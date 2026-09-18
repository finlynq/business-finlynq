import { z } from "zod";
import { exact, minorUnits, quantizeMoney, sumExact } from "@/kernel/money";

const decimalSchema = z.string().trim().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/);
const fieldKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const taxFilingFormulaSchema = z.object({
  operation: z.enum(["ADD", "SUBTRACT", "POSITIVE_PART", "NEGATIVE_PART"]),
  operands: z.array(fieldKeySchema).min(1).max(20),
}).strict();

export const taxFilingFieldSchema = z.object({
  key: fieldKeySchema,
  code: z.string().trim().min(1).max(20),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  kind: z.enum(["ACCOUNT", "MANUAL", "CALCULATED"]),
  valueType: z.literal("MONEY"),
  allowAccountMapping: z.boolean(),
  required: z.boolean(),
  reconcile: z.boolean(),
  defaultBalanceBasis: z.enum([
    "DEBITS",
    "CREDITS",
    "NET_DEBIT",
    "NET_CREDIT",
    "ABSOLUTE_NET",
  ]).optional(),
  formula: taxFilingFormulaSchema.optional(),
}).strict().superRefine((field, context) => {
  if ((field.kind === "CALCULATED") !== Boolean(field.formula)) {
    context.addIssue({
      code: "custom",
      message: "Calculated fields need a formula and non-calculated fields cannot define one",
      path: ["formula"],
    });
  }
  if (field.kind === "CALCULATED" && field.allowAccountMapping) {
    context.addIssue({
      code: "custom",
      message: "Calculated fields cannot be mapped",
      path: ["allowAccountMapping"],
    });
  }
  if (field.kind === "ACCOUNT" && !field.allowAccountMapping) {
    context.addIssue({
      code: "custom",
      message: "Account fields must allow account mapping",
      path: ["allowAccountMapping"],
    });
  }
  if (field.defaultBalanceBasis && !field.allowAccountMapping) {
    context.addIssue({
      code: "custom",
      message: "Only mappable fields can define a default balance basis",
      path: ["defaultBalanceBasis"],
    });
  }
});

const comparisonOperatorSchema = z.enum(["LT", "LTE", "EQ", "GTE", "GT"]);

const ruleBaseSchema = z.object({
  key: fieldKeySchema,
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  severity: z.enum(["WARNING", "ERROR"]),
  source: z.url(),
});

export const taxFilingValidationRuleSchema = z.discriminatedUnion("type", [
  ruleBaseSchema.extend({
    type: z.literal("PERCENTAGE_RANGE"),
    numeratorField: fieldKeySchema,
    denominatorField: fieldKeySchema,
    minimumRate: decimalSchema,
    maximumRate: decimalSchema,
  }).strict(),
  ruleBaseSchema.extend({
    type: z.literal("THRESHOLD"),
    field: fieldKeySchema,
    operator: comparisonOperatorSchema,
    threshold: decimalSchema,
  }).strict(),
  ruleBaseSchema.extend({
    type: z.literal("COMPARISON"),
    leftField: fieldKeySchema,
    operator: comparisonOperatorSchema,
    rightField: fieldKeySchema,
  }).strict(),
  ruleBaseSchema.extend({
    type: z.literal("ONE_OF_ZERO"),
    fields: z.array(fieldKeySchema).min(2).max(20),
  }).strict(),
]);

export const taxFilingTemplateDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  instructions: z.string().trim().min(1).max(2_000),
  reconciliationTolerance: decimalSchema,
  fields: z.array(taxFilingFieldSchema).min(1).max(200),
  validations: z.array(taxFilingValidationRuleSchema).max(200),
}).strict().superRefine((definition, context) => {
  const known = new Set<string>();
  for (const [index, field] of definition.fields.entries()) {
    if (known.has(field.key)) {
      context.addIssue({ code: "custom", message: "Field keys must be unique", path: ["fields", index, "key"] });
    }
    if (field.formula) {
      for (const operand of field.formula.operands) {
        if (!known.has(operand)) {
          context.addIssue({
            code: "custom",
            message: "Formula operands must reference an earlier field",
            path: ["fields", index, "formula", "operands"],
          });
        }
      }
    }
    known.add(field.key);
  }

  for (const [index, rule] of definition.validations.entries()) {
    const references = rule.type === "PERCENTAGE_RANGE"
      ? [rule.numeratorField, rule.denominatorField]
      : rule.type === "THRESHOLD"
        ? [rule.field]
        : rule.type === "COMPARISON"
          ? [rule.leftField, rule.rightField]
          : rule.fields;
    if (references.some((reference) => !known.has(reference))) {
      context.addIssue({
        code: "custom",
        message: "Validation rules must reference defined fields",
        path: ["validations", index],
      });
    }
  }
});

export type TaxFilingTemplateDefinition = z.infer<typeof taxFilingTemplateDefinitionSchema>;
export type TaxFilingField = z.infer<typeof taxFilingFieldSchema>;
export type TaxFilingValidationRule = z.infer<typeof taxFilingValidationRuleSchema>;
export type TaxMappingBalanceBasis = NonNullable<TaxFilingField["defaultBalanceBasis"]>;

export type TaxFilingValidationResult = Readonly<{
  ruleKey: string;
  label: string;
  description: string;
  severity: "WARNING" | "ERROR";
  status: "PASS" | "FAIL" | "SKIPPED";
  actual: string | null;
  expected: string;
  source: string;
}>;

export type TaxFieldReconciliation = Readonly<{
  fieldKey: string;
  code: string;
  label: string;
  calculatedValue: string;
  reportedValue: string | null;
  difference: string | null;
  status: "MATCHED" | "VARIANCE" | "NOT_REPORTED";
  source: "MAPPED_ACCOUNTS" | "MANUAL_INPUT" | "FORMULA";
}>;

export type TaxFilingEvaluation = Readonly<{
  calculatedValues: Readonly<Record<string, string>>;
  reconciliation: readonly TaxFieldReconciliation[];
  validations: readonly TaxFilingValidationResult[];
  varianceCount: number;
  failedValidationCount: number;
}>;

function compare(left: ReturnType<typeof exact>, operator: z.infer<typeof comparisonOperatorSchema>, right: ReturnType<typeof exact>): boolean {
  switch (operator) {
    case "LT": return left.lessThan(right);
    case "LTE": return left.lessThanOrEqualTo(right);
    case "EQ": return left.equals(right);
    case "GTE": return left.greaterThanOrEqualTo(right);
    case "GT": return left.greaterThan(right);
  }
}

function fixedMoney(value: ReturnType<typeof exact>, currency: string): string {
  return quantizeMoney(value, currency).toFixed(minorUnits(currency));
}

function formulaValue(
  field: TaxFilingField,
  values: Readonly<Record<string, string>>,
) {
  if (!field.formula) throw new Error(`Tax field ${field.key} has no formula`);
  const operands = field.formula.operands.map((key) => exact(values[key] ?? "0"));
  switch (field.formula.operation) {
    case "ADD":
      return sumExact(operands);
    case "SUBTRACT":
      if (operands.length < 2) throw new Error(`Tax field ${field.key} subtraction needs at least two operands`);
      return operands.slice(1).reduce((result, operand) => result.minus(operand), operands[0]);
    case "POSITIVE_PART":
      return operands[0].isPositive() ? operands[0] : exact(0);
    case "NEGATIVE_PART":
      return operands[0].isNegative() ? operands[0].abs() : exact(0);
  }
}

function validationResult(
  rule: TaxFilingValidationRule,
  values: Readonly<Record<string, string>>,
): TaxFilingValidationResult {
  const base = {
    ruleKey: rule.key,
    label: rule.label,
    description: rule.description,
    severity: rule.severity,
    source: rule.source,
  } as const;

  if (rule.type === "PERCENTAGE_RANGE") {
    const denominator = exact(values[rule.denominatorField] ?? "0");
    if (denominator.isZero()) {
      return { ...base, status: "SKIPPED", actual: null, expected: `${rule.minimumRate}–${rule.maximumRate}` };
    }
    const actual = exact(values[rule.numeratorField] ?? "0").div(denominator);
    const passed = actual.greaterThanOrEqualTo(rule.minimumRate) && actual.lessThanOrEqualTo(rule.maximumRate);
    return {
      ...base,
      status: passed ? "PASS" : "FAIL",
      actual: actual.toDecimalPlaces(6).toString(),
      expected: `${rule.minimumRate}–${rule.maximumRate}`,
    };
  }

  if (rule.type === "THRESHOLD") {
    const actual = exact(values[rule.field] ?? "0");
    return {
      ...base,
      status: compare(actual, rule.operator, exact(rule.threshold)) ? "PASS" : "FAIL",
      actual: actual.toString(),
      expected: `${rule.operator} ${rule.threshold}`,
    };
  }

  if (rule.type === "COMPARISON") {
    const left = exact(values[rule.leftField] ?? "0");
    const right = exact(values[rule.rightField] ?? "0");
    return {
      ...base,
      status: compare(left, rule.operator, right) ? "PASS" : "FAIL",
      actual: `${left.toString()} vs ${right.toString()}`,
      expected: rule.operator,
    };
  }

  const nonZero = rule.fields.filter((field) => !exact(values[field] ?? "0").isZero());
  return {
    ...base,
    status: nonZero.length <= 1 ? "PASS" : "FAIL",
    actual: nonZero.length ? nonZero.join(", ") : "none",
    expected: "at most one non-zero field",
  };
}

export function evaluateTaxFilingTemplate(input: Readonly<{
  definition: TaxFilingTemplateDefinition;
  currency: string;
  mappedValues?: Readonly<Record<string, string>>;
  manualValues?: Readonly<Record<string, string>>;
  reportedValues?: Readonly<Record<string, string>>;
}>): TaxFilingEvaluation {
  const definition = taxFilingTemplateDefinitionSchema.parse(input.definition);
  const fieldsByKey = new Map(definition.fields.map((field) => [field.key, field]));
  for (const collection of [input.mappedValues, input.manualValues, input.reportedValues]) {
    for (const key of Object.keys(collection ?? {})) {
      if (!fieldsByKey.has(key)) throw new Error(`Unknown tax template field: ${key}`);
    }
  }
  for (const key of Object.keys(input.mappedValues ?? {})) {
    if (!fieldsByKey.get(key)?.allowAccountMapping) {
      throw new Error(`Tax template field does not accept mapped values: ${key}`);
    }
  }
  for (const key of Object.keys(input.manualValues ?? {})) {
    if (fieldsByKey.get(key)?.kind !== "MANUAL") {
      throw new Error(`Tax template field does not accept manual values: ${key}`);
    }
  }

  const calculatedValues: Record<string, string> = {};
  for (const field of definition.fields) {
    const hasMappedValue = Object.hasOwn(input.mappedValues ?? {}, field.key);
    const raw = field.kind === "CALCULATED"
      ? formulaValue(field, calculatedValues)
      : field.kind === "ACCOUNT" || hasMappedValue
        ? exact(input.mappedValues?.[field.key] ?? "0")
        : exact(input.manualValues?.[field.key] ?? "0");
    calculatedValues[field.key] = fixedMoney(raw, input.currency);
  }

  const tolerance = exact(definition.reconciliationTolerance);
  const reconciliation = definition.fields
    .filter((field) => field.reconcile)
    .map<TaxFieldReconciliation>((field) => {
      const calculatedValue = calculatedValues[field.key];
      const rawReported = input.reportedValues?.[field.key];
      const source = field.kind === "CALCULATED" ? "FORMULA"
        : field.kind === "ACCOUNT" || Object.hasOwn(input.mappedValues ?? {}, field.key)
          ? "MAPPED_ACCOUNTS"
          : "MANUAL_INPUT";
      if (rawReported === undefined) {
        return {
          fieldKey: field.key,
          code: field.code,
          label: field.label,
          calculatedValue,
          reportedValue: null,
          difference: null,
          status: "NOT_REPORTED",
          source,
        };
      }
      const reportedValue = fixedMoney(exact(rawReported), input.currency);
      const difference = quantizeMoney(exact(reportedValue).minus(calculatedValue), input.currency);
      return {
        fieldKey: field.key,
        code: field.code,
        label: field.label,
        calculatedValue,
        reportedValue,
        difference: difference.toFixed(minorUnits(input.currency)),
        status: difference.abs().lessThanOrEqualTo(tolerance) ? "MATCHED" : "VARIANCE",
        source,
      };
    });

  const validations = definition.validations.map((rule) => validationResult(rule, calculatedValues));
  return {
    calculatedValues,
    reconciliation,
    validations,
    varianceCount: reconciliation.filter((field) => field.status === "VARIANCE").length,
    failedValidationCount: validations.filter((rule) => rule.status === "FAIL").length,
  };
}
