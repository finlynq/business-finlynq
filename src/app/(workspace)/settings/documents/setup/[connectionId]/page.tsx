import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { mutationContext } from "@/modules/workspace/write-policy";
import { getStorageSetup } from "@/modules/document-storage/setup";
import { StorageError } from "@/modules/document-storage/provider";
import { PageHeader } from "@/app/_components/ui";
import { StorageSetupApproval } from "@/app/_components/storage-setup-approval.client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approve document storage" };
export default async function StorageSetupPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const principal = await requireWorkspacePrincipal(`/app/settings/documents/setup/${connectionId}`);
  let setup;
  try { setup = await getStorageSetup(mutationContext(principal, randomUUID()), connectionId); }
  catch (error) { if (error instanceof StorageError) notFound(); throw error; }
  return <div className="page-content">
    <PageHeader eyebrow="Documents" title="Review document storage" description="Approve the company and accounting module that may use this inbox." actions={<Link className="secondary-button" href="/app/settings/documents">Document inbox</Link>} />
    <StorageSetupApproval initial={setup} />
  </div>;
}
