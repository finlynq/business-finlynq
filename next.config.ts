import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  output: "standalone",
  serverExternalPackages: ["pg"],
  turbopack: {
    // An unrelated lockfile exists higher in the Windows user directory.
    // Pinning the root prevents Turbopack from traversing outside this repo.
    root: process.cwd(),
  },
  async redirects() {
    const legacyWorkspaceRoutes = [
      "/automation",
      "/controls/:path*",
      "/entities",
      "/journals/:path*",
      "/parties",
      "/payables/:path*",
      "/receivables/:path*",
      "/reports/:path*",
      "/tax",
    ];

    return legacyWorkspaceRoutes.map((source) => ({
      source,
      destination: `/app${source}`,
      permanent: true,
    }));
  },
  async rewrites() {
    return [
      { source: "/app/automation", destination: "/automation" },
      { source: "/app/controls/:path*", destination: "/controls/:path*" },
      { source: "/app/entities", destination: "/entities" },
      { source: "/app/journals/:path*", destination: "/journals/:path*" },
      { source: "/app/parties", destination: "/parties" },
      { source: "/app/payables/:path*", destination: "/payables/:path*" },
      { source: "/app/receivables/:path*", destination: "/receivables/:path*" },
      { source: "/app/reports/:path*", destination: "/reports/:path*" },
      { source: "/app/tax", destination: "/tax" },
    ];
  },
  async headers() {
    const turnstileOrigin = "https://challenges.cloudflare.com";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${turnstileOrigin}${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${turnstileOrigin}`,
      `frame-src ${turnstileOrigin}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
      {
        source: "/app/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Vary", value: "Cookie" },
        ],
      },
      {
        source: "/(login|signup|complete-signup|forgot-password|reset-password|accept-invitation|try-demo)",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
