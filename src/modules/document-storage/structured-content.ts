import "server-only";

import { read, utils, type CellObject, type WorkSheet } from "xlsx";
import { StorageError } from "./provider";
import { decodeStructuredText, type InboxDocumentFormat } from "./file-types";

const PREVIEW_ROWS = 25;
const PREVIEW_COLUMNS = 20;
const PREVIEW_CELL_CHARACTERS = 256;
const MAX_WORKBOOK_SHEETS = 100;

function lineEnding(text: string) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replaceAll("\r\n", "");
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  return kinds > 1 ? "MIXED" : crlf ? "CRLF" : lf ? "LF" : cr ? "CR" : "NONE";
}

function delimiterLabel(delimiter: string | null) {
  return delimiter === "," ? "COMMA" : delimiter === "\t" ? "TAB" : delimiter === ";" ? "SEMICOLON" : delimiter === "|" ? "PIPE" : "NONE";
}

function delimiterScore(text: string, delimiter: string) {
  const counts: number[] = [];
  let count = 0;
  let quoted = false;
  for (let index = 0; index < Math.min(text.length, 64 * 1024) && counts.length < 20; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) count += 1;
    else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      if (count > 0 || counts.length > 0) counts.push(count);
      count = 0;
    }
  }
  if (count > 0) counts.push(count);
  const positive = counts.filter((value) => value > 0);
  if (!positive.length) return 0;
  const common = positive.reduce((result, value) => {
    const frequency = positive.filter((candidate) => candidate === value).length;
    return frequency > result.frequency ? { value, frequency } : result;
  }, { value: 0, frequency: 0 });
  return common.frequency * 1000 + common.value;
}

function detectDelimiter(text: string, format: InboxDocumentFormat) {
  if (format === "TEXT") return null;
  if (format === "TSV") return "\t";
  const candidates = [",", "\t", ";", "|"];
  return candidates.reduce((selected, candidate) => delimiterScore(text, candidate) > delimiterScore(text, selected) ? candidate : selected, ",");
}

function previewValue(value: string) {
  if (value.length <= PREVIEW_CELL_CHARACTERS) return { value, truncated: false };
  return { value: value.slice(0, PREVIEW_CELL_CHARACTERS), truncated: true };
}

function parseDelimitedPreview(text: string, delimiter: string) {
  const previewRows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;
  let quotedFields = 0;
  let rowCount = 0;
  let maximumColumns = 0;
  let currentColumns = 0;
  let truncatedCells = 0;

  const commitField = () => {
    const preview = previewValue(field);
    if (preview.truncated) truncatedCells += 1;
    if (rowCount < PREVIEW_ROWS && currentColumns < PREVIEW_COLUMNS) row.push(preview.value);
    currentColumns += 1;
    field = "";
    closedQuote = false;
  };
  const commitRow = () => {
    commitField();
    maximumColumns = Math.max(maximumColumns, currentColumns);
    if (rowCount < PREVIEW_ROWS) previewRows.push(row);
    row = [];
    currentColumns = 0;
    rowCount += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { inQuotes = false; closedQuote = true; }
      else field += character;
      continue;
    }
    if (closedQuote && character !== delimiter && character !== "\r" && character !== "\n") {
      throw new StorageError("STORAGE_TEXT_MALFORMED", "A quoted field contains characters after its closing quote.");
    }
    if (character === '"') {
      if (field.length > 0) throw new StorageError("STORAGE_TEXT_MALFORMED", "A quote appears inside an unquoted field.");
      inQuotes = true;
      quotedFields += 1;
    } else if (character === delimiter) commitField();
    else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      commitRow();
    } else field += character;
  }
  if (inQuotes) throw new StorageError("STORAGE_TEXT_MALFORMED", "The final quoted field is not terminated.");
  if (field.length > 0 || row.length > 0 || !/[\r\n]$/.test(text)) commitRow();

  return {
    rows: previewRows,
    rowCount,
    dataRowCount: Math.max(0, rowCount - 1),
    maximumColumns,
    headers: previewRows[0] ?? [],
    quoting: quotedFields ? "RFC4180_DOUBLE_QUOTE" : "NONE",
    quotedFields,
    truncated: rowCount > PREVIEW_ROWS || maximumColumns > PREVIEW_COLUMNS || truncatedCells > 0,
    truncation: {
      rowLimit: PREVIEW_ROWS,
      columnLimit: PREVIEW_COLUMNS,
      cellCharacterLimit: PREVIEW_CELL_CHARACTERS,
      rowsOmitted: Math.max(0, rowCount - PREVIEW_ROWS),
      columnsOmitted: Math.max(0, maximumColumns - PREVIEW_COLUMNS),
      cellsTruncated: truncatedCells,
    },
  };
}

function plainTextPreview(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  let truncatedCells = 0;
  const rows = lines.slice(0, PREVIEW_ROWS).map((line) => {
    const value = previewValue(line);
    if (value.truncated) truncatedCells += 1;
    return [value.value];
  });
  return {
    rows,
    rowCount: lines.length,
    dataRowCount: Math.max(0, lines.length - 1),
    maximumColumns: 1,
    headers: rows[0] ?? [],
    quoting: "NOT_APPLICABLE",
    quotedFields: 0,
    truncated: lines.length > PREVIEW_ROWS || truncatedCells > 0,
    truncation: {
      rowLimit: PREVIEW_ROWS,
      columnLimit: 1,
      cellCharacterLimit: PREVIEW_CELL_CHARACTERS,
      rowsOmitted: Math.max(0, lines.length - PREVIEW_ROWS),
      columnsOmitted: 0,
      cellsTruncated: truncatedCells,
    },
  };
}

function textPreview(bytes: Buffer, format: InboxDocumentFormat, canonicalMimeType: string) {
  const decoded = decodeStructuredText(bytes);
  const delimiter = detectDelimiter(decoded.text, format);
  const parsed = delimiter ? parseDelimitedPreview(decoded.text, delimiter) : plainTextPreview(decoded.text);
  return {
    contentKind: "DELIMITED_TEXT" as const,
    mimeType: canonicalMimeType,
    pageCount: 1,
    text: parsed.rows.map((row) => row.join("\t")).join("\n"),
    preview: {
      kind: format,
      encoding: decoded.encoding,
      delimiter: delimiterLabel(delimiter),
      lineEnding: lineEnding(decoded.text),
      ...parsed,
    },
    routingTarget: "BANKING_IMPORT_REVIEW" as const,
  };
}

function fullRange(sheet: WorkSheet) {
  const reference = String(sheet["!fullref"] ?? sheet["!ref"] ?? "");
  if (!reference) return { rows: 0, columns: 0 };
  try {
    const range = utils.decode_range(reference);
    return { rows: range.e.r + 1, columns: range.e.c + 1 };
  } catch {
    throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "A worksheet contains an invalid cell range.");
  }
}

function workbookCell(cell: CellObject | undefined) {
  if (!cell) return { value: "", formula: false, externalLink: false, truncated: false };
  const formula = typeof cell.f === "string" || typeof cell.F === "string";
  const externalLink = Boolean(cell.l && typeof cell.l.Target === "string");
  if (formula) return { value: "[FORMULA OMITTED]", formula: true, externalLink, truncated: false };
  let raw = "";
  if (cell.t === "b") raw = cell.v ? "TRUE" : "FALSE";
  else if (cell.t === "e") raw = "#ERROR";
  else if (cell.v !== undefined && cell.v !== null) raw = String(cell.w ?? cell.v);
  const preview = previewValue(raw);
  return { ...preview, formula: false, externalLink };
}

function workbookPreview(bytes: Buffer, format: "XLS" | "XLSX", canonicalMimeType: string, page: number) {
  try {
    const metadata = read(bytes, { type: "buffer", bookSheets: true, bookProps: true, bookDeps: false, bookFiles: false, bookVBA: false, WTF: false });
    const sheetNames = metadata.SheetNames;
    if (!sheetNames.length) throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The workbook contains no worksheets.");
    if (sheetNames.length > MAX_WORKBOOK_SHEETS) throw new StorageError("STORAGE_WORKBOOK_LIMIT", `Workbooks may contain at most ${MAX_WORKBOOK_SHEETS} worksheets.`);
    if (page > sheetNames.length) throw new StorageError("STORAGE_PAGE_INVALID", "This workbook does not contain that worksheet.");
    const sheetName = sheetNames[page - 1];
    const workbook = read(bytes, {
      type: "buffer",
      sheets: [sheetName],
      sheetRows: PREVIEW_ROWS + 1,
      dense: true,
      cellFormula: true,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      cellText: true,
      cellDates: false,
      bookDeps: false,
      bookFiles: false,
      bookVBA: true,
      WTF: false,
      UTC: true,
    });
    if (workbook.vbaraw) throw new StorageError("STORAGE_WORKBOOK_UNSAFE", "Macro-enabled workbooks are not accepted. Save a values-only workbook.");
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The selected worksheet is missing.");
    const size = fullRange(sheet);
    const data = sheet["!data"] ?? [];
    const rows: string[][] = [];
    let formulasOmitted = 0;
    let externalLinksOmitted = 0;
    let cellsTruncated = 0;
    const rowLimit = Math.min(PREVIEW_ROWS, size.rows);
    const columnLimit = Math.min(PREVIEW_COLUMNS, size.columns);
    for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
      const row: string[] = [];
      for (let columnIndex = 0; columnIndex < columnLimit; columnIndex += 1) {
        const value = workbookCell(data[rowIndex]?.[columnIndex]);
        row.push(value.value);
        if (value.formula) formulasOmitted += 1;
        if (value.externalLink) externalLinksOmitted += 1;
        if (value.truncated) cellsTruncated += 1;
      }
      rows.push(row);
    }
    return {
      contentKind: "WORKBOOK" as const,
      mimeType: canonicalMimeType,
      pageCount: sheetNames.length,
      text: rows.map((row) => row.join("\t")).join("\n"),
      preview: {
        kind: format,
        sheetNames,
        sheetName,
        sheetIndex: page,
        rowCount: size.rows,
        columnCount: size.columns,
        rows,
        formulasOmitted,
        externalLinksOmitted,
        truncated: size.rows > PREVIEW_ROWS || size.columns > PREVIEW_COLUMNS || cellsTruncated > 0,
        truncation: {
          rowLimit: PREVIEW_ROWS,
          columnLimit: PREVIEW_COLUMNS,
          cellCharacterLimit: PREVIEW_CELL_CHARACTERS,
          rowsOmitted: Math.max(0, size.rows - PREVIEW_ROWS),
          columnsOmitted: Math.max(0, size.columns - PREVIEW_COLUMNS),
          cellsTruncated,
        },
      },
      routingTarget: "BANKING_IMPORT_REVIEW" as const,
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The workbook is malformed, encrypted, or uses an unsupported Excel feature.");
  }
}

export function structuredDocumentPreview(bytes: Buffer, format: InboxDocumentFormat, canonicalMimeType: string, page: number) {
  if (["CSV", "TSV", "TEXT"].includes(format)) {
    if (page !== 1) throw new StorageError("STORAGE_PAGE_INVALID", "Text documents have one preview page.");
    return textPreview(bytes, format, canonicalMimeType);
  }
  if (format === "XLS" || format === "XLSX") return workbookPreview(bytes, format, canonicalMimeType, page);
  throw new StorageError("STORAGE_TYPE_MISMATCH", "This document is not a structured text or workbook file.");
}
