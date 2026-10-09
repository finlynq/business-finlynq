import { z } from "zod";

export const GUIDANCE_MAX_TOKENS = 3_000;
export const GUIDANCE_MAX_BYTES = 12_000;
export const GUIDANCE_MAX_FILES_PER_SCOPE = 100;

export const guidancePathSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9][a-z0-9/_-]*\.md$/, "Use a lowercase relative .md path")
  .refine((path) => !path.split("/").some((part) => part === ".." || part === "." || part.length === 0),
    "Path segments must be nonempty and cannot traverse directories");

export const guidanceContentSchema = z.string().min(1).max(GUIDANCE_MAX_BYTES);
export const guidanceSummarySchema = z.string().trim().min(1).max(240);

/** A portable estimate, paired with a strict UTF-8 byte ceiling. */
export function guidanceTokenBudget(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  return Math.max(Math.ceil(bytes / 3), content.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0);
}

export function assertGuidanceSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > GUIDANCE_MAX_BYTES ||
      guidanceTokenBudget(content) > GUIDANCE_MAX_TOKENS) {
    throw Object.assign(new Error("Guidance files are limited to 3,000 estimated tokens and 12,000 UTF-8 bytes; split this content into referenced files"),
      { code: "GUIDANCE_FILE_TOO_LARGE" });
  }
}

export const saveGuidanceFileSchema = z.object({
  path: guidancePathSchema,
  summary: guidanceSummarySchema,
  content: guidanceContentSchema,
  expectedVersion: z.number().int().min(0),
}).strict();

export const retireGuidanceFileSchema = z.object({
  path: guidancePathSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
