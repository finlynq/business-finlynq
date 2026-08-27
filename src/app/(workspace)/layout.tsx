import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { WorkspaceShell } from "../_components/workspace-shell";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const [principal, requestHeaders] = await Promise.all([currentPrincipal(), headers()]);
  if (!principal) {
    const next = safeAppPath(requestHeaders.get("x-business-finlynq-request-path"));
    redirect(`/login?next=${encodeURIComponent(next)}&reason=expired`);
  }
  return <WorkspaceShell principal={principal} readOnly={!principalCanWrite(principal)}>{children}</WorkspaceShell>;
}
