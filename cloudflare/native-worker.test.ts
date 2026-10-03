import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { CelldOperator } from "../scripts/native-worker/operator";

test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("authenticated app management retains native resources, isolates owners/secrets and recovers interrupted updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-controller-"));
  const operatorToken = "operator-fixture-token-with-32-characters";
  const operator = new CelldOperator({ root: join(directory, "operator"), token: operatorToken, binary: process.env.CELLD_BIN });
  let runtime: Miniflare | undefined;
  try {
    await operator.start();
    const server = operator.serve({ port: 0 });
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "native-controller", alg: "RS256", use: "sig" };
    const assertion = async (subject: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(subject)
      .setIssuer("https://fixture.cloudflareaccess.com").setAudience("native-app-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    const alice = await assertion("alice"), bob = await assertion("bob");
    const modulesRoot = join(import.meta.dir, "../dist/worker-app");
    const modules: Record<string, { type: "esm" | "wasm" | "text"; contents: string | Uint8Array }> = {};
    for (const name of await readdir(modulesRoot)) {
      if (name.endsWith(".js") || name.endsWith(".html")) modules[name] = { type: name.endsWith(".js") ? "esm" : "text", contents: await readFile(join(modulesRoot, name), "utf8") };
      if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
    }
    const env: Record<string, any> = Object.fromEntries(Object.entries({
      ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com", ACCESS_AUD: "native-app-test", AUTH_MODE: "access",
      NATIVE_CELLD_OPERATOR_URL: server.url.origin + "/", NATIVE_CELLD_OPERATOR_TOKEN: operatorToken, NATIVE_CELLD_TRUSTED_APPS: "true",
    }).map(([key, value]) => [key, { type: "text", value }]));
    const exports: Record<string, any> = {};
    for (const [binding, className] of Object.entries({ NATIVE_APPS: "NativeApps", LIBRARIES: "ArtifactLibrary", BACKENDS: "ArtifactBackend", LINKS: "ArtifactLinks", SCRIPTS: "ScriptLibrary", SCRIPT_BACKENDS: "ScriptBackend" })) {
      env[binding] = { type: "durable-object", worker: "controller", exportName: className }; exports[className] = { type: "durable-object", storage: "sqlite" };
    }
    env.ASSETS = { type: "assets" }; env.LOADER = { type: "worker-loader" };
    let denyDeploy = false;
    const options = { cf: false as const, port: 0, resourcePersistencePath: join(directory, "controller"), workers: [{ config: {
      name: "controller", type: "worker" as const, compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "worker.js", modulesRoot, modules }, env, exports,
      assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" as const },
    }, dev: { outboundService: { type: "fetcher" as const, handler: async (request: Request) => {
      if (request.url === "https://fixture.cloudflareaccess.com/cdn-cgi/access/certs") return new RuntimeResponse(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
      if (denyDeploy && new URL(request.url).pathname === "/deploy") return new RuntimeResponse("Provider unavailable", { status: 503 });
      const result = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
      return new RuntimeResponse(result.body, { status: result.status, headers: result.headers });
    } } } }] };
    runtime = new Miniflare(options); let origin = (await runtime.ready).origin;
    async function tool(name: string, args: Record<string, unknown>, token = alice, library = "private") {
      const response = await fetch(`${origin}/api/tools?workspace=test&library=${library}`, { method: "POST", headers: { "content-type": "application/json", "cf-access-jwt-assertion": token }, body: JSON.stringify({ name, arguments: args }) });
      const result = await response.json() as { isError?: boolean; structuredContent?: any; error?: string };
      return { response, result, payload: result.structuredContent };
    }
    async function invoke(name = "fixture", token = alice, path = "/", library = "private", init: RequestInit = {}) {
      return fetch(`${origin}/apps/${name}${path}?workspace=test&library=${library}`, { ...init, headers: { "cf-access-jwt-assertion": token, ...Object.fromEntries(new Headers(init.headers)) } });
    }
    const source = (await readFile(join(import.meta.dir, "../examples/native-worker/worker.ts"), "utf8")).replace("    const counter =", '    if (url.pathname === "/inspect") return Response.json({url:request.url,headers:Object.fromEntries(request.headers)});\n    const counter =');
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "../examples/native-worker/app.json"), "utf8"));
    expect((await fetch(`${origin}/api/gallery`)).status).toBe(401);
    const missing = await tool("app_write", { name: "fixture", source, manifest, provider: "celld-local", expected_revision: null });
    expect(missing.result.isError).toBe(true); expect(missing.payload.error).toContain("Missing declared app secret");
    expect((await invoke()).status).toBe(503);
    const withSecret = await tool("app_secrets", { name: "fixture", secrets: { API_TOKEN: "app-fixture-secret" } });
    expect(withSecret.result.isError, JSON.stringify(withSecret.result)).toBe(false);
    const first = await (await invoke()).json() as any;
    expect(first).toMatchObject({ count: 1, visits: 1, hasToken: true });
    expect(first.bindings).toEqual(["API_TOKEN", "CACHE", "COUNTERS", "DB", "FILES", "GREETING", "JOBS"]);
    const largeBody = "streaming-body".repeat(30000);
    expect(await (await invoke("fixture", alice, "/stream", "private", { method: "POST", body: largeBody })).text()).toBe(largeBody);
    const inspection = await (await invoke("fixture", alice, "/inspect", "private", { headers: { cookie: "management=private", authorization: "Bearer management-private", "x-artifacts-gateway-token": "forged" } })).json() as any;
    expect(inspection.url).toBe(`${origin}/inspect`);
    for (const header of ["cookie", "authorization", "cf-access-jwt-assertion", "x-artifacts-gateway-token", "x-artifacts-target-url", "x-artifacts-app-selection"]) expect(inspection.headers[header]).toBeUndefined();
    const read = (await tool("app_read", { name: "fixture" })).payload;
    expect(JSON.stringify(read)).not.toContain("app-fixture-secret"); expect(JSON.stringify(read)).not.toContain(operatorToken);
    const original = read.active_revision;
    expect((await tool("app_read", { name: "fixture" }, bob)).response.status).toBe(404);
    expect((await invoke("fixture", bob)).status).toBe(404);
    await tool("app_write", { name: "fixture", source, manifest, provider: "celld-local" }, bob);
    await tool("app_secrets", { name: "fixture", secrets: { API_TOKEN: "bob-fixture-secret" } }, bob);
    expect(await (await invoke("fixture", bob)).json()).toMatchObject({ count: 1, visits: 1 });
    const renamed = structuredClone(manifest); renamed.bindings.COUNTERS.class_name = "RenamedCounter";
    expect((await tool("app_write", { name: "fixture", source: source.replaceAll("Counter", "RenamedCounter"), manifest: renamed, expected_revision: read.revision_token })).result.isError).toBe(false);
    expect(await (await invoke()).json()).toMatchObject({ count: 2, visits: 2 });
    const invalid = await tool("app_write", { name: "fixture", source: "export default {", manifest });
    expect(invalid.result.isError).toBe(true); expect(invalid.payload.applied).toBe(true);
    expect((await tool("app_write", { name: "fixture", source, manifest, expected_revision: read.revision_token })).response.status).toBe(409);
    expect((await tool("app_restore", { name: "fixture", revision_id: original })).result.isError).toBe(false);
    expect(await (await invoke()).json()).toMatchObject({ count: 3, visits: 3 });
    const noBindings = { ...manifest, secrets: [], bindings: {}, triggers: {} };
    expect((await tool("app_write", { name: "fixture", source: 'export default {fetch() {return new Response("removed");}};', manifest: noBindings })).result.isError).toBe(false);
    expect(await (await invoke()).text()).toBe("removed");
    await tool("app_restore", { name: "fixture", revision_id: original });
    expect(await (await invoke()).json()).toMatchObject({ count: 4, visits: 4 });
    denyDeploy = true;
    const desiredManifest = structuredClone(manifest); desiredManifest.vars.GREETING = "Recovered update";
    const unavailable = await tool("app_write", { name: "fixture", source, manifest: desiredManifest });
    expect(unavailable.result.isError).toBe(true); expect(unavailable.payload.status).toBe("recovery-required");
    expect(unavailable.payload.desired_revision).not.toBe(unavailable.payload.active_revision);
    expect((await invoke()).status).toBe(503);
    await runtime.dispose(); runtime = new Miniflare(options); origin = (await runtime.ready).origin;
    expect((await tool("app_read", { name: "fixture" })).payload.status).toBe("recovery-required");
    denyDeploy = false;
    expect((await tool("app_reconcile", { name: "fixture" })).result.isError).toBe(false);
    expect(await (await invoke()).json()).toMatchObject({ count: 5, visits: 5, greeting: "Recovered update" });
    expect((await tool("app_move", { name: "fixture", library: "team" })).result.isError).toBe(false);
    expect((await tool("app_read", { name: "fixture" })).response.status).toBe(404);
    expect((await invoke()).status).toBe(404);
    expect(await (await invoke("fixture", bob, "/", "team")).json()).toMatchObject({ count: 6, visits: 6 });
    expect((await tool("app_secrets", { name: "fixture" }, bob, "team")).payload.names).toEqual(["API_TOKEN"]);
    // Reusing the former logical name must allocate a new physical app and fresh storage.
    await tool("app_write", { name: "fixture", source, manifest, provider: "celld-local", expected_revision: null });
    await tool("app_secrets", { name: "fixture", secrets: { API_TOKEN: "replacement-secret" } });
    expect(await (await invoke()).json()).toMatchObject({ count: 1, visits: 1 });
  } finally { await runtime?.dispose(); await operator.close(); await rm(directory, { recursive: true, force: true }); }
}, 180_000);
