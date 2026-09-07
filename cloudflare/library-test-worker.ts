export { CanvasLibrary } from "./library";

type LibraryStub = Record<string, (input: unknown) => Promise<unknown>>;
type Env = { LIBRARY: { getByName(name: string): LibraryStub } };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/call\/([A-Za-z][A-Za-z0-9]*)$/);
    if (request.method !== "POST" || !match) return new Response("Not found", { status: 404 });
    try {
      const method = match[1]!;
      const stub = env.LIBRARY.getByName(url.searchParams.get("library") ?? "default");
      const call = stub[method];
      if (typeof call !== "function") return Response.json({ error: "Unknown method" }, { status: 404 });
      return Response.json({ result: await call(await request.json()) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
};
