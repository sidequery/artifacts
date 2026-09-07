# Canvas pages and APIs

The runtime supplies React Router to every canvas. Import routing components and hooks from `sidequery/canvas`; no router setup or additional source files are required.

```tsx
import { Routes, Route, Outlet, Link, useParams } from "sidequery/canvas";

function Account() {
  const { id } = useParams();
  return <p>Account {id}</p>;
}

export default function App() {
  return <>
    <Link to="/accounts/123">Open account</Link>
    <Routes>
      <Route path="/" element={<p>Overview</p>} />
      <Route path="accounts" element={<section><h1>Accounts</h1><Outlet /></section>}>
        <Route path=":id" element={<Account />} />
      </Route>
      <Route path="*" element={<p>Page not found</p>} />
    </Routes>
  </>;
}
```

`Link to` navigates within the canvas. Existing `Link href` keeps ordinary anchor behavior. `NavLink`, `Navigate`, `useNavigate`, `useLocation`, `useParams`, `useSearchParams`, `useMatch`, and `useResolvedPath` are also available. Relative links, nested layouts, query strings, fragments, and navigation state use React Router semantics.

A canvas published as `/sales` opens `/sales/accounts/123` at the route `/accounts/123`. The trusted standalone wrapper owns browser history and synchronizes it with the sandboxed canvas. Reload, bookmarks, and browser back/forward work. The slug is supplied by the viewer; canvas source does not hard-code it. Gallery, MCP/chat, and local views use independent memory history starting at `/`, leaving their surrounding viewer's URL unchanged. Existing single-page canvases continue rendering normally.

## HTTP APIs

Requests to `/sales/api` and `/sales/api/*` go to that canvas's active backend before page dispatch. The backend receives `/api` or `/api/*` plus the original query string, HTTP method, and body bytes. Its status, response body, and application headers are returned. `canvasFetch("/api/accounts/123")` reaches the same handler in hosted standalone, gallery, and chat views.

A canvas without a backend returns JSON 404 for API requests. A handler's own 404 is returned directly, never replaced by page HTML. Requests and responses retain the existing 256 KiB body limit. GET/HEAD page requests load the canvas shell; other page methods return 405. Unknown `/_canvas/*` paths return 404 because that namespace belongs to runtime bridges.

Private URLs require the existing authenticated owner or team access. Public URLs expose their API as well as their page, so handlers must implement any additional application authorization they need. Management cookies and Access credentials are removed before calling canvas code; private management Authorization is removed too. Backend Set-Cookie is suppressed, responses are not cached, and sandbox policy prevents returned HTML from gaining management-origin access.

Standalone scripts continue handling their own methods and subpaths. Deployment plugin functions keep their separate authenticated bridge and authorization rules. Routing does not add SSR or React Router data loaders/actions; use the existing canvas backend or plugin functions for data.
