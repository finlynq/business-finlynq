import { z } from "zod";


const valuesSchema = z.record(z.string(), z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/));
const snapshotSchema = z.object({
  capturedAt: z.string().optional(), ledgerFingerprint: z.string().optional(),
  mappingVersion: z.number().optional(), refreshedFromFilingId: z.string().nullable().optional(),
  manualValues: valuesSchema.optional(),
  definition: z.object({ fields: z.array(z.object({ key: z.string(), kind: z.string() }).passthrough()) }).passthrough().optional(),
}).passthrough();

export function taxFilingSnapshot(snapshot: unknown, reportedValues: unknown, calculatedValues: unknown, mappedFieldKeys: readonly string[]) {
  const saved = snapshotSchema.parse(snapshot);
  // Older workpapers did not record whether a zero was supplied or defaulted.
  // Recover only known nonzero manual values and require review of that ambiguity.
  const calculated = valuesSchema.parse(calculatedValues);
  const legacyManual = Object.fromEntries((saved.definition?.fields ?? [])
    .filter((field) => field.kind === "MANUAL" && !mappedFieldKeys.includes(field.key)
      && calculated[field.key] !== undefined && !/^-?0(?:\.0+)?$/.test(calculated[field.key]!))
    .map((field) => [field.key, calculated[field.key]!]));
  return {
    capturedAt: saved.capturedAt, ledgerFingerprint: saved.ledgerFingerprint,
    mappingVersion: saved.mappingVersion, refreshedFromFilingId: saved.refreshedFromFilingId ?? null,
    reportedValues: valuesSchema.parse(reportedValues), manualValues: saved.manualValues ?? legacyManual,
    manualInputsNeedReview: saved.manualValues === undefined,
  };
}
