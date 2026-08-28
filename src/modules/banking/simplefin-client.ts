import "server-only";

import { lookup as systemLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * The SimpleFIN protocol flow is adapted from Finlynq's AGPL-3.0-only
 * import-connector client. This implementation is independently rewritten for
 * Business Finlynq and adds pinned public-DNS resolution, HTTPS-only endpoints,
 * blocked redirects, bounded bodies, and short operation timeouts.
 */

export type SimpleFinTransaction = Readonly<{
  id: string;
  posted: number;
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
  transacted_at?: number;
  mcc?: string;
}>;

export type SimpleFinAccount = Readonly<{
  id: string;
  name: string;
  currency: string;
  balance?: string | number;
  "available-balance"?: string | number;
  "balance-date"?: number;
  org?: Readonly<{ name?: string; domain?: string }>;
  transactions?: readonly SimpleFinTransaction[];
}>;

export type SimpleFinAccountsResponse = Readonly<{
  accounts: readonly SimpleFinAccount[];
  errors?: readonly string[];
}>;

export type SimpleFinFetchWindow = Readonly<{
  startDate?: number;
  endDate?: number;
  includePending?: boolean;
}>;

export type SimpleFinFailureCode =
  | "INVALID_SETUP_TOKEN"
  | "UNSAFE_ENDPOINT"
  | "DNS_FAILED"
  | "REDIRECT_BLOCKED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_AUTHORIZATION_REJECTED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_INVALID_RESPONSE";

export class SimpleFinClientError extends Error {
  constructor(
    public readonly code: SimpleFinFailureCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SimpleFinClientError";
  }
}

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type SimpleFinResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64],
  ["64:ff9b::", 96], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

export function isPublicSimpleFinAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family === 6) return !address.toLowerCase().startsWith("::ffff:") && !blockedAddresses.check(address, "ipv6");
  return false;
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  try {
    const addresses = await systemLookup(hostname, { all: true, verbatim: true });
    return addresses
      .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
      .slice(0, 16);
  } catch {
    throw new SimpleFinClientError("DNS_FAILED", "The provider endpoint could not be resolved.", true);
  }
}

export async function validateSimpleFinEndpoint(
  value: string,
  options: Readonly<{
    credentials: "forbid" | "require";
    resolver?: SimpleFinResolver;
  }>,
): Promise<Readonly<{ url: URL; addresses: readonly ResolvedAddress[] }>> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SimpleFinClientError("UNSAFE_ENDPOINT", "The provider endpoint is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const credentialsPresent = Boolean(url.username && url.password);
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    !hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
    url.hash ||
    (options.credentials === "forbid" ? Boolean(url.username || url.password) : !credentialsPresent)
  ) {
    throw new SimpleFinClientError("UNSAFE_ENDPOINT", "The provider endpoint does not meet the secure connection policy.");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await (options.resolver ?? defaultResolver)(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicSimpleFinAddress(entry.address))) {
    throw new SimpleFinClientError("UNSAFE_ENDPOINT", "The provider endpoint did not resolve exclusively to public addresses.");
  }
  return { url, addresses };
}

type BoundedRequest = Readonly<{
  method: "GET" | "POST";
  url: URL;
  addresses: readonly ResolvedAddress[];
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maximumBytes: number;
}>;

async function boundedHttpsRequest(input: BoundedRequest): Promise<Readonly<{ status: number; body: Buffer; contentType: string }>> {
  const selected = input.addresses[0];
  if (!selected) throw new SimpleFinClientError("DNS_FAILED", "The provider endpoint could not be resolved.", true);

  const lookup: LookupFunction = ((_hostname, _options, callback) => {
    callback(null, selected.address, selected.family);
  }) as LookupFunction;

  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.url.hostname,
      port: 443,
      method: input.method,
      path: `${input.url.pathname}${input.url.search}`,
      headers: input.headers,
      lookup,
      servername: input.url.hostname,
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new SimpleFinClientError("REDIRECT_BLOCKED", "The provider attempted an untrusted redirect."));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > input.maximumBytes) {
        response.destroy();
        reject(new SimpleFinClientError("PROVIDER_RESPONSE_TOO_LARGE", "The provider response exceeded the safe size limit."));
        return;
      }
      let received = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > input.maximumBytes) {
          response.destroy(new SimpleFinClientError("PROVIDER_RESPONSE_TOO_LARGE", "The provider response exceeded the safe size limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({
        status,
        body: Buffer.concat(chunks),
        contentType: String(response.headers["content-type"] ?? ""),
      }));
      response.on("error", reject);
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new SimpleFinClientError("PROVIDER_TIMEOUT", "The provider did not respond before the secure timeout.", true));
    });
    request.on("error", (error) => {
      reject(error instanceof SimpleFinClientError
        ? error
        : new SimpleFinClientError("PROVIDER_HTTP_ERROR", "The encrypted bank-feed request failed.", true));
    });
    request.end();
  });
}

function decodeSetupToken(setupToken: string): string {
  const normalized = setupToken.trim();
  if (normalized.length < 20 || normalized.length > 4096 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) {
    throw new SimpleFinClientError("INVALID_SETUP_TOKEN", "The SimpleFIN setup token is invalid.");
  }
  try {
    const base64 = normalized.replaceAll("-", "+").replaceAll("_", "/");
    const unpadded = base64.replace(/=+$/, "");
    if (unpadded.length % 4 === 1) throw new Error("invalid base64 length");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== unpadded) throw new Error("non-canonical base64");
    const decoded = bytes.toString("utf8").trim();
    if (decoded.length < 12 || decoded.length > 2048 || decoded.includes("\uFFFD")) throw new Error("invalid token");
    return decoded;
  } catch {
    throw new SimpleFinClientError("INVALID_SETUP_TOKEN", "The SimpleFIN setup token is invalid.");
  }
}

export async function exchangeSimpleFinSetupToken(
  setupToken: string,
  options: Readonly<{ resolver?: SimpleFinResolver; timeoutMs?: number }> = {},
): Promise<string> {
  const claimEndpoint = await validateSimpleFinEndpoint(decodeSetupToken(setupToken), {
    credentials: "forbid",
    resolver: options.resolver,
  });
  const response = await boundedHttpsRequest({
    method: "POST",
    url: claimEndpoint.url,
    addresses: claimEndpoint.addresses,
    headers: { "Content-Length": "0", Accept: "text/plain" },
    timeoutMs: options.timeoutMs ?? 20_000,
    maximumBytes: 8192,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new SimpleFinClientError("PROVIDER_HTTP_ERROR", "SimpleFIN rejected or expired the one-time setup token.");
  }
  const accessUrl = response.body.toString("utf8").trim();
  await validateSimpleFinEndpoint(accessUrl, { credentials: "require", resolver: options.resolver });
  return accessUrl;
}

export async function fetchSimpleFinAccounts(
  accessUrl: string,
  window: SimpleFinFetchWindow = {},
  options: Readonly<{ resolver?: SimpleFinResolver; timeoutMs?: number }> = {},
): Promise<SimpleFinAccountsResponse> {
  const endpoint = await validateSimpleFinEndpoint(accessUrl, {
    credentials: "require",
    resolver: options.resolver,
  });
  const username = decodeURIComponent(endpoint.url.username);
  const password = decodeURIComponent(endpoint.url.password);
  const basePath = endpoint.url.pathname.replace(/\/+$/, "");
  const requestUrl = new URL(endpoint.url.toString());
  requestUrl.username = "";
  requestUrl.password = "";
  requestUrl.pathname = `${basePath}/accounts`.replace(/\/{2,}/g, "/");
  requestUrl.search = "";
  if (window.startDate !== undefined) requestUrl.searchParams.set("start-date", String(Math.floor(window.startDate)));
  if (window.endDate !== undefined) requestUrl.searchParams.set("end-date", String(Math.floor(window.endDate)));
  if (window.includePending) requestUrl.searchParams.set("pending", "1");

  const response = await boundedHttpsRequest({
    method: "GET",
    url: requestUrl,
    addresses: endpoint.addresses,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      Accept: "application/json",
    },
    timeoutMs: options.timeoutMs ?? 30_000,
    maximumBytes: 8 * 1024 * 1024,
  });
  if (response.status === 401 || response.status === 403) {
    throw new SimpleFinClientError(
      "PROVIDER_AUTHORIZATION_REJECTED",
      "SimpleFIN no longer authorizes this connection. Reauthorize it with a new one-time setup token.",
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SimpleFinClientError("PROVIDER_HTTP_ERROR", "SimpleFIN could not return the connected accounts.", response.status >= 500);
  }
  if (!response.contentType.toLowerCase().includes("application/json")) {
    throw new SimpleFinClientError("PROVIDER_INVALID_RESPONSE", "SimpleFIN returned an unexpected response format.");
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new SimpleFinClientError("PROVIDER_INVALID_RESPONSE", "SimpleFIN returned invalid JSON.");
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { accounts?: unknown }).accounts)) {
    throw new SimpleFinClientError("PROVIDER_INVALID_RESPONSE", "SimpleFIN did not return an accounts list.");
  }
  return body as SimpleFinAccountsResponse;
}
