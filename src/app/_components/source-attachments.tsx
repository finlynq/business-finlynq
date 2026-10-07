import type { DocumentEvidenceMetadata } from "@/modules/subledger/evidence-model";

export function SourceAttachments({ attachments }: Readonly<{ attachments: readonly DocumentEvidenceMetadata[] | undefined }>) {
  if (!attachments?.length) return <p>No attachment available.</p>;
  return <ul>{attachments.map((attachment) => <li key={attachment.assetId}>
    <a href={attachment.downloadUrl}>{attachment.filename}</a>{" · "}{attachment.purpose.toLowerCase()}
    {" · "}{attachment.byteSize.toLocaleString()} bytes
    <p>{["application/pdf", "image/png", "image/jpeg"].includes(attachment.mimeType) && <>
      <a className="primary-button compact-button" href={`${attachment.downloadUrl}&disposition=inline`} target="_blank" rel="noopener noreferrer" aria-label={`View attachment ${attachment.filename}`}>View attachment</a>{" "}
    </>}<a className="secondary-button compact-button" href={attachment.downloadUrl} download={attachment.filename}>Download</a></p>
    <details><summary>File audit details</summary><p>Source version {attachment.sourceVersion} · SHA-256: <code>{attachment.sha256}</code></p>
      <p>Uploaded {attachment.uploadedAt} · Scanned {attachment.scannedAt}</p></details>
  </li>)}</ul>;
}
