import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ArtifactHistory } from "../history";
import { galleryData } from "./server";

/** File-gallery mode uses filesystem events; the hosted app uses Durable Objects. */
export function watchGallery(history: ArtifactHistory, workspace: string, changed: (all: boolean) => void) {
  const watchers = new Map<string, FSWatcher>();
  const snapshots = new Map<boolean, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const snapshot = (all: boolean) => JSON.stringify(galleryData(history, workspace, all), (key, value) => key === "serveCount" ? undefined : value);
  for (const all of [false, true]) snapshots.set(all, snapshot(all));

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      attach(workspace);
      for (const all of [false, true]) {
        try {
          const next = snapshot(all);
          if (next === snapshots.get(all)) continue;
          snapshots.set(all, next);
        } catch { /* Let the gallery report an unreadable source or project. */ }
        changed(all);
      }
    }, 80);
  }
  function attach(directory: string) {
    if (watchers.has(directory) || !existsSync(directory)) return;
    const watcher = watch(directory, (_event, filename) => {
      const name = filename?.toString();
      if (!name || directory === dirname(workspace) && name === basename(workspace)
        || directory === dirname(history.path) && [basename(history.path), basename(history.path) + "-wal"].includes(name)
        || directory === workspace && /\.(artifact|canvas)\.(tsx(?:\.project\.json)?|server\.ts)$/.test(name)) schedule();
    });
    watchers.set(directory, watcher);
  }
  try {
    for (const directory of [workspace, dirname(workspace), dirname(history.path)]) attach(directory);
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    throw error;
  }
  return () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
  };
}
