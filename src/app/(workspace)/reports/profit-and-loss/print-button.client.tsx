"use client";

export function MonthlyReportPrintButton() {
  return <button type="button" className="secondary-button" onClick={() => window.print()}>Print / Save PDF</button>;
}
