import { createRoot } from "react-dom/client";
import * as react from "react";
import * as reactRouter from "react-router";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxDev from "react/jsx-dev-runtime";
import type { ComponentType } from "react";
import * as jsx from "react/jsx-runtime";
import { ArtifactRouter } from "../sdk/routing";
import * as sdk from "../sdk";

const runtime = {
  sdk,
  react,
  reactRouter,
  reactDom,
  reactDomClient,
  jsxDev,
  jsx,
  mount(Component: ComponentType) {
    const element = document.getElementById("root");
    if (!element) throw new Error("missing #root");
    const root = createRoot(element);
    (window as Window & { __artifactsUnmount?: () => void }).__artifactsUnmount = () => root.unmount();
    root.render(jsx.jsx(ArtifactRouter, { children: jsx.jsx(Component, {}) }));
  },
};

// This runs only inside the artifact browser frame. A deployment prebuilds this
// fixed SDK/React runtime; request-time compilation only handles artifact source.
(globalThis as typeof globalThis & { __artifactsRuntime: typeof runtime }).__artifactsRuntime = runtime;
