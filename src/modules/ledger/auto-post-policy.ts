import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";

export type PostingOrigin = "USER" | "SYSTEM" | "IMPORT" | "API" | "MCP" | "BANK" | "AI";

export type AutoPostDecision = Readonly<{
  allowed: boolean;
  reason: string;
}>;

const deterministicSourceTypes = new Set([
  "receivables.sales-invoice",
  "payables.supplier-bill",
]);

export function decideSynchronousPost(input: Readonly<{
  origin: PostingOrigin;
  journalTypeKey: string;
  actorPermissions: ReadonlySet<Permission>;
  sourceActionExplicitlyAuthorized: boolean;
}>): AutoPostDecision {
  if (!input.actorPermissions.has(PERMISSIONS.postJournal)) {
    return { allowed: false, reason: "Actor lacks the posting permission" };
  }

  if (["IMPORT", "MCP", "BANK", "AI"].includes(input.origin)) {
    return { allowed: false, reason: `${input.origin} activity is draft-only in v0` };
  }

  if (!deterministicSourceTypes.has(input.journalTypeKey)) {
    return { allowed: false, reason: "General configurable auto-posting is disabled in v0" };
  }

  if (!input.sourceActionExplicitlyAuthorized) {
    return { allowed: false, reason: "The user has not authorized the source business action" };
  }

  return { allowed: true, reason: "Authorized deterministic source action" };
}
