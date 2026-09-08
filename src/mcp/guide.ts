// Kept in sync with the SDK by the guide contract test, without importing
// browser-only React modules into the Cloudflare server.
export const ARTIFACTS_GUIDE_EXPORTS = [
  "BarChart", "Button", "Callout", "Card", "CardBody", "CardHeader", "Checkbox",
  "Code", "Divider", "Grid", "H1", "H2", "H3", "LineChart", "Link", "PieChart",
  "Pill", "Row", "Select", "Spacer", "Stack", "Stat", "Table", "Text", "TextArea",
  "TextInput", "Toggle", "artifactFetch", "pluginCall", "Routes", "Route", "Outlet", "Navigate", "NavLink", "useNavigate", "useParams", "useLocation", "useSearchParams", "useMatch", "useResolvedPath", "artifactPaletteDark", "artifactPaletteLight", "artifactTypography",
  "mergeStyle", "themeFromKind", "tokensFromPalette", "useArtifactAction", "useArtifactState", "useState", "useReducer", "useRef", "useMemo", "useCallback", "useEffect", "useHostTheme",
  "artifactFiles", "MAX_ARTIFACTS_FILE_BYTES",
];
export const LEGACY_GUIDE_EXPORTS = [
  "useCanvasAction", "useCanvasState", "canvasFetch", "canvasFiles", "MAX_CANVAS_FILE_BYTES",
  "canvasPaletteDark", "canvasPaletteLight", "canvasTypography",
];

export function artifactGuide() {
  return `# Sidequery Artifacts SDK contract

Read this guide before your first artifact_write in the conversation. Reuse it for subsequent creates and edits; read it again when unsure about the SDK.

## Source and imports

Submit a complete TSX entrypoint with a default-exported React component. Use a kebab-case artifact name without slashes. Import the SDK from "sidequery/artifacts" ("herdr/canvas" and "cursor/canvas" are compatibility aliases). Add relative helper modules with artifact_write.project.files and exact package versions with project.dependencies. Omit project to preserve it; when supplied, files and dependencies replace the existing declarations. Dependency source is integrity-verified and archived for offline replay; project.lock is read-only. Use artifact_read/artifact_edit with file to select a helper. Hosted deployments may also expose browser packages listed by plugins_list. Browser React packages share the host runtime. Dynamic imports and require remain unsupported in authored artifact modules.

These are the installed SDK's runtime exports:
${ARTIFACTS_GUIDE_EXPORTS.join(", ")}

Historical sources can still use these compatibility aliases: ${LEGACY_GUIDE_EXPORTS.join(", ")}. Use the Artifacts names for new source.

## State and host hooks

- useState, useReducer, useRef, useMemo, useCallback, useEffect: standard React hooks for component-local state and behavior.
- useArtifactState<T>(key: string, defaultValue: T): [T, setter] for host-backed state. Keys must be stable and distinct. The setter accepts a value or updater. Live local views persist through the host; MCP and gallery views keep isolated in-memory state.
- useHostTheme(): returns the host theme with color and typography tokens.
- useArtifactAction(): returns a dispatcher accepting {type: "openFile", path, selection?}, {type: "promptAgent", prompt}, or {type: "openUrl", url}. In MCP Apps, promptAgent and HTTP(S) openUrl depend on host approval; openFile is unavailable.

## Deployment plugins

pluginCall<T>(plugin, operation, input, { signal }?) calls an authenticated deployment function. Use plugins_list for installed names and schemas and plugin_guide for access rules. Installed browser libraries may wrap this helper with their own typed API. A view without the hosted plugin bridge rejects calls.

## Routing

The runtime supplies React Router. Use Routes, Route, Outlet, Navigate, NavLink and routing hooks from sidequery/artifacts. Link to="/accounts/123" navigates within an artifact; existing Link href="https://..." keeps ordinary link behavior. Nested layouts, params, search params and navigation state work normally. Standalone /slug/* URLs support deep links, reload and browser back/forward. Gallery and chat views keep navigation in memory. /api and /api/* are reserved for the artifact backend; /_artifact/* is reserved for runtime bridges.

## Hosted servers and SQLite

artifactFetch(path: string, init?: RequestInit): Promise<Response> sends a request to the artifact's native server through the host bridge. Use relative paths and standard methods, headers, and bodies; check response.ok before reading response.json() or response.text(). Cross-origin and protocol-relative URLs are rejected. Request and response bodies are limited to 256 KiB.

Server requests require a hosted runtime with a native artifacts server. Local Bun CLI, local stdio MCP and local gallery views do not execute servers and report requests as unavailable. Hosted MCP Apps and the hosted gallery support them. Hosted artifact_write accepts server TypeScript exporting class ArtifactServer extends DurableObject from "cloudflare:workers", alongside browser contents.

Each artifact with a server gets one native SQLite database. Different artifact names get separate databases; multiple tabs and server restarts use the same database. Use this.ctx.storage.sql.exec(sql, ...bindings) with ? placeholders for values; cursors support .toArray() and .one(). Use this.ctx.storage.kv.get/put/delete for key/value data and this.ctx.storage.transactionSync(() => { ... }) for synchronous SQL/KV transactions. Initialize tables with create table if not exists.

Artifacts has no application-schema migration runner. For schema changes, keep a schema version in the database and apply pending changes plus the version update in one this.ctx.storage.transactionSync during server initialization, before serving requests. Saving source does not execute migrations; they run when that server is next requested. Prefer additive changes compatible with older source because source restore does not reverse migrations.

Omitting server preserves existing code; null removes code without deleting the database. Hosted artifact_read/artifact_edit accept part: "server". Browser and server source are versioned together; the database remains live across source edits and restores. Archived code also runs against the current database, not a historical snapshot.

Database identity is library + workspace + artifact name: private libraries isolate users; an authorized team library shares data. Server code has no ordinary D1, R2 or custom Worker bindings and no global outbound access.

Direct HTTP requests to /slug/api and /slug/api/* reach the active artifact backend with the /api path and query preserved. Unknown API routes never fall back to page HTML; an artifact without a backend returns JSON 404. Existing body limits and access rules apply.

Implement fetch(request: Request) on ArtifactServer and return a Response; browser code calls it with artifactFetch. SQLite stores durable application data; useState and useArtifactState hold UI state. Agents can also invoke the hosted artifact_request tool with name or version_id and a request envelope (path, method, headers, base64 body).

## Persistent files

Hosted artifacts and the managed local celld server expose artifactFiles from sidequery/artifacts; no server code is required. artifactFiles.upload(file: File | Blob, {name?, signal?}?) returns {id,name,size,type,uploaded}; maximum 25 MiB. artifactFiles.list({cursor?}?) returns {files,cursor?} with at most 100 files. artifactFiles.read(id, {signal?}?) returns a Blob for parsing; artifactFiles.download(id) asks the host to start a download; artifactFiles.delete(id) removes it. Catch errors and show them in the UI. Use an input type="file" to select uploads. Filenames are display metadata; use opaque file IDs for subsequent operations.

Files use the same library + workspace + artifact identity as the database and stay live across source edits, archived previews and restores. Uploads create distinct files even when names match. Public standalone artifacts expose their files for reading but cannot upload/delete through the public URL. Plain file-based previews have no file storage. Transfer URLs expire after five minutes; bytes bypass the small JSON bridge. Agents use artifact_files for listing or allocating transfers, then ordinary HTTP PUT/GET for bytes. Never put file bytes or bearer transfer URLs into artifact source.

## Common components and props

- Stack: children, gap?, style?. Row: children, gap?, align?, justify?, wrap?, style?. Grid: columns (number or CSS template string), children, gap?, style?.
- Table: headers: ReactNode[], rows: ReactNode[][]; optional columnAlign, rowTone, striped, stickyHeader, emptyMessage.
- Card: collapsible?, defaultOpen?, open?, onOpenChange(open)?; compose with CardHeader and CardBody. Button: variant "primary" | "secondary" | "ghost". Stat: value, label, tone? ("success" | "danger" | "warning" | "info").
- TextInput/TextArea: value (string), onChange(value), placeholder?, disabled?. Checkbox/Toggle: checked, onChange(checked), label?, disabled?. Select: value, onChange(value), options: [{value, label}]. SDK form callbacks receive values, not DOM events.
- BarChart/LineChart: categories: string[], series: [{name, data: number[], tone?}], height?, caption?. Each series aligns with categories; axes support beginAtZero, yMin, yMax, referenceLines. BarChart also supports stacked/horizontal; LineChart supports fill. PieChart: data: [{label, value, tone?}], size?, donut?, caption?.
- SDK components do not necessarily accept arbitrary DOM props.

## Restrictions and validation

For browser TSX, embed data in the source or use artifactFetch when a hosted native server is available. Direct network calls (fetch, XMLHttpRequest, WebSocket), eval, new Function, process/Bun APIs, localStorage and sessionStorage are disallowed. The browser import restrictions above do not apply to native server source, which imports DurableObject from "cloudflare:workers".

artifact_write creates or replaces the full source and then validates it. artifact_edit applies exact replacements and then validates; use artifact_read's source_hash as expected_hash to guard edits. A failed typecheck can leave source applied: inspect applied/ok and diagnostics, fix the source, and validate again. Do not treat an error as a rollback. Successful writes/edits show an inline preview in MCP Apps hosts. artifact_typecheck and artifact_compile check existing artifacts; artifact_open shows one. artifact_history lists revisions; artifact_version reads archived source; artifact_restore restores source as a new revision while retaining current state. Hosted revisions include both client and server source.
`;
}

export function artifactGuideResult() {
  return { content: [{ type: "text" as const, text: artifactGuide() }], isError: false };
}
