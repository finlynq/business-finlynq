import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Business Finlynq",
    template: "%s · Business Finlynq",
  },
  description: "Audit-first, multi-entity accounting for small businesses.",
  applicationName: "Business Finlynq",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
