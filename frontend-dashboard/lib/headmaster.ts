// Headmaster embedding bridge.
//
// Presentation/readiness handshake plus the narrow admin launch exchange.
// This module NEVER accepts GCAP tokens, Nora API keys, login assertions, or
// RPC commands from the parent. The only credential that ever crosses the
// bridge is the short-lived single-use launch code issued by the Headmaster
// server for the current browser session, and it is immediately exchanged for
// the platform's own HttpOnly session cookie server-side.
//
// Frame policy: without NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN (a build-time
// exact HTTPS origin) the dashboards stay same-origin-only.

export const HEADMASTER_MESSAGE_PREFIX = "headmaster:nora:";

export type HeadmasterStatus = {
  type: "headmaster:nora:status";
  nonce: string;
  ready: boolean;
  role: string | null;
  brand: "headmaster";
  view: "runtime-operations" | "platform-administration";
};

type HelloMessage = { type: "headmaster:nora:hello"; nonce: string };
type LaunchInitMessage = { type: "headmaster:nora:launch-init"; nonce: string };
type LaunchCodeMessage = { type: "headmaster:nora:launch-code"; nonce: string; code: string };

type InboundMessage = HelloMessage | LaunchInitMessage | LaunchCodeMessage;

export type HeadmasterBridgeOptions = {
  /** Fixed iframe path family for this bundle: "runtime-operations" or "platform-administration". */
  view: "runtime-operations" | "platform-administration";
  /** Where to send this window after a successful launch redemption. */
  entryPath?: string;
  /** Extra readiness check; defaults to GET /api/auth/me role === "admin". */
  verifyReady?: () => Promise<{ ready: boolean; role: string | null }>;
};

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CODE_PATTERN = /^[A-Fa-f0-9]{64}$/; // 256-bit hex launch code
const LAUNCH_BROWSER_COOKIE = "hm_launch_browser";

/**
 * Parse and strictly validate the build-time parent origin.
 * Returns null when unset or invalid — embedding then stays same-origin-only.
 */
export function parseHeadmasterParentOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // Exact origin only: no wildcard, path, query, credentials, or fragments.
  if (
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    value.includes("*")
  ) {
    return null;
  }
  const normalized = `${url.protocol}//${url.host.toLowerCase()}`;
  return normalized === value.toLowerCase().replace(/\/$/, "") ? normalized : null;
}

export function getHeadmasterParentOrigin(): string | null {
  // NEXT_PUBLIC_* is inlined at build time; reading it through the index keeps
  // runtime overrides from silently loosening the frame policy.
  return parseHeadmasterParentOrigin(process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN);
}

export function isHeadmasterEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  if (!getHeadmasterParentOrigin()) return false;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access threw — we are framed.
    return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInbound(data: unknown): InboundMessage | null {
  if (!isPlainObject(data)) return null;
  const type = data.type;
  const nonce = data.nonce;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return null;
  if (type === "headmaster:nora:hello") return { type, nonce };
  if (type === "headmaster:nora:launch-init") return { type, nonce };
  if (
    type === "headmaster:nora:launch-code" &&
    typeof data.code === "string" &&
    CODE_PATTERN.test(data.code)
  ) {
    return { type, nonce, code: data.code };
  }
  return null;
}

async function defaultVerifyReady(): Promise<{ ready: boolean; role: string | null }> {
  try {
    const response = await fetch("/api/auth/me", { credentials: "include" });
    if (!response.ok) return { ready: false, role: null };
    const user = (await response.json()) as { role?: unknown };
    const role = typeof user.role === "string" ? user.role : null;
    return { ready: role === "admin", role };
  } catch {
    return { ready: false, role: null };
  }
}

function setEmbeddedFlag() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-headmaster-embedded", "true");
}

function randomToken(bytes = 32): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Ask the Nora backend to plant the browser-binding cookie for the launch
 * exchange. The cookie is HttpOnly and host-only; the returned nonce is
 * carried to the Headmaster server so the issued launch code is bound to
 * exactly this browser.
 */
async function initiateBrowserBinding(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/headmaster/initiate", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { browserNonce?: unknown };
    return typeof data.browserNonce === "string" && NONCE_PATTERN.test(data.browserNonce)
      ? data.browserNonce
      : null;
  } catch {
    return null;
  }
}

async function redeemLaunchCode(code: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/headmaster/redeem", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Navigate to the real entry point after a successful redemption. The launch
 * page is a pre-auth staging surface and must not simply reload.
 */
export function completeHeadmasterLaunch(entryPath?: string) {
  setEmbeddedFlag();
  // Head to the real entry point authenticated (the launch page is a
  // pre-auth staging surface and must not be reloaded).
  window.location.assign(entryPath && entryPath.startsWith("/") ? entryPath : "/");
}

let bridgeInstalled = false;

/**
 * Install the bridge message listener. Returns a cleanup function.
 * No-op unless the parent origin is configured AND we are actually framed.
 * Singleton: only the first installer on a document is active, so a launch
 * page and the app shell never double-answer.
 */
export function startHeadmasterBridge(options: HeadmasterBridgeOptions): () => void {
  if (typeof window === "undefined") return () => {};
  if (bridgeInstalled) return () => {};
  const parentOrigin = getHeadmasterParentOrigin();
  if (!parentOrigin) return () => {};
  try {
    if (window.self === window.top) return () => {};
  } catch {
    // Cross-origin access threw — we are framed.
  }
  bridgeInstalled = true;

  let browserNonce: string | null = null;
  let launchInFlight = false;

  const verifyReady = options.verifyReady ?? defaultVerifyReady;

  async function statusFor(nonce: string): Promise<HeadmasterStatus> {
    const { ready, role } = await verifyReady();
    if (ready) setEmbeddedFlag();
    return {
      type: "headmaster:nora:status",
      nonce,
      ready,
      role,
      brand: "headmaster",
      view: options.view,
    };
  }

  async function handleMessage(event: MessageEvent) {
    if (event.origin !== parentOrigin) return;
    if (event.source !== window.parent) return;
    const message = parseInbound(event.data);
    if (!message) return;

    if (message.type === "headmaster:nora:hello") {
      window.parent.postMessage(await statusFor(message.nonce), parentOrigin);
      return;
    }

    if (message.type === "headmaster:nora:launch-init") {
      if (launchInFlight) {
        window.parent.postMessage(
          { type: "headmaster:nora:launch-error", nonce: message.nonce, reason: "in_progress" },
          parentOrigin,
        );
        return;
      }
      launchInFlight = true;
      const nonce = await initiateBrowserBinding();
      launchInFlight = false;
      if (!nonce) {
        window.parent.postMessage(
          { type: "headmaster:nora:launch-error", nonce: message.nonce, reason: "initiate_failed" },
          parentOrigin,
        );
        return;
      }
      browserNonce = nonce;
      window.parent.postMessage(
        { type: "headmaster:nora:launch-ready", nonce: message.nonce, browserNonce },
        parentOrigin,
      );
      return;
    }

    if (message.type === "headmaster:nora:launch-code") {
      // The code is redeemed with the browser-binding cookie attached; the
      // server matches code binding, cookie, audience, origin, and identity.
      const ok = Boolean(browserNonce) && (await redeemLaunchCode(message.code));
      browserNonce = null;
      if (ok) {
        completeHeadmasterLaunch(options.entryPath);
      } else {
        window.parent.postMessage(
          { type: "headmaster:nora:launch-error", nonce: message.nonce, reason: "redeem_failed" },
          parentOrigin,
        );
      }
    }
  }

  window.addEventListener("message", handleMessage);
  // Report readiness proactively so the host can drop its loading state.
  void statusFor(randomToken(16)).then((status) => {
    window.parent.postMessage(status, parentOrigin);
  });
  setEmbeddedFlag();

  return () => window.removeEventListener("message", handleMessage);
}

export const __headmasterTestHooks = {
  NONCE_PATTERN,
  CODE_PATTERN,
  LAUNCH_BROWSER_COOKIE,
  parseInbound,
  isExactHttpsOrigin: parseHeadmasterParentOrigin,
};
