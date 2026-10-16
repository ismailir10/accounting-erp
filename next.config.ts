import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local images only, without query strings (the public page draws its illustrations instead of shipping screenshots).
  images: { localPatterns: [{ pathname: "**", search: "" }] },
  serverExternalPackages: ["pg", "exceljs", "pdfkit"],
  // AGENTS.md (and its CLAUDE.md symlink) is hand-maintained; stop `next dev` from rewriting it.
  agentRules: false,
  // Keep the dev badge from covering the sidebar footer during demos run from `npm run dev`.
  devIndicators: false,
  // Dev logs print server-action arguments verbatim. Those include the AI key, the admin passcode and PDF passwords.
  logging: { serverFunctions: false },
  // Statements up to 5 MB go through a server action (default limit is 1 MB).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  // Public product decks: static files in public/deck, served without login. Same-origin only; nothing from the app is reachable from them.
  // /deck chooses between the two decks: /deck/kantor (accounting firms) and /deck/perusahaan (companies).
  async rewrites() {
    return [
      { source: "/deck", destination: "/deck/index.html" },
      { source: "/deck/", destination: "/deck/index.html" },
      { source: "/deck/kantor", destination: "/deck/kantor.html" },
      { source: "/deck/perusahaan", destination: "/deck/perusahaan.html" },
    ];
  },
  async headers() {
    return [
      {
        source: "/deck/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
