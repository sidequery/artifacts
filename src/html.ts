export function artifactHtml(opts: {
  title: string;
  artifactId: string;
  scriptUrl: string;
  persistUrl?: string;
  actionUrl?: string;
  mtimeUrl?: string;
  versionId?: string;
  eventId?: string;
  sourceHash?: string;
  themeKind?: "dark" | "light";
  state?: Record<string, unknown>;
}): string {
  const bridge = {
    artifactId: opts.artifactId,
    canvasId: opts.artifactId,
    persistUrl: opts.persistUrl,
    actionUrl: opts.actionUrl,
    theme: { kind: opts.themeKind ?? "dark" },
    state: opts.state ?? {},
    versionId: opts.versionId,
    eventId: opts.eventId,
  };
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <style>
      html, body, #root { margin: 0; min-height: 100%; }
      body {
        background: #181818;
        color: #f0f0f0;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      #root { padding: 24px; box-sizing: border-box; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__herdrCanvas = window.__artifacts = ${JSON.stringify(bridge).replaceAll("<", "\\u003c")};</script>
    <script type="module" src="${escapeHtml(opts.scriptUrl)}"></script>
    <script>
      (function () {
        var last = ${JSON.stringify(opts.mtimeUrl ?? null)};
        if (!last) return;
        var url = last;
        window.__artifactsMtime = ${JSON.stringify(opts.sourceHash ?? null)};
        setInterval(function () {
          fetch(url, { cache: "no-store" }).then(function (res) { return res.json(); }).then(function (data) {
            if (window.__artifactsMtime && data.mtime && data.mtime !== window.__artifactsMtime) {
              location.reload();
            }
            window.__artifactsMtime = data.mtime;
          }).catch(function () {});
        }, 750);
      })();
    </script>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
