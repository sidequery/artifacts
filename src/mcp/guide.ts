// Kept in sync with the SDK by the guide contract test, without importing
// browser-only React modules into the Cloudflare server.
export const CANVAS_GUIDE_EXPORTS = [
  "BarChart", "Button", "Callout", "Card", "CardBody", "CardHeader", "Checkbox",
  "Code", "Divider", "Grid", "H1", "H2", "H3", "LineChart", "Link", "PieChart",
  "Pill", "Row", "Select", "Spacer", "Stack", "Stat", "Table", "Text", "TextArea",
  "TextInput", "Toggle", "canvasFetch", "canvasPaletteDark", "canvasPaletteLight", "canvasTypography",
  "mergeStyle", "themeFromKind", "tokensFromPalette", "useCanvasAction", "useCanvasState", "useState", "useReducer", "useRef", "useMemo", "useCallback", "useEffect", "useHostTheme",
];

export function canvasGuide() {
  return `# Sidequery Canvas SDK contract

Read this guide before your first canvas_write in the conversation. Reuse it for subsequent creates and edits; read it again when unsure about the SDK.

## Source and imports

Submit a complete TSX module with a default-exported React component. Use a kebab-case canvas name without slashes. Import from "sidequery/canvas" ("herdr/canvas" and "cursor/canvas" are compatibility aliases). Do not import react, other packages, relative files, or use dynamic imports or require.

These are the installed SDK's runtime exports:
${CANVAS_GUIDE_EXPORTS.join(", ")}

## State and host hooks

- useState, useReducer, useRef, useMemo, useCallback, useEffect: standard React hooks for component-local state and behavior.
- useCanvasState<T>(key: string, defaultValue: T): [T, setter] for host-backed state. Keys must be stable and distinct. The setter accepts a value or updater. Live local views persist through the host; MCP and gallery views keep isolated in-memory state.
- useHostTheme(): returns the host theme with color and typography tokens.
- useCanvasAction(): returns a dispatcher accepting {type: "openFile", path, selection?}, {type: "promptAgent", prompt}, or {type: "openUrl", url}. In MCP Apps, promptAgent and HTTP(S) openUrl depend on host approval; openFile is unavailable.

## Hosted servers and SQLite

canvasFetch(path: string, init?: RequestInit): Promise<Response> sends a request to the canvas's native server through the host bridge. Use relative paths and standard methods, headers, and bodies; check response.ok before reading response.json() or response.text(). Cross-origin and protocol-relative URLs are rejected. Request and response bodies are limited to 256 KiB.

Server requests require a hosted runtime with a native canvas server. Local Bun CLI, local stdio MCP and local gallery views do not execute servers and report requests as unavailable. Hosted MCP Apps and the hosted gallery support them. Hosted canvas_write accepts server TypeScript exporting class CanvasServer extends DurableObject from "cloudflare:workers", alongside browser contents.

Each canvas with a server gets one native SQLite database. Different canvas names get separate databases; multiple tabs and server restarts use the same database. Use this.ctx.storage.sql.exec(sql, ...bindings) with ? placeholders for values; cursors support .toArray() and .one(). Use this.ctx.storage.kv.get/put/delete for key/value data and this.ctx.storage.transactionSync(() => { ... }) for synchronous SQL/KV transactions. Initialize tables with create table if not exists.

Canvas has no application-schema migration runner. For schema changes, keep a schema version in the database and apply pending changes plus the version update in one this.ctx.storage.transactionSync during server initialization, before serving requests. Saving source does not execute migrations; they run when that server is next requested. Prefer additive changes compatible with older source because source restore does not reverse migrations.

Omitting server preserves existing code; null removes code without deleting the database. Hosted canvas_read/canvas_edit accept part: "server". Browser and server source are versioned together; the database remains live across source edits and restores. Archived code also runs against the current database, not a historical snapshot.

Database identity is library + workspace + canvas name: private libraries isolate users; an authorized team library shares data. Server code has no ordinary D1, R2 or custom Worker bindings and no global outbound access.

Implement fetch(request: Request) on CanvasServer and return a Response; browser code calls it with canvasFetch. SQLite stores durable application data; useState and useCanvasState hold UI state. Agents can also invoke the hosted canvas_request tool with name or version_id and a request envelope (path, method, headers, base64 body).

## Common components and props

- Stack: children, gap?, style?. Row: children, gap?, align?, justify?, wrap?, style?. Grid: columns (number or CSS template string), children, gap?, style?.
- Table: headers: ReactNode[], rows: ReactNode[][]; optional columnAlign, rowTone, striped, stickyHeader, emptyMessage.
- Card: collapsible?, defaultOpen?, open?, onOpenChange(open)?; compose with CardHeader and CardBody. Button: variant "primary" | "secondary" | "ghost". Stat: value, label, tone? ("success" | "danger" | "warning" | "info").
- TextInput/TextArea: value (string), onChange(value), placeholder?, disabled?. Checkbox/Toggle: checked, onChange(checked), label?, disabled?. Select: value, onChange(value), options: [{value, label}]. SDK form callbacks receive values, not DOM events.
- BarChart/LineChart: categories: string[], series: [{name, data: number[], tone?}], height?, caption?. Each series aligns with categories; axes support beginAtZero, yMin, yMax, referenceLines. BarChart also supports stacked/horizontal; LineChart supports fill. PieChart: data: [{label, value, tone?}], size?, donut?, caption?.
- SDK components do not necessarily accept arbitrary DOM props.

## Restrictions and validation

For browser TSX, embed data in the source or use canvasFetch when a hosted native server is available. Direct network calls (fetch, XMLHttpRequest, WebSocket), eval, new Function, process/Bun APIs, localStorage and sessionStorage are disallowed. The browser import restrictions above do not apply to native server source, which imports DurableObject from "cloudflare:workers".

canvas_write creates or replaces the full source and then validates it. canvas_edit applies exact replacements and then validates; use canvas_read's source_hash as expected_hash to guard edits. A failed typecheck can leave source applied: inspect applied/ok and diagnostics, fix the source, and validate again. Do not treat an error as a rollback. Successful writes/edits show an inline preview in MCP Apps hosts. canvas_typecheck and canvas_compile check existing canvases; canvas_open shows one. canvas_history lists revisions; canvas_version reads archived source; canvas_restore restores source as a new revision while retaining current state. Hosted revisions include both client and server source.
`;
}

export function canvasGuideResult() {
  return { content: [{ type: "text" as const, text: canvasGuide() }], isError: false };
}
