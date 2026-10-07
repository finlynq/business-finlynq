import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JournalRegisterFilters } from "@/app/_components/journal-register-filters";
import { RegisterPaginationNav } from "@/app/_components/register-pagination";
import { buildJournalRegisterPredicate, journalFilterHref, journalFilterParameters, parseJournalFilters } from "@/modules/ledger/journal-register-filters";

const options = { fiscalYears: ["2025"], periods: [], accounts: [], journalTypes: [], sourceModules: ["ledger"], currencies: ["CAD"] };

describe("structured journal filters", () => {
  it("retains repeated and comma-separated statuses across copied and paginated URLs", () => {
    const state = parseJournalFilters({ status: ["SUBMITTED,APPROVED", "SUBMITTED"], dateFrom: "2025-01-01", dateTo: "2025-01-31", currency: "cad" });
    expect(state.errors).toEqual([]);
    expect(state.values.status).toEqual(["SUBMITTED", "APPROVED"]);
    const parameters = journalFilterParameters(state.values, "depreciation");
    expect(parseJournalFilters(parameters).values).toEqual(state.values);
    const html = renderToStaticMarkup(<RegisterPaginationNav basePath="/app/journals" pagination={{ page: 1, pageSize: 50, hasPrevious: false, hasNext: true }} parameters={parameters} />);
    expect(html).toContain("status=SUBMITTED%2CAPPROVED");
    expect(html).toContain("dateFrom=2025-01-01");
    expect(html).toContain("q=depreciation");
    expect(html).toContain("page=2");
  });

  it.each([
    [{ dateFrom: "2025-02-29" }, "valid date"],
    [{ dateTo: "2025-13-01" }, "valid date"],
    [{ dateFrom: "2025-02-01", dateTo: "2025-01-31" }, "on or before"],
    [{ minAmount: "-1" }, "non-negative decimal"],
    [{ maxAmount: "1e9" }, "non-negative decimal"],
    [{ maxAmount: "NaN" }, "non-negative decimal"],
    [{ minAmount: "0.0000000001" }, "9 decimal places"],
    [{ minAmount: "9007199254740993.000000002", maxAmount: "9007199254740993.000000001" }, "less than or equal"],
  ])("rejects invalid ranges without sending malformed values to SQL: %j", (parameters, error) => {
    const state = parseJournalFilters(parameters);
    expect(state.errors.join(" ")).toContain(error);
    const predicate = buildJournalRegisterPredicate({ organizationId: "tenant", selectedEntityId: null, search: "", filterState: state });
    expect(predicate.sql).toContain("AND FALSE");
    expect(predicate.parameters).toHaveLength(4);
  });

  it("compares valid high-precision boundaries without rounding", () => {
    expect(parseJournalFilters({ dateFrom: "2024-02-29", minAmount: "99999999999999999999999999999.000000001", maxAmount: "99999999999999999999999999999.000000002" }).errors).toEqual([]);
  });

  it("removes one filter or one status while retaining search and resets the page", () => {
    const state = parseJournalFilters({ status: ["SUBMITTED", "APPROVED"], minAmount: "5", dateFrom: "2025-01-01", page: "9" });
    const link = new URL(journalFilterHref(state.values, "depreciation", "status", "SUBMITTED"), "https://example.com");
    expect(link.searchParams.get("status")).toBe("APPROVED");
    expect(link.searchParams.get("q")).toBe("depreciation");
    expect(link.searchParams.get("minAmount")).toBe("5");
    expect(link.searchParams.has("page")).toBe(false);
    expect(journalFilterHref(state.values, "depreciation", "dateFrom")).not.toContain("dateFrom=");
  });

  it("renders all controls, active removals, amount basis and validation without retaining a stale page", () => {
    const state = parseJournalFilters({ dateFrom: "2025-02-01", dateTo: "2025-01-01", status: ["SUBMITTED", "APPROVED"], minAmount: "5", page: "8" });
    const html = renderToStaticMarkup(<JournalRegisterFilters search="depreciation" state={state} options={options} />);
    expect(html).toContain('action="/app/journals"');
    expect(html).not.toContain('name="page"');
    expect(html).toContain("Functional-currency journal total (debit)");
    expect(html).toContain('name="fiscalYear"');
    expect(html).toContain('name="periodId"');
    expect(html).toContain('name="accountId"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Accounting date from must be on or before");
    expect(html).toContain('aria-label="Remove status: SUBMITTED"');
    expect(html).toContain('href="/app/journals">Clear all');
  });

  it("binds free text and structured values rather than interpolating SQL", () => {
    const malicious = "' OR 1=1 --";
    const predicate = buildJournalRegisterPredicate({ organizationId: "tenant", selectedEntityId: null, search: "100%_", filterState: parseJournalFilters({ typeKey: malicious }) });
    expect(predicate.sql).not.toContain(malicious);
    expect(predicate.parameters).toEqual(["tenant", "100%_", "%100\\%\\_%", null, malicious]);
  });
});
