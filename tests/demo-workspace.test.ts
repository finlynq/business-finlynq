import { describe, expect, it } from "vitest";
import {
  escapeDemoCsvCell,
  generateDemoTrialBalanceCsv,
  getDemoTrialBalance,
  searchDemoWorkspace,
} from "@/modules/demo/workspace";

describe("demo workspace queries and exports", () => {
  it("searches, ranks, filters, and limits the serializable workspace index", () => {
    const exactInvoice = searchDemoWorkspace("INV-1048");
    expect(exactInvoice[0]).toMatchObject({
      id: "invoice-ca-1048",
      kind: "invoice",
      href: "/receivables/invoices?q=INV-1048",
    });

    const filtered = searchDemoWorkspace("cascade", {
      kinds: ["invoice"],
      entityCode: "US01",
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ kind: "invoice", entityCode: "US01" });
    expect(searchDemoWorkspace("   ")).toEqual([]);
  });

  it("routes results to their real workspace and owning subledger", () => {
    expect(searchDemoWorkspace("CA01", { kinds: ["entity"] })[0]?.href).toBe(
      "/entities?q=CA01",
    );
    expect(searchDemoWorkspace("CA-000288", { kinds: ["journal"] })[0]?.href).toBe(
      "/journals?q=PREPAID-AUG",
    );
    expect(searchDemoWorkspace("CA-000291", { kinds: ["journal"] })[0]?.href).toBe(
      "/receivables/invoices?q=INV-1048",
    );
    expect(searchDemoWorkspace("US-000188", { kinds: ["journal"] })[0]?.href).toBe(
      "/payables/bills?q=BILL-0882",
    );
    expect(searchDemoWorkspace("trial balance", { kinds: ["report"] })[0]?.href).toBe(
      "/reports/trial-balance",
    );
    expect(searchDemoWorkspace("August close", { kinds: ["control"] })[0]?.href).toBe(
      "/controls/period-close",
    );
  });

  it("returns balanced, currency-specific trial balance reports", () => {
    expect(getDemoTrialBalance("CA01")).toMatchObject({
      demoOnly: true,
      entityCode: "CA01",
      currency: "CAD",
      totalDebit: "252710.35",
      totalCredit: "252710.35",
      balanced: true,
    });
    expect(getDemoTrialBalance("US01")).toMatchObject({
      demoOnly: true,
      entityCode: "US01",
      currency: "USD",
      totalDebit: "235940.20",
      totalCredit: "235940.20",
      balanced: true,
    });
  });

  it("escapes CSV formulas and quotes every cell", () => {
    expect(escapeDemoCsvCell("=1+1")).toBe("\"'=1+1\"");
    expect(escapeDemoCsvCell("  @SUM(A1:A2)")).toBe("\"'  @SUM(A1:A2)\"");
    expect(escapeDemoCsvCell('A "quoted" value')).toBe('"A ""quoted"" value"');
  });

  it("labels the export as demo data and separates both currencies", () => {
    const allEntities = generateDemoTrialBalanceCsv();
    expect(allEntities.startsWith('"DEMO DATA - NOT AN OFFICIAL ACCOUNTING EXPORT"')).toBe(true);
    expect(allEntities).toContain('"Entity","CA01","Currency","CAD"');
    expect(allEntities).toContain('"Entity","US01","Currency","USD"');
    expect(allEntities).toContain('"DEMO TOTAL","","","","252710.35","252710.35"');
    expect(allEntities).toContain('"DEMO TOTAL","","","","235940.20","235940.20"');

    const canadaOnly = generateDemoTrialBalanceCsv({ entityCode: "CA01" });
    expect(canadaOnly).toContain('"Entity","CA01","Currency","CAD"');
    expect(canadaOnly).not.toContain('"Entity","US01","Currency","USD"');
  });
});
