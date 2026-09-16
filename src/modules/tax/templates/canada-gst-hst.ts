import type { TaxFilingTemplateDefinition } from "../filing-template";

export const CANADA_GST_HST_TEMPLATE_KEY = "ca.gst-hst.return";
export const CANADA_GST_HST_TEMPLATE_VERSION = 1;
export const CANADA_GST_HST_SOURCE =
  "https://www.canada.ca/content/dam/cra-arc/migration/cra-arc/tx/bsnss/tpcs/gst-tps/bspsbch/rtrns/wrkngcp-eng.pdf";
export const CANADA_GST_HST_REGISTRATION_SOURCE =
  "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html";
export const CANADA_GST_HST_RATE_SOURCE =
  "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html";

export const canadaGstHstTemplate: TaxFilingTemplateDefinition = {
  schemaVersion: 1,
  instructions: "Prepare or reconcile a GST/HST return workpaper. Account mappings are organization- and ledger-specific. Review CRA instructions and supporting evidence before filing; this template does not submit a return to CRA.",
  reconciliationTolerance: "0.01",
  fields: [
    { key: "line_101", code: "101", label: "Sales and other revenue", description: "Total revenue for the reporting period, excluding GST/HST.", kind: "ACCOUNT", valueType: "MONEY", allowAccountMapping: true, required: true, reconcile: true, defaultBalanceBasis: "NET_CREDIT" },
    { key: "line_103", code: "103", label: "GST/HST collected or collectible", description: "GST/HST collected or collectible for the reporting period.", kind: "ACCOUNT", valueType: "MONEY", allowAccountMapping: true, required: true, reconcile: true, defaultBalanceBasis: "NET_CREDIT" },
    { key: "line_104", code: "104", label: "Adjustments added to net tax", description: "Adjustments that increase net tax for the reporting period.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_105", code: "105", label: "Total GST/HST and adjustments", description: "Line 103 plus line 104.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "ADD", operands: ["line_103", "line_104"] } },
    { key: "line_106", code: "106", label: "Input tax credits", description: "Eligible GST/HST paid or payable on qualifying expenses.", kind: "ACCOUNT", valueType: "MONEY", allowAccountMapping: true, required: true, reconcile: true, defaultBalanceBasis: "NET_DEBIT" },
    { key: "line_107", code: "107", label: "Adjustments deducted from net tax", description: "Adjustments deducted when determining net tax.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_108", code: "108", label: "Total ITCs and adjustments", description: "Line 106 plus line 107.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "ADD", operands: ["line_106", "line_107"] } },
    { key: "line_109", code: "109", label: "Net tax", description: "Line 105 less line 108.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "SUBTRACT", operands: ["line_105", "line_108"] } },
    { key: "line_110", code: "110", label: "Instalments and other annual filer payments", description: "Instalments and other annual filer payments made for the reporting period.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_111", code: "111", label: "Rebates", description: "Eligible GST/HST rebates supported by the applicable rebate form.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_112", code: "112", label: "Total other credits", description: "Line 110 plus line 111.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "ADD", operands: ["line_110", "line_111"] } },
    { key: "line_113a", code: "113 A", label: "Balance before other debits", description: "Line 109 less line 112.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "SUBTRACT", operands: ["line_109", "line_112"] } },
    { key: "line_205", code: "205", label: "Tax due on real property or emission allowances", description: "GST/HST due on qualifying purchases of real property or emission allowances.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_405", code: "405", label: "Other GST/HST to self-assess", description: "Other GST/HST that must be self-assessed.", kind: "MANUAL", valueType: "MONEY", allowAccountMapping: false, required: false, reconcile: true },
    { key: "line_113b", code: "113 B", label: "Total other debits", description: "Line 205 plus line 405.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "ADD", operands: ["line_205", "line_405"] } },
    { key: "line_113c", code: "113 C", label: "Final balance", description: "Line 113 A plus line 113 B.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "ADD", operands: ["line_113a", "line_113b"] } },
    { key: "line_114", code: "114", label: "Refund claimed", description: "Absolute value of a negative line 113 C balance.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "NEGATIVE_PART", operands: ["line_113c"] } },
    { key: "line_115", code: "115", label: "Payment due", description: "Positive line 113 C balance.", kind: "CALCULATED", valueType: "MONEY", allowAccountMapping: false, required: true, reconcile: true, formula: { operation: "POSITIVE_PART", operands: ["line_113c"] } },
  ],
  validations: [
    {
      key: "collected_rate_range",
      type: "PERCENTAGE_RANGE",
      label: "Collected tax percentage",
      description: "Collected tax should not be negative or exceed the current highest general GST/HST rate. Mixed, zero-rated, exempt, and place-of-supply transactions can make the effective rate lower.",
      severity: "WARNING",
      numeratorField: "line_103",
      denominatorField: "line_101",
      minimumRate: "0",
      maximumRate: "0.15",
      source: CANADA_GST_HST_RATE_SOURCE,
    },
    {
      key: "small_supplier_review",
      type: "THRESHOLD",
      label: "Small-supplier threshold review",
      description: "Review registration status when mapped taxable revenue exceeds CAD 30,000. The legal test considers a single quarter and up to four consecutive calendar quarters, associated persons, and exclusions; this warning is not the legal determination.",
      severity: "WARNING",
      field: "line_101",
      operator: "LTE",
      threshold: "30000",
      source: CANADA_GST_HST_REGISTRATION_SOURCE,
    },
    {
      key: "refund_or_payment",
      type: "ONE_OF_ZERO",
      label: "Refund/payment exclusivity",
      description: "A return cannot have both a refund claimed and a payment due.",
      severity: "ERROR",
      fields: ["line_114", "line_115"],
      source: CANADA_GST_HST_SOURCE,
    },
  ],
};
