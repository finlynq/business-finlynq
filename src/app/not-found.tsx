import Link from "next/link";

export default function NotFound() {
  return <main className="public-not-found"><span>404</span><h1>That page is not in the books.</h1><p>The address may have changed, or the page may no longer exist.</p><Link href="/">Return to Business Finlynq</Link></main>;
}
