import { createHash } from "node:crypto";

const LEASE_MS = 5 * 60_000;
const tag = (library: string, workspace?: string) => createHash("sha256").update(JSON.stringify([library, workspace ?? null])).digest("hex");

/** Hibernatable invalidation subscriptions; source and credentials never enter messages. */
export class GallerySubscriptions {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  accept(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    // Only the authenticated Worker creates this request; never forward browser headers.
    const selection = JSON.parse(request.headers.get("x-gallery-selection") ?? "null") as { libraryKey?: string; workspace?: string } | null;
    if (!selection || typeof selection.libraryKey !== "string" || !selection.libraryKey
      || (selection.workspace !== undefined && typeof selection.workspace !== "string")) return new Response("Invalid subscription", { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag(selection.libraryKey, selection.workspace)]);
    pair[1].serializeAttachment({ expiresAt: Date.now() + LEASE_MS });
    pair[1].send("ready");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  changed(library: string, workspace: string) {
    for (const scope of [tag(library, workspace), tag(library)]) {
      for (const socket of this.ctx.getWebSockets(scope)) {
        try {
          if (socket.deserializeAttachment()?.expiresAt <= Date.now()) socket.close(1000, "Renew subscription");
          else socket.send("changed");
        } catch { /* Disconnected clients reconcile from a fresh snapshot on reconnect. */ }
      }
    }
  }
}
