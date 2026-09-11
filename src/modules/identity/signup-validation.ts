import { z } from "zod";
import { supportedCurrencies } from "@/kernel/money";
import { isSignupRegion } from "./signup-policy";

export const ownerSignupDetailsSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(200),
  entityCode: z.string().trim().toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/)
    .refine((value) => value !== "0000"),
  entityName: z.string().trim().min(2).max(200),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  regionCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/),
  functionalCurrency: z.string().trim().toUpperCase().refine(
    (value) => supportedCurrencies.includes(value),
    "Choose a supported functional currency",
  ),
  accountingProfile: z.enum(["CAN_ASPE", "US_GAAP_NONPUBLIC"]),
  fiscalYear: z.number().int().min(2000).max(2200),
  manualPostingMode: z.enum(["REVIEW_REQUIRED", "AUTO_POST"]),
  termsAccepted: z.literal(true),
  challengeToken: z.string().max(2048).default(""),
}).superRefine((value, context) => {
  if (!isSignupRegion(value.countryCode, value.regionCode)) {
    context.addIssue({
      code: "custom",
      path: ["regionCode"],
      message: "Choose a valid state or province",
    });
  }
});
