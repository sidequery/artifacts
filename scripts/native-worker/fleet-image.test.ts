import { expect, test } from "bun:test";

test.skipIf(!process.env.FLEET_OPERATOR_DOCKER_IMAGE)(
  "fleet publisher image runs pinned celld and sends host releases through the authenticated singleton",
  async () => {
    const image = process.env.FLEET_OPERATOR_DOCKER_IMAGE!;
    const token = "fleet-image-fixture-token-with-32-characters";
    let received = false;
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/native-operator/host");
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
        received = true;
        return Response.json({ ok: true });
      },
    });
    try {
      const version = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "/usr/local/bin/celld",
          image,
          "--version",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [output] = await Promise.all([
        new Response(version.stdout).text(),
        new Response(version.stderr).text(),
      ]);
      expect(await version.exited).toBe(0);
      expect(output.trim()).toBe("celld 0.6.1");
      const job = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--add-host",
          "host.docker.internal:host-gateway",
          "-e",
          `NATIVE_CELLD_FLEET_OPERATOR_TOKEN=${token}`,
          "-e",
          `NATIVE_CELLD_FLEET_RELEASE_URL=http://host.docker.internal:${server.port}/api/native-operator/host`,
          image,
          "--request-host",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [, diagnostic] = await Promise.all([
        new Response(job.stdout).text(),
        new Response(job.stderr).text(),
      ]);
      expect(await job.exited, diagnostic).toBe(0);
      expect(received).toBe(true);
    } finally {
      server.stop(true);
    }
  },
  30_000,
);
