import { invoiceRenderFactsSchema, type InvoiceRenderFacts } from "./model";

export const INVOICE_PDF_TEMPLATE_VERSION = "business-finlynq-invoice-v1";

function pdfText(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
}

function wrap(value: string, width = 88): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function money(value: string, currency: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${currency} ${amount.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`
    : `${currency} ${value}`;
}

export function invoicePdfLines(unparsed: InvoiceRenderFacts): string[] {
  const facts = invoiceRenderFactsSchema.parse(unparsed);
  const lines = [
    facts.preview ? "PREVIEW - NOT ISSUED" : "TAX INVOICE",
    facts.organizationName,
    facts.legalEntityName,
    ...facts.legalEntityAddress,
    ...facts.taxRegistrations.map((value) => `Tax registration: ${value}`),
    "",
    `Invoice: ${facts.invoiceNumber}`,
    `Invoice date: ${facts.invoiceDate}`,
    ...(facts.dueDate ? [`Due date: ${facts.dueDate}`] : []),
    ...(facts.terms ? [`Terms: ${facts.terms}`] : []),
    ...(facts.purchaseOrder ? [`PO / reference: ${facts.purchaseOrder}`] : []),
    "",
    `Bill to: ${facts.customerName}`,
    ...facts.customerAddress,
    "",
    "Description | Qty | Unit price | Net | Tax | Total",
  ];
  for (const line of facts.lines) {
    const amounts = `${line.quantity} | ${money(line.unitPrice, facts.currency)} | ${money(line.netAmount, facts.currency)} | ${money(line.taxAmount, facts.currency)} | ${money(line.grossAmount, facts.currency)}`;
    const descriptions = wrap(line.description, 58);
    lines.push(`${descriptions[0]} | ${amounts}`, ...descriptions.slice(1).map((value) => `  ${value}`));
  }
  lines.push(
    "",
    `Net total: ${money(facts.netTotal, facts.currency)}`,
    `Tax total: ${money(facts.taxTotal, facts.currency)}`,
    `Amount due: ${money(facts.grossTotal, facts.currency)}`,
  );
  if (facts.paymentInstructions.length) lines.push("", "Payment instructions", ...facts.paymentInstructions.flatMap((value) => wrap(value)));
  if (facts.remittanceContact) lines.push(`Remittance contact: ${facts.remittanceContact}`);
  if (facts.notes) lines.push("", "Notes", ...wrap(facts.notes));
  return lines;
}

function contentStream(lines: readonly string[], page: number, pages: number): string {
  const commands = ["BT", "/F1 10 Tf", "48 752 Td", "13 TL"];
  lines.forEach((line, index) => {
    commands.push(`${index === 0 ? "" : "T* "}(${pdfText(line)}) Tj`);
  });
  commands.push("ET", "BT", "/F1 9 Tf", "270 28 Td", `(Page ${page} of ${pages}) Tj`, "ET");
  return commands.filter(Boolean).join("\n");
}

export function renderInvoicePdf(unparsed: InvoiceRenderFacts): Buffer {
  const lines = invoicePdfLines(unparsed);
  const pageLines: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += 50) pageLines.push(lines.slice(offset, offset + 50));
  const pageCount = Math.max(1, pageLines.length);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pageLines.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = contentStream(page, index + 1, pageCount);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let output = "%PDF-1.7\n%FinLynQ\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(output, "latin1");
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R /ID [<46696e4c796e51496e766f6963657631><46696e4c796e51496e766f6963657631>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}
