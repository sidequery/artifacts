/** Deployments behind a loopback gateway still publish externally usable links. */
export function publicOrigin(requestUrl: string, configured?: string): string {
  if (configured === undefined) return new URL(requestUrl).origin;
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CANVAS_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}
