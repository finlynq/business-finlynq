import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://business.finlynq.com"),
  title: {
    default: "Business Finlynq",
    template: "%s | Business Finlynq",
  },
  description: "Open-source, audit-first, multicurrency accounting for small businesses.",
  applicationName: "Business Finlynq",
  keywords: ["open-source ERP", "small business accounting", "multicurrency accounting", "period close", "MCP accounting"],
  authors: [{ name: "Finlynq", url: "https://finlynq.com" }],
  creator: "Finlynq",
  openGraph: {
    type: "website",
    locale: "en_CA",
    url: "/",
    siteName: "Business Finlynq",
    title: "Business Finlynq — accounting with an audit trail",
    description: "A modular, multicurrency accounting foundation with immutable posting history and governed AI access.",
    images: [
      {
        url: "/business-finlynq-social.png",
        width: 1731,
        height: 909,
        alt: "An abstract secured ledger network for Business Finlynq",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Business Finlynq — accounting with an audit trail",
    description: "Open-source, audit-first accounting for small businesses.",
    images: ["/business-finlynq-social.png"],
  },
  category: "finance",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#142237" },
  ],
  colorScheme: "light",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Next.js can apply a request nonce only while rendering dynamically. The
  // application handles financial and identity data, so every HTML response
  // uses the fresh nonce established by src/proxy.ts.
  await connection();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
