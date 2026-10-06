import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Lock, Mail, Zap } from "lucide-react";
import { useAuthBootstrap } from "../components/AuthBootstrapProvider";
import LanguageSwitcher from "../components/LanguageSwitcher";
import SeoHead from "../components/SeoHead";
import { normalizeLocale, useI18n } from "../lib/i18n";

type LanguageProfile = {
  effectiveLocale?: string;
  defaultLocale?: string;
};

function readLegacyToken() {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

function clearLegacyToken() {
  try {
    localStorage.removeItem("token");
  } catch {
    // A valid HttpOnly cookie session should still proceed when storage is unavailable.
  }
}

export default function Login() {
  const { localizePath, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState("");
  const [error, setError] = useState("");
  const { status: bootstrapStatus, error: bootstrapLoadError } = useAuthBootstrap();
  const bootstrapError = bootstrapLoadError
    ? "OAuth availability could not be checked. Email and password login remains available."
    : "";
  const oauthLoginEnabled = bootstrapStatus?.oauthLoginEnabled === true;

  const routeAfterLogin = useCallback(async () => {
    try {
      const [profileRes, providersRes, agentsRes] = await Promise.all([
        fetch("/api/auth/me", { credentials: "include" }),
        fetch("/api/llm-providers", { credentials: "include" }),
        fetch("/api/agents", { credentials: "include" }),
      ]);

      const [profile, providers, agents] = await Promise.all([
        profileRes.ok
          ? profileRes.json().catch(() => ({}) as LanguageProfile)
          : ({} as LanguageProfile),
        providersRes.ok ? providersRes.json() : [],
        agentsRes.ok ? agentsRes.json() : [],
      ]);

      const hasProviders = Array.isArray(providers) && providers.length > 0;
      const hasAgents = Array.isArray(agents) && agents.length > 0;
      const targetLocale = normalizeLocale(profile.effectiveLocale || profile.defaultLocale);

      window.location.assign(
        localizePath(
          hasProviders || hasAgents ? "/app/dashboard" : "/app/getting-started",
          targetLocale,
        ),
      );
    } catch (routeErr) {
      console.error(routeErr);
      window.location.assign(localizePath("/app/dashboard"));
    }
  }, [localizePath]);
  const routeAfterLoginRef = useRef(routeAfterLogin);

  useEffect(() => {
    routeAfterLoginRef.current = routeAfterLogin;
  }, [routeAfterLogin]);

  useEffect(() => {
    let cancelled = false;

    async function redirectAuthenticatedSession() {
      let sessionResponse;
      try {
        sessionResponse = await fetch("/api/auth/me", { credentials: "include" });
      } catch {
        return;
      }
      if (cancelled) return;
      if (sessionResponse.ok) {
        clearLegacyToken();
        await routeAfterLoginRef.current();
        return;
      }
      if (sessionResponse.status !== 401) return;

      // Legacy migration: clear any stale HttpOnly cookie first because backend
      // auth deliberately prefers cookies over bearer headers. Then upgrade the
      // legacy bearer into a fresh HttpOnly cookie before deleting localStorage.
      const legacyToken = readLegacyToken();
      if (!legacyToken) return;
      try {
        const logoutResponse = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
        });
        if (cancelled || !logoutResponse.ok) return;

        const upgradeResponse = await fetch("/api/auth/session-upgrade", {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${legacyToken}` },
        });
        if (cancelled || !upgradeResponse.ok) return;

        clearLegacyToken();
        await routeAfterLoginRef.current();
      } catch {
        // Preserve the bearer token so a transient network or backend failure
        // cannot strand an otherwise valid legacy session.
      }
    }

    void redirectAuthenticatedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.token) {
        // The backend set an HttpOnly nora_auth cookie in the response — the
        // JWT is no longer stored client-side, which keeps it out of reach of
        // any script (including XSS payloads). Clear any stale legacy token.
        clearLegacyToken();
        await routeAfterLogin();
        return;
      }

      setError(data.error || t("Login failed. Check your email and password and try again."));
    } catch (loginErr) {
      console.error(loginErr);
      setError(t("Login failed. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  function handleOAuth(provider) {
    if (!oauthLoginEnabled) return;
    setOauthLoading(provider);
    window.location.assign(localizePath(`/auth/oauth/${provider}`));
  }

  return (
    <>
      <SeoHead
        title="Sign in | Headmaster Control"
        description="Sign in to the Headmaster control panel."
        path="/login"
      />

      <div className="site-shell min-h-screen px-4 pb-10 pt-4 text-brand-ink sm:px-6">
        <header className="mx-auto flex max-w-6xl items-center justify-between rounded-2xl border border-brand-cyan/25 bg-white/90 px-4 py-3 shadow-xl shadow-brand-ink/10 backdrop-blur-xl sm:px-5">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-sm font-black uppercase tracking-[0.28em] text-brand-ink">
                Headmaster
              </div>
              <div className="text-xs text-slate-600">Control panel</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
          </div>
        </header>

        <main className="mx-auto grid max-w-md gap-6 pt-10 lg:pt-12">
          <section className="rounded-[36px] panel-warm px-6 py-8 sm:px-8">
            <div className="eyebrow eyebrow-warm mb-5">
              <Zap size={14} />
              Control panel
            </div>
            <h2 className="text-3xl font-black leading-tight text-slate-950">
              Sign in
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-700">
              Use the email and password of your Headmaster admin account. Accounts are created
              by the operator; there is no public sign-up.
            </p>

            {oauthLoginEnabled && (
              <div className="mt-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => handleOAuth("google")}
                  disabled={!!oauthLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-4 py-3 text-sm font-black text-slate-950 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {oauthLoading === "google" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                        fill="#4285F4"
                      />
                      <path
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        fill="#34A853"
                      />
                      <path
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        fill="#FBBC05"
                      />
                      <path
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        fill="#EA4335"
                      />
                    </svg>
                  )}
                  Continue with Google
                </button>

                <button
                  type="button"
                  onClick={() => handleOAuth("github")}
                  disabled={!!oauthLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-full bg-slate-950 px-4 py-3 text-sm font-black text-white transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {oauthLoading === "github" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                  )}
                  Continue with GitHub
                </button>
              </div>
            )}

            <div className="my-6 flex items-center gap-4">
              <div className="h-px flex-1 bg-black/10" />
              <div className="text-[0.65rem] font-black uppercase tracking-[0.28em] text-slate-500">
                {oauthLoginEnabled ? "or use email" : "email login"}
              </div>
              <div className="h-px flex-1 bg-black/10" />
            </div>

            {bootstrapError && (
              <div
                role="status"
                data-testid="auth-bootstrap-warning"
                className="mb-4 rounded-[22px] border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-800"
              >
                {bootstrapError}
              </div>
            )}

            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-slate-500">
                  Email address
                </span>
                <div className="relative">
                  <Mail
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    placeholder="you@company.com"
                    className="w-full rounded-[24px] border border-black/10 bg-white/70 px-12 py-4 text-sm font-semibold text-slate-950 outline-none transition-colors focus:border-slate-950"
                    required
                  />
                </div>
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-slate-500">
                  Password
                </span>
                <div className="relative">
                  <Lock
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    className="w-full rounded-[24px] border border-black/10 bg-white/70 px-12 py-4 text-sm font-semibold text-slate-950 outline-none transition-colors focus:border-slate-950"
                    required
                  />
                </div>
              </label>

              {error && (
                <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-5 py-4 text-sm font-black text-white transition-transform hover:-translate-y-0.5 disabled:opacity-60"
              >
                {loading ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} />}
                {loading ? "Logging in..." : "Log In"}
              </button>
            </form>
          </section>
        </main>
      </div>
    </>
  );
}
