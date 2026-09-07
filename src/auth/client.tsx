import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { authClient, safeReturnTo } from "./client-api";

type AuthProvider = { id: string; name: string };
type ProviderState =
  | { status: "loading"; providers: AuthProvider[]; error: "" }
  | { status: "ready"; providers: AuthProvider[]; error: "" }
  | { status: "error"; providers: AuthProvider[]; error: string };

type PublicClient = { client_id: string; client_name?: string };

const styles = `
  :root { color-scheme: dark; --page: #141414; --panel: #1b1b1b; --line: #303030; --muted: #a0a0a0; }
  * { box-sizing: border-box; }
  html, body, #root { min-width: 100%; min-height: 100%; }
  body { margin: 0; background: var(--page); color: #e5e5e5; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  button, a { font: inherit; color: inherit; }
  button { width: 100%; min-height: 42px; border: 1px solid var(--line); border-radius: 4px; background: #252525; padding: 9px 12px; cursor: pointer; }
  button.primary { border-color: #d2d2d2; background: #e5e5e5; color: #161616; }
  button:disabled { opacity: .55; cursor: wait; }
  :is(button, a):focus-visible { outline: 2px solid #d0d0d0; outline-offset: 2px; }
  .auth-shell { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
  .auth-card { width: min(100%, 420px); border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 28px; }
  .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 23px; font-weight: 600; letter-spacing: -.02em; }
  .description { margin: 10px 0 24px; color: var(--muted); }
  .provider-list { display: grid; gap: 9px; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .state { margin: 0; color: var(--muted); }
  .error { margin: 14px 0 0; color: #eeaaaa; }
  .client-name { color: #f3f3f3; font-weight: 600; }
  @media (hover: hover) and (pointer: fine) { button:hover:not(:disabled) { background: #303030; } button.primary:hover:not(:disabled) { background: #fff; } }
  @media (pointer: coarse) { button { min-height: 48px; } }
`;

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error_description?: unknown };
    if (typeof candidate.message === "string" && candidate.message) return candidate.message;
    if (typeof candidate.error_description === "string" && candidate.error_description) return candidate.error_description;
  }
  return fallback;
}

function validProviders(value: unknown): AuthProvider[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { providers?: unknown }).providers)) return null;
  const providers = (value as { providers: unknown[] }).providers;
  if (!providers.every(provider => provider && typeof provider === "object"
    && typeof (provider as AuthProvider).id === "string" && !!(provider as AuthProvider).id
    && typeof (provider as AuthProvider).name === "string" && !!(provider as AuthProvider).name)) return null;
  return providers as AuthProvider[];
}

function SignIn() {
  const [state, setState] = useState<ProviderState>({ status: "loading", providers: [], error: "" });
  const [pending, setPending] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/auth/providers", {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
        const providers = validProviders(await response.json());
        if (!providers) throw new Error("The server returned an invalid provider list.");
        if (!controller.signal.aborted) setState({ status: "ready", providers, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: "error", providers: [], error: errorMessage(error, "Could not load sign-in providers.") });
      }
    })();
    return () => controller.abort();
  }, []);

  const signIn = async (provider: AuthProvider) => {
    setPending(provider.id);
    setSubmitError("");
    try {
      const result = await authClient.signIn.social({ provider: provider.id, callbackURL: safeReturnTo() });
      if (result.error) throw result.error;
      if (!result.data?.url) throw new Error("The identity provider did not return a sign-in URL.");
      window.location.assign(result.data.url);
    } catch (error) {
      setSubmitError(errorMessage(error, `Could not sign in with ${provider.name}.`));
      setPending(null);
    }
  };

  return (
    <AuthCard title="Sign in to Canvas" description="Use your team's configured identity provider.">
      {state.status === "loading" ? <p className="state" role="status">Loading sign-in options…</p> : null}
      {state.status === "error" ? <p className="state" role="alert">{state.error}</p> : null}
      {state.status === "ready" && state.providers.length === 0 ? <p className="state" role="alert">No sign-in provider is configured.</p> : null}
      {state.providers.length > 0 ? (
        <div className="provider-list">
          {state.providers.map(provider => (
            <button key={provider.id} type="button" disabled={pending !== null} onClick={() => void signIn(provider)}>
              {pending === provider.id ? "Redirecting…" : `Continue with ${provider.name}`}
            </button>
          ))}
        </div>
      ) : null}
      {submitError ? <p className="error" role="alert">{submitError}</p> : null}
    </AuthCard>
  );
}

function Consent() {
  const [client, setClient] = useState<PublicClient | null>(null);
  const [pending, setPending] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const clientId = new URLSearchParams(window.location.search).get("client_id");
    if (!clientId) return;
    let active = true;
    void (async () => {
      try {
        const result = await authClient.oauth2.publicClientPrelogin({ client_id: clientId });
        if (!active || result.error || !result.data || typeof result.data.client_id !== "string") return;
        setClient(result.data);
      } catch {
        // The app name is optional context; consent remains usable without it.
      }
    })();
    return () => { active = false; };
  }, []);

  const decide = async (accept: boolean) => {
    setPending(accept ? "accept" : "deny");
    setError("");
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error) throw result.error;
      if (!result.data?.url) throw new Error("The authorization server did not return a continuation URL.");
      window.location.assign(result.data.url);
    } catch (cause) {
      setError(errorMessage(cause, "Could not complete authorization."));
      setPending(null);
    }
  };

  const appName = client?.client_name?.trim();
  return (
    <AuthCard
      title="Allow access to Canvas?"
      description={<>{appName ? <span className="client-name">{appName}</span> : "An application"} will be able to read and modify your personal canvases, shared team canvases, and their stored data.</>}
    >
      <div className="actions">
        <button type="button" disabled={pending !== null} onClick={() => void decide(false)}>{pending === "deny" ? "Denying…" : "Deny"}</button>
        <button className="primary" type="button" disabled={pending !== null} onClick={() => void decide(true)}>{pending === "accept" ? "Allowing…" : "Allow"}</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </AuthCard>
  );
}

function AuthCard({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">Canvas</p>
        <h1>{title}</h1>
        <div className="description">{description}</div>
        {children}
      </section>
    </main>
  );
}

function App() {
  return <><style>{styles}</style>{window.location.pathname === "/consent" ? <Consent /> : <SignIn />}</>;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
