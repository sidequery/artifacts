export const ROUTING_CANVAS = `import { Routes, Route, Outlet, Link, Button, H1, useParams, useLocation, useSearchParams, useNavigate } from "sidequery/canvas";
function Account() {
  const {id} = useParams(); const location = useLocation(); const [query] = useSearchParams();
  return <><H1>Account {id}</H1><p>Tab: {query.get('tab') ?? 'none'}</p><p>Hash: {location.hash}</p><p>State: {JSON.stringify(location.state)}</p><Link to="../456" relative="path">Next account</Link></>;
}
export default function Canvas() {
 const navigate = useNavigate();
 return <><nav><Link to="/">Home</Link><Link to="/accounts/123?tab=activity#latest">Account</Link><Link href="https://example.com">External</Link><Button onClick={() => navigate(-1)}>Back</Button><Button onClick={() => navigate('/accounts/789', {replace:true,state:{from:'replace'}})}>Replace</Button></nav>
 <Routes><Route path="/" element={<H1>Home page</H1>}/><Route path="accounts" element={<section><p>Account layout</p><Outlet/></section>}><Route path=":id" element={<Account/>}/></Route><Route path="*" element={<H1>Page not found</H1>}/></Routes></>;
}`;
