import { canvasIdFromFile } from "./canvasFile";
import { compileCanvas } from "./compile";
import { ensureCanvasServer } from "./local/preview-daemon";
import { formatCanvasCheck } from "./diagnostics";
import {
  canvasPaneOpenArgs,
  createHerdrClient,
  type CommandResult,
  type HerdrClient,
  type PanePlacement,
} from "./herdr";
import { typecheckCanvas } from "./typecheck";
import { CanvasHistory, historyPath } from "./history";

export type OpenResult = {
  ok: boolean;
  url?: string;
  canvasId?: string;
  reusedServer?: boolean;
  opened?: "canvas-pane" | "none";
  check: string;
  diagnostics: ReturnType<typeof typecheckCanvas>;
  herdr?: CommandResult;
};

export type OpenCanvasOptions = {
  canvasesDir: string;
  herdr?: HerdrClient;
  placement?: PanePlacement;
  direction?: "right" | "down";
  focus?: boolean;
  env?: NodeJS.ProcessEnv;
  ensureServer?: typeof ensureCanvasServer;
  compile?: typeof compileCanvas;
  skipOpen?: boolean;
  inProcessServer?: boolean;
  versionId?: string;
  eventId?: string;
};

export async function openCanvas(canvasPath: string, opts: OpenCanvasOptions): Promise<OpenResult> {
  let snapshot: string | undefined;
  if (opts.versionId) {
    const archive = new CanvasHistory(historyPath(opts.env));
    try {
      const version = archive.version(opts.versionId, opts.canvasesDir);
      if (!version) throw new Error("version not found in this workspace");
      if (opts.eventId && !archive.events(version.id).some(event => event.id === opts.eventId)) throw new Error("serve event not found for version");
      snapshot = version.source;
    } finally { archive.close(); }
  }
  const diagnostics = snapshot === undefined ? typecheckCanvas(canvasPath) : [];
  const check = snapshot === undefined ? formatCanvasCheck(diagnostics) : "Archived source: compiling with the installed SDK";
  if (diagnostics.length > 0) {
    return { ok: false, check, diagnostics, opened: "none" };
  }

  const compile = opts.compile ?? compileCanvas;
  const compiled = await compile(canvasPath, snapshot);
  if (!compiled.ok) {
    return {
      ok: false,
      check: formatCanvasCheck(compiled.diagnostics),
      diagnostics: compiled.diagnostics,
      opened: "none",
    };
  }

  const canvasId = canvasIdFromFile(canvasPath);
  const paneContext = {
    workspaceId: opts.env?.HERDR_WORKSPACE_ID,
    targetPaneId: opts.env?.HERDR_PANE_ID,
    historyPath: historyPath(opts.env),
    versionId: opts.versionId,
    eventId: opts.eventId,
  };

  if (opts.skipOpen) {
    const ensure = opts.ensureServer ?? ensureCanvasServer;
    const server = await ensure({
      canvasesDir: opts.canvasesDir,
      env: opts.env,
      inProcess: opts.inProcessServer,
    });
    const route = opts.versionId ? `/v/${opts.versionId}${opts.eventId ? `?event=${encodeURIComponent(opts.eventId)}` : ""}` : `/c/${encodeURIComponent(canvasId)}`;
    const url = `${server.url.replace(/\/$/, "")}${route}`;
    return {
      ok: true,
      url,
      canvasId,
      reusedServer: server.reused,
      opened: "none",
      check,
      diagnostics: [],
    };
  }

  const herdr = opts.herdr ?? createHerdrClient(opts.env);
  let pane = herdr.run(
    canvasPaneOpenArgs(canvasPath, opts.canvasesDir, {
      placement: opts.placement,
      direction: opts.direction,
      focus: opts.focus,
      ...paneContext,
    }),
  );
  if (pane.status !== 0 && `${pane.stdout}${pane.stderr}`.includes("no_active_pane")) {
    pane = herdr.run(
      canvasPaneOpenArgs(canvasPath, opts.canvasesDir, {
        placement: "tab",
        focus: opts.focus,
        ...paneContext,
      }),
    );
  }
  return {
    ok: pane.status === 0,
    canvasId,
    opened: "canvas-pane",
    check,
    diagnostics: [],
    herdr: pane,
  };
}
