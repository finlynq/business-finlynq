import Link from "next/link";

export default function WorkspaceNotFound() {
  return <div className="page-content"><div className="empty-state"><strong>Page not found</strong><p>The requested demo route does not exist.</p><Link className="primary-button" href="/">Return to overview</Link></div></div>;
}
