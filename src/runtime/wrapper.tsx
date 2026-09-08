import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { ArtifactRouter } from "../sdk/routing";
import Artifact from "artifacts-entry";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

const Component = Artifact as ComponentType;
const reactRoot = createRoot(root);
(window as Window & { __artifactsUnmount?: () => void }).__artifactsUnmount = () => reactRoot.unmount();
reactRoot.render(<ArtifactRouter><Component /></ArtifactRouter>);
