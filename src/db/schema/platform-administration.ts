import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * Control-plane authorization is intentionally independent of tenant roles.
 * The blind index permits a grant to be reserved before signup without
 * exposing the email address. A grant is effective only after linkedUserId is
 * populated by the database identity-assurance checks.
 */
export const platformAdministratorGrants = pgTable(
  "platform_administrator_grants",
  {
    id: uuid("id").primaryKey(),
    emailLookupHash: text("email_lookup_hash").notNull(),
    emailCiphertext: text("email_ciphertext").notNull(),
    roleKey: text("role_key").notNull().default("PLATFORM_ADMINISTRATOR"),
    status: text("status").notNull().default("GRANTED"),
    linkedUserId: uuid("linked_user_id").references(() => users.id, { onDelete: "restrict" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    grantedBy: text("granted_by").notNull(),
    grantReason: text("grant_reason").notNull(),
    grantRequestId: text("grant_request_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedBy: text("revoked_by"),
    revocationReason: text("revocation_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("platform_administrator_grants_email_unique").on(table.emailLookupHash),
    uniqueIndex("platform_administrator_grants_linked_user_unique")
      .on(table.linkedUserId)
      .where(sql`${table.linkedUserId} IS NOT NULL`),
  ],
);

export const platformAdministratorGrantEvents = pgTable(
  "platform_administrator_grant_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id").notNull().references(() => platformAdministratorGrants.id, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id").references(() => users.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    requestId: text("request_id").notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_administrator_grant_events_grant_created_idx").on(table.grantId, table.createdAt),
  ],
);
