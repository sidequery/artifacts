import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractStandalonePackage } from "./standalone";

test("embedded packages extract atomically, retain assets and reuse one version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-standalone-"));
  try {
    const payload = await new Bun.Archive({
      "package/src/cli.ts": "console.log('embedded cli')", "package/package.json": '{"version":"test"}',
      "package/native/celld": "runtime", "package/native/esbuild": "compiler", "package/dist/assets/icon.txt": "asset",
    }, { compress: "gzip" }).bytes();
    const hash = createHash("sha256").update(payload).digest("hex");
    const [a,b] = await Promise.all([extractStandalonePackage(payload, hash, directory), extractStandalonePackage(payload, hash, directory)]);
    expect(a).toBe(b);
    expect(await readFile(join(a, "dist/assets/icon.txt"), "utf8")).toBe("asset");
    expect((await stat(join(a,"native/celld"))).mode & 0o777).toBe(0o700);
    expect(await extractStandalonePackage(payload, hash, directory)).toBe(a);
    expect(await readdir(join(directory,"packages"))).toEqual([hash]);
    await expect(extractStandalonePackage(payload, "incorrect", directory)).rejects.toThrow("checksum");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("incomplete embedded payload is never published", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-standalone-incomplete-"));
  try {
    const payload = await new Bun.Archive({"package/package.json":"{}"}).bytes();
    const hash = createHash("sha256").update(payload).digest("hex");
    await expect(extractStandalonePackage(payload,hash,directory)).rejects.toThrow("missing src/cli.ts");
    expect(await readdir(join(directory,"packages"))).toEqual([]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
