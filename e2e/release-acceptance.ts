import type { APIRequestContext, APIResponse, BrowserContext } from "@playwright/test";

const acceptanceHeader = "Authorization";
const acceptanceHeaderLower = acceptanceHeader.toLowerCase();
const acceptanceBaseURL = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
);
const releaseAcceptanceToken = process.env.PLAYWRIGHT_RELEASE_ACCEPTANCE_TOKEN;

if (!/^https?:$/.test(acceptanceBaseURL.protocol)
  || acceptanceBaseURL.username
  || acceptanceBaseURL.password) {
  throw new Error("PLAYWRIGHT_BASE_URL must be a credential-free HTTP(S) URL");
}
if (releaseAcceptanceToken && !/^[a-f0-9]{64}$/.test(releaseAcceptanceToken)) {
  throw new Error("PLAYWRIGHT_RELEASE_ACCEPTANCE_TOKEN must be 64 lowercase hexadecimal characters");
}

function scopedHeaders(
  inherited: Readonly<Record<string, string>> | undefined,
  includeToken: boolean,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(inherited ?? {}).filter(([name]) => name.toLowerCase() !== acceptanceHeaderLower),
  );
  if (includeToken && releaseAcceptanceToken) {
    headers[acceptanceHeader] = `Bearer ${releaseAcceptanceToken}`;
  }
  return headers;
}

function sameOriginTarget(target: string): URL {
  const resolved = new URL(target, acceptanceBaseURL);
  if (resolved.origin !== acceptanceBaseURL.origin || resolved.username || resolved.password) {
    throw new Error(`Release acceptance refused a cross-origin API request: ${resolved.origin}`);
  }
  return resolved;
}

export async function installReleaseAcceptanceRoute(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestURL = new URL(route.request().url());
    const headers = scopedHeaders(
      route.request().headers(),
      requestURL.origin === acceptanceBaseURL.origin,
    );
    await route.continue({ headers });
  });
}

type GetOptions = NonNullable<Parameters<APIRequestContext["get"]>[1]>;
type PostOptions = NonNullable<Parameters<APIRequestContext["post"]>[1]>;
type DeleteOptions = NonNullable<Parameters<APIRequestContext["delete"]>[1]>;

export function releaseGet(
  request: APIRequestContext,
  target: string,
  options: GetOptions = {},
): Promise<APIResponse> {
  return request.get(sameOriginTarget(target).href, {
    ...options,
    headers: scopedHeaders(options.headers, true),
    // Playwright forwards request headers across redirects. Returning the first
    // redirect keeps the private token confined to the validated origin.
    maxRedirects: 0,
  });
}

export function releasePost(
  request: APIRequestContext,
  target: string,
  options: PostOptions = {},
): Promise<APIResponse> {
  return request.post(sameOriginTarget(target).href, {
    ...options,
    headers: scopedHeaders(options.headers, true),
    maxRedirects: 0,
  });
}

export function releaseDelete(
  request: APIRequestContext,
  target: string,
  options: DeleteOptions = {},
): Promise<APIResponse> {
  return request.delete(sameOriginTarget(target).href, {
    ...options,
    headers: scopedHeaders(options.headers, true),
    maxRedirects: 0,
  });
}
