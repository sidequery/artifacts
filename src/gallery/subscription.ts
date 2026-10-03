/** Changes invalidate snapshots; reconnect always reconciles missed events. */
export function subscribeGallery(url: string, refresh: () => void, status: (connected: boolean) => void) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let opening: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  let lastPong = 0;
  const changed = () => {
    if (pending || stopped) return;
    pending = setTimeout(() => { pending = undefined; if (!stopped) refresh(); }, 80);
  };
  const clearConnectionTimers = () => { clearInterval(heartbeat); clearTimeout(lease); clearTimeout(opening); };
  function connect() {
    if (stopped) return;
    const current = socket = new WebSocket(url);
    opening = setTimeout(() => current.close(), 10_000);
    current.onopen = () => {
      clearTimeout(opening);
      delay = 1_000;
      lastPong = Date.now();
      status(true);
      changed();
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 45_000) current.close();
        else if (current.readyState === WebSocket.OPEN) current.send("ping");
      }, 20_000);
      // Re-enter the authenticated HTTP route periodically, even on quiet libraries.
      lease = setTimeout(() => current.close(1000, "Renew subscription"), 4 * 60_000);
    };
    current.onmessage = event => {
      if (event.data === "pong") lastPong = Date.now();
      else if (event.data === "changed") changed();
    };
    current.onerror = () => current.close();
    current.onclose = () => {
      clearConnectionTimers();
      socket = undefined;
      if (stopped) return;
      status(false);
      // A failed upgrade may be an expired session. A normal request handles login.
      changed();
      retry = setTimeout(connect, delay + Math.random() * delay / 4);
      delay = Math.min(delay * 2, 30_000);
    };
  }
  const resume = () => {
    if (document.visibilityState === "hidden") return;
    if (!socket) { clearTimeout(retry); connect(); }
    else if (socket.readyState === WebSocket.OPEN) {
      if (Date.now() - lastPong > 45_000) socket.close();
      else { socket.send("ping"); changed(); }
    }
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  connect();
  return () => {
    stopped = true;
    clearConnectionTimers();
    clearTimeout(retry);
    clearTimeout(pending);
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
    socket?.close();
  };
}
