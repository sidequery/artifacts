export function scriptRuntimeConfig(runtime?: string) {
  return {
    compatibilityDate: "2026-09-06",
    compatibilityFlags: ["nodejs_compat"],
    // celld 0.5.0 rejects limits and cannot enforce these per-script budgets.
    // Keep the Cloudflare limits unless the deployment explicitly selects celld.
    ...(runtime === "celld" ? {} : { limits: { cpuMs: 30000, subRequests: 50 } }),
  };
}
