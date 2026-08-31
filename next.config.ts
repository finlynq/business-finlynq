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
      "/banking",
      "/banking/:path*",
      "/controls/:path*",
      "/entities",
      "/journals/:path*",
      "/parties",
      "/payables/:path*",
      "/receivables/:path*",
      "/reports/:path*",
      "/settings",
      "/settings/:path*",
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
      { source: "/app/banking", destination: "/banking" },
      { source: "/app/banking/:path*", destination: "/banking/:path*" },
      { source: "/app/controls/:path*", destination: "/controls/:path*" },
      { source: "/app/entities", destination: "/entities" },
      { source: "/app/journals/:path*", destination: "/journals/:path*" },
      { source: "/app/parties", destination: "/parties" },
      { source: "/app/payables/:path*", destination: "/payables/:path*" },
      { source: "/app/receivables/:path*", destination: "/receivables/:path*" },
      { source: "/app/reports/:path*", destination: "/reports/:path*" },
      { source: "/app/settings", destination: "/settings" },
      { source: "/app/settings/:path*", destination: "/settings/:path*" },
      { source: "/app/tax", destination: "/tax" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
