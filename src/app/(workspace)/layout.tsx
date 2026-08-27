import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
import { platformAdministratorAuthorization } from "@/modules/identity/platform-administration";
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
  const platformAdministrator = await platformAdministratorAuthorization(principal);
  return (
    <WorkspaceShell
      principal={principal}
      readOnly={!principalCanWrite(principal)}
      isPlatformAdministrator={Boolean(platformAdministrator)}
    >
      {children}
    </WorkspaceShell>
  );
}
