import type { Env } from "./worker";
import { authenticate } from "./auth";
import { authenticateBetterAuth } from "./better-auth";
import { CloudCanvasService } from "./service";
import { readRequestText } from "./http";
import { canvas_request as validateRequest } from "../dist/cloudflare/tool-validators.js";
import type { CanvasHttpRequest } from "../src/httpTypes";
import galleryBridge from "../dist/cloudflare/gallery-request.json";

export async function identify(request: Request, env: Env): Promise<{ privateKey: string } | Response> {
  if (env.AUTH_MODE && !["access", "better-auth"].includes(env.AUTH_MODE)) return Response.json({ error: "Invalid AUTH_MODE" }, { status: 503 });
  if (env.AUTH_MODE === "better-auth") {
    const user = await authenticateBetterAuth(request, env);
    if (user instanceof Response) return user;
    return { privateKey: JSON.stringify(["private", "better-auth", user.id]) };
  }
  const identity = await authenticate(request, env);
  return identity instanceof Response ? identity : { privateKey: JSON.stringify(["private", env.ACCESS_TEAM_DOMAIN ?? "local", identity.subject]) };
}
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
function html(body: string, policy: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": policy, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

/** Root slug dispatch is separate from management authentication. */
export async function artifactRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const slug = url.pathname.split("/")[1] ?? "";
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const link = await env.LINKS.getByName("deployment").get(slug);
  if (!link) return null;
  if (link.access === "private") {
    const identity = await identify(request, env);
    if (identity instanceof Response) return identity;
    if (link.libraryKey !== "team" && link.libraryKey !== identity.privateKey) return new Response("Not found", { status: 404 });
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
  if (!link.version_id) return new Response("Canvas has no valid version", { status: 409 });
  const service = new CloudCanvasService(env.LIBRARIES.getByName(link.libraryKey), link.workspace, env.BACKENDS, link.libraryKey);
  if (url.pathname === `/${slug}/_canvas/request`) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    // Only the trusted wrapper can send browser requests, including public canvases.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin is not allowed", { status: 403 });
    let input: unknown;
    try { input = JSON.parse(await readRequestText(request, 1024 * 1024)); }
    catch { return new Response("Invalid request", { status: 400 }); }
    if (!validateRequest(input)) return new Response("Invalid request", { status: 400 });
    const args = input as { version_id?: string; request: CanvasHttpRequest };
    // Bind requests to this link's active code; caller cannot choose another artifact.
    if (args.version_id !== link.version_id) return Response.json({ error: "Canvas updated; reload the page" }, { status: 409 });
    return Response.json({ response: await service.request({ name: link.name, version_id: link.version_id }, args.request) }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname !== `/${slug}` && url.pathname !== `/${slug}/`) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const snapshot = await service.snapshot({ version_id: link.version_id });
  const preview = await service.preview(snapshot);
  if (!preview.ok || !preview._meta) return new Response(preview.check, { status: 400 });
  const payload = preview._meta.canvas;
  const frame = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>body{margin:0;background:#181818;color:#f0f0f0;font-family:system-ui,sans-serif}#root{padding:24px}</style></head><body><div id="root"></div><script>window.__herdrCanvas=${scriptJson({ canvasId: payload.name, state: payload.state, theme: { kind: "dark" }, ...(payload.server ? { serverVersionId: payload.versionId } : {}) })};${galleryBridge.replace(/<\/script/gi, "<\\/script")}</script><script type="module">${payload.js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  return html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block;background:#181818}</style></head><body><iframe title="Canvas" sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');frame.srcdoc=${scriptJson(frame)};
const pending=new Set();
window.addEventListener('message',async event=>{
 const data=event.data;
 if(event.source!==frame.contentWindow||data?.type!=='canvas/http-request'||typeof data.id!=='string'||data.id.length>64||pending.has(data.id))return;
 try{
  if(pending.size>=16)throw new Error('Too many pending requests');
  if(data.versionId!==${scriptJson(payload.versionId)})throw new Error('Invalid canvas version');
  pending.add(data.id);
  const response=await fetch(${scriptJson(`/${slug}/_canvas/request`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version_id:${scriptJson(payload.versionId)},request:data.request})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Canvas request failed');
  frame.contentWindow.postMessage({type:'canvas/http-response',id:data.id,response:result.response},'*');
 }catch(error){frame.contentWindow.postMessage({type:'canvas/http-response',id:data.id,error:String(error.message||error)},'*');}
 finally{pending.delete(data.id);}
});</script></body></html>`, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
}
