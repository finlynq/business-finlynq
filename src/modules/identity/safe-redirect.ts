export function safeAppPath(value: string | null | undefined, fallback = "/app"): string {
  if (!value || !value.startsWith("/app") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const parsed = new URL(value, "https://business.finlynq.invalid");
    if (parsed.origin !== "https://business.finlynq.invalid") return fallback;
    if (parsed.pathname !== "/app" && !parsed.pathname.startsWith("/app/")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
