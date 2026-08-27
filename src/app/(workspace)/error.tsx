"use client";

export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="page-content"><div className="empty-state"><strong>This workspace page could not be rendered.</strong><p>Retry the request. If this followed a submission, check the record before submitting it again.</p><button type="button" className="primary-button" onClick={reset}>Try again</button></div></div>;
}
