import { createRoot } from "react-dom/client";
import * as react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxDev from "react/jsx-dev-runtime";
import type { ComponentType } from "react";
import * as jsx from "react/jsx-runtime";
import * as sdk from "../sdk";

const runtime = {
  sdk,
  react,
  reactDom,
  reactDomClient,
  jsxDev,
  jsx,
  mount(Component: ComponentType) {
    const element = document.getElementById("root");
    if (!element) throw new Error("missing #root");
    const root = createRoot(element);
    (window as Window & { __herdrCanvasUnmount?: () => void }).__herdrCanvasUnmount = () => root.unmount();
    root.render(jsx.jsx(Component, {}));
  },
};

// This runs only inside the canvas browser frame. A deployment prebuilds this
// fixed SDK/React runtime; request-time compilation only handles canvas source.
(globalThis as typeof globalThis & { __herdrCanvasRuntime: typeof runtime }).__herdrCanvasRuntime = runtime;
