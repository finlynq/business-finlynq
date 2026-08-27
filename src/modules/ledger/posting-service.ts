import { withTenantTransaction } from "@/db/transaction";
import { assertTenantWritesEnabled } from "@/modules/workspace/write-policy";
import {
  postJournalInTransaction,
  type PostJournalCommand,
  type PostJournalResult,
} from "./posting-engine";

export { postJournalInTransaction } from "./posting-engine";
export type { PostJournalCommand, PostJournalResult, PostingBoundary } from "./posting-engine";

export async function postJournal(command: PostJournalCommand): Promise<PostJournalResult> {
  assertTenantWritesEnabled(command.context);
  return withTenantTransaction(command.context, async (client) => {
    return postJournalInTransaction(client, {
      ...command,
      requiredOwnerModule: "ledger",
      requiredJournalType: "ledger.manual",
    });
  });
}
