import "../styles/globals.css";
import "@xterm/xterm/css/xterm.css";
import { useEffect } from "react";
import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../lib/i18n";
import { startHeadmasterBridge } from "../lib/headmaster";

function MyApp({ Component, pageProps }) {
  useEffect(() => {
    // Presentation/readiness + launch bridge. No-op unless the app is framed
    // by the configured build-time Headmaster parent origin.
    return startHeadmasterBridge({ view: "runtime-operations" });
  }, []);

  return (
    <I18nProvider>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </I18nProvider>
  );
}

export default MyApp;
