/** Direct APIs use native HTTP; browser and MCP bridges keep bounded envelopes. */
export function artifactApiRequest(request: Request, basePath: string, privateLink: boolean): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(basePath.length);
  const input = new Request(url, request);
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) input.headers.delete(name);
  if (privateLink) input.headers.delete("authorization");
  return input;
}

export function artifactApiResponse(response: Response, method: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.append("content-security-policy", "sandbox allow-scripts allow-forms");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, no-store");
  const bodyless = method === "HEAD" || [204, 205, 304].includes(response.status);
  if (bodyless) void response.body?.cancel();
  return new Response(bodyless ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
