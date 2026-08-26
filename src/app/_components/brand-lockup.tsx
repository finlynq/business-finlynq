import Link from "next/link";

type BrandLockupProps = Readonly<{
  href?: string;
  inverse?: boolean;
  compact?: boolean;
}>;

export function BrandLockup({ href = "/", inverse = false, compact = false }: BrandLockupProps) {
  return (
    <Link
      href={href}
      className={`site-brand${inverse ? " site-brand-inverse" : ""}${compact ? " site-brand-compact" : ""}`}
      aria-label="Business Finlynq home"
    >
      <span className="site-brand-mark" aria-hidden="true">F</span>
      <span className="site-brand-copy">
        <strong>Finlynq</strong>
        <span>Business</span>
      </span>
    </Link>
  );
}
