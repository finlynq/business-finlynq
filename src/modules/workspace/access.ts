import "server-only";

import { redirect } from "next/navigation";
import { currentPrincipal, type SessionPrincipal } from "@/modules/identity/session";

export async function requireWorkspacePrincipal(nextPath: string): Promise<SessionPrincipal> {
  const principal = await currentPrincipal();
  if (!principal) redirect(`/login?next=${encodeURIComponent(nextPath)}&reason=expired`);
  return principal;
}
