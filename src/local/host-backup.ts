import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

/** The host releases this lock only after its runtime child has exited. */
export async function acquireHostBackupLock(path: string, timeoutMs = 60_000): Promise<Database> {
  const lock = new Database(path, { readwrite: true, create: false });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { lock.exec("begin exclusive"); return lock; }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) {
        lock.close();
        throw new Error("Cannot acquire quiesced Canvas state for backup", { cause: error });
      }
      await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
}

