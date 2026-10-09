import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";

/** Immutable Markdown revisions. The newest revision of a path is its current file. */
export const organizationGuidanceFiles = pgTable("organization_guidance_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  path: text("path").notNull(),
  summary: text("summary").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  changedBy: uuid("changed_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  requestId: text("request_id").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("organization_guidance_path_version_unique").on(table.organizationId, table.path, table.version),
  index("organization_guidance_path_recent_idx").on(table.organizationId, table.path, table.version),
  check("organization_guidance_status_check", sql`${table.status} IN ('ACTIVE','RETIRED')`),
  check("organization_guidance_version_check", sql`${table.version} > 0`),
  check("organization_guidance_path_check", sql`length(${table.path}) BETWEEN 4 AND 120`),
  check("organization_guidance_content_check", sql`octet_length(${table.content}) <= 12000`),
]);

export const platformGuidanceFiles = pgTable("platform_guidance_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  path: text("path").notNull(),
  summary: text("summary").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  changedBy: uuid("changed_by").references(() => users.id, { onDelete: "restrict" }),
  requestId: text("request_id").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("platform_guidance_path_version_unique").on(table.path, table.version),
  index("platform_guidance_path_recent_idx").on(table.path, table.version),
  check("platform_guidance_status_check", sql`${table.status} IN ('ACTIVE','RETIRED')`),
  check("platform_guidance_version_check", sql`${table.version} > 0`),
  check("platform_guidance_path_check", sql`length(${table.path}) BETWEEN 4 AND 120`),
  check("platform_guidance_content_check", sql`octet_length(${table.content}) <= 12000`),
]);
