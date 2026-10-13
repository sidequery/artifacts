import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CreateBucketCommand,
  ListBucketsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CelldFleetOperator, fleetHostConfig } from "./fleet";
import { FleetStore } from "./fleet-store";
import {
  fleetBinding,
  readFleetRegistry,
  type FleetPointer,
} from "../../cloudflare/native-worker/fleet-contract";
import { prepareCelldConfig } from "../prepare-celld";

test("fleet operator authenticates requests before parsing deployments", async () => {
  const operator = new CelldFleetOperator({
    bucket: "s3://fixture",
    config: "/unused",
    token: "fleet-fixture-token-with-32-characters",
  });
  expect(
    (
      await operator.fetch(
        new Request("https://operator.invalid/deploy", {
          method: "POST",
          body: "invalid JSON",
        }),
      )
    ).status,
  ).toBe(401);
});

test("fleet configuration keeps host bindings and rejects conflicting app identities", () => {
  const app = "11111111-1111-4111-8111-111111111111";
  const script = `art-app-${app.replaceAll("-", "")}`;
  const registry = readFleetRegistry({
    schema_version: 1,
    apps: [
      {
        app,
        revision: "a".repeat(64),
        pointer: {
          script_name: script,
          version: "b".repeat(16),
          prefix: `deploy/${script}/${"b".repeat(16)}`,
          rollout: { percent: 100 },
        },
        crons: ["0 * * * *"],
        queues: [],
      },
    ],
  });
  const config = fleetHostConfig(
    {
      name: "canvas",
      main: "worker.js",
      services: [{ binding: "EXISTING", service: "existing" }],
      vars: { HOST_ONLY: "host" },
    },
    registry,
    "publication",
  );
  expect(config.services?.map((item) => item.binding)).toEqual([
    "EXISTING",
    fleetBinding(app),
    `${fleetBinding(app)}_SCHEDULE`,
  ]);
  expect(config.triggers?.crons).toEqual(["0 * * * *"]);
  expect(config.vars?.HOST_ONLY).toBe("host");
  expect(() =>
    fleetHostConfig(
      {
        name: "canvas",
        main: "worker.js",
        services: [{ binding: fleetBinding(app), service: "forged" }],
      },
      registry,
      "publication",
    ),
  ).toThrow("conflicts");
  expect(() =>
    readFleetRegistry({
      ...registry,
      apps: [...registry.apps, registry.apps[0]],
    }),
  ).toThrow("Invalid native fleet app");
});

function reservePort() {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

test.skipIf(process.env.NATIVE_WORKER_FLEET !== "1")(
  "native apps run on two celld fleet nodes while host, storage, queues, secrets and revisions survive updates",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifacts-native-fleet-"));
    const binary = process.env.CELLD_BIN!;
    const endpoint =
      process.env.FLEET_TEST_S3_ENDPOINT ?? "http://127.0.0.1:5117";
    const bucket = `artifacts-native-test-${randomUUID().slice(0, 8)}`;
    const region = "us-east-1";
    const credentials = {
      accessKeyId: "artifacts-fixture",
      secretAccessKey: "artifacts-fixture-secret",
    };
    const client = new S3Client({
      endpoint,
      region,
      credentials,
      forcePathStyle: true,
    });
    const environment = {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: "",
      AWS_REGION: region,
      S3_ENDPOINT: endpoint,
    };
    const store = new FleetStore(client, `s3://${bucket}`);
    const nodePorts = [reservePort(), reservePort()];
    const nodes = nodePorts.map((port) => `http://127.0.0.1:${port}`);
    const operatorPort = reservePort();
    const operatorToken = "fleet-fixture-token-with-32-characters";
    const configPath = join(directory, "wrangler.jsonc");
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let logs = "";
    let operator: CelldFleetOperator | undefined;
    try {
      // A newly started fixture container can accept TCP before S3 is ready.
      const fixtureDeadline = Date.now() + 30_000;
      while (true) {
        try {
          await client.send(new ListBucketsCommand({}));
          break;
        } catch (error) {
          if (Date.now() >= fixtureDeadline) throw error;
          await Bun.sleep(250);
        }
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const config = await prepareCelldConfig(
        resolve(import.meta.dir, "../../wrangler.jsonc"),
        configPath,
        {
          main: resolve(import.meta.dir, "../../dist/worker-app/worker.js"),
          assets: resolve(import.meta.dir, "../../dist/cloudflare/assets"),
        },
      );
      config.vars = {
        ...(config.vars as object),
        NATIVE_CELLD_TRUSTED_APPS: "true",
        NATIVE_CELLD_FLEET_OPERATOR_URL: `http://127.0.0.1:${operatorPort}/`,
        NATIVE_CELLD_FLEET_OPERATOR_TOKEN: operatorToken,
        HOST_ONLY_SECRET: "host-fixture-secret",
      };
      await writeFile(configPath, JSON.stringify(config));
      function startNode(index: number) {
        const port = nodePorts[index]!;
        const peerPort = reservePort();
        const child = Bun.spawn(
          [
            binary,
            "--bucket",
            `s3://${bucket}`,
            "--endpoint",
            endpoint,
            "--region",
            region,
            "--listen",
            `127.0.0.1:${port}`,
            "--internal-listen",
            `127.0.0.1:${peerPort}`,
            "--advertise",
            `127.0.0.1:${peerPort}`,
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              ...environment,
              CELLD_NODE: `fixture-${index}-${randomUUID()}`,
              CELLD_WATCH: join(directory, `node-${index}`),
              // Keep one node slower than Bun's default HTTP idle timeout.
              CELLD_DEPLOY_POLL_S: index === 1 ? "15" : "1",
              CELLD_READY_FLEET_GATE_MS: "0",
              CELLD_IDLE_EVICT_S: "60",
              RUST_LOG: "warn",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        children.push(child);
        for (const stream of [child.stdout, child.stderr])
          if (stream && typeof stream !== "number")
            void (async () => {
              for await (const chunk of stream)
                logs = (logs + new TextDecoder().decode(chunk)).slice(-100_000);
            })();
        return child;
      }
      for (const index of nodePorts.keys()) startNode(index);
      operator = new CelldFleetOperator({
        bucket: `s3://${bucket}`,
        config: configPath,
        token: operatorToken,
        binary,
        endpoint,
        region,
        client,
        environment,
        nodes,
        readinessTimeoutMs: 45_000,
      });
      await operator.start();
      operator.serve({ port: operatorPort });
      await operator.publishHost();
      const galleryBundle = await readFile(
        resolve(import.meta.dir, "../../dist/cloudflare/assets/gallery.js"),
        "utf8",
      );
      for (const node of nodes) {
        expect((await fetch(`${node}/health`)).status, logs).toBe(200);
        const gallery = await fetch(`${node}/`);
        expect(gallery.status, logs).toBe(200);
        expect(await gallery.text()).toContain('src="/gallery.js"');
        const bundle = await fetch(`${node}/gallery.js`);
        expect(bundle.status, logs).toBe(200);
        expect(bundle.headers.get("content-type")).toContain("javascript");
        expect(await bundle.text(), logs).toBe(galleryBundle);
      }
      expect(
        (await store.json<FleetPointer>("deploy/current.json"))?.value
          .script_name,
      ).toBe("canvas");
      const source = (
        await readFile(
          resolve(import.meta.dir, "../../examples/native-worker/worker.ts"),
          "utf8",
        )
      ).replace(
        "    const counter =",
        '    if (url.pathname === "/inspect") return Response.json({ url: request.url, headers: Object.fromEntries(request.headers), bindings: Object.keys(env).sort() });\n    const counter =',
      );
      const manifest = JSON.parse(
        await readFile(
          resolve(import.meta.dir, "../../examples/native-worker/app.json"),
          "utf8",
        ),
      );
      manifest.triggers.crons = ["* * * * *"];
      async function tool(
        name: string,
        args: Record<string, unknown>,
        index = 0,
        library = "private",
      ) {
        const response = await fetch(
          `${nodes[index]}/api/tools?workspace=test&library=${library}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, arguments: args }),
          },
        );
        const result = (await response.json()) as {
          isError?: boolean;
          structuredContent?: Record<string, any>;
          content?: { text: string }[];
        };
        const payload =
          result.structuredContent ??
          JSON.parse(result.content?.[0]?.text ?? "{}");
        return { result, payload };
      }
      const invoke = (path = "/", index = 0, init?: RequestInit) =>
        fetch(`${nodes[index]}/apps/fixture${path}?workspace=test`, init);
      const missing = await tool("app_write", {
        name: "fixture",
        source,
        manifest,
        provider: "celld-fleet",
        expected_revision: null,
      });
      expect(missing.result.isError, JSON.stringify(missing)).toBe(true);
      expect(missing.payload.error).toContain("Missing declared app secret");
      const saved = await tool("app_secrets", {
        name: "fixture",
        secrets: { API_TOKEN: "app-fixture-secret" },
      });
      expect(saved.result.isError, JSON.stringify(saved)).not.toBe(true);
      expect(await (await invoke()).json(), logs).toMatchObject({
        count: 1,
        visits: 1,
        hasToken: true,
      });
      expect(await (await invoke("/rpc", 1)).json(), logs).toMatchObject({
        count: 2,
        visits: 2,
      });
      const inspection = (await (
        await invoke("/inspect", 1, {
          headers: {
            authorization: "Bearer forged",
            cookie: "management=private",
            "x-artifacts-gateway-token": "forged",
            "x-artifacts-target-url": "https://forged.invalid",
          },
        })
      ).json()) as any;
      expect(inspection.url).toBe(`${nodes[1]}/inspect`);
      expect(inspection.bindings).toEqual([
        "API_TOKEN",
        "CACHE",
        "COUNTERS",
        "DB",
        "FILES",
        "GREETING",
        "JOBS",
      ]);
      for (const name of [
        "authorization",
        "cookie",
        "x-artifacts-gateway-token",
        "x-artifacts-target-url",
        "x-artifacts-app-selection",
      ])
        expect(inspection.headers[name]).toBeUndefined();
      expect(await (await invoke("/queue")).text()).toBe("queued");
      const queueDeadline = Date.now() + 15_000;
      let queued: any;
      do {
        queued = await (await invoke("/events", 1)).json();
        if (queued.queued) break;
        await Bun.sleep(100);
      } while (Date.now() < queueDeadline);
      expect(queued.queued?.bodies, logs).toEqual([{ message: "from fetch" }]);
      const cronDeadline = Date.now() + 70_000;
      let scheduled: any;
      do {
        scheduled = await (await invoke("/events", 1)).json();
        if (scheduled.scheduled) break;
        await Bun.sleep(500);
      } while (Date.now() < cronDeadline);
      expect(scheduled.scheduled, logs).toMatchObject({
        cron: "* * * * *",
        time: expect.any(Number),
      });
      const read = (await tool("app_read", { name: "fixture" })).payload;
      expect(JSON.stringify(read)).not.toContain("app-fixture-secret");
      expect(JSON.stringify(read)).not.toContain(operatorToken);
      const update = await tool(
        "app_write",
        {
          name: "fixture",
          source: source.replace(
            "greeting: env.GREETING",
            'greeting: "updated"',
          ),
          manifest,
          expected_revision: read.revision_token,
        },
        1,
      );
      expect(update.result.isError, JSON.stringify(update)).not.toBe(true);
      expect(await (await invoke()).json(), logs).toMatchObject({
        greeting: "updated",
        count: 3,
        visits: 3,
      });
      expect(
        (await store.json<FleetPointer>("deploy/current.json"))?.value
          .script_name,
      ).toBe("canvas");
      await operator.publishHost();
      expect(await (await invoke("/rpc", 1)).json(), logs).toMatchObject({
        count: 4,
        visits: 4,
      });
      const active = (await tool("app_read", { name: "fixture" })).payload;
      const invalid = await tool("app_write", {
        name: "fixture",
        source: "export default { fetch( {",
        manifest,
        expected_revision: active.revision_token,
      });
      expect(invalid.result.isError, JSON.stringify(invalid)).toBe(true);
      expect(
        (await tool("app_read", { name: "fixture" })).payload.active_revision,
      ).toBe(active.active_revision);
      const team = await tool(
        "app_write",
        {
          name: "fixture",
          source,
          manifest: {
            ...manifest,
            secrets: [],
            triggers: { ...manifest.triggers, crons: [] },
          },
          provider: "celld-fleet",
          expected_revision: null,
        },
        1,
        "team",
      );
      expect(team.result.isError, JSON.stringify(team)).not.toBe(true);
      expect(
        await (
          await fetch(`${nodes[0]}/apps/fixture/?workspace=test&library=team`)
        ).json(),
      ).toMatchObject({ count: 1, visits: 1, hasToken: false });
      expect(await (await invoke("/rpc")).json()).toMatchObject({
        count: 5,
        visits: 5,
        hasToken: true,
      });
      const oldNode = children[0]!;
      oldNode.kill("SIGTERM");
      await oldNode.exited;
      startNode(0);
      const restartDeadline = Date.now() + 30_000;
      let ready = false;
      do {
        try {
          ready = (
            await fetch(`${nodes[0]}/health`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {}
        if (!ready) await Bun.sleep(100);
      } while (!ready && Date.now() < restartDeadline);
      expect(ready, logs).toBe(true);
      expect(await (await invoke("/rpc")).json(), logs).toMatchObject({
        count: 6,
        visits: 6,
      });
      await operator.close();
      operator = new CelldFleetOperator({
        bucket: `s3://${bucket}`,
        config: configPath,
        token: operatorToken,
        binary,
        endpoint,
        region,
        client,
        environment,
        nodes,
        readinessTimeoutMs: 45_000,
      });
      await operator.start();
      operator.serve({ port: operatorPort });
      await operator.publishHost();
      expect(await (await invoke("/storage", 1)).json()).toMatchObject({
        cached: "6",
        file: "6",
        visits: 6,
      });
    } catch (error) {
      if (error instanceof Error && error.cause) console.error(error.cause);
      throw error;
    } finally {
      await operator?.close();
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.all(
        children.map(async (child) => {
          const stopped = await Promise.race([
            child.exited.then(() => true),
            Bun.sleep(45_000).then(() => false),
          ]);
          if (!stopped) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }),
      );
      client.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000,
);
