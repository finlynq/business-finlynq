import { NextResponse } from "next/server";
import { queryDatabase } from "@/db/transaction";
import { loadIdentitySecret } from "@/security/identity-secret";
import { loadOrganizationRootKek } from "@/security/root-secret";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  try {
    loadIdentitySecret();
    loadOrganizationRootKek();
    const result = await queryDatabase<{ ready: number }>("SELECT 1::integer AS ready");
    if (result.rows[0]?.ready !== 1) throw new Error("Database readiness query returned an unexpected result");
    return NextResponse.json({ status: "ready" }, { headers });
  } catch (error) {
    console.error("Business Finlynq readiness check failed", { error });
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  }
}
