import { z } from "zod";
import { loadOAuthClient, type McpOAuthClient } from "./oauth-store";
import {
  McpOAuthError,
  mcpResourceUrl,
  parseRequestedScopes,
  type McpOAuthScope,
} from "./protocol";

const authorizationRequestSchema = z.object({
  responseType: z.literal("code"),
  clientId: z.string().trim().min(1).max(200),
  redirectUri: z.url().max(2000),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().max(2000).optional(),
  resource: z.url().max(2000),
  scope: z.string().max(1000).optional(),
}).strict();

export type ValidatedAuthorizationRequest = Readonly<{
  responseType: "code";
  client: McpOAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource: string;
  scopes: readonly McpOAuthScope[];
}>;

export function validateRedirectUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpOAuthError("invalid_redirect_uri", "Each redirect URI must be an absolute URL");
  }
  if (url.hash) throw new McpOAuthError("invalid_redirect_uri", "OAuth redirect URIs cannot include fragments");
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new McpOAuthError("invalid_redirect_uri", "OAuth redirect URIs must use HTTPS except on localhost");
  }
  if (url.username || url.password) throw new McpOAuthError("invalid_redirect_uri", "OAuth redirect URIs cannot contain credentials");
  return url.href;
}

export async function validateAuthorizationRequest(
  search: URLSearchParams,
  requestUrl: string,
): Promise<ValidatedAuthorizationRequest> {
  const parsed = authorizationRequestSchema.safeParse({
    responseType: search.get("response_type"),
    clientId: search.get("client_id"),
    redirectUri: search.get("redirect_uri"),
    codeChallenge: search.get("code_challenge"),
    codeChallengeMethod: search.get("code_challenge_method"),
    state: search.get("state") ?? undefined,
    resource: search.get("resource"),
    scope: search.get("scope") ?? undefined,
  });
  if (!parsed.success) throw new McpOAuthError("invalid_request", "The OAuth authorization request is incomplete or invalid");
  const client = await loadOAuthClient(parsed.data.clientId);
  if (!client) throw new McpOAuthError("invalid_client", "The OAuth client is unknown or inactive", 401);
  const redirectUri = validateRedirectUri(parsed.data.redirectUri);
  if (!client.redirectUris.includes(redirectUri)) {
    throw new McpOAuthError("invalid_request", "The redirect URI is not registered for this OAuth client");
  }
  const expectedResource = mcpResourceUrl(requestUrl).href;
  if (parsed.data.resource !== expectedResource) {
    throw new McpOAuthError("invalid_target", "The resource parameter must identify this MCP endpoint");
  }
  return {
    responseType: "code",
    client,
    redirectUri,
    codeChallenge: parsed.data.codeChallenge,
    state: parsed.data.state,
    resource: expectedResource,
    scopes: parseRequestedScopes(parsed.data.scope),
  };
}

export async function readFormBody(request: Request, maximumBytes = 16_384): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new McpOAuthError("invalid_request", "OAuth endpoint requires application/x-www-form-urlencoded");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximumBytes) {
    throw new McpOAuthError("invalid_request", "OAuth request body is too large", 413);
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maximumBytes) {
    throw new McpOAuthError("invalid_request", "OAuth request body is too large", 413);
  }
  return new URLSearchParams(body);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function appendOAuthResult(
  redirectUri: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  const redirect = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) redirect.searchParams.set(name, value);
  }
  return redirect.href;
}
