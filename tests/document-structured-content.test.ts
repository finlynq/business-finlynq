import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write, type WorkBook } from "xlsx";
import { classifyInboxFile, decodeStructuredText, validateInboxDocumentBytes } from "@/modules/document-storage/file-types";
import { structuredDocumentPreview } from "@/modules/document-storage/structured-content";

afterEach(() => vi.unstubAllGlobals());

function workbook(bookType: "xls" | "xlsx" | "xlsm" = "xlsx") {
  const first = utils.aoa_to_sheet([
    ["Date", "Description", "Amount", "Calculated", "Link"],
    ["2026-09-05", "Office supply", 12.5, 25, "details"],
  ]);
  first.D2 = { t: "n", v: 25, f: "1+1" };
  first.E2.l = { Target: "https://never.example/evidence" };
  const second = utils.aoa_to_sheet([["Invoice"], ["INV-42"]]);
  const value: WorkBook = { SheetNames: ["Transactions", "Invoices"], Sheets: { Transactions: first, Invoices: second } };
  if (bookType === "xlsm") value.vbaraw = Buffer.from("not-an-executable-macro");
  return write(value, { type: "buffer", bookType });
}

describe("structured inbox type validation", () => {
  it("accepts bounded MIME aliases only when the extension agrees", () => {
    expect(classifyInboxFile({ folder: false, name: "transactions.csv", mimeType: "application/vnd.ms-excel", size: 20 }))
      .toMatchObject({ supported: true, format: "CSV", canonicalMimeType: "text/csv" });
    expect(classifyInboxFile({ folder: false, name: "transactions.xlsx", mimeType: "application/vnd.ms-excel", size: 20 }))
      .toMatchObject({ supported: true, format: "XLSX" });
    expect(classifyInboxFile({ folder: false, name: "transactions.csv", mimeType: "application/pdf", size: 20 }))
      .toMatchObject({ supported: false, code: "STORAGE_MIME_MISMATCH" });
    expect(classifyInboxFile({ folder: false, shortcut: true, name: "outside.csv", mimeType: "text/csv", size: 20 }))
      .toMatchObject({ supported: false, code: "STORAGE_SHORTCUT_SKIPPED" });
    expect(classifyInboxFile({ folder: false, name: "oversized.csv", mimeType: "text/csv", size: 2 * 1024 * 1024 + 1 }))
      .toMatchObject({ supported: false, code: "STORAGE_TOO_LARGE" });
    expect(classifyInboxFile({ folder: false, name: "invoice\u202Efdp.csv", mimeType: "text/csv", size: 20 }))
      .toMatchObject({ supported: false, code: "STORAGE_FILENAME_INVALID" });
  });

  it("detects supported text encodings and rejects binary or active-content spoofs", () => {
    expect(decodeStructuredText(Buffer.from("\ufeffa,b\r\n1,2", "utf8")).encoding).toBe("UTF-8-BOM");
    expect(decodeStructuredText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\tb", "utf16le")])).encoding).toBe("UTF-16LE");
    expect(() => validateInboxDocumentBytes("payload.csv", "text/csv", Buffer.from([0x4d, 0x5a, 0, 1]))).toThrow(/binary|match/);
    expect(() => validateInboxDocumentBytes("payload.txt", "text/plain", Buffer.from("<script>fetch('/')</script>"))).toThrow(/not match/);
    expect(() => validateInboxDocumentBytes("payload.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("not a zip"))).toThrow(/not match/);
    const malformedXls = Buffer.alloc(512);
    Buffer.from("d0cf11e0a1b11ae1", "hex").copy(malformedXls);
    expect(() => validateInboxDocumentBytes("payload.xls", "application/vnd.ms-excel", malformedXls)).toThrow(/malformed/);
  });

  it("preflights XLSX expansion limits and macro containers", () => {
    const macro = workbook("xlsm");
    expect(() => validateInboxDocumentBytes("macro.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", macro)).toThrow(/Macro-enabled/);

    const oversizedEntry = Buffer.from(workbook("xlsx"));
    const central = oversizedEntry.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    oversizedEntry.writeUInt32LE(9 * 1024 * 1024, central + 24);
    expect(() => validateInboxDocumentBytes("bomb.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", oversizedEntry)).toThrow(/expanded-content/);

    const externalLink = Buffer.from(workbook("xlsx"));
    const sheetName = Buffer.from("xl/worksheets/sheet1.xml");
    const externalName = Buffer.from("xl/externalLinks/abc.xml");
    expect(externalName).toHaveLength(sheetName.length);
    const sheetEntry = externalLink.indexOf(sheetName, externalLink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
    expect(sheetEntry).toBeGreaterThan(0);
    externalName.copy(externalLink, sheetEntry);
    expect(() => validateInboxDocumentBytes("linked.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", externalLink)).toThrow(/external links/);
  });
});

describe("structured inbox previews", () => {
  it("reports CSV structure, quoting, headers, row counts, encoding, and truncation", () => {
    const rows = ['Date,Description,Amount', '2026-09-01,"Coffee, client",4.50'];
    for (let index = 0; index < 30; index += 1) rows.push(`2026-09-02,Row ${index},1.00`);
    const bytes = Buffer.from(rows.join("\r\n"));
    validateInboxDocumentBytes("transactions.csv", "application/vnd.ms-excel", bytes);
    const result = structuredDocumentPreview(bytes, "CSV", "text/csv", 1);
    expect(result).toMatchObject({
      contentKind: "DELIMITED_TEXT",
      routingTarget: "BANKING_IMPORT_REVIEW",
      preview: {
        encoding: "UTF-8",
        delimiter: "COMMA",
        lineEnding: "CRLF",
        quoting: "RFC4180_DOUBLE_QUOTE",
        headers: ["Date", "Description", "Amount"],
        rowCount: 32,
        dataRowCount: 31,
        truncated: true,
      },
    });
    expect(result.preview.rows[1]).toEqual(["2026-09-01", "Coffee, client", "4.50"]);
    expect(() => structuredDocumentPreview(Buffer.from('a,b\n"unterminated'), "CSV", "text/csv", 1)).toThrow(/not terminated/);
  });

  it("reports TSV and plain-text previews deterministically", () => {
    const tsv = structuredDocumentPreview(Buffer.from("Date\tAmount\n2026-09-01\t5.25"), "TSV", "text/tab-separated-values", 1);
    expect(tsv.preview).toMatchObject({ delimiter: "TAB", rowCount: 2, headers: ["Date", "Amount"] });
    const text = structuredDocumentPreview(Buffer.from("Statement\nOpening balance"), "TEXT", "text/plain", 1);
    expect(text.preview).toMatchObject({ delimiter: "NONE", quoting: "NOT_APPLICABLE", rowCount: 2 });
  });

  it.each([
    ["XLSX", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1],
    ["XLS", "xls", "application/vnd.ms-excel", 0],
  ] as const)("previews multiple %s sheets without executing formulas or following links", (format, bookType, mimeType, expectedFormulas) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const bytes = workbook(bookType);
    validateInboxDocumentBytes(`transactions.${bookType}`, mimeType, bytes);
    const first = structuredDocumentPreview(bytes, format, mimeType, 1);
    if (first.contentKind !== "WORKBOOK") throw new Error("Expected a workbook preview.");
    expect(first).toMatchObject({
      contentKind: "WORKBOOK",
      pageCount: 2,
      routingTarget: "BANKING_IMPORT_REVIEW",
      preview: {
        sheetNames: ["Transactions", "Invoices"],
        sheetName: "Transactions",
        formulasOmitted: expectedFormulas,
        externalLinksOmitted: 1,
      },
    });
    expect(first.preview.rows[1][3]).toBe(expectedFormulas ? "[FORMULA OMITTED]" : "25");
    expect(JSON.stringify(first)).not.toContain("never.example");
    expect(fetcher).not.toHaveBeenCalled();

    const second = structuredDocumentPreview(bytes, format, mimeType, 2);
    if (second.contentKind !== "WORKBOOK") throw new Error("Expected a workbook preview.");
    expect(second.preview.sheetName).toBe("Invoices");
    expect(second.preview.rows[1][0]).toBe("INV-42");
    expect(() => structuredDocumentPreview(bytes, format, mimeType, 3)).toThrow(/worksheet/);
  });
});
