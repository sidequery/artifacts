import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { CanvasRouter } from "../sdk/routing";
import Canvas from "herdr-canvas-entry";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

const Component = Canvas as ComponentType;
const reactRoot = createRoot(root);
(window as Window & { __herdrCanvasUnmount?: () => void }).__herdrCanvasUnmount = () => reactRoot.unmount();
reactRoot.render(<CanvasRouter><Component /></CanvasRouter>);
