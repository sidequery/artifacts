import { artifactIdFromFile } from "./artifactFile";
import { compileArtifact } from "./compile";
import { ensureArtifactServer } from "./local/preview-daemon";
import { formatArtifactCheck } from "./diagnostics";
import {
  artifactPaneOpenArgs,
  createHerdrClient,
  type CommandResult,
  type HerdrClient,
  type PanePlacement,
} from "./herdr";
import { typecheckArtifact } from "./typecheck";
import { ArtifactHistory, historyPath } from "./history";

export type OpenResult = {
  ok: boolean;
  url?: string;
  artifactId?: string;
  reusedServer?: boolean;
  opened?: "artifact-pane" | "none";
  check: string;
  diagnostics: ReturnType<typeof typecheckArtifact>;
  herdr?: CommandResult;
};

export type OpenArtifactOptions = {
  artifactsDir: string;
  herdr?: HerdrClient;
  placement?: PanePlacement;
  direction?: "right" | "down";
  focus?: boolean;
  env?: NodeJS.ProcessEnv;
  ensureServer?: typeof ensureArtifactServer;
  compile?: typeof compileArtifact;
  skipOpen?: boolean;
  inProcessServer?: boolean;
  versionId?: string;
  eventId?: string;
};

export async function openArtifact(artifactPath: string, opts: OpenArtifactOptions): Promise<OpenResult> {
  let snapshot: string | undefined;
  if (opts.versionId) {
    const archive = new ArtifactHistory(historyPath(opts.env));
    try {
      const version = archive.version(opts.versionId, opts.artifactsDir);
      if (!version) throw new Error("version not found in this workspace");
      if (opts.eventId && !archive.events(version.id).some(event => event.id === opts.eventId)) throw new Error("serve event not found for version");
      snapshot = version.source;
    } finally { archive.close(); }
  }
  const diagnostics = snapshot === undefined ? typecheckArtifact(artifactPath) : [];
  const check = snapshot === undefined ? formatArtifactCheck(diagnostics) : "Archived source: compiling with the installed SDK";
  if (diagnostics.length > 0) {
    return { ok: false, check, diagnostics, opened: "none" };
  }

  const compile = opts.compile ?? compileArtifact;
  const compiled = await compile(artifactPath, snapshot);
  if (!compiled.ok) {
    return {
      ok: false,
      check: formatArtifactCheck(compiled.diagnostics),
      diagnostics: compiled.diagnostics,
      opened: "none",
    };
  }

  const artifactId = artifactIdFromFile(artifactPath);
  const paneContext = {
    workspaceId: opts.env?.HERDR_WORKSPACE_ID,
    targetPaneId: opts.env?.HERDR_PANE_ID,
    historyPath: historyPath(opts.env),
    versionId: opts.versionId,
    eventId: opts.eventId,
  };

  if (opts.skipOpen) {
    const ensure = opts.ensureServer ?? ensureArtifactServer;
    const server = await ensure({
      artifactsDir: opts.artifactsDir,
      env: opts.env,
      inProcess: opts.inProcessServer,
    });
    const route = opts.versionId ? `/v/${opts.versionId}${opts.eventId ? `?event=${encodeURIComponent(opts.eventId)}` : ""}` : `/c/${encodeURIComponent(artifactId)}`;
    const url = `${server.url.replace(/\/$/, "")}${route}`;
    return {
      ok: true,
      url,
      artifactId,
      reusedServer: server.reused,
      opened: "none",
      check,
      diagnostics: [],
    };
  }

  const herdr = opts.herdr ?? createHerdrClient(opts.env);
  let pane = herdr.run(
    artifactPaneOpenArgs(artifactPath, opts.artifactsDir, {
      placement: opts.placement,
      direction: opts.direction,
      focus: opts.focus,
      ...paneContext,
    }),
  );
  if (pane.status !== 0 && `${pane.stdout}${pane.stderr}`.includes("no_active_pane")) {
    pane = herdr.run(
      artifactPaneOpenArgs(artifactPath, opts.artifactsDir, {
        placement: "tab",
        focus: opts.focus,
        ...paneContext,
      }),
    );
  }
  return {
    ok: pane.status === 0,
    artifactId,
    opened: "artifact-pane",
    check,
    diagnostics: [],
    herdr: pane,
  };
}
