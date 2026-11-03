// Loaded beside user server code. Captures bounded console output per run and
// redacts the secrets it was configured with; never imported by the host.
export const SERVER_LOGGING_MODULE = `import { AsyncLocalStorage } from "node:async_hooks";
const secrets = __ARTIFACTS_SCRIPT_SECRETS__;
export const execution = new AsyncLocalStorage();
let logs = [];
const clean = (value, secrets) => {
  let message;
  try { message = typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(value); } catch { message = "[unserializable]"; }
  message = String(message);
  for (const secret of Object.values(secrets)) if (secret) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 2048);
};
for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = (...args) => {
      logs.push({run_id: execution.getStore(), timestamp: new Date().toISOString(), level, message: args.slice(0, 16).map(value => clean(value, secrets)).join(" ").slice(0, 2048)});
      if (logs.length > 100) logs.shift();
};
export function takeLogs() { const result = logs; logs = []; return result; }
`;
