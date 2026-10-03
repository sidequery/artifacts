import type { AppManifest, ResourceLedger } from "./manifest";
import type { ArtifactProject } from "../project";

export type NativeRevision = { id: string; source: string; manifest: AppManifest; code: string; created_at: string; project?: ArtifactProject };
export type NativeDeployment = {
  app: string;
  revision: NativeRevision;
  resources: ResourceLedger;
  secrets: Record<string, string>;
};
export const workerName = (app: string) => `art-app-${app.replaceAll("-", "")}`;
export const resourceName = (id: string) => `art-${id.slice(0, 48)}`;
export const classAlias = (id: string) => `AppDO_${id}`;

export type ProviderResult = { revision: string; endpoint: string };
