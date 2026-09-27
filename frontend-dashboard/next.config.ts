import path from "node:path";
import type { NextConfig } from "next";

// Frame policy is owned here, at the app edge: with a valid build-time
// NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN the dashboard emits CSP
// frame-ancestors 'self' <origin>, which supersedes the reverse proxy's
// X-Frame-Options for modern browsers and permits exactly one embedder.
// Without it no CSP is emitted and framing stays same-origin-only.
function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^https:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?$/.test(value)) return null;
  return value;
}

const parentOrigin = exactHttpsOrigin(process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN);
const frameHeaders = parentOrigin
  ? [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self' ${parentOrigin}`,
          },
        ],
      },
    ]
  : [];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  headers: async () => frameHeaders,
  poweredByHeader: false,
  output: "standalone",
  basePath: "/app",
  i18n: {
    locales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    defaultLocale: "en",
    localeDetection: false,
  },
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
  },
};

export default nextConfig;
