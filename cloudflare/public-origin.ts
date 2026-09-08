/** Canonical URLs behind a trusted proxy; never changes request authentication. */
export function publicOrigin(requestUrl: string, configured?: string): string {
  if (configured === undefined) return new URL(requestUrl).origin;
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== configured || /[\s"'<>;,]/.test(configured)) {
    throw new Error("ARTIFACTS_PUBLIC_ORIGIN must be an exact HTTP(S) origin");
  }
  return url.origin;
}
