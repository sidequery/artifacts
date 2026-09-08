import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const runner = Bun.spawn([process.execPath, "run", "examples/runner-status/local.ts", "--prepare-only"], {
 cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, CELLD_BIN: "/unused-during-prepare", RUNNER_ORG: "example", RUNNER_REPOS: "example/repo", RUNNER_STATE_DIR: join(root,"dist/runner-status") }
});
if (await runner.exited !== 0) throw new Error("Runner deployment preparation failed");
await cp(join(root,"examples/runner-status/runner-status.artifact.tsx"),join(root,"dist/runner-status/runner-status.artifact.tsx"));
// Plugin preparation shares build intermediates; restore the core bundle last.
const core = Bun.spawn([process.execPath,"run","build:package"],{cwd:root,stdout:"inherit",stderr:"inherit"});
if(await core.exited !== 0) throw new Error("Core package preparation failed");
await mkdir(join(root,"dist/nicmini"),{recursive:true});
const service = await Bun.build({entrypoints:[join(import.meta.dir,"host-service.ts")],target:"bun",format:"esm",outdir:join(root,"dist/nicmini"),naming:"service.js"});
if(!service.success)throw new Error(service.logs.join("\n"));
console.log("Prepared optional nicmini deployment assets");
