export const registerPageSize = 50;

export type RegisterPagination = Readonly<{
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
}>;

export function normalizeRegisterPage(value: unknown): number {
  const candidate = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) return 1;
  return Math.min(candidate, 10_000);
}

export function registerPageWindow<T>(
  rows: readonly T[],
  page: number,
): Readonly<{ rows: readonly T[]; pagination: RegisterPagination }> {
  const normalizedPage = normalizeRegisterPage(page);
  return {
    rows: rows.slice(0, registerPageSize),
    pagination: {
      page: normalizedPage,
      pageSize: registerPageSize,
      hasPrevious: normalizedPage > 1,
      hasNext: rows.length > registerPageSize,
    },
  };
}
