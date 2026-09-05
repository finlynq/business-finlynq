const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function oauthCallbackFormActionSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const callback = new URL(raw);
    const localHttp = callback.protocol === "http:" && LOOPBACK_HOSTS.has(callback.hostname);
    if ((callback.protocol !== "https:" && !localHttp) || callback.username || callback.password || callback.hash) {
      return null;
    }
    return callback.origin;
  } catch {
    return null;
  }
}

export function oauthAuthorizationContentSecurityPolicy(redirectUri: string): string {
  const callbackSource = oauthCallbackFormActionSource(redirectUri);
  const formAction = callbackSource ? `form-action 'self' ${callbackSource}` : "form-action 'self'";
  return `default-src 'none'; ${formAction}; base-uri 'none'; frame-ancestors 'none'`;
}
