export const FLEET_REGISTRY_VAR = "ARTIFACTS_NATIVE_FLEET_REGISTRY";
export const FLEET_PUBLICATION_VAR = "ARTIFACTS_NATIVE_FLEET_PUBLICATION";
export const FLEET_SCHEDULER_EXPORT = "ArtifactsNativeScheduler";
export const fleetBinding = (app: string) =>
  `ARTIFACTS_APP_${app.replaceAll("-", "")}` as const;
export const fleetScheduleBinding = (app: string) =>
  `${fleetBinding(app)}_SCHEDULE` as const;

export type FleetPointer = {
  script_name: string;
  version: string;
  prefix: string;
  rollout: { percent: number };
};
export type FleetApp = {
  app: string;
  revision: string;
  pointer: FleetPointer;
  crons: string[];
  queues: string[];
};
export type FleetRegistry = { schema_version: 1; apps: FleetApp[] };

export function readFleetRegistry(value: unknown): FleetRegistry {
  if (value === undefined) return { schema_version: 1, apps: [] };
  const registry = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !registry ||
    registry.schema_version !== 1 ||
    !Array.isArray(registry.apps)
  )
    throw new Error("Invalid native fleet registry");
  const ids = new Set<string>();
  for (const app of registry.apps) {
    if (
      !app ||
      !/^[0-9a-f-]{36}$/.test(app.app) ||
      ids.has(app.app) ||
      !/^[0-9a-f]{64}$/.test(app.revision) ||
      app.pointer?.script_name !== `art-app-${app.app.replaceAll("-", "")}` ||
      !/^[0-9a-f]{16,64}$/.test(app.pointer?.version ?? "") ||
      app.pointer.prefix !==
        `deploy/${app.pointer.script_name}/${app.pointer.version}` ||
      !Array.isArray(app.crons) ||
      !app.crons.every((value: unknown) => typeof value === "string") ||
      !Array.isArray(app.queues) ||
      !app.queues.every(
        (value: unknown) =>
          typeof value === "string" && /^art-[0-9a-f]{48}$/.test(value),
      )
    ) {
      throw new Error("Invalid native fleet app");
    }
    ids.add(app.app);
  }
  return registry;
}
