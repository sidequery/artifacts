import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { authClient, signInUrl } from "../auth/client-api";
import type { GalleryArtifact, GalleryData } from "./types";
import { ExecutionControls } from "./execution-controls";
import { ArtifactSourcePanel, LinkSettings, ScriptPanel, type ScriptView } from "./hosted";
import { artifactFileTransferUrl } from "../sdk/files";
import { RemixPanel } from "./remix";
import { Select } from "./select";
import { MovePanel } from "./move";
import { SourceEditor } from "./source-editor";

type Scope = "current" | "all";
type DetailTab = "preview" | "source" | "activity" | "requests" | "secrets";
type KindFilter = "all" | "artifact" | "script";
type SourceState =
  | { status: "idle"; text: ""; error: "" }
  | { status: "loading"; text: ""; error: "" }
  | { status: "ready"; text: string; error: "" }
  | { status: "error"; text: ""; error: string };

const WORKING_VERSION = "working";

type SessionUser = { id: string; name: string; email: string };

const styles = `
  :root { color-scheme: dark; --page: #111214; --panel: #161719; --raised: #202225; --selected: #292c30; --line: #303336; --text: #e8e9e9; --muted: #a0a5aa; --subtle: #757b81; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body, #root { width: 100%; height: 100%; }
  body { margin: 0; background: var(--page); color: var(--text); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  button, input, select, textarea, a { font: inherit; color: inherit; touch-action: manipulation; }
  button, select, .download-link { cursor: pointer; }
  button, select, input { height: 32px; min-height: 32px; line-height: 20px; border: 1px solid transparent; border-radius: 0; background: transparent; padding: 5px 10px; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  select, input { border-color: var(--line); min-width: 0; }
  input { background: var(--page); }
  button:disabled, select:disabled { opacity: .45; cursor: default; }
  :is(button, input, select, textarea, summary, a):focus-visible { outline: 2px solid var(--text); outline-offset: -2px; }
  button, a { -webkit-tap-highlight-color: transparent; }
  .select-control { position: relative; display: inline-flex; min-width: 0; vertical-align: middle; }
  .select-control select { appearance: none; width: 100%; background: var(--panel); padding-right: 30px; text-overflow: ellipsis; }
  .select-chevron { position: absolute; pointer-events: none; right: 12px; top: 50%; width: 6px; height: 6px; margin-top: -4px; border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted); transform: rotate(45deg); }
  .select-control:has(select:disabled) .select-chevron { opacity: .45; }
  .gallery-app { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  .app-header { display: flex; align-items: center; gap: 16px; min-height: 52px; padding: 8px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .wordmark { font-size: 17px; font-weight: 600; letter-spacing: -.4px; }
  .header-context { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header-context::before { content: "/"; color: var(--subtle); margin-right: 16px; }
  .header-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }
  .header-actions .select-control { max-width: 180px; }
  .header-actions select { border-color: transparent; background: transparent; }
  .new-script { border-color: var(--line); white-space: nowrap; }
  .new-script span { color: var(--muted); }
  .account { display: flex; align-items: center; gap: 8px; margin-left: 8px; }
  .account-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .gallery-layout { display: grid; grid-template-columns: 248px minmax(0, 1fr); flex: 1; min-height: 0; }
  .library-panel { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-right: 1px solid var(--line); }
  .library-heading { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
  .library-heading h2 { margin: 0; font-size: 12px; font-weight: 500; color: var(--muted); }
  .library-count { font-size: 12px; color: var(--subtle); font-variant-numeric: tabular-nums; }
  .refresh-button { margin-left: auto; color: var(--muted); height: 28px; min-height: 28px; padding: 3px 0 3px 8px; font-size: 12px; }
  .library-search { position: relative; margin: 0 12px 8px; }
  .search-input { width: 100%; padding-right: 32px; }
  .search-input::placeholder { color: var(--subtle); }
  .search-input::-webkit-search-cancel-button { display: none; }
  .clear-search { position: absolute; right: 0; top: 0; bottom: 0; width: 32px; padding: 0; color: var(--muted); font-size: 18px; }
  .scope-control { margin: 0 12px 8px; display: flex; }
  .scope-control .select-control { width: 100%; }
  .scope-control select { color: var(--muted); background: transparent; border-color: transparent; padding-left: 0; }
  .scope-control .select-chevron { right: 8px; }
  .library-filters { display: flex; gap: 2px; padding: 0 8px 8px; border-bottom: 1px solid var(--line); }
  .library-filters button { height: 28px; min-height: 28px; padding: 3px 8px; font-size: 12px; color: var(--muted); }
  .library-filters button[aria-pressed="true"] { color: var(--text); background: var(--raised); }
  .artifact-list { overflow: auto; flex: 1; min-height: 0; padding: 0; }
  .artifact-row { display: flex; justify-content: flex-start; align-items: center; gap: 8px; width: 100%; height: auto; min-height: 34px; text-align: left; padding: 6px 12px; border: 0; }
  .artifact-row[aria-current="true"] { background: var(--selected); }
  .artifact-row-copy { min-width: 0; flex: 1; }
  .artifact-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .row-kind { flex-shrink: 0; color: var(--subtle); font-size: 11px; }
  .workspace-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--subtle); font-size: 11px; }
  .library-footer { padding: 8px 12px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; }
  .library-footer details { margin-top: 4px; }
  .library-footer summary { color: var(--muted); min-height: 24px; padding: 2px 0; }
  .library-footer p { margin: 6px 0; font-size: 12px; }
  .artifact-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .detail-header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 12px 20px; flex-shrink: 0; }
  .detail-title { min-width: 0; }
  .detail-eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 11px; }
  .detail-title h1 { margin: 0; font-size: 19px; line-height: 1.3; font-weight: 550; letter-spacing: -.35px; overflow-wrap: anywhere; }
  .detail-title h1:focus { outline: none; }
  .detail-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
  .detail-actions > :is(button, a) { white-space: nowrap; }
  .download-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; min-height: 32px; line-height: 20px; padding: 5px 10px; border: 1px solid transparent; text-decoration: none; }
  .detail-actions .open-link { margin-left: 6px; background: var(--text); color: var(--page); }
  .detail-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .view-control { display: flex; align-items: center; gap: 2px; }
  .view-control button { padding: 5px 10px; color: var(--muted); }
  .view-control button[aria-pressed="true"] { color: var(--text); background: var(--raised); }
  .revision-control { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
  .version-select { width: 240px; max-width: 240px; }
  .version-select select { border-color: transparent; background: transparent; color: var(--text); }
  .detail-actions button[aria-expanded="true"] { background: var(--raised); }
  .back-library, .mobile-more { display: none; }
  .mobile-more { position: relative; }
  .mobile-more summary { padding: 5px 10px; list-style: none; }
  .mobile-more summary::-webkit-details-marker { display: none; }
  .mobile-more .download-link { position: absolute; top: 100%; right: 0; min-width: 160px; background: var(--panel); border: 1px solid var(--line); z-index: 2; }
  .detail-disclosure { flex-shrink: 0; max-height: 42vh; overflow: auto; background: var(--panel); border-bottom: 1px solid var(--line); }
  .link-settings, .script-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  .link-settings { padding: 12px 20px; }
  .link-settings label, .script-fields label { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }
  .link-settings :is(button, .download-link), .script-panel button { border-color: var(--line); background: var(--raised); }
  .library-move { padding: 12px 20px; }
  .library-move p { margin: 0 0 10px; max-width: 720px; }
  .library-move button { border-color: var(--line); }
  .link-note { flex-basis: 100%; margin: 0; color: var(--muted); font-size: 12px; }
  .link-settings [role="status"] { align-self: center; }
  .link-settings .muted { font-size: 12px; }
  .script-panel { display: flex; flex-direction: column; flex: 1; width: 100%; min-width: 0; min-height: 0; overflow: hidden; }
  .source-form { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .source-form > .script-fields { padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .source-actions { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0; }
  .source-actions p { margin: 0; color: var(--muted); }
  .source-actions .source-readonly { margin-right: auto; }
  .script-panel label { color: var(--muted); font-size: 12px; }
  .script-panel :is(input, select) { color: var(--text); }
  .project-editor { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .project-file-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .project-file-bar button { background: transparent; border-color: transparent; font: 12px/20px "SFMono-Regular", Consolas, monospace; }
  .project-file-bar button[aria-pressed="true"] { background: var(--raised); }
  .source-code-editor { display: flex; flex-direction: column; flex: 1; min-height: 180px; min-width: 0; }
  .source-code-surface { flex: 1; min-height: 0; min-width: 0; }
  .source-code-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 16px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; flex-shrink: 0; }
  .project-file-management, .project-dependencies { flex-shrink: 0; border-top: 1px solid var(--line); padding: 0 16px; max-height: 35vh; overflow: auto; }
  .project-file-management > div { padding-bottom: 10px; }
  .project-file-management details { margin: 0; }
  .project-file-management p { margin: 6px 0; }
  .script-panel textarea, .artifact-execution textarea { display: block; width: 100%; min-height: 80px; margin: 6px 0 12px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 0; padding: 10px; font: 13px/1.6 "SFMono-Regular", Consolas, monospace; resize: vertical; }
  summary { cursor: pointer; min-height: 32px; padding-block: 5px; color: var(--text); }
  .script-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--line); background: var(--panel); }
  .script-activity, .artifact-execution { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; }
  .script-activity p { color: var(--muted); }
  .script-activity label { display: block; }
  .script-activity details + details { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 8px; }
  .artifact-execution label { display: inline-flex; flex-direction: column; gap: 4px; margin: 8px 12px 8px 0; }
  .artifact-execution label:has(textarea) { display: flex; margin-right: 0; }
  .artifact-execution button { border-color: var(--line); }
  .artifact-execution table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 12px; width: 100%; }
  .artifact-execution :is(td, th) { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  .artifact-execution p { color: var(--muted); }
  .muted { color: var(--muted); }
  .artifact-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .source-stage { display: flex; flex: 1; min-width: 0; min-height: 0; }
  .preview-stage { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; }
  .preview-frame { display: block; width: 100%; height: 100%; border: 0; }
  .preview-loading { position: absolute; inset: 0; display: grid; place-items: center; background: var(--page); color: var(--muted); pointer-events: none; }
  .state-message { margin: 0; padding: 12px; color: var(--muted); }
  .library-empty { padding: 20px 12px; }
  .library-empty p { margin: 0 0 8px; color: var(--muted); }
  .library-empty button { border-color: var(--line); }
  .empty-detail { margin: auto; max-width: 400px; padding: 24px; text-align: center; }
  .empty-detail h2 { margin: 0 0 8px; font-size: 18px; font-weight: 500; }
  .empty-detail p { margin: 0; color: var(--muted); }
  .error-message { color: #f2a5a5; }
  .source-form > .error-message, .script-panel > .error-message { margin: 0; padding: 8px 16px; flex-shrink: 0; }
  .refresh-error { padding: 10px 16px; margin: 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled), .download-link:hover { background: var(--raised); }
    .artifact-row[aria-current="true"]:hover { background: var(--selected); }
    .detail-actions .open-link:hover { background: #fff; }
    .view-control button:hover:not([aria-pressed="true"]), .library-filters button:hover:not([aria-pressed="true"]) { color: var(--text); background: transparent; }
  }
  @media (max-width: 1100px) {
    .gallery-layout { grid-template-columns: 220px minmax(0, 1fr); }
    .detail-header { align-items: flex-start; gap: 10px; padding-inline: 16px; }
    .detail-actions { max-width: 300px; }
    .revision-control > span:not(.select-control) { display: none; }
    .account-name { display: none; }
  }
  @media (max-width: 760px) {
    .app-header { min-height: 52px; padding: 6px 12px; gap: 10px; }
    .wordmark { font-size: 17px; }
    .header-context { display: none; }
    .header-actions { gap: 4px; }
    .header-actions .select-control { max-width: 130px; }
    .account { margin-left: 0; }
    .new-script { font-size: 12px; }
    .gallery-layout { display: flex; flex: 1; }
    .library-panel, .artifact-detail { width: 100%; flex: 1; }
    .library-panel { border-right: 0; }
    .artifact-row { min-height: 44px; }
    .artifact-name { font-size: 14px; }
    .back-library { display: inline-flex; align-self: flex-start; margin: 4px 4px 0; min-height: 36px; color: var(--muted); }
    .detail-header { flex-direction: column; padding: 4px 12px 8px; }
    .detail-actions { max-width: none; justify-content: flex-start; margin-left: -10px; }
    .detail-title h1 { font-size: 19px; }
    .detail-toolbar { gap: 4px; padding-inline: 4px; }
    .version-select { width: 150px; max-width: 150px; }
    .version-select select { padding-left: 6px; }
    .view-control { gap: 0; }
    .view-control button { padding-inline: 8px; }
    .revision-control { min-width: 0; margin-left: auto; }
    .desktop-download { display: none; }
    .mobile-more { display: block; }
    .link-settings { padding: 12px; }
    .script-fields > :is(input, label, .select-control) { max-width: 100%; }
    .link-settings label { flex: 1; min-width: 0; }
    .link-settings input { width: 100%; }
    .detail-disclosure { max-height: 45dvh; }
    .project-file-bar { padding-inline: 6px; }
    .source-actions { padding: 8px 12px; }
    .source-code-status { padding-inline: 12px; }
    .source-code-status .editor-shortcuts { display: none; }
    .script-activity, .artifact-execution { padding: 12px; }
  }
  @media (pointer: coarse) {
    button, input, select, .download-link, summary { height: auto; min-height: 44px; }
    input, select, textarea, .script-panel textarea { font-size: 16px; }
    .search-input { padding-block: 11px; }
    .clear-search { height: 44px; }
  }
`;

function isGalleryResponse(value: unknown): value is GalleryData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GalleryData>;
  return typeof candidate.workspace === "string" && Array.isArray(candidate.artifacts);
}

function sessionUser(value: unknown): SessionUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { authMode?: unknown; user?: Partial<SessionUser> };
  if (candidate.authMode !== "better-auth" || !candidate.user
    || typeof candidate.user.id !== "string" || typeof candidate.user.name !== "string"
    || typeof candidate.user.email !== "string") return null;
  return candidate.user as SessionUser;
}

function redirectExpiredSession(response: Response): boolean {
  if (response.status !== 401 || response.headers.get("X-Artifact-Auth") !== "better-auth") return false;
  window.location.assign(signInUrl());
  return true;
}

function galleryUrl(scope: Scope, offset = 0): string {
  const params = new URLSearchParams();
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  const workspace = new URLSearchParams(window.location.search).get("workspace");
  if (workspace) params.set("workspace", workspace);
  if (scope === "all") params.set("all", "1");
  if (offset) params.set("offset", String(offset));
  const query = params.toString();
  return `/api/gallery${query ? `?${query}` : ""}`;
}

function artifactUrl(path: "/api/source" | "/gallery/preview", artifact: GalleryArtifact, version: string, download = false): string {
  const params = new URLSearchParams();
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  params.set("workspace", artifact.workspace);
  if (artifact.kind === "script") params.set("kind", "script");
  if (version === WORKING_VERSION) params.set("name", artifact.name);
  else params.set("version", version);
  if (download) params.set("download", "1");
  return `${path}?${params.toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function App() {
  const [remixing, setRemixing] = useState(false);
  const [creatingScript, setCreatingScript] = useState(false);
  const [scope, setScope] = useState<Scope>("current");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [showLinks, setShowLinks] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [sourceVisited, setSourceVisited] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [narrowLayout, setNarrowLayout] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const libraryPanel = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const wasMobileDetail = useRef(false);
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("preview");
  const [loading, setLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [source, setSource] = useState<SourceState>({ status: "idle", text: "", error: "" });
  const [previewLoading, setPreviewLoading] = useState(true);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const createdRemix = useRef<{name:string;workspace:string;kind:string} | null>(null);
  const createdScriptName = useRef<string | null>(null);
  const galleryController = useRef<AbortController | null>(null);
  const galleryRequest = useRef(0);
  const sourceRequest = useRef(0);
  const previewFrame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrowLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (narrowLayout && mobileDetail) detailHeading.current?.focus({ preventScroll: true });
    else if (narrowLayout && wasMobileDetail.current) libraryPanel.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    wasMobileDetail.current = mobileDetail;
  }, [mobileDetail, narrowLayout]);

  const loadGallery = useCallback(async () => {
    galleryController.current?.abort();
    const controller = new AbortController();
    galleryController.current = controller;
    const request = ++galleryRequest.current;
    setLoading(true);
    setGalleryError("");

    try {
      let offset = 0;
      let payload: GalleryData;
      const artifacts = new Map<string, GalleryArtifact>();
      do {
        const response = await fetch(galleryUrl(scope, offset), {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (redirectExpiredSession(response)) return;
        if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
        const page: unknown = await response.json();
        if (!isGalleryResponse(page)) throw new Error("The gallery returned an unexpected response.");
        for (const artifact of page.artifacts) {
          const previous = artifacts.get(artifact.key);
          const versions = new Map([...(previous?.versions ?? []), ...artifact.versions].map(version => [version.id, version]));
          artifacts.set(artifact.key, { ...artifact, working: artifact.working || !!previous?.working, versions: [...versions.values()] });
        }
        payload = { ...page, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)) };
        if (page.nextOffset === undefined || page.nextOffset === null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid gallery pagination.");
        offset = page.nextOffset;
      } while (!controller.signal.aborted);
      if (request !== galleryRequest.current) return;

      setGallery(payload);
      setRefreshEpoch((epoch) => epoch + 1);
      const created = createdScriptName.current;
      createdScriptName.current = null;
      const remix = createdRemix.current;
      createdRemix.current = null;
      setSelectedKey((current) => {
        if (remix) return payload.artifacts.find(artifact => (artifact.kind ?? "artifact") === remix.kind && artifact.name === remix.name && artifact.workspace === remix.workspace)?.key ?? current;
        if (created) return payload.artifacts.find(artifact => artifact.kind === "script" && artifact.name === created)?.key ?? current;
        if (current && payload.artifacts.some((artifact) => artifact.key === current)) return current;
        const selection = new URLSearchParams(window.location.search);
        return payload.artifacts.find(item => item.name === selection.get("name") && item.workspace === (selection.get("workspace") ?? payload.workspace) && (item.kind ?? "artifact") === (selection.get("kind") ?? "artifact"))?.key ?? payload.artifacts[0]?.key ?? null;
      });
    } catch (error) {
      if (controller.signal.aborted || request !== galleryRequest.current) return;
      setGalleryError(error instanceof Error ? error.message : "Could not load the artifact library.");
    } finally {
      if (request === galleryRequest.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void loadGallery();
    return () => galleryController.current?.abort();
  }, [loadGallery]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/session", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (redirectExpiredSession(response) || !response.ok) return;
        const resolved = sessionUser(await response.json());
        if (!controller.signal.aborted) setUser(resolved);
      } catch {
        // Local Artifact servers do not expose an auth session endpoint.
      }
    })();
    return () => controller.abort();
  }, []);

  const filteredArtifacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (gallery?.artifacts ?? []).filter((artifact) =>
      (kindFilter === "all" || (artifact.kind ?? "artifact") === kindFilter) &&
      (!normalized || `${artifact.name}\n${artifact.workspace}`.toLocaleLowerCase().includes(normalized)),
    );
  }, [gallery, query, kindFilter]);

  const selectedArtifact = useMemo(
    () => gallery?.artifacts.find((artifact) => artifact.key === selectedKey) ?? null,
    [gallery, selectedKey],
  );

  const activeTab: DetailTab = selectedArtifact?.kind === "script"
    ? tab === "preview" ? "source" : tab
    : tab === "requests" || tab === "secrets" ? "preview" : tab;

  const sortedVersions = useMemo(
    () => [...(selectedArtifact?.versions ?? [])].sort((left, right) => right.revision - left.revision),
    [selectedArtifact],
  );

  const resolvedVersion = useMemo(() => {
    if (!selectedArtifact) return null;
    if (selectedVersion === WORKING_VERSION && selectedArtifact.working) return WORKING_VERSION;
    if (selectedVersion && sortedVersions.some((version) => version.id === selectedVersion)) return selectedVersion;
    if (selectedArtifact.working) return WORKING_VERSION;
    return sortedVersions[0]?.id ?? null;
  }, [selectedArtifact, selectedVersion, sortedVersions]);

  useEffect(() => {
    setSelectedVersion(resolvedVersion);
  }, [resolvedVersion]);

  useEffect(() => {
    if (activeTab === "source" && selectedArtifact && resolvedVersion) setSourceVisited(`${selectedArtifact.key}:${resolvedVersion}`);
  }, [activeTab, selectedArtifact?.key, resolvedVersion]);

  const previewUrl = selectedArtifact && selectedArtifact.kind !== "script" && resolvedVersion
    ? `${artifactUrl("/gallery/preview", selectedArtifact, resolvedVersion)}&refresh=${refreshEpoch}`
    : "";
  const downloadUrl = selectedArtifact && resolvedVersion
    ? artifactUrl("/api/source", selectedArtifact, resolvedVersion, true)
    : "";

  useEffect(() => {
    const pending = new Set<string>();
    const request = async (event: MessageEvent) => {
      const frame = previewFrame.current;
      if (!frame || event.source !== frame.contentWindow || !selectedArtifact
        || !["artifact/http-request", "artifact/plugin-request", "artifact/files-request", "artifact/file-download"].includes(event.data?.type) || typeof event.data.id !== "string"
        || event.data.id.length > 64 || (event.data.type !== "artifact/plugin-request" && typeof event.data.versionId !== "string") || pending.has(event.data.id)) return;
      const plugin = event.data.type === "artifact/plugin-request";
      const files = event.data.type === "artifact/files-request";
      const download = event.data.type === "artifact/file-download";
      const responseType = plugin ? "artifact/plugin-response" : files ? "artifact/files-response" : download ? "artifact/file-download-response" : "artifact/http-response";
      const target = frame.contentWindow!;
      const id = event.data.id;
      try {
        if (pending.size >= 16) throw new Error("Too many pending artifact requests");
        pending.add(id);
        if (download) {
          const url = artifactFileTransferUrl(event.data.url, window.location.origin);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "";
          anchor.rel = "noopener";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          target.postMessage({ type: responseType, id, result: null }, "*");
          return;
        }
        const params = new URLSearchParams({ workspace: selectedArtifact.workspace });
        const library = new URLSearchParams(window.location.search).get("library");
        if (library) params.set("library", library);
        const response = await fetch(`${plugin ? "/api/plugins/call" : files ? "/api/artifact/files" : "/api/artifact/request"}?${params}`, {
          method: "POST", headers: { "content-type": "application/json" },
          // The frame selects its pinned code version, but cannot redirect a
          // request to another artifact or private/team library.
          body: JSON.stringify(plugin ? event.data.request : { name: selectedArtifact.name, version_id: event.data.versionId, request: event.data.request }),
        });
        if (redirectExpiredSession(response)) return;
        const result = await response.json() as { response?: unknown; result?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error ?? `Artifact request failed (${response.status})`);
        target.postMessage({ type: responseType, id, response: result.response, result: result.result }, "*");
      } catch (error) {
        target.postMessage({ type: responseType, id, error: error instanceof Error ? error.message : String(error) }, "*");
      } finally { pending.delete(id); }
    };
    window.addEventListener("message", request);
    return () => window.removeEventListener("message", request);
  }, [selectedArtifact]);

  useEffect(() => {
    if (activeTab !== "source" || gallery?.capabilities?.links || !selectedArtifact || selectedArtifact.kind === "script" || !resolvedVersion) {
      setSource({ status: "idle", text: "", error: "" });
      return;
    }

    const controller = new AbortController();
    const request = ++sourceRequest.current;
    setSource({ status: "loading", text: "", error: "" });

    void (async () => {
      try {
        const response = await fetch(artifactUrl("/api/source", selectedArtifact, resolvedVersion), {
          signal: controller.signal,
          headers: { Accept: "text/plain" },
        });
        if (redirectExpiredSession(response)) return;
        if (!response.ok) throw new Error(`Source request failed (${response.status})`);
        const text = await response.text();
        if (!controller.signal.aborted && request === sourceRequest.current) {
          setSource({ status: "ready", text, error: "" });
        }
      } catch (error) {
        if (controller.signal.aborted || request !== sourceRequest.current) return;
        setSource({
          status: "error",
          text: "",
          error: error instanceof Error ? error.message : "Could not load this source file.",
        });
      }
    })();

    return () => controller.abort();
  }, [resolvedVersion, selectedArtifact, activeTab, gallery?.capabilities?.links]);

  useEffect(() => {
    if (activeTab === "preview") setPreviewLoading(true);
  }, [previewUrl, activeTab]);

  const selectArtifact = (artifact: GalleryArtifact) => {
    if (narrowLayout && !mobileDetail) setPreviewLoading(true);
    setMobileDetail(true);
    setShowLinks(false);
    setShowMove(false);
    setCreatingScript(false);
    setRemixing(false);
    setSelectedKey(artifact.key);
    setSelectedVersion(artifact.working ? WORKING_VERSION : [...artifact.versions].sort((a, b) => b.revision - a.revision)[0]?.id ?? null);
  };

  const signOut = async () => {
    setSigningOut(true);
    setAccountError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw result.error;
      window.location.assign(signInUrl());
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not sign out.");
      setSigningOut(false);
    }
  };

  const downloadSource = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!user) return;
    event.preventDefault();
    try {
      const response = await fetch(downloadUrl, { headers: { Accept: "text/plain" } });
      if (redirectExpiredSession(response)) return;
      if (!response.ok) throw new Error(`Source download failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selectedArtifact?.name ?? "artifact"}${selectedArtifact?.kind === "script" ? ".ts" : ".artifact.tsx"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not download this source file.");
    }
  };

  return (
    <>
      <style>{styles}</style>
      <main className="gallery-app">
        <header className="app-header">
          <span className="wordmark">Artifacts</span>
          {gallery?.workspace ? <span className="header-context" title={gallery.workspace}>{gallery.workspace}</span> : null}
          <div className="header-actions">
            {gallery?.libraryScope ? <Select aria-label="Library" value={gallery.libraryScope} onChange={event => {
              const url = new URL(window.location.href);
              url.searchParams.set("library", event.target.value);
              window.location.assign(url.href);
            }}><option value="private">Personal library</option><option value="team">Team library</option></Select> : null}
            {gallery?.capabilities?.scripts ? <button className="new-script" onClick={() => { setCreatingScript(true); setRemixing(false); setShowLinks(false); setShowMove(false); setMobileDetail(true); }}><span aria-hidden="true">+</span>New script</button> : null}
            {user ? <div className="account">
              <span className="account-name" title={user.email}>{user.name}</span>
              <button type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
            </div> : null}
          </div>
        </header>

        {galleryError && gallery ? <p role="alert" className="refresh-error error-message">Refresh failed: {galleryError}. Showing the last loaded files.</p> : null}
        {accountError ? <p role="alert" className="refresh-error error-message">{accountError}</p> : null}

        <div className="gallery-layout">
          <aside ref={libraryPanel} className="library-panel" hidden={narrowLayout && mobileDetail} aria-label={gallery?.capabilities?.scripts ? "Artifacts and scripts" : "Artifacts"}>
            <div className="library-heading">
              <h2>Library</h2>
              <span className="library-count" aria-label={`${gallery?.artifacts.length ?? 0} items`}>{gallery?.artifacts.length ?? "—"}</span>
              <button className="refresh-button" type="button" onClick={() => void loadGallery()} disabled={loading} aria-label={loading ? "Refreshing artifacts" : "Refresh"}>{loading ? "Refreshing…" : "Refresh"}</button>
            </div>
            <div className="library-search">
              <input ref={searchInput} className="search-input" type="search"
                aria-label={gallery?.capabilities?.scripts ? "Search artifacts and scripts" : "Search artifacts"}
                value={query} onChange={event => setQuery(event.target.value)} placeholder="Search library…"
                autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore />
              {query ? <button type="button" className="clear-search" aria-label="Clear search" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><span aria-hidden="true">×</span></button> : null}
            </div>
            <div className="scope-control">
              <Select aria-label="Project scope" value={scope} onChange={event => setScope(event.target.value as Scope)}>
                <option value="current">Current project</option><option value="all">All projects</option>
              </Select>
            </div>
            {gallery?.capabilities?.scripts ? <div className="library-filters" role="group" aria-label="Filter library">
              {([['all', 'All'], ['artifact', 'Artifacts'], ['script', 'Scripts']] as const).map(([value, label]) =>
                <button type="button" key={value} aria-pressed={kindFilter === value} onClick={() => setKindFilter(value)}>{label}</button>)}
            </div> : null}
            <div className="artifact-list">
              {loading && !gallery ? <p className="state-message" role="status">Loading library…</p>
                : galleryError && !gallery ? <div role="alert" className="library-empty">
                  <p className="error-message">{galleryError}</p><button type="button" onClick={() => void loadGallery()}>Try again</button>
                </div>
                : filteredArtifacts.length === 0 ? <div className="library-empty">
                  <p>{query ? "No matches" : kindFilter !== "all" ? `No ${kindFilter === "script" ? "scripts" : "artifacts"}` : "Your library is empty"}</p>
                  {query || kindFilter !== "all" ? <button type="button" onClick={() => { setQuery(""); setKindFilter("all"); }}>Show all items</button> : <p>Saved artifacts will appear here.</p>}
                </div>
                : filteredArtifacts.map(artifact => <button className="artifact-row" type="button" key={artifact.key}
                  title={`${artifact.workspace}/${artifact.name}`} aria-current={!creatingScript && artifact.key === selectedKey ? "true" : undefined}
                  onClick={() => selectArtifact(artifact)} onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest" })}>
                  <span className="artifact-row-copy">
                    <span className="artifact-name">{artifact.name}</span>
                    {scope === "all" ? <span className="workspace-name">{artifact.workspace}</span> : null}
                    {!artifact.working ? <span className="workspace-name">Archived</span> : null}
                  </span>
                  {artifact.kind === "script" ? <span className="row-kind">Script</span> : null}
                </button>)}
            </div>
            <div className="library-footer">{query || kindFilter !== "all" ? `${filteredArtifacts.length} of ${gallery?.artifacts.length ?? 0} items` : scope === "all" ? "Across all projects" : "In this project"}
              {gallery?.capabilities?.scripts ? <details><summary>Artifacts and scripts</summary><p>Artifacts are interactive apps with a UI and optional backend. Scripts are HTTP handlers that return a response when their URL is called.</p><p>Both have source files, dependencies, history, and their own URL.</p></details> : null}
            </div>
          </aside>

          <div className="artifact-detail" hidden={narrowLayout && !mobileDetail}>
            <button className="back-library" type="button" onClick={() => setMobileDetail(false)} aria-label="Back to library"><span aria-hidden="true">←&nbsp;</span> Library</button>
            <div className="detail-header">
              <div className="detail-title">
                <p className="detail-eyebrow">{creatingScript ? "Create" : selectedArtifact?.kind === "script" ? "HTTP script" : selectedArtifact ? "Interactive artifact" : "Library"}</p>
                <h1 ref={detailHeading} tabIndex={-1}>{creatingScript ? "New script" : selectedArtifact?.name ?? "Your artifacts"}</h1>
              </div>
              {!creatingScript && selectedArtifact && resolvedVersion ? <div className="detail-actions">
                {gallery?.capabilities?.links ? <button type="button" aria-expanded={showLinks} aria-controls="link-settings-panel" onClick={() => setShowLinks(value => !value)}>Link settings</button> : null}
                {gallery?.capabilities?.moves && gallery.libraryScope ? <button type="button" aria-expanded={showMove} aria-controls="library-move-panel" onClick={() => { setShowMove(value => !value); setShowLinks(false); setRemixing(false); }}>Move</button> : null}
                <button type="button" onClick={() => setRemixing(value => !value)} aria-expanded={remixing}>Remix</button>
                <a className="download-link desktop-download" href={downloadUrl} download onClick={downloadSource}>Download source</a>
                <details className="mobile-more"><summary aria-label="More actions">More</summary><a className="download-link" href={downloadUrl} download onClick={downloadSource}>Download source</a></details>
                {selectedArtifact.kind !== "script" && selectedArtifact.url ? <a className="download-link open-link" href={selectedArtifact.url} target="_blank" rel="noopener noreferrer">Open<span aria-hidden="true">↗</span></a> : null}
              </div> : null}
            </div>
            {!creatingScript && selectedArtifact && resolvedVersion ? <div className="detail-toolbar">
              <div className="view-control" role="group" aria-label={selectedArtifact.kind === "script" ? "Script view" : "Artifact view"}>
                {(selectedArtifact.kind === "script"
                  ? [["source", "Source"], ["requests", "Requests"], ["activity", "Activity"], ["secrets", "Secrets"]] as const
                  : [["preview", "Preview"], ["source", "Source"], ...(gallery?.capabilities?.links ? [["activity", "Activity"] as const] : [])] as const
                ).map(([value, label]) => <button key={value} type="button" aria-pressed={activeTab === value} aria-controls="artifact-panel" onClick={() => setTab(value)}>{label}</button>)}
              </div>
              <label className="revision-control"><span>Version</span><Select className="version-select" aria-label="Version" value={resolvedVersion} onChange={event => setSelectedVersion(event.target.value)}>
                {selectedArtifact.working ? <option value={WORKING_VERSION}>Working copy</option> : null}
                {sortedVersions.map(version => <option key={version.id} value={version.id}>Revision {version.revision} · {formatDate(version.createdAt)}</option>)}
              </Select></label>
            </div> : null}
            {showMove && !creatingScript && selectedArtifact && gallery?.libraryScope && gallery.capabilities?.moves ? <div id="library-move-panel" className="detail-disclosure"><MovePanel key={selectedArtifact.key} artifact={selectedArtifact} library={gallery.libraryScope} onCancel={() => setShowMove(false)} /></div> : null}
            {remixing && !creatingScript && selectedArtifact && resolvedVersion ? <div className="detail-disclosure"><RemixPanel key={selectedArtifact.key + resolvedVersion} artifact={selectedArtifact} version={resolvedVersion} onCancel={() => setRemixing(false)} onSaved={async name => { createdRemix.current = {name, workspace:selectedArtifact.workspace, kind:selectedArtifact.kind ?? "artifact"}; await loadGallery(); setSelectedVersion("working"); setQuery(""); setKindFilter("all"); setRemixing(false); }} /></div> : null}
            {!creatingScript && selectedArtifact && gallery?.capabilities?.links ? <div id="link-settings-panel" className="detail-disclosure" hidden={!showLinks}><LinkSettings key={selectedArtifact.key} artifact={selectedArtifact} onSaved={loadGallery} /></div> : null}
            <section id="artifact-panel" className="artifact-stage" aria-label={selectedArtifact?.kind === "script" || creatingScript ? "Script editor" : activeTab === "preview" ? "Artifact preview" : activeTab === "activity" ? "Artifact activity" : "Artifact source"}>
              {creatingScript ? <ScriptPanel key="new-script" workspace={gallery?.workspace ?? "default"} onCancel={() => setCreatingScript(false)} onSaved={async name => { createdScriptName.current = name; await loadGallery(); setCreatingScript(false); setSelectedVersion("working"); setTab("source"); setQuery(""); setKindFilter("all"); }} />
                : selectedArtifact?.kind === "script" ? <ScriptPanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} workspace={selectedArtifact.workspace} version={resolvedVersion ?? undefined} view={activeTab as ScriptView} sourceUrl={resolvedVersion ? artifactUrl("/api/source", selectedArtifact, resolvedVersion) : undefined} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
                : !selectedArtifact ? <div className="empty-detail"><h2>{loading ? "Loading your library…" : "Your library"}</h2><p>{loading ? "Your saved artifacts will appear shortly." : "Select an artifact or script to open it."}</p></div>
                : !resolvedVersion ? <div className="empty-detail"><h2>No readable version</h2><p>This artifact has no saved source available to preview.</p></div>
                : <>
                  {activeTab === "preview" ? <div className="preview-stage">
                    {previewLoading ? <div className="preview-loading" role="status">Loading preview…</div> : null}
                    {!narrowLayout || mobileDetail ? <iframe ref={previewFrame} key={previewUrl} className="preview-frame" src={previewUrl} title={`Preview of ${selectedArtifact.name}`} sandbox="allow-scripts" onLoad={() => setPreviewLoading(false)} /> : null}
                  </div> : null}
                  {sourceVisited === `${selectedArtifact.key}:${resolvedVersion}` || activeTab === "source" ? <div className="source-stage" hidden={activeTab !== "source"}>
                    {gallery?.capabilities?.links ? <ArtifactSourcePanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} version={resolvedVersion} sourceUrl={artifactUrl("/api/source", selectedArtifact, resolvedVersion)} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
                      : source.status === "ready" ? <SourceEditor filename={`${selectedArtifact.name}.artifact.tsx`} value={source.text} onChange={() => {}} readOnly />
                      : source.status === "error" ? <p role="alert" className="state-message error-message">{source.error}</p>
                      : <p className="state-message" role="status">Loading source…</p>}
                  </div> : null}
                  {gallery?.capabilities?.links ? <div id="execution-panel" className="artifact-execution" hidden={activeTab !== "activity"}><ExecutionControls key={selectedArtifact.key + "execution"} workspace={selectedArtifact.workspace} name={selectedArtifact.name} kind="artifact" /></div> : null}
                </>}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
