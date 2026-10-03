/** A ping is a transport barrier, so isolation tests need no arbitrary sleeps. */
export async function openGallerySubscription(url: string, headers: Record<string, string> = {}) {
  const address = new URL(url);
  const origin = address.origin;
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  // Bun accepts request headers; the browser DOM overload does not expose them.
  const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(address, { headers: { Origin: origin, ...headers } });
  const messages: string[] = [];
  let cursor = 0;
  socket.addEventListener("message", event => messages.push(String(event.data)));
  function waitFor(message: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Subscription did not receive ${message}`)); }, 5_000);
      const received = (event: MessageEvent) => { if (event.data === message) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("Subscription disconnected")); };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", received);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      socket.addEventListener("message", received);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    });
  }
  try { await waitFor("ready"); } catch (error) { socket.close(); throw error; }
  return {
    close: () => socket.close(),
    async changes() {
      const pong = waitFor("pong");
      socket.send("ping");
      await pong;
      const batch = messages.slice(cursor).filter(message => message !== "ready" && message !== "pong");
      cursor = messages.length;
      return batch;
    },
  };
}
