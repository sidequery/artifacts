import { CanvasFiles as BaseCanvasFiles, TRANSFER_PATH } from "./files";
import type { FilesEnv } from "./files";
import type { CanvasFileRequest } from "../src/sdk/files";
export class CanvasFiles extends BaseCanvasFiles {
  private armDeleteFailure: () => void;

  constructor(ctx: DurableObjectState, env: FilesEnv) {
    let failDelete = false;
    const bucket = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "delete") return async (keys: string | string[]) => {
          if (failDelete) {
            failDelete = false;
            throw new Error("Injected R2 delete failure");
          }
          return target.delete(keys);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, FILES: bucket });
    this.armDeleteFailure = () => { failDelete = true; };
  }

  async failNextDelete() { this.armDeleteFailure(); }
  async runCleanup() { await super.alarm(); }
}

type Env = { FILE_BACKENDS: DurableObjectNamespace<CanvasFiles> };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const transfer = url.pathname.match(TRANSFER_PATH);
    if (transfer) return env.FILE_BACKENDS.get(env.FILE_BACKENDS.idFromString(transfer[1]!)).fetch(request);
    if (request.method !== "POST" || !["/request", "/alarm", "/fail-next-delete"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    const stub = env.FILE_BACKENDS.getByName(url.searchParams.get("scope") ?? "default");
    try {
      if (url.pathname === "/fail-next-delete") {
        await stub.failNextDelete();
        return Response.json({ ok: true });
      }
      if (url.pathname === "/alarm") {
        await stub.runCleanup();
        return Response.json({ ok: true });
      }
      return Response.json(await stub.request(await request.json() as CanvasFileRequest));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
};
