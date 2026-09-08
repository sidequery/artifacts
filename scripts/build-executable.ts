import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { artifactDataRoot, celldArtifact, ensureCelldRuntime } from "../src/local/celld-runtime";

const root = resolve(import.meta.dir, "..");
const platform = `${process.platform}-${process.arch}`;
celldArtifact(); // Never produce a binary with an unsupported native runtime.
const output = join(root, "dist/binaries", `artifacts-${platform}`);
const temporary = await mkdtemp(join(tmpdir(), "canvas-executable-build-"));
async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const code = await child.exited;
  const out = await stdout, err = await stderr;
  if (code !== 0) throw new Error(`${command[1] ?? command[0]} failed (${code})\n${out}\n${err}`);
}
try {
  if (!process.argv.includes("--prebuilt-package")) {
    console.log("Preparing Canvas application bundles…");
    await run([process.execPath, "run", "build:package"]);
  }
  console.log("Packing the locked runtime dependencies…");
  const archives = join(temporary,"archives");
  await mkdir(archives);
  await run([process.execPath,"pm","pack","--ignore-scripts","--destination",archives]);
  const manifest = JSON.parse(await readFile(join(root,"package.json"),"utf8"));
  const archive = join(archives,`sidequery-artifacts-${manifest.version}.tgz`);
  const payloadRoot = join(temporary,"payload");
  await mkdir(payloadRoot);
  await new Bun.Archive(await Bun.file(archive).arrayBuffer()).extract(payloadRoot);
  const packaged = join(payloadRoot,"package");
  await cp(join(root,"bun.lock"),join(packaged,"bun.lock"));
  await cp(join(root,"patches"),join(packaged,"patches"),{recursive:true});
  await run([process.execPath,"install","--production","--frozen-lockfile","--ignore-scripts","--linker","hoisted"],packaged);
  const native = join(packaged,"native");
  await mkdir(native);
  await cp(await ensureCelldRuntime({dataRoot:artifactDataRoot()}),join(native,"celld"));
  const require = createRequire(join(root,"package.json"));
  const fromEsbuild = createRequire(require.resolve("esbuild/package.json"));
  await cp(fromEsbuild.resolve(`@esbuild/${platform}/bin/esbuild`),join(native,"esbuild"));
  const payload = join(temporary,"payload.tar.gz");
  await run(["tar","-czf",payload,"-C",payloadRoot,"package"]);
  const hash = createHash("sha256").update(await readFile(payload)).digest("hex");
  const entry = join(temporary,"entry.ts");
  await writeFile(entry, `import payload from ${JSON.stringify(payload)} with { type: "file" };\nimport { runStandalone } from ${JSON.stringify(join(root,"src/local/standalone.ts"))};\nawait runStandalone(new Uint8Array(await Bun.file(payload).arrayBuffer()), ${JSON.stringify(hash)});\n`);
  await mkdir(join(root,"dist/binaries"),{recursive:true});
  console.log(`Compiling self-contained Canvas for ${platform}…`);
  await run([process.execPath,"build","--compile","--minify",entry,"--outfile",output],temporary);
  const binaryHash = createHash("sha256").update(await readFile(output)).digest("hex");
  await writeFile(`${output}.sha256`,`${binaryHash}  artifacts-${platform}\n`);
  await writeFile(`${output}.json`,JSON.stringify({ version:manifest.version, platform, sha256:binaryHash, payloadSha256:hash },null,2)+"\n");
  console.log(`Built ${output} (${(Bun.file(output).size / 1024 / 1024).toFixed(1)} MiB)`);
} finally {
  await rm(temporary,{recursive:true,force:true});
}
