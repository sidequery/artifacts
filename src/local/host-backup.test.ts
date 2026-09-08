import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostBackupLock } from "./host-backup";

test("backup waits for runtime shutdown and prevents another host from opening state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-backup-lock-"));
  const path = join(directory, "host-lock.sqlite");
  const host = new Database(path, { create: true });
  let backup: Database | undefined;
  let contender: Database | undefined;
  try {
    host.exec("begin exclusive");
    let acquired = false;
    const pending = acquireHostBackupLock(path, 2000).then(lock => { acquired = true; return lock; });
    await Bun.sleep(50);
    expect(acquired).toBe(false);
    host.close();
    backup = await pending;
    contender = new Database(path);
    expect(() => contender!.exec("begin exclusive")).toThrow();
    backup.close();
    backup = undefined;
    expect(() => contender!.exec("begin exclusive")).not.toThrow();
  } finally {
    backup?.close();
    contender?.close();
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup fails closed when the host retains its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-backup-lock-"));
  const path = join(directory, "host-lock.sqlite");
  const host = new Database(path, { create: true });
  try {
    host.exec("begin exclusive");
    await expect(acquireHostBackupLock(path, 25)).rejects.toThrow("Cannot acquire quiesced Canvas state");
  } finally {
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
