"use client";

export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="page-content"><div className="empty-state"><strong>This demo page could not be rendered.</strong><p>No accounting data was changed. Retry the read-only request.</p><button type="button" className="primary-button" onClick={reset}>Try again</button></div></div>;
}
