import { NextResponse } from "next/server";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";

export const AUTH_MUTATION_MAXIMUM_BYTES = 16_384;
export const AUTH_MUTATION_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

type AuthMutationBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: NextResponse<{ error: string }> };

const mutationBodyMessages: Record<MutationBodyError["status"], string> = {
  400: "The request body is not valid JSON.",
  413: "The request body is too large.",
  415: "The request body must use application/json.",
};

export async function readAuthMutationJson(request: Request): Promise<AuthMutationBodyResult> {
  try {
    return {
      ok: true,
      value: await readBoundedJson(request, AUTH_MUTATION_MAXIMUM_BYTES),
    };
  } catch (error) {
    if (!(error instanceof MutationBodyError)) throw error;
    return {
      ok: false,
      response: NextResponse.json(
        { error: mutationBodyMessages[error.status] },
        { status: error.status, headers: AUTH_MUTATION_HEADERS },
      ),
    };
  }
}
