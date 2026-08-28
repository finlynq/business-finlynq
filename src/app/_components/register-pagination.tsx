import Link from "next/link";
import type { RegisterPagination } from "@/modules/workspace/register-pagination";
import styles from "./register-pagination.module.css";

function pageHref(
  basePath: string,
  page: number,
  parameters: Readonly<Record<string, string | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  else query.delete("page");
  const encoded = query.toString();
  return encoded ? `${basePath}?${encoded}` : basePath;
}

export function RegisterPaginationNav({
  basePath,
  pagination,
  parameters = {},
}: Readonly<{
  basePath: string;
  pagination: RegisterPagination | undefined;
  parameters?: Readonly<Record<string, string | undefined>>;
}>) {
  if (!pagination || (!pagination.hasPrevious && !pagination.hasNext)) return null;
  return (
    <nav className={styles.pagination} aria-label="Register pagination">
      {pagination.hasPrevious ? (
        <Link className="secondary-button compact-button" href={pageHref(basePath, pagination.page - 1, parameters)}>Previous</Link>
      ) : <span className={styles.disabled}>Previous</span>}
      <span>Page {pagination.page}</span>
      {pagination.hasNext ? (
        <Link className="secondary-button compact-button" href={pageHref(basePath, pagination.page + 1, parameters)}>Next</Link>
      ) : <span className={styles.disabled}>Next</span>}
    </nav>
  );
}
