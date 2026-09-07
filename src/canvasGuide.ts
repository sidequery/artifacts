// Kept in sync with the SDK by the guide contract test, without importing
// browser-only React modules into the Cloudflare server.
export const CANVAS_GUIDE_EXPORTS = [
  "BarChart", "Button", "Callout", "Card", "CardBody", "CardHeader", "Checkbox",
  "Code", "Divider", "Grid", "H1", "H2", "H3", "LineChart", "Link", "PieChart",
  "Pill", "Row", "Select", "Spacer", "Stack", "Stat", "Table", "Text", "TextArea",
  "TextInput", "Toggle", "canvasPaletteDark", "canvasPaletteLight", "canvasTypography",
  "mergeStyle", "themeFromKind", "tokensFromPalette", "useCanvasAction", "useCanvasState", "useHostTheme",
];

export const CANVAS_GUIDE_EXAMPLE = `import { Button, H1, Stack, useCanvasState } from "herdr/canvas";

export default function Counter() {
  const [count, setCount] = useCanvasState("count", 0);
  return (
    <Stack gap={12}>
      <H1>Count: {count}</H1>
      <Button onClick={() => setCount(previous => previous + 1)}>Increment</Button>
      <Button onClick={() => setCount(0)}>Reset</Button>
    </Stack>
  );
}
`;

export function canvasGuide() {
  return `# Canvas authoring guide

Read this guide before your first canvas_write in the conversation. Reuse it for subsequent creates and edits; read it again when unsure about the SDK.

## Source and imports

Submit a complete TSX module with a default-exported React component. Use a kebab-case canvas name without slashes. Import from "herdr/canvas" ("cursor/canvas" is a compatibility alias). JSX and native HTML elements work without importing React. Do not import react, other packages, relative files, or use dynamic imports or require.

These are the installed SDK's runtime exports:
${CANVAS_GUIDE_EXPORTS.join(", ")}

## State and host hooks

- useCanvasState<T>(key: string, defaultValue: T): [T, setter]. Use a stable, distinct key for each state value. The setter accepts a value or a function of the previous value. State persistence depends on the host/view mode.
- useHostTheme(): returns the host theme with color and typography tokens.
- useCanvasAction(): returns a dispatcher accepting {type: "openFile", path, selection?}, {type: "promptAgent", prompt}, or {type: "openUrl", url}. Action support depends on the host.

useState, useEffect, and useMemo are not SDK exports. For interactive state, use useCanvasState("count", 0), not useState(0).

## Common components and props

- Stack: children, gap?, style?. Row: children, gap?, align?, justify?, wrap?, style?. Grid: columns (number or CSS template string), children, gap?, style?.
- H1, H2, H3: children, style?. Button: children and onClick for actions.
- TextInput/TextArea: value (string), onChange(value), placeholder?, disabled?. Checkbox/Toggle: checked, onChange(checked), label?, disabled?. Select: value, onChange(value), options: [{value, label}]. SDK form callbacks receive values, not DOM events. Native HTML inputs use normal React event handlers.
- BarChart/LineChart: categories: string[], series: [{name, data: number[], tone?}], height?, caption?. Each series aligns with categories. PieChart: data: [{label, value, tone?}], size?, donut?, caption?.
- Native HTML and inline style objects are available when you need custom layouts. Do not assume SDK components accept arbitrary native HTML props.

## Restrictions and validation

Embed data in the source. Network calls (fetch, XMLHttpRequest, WebSocket), eval, new Function, process/Bun APIs, localStorage and sessionStorage are disallowed. Use useCanvasState for state.

canvas_write creates or replaces the full source and then validates it. canvas_edit applies exact replacements and then validates; use canvas_read's source_hash as expected_hash to guard edits. A failed typecheck can leave source applied: inspect applied/ok and diagnostics, fix the source, and validate again. Do not treat an error as a rollback. Successful writes/edits show an inline preview in MCP Apps hosts. canvas_typecheck and canvas_compile check existing canvases; canvas_open shows one.

## Working example

\`\`\`tsx
${CANVAS_GUIDE_EXAMPLE}\`\`\`
`;
}

export function canvasGuideResult() {
  return { content: [{ type: "text" as const, text: canvasGuide() }], isError: false };
}
