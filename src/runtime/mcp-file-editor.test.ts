import { describe, expect, test } from "bun:test";
import type { OpenAIResources, OpenAIResourceReadResult, OpenAIResourceWriteResult, OpenAIResourceUpdatedHandler } from "@openai/mcp-extensions/app";
import { createArtifactFileSession } from "./mcp-file-editor";

const uri = "host-owned:opaque-token";
const input = { file: { name: "demo.artifact.tsx", resourceUri: uri } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let handler: OpenAIResourceUpdatedHandler | undefined;
  let content: OpenAIResourceReadResult = { contents: [{ uri, text: "initial", openaiMetadata: { writable: true, etag: "v1" } }] };
  let outcome: OpenAIResourceWriteResult = { outcome: "saved", etag: "v2" };
  const writes: Array<{ uri: string; content: unknown }> = [];
  const reads: unknown[] = [];
  const unsubscribes: string[] = [];
  const resources: OpenAIResources = {
    addUpdateHandler(value) { handler = value; return () => { handler = undefined; }; },
    async read(params) { reads.push(params); return content; },
    async subscribe() { return {}; },
    async unsubscribe(params) { unsubscribes.push(params.uri); return {}; },
    async write(uri, content) { writes.push({ uri, content }); return outcome; },
  };
  return { resources, writes, reads, unsubscribes, setContent(value: OpenAIResourceReadResult) { content = value; }, setOutcome(value: OpenAIResourceWriteResult) { outcome = value; },
    update: () => handler?.({ method: "notifications/resources/updated", params: { uri } }), hasHandler: () => !!handler };
}

describe("owned artifact file editor", () => {
  test("missing extension and general TSX stay unavailable", async () => {
    const unavailable = createArtifactFileSession(undefined, input);
    await unavailable.ready;
    expect(unavailable.getSnapshot().message).toContain("does not support");
    const host = fixture();
    const unsupported = createArtifactFileSession(host.resources, { file: { ...input.file, name: "ordinary.tsx" } });
    await unsupported.ready;
    expect(unsupported.getSnapshot().loaded).toBe(false);
    expect(host.reads).toHaveLength(0);
    expect(host.hasHandler()).toBe(false);
  });

  test.each([{ writable: false, etag: "v1" }, { writable: true }, { writable: true, etag: " " }])("requires writable access and nonempty etag: %j", async metadata => {
    const host = fixture();
    host.setContent({ contents: [{ uri, text: "initial", openaiMetadata: metadata }] });
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    session.edit("changed");
    await session.save();
    expect(session.getSnapshot().draft).toBe("initial");
    expect(session.getSnapshot().writable).toBe(false);
    expect(host.writes).toHaveLength(0);
    await session.dispose();
  });

  test("requests text and decodes UTF-8 blobs strictly", async () => {
    const host = fixture();
    host.setContent({ contents: [{ uri, blob: btoa("hello"), openaiMetadata: { writable: true, etag: "v1" } }] });
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    expect(host.reads).toEqual([{ uri, representation: "text" }]);
    expect(session.getSnapshot().draft).toBe("hello");
    host.setContent({ contents: [{ uri, blob: btoa(String.fromCharCode(0xff)) }] });
    await session.reload();
    expect(session.getSnapshot().message).toContain("Unable to read");
    expect(session.getSnapshot().draft).toBe("hello");
    await session.dispose();
  });

  test("save uses opaque URI and matching etag, and advances baseline", async () => {
    const host = fixture();
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    session.edit("draft");
    await session.save();
    expect(host.writes).toEqual([{ uri, content: { text: "draft", ifMatch: "v1" } }]);
    expect(session.hasUnsavedChanges()).toBe(false);
    session.edit("next");
    await session.save();
    expect(host.writes[1]).toEqual({ uri, content: { text: "next", ifMatch: "v2" } });
    await session.dispose();
  });

  test("conflict preserves draft and old version until explicit reload", async () => {
    const host = fixture();
    host.setOutcome({ outcome: "conflict", etag: "other-version" });
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    session.edit("mine");
    await session.save();
    expect(session.getSnapshot()).toMatchObject({ draft: "mine", baseline: "initial", etag: "v1", conflict: true });
    await session.save();
    expect(host.writes).toHaveLength(1);
    host.setContent({ contents: [{ uri, text: "theirs", openaiMetadata: { writable: true, etag: "v3" } }] });
    await session.reload();
    expect(session.getSnapshot()).toMatchObject({ draft: "theirs", baseline: "theirs", etag: "v3", conflict: false });
    await session.dispose();
  });

  test("too-large preserves draft and allows a smaller retry", async () => {
    const host = fixture();
    host.setOutcome({ outcome: "too-large", maxBytes: 10 });
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    session.edit("a large draft");
    await session.save();
    expect(session.getSnapshot()).toMatchObject({ draft: "a large draft", baseline: "initial", etag: "v1" });
    expect(session.getSnapshot().message).toContain("10 bytes");
    session.edit("small");
    host.setOutcome({ outcome: "saved", etag: "v2" });
    await session.save();
    expect(session.hasUnsavedChanges()).toBe(false);
    await session.dispose();
  });

  test("clean updates refresh, dirty updates preserve draft and announce conflict", async () => {
    const host = fixture();
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    host.setContent({ contents: [{ uri, text: "new", openaiMetadata: { writable: true, etag: "v2" } }] });
    await host.update();
    expect(session.getSnapshot().draft).toBe("new");
    session.edit("mine");
    await host.update();
    expect(session.getSnapshot()).toMatchObject({ draft: "mine", baseline: "new", conflict: true });
    expect(session.getSnapshot().message).toContain("draft is preserved");
    await session.dispose();
  });

  test("typing during a read or save remains unsaved", async () => {
    const host = fixture();
    const session = createArtifactFileSession(host.resources, input);
    await session.ready;
    const read = deferred<OpenAIResourceReadResult>();
    host.resources.read = () => read.promise;
    const updating = host.update();
    session.edit("typed while reading");
    read.resolve({ contents: [{ uri, text: "external" }] });
    await updating;
    expect(session.getSnapshot()).toMatchObject({ draft: "typed while reading", conflict: true });
    await session.dispose();
    const next = fixture();
    const savingSession = createArtifactFileSession(next.resources, input);
    await savingSession.ready;
    const write = deferred<OpenAIResourceWriteResult>();
    next.resources.write = () => write.promise;
    savingSession.edit("saved draft");
    const saving = savingSession.save();
    savingSession.edit("newer draft");
    write.resolve({ outcome: "saved", etag: "v2" });
    await saving;
    expect(savingSession.getSnapshot()).toMatchObject({ draft: "newer draft", baseline: "saved draft", etag: "v2" });
    expect(savingSession.hasUnsavedChanges()).toBe(true);
    await savingSession.dispose();
  });

  test("dispose ignores stale reads and cleans a pending subscription exactly once", async () => {
    const host = fixture();
    const read = deferred<OpenAIResourceReadResult>();
    const subscribe = deferred<Record<string, never>>();
    host.resources.read = () => read.promise;
    host.resources.subscribe = () => subscribe.promise;
    const session = createArtifactFileSession(host.resources, input);
    const snapshot = session.getSnapshot();
    const disposing = session.dispose();
    expect(host.hasHandler()).toBe(false);
    read.resolve({ contents: [{ uri, text: "stale" }] });
    subscribe.resolve({});
    await Promise.all([session.ready, disposing]);
    await session.dispose();
    expect(session.getSnapshot()).toBe(snapshot);
    expect(host.unsubscribes).toEqual([uri]);
  });
});
