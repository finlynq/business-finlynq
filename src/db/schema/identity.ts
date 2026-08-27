import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    isDemo: boolean("is_demo").notNull().default(false),
    mode: text("organization_mode").notNull().default("REAL"),
    settingsVersion: integer("settings_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("organizations_slug_unique").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailLookupHash: text("email_lookup_hash").notNull(),
    emailCiphertext: text("email_ciphertext").notNull(),
    displayNameCiphertext: text("display_name_ciphertext"),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    isDemo: boolean("is_demo").notNull().default(false),
    mfaRequired: boolean("mfa_required").notNull().default(true),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_lookup_hash_unique").on(table.emailLookupHash)],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    administrationVersion: integer("administration_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_memberships_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    uniqueIndex("organization_memberships_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("organization_memberships_one_active_user_unique")
      .on(table.userId)
      .where(sql`${table.active}`),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    systemTemplate: boolean("system_template").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("roles_org_key_unique").on(table.organizationId, table.key),
    uniqueIndex("roles_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.roleId, table.permissionKey] })],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "restrict" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.membershipId, table.roleId] }),
    uniqueIndex("membership_roles_one_fixed_role_unique").on(
      table.organizationId,
      table.membershipId,
    ),
  ],
);

export const organizationKeyVersions = pgTable(
  "organization_key_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    keyProvider: text("key_provider").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("organization_key_versions_org_version_unique").on(
      table.organizationId,
      table.version,
    ),
    uniqueIndex("organization_key_versions_one_active_unique")
      .on(table.organizationId)
      .where(sql`${table.active}`),
  ],
);
