import { expect, test } from "bun:test";
import Ajv from "ajv";
import { createPluginDispatcher, PluginError, PLUGIN_JSON_LIMIT } from "./plugins";
import type { CanvasPlugin, PluginOperation, PluginContext } from "../src/plugins/config";
import { createAuthenticator } from "./auth";

const schema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
function setup(handler: PluginOperation["handler"], extra: Partial<PluginOperation> = {}, timeout = 30_000) {
  const plugin: CanvasPlugin = { name: "data", description: "Test data", secrets: ["DATA_KEY"], operations: { read: { description: "Read", inputSchema: schema, outputSchema: schema, handler, ...extra } } };
  const ajv = new Ajv({ strict: true });
  const input = ajv.compile(schema), output = ajv.compile(schema);
  return createPluginDispatcher([plugin], { input: (_plugin, _op, value) => input(value), output: (_plugin, _op, value) => output(value) }, timeout);
}
const request = { plugin: "data", operation: "read", input: { value: 1 } };
const context = { user: { subject: "alice", authority: "https://team.cloudflareaccess.com" }, env: { DATA_KEY: "provider-secret", OTHER_SECRET: "hidden", LIBRARIES: {} } };

test("passes verified local caller identity and only declared secrets to handler", async () => {
  const user = await createAuthenticator()(new Request("http://localhost:4785/api/plugins/call"), { ENVIRONMENT: "local" });
  if (user instanceof Response) throw new Error("Local authentication failed");
  let received: PluginContext | undefined;
  const dispatch = setup((input, ctx) => { received = ctx; return input; });
  expect(await dispatch(request, { user, env: context.env })).toEqual({ value: 1 });
  expect(received?.user).toEqual({ subject: "local", authority: "local" });
  expect({ ...received?.secrets }).toEqual({ DATA_KEY: "provider-secret" });
  expect(Object.keys(received!)).toEqual(["user", "secrets", "signal"]);
});

test("requires authentication, checks operation existence separately, and rejects selector authority", async () => {
  const dispatch = setup(input => input);
  await expect(dispatch(request)).rejects.toMatchObject({ status: 401 });
  await expect(dispatch({ ...request, operation: "missing" }, context)).rejects.toMatchObject({ status: 404 });
  await expect(dispatch({ ...request, operation: "toString" }, context)).rejects.toMatchObject({ status: 404 });
  await expect(dispatch({ ...request, input: {} }, context)).rejects.toMatchObject({ status: 400 });
  await expect(dispatch({ ...request, library: "team" } as typeof request, context)).rejects.toMatchObject({ status: 400 });
});

test("authorize uses actual caller, defaults authenticated, and does not execute forbidden handler", async () => {
  let calls = 0;
  const dispatch = setup(input => { calls++; return input; }, { authorize: user => user.subject === "bob" });
  await expect(dispatch(request, context)).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(0);
  expect(await dispatch(request, { ...context, user: { ...context.user, subject: "bob" } })).toEqual({ value: 1 });
  expect(calls).toBe(1);
});

test("bounds JSON and validates handler output", async () => {
  await expect(setup(input => input)({ ...request, input: "x".repeat(PLUGIN_JSON_LIMIT) }, context)).rejects.toMatchObject({ status: 413 });
  for (const output of [{ value: "wrong" }, undefined, { value: NaN }, { value: "x".repeat(PLUGIN_JSON_LIMIT) }]) {
    await expect(setup(() => output)(request, context)).rejects.toMatchObject({ status: 500 });
  }
});

test("sanitizes handler and authorization errors, including thrown plugin errors", async () => {
  await expect(setup(() => { throw new Error("provider-secret"); })(request, context)).rejects.toMatchObject({ message: "Plugin operation failed", status: 500 });
  await expect(setup(() => { throw new PluginError("provider-secret", 400); })(request, context)).rejects.toMatchObject({ message: "Plugin operation failed", status: 500 });
  await expect(setup(input => input, { authorize: () => { throw new Error("provider-secret"); } })(request, context)).rejects.toMatchObject({ message: "Plugin authorization failed", status: 500 });
});

test("missing declared secret fails without exposing its binding name or calling handler", async () => {
  let calls = 0;
  await expect(setup(input => { calls++; return input; })(request, { ...context, env: {} })).rejects.toMatchObject({ status: 500, message: "Plugin configuration unavailable" });
  expect(calls).toBe(0);
});

test("times out handler and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  const dispatch = setup((_input, ctx) => { signal = ctx.signal; return new Promise(() => {}); }, {}, 10);
  await expect(dispatch(request, context)).rejects.toMatchObject({ status: 504 });
  expect(signal?.aborted).toBe(true);
});

test("timed out authorization never starts handler", async () => {
  let calls = 0;
  const dispatch = setup(input => { calls++; return input; }, { authorize: () => new Promise(resolve => setTimeout(() => resolve(true), 20)) }, 5);
  await expect(dispatch(request, context)).rejects.toMatchObject({ status: 504 });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(calls).toBe(0);
});
