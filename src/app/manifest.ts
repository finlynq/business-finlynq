import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Business Finlynq",
    short_name: "Finlynq Business",
    description: "Open-source, audit-first accounting for small businesses.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f6f8",
    theme_color: "#142237",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
