export class MutationBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
  }
}
export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new MutationBodyError("Request body must be JSON.", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new MutationBodyError("Request body is too large.", 413);
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new MutationBodyError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new MutationBodyError("Request body is not valid JSON.", 400);
  }
}
