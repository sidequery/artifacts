/** Bridge native subscriptions to HTTP for proxies that cannot carry upgrades. */
export async function galleryEvents(
  request: Request,
  subscribe: () => Promise<Response>,
): Promise<Response> {
  const response = await subscribe();
  const socket = response.webSocket;
  if (response.status !== 101 || !socket)
    return new Response("Live updates unavailable", { status: 503 });
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval>;
  let lease: ReturnType<typeof setTimeout>;
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(lease);
    request.signal.removeEventListener("abort", close);
    socket.close(1000, "Renew subscription");
    controller.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      socket.addEventListener("message", (event) => {
        if (!stopped && event.data === "changed")
          controller.enqueue(encoder.encode("data: changed\n\n"));
      });
      socket.addEventListener("close", close);
      socket.addEventListener("error", close);
      socket.accept();
      controller.enqueue(encoder.encode("retry: 1000\ndata: ready\n\n"));
      // Stay below common proxy idle timeouts; periodically reauthenticate.
      heartbeat = setInterval(() => {
        if (!stopped) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 20_000);
      lease = setTimeout(close, 4 * 60_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() {
      // The reader already owns closure when it cancels the response.
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(lease);
      request.signal.removeEventListener("abort", close);
      socket.close(1000, "Client disconnected");
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
