# Artifact pages and APIs

The runtime supplies React Router to every artifact. Import routing components and hooks from `sidequery/artifacts`; no router setup or additional source files are required.

```tsx
import { Routes, Route, Outlet, Link, useParams } from "sidequery/artifacts";

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

`Link to` navigates within the artifact. Existing `Link href` keeps ordinary anchor behavior. `NavLink`, `Navigate`, `useNavigate`, `useLocation`, `useParams`, `useSearchParams`, `useMatch`, and `useResolvedPath` are also available. Relative links, nested layouts, query strings, fragments, and navigation state use React Router semantics.

An artifact published as `/sales` opens `/sales/accounts/123` at the route `/accounts/123`. The trusted standalone wrapper owns browser history and synchronizes it with the sandboxed artifact. Reload, bookmarks, and browser back/forward work. The slug is supplied by the viewer; artifact source does not hard-code it. Gallery, MCP/chat, and local views use independent memory history starting at `/`, leaving their surrounding viewer's URL unchanged. Existing single-page artifacts continue rendering normally.

## HTTP APIs

Requests to `/sales/api` and `/sales/api/*` go to that artifact's active backend before page dispatch. The backend receives `/api` or `/api/*` plus the original query string, HTTP method, and body bytes. Its status, response body, and application headers are returned. `artifactFetch("/api/accounts/123")` reaches the same handler in hosted standalone, gallery, and chat views.

An artifact without a backend returns JSON 404 for API requests. A handler's own 404 is returned directly, never replaced by page HTML. Requests and responses retain the existing 256 KiB body limit. GET/HEAD page requests load the artifact shell; other page methods return 405. Unknown `/_artifact/*` paths return 404 because that namespace belongs to runtime bridges.

Private URLs require the existing authenticated owner or team access. Public URLs expose their API as well as their page, so handlers must implement any additional application authorization they need. Management cookies and Access credentials are removed before calling artifact code; private management Authorization is removed too. Backend Set-Cookie is suppressed, responses are not cached, and sandbox policy prevents returned HTML from gaining management-origin access.

Standalone scripts continue handling their own methods and subpaths. Deployment plugin functions keep their separate authenticated bridge and authorization rules. Routing does not add SSR or React Router data loaders/actions; use the existing artifact backend or plugin functions for data.
