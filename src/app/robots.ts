import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: "*",
      allow: ["/", "/security", "/privacy", "/terms"],
      disallow: ["/app", "/api", "/login", "/forgot-password", "/reset-password", "/try-demo"],
    }],
    sitemap: "https://business.finlynq.com/sitemap.xml",
    host: "https://business.finlynq.com",
  };
}
