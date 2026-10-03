import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactHistory } from "../src/history";
import { createArtifactServer } from "../src/serve";

// Each launch gets independent files and history, never the user's library.
const directory = join(await mkdtemp(join(tmpdir(), "sidequery-artifacts-demo-")), "Demo workspace");
await mkdir(directory);
const historyPath = join(directory, "history.sqlite");
const history = new ArtifactHistory(historyPath);
const sample = await readFile(new URL("../examples/library-demo.artifact.tsx", import.meta.url), "utf8");
for (const name of ["Launch checklist", "Team directory", "Release notes"]) {
  const source = sample.replace('demoView: string = "Launch checklist"', `demoView: string = ${JSON.stringify(name)}`);
  const sourcePath = join(directory, `${name}.artifact.tsx`);
  await writeFile(sourcePath, source);
  history.capture({ workspace: directory, name, sourcePath, source, runtime: "demo", reason: "Demo starting point" });
}
history.close();
const server = await createArtifactServer({ artifactsDir: directory, historyPath, gallery: true, port: Number(process.env.DEMO_PORT ?? 4788) });
console.log(`Artifacts demo: ${server.url}\nTemporary library: ${directory}`);
const stop = () => { server.stop(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
