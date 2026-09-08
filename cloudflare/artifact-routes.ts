import { publicOrigin } from "./public-origin";
import type { Env } from "./worker";
import { authenticate } from "./auth";
import { authenticateBetterAuth } from "./better-auth";
import { CloudArtifactService } from "./service";
import { readRequestText } from "./http";
import { artifact_request as validateRequest } from "../dist/cloudflare/tool-validators.js";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import { PluginError, PLUGIN_JSON_LIMIT, type PluginInvocationContext } from "./plugins";
import { artifact_files as validateFiles } from "../dist/cloudflare/tool-validators.js";
import type { ArtifactFileRequest } from "../src/sdk/files";
import type { PluginRequest, PluginUser } from "../src/plugins/types";
import galleryBridge from "../dist/cloudflare/gallery-request.json";
import navigationHost from "../dist/cloudflare/navigation-host.json";
import { artifactApiRequest, artifactApiResponse } from "./artifact-api";

export async function identify(request: Request, env: Env): Promise<{ privateKey: string; user: PluginUser } | Response> {
  if (env.AUTH_MODE && !["access", "better-auth"].includes(env.AUTH_MODE)) return Response.json({ error: "Invalid AUTH_MODE" }, { status: 503 });
  if (env.AUTH_MODE === "better-auth") {
    const user = await authenticateBetterAuth(request, env);
    if (user instanceof Response) return user;
    return { privateKey: JSON.stringify(["private", "better-auth", user.id]), user: { subject: user.id, authority: "better-auth" } };
  }
  const identity = await authenticate(request, env);
  return identity instanceof Response ? identity : { privateKey: JSON.stringify(["private", env.ACCESS_TEAM_DOMAIN ?? "local", identity.subject]), user: identity };
}
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
function html(body: string, policy: string, head: boolean): Response {
  return new Response(head ? null : body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": policy, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

/** Root slug dispatch is separate from management authentication. */
export async function artifactRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const slug = url.pathname.split("/")[1] ?? "";
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const link = await env.LINKS.getByName("deployment").get(slug);
  if (!link) return null;
  let plugins: PluginInvocationContext | undefined;
  // Public links never acquire plugin authority from ambient management cookies.
  if (link.kind === "artifact" && url.pathname === `/${slug}/_artifact/plugins` && link.access !== "private") return Response.json({ error: "Plugin sign-in required" }, { status: 401 });
  if (link.access === "private") {
    const identity = await identify(request, env);
    if (identity instanceof Response) return identity;
    if (link.libraryKey !== "team" && link.libraryKey !== identity.privateKey) return new Response("Not found", { status: 404 });
    plugins = { user: identity.user, env };
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin is not allowed", { status: 403 });
  }
  if (link.kind === "script") {
    const active = await env.SCRIPTS.getByName(link.libraryKey).active({ workspace: link.workspace, name: link.name, hash: link.script_hash });
    if (!active) return new Response("Script has no valid version", { status: 409 });
    // Management session credentials never become inputs to user-authored code.
    // Public script Authorization headers remain available for application auth.
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("cf-access-jwt-assertion");
    headers.delete("cf-access-client-id");
    headers.delete("cf-access-client-secret");
    if (link.access === "private") headers.delete("authorization");
    const input = new Request(request, { headers });
    const backend = env.SCRIPT_BACKENDS.getByName(JSON.stringify([link.libraryKey, link.workspace, link.name]));
    const response = await backend.request({ ...active, request: input });
    const output = new Headers(response.headers);
    output.delete("set-cookie");
    // HTML returned by scripts cannot acquire the management origin's authority.
    output.append("content-security-policy", "sandbox allow-scripts allow-forms");
    output.set("x-content-type-options", "nosniff");
    output.set("cache-control", "private, no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: output });
  }
  if (!link.version_id) return new Response("Artifact has no valid version", { status: 409 });
  const service = new CloudArtifactService(env.LIBRARIES.getByName(link.libraryKey), link.workspace, env.BACKENDS, link.libraryKey, undefined, plugins,
    env.FILE_BACKENDS ? { backends: env.FILE_BACKENDS, origin: publicOrigin(request.url, env.ARTIFACTS_PUBLIC_ORIGIN) } : undefined);
  if (url.pathname === `/${slug}/_artifact/files`) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin is not allowed", { status: 403 });
    let input: unknown;
    try { input = JSON.parse(await readRequestText(request, 8192)); }
    catch (error) { return Response.json({ error: error instanceof RangeError ? "File request exceeds 8 KiB" : "Invalid JSON" }, { status: error instanceof RangeError ? 413 : 400 }); }
    if (!validateFiles(input)) return Response.json({ error: "Invalid file request" }, { status: 400 });
    const args = input as { version_id?: string; request: ArtifactFileRequest };
    if (args.version_id !== link.version_id) return Response.json({ error: "Artifact updated; reload the page" }, { status: 409 });
    const result = await service.fileRequest({ name: link.name, version_id: link.version_id }, args.request, link.access === "private");
    return Response.json({ result }, { headers: { "cache-control": "private, no-store" } });
  }
  if (url.pathname === `/${slug}/api` || url.pathname.startsWith(`/${slug}/api/`)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin is not allowed", { status: 403 });
    const selection = { name: link.name, version_id: link.version_id };
    if ((await service.snapshot({ version_id: link.version_id })).server_source === null) return Response.json({ error: "Artifact has no server" }, { status: 404 });
    let input: ArtifactHttpRequest;
    try { input = await artifactApiRequest(request, `/${slug}`, link.access === "private"); }
    catch (error) {
      if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 413 });
      throw error;
    }
    return artifactApiResponse(await service.request(selection, input), request.method);
  }
  if (url.pathname === `/${slug}/_artifact/plugins`) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    let input: PluginRequest;
    try { input = JSON.parse(await readRequestText(request, PLUGIN_JSON_LIMIT)); }
    catch (error) { return Response.json({ error: error instanceof RangeError ? "Plugin input exceeds 256 KiB" : "Invalid JSON" }, { status: error instanceof RangeError ? 413 : 400 }); }
    try { return Response.json({ result: await service.pluginCall(input) }, { headers: { "cache-control": "no-store" } }); }
    catch (error) { return Response.json({ error: error instanceof PluginError ? error.message : "Plugin operation failed" }, { status: error instanceof PluginError ? error.status : 500 }); }
  }
  if (url.pathname === `/${slug}/_artifact/request`) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    // Only the trusted wrapper can send browser requests, including public artifacts.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin is not allowed", { status: 403 });
    let input: unknown;
    try { input = JSON.parse(await readRequestText(request, 1024 * 1024)); }
    catch { return new Response("Invalid request", { status: 400 }); }
    if (!validateRequest(input)) return new Response("Invalid request", { status: 400 });
    const args = input as { version_id?: string; request: ArtifactHttpRequest };
    // Bind requests to this link's active code; caller cannot choose another artifact.
    if (args.version_id !== link.version_id) return Response.json({ error: "Artifact updated; reload the page" }, { status: 409 });
    return Response.json({ response: await service.request({ name: link.name, version_id: link.version_id }, args.request) }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === `/${slug}/_artifact` || url.pathname.startsWith(`/${slug}/_artifact/`)) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const snapshot = await service.snapshot({ version_id: link.version_id });
  const preview = await service.preview(snapshot);
  if (!preview.ok || !preview._meta) return new Response(preview.check, { status: 400 });
  const payload = preview._meta.artifact;
  const frame = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ${publicOrigin(request.url, env.ARTIFACTS_PUBLIC_ORIGIN)}/api/artifact/files/transfer/ ${publicOrigin(request.url, env.ARTIFACTS_PUBLIC_ORIGIN)}/api/canvas/files/transfer/; form-action 'none'; base-uri 'none'"><style>body{margin:0;background:#181818;color:#f0f0f0;font-family:system-ui,sans-serif}#root{padding:24px}</style></head><body><div id="root"></div><script>window.__herdrCanvas=window.__artifacts=${scriptJson({ artifactId: payload.name, canvasId: payload.name, state: payload.state, theme: { kind: "dark" }, plugins: payload.plugins, ...(payload.files ? { filesVersionId: payload.versionId } : {}), route: { path: (url.pathname.slice(slug.length + 1) || "/") + url.search, basePath: `/${slug}`, external: true }, ...(payload.server ? { serverVersionId: payload.versionId } : {}) })};${galleryBridge.replace(/<\/script/gi, "<\\/script")}</script><script type="module">${payload.js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  return html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block;background:#181818}</style></head><body><iframe title="Artifact" sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');frame.srcdoc=${scriptJson(frame)};
window.__artifactNavigationHost={frame,basePath:${scriptJson(`/${slug}`)}};
${navigationHost.replace(/<\/script/gi, "<\\/script")}
const pending=new Set();
window.addEventListener('message',async event=>{
 const data=event.data;
 if(event.source!==frame.contentWindow||!['artifact/http-request','artifact/plugin-request','artifact/files-request','artifact/file-download'].includes(data?.type)||typeof data.id!=='string'||data.id.length>64||pending.has(data.id))return;
 const plugin=data.type==='artifact/plugin-request';
 const files=data.type==='artifact/files-request';
 const download=data.type==='artifact/file-download';
 const responseType=plugin?'artifact/plugin-response':files?'artifact/files-response':download?'artifact/file-download-response':'artifact/http-response';
 try{
  if(pending.size>=16)throw new Error('Too many pending requests');
  if(plugin&&!${scriptJson(!!payload.plugins)})throw new Error('Plugin sign-in required');
  if(!plugin&&!download&&data.versionId!==${scriptJson(payload.versionId)})throw new Error('Invalid artifacts version');
  pending.add(data.id);
  if(download){
   const target=new URL(data.url);
   if(target.origin!==location.origin||target.username||target.password||target.search||target.hash||!/^\\/api\\/(?:artifact|canvas)\\/files\\/transfer\\/[a-f0-9]{64}\\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.pathname))throw new Error('Invalid artifact file transfer URL');
   const anchor=document.createElement('a');anchor.href=target.href;anchor.download='';anchor.rel='noreferrer';document.body.append(anchor);anchor.click();anchor.remove();
   frame.contentWindow.postMessage({type:responseType,id:data.id,result:null},'*');return;
  }
  const response=await fetch(plugin?${scriptJson(`/${slug}/_artifact/plugins`)}:files?${scriptJson(`/${slug}/_artifact/files`)}:${scriptJson(`/${slug}/_artifact/request`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(plugin?data.request:{version_id:${scriptJson(payload.versionId)},request:data.request})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Artifact request failed');
  frame.contentWindow.postMessage({type:responseType,id:data.id,...((plugin||files)?{result:result.result}:{response:result.response})},'*');
 }catch(error){frame.contentWindow.postMessage({type:responseType,id:data.id,error:String(error.message||error)},'*');}
 finally{pending.delete(data.id);}
});</script></body></html>`, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'", request.method === "HEAD");
}
