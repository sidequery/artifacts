import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const image = process.env.ARTIFACTS_DOCKER_IMAGE;

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${stderr}\n${stdout}`);
  return stdout.trim();
}

(image ? test : test.skip)("container compiles apps and preserves backend data across recreation", async () => {
  const name = `artifacts-test-${randomUUID()}`;
  const volume = `${name}-data`;
  let running = false;
  async function start() {
    await docker("run", "-d", "--name", name, "--stop-timeout", "60",
      "-p", "127.0.0.1::4786", "-v", `${volume}:/app/.celld`, image!);
    running = true;
    const address = await docker("port", name, "4786/tcp");
    const origin = `http://${address}`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return origin;
      } catch { /* Wait for the container's listener. */ }
      if (await docker("inspect", "--format", "{{.State.Running}}", name) !== "true") break;
      await Bun.sleep(250);
    }
    throw new Error(`Container failed readiness:\n${await docker("logs", name)}`);
  }
  async function stop() {
    await docker("stop", name);
    expect(await docker("inspect", "--format", "{{.State.ExitCode}}", name)).toBe("0");
    await docker("rm", name);
    running = false;
  }
  await docker("volume", "create", volume);
  try {
    for (const restart of [false, true]) {
      const origin = await start();
      expect((await fetch(origin)).status).toBe(200);
      const client = new Client({ name: "docker-test", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
        if (!restart) {
          const written = await client.callTool({ name: "artifact_write", arguments: {
            name: "persistent-counter",
            contents: 'import { H1 } from "sidequery/artifacts"; export default function App() { return <H1>Container app</H1>; }',
            server: `import { DurableObject } from "cloudflare:workers";
              export class ArtifactServer extends DurableObject {
                fetch(request: Request) {
                  this.ctx.storage.sql.exec("create table if not exists counter (value integer)");
                  if (request.method === "POST") this.ctx.storage.sql.exec("insert into counter values (1)");
                  return Response.json({ count: this.ctx.storage.sql.exec("select count(*) as count from counter").one().count });
                }
              }`,
          } });
          expect(written.isError, JSON.stringify(written)).not.toBe(true);
          const version = (written._meta as { artifact: { versionId: string } }).artifact.versionId;
          expect((await fetch(`${origin}/gallery/preview?version=${version}`)).status).toBe(200);
        }
        const result = await client.callTool({ name: "artifact_request", arguments: {
          name: "persistent-counter", request: { path: "/", method: restart ? "GET" : "POST", headers: [] },
        } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const response = (result.structuredContent as { response: { status: number; body: string } }).response;
        expect(response.status).toBe(200);
        expect(JSON.parse(Buffer.from(response.body, "base64").toString())).toEqual({ count: 1 });
      } finally { await client.close(); }
      await stop();
    }
  } finally {
    if (running) {
      console.error(await docker("logs", name));
      await docker("rm", "-f", name);
    }
    await docker("volume", "rm", volume);
  }
}, 240_000);
