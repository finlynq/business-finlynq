import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";
export const REQUEST_ID_INPUT_HEADER = "x-request-id";

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generatedRequestIds = new WeakMap<object, string>();

export function normalizedRequestId(value: string | null | undefined): string | null {
  const selected = value?.trim();
  return selected && requestIdPattern.test(selected) ? selected.toLowerCase() : null;
}

export function requestIdFor(request: Pick<Request, "headers">): string {
  const cached = generatedRequestIds.get(request);
  if (cached) return cached;
  const requestId = normalizedRequestId(request.headers.get(REQUEST_ID_INPUT_HEADER)) ?? randomUUID();
  generatedRequestIds.set(request, requestId);
  return requestId;
}

export function responseWithRequestId<T extends Response>(response: T, requestId: string): T {
  response.headers.set(REQUEST_ID_HEADER, normalizedRequestId(requestId) ?? "invalid-request-id");
  return response;
}
