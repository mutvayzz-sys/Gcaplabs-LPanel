import "../styles/globals.css";
import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { ToastProvider } from "../components/Toast";
import { I18nProvider, useI18n } from "../lib/i18n";
import { startHeadmasterBridge } from "../lib/headmaster";

function AdminAccessGate({ children }) {
  const { dashboardPath, loginPath, t } = useI18n();
  const [status, setStatus] = useState("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function verifyAdminAccess() {
      // Primary auth is the HttpOnly nora_auth cookie, sent automatically.
      // A legacy localStorage token is forwarded for users still on the
      // pre-cookie session so they don't get kicked out mid-session.
      const legacy = window.localStorage.getItem("token");
      const headers: Record<string, string> = {};
      if (legacy) headers["Authorization"] = `Bearer ${legacy}`;

      try {
        const response = await fetch("/api/auth/me", {
          credentials: "include",
          headers,
        });

        if (response.status === 401) {
          window.localStorage.removeItem("token");
          window.location.replace(loginPath);
          return;
        }

        if (!response.ok) {
          throw new Error("Cannot verify admin access");
        }

        const user = await response.json();
        if (user.role !== "admin") {
          window.location.replace(dashboardPath);
          return;
        }

        if (active) {
          setStatus("allowed");
        }
      } catch (accessError) {
        if (active) {
          setStatus("error");
          setError(accessError.message || t("Cannot verify admin access"));
        }
      }
    }

    verifyAdminAccess();

    return () => {
      active = false;
    };
  }, [dashboardPath, loginPath, t]);

  if (status === "allowed") {
    return children;
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-ink px-6 text-brand-foreground">
        <div className="max-w-md rounded-3xl border border-brand-cyan/10 bg-brand-cyan/6 p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 text-red-300">
            <ShieldAlert size={24} />
          </div>
          <h1 className="text-xl font-black">{t("Admin access check failed")}</h1>
          <p className="mt-3 text-sm text-brand-foreground/74">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-ink text-brand-foreground">
      <div className="flex items-center gap-3 rounded-2xl border border-brand-cyan/10 bg-brand-cyan/6 px-5 py-4 text-sm font-bold">
        <Loader2 size={18} className="animate-spin" />
        {t("Checking admin access...")}
      </div>
    </div>
  );
}

function MyApp({ Component, pageProps }) {
  useEffect(() => {
    // Presentation/readiness + launch bridge. No-op unless the app is framed
    // by the configured build-time Headmaster parent origin.
    return startHeadmasterBridge({ view: "platform-administration" });
  }, []);

  // The Headmaster launch staging page must be reachable without an existing
  // session — the gate would bounce it (and the whole launch exchange) to the
  // marketing login before the bridge could answer.
  const content = Component.isHeadmasterLaunchPage ? (
    <Component {...pageProps} />
  ) : (
    <AdminAccessGate>
      <Component {...pageProps} />
    </AdminAccessGate>
  );

  return (
    <I18nProvider>
      <ToastProvider>{content}</ToastProvider>
    </I18nProvider>
  );
}

export default MyApp;
