import { readdir, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultMetaDirectory = join(repositoryRoot, "migrations", "drizzle", "meta");
const defaultMigrationDirectory = join(repositoryRoot, "migrations", "drizzle");
const runtimeRoleName = "business_finlynq_app";
const ownerOnlyRlsTables = new Set([
  "audit_outbox_pair_contract",
  "auth_email_outbox",
  "auth_one_time_tokens",
  "auth_organization_signups",
  "auth_recovery_requests",
  "auth_security_events",
  "auth_sessions",
  "demo_daily_claims",
  "demo_sandbox_slots",
  "shared_demo_reset_state",
]);
const userBoundRlsTables = new Set([
  "mcp_access_tokens",
  "mcp_approvals",
  "mcp_connections",
  "mcp_oauth_codes",
  "mcp_refresh_tokens",
  "mcp_tool_executions",
]);
// These policies existed before 0025 completed the FORCE RLS contract. Their
// names are part of the reviewed historical database contract, so do not
// silently normalize them to the generic tenant_isolation convention.
const preservedTenantRlsPolicyNames = new Map([
  ["ledger_posting_policies", "tenant_isolation"],
  ["organization_invitations", "organization_invitations_tenant_policy"],
]);

// This is the direct table/view ACL contract reconciled by
// deploy/postgres/010-runtime-role.sh. Keep both allowlists in the same change:
// this verifier intentionally fails if the database and reviewed reconciler
// disagree. Relations absent here must have no direct or effective grants to
// the app role, and PUBLIC/role-membership privilege paths are always rejected.
const runtimeSelectRelations = [
  "organizations", "organization_memberships", "roles", "membership_roles",
  "role_permissions", "permissions", "organization_key_versions",
  "legal_entities", "ledgers", "currency_definitions",
  "organization_currencies", "currency_exchange_rates", "fiscal_periods",
  "period_events", "ledger_number_sequences", "ledger_posting_policies",
  "gl_accounts", "segment_definitions", "segment_values",
  "account_combinations", "accounting_hierarchies",
  "accounting_hierarchy_nodes", "journal_type_definitions",
  "source_documents", "journal_entries", "journal_approvals", "journal_lines",
  "journal_entry_relations", "parties", "party_addresses", "party_accounts",
  "subledger_events", "open_items", "document_settlement_allocations",
  "open_item_void_events", "open_item_balances", "tax_pack_versions",
  "entity_tax_registrations", "tax_determination_snapshots",
  "bank_connections", "bank_connection_credential_events",
  "bank_external_accounts", "bank_sync_runs", "bank_observations",
  "bank_observation_versions", "bank_balance_anchors",
  "bank_reconciliation_sessions", "bank_reconciliation_voids",
  "bank_match_allocations", "bank_match_allocation_voids", "bank_rules",
  "bank_rule_runs", "bank_draft_proposals", "mcp_oauth_clients",
  "mcp_connections", "mcp_oauth_codes", "mcp_access_tokens",
  "mcp_refresh_tokens", "mcp_approvals", "mcp_tool_executions",
];
const runtimeInsertUpdateRelations = [
  "journal_entries", "journal_lines", "parties", "party_addresses",
  "party_accounts", "gl_accounts", "ledger_posting_policies", "ledger_number_sequences",
  "bank_connections", "bank_external_accounts", "bank_sync_runs",
  "bank_reconciliation_sessions", "mcp_connections", "mcp_oauth_codes",
  "mcp_access_tokens", "mcp_refresh_tokens", "mcp_approvals",
  "mcp_tool_executions",
];
const runtimeInsertRelations = [
  "journal_approvals", "journal_entry_relations", "source_documents",
  "subledger_events", "open_items", "document_settlement_allocations",
  "open_item_void_events", "tax_determination_snapshots",
  "bank_connection_credential_events", "bank_observations",
  "bank_observation_versions", "bank_balance_anchors",
  "bank_reconciliation_voids", "bank_match_allocations",
  "bank_match_allocation_voids", "bank_rules", "bank_rule_runs",
  "bank_draft_proposals", "mcp_oauth_clients",
];
const runtimeExecuteFunctions = [
  "public.digest(bytea, text)",
  "public.digest(text, text)",
  "app.current_organization_id()",
  "app.current_actor_id()",
  "app.current_actor_has_permission(text)",
  "app.mcp_user_is_active(uuid)",
  "app.segment_value_is_valid(uuid, uuid, text, date)",
  "app.currency_minor_units(text)",
  "app.current_demo_session_is_valid()",
  "app.assert_current_demo_session_lease()",
  "app.allocate_journal_number(uuid, uuid, text)",
  "app.compute_journal_content_hash(uuid)",
  "app.install_initial_organization_key(text, text)",
  "app.accounting_set_currency_enabled(text, boolean)",
  "app.accounting_add_currency_rate(text, text, numeric, timestamp with time zone, text)",
  "app.accounting_add_tax_registration(uuid, uuid, text, text, integer, text, text, text, text, text, date, date)",
  "app.accounting_configure_segment(text, text, boolean, boolean, text)",
  "app.accounting_add_segment_value(text, text, text, date, date)",
  "app.accounting_create_account_combination(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid)",
  "app.accounting_create_legal_entity(text, text, text, text, text, accounting_profile, integer, manual_posting_mode)",
  "app.accounting_create_hierarchy_draft(text, uuid, text, text, uuid)",
  "app.accounting_replace_hierarchy_draft(uuid, integer, jsonb)",
  "app.accounting_publish_hierarchy(uuid, integer, date)",
  "app.auth_consume_rate_limit(text, text, integer, integer)",
  "app.auth_lookup_login(text)",
  "app.auth_lookup_login_v2(text)",
  "app.auth_issue_demo_session(text, text, text, text, text, text)",
  "app.auth_demo_session_lease_valid(uuid)",
  "app.auth_mark_demo_step_up(uuid, text)",
  "app.shared_demo_operations_state()",
  "app.auth_issue_mfa_user_session(uuid, uuid, uuid, uuid, bigint, text, text, text, text)",
  "app.auth_issue_password_user_session(uuid, uuid, uuid, text, text, text, text)",
  "app.auth_resolve_session(text, text)",
  "app.auth_resolve_session_v2(text, text)",
  "app.auth_resolve_session_v3(text, text)",
  "app.auth_platform_administrator_authorization(uuid, uuid)",
  "app.platform_administration_overview(uuid, uuid)",
  "app.auth_revoke_session(text, text)",
  "app.auth_queue_password_reset(text, text, text, uuid, text, text)",
  "app.auth_finish_password_reset(text, text, text)",
  "app.auth_record_login_failure(text)",
  "app.auth_password_reset_challenge(text)",
  "app.auth_prepare_recovery_mfa(text, uuid, text, text)",
  "app.auth_authorize_password_reset_totp(text, uuid, bigint, text)",
  "app.auth_finish_password_reset_with_mfa(text, text, uuid, bigint, text)",
  "app.auth_escalate_password_reset(text, text)",
  "app.auth_approve_recovery(uuid, uuid, uuid, bigint, text)",
  "app.auth_accept_invitation(text, text, uuid, text, text, text)",
  "app.auth_begin_organization_signup(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, accounting_profile, integer, manual_posting_mode, text, text, text, text, uuid, text, text, text)",
  "app.auth_consume_signup_accept_limits(text)",
  "app.auth_accept_organization_signup(text, text, uuid, text, text, text)",
  "app.auth_mfa_setup_challenge(text)",
  "app.auth_finish_mfa_enrollment(text, uuid, bigint, text)",
  "app.auth_skip_mfa_enrollment(text, text)",
  "app.auth_mfa_status_for_session(uuid)",
  "app.auth_begin_session_mfa_enrollment(uuid, uuid, text, text, text)",
  "app.auth_finish_session_mfa_enrollment(uuid, text, uuid, bigint, text, text)",
  "app.auth_password_for_session(uuid)",
  "app.auth_record_session_reauthentication_failure(uuid, text)",
  "app.auth_totp_for_session(uuid)",
  "app.auth_mark_step_up(uuid, uuid, bigint, text)",
  "app.auth_email_delivery_readiness(integer)",
  "app.operations_metrics()",
  "app.auth_consume_mfa_step_up_limits(uuid)",
  "app.auth_consume_password_reset_limits(text)",
  "app.auth_consume_password_reset_escalation_limits(text)",
  "app.auth_consume_recovery_approval_limits(uuid, uuid)",
  "app.auth_consume_mfa_enrollment_limits(text)",
  "app.organization_settings_read()",
  "app.organization_members_read()",
  "app.organization_update_settings(text, integer)",
  "app.organization_invite_member(uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text)",
  "app.organization_resend_invitation(uuid, integer, uuid, text, uuid, text)",
  "app.organization_cancel_invitation(uuid, integer)",
  "app.organization_assign_member_role(uuid, uuid, integer)",
  "app.organization_set_member_active(uuid, integer, boolean)",
  "app.organization_revoke_member_sessions(uuid)",
];
const universallyUnsafeTablePrivileges = new Set([
  "DELETE", "REFERENCES", "TRIGGER", "TRUNCATE",
]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

async function readJson(path, label) {
  let serialized;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} is missing at ${path}`);
    }
    throw error;
  }

  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${label} is not valid JSON at ${path}`);
  }
}

export async function loadLatestJournalSnapshot(metaDirectory = defaultMetaDirectory) {
  const journalPath = join(metaDirectory, "_journal.json");
  const journal = record(await readJson(journalPath, "Drizzle migration journal"), "Drizzle migration journal");
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error(`Drizzle migration journal has no entries at ${journalPath}`);
  }

  const entries = journal.entries.map((entry, position) => {
    const selected = record(entry, `Drizzle journal entry ${position}`);
    if (!Number.isInteger(selected.idx) || typeof selected.tag !== "string" || !selected.tag) {
      throw new Error(`Drizzle journal entry ${position} needs an integer idx and non-empty tag`);
    }
    return selected;
  });
  const latestEntry = entries.reduce((latest, entry) => entry.idx > latest.idx ? entry : latest);
  const separator = latestEntry.tag.indexOf("_");
  if (separator <= 0) {
    throw new Error(`Latest Drizzle journal tag cannot identify its snapshot prefix: ${latestEntry.tag}`);
  }

  const snapshotPrefix = latestEntry.tag.slice(0, separator);
  const snapshotPath = join(metaDirectory, `${snapshotPrefix}_snapshot.json`);
  let snapshot;
  try {
    snapshot = await readJson(snapshotPath, `Snapshot for latest Drizzle journal entry ${latestEntry.tag}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes(" is missing at ")) {
      throw new Error(
        `Latest Drizzle journal entry ${latestEntry.tag} has no matching ${snapshotPrefix}_snapshot.json. `
        + "Generate a reviewed current snapshot before running the database schema verifier.",
      );
    }
    throw error;
  }

  return {
    journalEntry: { idx: latestEntry.idx, tag: latestEntry.tag },
    snapshot: record(snapshot, `Drizzle snapshot ${snapshotPath}`),
    snapshotPath,
  };
}

const typeAliases = new Map([
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["int2", "smallint"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["serial", "integer"],
  ["serial4", "integer"],
  ["bigserial", "bigint"],
  ["serial8", "bigint"],
  ["smallserial", "smallint"],
  ["serial2", "smallint"],
  ["timestamptz", "timestamp with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["timetz", "time with time zone"],
  ["time", "time without time zone"],
  ["varchar", "character varying"],
]);

export function normalizePostgresType(type) {
  if (typeof type !== "string" || !type.trim()) {
    throw new Error("PostgreSQL type must be a non-empty string");
  }

  let normalized = type
    .trim()
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/^public\./, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*,\s*/g, ", ");
  const arraySuffix = normalized.endsWith("[]") ? "[]" : "";
  if (arraySuffix) normalized = normalized.slice(0, -2);
  normalized = typeAliases.get(normalized) ?? normalized;
  return `${normalized}${arraySuffix}`;
}

// Catalog expressions are deparsed rather than stored in declaration form.
// Preserve quoted literals (their case is meaningful), while normalizing the
// identifier/keyword formatting PostgreSQL is free to change.
function removeOuterGrouping(expression) {
  let selected = expression;
  while (selected.startsWith("(") && selected.endsWith(")")) {
    let depth = 0;
    let inString = false;
    let wrapsWholeExpression = true;
    for (let position = 0; position < selected.length; position += 1) {
      const character = selected[position];
      if (character === "'") {
        if (inString && selected[position + 1] === "'") {
          position += 1;
        } else {
          inString = !inString;
        }
      } else if (!inString && character === "(") {
        depth += 1;
      } else if (!inString && character === ")") {
        depth -= 1;
        if (depth === 0 && position < selected.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
    }
    if (!wrapsWholeExpression || depth !== 0) break;
    selected = selected.slice(1, -1).trim();
  }
  return selected;
}

export function normalizeSqlExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) return null;
  const controlEscape = (character) => ({
    "\b": "\\u0008",
    "\f": "\\u000c",
    "\n": "\\u000a",
    "\r": "\\u000d",
    "\t": "\\u0009",
  })[character] ?? null;
  const escapeLetter = (character) => ({
    b: "\\u0008",
    f: "\\u000c",
    n: "\\u000a",
    r: "\\u000d",
    t: "\\u0009",
  })[character] ?? null;
  let normalized = "";
  let inString = false;
  for (let position = 0; position < expression.length; position += 1) {
    const character = expression[position];
    // pg_get_expr emits the parsed value of an escape string as a regular
    // quoted literal. Decode the reviewed E literal while preserving literal
    // backslashes, then encode control bytes explicitly so the two semantic
    // values share one spelling without collapsing CR and LF together.
    if (
      !inString
      && (character === "e" || character === "E")
      && expression[position + 1] === "'"
      && (position === 0 || !/[a-z0-9_$]/i.test(expression[position - 1]))
    ) {
      normalized += "'";
      let closed = false;
      for (let cursor = position + 2; cursor < expression.length; cursor += 1) {
        const selected = expression[cursor];
        if (selected === "'") {
          if (expression[cursor + 1] === "'") {
            normalized += "''";
            cursor += 1;
            continue;
          }
          normalized += "'";
          position = cursor;
          closed = true;
          break;
        }
        if (selected === "\\" && cursor + 1 < expression.length) {
          const escaped = expression[cursor + 1];
          const encodedControl = escapeLetter(escaped);
          if (encodedControl !== null) {
            normalized += encodedControl;
          } else if (escaped === "\\") {
            normalized += "\\";
          } else if (escaped === "'") {
            normalized += "''";
          } else {
            normalized += `\\${escaped}`;
          }
          cursor += 1;
          continue;
        }
        normalized += controlEscape(selected) ?? selected;
      }
      if (!closed) return null;
      continue;
    }
    if (character === "'") {
      normalized += character;
      if (inString && expression[position + 1] === "'") {
        normalized += expression[position + 1];
        position += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    normalized += inString
      ? (controlEscape(character) ?? character)
      : character.toLowerCase();
  }
  return removeOuterGrouping(normalized
    .replaceAll("pg_catalog.", "")
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .trim());
}

function normalizeTableExpression(expression, tableName) {
  const normalized = normalizeSqlExpression(expression);
  if (!normalized) return null;
  const qualifier = `${tableName.toLowerCase()}.`;
  let selected = "";
  let inString = false;
  for (let position = 0; position < normalized.length;) {
    if (normalized[position] === "'") {
      selected += normalized[position];
      if (inString && normalized[position + 1] === "'") {
        selected += normalized[position + 1];
        position += 2;
        continue;
      }
      inString = !inString;
      position += 1;
      continue;
    }
    if (!inString && normalized.startsWith(qualifier, position)) {
      position += qualifier.length;
      continue;
    }
    selected += normalized[position];
    position += 1;
  }
  return selected;
}

function tokenizePredicate(expression) {
  const tokens = [];
  for (let position = 0; position < expression.length;) {
    const character = expression[position];
    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (character === "'") {
      let token = character;
      position += 1;
      while (position < expression.length) {
        token += expression[position];
        if (expression[position] === "'") {
          if (expression[position + 1] === "'") {
            token += expression[position + 1];
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        position += 1;
      }
      tokens.push(token);
      continue;
    }
    const token = expression.slice(position).match(/^(!~~\*?|~~\*?|!~\*?|~\*?|::|>=|<=|<>|!=|[()[\],=~<>]|[a-z_][a-z0-9_.$]*|\d+(?:\.\d+)?)/i)?.[0];
    if (!token) {
      tokens.push(character);
      position += 1;
      continue;
    }
    tokens.push(token);
    position += token.length;
  }
  return tokens;
}

function matchingPredicateDelimiter(tokens, openingPosition, opening, closing) {
  let depth = 0;
  for (let position = openingPosition; position < tokens.length; position += 1) {
    if (tokens[position] === opening) depth += 1;
    else if (tokens[position] === closing) {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

function stripOuterPredicateGrouping(tokens) {
  let selected = tokens;
  while (selected[0] === "(" && matchingPredicateDelimiter(selected, 0, "(", ")") === selected.length - 1) {
    selected = selected.slice(1, -1);
  }
  return selected;
}

function stripLiteralCastTokens(tokens) {
  const selected = [];
  for (let position = 0; position < tokens.length; position += 1) {
    selected.push(tokens[position]);
    // pg_get_expr annotates string constants with ::text. That annotation is
    // redundant for a text literal, but a domain, enum, or other explicit
    // cast remains part of the reviewed expression contract.
    if (
      !tokens[position].startsWith("'")
      || tokens[position + 1] !== "::"
      || tokens[position + 2]?.toLowerCase() !== "text"
    ) continue;
    let nextPosition = position + 3;
    if (tokens[nextPosition] === "(") {
      nextPosition = matchingPredicateDelimiter(tokens, nextPosition, "(", ")") + 1;
    }
    position = nextPosition - 1;
  }
  return selected;
}

function splitTopLevelPredicateBoolean(tokens, operator) {
  const parts = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let betweenNeedsAnd = false;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === "(") parenthesisDepth += 1;
    else if (token === ")") parenthesisDepth -= 1;
    else if (token === "[") bracketDepth += 1;
    else if (token === "]") bracketDepth -= 1;
    if (parenthesisDepth !== 0 || bracketDepth !== 0) continue;
    if (token === "between") {
      betweenNeedsAnd = true;
      continue;
    }
    if (token === "and" && betweenNeedsAnd) {
      betweenNeedsAnd = false;
      continue;
    }
    if (token === operator) {
      parts.push(tokens.slice(start, position));
      start = position + 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(tokens.slice(start));
  return parts;
}

function topLevelTokenPosition(tokens, expected) {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === "(") parenthesisDepth += 1;
    else if (token === ")") parenthesisDepth -= 1;
    else if (token === "[") bracketDepth += 1;
    else if (token === "]") bracketDepth -= 1;
    else if (parenthesisDepth === 0 && bracketDepth === 0 && token === expected) return position;
  }
  return -1;
}

function renderPredicateTokens(tokens) {
  const output = [];
  let previousToken = "";
  for (const token of tokens) {
    const needsSpace = /^[a-z0-9_.$']/.test(token)
      && /^[a-z0-9_.$']/.test(previousToken)
      && !previousToken.endsWith("'");
    output.push(`${needsSpace ? " " : ""}${token}`);
    previousToken = token;
  }
  return output.join("");
}

function canonicalMembershipTokens(tokens) {
  const inPosition = topLevelTokenPosition(tokens, "in");
  if (inPosition >= 0) {
    const values = tokens.slice(inPosition + 1);
    if (values[0] === "(" && matchingPredicateDelimiter(values, 0, "(", ")") === values.length - 1) {
      const negated = tokens[inPosition - 1] === "not";
      const subjectEnd = negated ? inPosition - 1 : inPosition;
      return [
        ...tokens.slice(0, subjectEnd),
        negated ? "<>" : "=",
        negated ? "all" : "any",
        "(", "array", "[", ...values.slice(1, -1), "]", ")",
      ];
    }
  }
  return tokens;
}

function canonicalPatternOperatorTokens(tokens) {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === "(") parenthesisDepth += 1;
    else if (token === ")") parenthesisDepth -= 1;
    else if (token === "[") bracketDepth += 1;
    else if (token === "]") bracketDepth -= 1;
    if (parenthesisDepth !== 0 || bracketDepth !== 0) continue;

    if (token === "like" || token === "ilike") {
      const negated = tokens[position - 1] === "not";
      return [
        ...tokens.slice(0, negated ? position - 1 : position),
        `${negated ? "!" : ""}~~${token === "ilike" ? "*" : ""}`,
        ...tokens.slice(position + 1),
      ];
    }
  }
  return tokens;
}

function topLevelComparisonPosition(tokens) {
  const comparisonOperators = new Set([
    "=", "!=", "<>", ">", ">=", "<", "<=", "~", "~*", "!~", "!~*",
    "~~", "~~*", "!~~", "!~~*",
  ]);
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === "(") parenthesisDepth += 1;
    else if (token === ")") parenthesisDepth -= 1;
    else if (token === "[") bracketDepth += 1;
    else if (token === "]") bracketDepth -= 1;
    else if (parenthesisDepth === 0 && bracketDepth === 0 && comparisonOperators.has(token)) return position;
  }
  return -1;
}

function hasTopLevelPredicateBoolean(tokens) {
  return splitTopLevelPredicateBoolean(tokens, "or") !== null
    || splitTopLevelPredicateBoolean(tokens, "and") !== null;
}

function stripRedundantComparisonOperandGrouping(tokens) {
  const stripped = stripOuterPredicateGrouping(tokens);
  // Parentheses around a boolean expression control precedence and must stay.
  return hasTopLevelPredicateBoolean(stripped) ? tokens : stripped;
}

function reviewedNumericLiteralCast(tokens) {
  let selected = tokens;
  if (selected[0] === "(") {
    const closingPosition = matchingPredicateDelimiter(selected, 0, "(", ")");
    if (closingPosition === 2 && selected[closingPosition + 1] === "::") {
      selected = [selected[1], ...selected.slice(closingPosition + 1)];
    }
  }
  if (
    selected.length === 3
    && /^\d+(?:\.\d+)?$/.test(selected[0])
    && selected[1] === "::"
    && selected[2]?.toLowerCase() === "numeric"
  ) {
    return selected[0];
  }
  return null;
}

function isKnownNumericColumn(tokens, columns) {
  if (!(columns instanceof Map) || tokens.length !== 1) return false;
  const type = columns.get(tokens[0])?.type;
  return typeof type === "string" && /^(?:numeric|decimal)(?:\(|$)/.test(type);
}

function isKnownColumnOfType(tokens, type, columns) {
  return columns instanceof Map
    && tokens.length === 1
    && typeof type === "string"
    && columns.get(tokens[0])?.type === type;
}

function directLiteralCast(tokens) {
  if (
    tokens.length === 3
    && tokens[0].startsWith("'")
    && tokens[1] === "::"
    && /^[a-z_][a-z0-9_.$]*$/i.test(tokens[2])
  ) {
    return { literal: tokens[0], type: tokens[2] };
  }
  return null;
}

function normalizeReviewedNumericComparison(tokens, columns) {
  const comparisonPosition = topLevelComparisonPosition(tokens);
  if (comparisonPosition < 0) return tokens;

  const left = stripRedundantComparisonOperandGrouping(tokens.slice(0, comparisonPosition));
  const operator = tokens[comparisonPosition];
  const right = stripRedundantComparisonOperandGrouping(tokens.slice(comparisonPosition + 1));
  const leftNumericLiteral = reviewedNumericLiteralCast(left);
  const rightNumericLiteral = reviewedNumericLiteralCast(right);

  if (rightNumericLiteral !== null && isKnownNumericColumn(left, columns)) {
    return [...left, operator, rightNumericLiteral];
  }
  if (leftNumericLiteral !== null && isKnownNumericColumn(right, columns)) {
    return [leftNumericLiteral, operator, ...right];
  }
  return [...left, operator, ...right];
}

function normalizeReviewedColumnLiteralCast(tokens, columns) {
  const comparisonPosition = topLevelComparisonPosition(tokens);
  if (comparisonPosition < 0) return tokens;

  const left = stripRedundantComparisonOperandGrouping(tokens.slice(0, comparisonPosition));
  const operator = tokens[comparisonPosition];
  const right = stripRedundantComparisonOperandGrouping(tokens.slice(comparisonPosition + 1));
  const leftCast = directLiteralCast(left);
  const rightCast = directLiteralCast(right);

  if (rightCast && isKnownColumnOfType(left, rightCast.type, columns)) {
    return [...left, operator, rightCast.literal];
  }
  if (leftCast && isKnownColumnOfType(right, leftCast.type, columns)) {
    return [leftCast.literal, operator, ...right];
  }
  return [...left, operator, ...right];
}

function predicateLeaf(tokens, columns) {
  const selected = canonicalPatternOperatorTokens(canonicalMembershipTokens(stripLiteralCastTokens(
    normalizeReviewedColumnLiteralCast(
      normalizeReviewedNumericComparison(stripOuterPredicateGrouping(tokens), columns),
      columns,
    ),
  )));
  const betweenPosition = topLevelTokenPosition(selected, "between");
  if (betweenPosition >= 0) {
    const lowerAndPosition = topLevelTokenPosition(selected.slice(betweenPosition + 1), "and");
    if (lowerAndPosition >= 0) {
      const andPosition = betweenPosition + lowerAndPosition + 1;
      const subject = selected.slice(0, betweenPosition);
      const lower = selected.slice(betweenPosition + 1, andPosition);
      const upper = selected.slice(andPosition + 1);
      if (subject.length > 0 && lower.length > 0 && upper.length > 0) {
        return {
          operator: "and",
          operands: [
            { operator: null, value: renderPredicateTokens([...subject, ">=", ...lower]) },
            { operator: null, value: renderPredicateTokens([...subject, "<=", ...upper]) },
          ],
        };
      }
    }
  }
  return { operator: null, value: renderPredicateTokens(selected) };
}

function parsePredicateExpression(tokens, columns) {
  const selected = stripOuterPredicateGrouping(tokens);
  const orParts = splitTopLevelPredicateBoolean(selected, "or");
  if (orParts) return { operator: "or", operands: orParts.map((part) => parsePredicateExpression(part, columns)) };
  const andParts = splitTopLevelPredicateBoolean(selected, "and");
  if (andParts) return { operator: "and", operands: andParts.map((part) => parsePredicateExpression(part, columns)) };
  return predicateLeaf(selected, columns);
}

function renderPredicateExpression(node, parentPrecedence = 0) {
  if (!node.operator) return node.value;
  const precedence = { or: 1, and: 2 };
  const ownPrecedence = precedence[node.operator];
  const rendered = node.operands
    .map((operand) => renderPredicateExpression(operand, ownPrecedence))
    .join(` ${node.operator} `);
  return ownPrecedence < parentPrecedence ? `(${rendered})` : rendered;
}

function normalizePredicateExpression(expression, tableName, columns) {
  const normalized = normalizeTableExpression(expression, tableName);
  if (!normalized) return null;
  return renderPredicateExpression(parsePredicateExpression(tokenizePredicate(normalized), columns));
}

export function normalizeIndexPredicate(expression, tableName, columns) {
  return normalizePredicateExpression(expression, tableName, columns);
}

// PostgreSQL stores a parse tree for CHECKs. pg_get_expr therefore deparses
// `IN` as `= ANY (ARRAY[...])` and `BETWEEN` as paired inequalities. Normalize
// those equivalent canonical forms without weakening comparisons of literals,
// operators, or referenced columns.
export function normalizeCheckExpression(expression, tableName, columns) {
  return normalizePredicateExpression(expression, tableName, columns);
}

export function normalizeColumnDefault(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const normalized = normalizeSqlExpression(value);
  if (normalized === null) return null;
  const canonical = normalized
    .replace(/current_timestamp\b/g, "now()")
    // PostgreSQL adds the target column type to typed literals while Drizzle
    // snapshots retain the literal. The column type itself is compared above.
    .replace(/('(?:[^']|'')*')::[a-z_][a-z0-9_ ]*(?:\([^)]*\))?(?:\[\])?/g, "$1");
  // PostgreSQL folds this reviewed all-zero command-hash default into
  // repeat('0',64). Keep the rewrite deliberately exact: arbitrary function
  // defaults remain syntactically distinct and therefore reviewable.
  return canonical === "repeat('0',64)" ? `'${"0".repeat(64)}'` : canonical;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function normalizeForeignKeyAction(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const aliases = new Map([
    ["a", "no action"],
    ["c", "cascade"],
    ["n", "set null"],
    ["r", "restrict"],
    ["d", "set default"],
  ]);
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return aliases.get(normalized) ?? normalized;
}

function stripIndexOrdering(expression) {
  return expression
    .replace(/\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?\s*$/i, "")
    .replace(/\s+nulls\s+(?:first|last)\s*$/i, "");
}

function normalizeIndexColumns(value, label, tableName) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((rawColumn, position) => {
    const column = record(rawColumn, `${label} ${position}`);
    const expression = normalizeTableExpression(
      typeof column.expression === "string"
        ? stripIndexOrdering(column.expression)
        : column.expression,
      tableName,
    );
    if (!expression) throw new Error(`${label} ${position} needs an expression`);
    return {
      asc: column.asc !== false,
      expression,
      isExpression: column.isExpression === true,
      nulls: typeof column.nulls === "string" ? column.nulls.toLowerCase() : "last",
    };
  });
}

function contractsDiffer(expected, actual) {
  return JSON.stringify(expected) !== JSON.stringify(actual);
}

function foreignKeySemantics(foreignKey) {
  return JSON.stringify({
    columnsFrom: foreignKey.columnsFrom,
    columnsTo: foreignKey.columnsTo,
    onDelete: foreignKey.onDelete,
    onUpdate: foreignKey.onUpdate,
    tableTo: foreignKey.tableTo,
  });
}

function publicSchemaName(tableKey, table) {
  if (typeof table.schema === "string" && table.schema) return table.schema;
  const separator = tableKey.indexOf(".");
  return separator > 0 ? tableKey.slice(0, separator) : "public";
}

// pg_get_expr is a PostgreSQL deparser, not a stable source formatter. Compare
// its meaningful tokens so harmless catalog qualification, quoting, whitespace,
// grouping-parenthesis differences, and the public-regclass-to-oid deparse used
// by PostgreSQL 16 do not obscure a policy change.
export function normalizeRlsPolicyExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) return null;
  const normalized = expression
    .toLowerCase()
    .replaceAll("pg_catalog.", "")
    .replaceAll('"', "")
    .replace(/[\s()]+/g, "")
    .trim();
  return normalized.replace(
    /'([a-z_][a-z0-9_$]*)'::regclass::oid/g,
    "'public.$1'::regclass",
  );
}

function ownerOnlyPolicyExpression(tableName) {
  return "current_user = pg_get_userbyid((select owner_relation.relowner "
    + "from pg_class owner_relation where owner_relation.oid = "
    + `'public.${tableName}'::regclass))`;
}

function expectedRlsPolicy(table) {
  if (table.name === "organizations") {
    return {
      command: "ALL",
      name: "organizations_tenant_isolation",
      permissive: true,
      roles: ["PUBLIC"],
      usingExpression: "id = app.current_organization_id()",
      withCheckExpression: "id = app.current_organization_id()",
    };
  }
  if (userBoundRlsTables.has(table.name)) {
    const expression = "organization_id = app.current_organization_id() AND user_id = app.current_actor_id()";
    return {
      command: "ALL",
      name: "mcp_user_isolation",
      permissive: true,
      roles: ["PUBLIC"],
      usingExpression: expression,
      withCheckExpression: expression,
    };
  }
  if (ownerOnlyRlsTables.has(table.name)) {
    const expression = ownerOnlyPolicyExpression(table.name);
    return {
      command: "ALL",
      name: `${table.name}_owner_only_policy`,
      permissive: true,
      roles: ["PUBLIC"],
      usingExpression: expression,
      withCheckExpression: expression,
    };
  }
  const preservedPolicyName = preservedTenantRlsPolicyNames.get(table.name);
  return {
    command: "ALL",
    name: preservedPolicyName ?? "tenant_isolation",
    permissive: true,
    roles: ["PUBLIC"],
    usingExpression: "organization_id = app.current_organization_id()",
    withCheckExpression: "organization_id = app.current_organization_id()",
  };
}

export function buildSnapshotSchemaContract(snapshot) {
  const selectedSnapshot = record(snapshot, "Drizzle snapshot");
  const snapshotTables = record(selectedSnapshot.tables, "Drizzle snapshot tables");
  const tables = new Map();

  for (const [tableKey, rawTable] of Object.entries(snapshotTables)) {
    const table = record(rawTable, `Drizzle snapshot table ${tableKey}`);
    if (publicSchemaName(tableKey, table) !== "public") continue;
    if (typeof table.name !== "string" || !table.name) {
      throw new Error(`Drizzle snapshot table ${tableKey} has no name`);
    }
    if (tables.has(table.name)) {
      throw new Error(`Drizzle snapshot declares public.${table.name} more than once`);
    }

    const rawColumns = record(table.columns, `Drizzle snapshot columns for public.${table.name}`);
    const columns = new Map();
    for (const [columnKey, rawColumn] of Object.entries(rawColumns)) {
      const column = record(rawColumn, `Drizzle snapshot column public.${table.name}.${columnKey}`);
      if (typeof column.name !== "string" || !column.name) {
        throw new Error(`Drizzle snapshot column public.${table.name}.${columnKey} has no name`);
      }
      columns.set(column.name, {
        default: normalizeColumnDefault(column.default),
        name: column.name,
        nullable: column.notNull !== true,
        type: normalizePostgresType(column.type),
      });
    }

    const foreignKeys = new Map();
    for (const [key, rawForeignKey] of Object.entries(record(table.foreignKeys ?? {}, `Drizzle snapshot foreign keys for public.${table.name}`))) {
      const foreignKey = record(rawForeignKey, `Drizzle snapshot foreign key public.${table.name}.${key}`);
      if (typeof foreignKey.name !== "string" || !foreignKey.name || typeof foreignKey.tableTo !== "string" || !foreignKey.tableTo) {
        throw new Error(`Drizzle snapshot foreign key public.${table.name}.${key} needs a name and target table`);
      }
      const identifier = constraintIdentifier(foreignKey.name, foreignKeys, `Drizzle snapshot foreign key public.${table.name}`);
      foreignKeys.set(identifier, {
        columnsFrom: stringArray(foreignKey.columnsFrom, `Drizzle snapshot foreign key public.${table.name}.${foreignKey.name} columnsFrom`),
        columnsTo: stringArray(foreignKey.columnsTo, `Drizzle snapshot foreign key public.${table.name}.${foreignKey.name} columnsTo`),
        name: identifier,
        onDelete: normalizeForeignKeyAction(foreignKey.onDelete ?? "no action", `Drizzle snapshot foreign key public.${table.name}.${identifier} onDelete`),
        onUpdate: normalizeForeignKeyAction(foreignKey.onUpdate ?? "no action", `Drizzle snapshot foreign key public.${table.name}.${identifier} onUpdate`),
        tableTo: foreignKey.tableTo,
      });
    }

    const checks = new Map();
    for (const [key, rawCheck] of Object.entries(record(table.checkConstraints ?? {}, `Drizzle snapshot checks for public.${table.name}`))) {
      const check = record(rawCheck, `Drizzle snapshot check public.${table.name}.${key}`);
      const expression = normalizeCheckExpression(check.value, table.name, columns);
      if (typeof check.name !== "string" || !check.name || !expression) {
        throw new Error(`Drizzle snapshot check public.${table.name}.${key} needs a name and expression`);
      }
      const identifier = constraintIdentifier(check.name, checks, `Drizzle snapshot CHECK public.${table.name}`);
      checks.set(identifier, { expression, name: identifier });
    }

    const uniqueConstraints = new Map();
    for (const [key, rawUnique] of Object.entries(record(table.uniqueConstraints ?? {}, `Drizzle snapshot unique constraints for public.${table.name}`))) {
      const unique = record(rawUnique, `Drizzle snapshot unique constraint public.${table.name}.${key}`);
      if (typeof unique.name !== "string" || !unique.name) {
        throw new Error(`Drizzle snapshot unique constraint public.${table.name}.${key} needs a name`);
      }
      const identifier = constraintIdentifier(unique.name, uniqueConstraints, `Drizzle snapshot unique constraint public.${table.name}`);
      uniqueConstraints.set(identifier, {
        columns: stringArray(unique.columns, `Drizzle snapshot unique constraint public.${table.name}.${unique.name} columns`),
        name: identifier,
        nullsNotDistinct: unique.nullsNotDistinct === true,
      });
    }

    const indexes = new Map();
    for (const [key, rawIndex] of Object.entries(record(table.indexes ?? {}, `Drizzle snapshot indexes for public.${table.name}`))) {
      const index = record(rawIndex, `Drizzle snapshot index public.${table.name}.${key}`);
      if (typeof index.name !== "string" || !index.name) {
        throw new Error(`Drizzle snapshot index public.${table.name}.${key} needs a name`);
      }
      indexes.set(index.name, {
        columns: normalizeIndexColumns(index.columns, `Drizzle snapshot index public.${table.name}.${index.name} columns`, table.name),
        isUnique: index.isUnique === true,
        method: typeof index.method === "string" ? index.method.toLowerCase() : "btree",
        name: index.name,
        nullsNotDistinct: index.nullsNotDistinct === true,
        where: normalizeIndexPredicate(index.where, table.name, columns),
      });
    }

    tables.set(table.name, {
      checks,
      columns,
      exclusionConstraints: new Map(),
      forceRls: table.name === "organizations"
        || columns.has("organization_id")
        || ownerOnlyRlsTables.has(table.name),
      foreignKeys,
      indexes,
      name: table.name,
      uniqueConstraints,
    });
  }

  return { tables };
}

function unquoteIdentifier(value) {
  return value.trim().replaceAll('"', "").replace(/^public\./i, "");
}

function parenthesizedSql(source, openingPosition) {
  if (source[openingPosition] !== "(") return null;
  let depth = 0;
  let inString = false;
  for (let position = openingPosition; position < source.length; position += 1) {
    const character = source[position];
    if (character === "'") {
      if (inString && source[position + 1] === "'") position += 1;
      else inString = !inString;
    } else if (!inString && character === "(") {
      depth += 1;
    } else if (!inString && character === ")") {
      depth -= 1;
      if (depth === 0) return { end: position, value: source.slice(openingPosition + 1, position) };
    }
  }
  return null;
}

function splitTopLevelSql(source, separators = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let position = 0; position < source.length; position += 1) {
    const character = source[position];
    if (character === "'") {
      if (inString && source[position + 1] === "'") position += 1;
      else inString = !inString;
    } else if (!inString && character === "(") {
      depth += 1;
    } else if (!inString && character === ")") {
      depth -= 1;
    } else if (!inString && depth === 0 && separators.includes(character)) {
      parts.push(source.slice(start, position));
      start = position + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function constraintExpression(fragment, keyword) {
  const match = typeof keyword === "string"
    ? fragment.match(keyword)
    : fragment.match(keyword);
  if (!match || match.index === undefined) return null;
  const openingPosition = fragment.indexOf("(", match.index + match[0].length);
  return openingPosition < 0 ? null : parenthesizedSql(fragment, openingPosition)?.value ?? null;
}

export function normalizePostgresConstraintIdentifier(identifier) {
  if (typeof identifier !== "string" || !identifier) throw new Error("PostgreSQL constraint identifier must be a non-empty string");
  const bytes = Buffer.from(identifier, "utf8");
  if (bytes.length <= 63) return identifier;
  let selected = bytes.subarray(0, 63).toString("utf8");
  while (Buffer.byteLength(selected, "utf8") > 63) selected = selected.slice(0, -1);
  return selected;
}

function constraintIdentifier(identifier, constraints, label) {
  const normalized = normalizePostgresConstraintIdentifier(identifier);
  if (constraints.has(normalized) && normalized !== identifier) {
    throw new Error(`${label} collides after PostgreSQL's 63-byte identifier truncation: ${identifier}`);
  }
  return normalized;
}

function markMigrationConstraintActive(contract, tableName, name) {
  contract.droppedConstraints?.get(tableName)?.delete(name);
}

function addMigrationCheck(contract, tableName, name, expression, generated = false) {
  const table = contract.get(tableName) ?? {
    checks: new Map(), foreignKeys: new Map(), indexes: new Map(), uniqueConstraints: new Map(),
  };
  const normalized = normalizeCheckExpression(expression, tableName);
  if (!normalized) throw new Error(`Migration-owned CHECK public.${tableName}.${name} has no expression`);
  table.checks.set(name, { expression: normalized, generated, name });
  markMigrationConstraintActive(contract, tableName, name);
  contract.set(tableName, table);
}

function addMigrationUniqueConstraint(contract, tableName, name, columns, nullsNotDistinct = false) {
  const table = contract.get(tableName) ?? {
    checks: new Map(), foreignKeys: new Map(), indexes: new Map(), uniqueConstraints: new Map(),
  };
  const identifier = constraintIdentifier(name, table.uniqueConstraints, `Migration-owned UNIQUE public.${tableName}`);
  table.uniqueConstraints.set(identifier, { columns: splitTopLevelSql(columns).map(unquoteIdentifier), name: identifier, nullsNotDistinct });
  markMigrationConstraintActive(contract, tableName, identifier);
  contract.set(tableName, table);
}

function addMigrationIndex(contract, tableName, name, isUnique, method, columns, where, nullsNotDistinct = false) {
  const table = contract.get(tableName) ?? {
    checks: new Map(), foreignKeys: new Map(), indexes: new Map(), uniqueConstraints: new Map(),
  };
  const parsedColumns = splitTopLevelSql(columns).map((rawColumn) => {
    const nullsMatch = rawColumn.match(/\s+nulls\s+(first|last)\s*$/i);
    const descending = /\s+desc(?:\s+nulls\s+(?:first|last))?\s*$/i.test(rawColumn);
    const expression = normalizeTableExpression(
      stripIndexOrdering(rawColumn),
      tableName,
    );
    if (!expression) throw new Error(`Migration-owned index public.${tableName}.${name} has an empty column`);
    return {
      asc: !descending,
      expression,
      isExpression: !/^[a-z_][a-z0-9_]*$/i.test(expression),
      nulls: nullsMatch?.[1].toLowerCase() ?? (descending ? "first" : "last"),
    };
  });
  table.indexes.set(name, {
    columns: parsedColumns,
    isUnique,
    method: method?.toLowerCase() ?? "btree",
    name,
    nullsNotDistinct,
    where: normalizeIndexPredicate(where, tableName),
  });
  contract.droppedIndexes?.delete(name);
  contract.set(tableName, table);
}

function addMigrationForeignKey(contract, tableName, name, columnsFrom, tableTo, columnsTo, onDelete, onUpdate) {
  const table = contract.get(tableName) ?? {
    checks: new Map(), foreignKeys: new Map(), indexes: new Map(), uniqueConstraints: new Map(),
  };
  const identifier = constraintIdentifier(name, table.foreignKeys, `Migration-owned foreign key public.${tableName}`);
  table.foreignKeys.set(identifier, {
    columnsFrom: splitTopLevelSql(columnsFrom).map(unquoteIdentifier),
    columnsTo: splitTopLevelSql(columnsTo).map(unquoteIdentifier),
    name: identifier,
    onDelete: normalizeForeignKeyAction(onDelete ?? "no action", `Migration-owned foreign key public.${tableName}.${identifier} onDelete`),
    onUpdate: normalizeForeignKeyAction(onUpdate ?? "no action", `Migration-owned foreign key public.${tableName}.${identifier} onUpdate`),
    tableTo: unquoteIdentifier(tableTo),
  });
  markMigrationConstraintActive(contract, tableName, identifier);
  contract.set(tableName, table);
}

function normalizeExclusionExpression(expression, tableName) {
  return normalizeCheckExpression(expression, tableName);
}

function addMigrationExclusion(contract, tableName, name, method, elements, where) {
  const table = contract.get(tableName) ?? {
    checks: new Map(), foreignKeys: new Map(), indexes: new Map(), uniqueConstraints: new Map(),
  };
  table.exclusionConstraints ??= new Map();
  const identifier = constraintIdentifier(name, table.exclusionConstraints, `Migration-owned exclusion public.${tableName}`);
  table.exclusionConstraints.set(identifier, {
    elements: splitTopLevelSql(elements).map((element) => {
      const match = element.match(/^([\s\S]+?)\s+WITH\s+([^\s]+)\s*$/i);
      const expression = match && normalizeExclusionExpression(match[1], tableName);
      if (!match || !expression) throw new Error(`Migration-owned exclusion public.${tableName}.${name} has an invalid element`);
      return { expression, operator: match[2] };
    }),
    method: method.toLowerCase(),
    name: identifier,
    where: normalizeIndexPredicate(where, tableName),
  });
  markMigrationConstraintActive(contract, tableName, identifier);
  contract.set(tableName, table);
}

function metadataUsesColumn(metadata, columnName) {
  const escapedColumn = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columnPattern = new RegExp(`(^|[^a-z0-9_])${escapedColumn}([^a-z0-9_]|$)`, "i");
  return (metadata.columns ?? []).some((column) => (
    typeof column === "string" ? column === columnName : columnPattern.test(column.expression ?? "")
  )) || columnPattern.test(metadata.expression ?? "") || columnPattern.test(metadata.where ?? "");
}

function removeColumnOwnedMetadata(table, columnName) {
  for (const [name, check] of table.checks) {
    if (metadataUsesColumn(check, columnName)) table.checks.delete(name);
  }
  for (const [name, unique] of table.uniqueConstraints) {
    if (metadataUsesColumn(unique, columnName)) table.uniqueConstraints.delete(name);
  }
  for (const [name, foreignKey] of table.foreignKeys) {
    if (foreignKey.columnsFrom.includes(columnName)) table.foreignKeys.delete(name);
  }
  for (const [name, index] of table.indexes) {
    if (metadataUsesColumn(index, columnName)) table.indexes.delete(name);
  }
}

function dropMigrationColumnMetadata(contract, tableName, columnName) {
  const table = contract.get(tableName);
  if (table) removeColumnOwnedMetadata(table, columnName);
  const droppedColumns = contract.droppedColumns.get(tableName) ?? new Set();
  droppedColumns.add(columnName);
  contract.droppedColumns.set(tableName, droppedColumns);
}

function parseNamedMigrationForeignKey(contract, tableName, fragment, name) {
  const columnsFrom = constraintExpression(fragment, /\bFOREIGN\s+KEY\b/i);
  const reference = fragment.match(/\bREFERENCES\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/i);
  if (!columnsFrom || !reference) return;
  const columnsTo = parenthesizedSql(fragment, fragment.indexOf("(", reference.index));
  if (!columnsTo) return;
  const onDelete = fragment.match(/\bON\s+DELETE\s+(NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)/i)?.[1];
  const onUpdate = fragment.match(/\bON\s+UPDATE\s+(NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)/i)?.[1];
  addMigrationForeignKey(contract, tableName, name, columnsFrom, reference[1], columnsTo.value, onDelete, onUpdate);
}

function parseNamedMigrationExclusion(contract, tableName, fragment, name) {
  const declared = fragment.match(/\bEXCLUDE\s+USING\s+([a-z_][a-z0-9_]*)\s*\(/i);
  if (!declared) return;
  const openingPosition = fragment.indexOf("(", declared.index);
  const elements = parenthesizedSql(fragment, openingPosition);
  if (!elements) return;
  const where = fragment.slice(elements.end + 1).match(/\bWHERE\s*\(([^]*)\)/i)?.[1] ?? null;
  addMigrationExclusion(contract, tableName, name, declared[1], elements.value, where);
}

function parseTableConstraintFragment(contract, tableName, fragment) {
  // A hand-authored CREATE TABLE may document a column with line comments.
  // Remove only leading comments so the first column token remains visible;
  // comments elsewhere can still be meaningful SQL formatting.
  fragment = fragment.replace(/^\s*(?:--[^\r\n]*(?:\r?\n|$)\s*)+/, "");
  const namedCheck = fragment.match(/^CONSTRAINT\s+"?([^"\s]+)"?\s+CHECK\s*\(/i);
  if (namedCheck) {
    const expression = constraintExpression(fragment, /\bCHECK\b/i);
    if (expression) addMigrationCheck(contract, tableName, namedCheck[1], expression);
    return;
  }
  const namedUnique = fragment.match(/^CONSTRAINT\s+"?([^"\s]+)"?\s+UNIQUE(?:\s+NULLS\s+NOT\s+DISTINCT)?\s*\(/i);
  if (namedUnique) {
    const columns = constraintExpression(fragment, /\bUNIQUE\b/i);
    if (columns) addMigrationUniqueConstraint(contract, tableName, namedUnique[1], columns, /\bNULLS\s+NOT\s+DISTINCT\b/i.test(fragment));
    return;
  }
  const namedForeign = fragment.match(/^CONSTRAINT\s+"?([^"\s]+)"?\s+FOREIGN\s+KEY\s*\(/i);
  if (namedForeign) {
    parseNamedMigrationForeignKey(contract, tableName, fragment, namedForeign[1]);
    return;
  }
  const namedExclusion = fragment.match(/^CONSTRAINT\s+"?([^"\s]+)"?\s+EXCLUDE\s+USING\s+/i);
  if (namedExclusion) {
    parseNamedMigrationExclusion(contract, tableName, fragment, namedExclusion[1]);
    return;
  }
  const column = fragment.match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
  if (!column) return;
  const inlineCheck = constraintExpression(fragment, /\bCHECK\b/i);
  if (inlineCheck) addMigrationCheck(contract, tableName, `${tableName}_${column[1]}_check`, inlineCheck, true);
  if (/\bUNIQUE\b/i.test(fragment)) {
    addMigrationUniqueConstraint(contract, tableName, `${tableName}_${column[1]}_key`, column[1]);
  }
}

// Migrations 0004-0025 predate the generated baseline and contain invariants
// (mostly CHECKs and UNIQUE constraints) which Drizzle cannot reconstruct from
// that historical snapshot. Parse only declarative CREATE/ALTER TABLE clauses;
// executable PL/pgSQL and RLS statements are intentionally out of scope.
export function parseMigrationOwnedConstraintContract(sql) {
  if (typeof sql !== "string") throw new Error("Migration SQL must be a string");
  const contract = new Map();
  contract.droppedColumns = new Map();
  contract.droppedConstraints = new Map();
  const statements = sql.split("--> statement-breakpoint");
  for (const statement of statements) {
    const create = statement.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/i);
    if (create) {
      const openingPosition = statement.indexOf("(", create.index);
      const definition = parenthesizedSql(statement, openingPosition);
      if (!definition) throw new Error(`Cannot parse CREATE TABLE ${create[1]} in migration contract`);
      for (const fragment of splitTopLevelSql(definition.value)) {
        parseTableConstraintFragment(contract, create[1], fragment);
      }
    }

    const alter = statement.match(/\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+([\s\S]*)$/i);
    if (!alter) continue;
    let tableName = alter[1];
    for (let fragment of splitTopLevelSql(alter[2].replace(/;\s*$/, ""), ",;")) {
      const subsequentAlter = fragment.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+([\s\S]*)$/i);
      if (subsequentAlter) {
        tableName = subsequentAlter[1];
        fragment = subsequentAlter[2];
      }
      const addedConstraint = fragment.match(/^ADD\s+CONSTRAINT\s+"?([^"\s]+)"?\s+(CHECK|UNIQUE|FOREIGN\s+KEY|EXCLUDE\s+USING)\b/i);
      if (addedConstraint?.[2].toUpperCase() === "CHECK") {
        const expression = constraintExpression(fragment, /\bCHECK\b/i);
        if (expression) addMigrationCheck(contract, tableName, addedConstraint[1], expression);
      } else if (addedConstraint?.[2].toUpperCase() === "UNIQUE") {
        const columns = constraintExpression(fragment, /\bUNIQUE\b/i);
        if (columns) addMigrationUniqueConstraint(contract, tableName, addedConstraint[1], columns, /\bNULLS\s+NOT\s+DISTINCT\b/i.test(fragment));
      } else if (addedConstraint?.[2].toUpperCase() === "FOREIGN KEY") {
        parseNamedMigrationForeignKey(contract, tableName, fragment, addedConstraint[1]);
      } else if (addedConstraint?.[2].toUpperCase() === "EXCLUDE USING") {
        parseNamedMigrationExclusion(contract, tableName, fragment, addedConstraint[1]);
      } else if (/^ADD\s+COLUMN\b/i.test(fragment)) {
        parseTableConstraintFragment(contract, tableName, fragment.replace(/^ADD\s+COLUMN\s+/i, ""));
        const addedColumn = fragment.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i);
        if (addedColumn) contract.droppedColumns.get(tableName)?.delete(addedColumn[1]);
      } else {
        const dropped = fragment.match(/^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([^"\s;]+)"?/i);
        if (dropped) {
          const table = contract.get(tableName);
          table?.checks.delete(dropped[1]);
          table?.foreignKeys.delete(dropped[1]);
          table?.uniqueConstraints.delete(dropped[1]);
          table?.exclusionConstraints?.delete(dropped[1]);
          const droppedConstraints = contract.droppedConstraints.get(tableName) ?? new Set();
          droppedConstraints.add(dropped[1]);
          contract.droppedConstraints.set(tableName, droppedConstraints);
        } else {
          const droppedColumn = fragment.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i);
          if (droppedColumn) dropMigrationColumnMetadata(contract, tableName, droppedColumn[1]);
        }
      }
    }
  }

  // Preserve DDL order: a later DROP INDEX must erase both a parsed legacy
  // CREATE INDEX and an index inherited from the generated snapshot.
  contract.droppedIndexes = new Set();
  const indexOperations = /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+ON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+USING\s+([a-z_][a-z0-9_]*))?\s*\(|\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([^;]+)/gi;
  for (const index of sql.matchAll(indexOperations)) {
    if (index[5]) {
      for (const rawName of splitTopLevelSql(index[5])) {
        const name = unquoteIdentifier(rawName.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, ""));
        contract.droppedIndexes.add(name);
        for (const table of contract.values()) table.indexes.delete(name);
      }
      continue;
    }
    const openingPosition = index.index + index[0].lastIndexOf("(");
    const definition = parenthesizedSql(sql, openingPosition);
    if (!definition) throw new Error(`Cannot parse migration-owned index ${index[2]}`);
    const tail = sql.slice(definition.end + 1, sql.indexOf(";", definition.end + 1) < 0 ? sql.length : sql.indexOf(";", definition.end + 1));
    const where = tail.match(/\bWHERE\s+([\s\S]*)$/i)?.[1] ?? null;
    addMigrationIndex(contract, index[3], index[2], index[1] !== undefined, index[4], definition.value, where, /\bNULLS\s+NOT\s+DISTINCT\b/i.test(tail));
  }
  return contract;
}

export async function loadMigrationOwnedConstraintContract(migrationDirectory = defaultMigrationDirectory) {
  const entries = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const combined = (await Promise.all(entries.map((entry) => readFile(join(migrationDirectory, entry.name), "utf8"))))
    .join("\n--> statement-breakpoint\n");
  return parseMigrationOwnedConstraintContract(combined);
}

export function applyMigrationOwnedConstraintContract(snapshotContract, migrationContract) {
  const selectedSnapshot = record(snapshotContract, "Snapshot schema contract");
  if (!(selectedSnapshot.tables instanceof Map) || !(migrationContract instanceof Map)) {
    throw new Error("Snapshot and migration-owned contracts must contain table maps");
  }
  for (const [tableName, migrationTable] of migrationContract) {
    const table = selectedSnapshot.tables.get(tableName);
    if (!table) continue;
    for (const [name, check] of migrationTable.checks) table.checks.set(name, check);
    for (const [name, foreignKey] of migrationTable.foreignKeys) {
      table.foreignKeys.set(name, foreignKey);
    }
    for (const [name, unique] of migrationTable.uniqueConstraints) {
      table.uniqueConstraints.set(name, unique);
      table.indexes.set(name, {
        columns: unique.columns.map((expression) => ({ asc: true, expression, isExpression: false, nulls: "last" })),
        isUnique: true,
        method: "btree",
        name,
        nullsNotDistinct: unique.nullsNotDistinct,
        where: null,
      });
    }
    for (const [name, index] of migrationTable.indexes) table.indexes.set(name, index);
    for (const [name, exclusion] of migrationTable.exclusionConstraints ?? []) {
      table.exclusionConstraints.set(name, exclusion);
    }
  }
  for (const name of migrationContract.droppedIndexes ?? []) {
    for (const table of selectedSnapshot.tables.values()) table.indexes.delete(name);
  }
  for (const [tableName, names] of migrationContract.droppedConstraints ?? []) {
    const table = selectedSnapshot.tables.get(tableName);
    if (!table) continue;
    for (const name of names) {
      table.checks.delete(name);
      table.foreignKeys.delete(name);
      table.uniqueConstraints.delete(name);
      table.exclusionConstraints.delete(name);
      table.indexes.delete(name);
    }
  }
  for (const [tableName, columns] of migrationContract.droppedColumns ?? []) {
    const table = selectedSnapshot.tables.get(tableName);
    if (table) for (const column of columns) removeColumnOwnedMetadata(table, column);
  }
  return selectedSnapshot;
}

function integerMetadata(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

const arrayElementAliases = new Map([
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["int2", "smallint"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["timestamptz", "timestamp with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["varchar", "character varying"],
]);

export function informationSchemaColumnType(column) {
  const row = record(column, "information_schema column");
  if (typeof row.data_type !== "string" || typeof row.udt_name !== "string") {
    throw new Error("information_schema column needs data_type and udt_name");
  }

  if (typeof row.domain_name === "string" && row.domain_name) {
    return normalizePostgresType(row.domain_name);
  }

  const dataType = row.data_type.toUpperCase();
  if (dataType === "USER-DEFINED") return normalizePostgresType(row.udt_name);
  if (dataType === "ARRAY") {
    const rawElement = row.udt_name.startsWith("_") ? row.udt_name.slice(1) : row.udt_name;
    return normalizePostgresType(`${arrayElementAliases.get(rawElement) ?? rawElement}[]`);
  }

  if (dataType === "NUMERIC" || dataType === "DECIMAL") {
    const precision = integerMetadata(row.numeric_precision);
    const scale = integerMetadata(row.numeric_scale);
    return precision === null || scale === null
      ? "numeric"
      : normalizePostgresType(`numeric(${precision}, ${scale})`);
  }

  if (dataType === "CHARACTER VARYING" || dataType === "CHARACTER") {
    const length = integerMetadata(row.character_maximum_length);
    return normalizePostgresType(length === null ? row.data_type : `${row.data_type}(${length})`);
  }

  if (dataType.startsWith("TIMESTAMP") || dataType.startsWith("TIME ")) {
    const precision = integerMetadata(row.datetime_precision);
    if (precision !== null && precision !== 6) {
      const zone = dataType.endsWith("WITH TIME ZONE") ? "with time zone" : "without time zone";
      const base = dataType.startsWith("TIMESTAMP") ? "timestamp" : "time";
      return normalizePostgresType(`${base}(${precision}) ${zone}`);
    }
  }

  return normalizePostgresType(row.data_type);
}

export function buildDatabaseSchemaContract({
  tableRows,
  columnRows,
  rlsRows,
  policyRows,
  foreignKeyRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  checkRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  uniqueConstraintRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  exclusionConstraintRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  indexRows = /** @type {Array<Record<string, unknown>>} */ ([]),
}) {
  if (
    !Array.isArray(tableRows)
    || !Array.isArray(columnRows)
    || !Array.isArray(rlsRows)
    || !Array.isArray(policyRows)
    || !Array.isArray(foreignKeyRows)
    || !Array.isArray(checkRows)
    || !Array.isArray(uniqueConstraintRows)
    || !Array.isArray(exclusionConstraintRows)
    || !Array.isArray(indexRows)
  ) {
    throw new Error(
      "Database schema metadata must provide table, column, RLS, policy, foreign-key, check, unique-constraint, and index arrays",
    );
  }

  const rlsByTable = new Map(rlsRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL RLS row");
    return [row.table_name, row];
  }));
  const policiesByTable = new Map();
  for (const rawRow of policyRows) {
    const row = record(rawRow, "PostgreSQL RLS policy row");
    if (
      typeof row.table_name !== "string"
      || !row.table_name
      || typeof row.policy_name !== "string"
      || !row.policy_name
    ) {
      throw new Error("PostgreSQL RLS policy row needs table_name and policy_name");
    }
    const selected = policiesByTable.get(row.table_name) ?? [];
    selected.push({
      command: row.command,
      name: row.policy_name,
      permissive: row.permissive,
      roles: row.roles,
      usingExpression: row.using_expression,
      withCheckExpression: row.with_check_expression,
    });
    policiesByTable.set(row.table_name, selected);
  }
  const tables = new Map();
  for (const rawRow of tableRows) {
    const row = record(rawRow, "information_schema table row");
    if (typeof row.table_name !== "string" || !row.table_name) {
      throw new Error("information_schema table row has no table_name");
    }
    const rls = rlsByTable.get(row.table_name);
    tables.set(row.table_name, {
      checks: new Map(),
      columns: new Map(),
      exclusionConstraints: new Map(),
      forceRlsEnabled: rls?.force_rls === true,
      foreignKeys: new Map(),
      indexes: new Map(),
      name: row.table_name,
      policies: policiesByTable.get(row.table_name) ?? [],
      rlsEnabled: rls?.rls_enabled === true,
      uniqueConstraints: new Map(),
    });
  }

  for (const rawRow of columnRows) {
    const row = record(rawRow, "information_schema column row");
    const table = tables.get(row.table_name);
    if (!table) {
      throw new Error(`information_schema returned a column for unknown base table public.${row.table_name}`);
    }
    if (typeof row.column_name !== "string" || !row.column_name) {
      throw new Error(`information_schema column for public.${row.table_name} has no column_name`);
    }
    table.columns.set(row.column_name, {
      default: normalizeColumnDefault(row.column_default),
      name: row.column_name,
      nullable: row.is_nullable === "YES",
      type: informationSchemaColumnType(row),
    });
  }

  for (const rawRow of foreignKeyRows) {
    const row = record(rawRow, "PostgreSQL foreign-key row");
    const table = tables.get(row.table_name);
    if (!table) throw new Error(`PostgreSQL returned a foreign key for unknown base table public.${row.table_name}`);
    if (typeof row.constraint_name !== "string" || !row.constraint_name || typeof row.table_to !== "string" || !row.table_to) {
      throw new Error(`PostgreSQL foreign key for public.${row.table_name} needs a name and target table`);
    }
    table.foreignKeys.set(row.constraint_name, {
      columnsFrom: stringArray(row.columns_from, `PostgreSQL foreign key public.${row.table_name}.${row.constraint_name} columns_from`),
      columnsTo: stringArray(row.columns_to, `PostgreSQL foreign key public.${row.table_name}.${row.constraint_name} columns_to`),
      name: row.constraint_name,
      onDelete: normalizeForeignKeyAction(row.on_delete, `PostgreSQL foreign key public.${row.table_name}.${row.constraint_name} on_delete`),
      onUpdate: normalizeForeignKeyAction(row.on_update, `PostgreSQL foreign key public.${row.table_name}.${row.constraint_name} on_update`),
      tableTo: row.table_to,
    });
  }

  for (const rawRow of checkRows) {
    const row = record(rawRow, "PostgreSQL check-constraint row");
    const table = tables.get(row.table_name);
    const expression = normalizeCheckExpression(row.expression, row.table_name, table?.columns);
    if (!table || typeof row.constraint_name !== "string" || !row.constraint_name || !expression) {
      throw new Error(`PostgreSQL check constraint for public.${row.table_name} needs a name and expression`);
    }
    table.checks.set(row.constraint_name, { expression, name: row.constraint_name });
  }

  for (const rawRow of uniqueConstraintRows) {
    const row = record(rawRow, "PostgreSQL unique-constraint row");
    const table = tables.get(row.table_name);
    if (!table || typeof row.constraint_name !== "string" || !row.constraint_name) {
      throw new Error(`PostgreSQL unique constraint for public.${row.table_name} needs a name`);
    }
    table.uniqueConstraints.set(row.constraint_name, {
      columns: stringArray(row.columns, `PostgreSQL unique constraint public.${row.table_name}.${row.constraint_name} columns`),
      name: row.constraint_name,
      nullsNotDistinct: row.nulls_not_distinct === true,
    });
  }

  for (const rawRow of exclusionConstraintRows) {
    const row = record(rawRow, "PostgreSQL exclusion-constraint row");
    const table = tables.get(row.table_name);
    if (!table || typeof row.constraint_name !== "string" || !row.constraint_name || typeof row.method !== "string") {
      throw new Error(`PostgreSQL exclusion constraint for public.${row.table_name} needs a name and method`);
    }
    if (!Array.isArray(row.elements)) throw new Error(`PostgreSQL exclusion constraint public.${row.table_name}.${row.constraint_name} needs elements`);
    table.exclusionConstraints.set(row.constraint_name, {
      elements: row.elements.map((element, position) => {
        const selected = record(element, `PostgreSQL exclusion constraint public.${row.table_name}.${row.constraint_name} element ${position}`);
        const expression = normalizeExclusionExpression(selected.expression, row.table_name);
        if (!expression || typeof selected.operator !== "string" || !selected.operator) {
          throw new Error(`PostgreSQL exclusion constraint public.${row.table_name}.${row.constraint_name} has an invalid element`);
        }
        return { expression, operator: selected.operator };
      }),
      method: row.method.toLowerCase(),
      name: row.constraint_name,
      where: normalizeIndexPredicate(row.where, row.table_name, table?.columns),
    });
  }

  for (const rawRow of indexRows) {
    const row = record(rawRow, "PostgreSQL index row");
    const table = tables.get(row.table_name);
    if (!table || typeof row.index_name !== "string" || !row.index_name) {
      throw new Error(`PostgreSQL index for public.${row.table_name} needs a name`);
    }
    table.indexes.set(row.index_name, {
      columns: normalizeIndexColumns(row.columns, `PostgreSQL index public.${row.table_name}.${row.index_name} columns`, row.table_name),
      isUnique: row.is_unique === true,
      method: typeof row.method === "string" ? row.method.toLowerCase() : "btree",
      name: row.index_name,
      nullsNotDistinct: row.nulls_not_distinct === true,
      where: normalizeIndexPredicate(row.where, row.table_name, table.columns),
    });
  }

  return { tables };
}

export function compareSchemaContracts(snapshotContract, databaseContract) {
  const expected = record(snapshotContract, "Snapshot schema contract");
  const actual = record(databaseContract, "Database schema contract");
  if (!(expected.tables instanceof Map) || !(actual.tables instanceof Map)) {
    throw new Error("Schema contracts must contain table maps");
  }

  const diagnostics = [];
  const tableNames = new Set([...expected.tables.keys(), ...actual.tables.keys()]);
  for (const tableName of [...tableNames].sort()) {
    const expectedTable = expected.tables.get(tableName);
    const actualTable = actual.tables.get(tableName);
    if (!expectedTable) {
      diagnostics.push(`[EXTRA_TABLE] public.${tableName} exists in PostgreSQL but is absent from the latest Drizzle snapshot`);
      continue;
    }
    if (!actualTable) {
      diagnostics.push(`[MISSING_TABLE] public.${tableName} is declared by the latest Drizzle snapshot but is absent from PostgreSQL`);
      continue;
    }

    const columnNames = new Set([...expectedTable.columns.keys(), ...actualTable.columns.keys()]);
    for (const columnName of [...columnNames].sort()) {
      const expectedColumn = expectedTable.columns.get(columnName);
      const actualColumn = actualTable.columns.get(columnName);
      const qualifiedName = `public.${tableName}.${columnName}`;
      if (!expectedColumn) {
        diagnostics.push(`[EXTRA_COLUMN] ${qualifiedName} exists in PostgreSQL but is absent from the latest Drizzle snapshot`);
      } else if (!actualColumn) {
        diagnostics.push(`[MISSING_COLUMN] ${qualifiedName} is declared by the latest Drizzle snapshot but is absent from PostgreSQL`);
      } else {
        if (expectedColumn.type !== actualColumn.type) {
          diagnostics.push(`[TYPE_MISMATCH] ${qualifiedName}: snapshot=${expectedColumn.type}, database=${actualColumn.type}`);
        }
        if (expectedColumn.nullable !== actualColumn.nullable) {
          diagnostics.push(
            `[NULLABILITY_MISMATCH] ${qualifiedName}: snapshot=${expectedColumn.nullable ? "NULL" : "NOT NULL"}, `
            + `database=${actualColumn.nullable ? "NULL" : "NOT NULL"}`,
          );
        }
        if (expectedColumn.default !== actualColumn.default) {
          diagnostics.push(
            `[DEFAULT_MISMATCH] ${qualifiedName}: snapshot=${String(expectedColumn.default)}, `
            + `database=${String(actualColumn.default)}`,
          );
        }
      }
    }

    const compareNamedConstraints = (kind, expectedItems, actualItems) => {
      const names = new Set([...expectedItems.keys(), ...actualItems.keys()]);
      for (const name of [...names].sort()) {
        const expectedItem = expectedItems.get(name);
        const actualItem = actualItems.get(name);
        if (!expectedItem) {
          diagnostics.push(`[EXTRA_${kind}] public.${tableName}.${name} exists in PostgreSQL but is absent from the latest Drizzle snapshot`);
        } else if (!actualItem) {
          diagnostics.push(`[MISSING_${kind}] public.${tableName}.${name} is declared by the latest Drizzle snapshot but is absent from PostgreSQL`);
        } else if (contractsDiffer(expectedItem, actualItem)) {
          diagnostics.push(`[${kind}_MISMATCH] public.${tableName}.${name} differs between the latest Drizzle snapshot and PostgreSQL`);
        }
      }
    };

    const compareChecks = (expectedChecks, actualChecks) => {
      const matchedActual = new Set();
      for (const [name, expectedCheck] of expectedChecks) {
        const namedActual = actualChecks.get(name);
        if (namedActual) {
          matchedActual.add(name);
          if (expectedCheck.expression !== namedActual.expression) {
            diagnostics.push(
              `[CHECK_MISMATCH] public.${tableName}.${name} differs between the latest Drizzle snapshot and PostgreSQL: `
              + `snapshot=${JSON.stringify(expectedCheck.expression)}, database=${JSON.stringify(namedActual.expression)}`,
            );
          }
          continue;
        }
        if (expectedCheck.generated === true) {
          const matched = [...actualChecks.entries()].find(([actualName, actualCheck]) => (
            !matchedActual.has(actualName) && actualCheck.expression === expectedCheck.expression
          ));
          if (matched) {
            matchedActual.add(matched[0]);
            continue;
          }
        }
        diagnostics.push(`[MISSING_CHECK] public.${tableName}.${name} is declared by the latest Drizzle snapshot but is absent from PostgreSQL`);
      }
      for (const [name] of actualChecks) {
        if (!matchedActual.has(name) && !expectedChecks.has(name)) {
          diagnostics.push(`[EXTRA_CHECK] public.${tableName}.${name} exists in PostgreSQL but is absent from the latest Drizzle snapshot`);
        }
      }
    };

    const matchedForeignKeys = new Set();
    for (const [name, expectedForeignKey] of expectedTable.foreignKeys) {
      const namedActual = actualTable.foreignKeys.get(name);
      if (namedActual) {
        matchedForeignKeys.add(name);
        if (contractsDiffer(expectedForeignKey, namedActual)) {
          diagnostics.push(`[FOREIGN_KEY_MISMATCH] public.${tableName}.${name} differs between the latest Drizzle snapshot and PostgreSQL`);
        }
        continue;
      }
      const matchingActual = [...actualTable.foreignKeys.entries()].find(([, actualForeignKey]) => (
        !matchedForeignKeys.has(actualForeignKey.name)
        && foreignKeySemantics(expectedForeignKey) === foreignKeySemantics(actualForeignKey)
      ));
      if (matchingActual) {
        matchedForeignKeys.add(matchingActual[0]);
      } else {
        diagnostics.push(`[MISSING_FOREIGN_KEY] public.${tableName}.${name} is declared by the latest Drizzle snapshot but is absent from PostgreSQL`);
      }
    }
    for (const [name] of actualTable.foreignKeys) {
      if (!matchedForeignKeys.has(name) && !expectedTable.foreignKeys.has(name)) {
        diagnostics.push(`[EXTRA_FOREIGN_KEY] public.${tableName}.${name} exists in PostgreSQL but is absent from the latest Drizzle snapshot`);
      }
    }
    compareChecks(expectedTable.checks, actualTable.checks);
    compareNamedConstraints("EXCLUSION_CONSTRAINT", expectedTable.exclusionConstraints ?? new Map(), actualTable.exclusionConstraints ?? new Map());
    compareNamedConstraints("UNIQUE_CONSTRAINT", expectedTable.uniqueConstraints, actualTable.uniqueConstraints);
    compareNamedConstraints("INDEX", expectedTable.indexes, actualTable.indexes);

    if (expectedTable.forceRls) {
      if (!actualTable.rlsEnabled) {
        diagnostics.push(`[RLS_DISABLED] public.${tableName} must have row-level security enabled`);
      }
      if (!actualTable.forceRlsEnabled) {
        diagnostics.push(`[RLS_NOT_FORCED] public.${tableName} must use FORCE ROW LEVEL SECURITY`);
      }
      const policies = Array.isArray(actualTable.policies) ? actualTable.policies : [];
      const expectedPolicy = expectedRlsPolicy(expectedTable);
      if (policies.length === 0) {
        diagnostics.push(
          `[RLS_POLICY_MISSING] public.${tableName} must define at least one explicit row-level security policy`,
        );
        continue;
      }
      if (policies.length !== 1) {
        diagnostics.push(
          `[RLS_POLICY_COUNT] public.${tableName} must define exactly one reviewed RLS policy; found ${policies.length}`,
        );
      }

      const matchingPolicy = policies.find((policy) => policy.name === expectedPolicy.name);
      for (const policy of policies) {
        if (policy.name !== expectedPolicy.name) {
          diagnostics.push(
            `[RLS_POLICY_EXTRA] public.${tableName} has unreviewed RLS policy ${String(policy.name)}`,
          );
        }
      }
      if (!matchingPolicy) {
        diagnostics.push(
          `[RLS_POLICY_EXPECTED_MISSING] public.${tableName} must define reviewed RLS policy ${expectedPolicy.name}`,
        );
        continue;
      }
      if (matchingPolicy.command !== expectedPolicy.command) {
        diagnostics.push(
          `[RLS_POLICY_COMMAND] public.${tableName}.${expectedPolicy.name} must use FOR ${expectedPolicy.command}; found ${String(matchingPolicy.command)}`,
        );
      }
      if (matchingPolicy.permissive !== expectedPolicy.permissive) {
        diagnostics.push(
          `[RLS_POLICY_PERMISSIVE] public.${tableName}.${expectedPolicy.name} must be permissive=${expectedPolicy.permissive}`,
        );
      }
      if (!Array.isArray(matchingPolicy.roles)
        || matchingPolicy.roles.length !== 1
        || matchingPolicy.roles[0] !== expectedPolicy.roles[0]) {
        diagnostics.push(
          `[RLS_POLICY_ROLES] public.${tableName}.${expectedPolicy.name} must apply only to PUBLIC`,
        );
      }
      if (normalizeRlsPolicyExpression(matchingPolicy.usingExpression)
        !== normalizeRlsPolicyExpression(expectedPolicy.usingExpression)) {
        diagnostics.push(
          `[RLS_POLICY_USING] public.${tableName}.${expectedPolicy.name} USING predicate differs from the reviewed contract`,
        );
      }
      if (normalizeRlsPolicyExpression(matchingPolicy.withCheckExpression)
        !== normalizeRlsPolicyExpression(expectedPolicy.withCheckExpression)) {
        diagnostics.push(
          `[RLS_POLICY_WITH_CHECK] public.${tableName}.${expectedPolicy.name} WITH CHECK predicate differs from the reviewed contract`,
        );
      }
    }
  }

  return diagnostics.sort();
}

function addExpectedPrivileges(matrix, relationName, privileges) {
  const selected = matrix.get(relationName) ?? new Set();
  for (const privilege of privileges) selected.add(privilege);
  matrix.set(relationName, selected);
}

export function buildExpectedRuntimeGrantContract() {
  const grants = new Map();
  for (const relationName of runtimeSelectRelations) {
    addExpectedPrivileges(grants, relationName, ["SELECT"]);
  }
  for (const relationName of runtimeInsertUpdateRelations) {
    addExpectedPrivileges(grants, relationName, ["INSERT", "UPDATE"]);
  }
  for (const relationName of runtimeInsertRelations) {
    addExpectedPrivileges(grants, relationName, ["INSERT"]);
  }
  addExpectedPrivileges(grants, "fiscal_periods", ["UPDATE"]);
  const functionGrants = new Map(
    runtimeExecuteFunctions.map((signature) => [signature, new Set(["EXECUTE"])]),
  );
  return { functionGrants, grants, roleName: runtimeRoleName };
}

function normalizedPrivilege(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty privilege name`);
  }
  return value.trim().toUpperCase();
}

export function buildDatabaseRuntimeGrantContract({
  roleRows,
  relationRows,
  grantRows,
  effectiveGrantRows = grantRows,
  publicGrantRows = [],
  membershipRows = [],
  columnGrantRows = [],
  publicColumnGrantRows = [],
  functionRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  functionGrantRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  effectiveFunctionGrantRows = functionGrantRows,
  publicFunctionGrantRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  defaultPrivilegeRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  databasePrivilegeRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  schemaPrivilegeRows = /** @type {Array<Record<string, unknown>>} */ ([]),
  unsafeObjectGrantRows = /** @type {Array<Record<string, unknown>>} */ ([]),
}) {
  if (
    !Array.isArray(roleRows)
    || !Array.isArray(relationRows)
    || !Array.isArray(grantRows)
    || !Array.isArray(effectiveGrantRows)
    || !Array.isArray(publicGrantRows)
    || !Array.isArray(membershipRows)
    || !Array.isArray(columnGrantRows)
    || !Array.isArray(publicColumnGrantRows)
    || !Array.isArray(functionRows)
    || !Array.isArray(functionGrantRows)
    || !Array.isArray(effectiveFunctionGrantRows)
    || !Array.isArray(publicFunctionGrantRows)
    || !Array.isArray(defaultPrivilegeRows)
    || !Array.isArray(databasePrivilegeRows)
    || !Array.isArray(schemaPrivilegeRows)
    || !Array.isArray(unsafeObjectGrantRows)
  ) {
    throw new Error(
      "Runtime grant metadata must provide role, relation/function, direct/effective/public grant, membership, and column-grant arrays",
    );
  }

  const selectedRoleRow = roleRows.find((rawRow) => {
    const row = record(rawRow, "PostgreSQL runtime-role row");
    return row.role_name === runtimeRoleName;
  });
  const roleExists = selectedRoleRow !== undefined;
  const unsafeRoleAttributes = [];
  if (selectedRoleRow) {
    const row = record(selectedRoleRow, "PostgreSQL runtime-role row");
    const expectedAttributes = {
      can_bypass_rls: false,
      can_create_database: false,
      can_create_role: false,
      can_login: true,
      can_replicate: false,
      connection_limit: 20,
      inherits_privileges: false,
      is_superuser: false,
    };
    for (const [attribute, expectedValue] of Object.entries(expectedAttributes)) {
      const actualValue = attribute === "connection_limit"
        ? Number(row[attribute])
        : row[attribute];
      if (actualValue !== expectedValue) {
        unsafeRoleAttributes.push({ actualValue, attribute, expectedValue });
      }
    }
  }
  const relations = new Set(relationRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL relation row");
    if (typeof row.relation_name !== "string" || !row.relation_name) {
      throw new Error("PostgreSQL relation row has no relation_name");
    }
    return row.relation_name;
  }));
  const grants = new Map();
  for (const rawRow of grantRows) {
    const row = record(rawRow, "PostgreSQL runtime table-grant row");
    if (typeof row.relation_name !== "string" || !row.relation_name) {
      throw new Error("PostgreSQL runtime table-grant row has no relation_name");
    }
    const privilege = normalizedPrivilege(row.privilege_type, "Runtime table privilege");
    const selected = grants.get(row.relation_name) ?? new Set();
    selected.add(privilege);
    grants.set(row.relation_name, selected);
  }

  const effectiveGrants = new Map();
  const grantOptions = [];
  for (const rawRow of effectiveGrantRows) {
    const row = record(rawRow, "PostgreSQL effective runtime table-grant row");
    if (typeof row.relation_name !== "string" || !row.relation_name) {
      throw new Error("PostgreSQL effective runtime table-grant row has no relation_name");
    }
    const privilege = normalizedPrivilege(row.privilege_type, "Effective runtime table privilege");
    const selected = effectiveGrants.get(row.relation_name) ?? new Set();
    selected.add(privilege);
    effectiveGrants.set(row.relation_name, selected);
    if (row.is_grantable === true) {
      grantOptions.push({ privilege, relationName: row.relation_name });
    }
  }

  const publicGrants = publicGrantRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL PUBLIC table-grant row");
    if (typeof row.relation_name !== "string" || !row.relation_name) {
      throw new Error("PostgreSQL PUBLIC table-grant row has no relation_name");
    }
    return {
      privilege: normalizedPrivilege(row.privilege_type, "PUBLIC table privilege"),
      relationName: row.relation_name,
    };
  });

  const memberships = membershipRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL runtime-role membership row");
    if (
      typeof row.granted_role_name !== "string"
      || !row.granted_role_name
      || typeof row.member_role_name !== "string"
      || !row.member_role_name
    ) {
      throw new Error("PostgreSQL runtime-role membership row needs granted_role_name and member_role_name");
    }
    return {
      grantedRoleName: row.granted_role_name,
      memberRoleName: row.member_role_name,
    };
  });

  const columnGrants = columnGrantRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL runtime column-grant row");
    if (
      typeof row.relation_name !== "string"
      || !row.relation_name
      || typeof row.column_name !== "string"
      || !row.column_name
    ) {
      throw new Error("PostgreSQL runtime column-grant row needs relation_name and column_name");
    }
    return {
      columnName: row.column_name,
      isGrantable: row.is_grantable === true,
      privilege: normalizedPrivilege(row.privilege_type, "Runtime column privilege"),
      relationName: row.relation_name,
    };
  });
  const publicColumnGrants = publicColumnGrantRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL PUBLIC column-grant row");
    if (
      typeof row.relation_name !== "string"
      || !row.relation_name
      || typeof row.column_name !== "string"
      || !row.column_name
    ) {
      throw new Error("PostgreSQL PUBLIC column-grant row needs relation_name and column_name");
    }
    return {
      columnName: row.column_name,
      privilege: normalizedPrivilege(row.privilege_type, "PUBLIC column privilege"),
      relationName: row.relation_name,
    };
  });

  const functions = new Set(functionRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL function row");
    if (typeof row.function_signature !== "string" || !row.function_signature) {
      throw new Error("PostgreSQL function row has no function_signature");
    }
    return row.function_signature;
  }));
  const functionGrants = new Map();
  for (const rawRow of functionGrantRows) {
    const row = record(rawRow, "PostgreSQL runtime function-grant row");
    if (typeof row.function_signature !== "string" || !row.function_signature) {
      throw new Error("PostgreSQL runtime function-grant row has no function_signature");
    }
    const privilege = normalizedPrivilege(row.privilege_type, "Runtime function privilege");
    const selected = functionGrants.get(row.function_signature) ?? new Set();
    selected.add(privilege);
    functionGrants.set(row.function_signature, selected);
  }
  const effectiveFunctionGrants = new Map();
  const functionGrantOptions = [];
  for (const rawRow of effectiveFunctionGrantRows) {
    const row = record(rawRow, "PostgreSQL effective runtime function-grant row");
    if (typeof row.function_signature !== "string" || !row.function_signature) {
      throw new Error("PostgreSQL effective runtime function-grant row has no function_signature");
    }
    const privilege = normalizedPrivilege(row.privilege_type, "Effective runtime function privilege");
    const selected = effectiveFunctionGrants.get(row.function_signature) ?? new Set();
    selected.add(privilege);
    effectiveFunctionGrants.set(row.function_signature, selected);
    if (row.is_grantable === true) {
      functionGrantOptions.push({ privilege, signature: row.function_signature });
    }
  }
  const publicFunctionGrants = publicFunctionGrantRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL PUBLIC function-grant row");
    if (typeof row.function_signature !== "string" || !row.function_signature) {
      throw new Error("PostgreSQL PUBLIC function-grant row has no function_signature");
    }
    return {
      privilege: normalizedPrivilege(row.privilege_type, "PUBLIC function privilege"),
      signature: row.function_signature,
    };
  });
  const unsafeDefaultPrivileges = defaultPrivilegeRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL default-privilege row");
    for (const key of [
      "owner_role_name",
      "scope_name",
      "object_type",
      "grantee_name",
    ]) {
      if (typeof row[key] !== "string" || !row[key]) {
        throw new Error(`PostgreSQL default-privilege row has no ${key}`);
      }
    }
    return {
      granteeName: row.grantee_name,
      objectType: row.object_type,
      ownerRoleName: row.owner_role_name,
      privilege: normalizedPrivilege(
        row.privilege_type,
        "PostgreSQL default privilege",
      ),
      scopeName: row.scope_name,
    };
  });
  const databasePrivileges = databasePrivilegeRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL database-privilege row");
    if (typeof row.grantee_name !== "string" || !row.grantee_name) {
      throw new Error("PostgreSQL database-privilege row has no grantee_name");
    }
    return {
      granteeName: row.grantee_name,
      isGrantable: row.is_grantable === true,
      privilege: normalizedPrivilege(row.privilege_type, "PostgreSQL database privilege"),
    };
  });
  const schemaPrivileges = schemaPrivilegeRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL schema-privilege row");
    if (
      typeof row.schema_name !== "string"
      || !row.schema_name
      || typeof row.grantee_name !== "string"
      || !row.grantee_name
    ) {
      throw new Error("PostgreSQL schema-privilege row needs schema_name and grantee_name");
    }
    return {
      granteeName: row.grantee_name,
      isGrantable: row.is_grantable === true,
      privilege: normalizedPrivilege(row.privilege_type, "PostgreSQL schema privilege"),
      schemaName: row.schema_name,
    };
  });
  const unsafeObjectGrants = unsafeObjectGrantRows.map((rawRow) => {
    const row = record(rawRow, "PostgreSQL unreviewed-object-grant row");
    for (const key of ["object_identity", "object_kind", "grantee_name"]) {
      if (typeof row[key] !== "string" || !row[key]) {
        throw new Error(`PostgreSQL unreviewed-object-grant row has no ${key}`);
      }
    }
    return {
      granteeName: row.grantee_name,
      isGrantable: row.is_grantable === true,
      objectIdentity: row.object_identity,
      objectKind: row.object_kind,
      privilege: normalizedPrivilege(row.privilege_type, "PostgreSQL unreviewed object privilege"),
    };
  });

  return {
    columnGrants,
    databasePrivileges,
    effectiveGrants,
    effectiveFunctionGrants,
    functionGrantOptions,
    functionGrants,
    functions,
    grantOptions,
    grants,
    memberships,
    publicGrants,
    publicColumnGrants,
    publicFunctionGrants,
    relations,
    roleExists,
    roleName: runtimeRoleName,
    schemaPrivileges,
    unsafeDefaultPrivileges,
    unsafeObjectGrants,
    unsafeRoleAttributes,
  };
}

export function compareRuntimeGrantContracts(
  databaseGrantContract,
  expectedGrantContract = buildExpectedRuntimeGrantContract(),
) {
  const actual = record(databaseGrantContract, "Database runtime-grant contract");
  const expected = record(expectedGrantContract, "Expected runtime-grant contract");
  if (
    !(actual.grants instanceof Map)
    || !(actual.effectiveGrants instanceof Map)
    || !(actual.functionGrants instanceof Map)
    || !(actual.effectiveFunctionGrants instanceof Map)
    || !(actual.relations instanceof Set)
    || !(actual.functions instanceof Set)
    || !(expected.grants instanceof Map)
    || !(expected.functionGrants instanceof Map)
    || !Array.isArray(actual.grantOptions)
    || !Array.isArray(actual.functionGrantOptions)
    || !Array.isArray(actual.columnGrants)
    || !Array.isArray(actual.publicGrants)
    || !Array.isArray(actual.publicColumnGrants)
    || !Array.isArray(actual.publicFunctionGrants)
    || !Array.isArray(actual.memberships)
    || !Array.isArray(actual.unsafeDefaultPrivileges)
    || !Array.isArray(actual.databasePrivileges)
    || !Array.isArray(actual.schemaPrivileges)
    || !Array.isArray(actual.unsafeObjectGrants)
    || !Array.isArray(actual.unsafeRoleAttributes)
  ) {
    throw new Error("Runtime grant contracts have invalid relation or privilege collections");
  }
  if (!actual.roleExists) {
    return [
      `[MISSING_ROLE] PostgreSQL role ${expected.roleName} does not exist; run the reviewed runtime-role reconciler`,
    ];
  }

  const diagnostics = [];
  for (const item of actual.unsafeRoleAttributes) {
    diagnostics.push(
      `[UNSAFE_ROLE_ATTRIBUTE] ${expected.roleName}.${item.attribute} is ${String(item.actualValue)}; `
      + `expected ${String(item.expectedValue)}`,
    );
  }

  const expectedDatabasePrivileges = new Set([`${expected.roleName}|CONNECT`]);
  const actualDatabasePrivileges = new Set(actual.databasePrivileges.map(
    (item) => `${item.granteeName}|${item.privilege}`,
  ));
  for (const expectedPrivilege of expectedDatabasePrivileges) {
    if (!actualDatabasePrivileges.has(expectedPrivilege)) {
      diagnostics.push(`[MISSING_DATABASE_GRANT] expected ${expectedPrivilege.replace("|", " ")}`);
    }
  }
  for (const item of actual.databasePrivileges) {
    const key = `${item.granteeName}|${item.privilege}`;
    if (!expectedDatabasePrivileges.has(key)) {
      diagnostics.push(
        `[UNSAFE_DATABASE_GRANT] ${item.granteeName} has ${item.privilege} on the application database`,
      );
    }
    if (item.isGrantable) {
      diagnostics.push(
        `[UNSAFE_DATABASE_GRANT_OPTION] ${item.granteeName} can re-grant ${item.privilege} on the application database`,
      );
    }
  }

  const expectedSchemaPrivileges = new Set([
    `${expected.roleName}|public|USAGE`,
    `${expected.roleName}|app|USAGE`,
  ]);
  const actualSchemaPrivileges = new Set(actual.schemaPrivileges.map(
    (item) => `${item.granteeName}|${item.schemaName}|${item.privilege}`,
  ));
  for (const expectedPrivilege of expectedSchemaPrivileges) {
    if (!actualSchemaPrivileges.has(expectedPrivilege)) {
      diagnostics.push(`[MISSING_SCHEMA_GRANT] expected ${expectedPrivilege.replaceAll("|", " ")}`);
    }
  }
  for (const item of actual.schemaPrivileges) {
    const key = `${item.granteeName}|${item.schemaName}|${item.privilege}`;
    if (!expectedSchemaPrivileges.has(key)) {
      diagnostics.push(
        `[UNSAFE_SCHEMA_GRANT] ${item.granteeName} has ${item.privilege} on schema ${item.schemaName}`,
      );
    }
    if (item.isGrantable) {
      diagnostics.push(
        `[UNSAFE_SCHEMA_GRANT_OPTION] ${item.granteeName} can re-grant ${item.privilege} on schema ${item.schemaName}`,
      );
    }
  }
  for (const item of actual.unsafeObjectGrants) {
    diagnostics.push(
      `[UNSAFE_OBJECT_GRANT] ${item.granteeName} has ${item.privilege} on `
      + `${item.objectKind} ${item.objectIdentity}`,
    );
    if (item.isGrantable) {
      diagnostics.push(
        `[UNSAFE_OBJECT_GRANT_OPTION] ${item.granteeName} can re-grant ${item.privilege} on `
        + `${item.objectKind} ${item.objectIdentity}`,
      );
    }
  }

  for (const relationName of [...expected.grants.keys()].sort()) {
    if (!actual.relations.has(relationName)) {
      diagnostics.push(
        `[MISSING_GRANT_RELATION] public.${relationName} is required by the ${expected.roleName} grant matrix but does not exist`,
      );
    }
  }

  const relationNames = new Set([...expected.grants.keys(), ...actual.grants.keys()]);
  for (const relationName of [...relationNames].sort()) {
    if (!actual.relations.has(relationName)) continue;
    const expectedPrivileges = expected.grants.get(relationName) ?? new Set();
    const actualPrivileges = actual.grants.get(relationName) ?? new Set();
    for (const privilege of [...expectedPrivileges].sort()) {
      if (!actualPrivileges.has(privilege)) {
        diagnostics.push(
          `[MISSING_GRANT] ${expected.roleName} needs direct ${privilege} on public.${relationName}`,
        );
      }
    }
    for (const privilege of [...actualPrivileges].sort()) {
      if (expectedPrivileges.has(privilege)) continue;
      const code = universallyUnsafeTablePrivileges.has(privilege)
        ? "UNSAFE_GRANT"
        : "EXTRA_GRANT";
      diagnostics.push(
        `[${code}] ${expected.roleName} has unreviewed direct ${privilege} on public.${relationName}`,
      );
    }
  }

  for (const [relationName, privileges] of actual.effectiveGrants) {
    const expectedPrivileges = expected.grants.get(relationName) ?? new Set();
    const directPrivileges = actual.grants.get(relationName) ?? new Set();
    for (const privilege of privileges) {
      if (expectedPrivileges.has(privilege) || directPrivileges.has(privilege)) continue;
      diagnostics.push(
        `[UNSAFE_EFFECTIVE_GRANT] ${expected.roleName} inherits unreviewed ${privilege} on public.${relationName}`,
      );
    }
  }

  for (const item of actual.publicGrants) {
    diagnostics.push(
      `[PUBLIC_GRANT] PUBLIC has ${item.privilege} on public.${item.relationName}; runtime access must be explicit`,
    );
  }
  for (const item of actual.publicColumnGrants) {
    diagnostics.push(
      `[PUBLIC_COLUMN_GRANT] PUBLIC has ${item.privilege} on public.${item.relationName}.${item.columnName}; runtime access must be explicit`,
    );
  }
  for (const item of actual.memberships) {
    diagnostics.push(
      `[UNSAFE_ROLE_MEMBERSHIP] ${item.grantedRoleName} -> ${item.memberRoleName} creates an unreviewed runtime privilege path`,
    );
  }

  for (const signature of [...expected.functionGrants.keys()].sort()) {
    if (!actual.functions.has(signature)) {
      diagnostics.push(
        `[MISSING_GRANT_FUNCTION] ${signature} is required by the ${expected.roleName} function grant matrix but does not exist`,
      );
    }
  }
  const functionSignatures = new Set([
    ...expected.functionGrants.keys(),
    ...actual.functionGrants.keys(),
  ]);
  for (const signature of [...functionSignatures].sort()) {
    if (!actual.functions.has(signature)) continue;
    const expectedPrivileges = expected.functionGrants.get(signature) ?? new Set();
    const actualPrivileges = actual.functionGrants.get(signature) ?? new Set();
    for (const privilege of [...expectedPrivileges].sort()) {
      if (!actualPrivileges.has(privilege)) {
        diagnostics.push(
          `[MISSING_FUNCTION_GRANT] ${expected.roleName} needs direct ${privilege} on ${signature}`,
        );
      }
    }
    for (const privilege of [...actualPrivileges].sort()) {
      if (expectedPrivileges.has(privilege)) continue;
      diagnostics.push(
        `[EXTRA_FUNCTION_GRANT] ${expected.roleName} has unreviewed direct ${privilege} on ${signature}`,
      );
    }
  }
  for (const [signature, privileges] of actual.effectiveFunctionGrants) {
    const expectedPrivileges = expected.functionGrants.get(signature) ?? new Set();
    const directPrivileges = actual.functionGrants.get(signature) ?? new Set();
    for (const privilege of privileges) {
      if (expectedPrivileges.has(privilege) || directPrivileges.has(privilege)) continue;
      diagnostics.push(
        `[UNSAFE_EFFECTIVE_FUNCTION_GRANT] ${expected.roleName} inherits unreviewed ${privilege} on ${signature}`,
      );
    }
  }
  for (const item of actual.publicFunctionGrants) {
    diagnostics.push(
      `[PUBLIC_FUNCTION_GRANT] PUBLIC has ${item.privilege} on ${item.signature}; runtime access must be explicit`,
    );
  }
  for (const item of actual.functionGrantOptions) {
    diagnostics.push(
      `[UNSAFE_FUNCTION_GRANT_OPTION] ${expected.roleName} can re-grant ${item.privilege} on ${item.signature}`,
    );
  }
  for (const item of actual.unsafeDefaultPrivileges) {
    diagnostics.push(
      `[UNSAFE_DEFAULT_PRIVILEGE] ${item.granteeName} receives ${item.privilege} on future `
      + `${item.objectType} objects in ${item.scopeName} defaults owned by ${item.ownerRoleName}`,
    );
  }

  for (const item of actual.grantOptions) {
    diagnostics.push(
      `[UNSAFE_GRANT_OPTION] ${expected.roleName} can re-grant ${item.privilege} on public.${item.relationName}`,
    );
  }
  for (const item of actual.columnGrants) {
    diagnostics.push(
      `[UNSAFE_COLUMN_GRANT] ${expected.roleName} has unreviewed direct ${item.privilege} `
      + `on public.${item.relationName}.${item.columnName}`,
    );
  }

  return diagnostics.sort();
}

export async function readDatabaseSchemaContract(client) {
  const tableResult = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const columnResult = await client.query(
    `SELECT column_definition.table_name, column_definition.column_name, column_definition.is_nullable,
            column_definition.data_type, column_definition.udt_schema, column_definition.udt_name,
            column_definition.domain_schema, column_definition.domain_name,
            column_definition.character_maximum_length, column_definition.numeric_precision,
            column_definition.numeric_scale, column_definition.datetime_precision, column_definition.column_default
       FROM information_schema.columns column_definition
       JOIN information_schema.tables selected_table
         ON selected_table.table_schema = column_definition.table_schema
        AND selected_table.table_name = column_definition.table_name
        AND selected_table.table_type = 'BASE TABLE'
      WHERE column_definition.table_schema = 'public'
      ORDER BY column_definition.table_name, column_definition.ordinal_position`,
  );
  const rlsResult = await client.query(
    `SELECT relation.relname AS table_name,
            relation.relrowsecurity AS rls_enabled,
            relation.relforcerowsecurity AS force_rls
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname`,
  );
  const policyResult = await client.query(
    `SELECT relation.relname AS table_name,
            policy.polname AS policy_name,
            CASE policy.polcmd
              WHEN '*' THEN 'ALL'
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
            END AS command,
            policy.polpermissive AS permissive,
            ARRAY(
              SELECT CASE
                WHEN selected_role_oid = 0 THEN 'PUBLIC'
                ELSE selected_role.rolname::text
              END
              FROM unnest(policy.polroles) AS selected_role_oid
              LEFT JOIN pg_catalog.pg_roles selected_role
                ON selected_role.oid = selected_role_oid
              ORDER BY CASE WHEN selected_role_oid = 0 THEN 'PUBLIC' ELSE selected_role.rolname END
            ) AS roles,
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS with_check_expression
       FROM pg_catalog.pg_policy policy
       JOIN pg_catalog.pg_class relation ON relation.oid = policy.polrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
      ORDER BY relation.relname, policy.polname`,
  );
  const foreignKeyResult = await client.query(
    `SELECT source_relation.relname AS table_name,
            constraint_definition.conname AS constraint_name,
            target_relation.relname AS table_to,
            array_agg(source_attribute.attname::text ORDER BY source_key.ordinality) AS columns_from,
            array_agg(target_attribute.attname::text ORDER BY target_key.ordinality) AS columns_to,
            constraint_definition.confdeltype::text AS on_delete,
            constraint_definition.confupdtype::text AS on_update
       FROM pg_catalog.pg_constraint constraint_definition
       JOIN pg_catalog.pg_class source_relation ON source_relation.oid = constraint_definition.conrelid
       JOIN pg_catalog.pg_namespace source_namespace ON source_namespace.oid = source_relation.relnamespace
       JOIN pg_catalog.pg_class target_relation ON target_relation.oid = constraint_definition.confrelid
       JOIN unnest(constraint_definition.conkey) WITH ORDINALITY AS source_key(attribute_number, ordinality) ON true
       JOIN unnest(constraint_definition.confkey) WITH ORDINALITY AS target_key(attribute_number, ordinality)
         ON target_key.ordinality = source_key.ordinality
       JOIN pg_catalog.pg_attribute source_attribute
         ON source_attribute.attrelid = constraint_definition.conrelid AND source_attribute.attnum = source_key.attribute_number
       JOIN pg_catalog.pg_attribute target_attribute
         ON target_attribute.attrelid = constraint_definition.confrelid AND target_attribute.attnum = target_key.attribute_number
      WHERE source_namespace.nspname = 'public'
        AND constraint_definition.contype = 'f'
      GROUP BY source_relation.relname, constraint_definition.conname, target_relation.relname,
               constraint_definition.confdeltype, constraint_definition.confupdtype
      ORDER BY source_relation.relname, constraint_definition.conname`,
  );
  const checkResult = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_definition.conname AS constraint_name,
            pg_catalog.pg_get_expr(constraint_definition.conbin, constraint_definition.conrelid) AS expression
       FROM pg_catalog.pg_constraint constraint_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_definition.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND constraint_definition.contype = 'c'
      ORDER BY relation.relname, constraint_definition.conname`,
  );
  const uniqueConstraintResult = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_definition.conname AS constraint_name,
            array_agg(attribute.attname::text ORDER BY constraint_key.ordinality) AS columns,
            index_definition.indnullsnotdistinct AS nulls_not_distinct
       FROM pg_catalog.pg_constraint constraint_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_definition.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_index index_definition ON index_definition.indexrelid = constraint_definition.conindid
       JOIN unnest(constraint_definition.conkey) WITH ORDINALITY AS constraint_key(attribute_number, ordinality) ON true
       JOIN pg_catalog.pg_attribute attribute
         ON attribute.attrelid = constraint_definition.conrelid AND attribute.attnum = constraint_key.attribute_number
      WHERE namespace.nspname = 'public'
        AND constraint_definition.contype = 'u'
      GROUP BY relation.relname, constraint_definition.conname, index_definition.indnullsnotdistinct
      ORDER BY relation.relname, constraint_definition.conname`,
  );
  const exclusionConstraintResult = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_definition.conname AS constraint_name,
            access_method.amname AS method,
            pg_catalog.pg_get_expr(index_definition.indpred, index_definition.indrelid) AS "where",
            jsonb_agg(
              jsonb_build_object(
                'expression', pg_catalog.pg_get_indexdef(index_relation.oid, key_position.position, true),
                'operator', operator.oprname
              )
              ORDER BY key_position.position
            ) AS elements
       FROM pg_catalog.pg_constraint constraint_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_definition.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_index index_definition ON index_definition.indexrelid = constraint_definition.conindid
       JOIN pg_catalog.pg_class index_relation ON index_relation.oid = constraint_definition.conindid
       JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
       JOIN generate_subscripts(constraint_definition.conexclop, 1) AS key_position(position) ON true
       JOIN pg_catalog.pg_operator operator ON operator.oid = constraint_definition.conexclop[key_position.position]
      WHERE namespace.nspname = 'public'
        AND constraint_definition.contype = 'x'
      GROUP BY relation.relname, constraint_definition.conname, access_method.amname,
               index_definition.indpred, index_definition.indrelid
      ORDER BY relation.relname, constraint_definition.conname`,
  );
  const indexResult = await client.query(
    `SELECT relation.relname AS table_name,
            index_relation.relname AS index_name,
            index_definition.indisunique AS is_unique,
            index_definition.indnullsnotdistinct AS nulls_not_distinct,
            access_method.amname AS method,
            pg_catalog.pg_get_expr(index_definition.indpred, index_definition.indrelid) AS "where",
            jsonb_agg(
              jsonb_build_object(
                'expression', pg_catalog.pg_get_indexdef(index_relation.oid, key_position.position + 1, true),
                'isExpression', index_definition.indkey[key_position.position] = 0,
                'asc', (index_definition.indoption[key_position.position] & 1) = 0,
                'nulls', CASE WHEN (index_definition.indoption[key_position.position] & 2) <> 0 THEN 'first' ELSE 'last' END
              )
              ORDER BY key_position.position
            ) AS columns
       FROM pg_catalog.pg_index index_definition
       JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_definition.indexrelid
       JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
       JOIN generate_series(0, index_definition.indnkeyatts - 1) AS key_position(position) ON true
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint constraint_definition
           WHERE constraint_definition.conindid = index_relation.oid
             AND constraint_definition.contype IN ('p', 'x')
        )
      GROUP BY relation.relname, index_relation.relname, index_definition.indisunique, index_definition.indnullsnotdistinct,
               access_method.amname, index_definition.indpred, index_definition.indrelid
      ORDER BY relation.relname, index_relation.relname`,
  );
  return buildDatabaseSchemaContract({
    tableRows: tableResult.rows,
    columnRows: columnResult.rows,
    rlsRows: rlsResult.rows,
    policyRows: policyResult.rows,
    foreignKeyRows: foreignKeyResult.rows,
    checkRows: checkResult.rows,
    uniqueConstraintRows: uniqueConstraintResult.rows,
    exclusionConstraintRows: exclusionConstraintResult.rows,
    indexRows: indexResult.rows,
  });
}

export async function readDatabaseRuntimeGrantContract(client) {
  const roleResult = await client.query(
    `SELECT rolname AS role_name,
            rolcanlogin AS can_login,
            rolbypassrls AS can_bypass_rls,
            rolsuper AS is_superuser,
            rolcreatedb AS can_create_database,
            rolcreaterole AS can_create_role,
            rolreplication AS can_replicate,
            rolinherit AS inherits_privileges,
            rolconnlimit AS connection_limit
       FROM pg_catalog.pg_roles
      WHERE rolname = 'business_finlynq_app'`,
  );
  const databasePrivilegeResult = await client.query(
    `SELECT CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE selected_role.rolname
            END AS grantee_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_database database
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN database.datacl IS NULL THEN pg_catalog.acldefault('d'::"char", database.datdba)
             WHEN pg_catalog.array_ndims(database.datacl) = 1 THEN database.datacl
             ELSE NULL::aclitem[] END
      ) privilege
      WHERE database.datname = current_database()
        AND privilege.grantee IN (0, selected_role.oid)
      ORDER BY grantee_name, privilege.privilege_type`,
  );
  const schemaPrivilegeResult = await client.query(
    `SELECT namespace.nspname AS schema_name,
            CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE selected_role.rolname
            END AS grantee_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_namespace namespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN namespace.nspacl IS NULL THEN pg_catalog.acldefault('n'::"char", namespace.nspowner)
             WHEN pg_catalog.array_ndims(namespace.nspacl) = 1 THEN namespace.nspacl
             ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND privilege.grantee IN (0, selected_role.oid)
      ORDER BY namespace.nspname, grantee_name, privilege.privilege_type`,
  );
  const unsafeObjectGrantResult = await client.query(
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS object_identity,
            CASE relation.relkind
              WHEN 'S' THEN 'sequence'
              WHEN 'r' THEN 'table'
              WHEN 'p' THEN 'partitioned table'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              WHEN 'f' THEN 'foreign table'
            END AS object_kind,
            CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE selected_role.rolname
            END AS grantee_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN relation.relacl IS NULL THEN pg_catalog.acldefault(
          CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation.relowner
        ) WHEN pg_catalog.array_ndims(relation.relacl) = 1 THEN relation.relacl
          ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND (
          relation.relkind = 'S'
          OR (
            namespace.nspname = 'app'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          )
        )
        AND privilege.grantee IN (0, selected_role.oid)
      ORDER BY object_identity, grantee_name, privilege.privilege_type`,
  );
  const relationResult = await client.query(
    `SELECT relation.relname AS relation_name
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY relation.relname`,
  );
  const grantResult = await client.query(
    `SELECT relation.relname AS relation_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(relation.relacl) = 1 THEN relation.relacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND privilege.grantee = selected_role.oid
       ORDER BY relation.relname, privilege.privilege_type`,
  );
  const effectiveGrantResult = await client.query(
    `SELECT relation.relname AS relation_name,
            privilege.privilege_type,
            pg_catalog.has_table_privilege(
              selected_role.oid,
              relation.oid,
              privilege.privilege_type || ' WITH GRANT OPTION'
            ) AS is_grantable
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN (VALUES
        ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text),
        ('DELETE'::text), ('TRUNCATE'::text), ('REFERENCES'::text),
        ('TRIGGER'::text)
      ) privilege(privilege_type)
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_table_privilege(
          selected_role.oid,
          relation.oid,
          privilege.privilege_type
        )
      ORDER BY relation.relname, privilege.privilege_type`,
  );
  const publicGrantResult = await client.query(
    `SELECT relation.relname AS relation_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(relation.relacl) = 1 THEN relation.relacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND privilege.grantee = 0
      ORDER BY relation.relname, privilege.privilege_type`,
  );
  const membershipResult = await client.query(
    `SELECT granted_role.rolname AS granted_role_name,
            member_role.rolname AS member_role_name
       FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted_role
         ON granted_role.oid = membership.roleid
       JOIN pg_catalog.pg_roles member_role
         ON member_role.oid = membership.member
      WHERE granted_role.rolname = 'business_finlynq_app'
         OR member_role.rolname = 'business_finlynq_app'
      ORDER BY granted_role.rolname, member_role.rolname`,
  );
  const columnGrantResult = await client.query(
    `SELECT relation.relname AS relation_name,
            attribute.attname AS column_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation
         ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(attribute.attacl) = 1 THEN attribute.attacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = selected_role.oid
      ORDER BY relation.relname, attribute.attname, privilege.privilege_type`,
  );
  const publicColumnGrantResult = await client.query(
    `SELECT relation.relname AS relation_name,
            attribute.attname AS column_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_attribute attribute
       JOIN pg_catalog.pg_class relation
         ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(attribute.attacl) = 1 THEN attribute.attacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = 0
      ORDER BY relation.relname, attribute.attname, privilege.privilege_type`,
  );
  const functionResult = await client.query(
    `SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              selected_function.proname,
              pg_catalog.oidvectortypes(selected_function.proargtypes)
            ) AS function_signature
       FROM pg_catalog.pg_proc selected_function
       JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = selected_function.pronamespace
      WHERE namespace.nspname IN ('public', 'app')
        AND selected_function.prokind = 'f'
      ORDER BY function_signature`,
  );
  const functionGrantResult = await client.query(
    `SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              selected_function.proname,
              pg_catalog.oidvectortypes(selected_function.proargtypes)
            ) AS function_signature,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_proc selected_function
       JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = selected_function.pronamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(selected_function.proacl) = 1 THEN selected_function.proacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND selected_function.prokind = 'f'
        AND privilege.grantee = selected_role.oid
      ORDER BY function_signature, privilege.privilege_type`,
  );
  const effectiveFunctionGrantResult = await client.query(
    `SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              selected_function.proname,
              pg_catalog.oidvectortypes(selected_function.proargtypes)
            ) AS function_signature,
            'EXECUTE'::text AS privilege_type,
            pg_catalog.has_function_privilege(
              selected_role.oid,
              selected_function.oid,
              'EXECUTE WITH GRANT OPTION'
            ) AS is_grantable
       FROM pg_catalog.pg_proc selected_function
       JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = selected_function.pronamespace
       JOIN pg_catalog.pg_roles selected_role
         ON selected_role.rolname = 'business_finlynq_app'
      WHERE namespace.nspname IN ('public', 'app')
        AND selected_function.prokind = 'f'
        AND pg_catalog.has_function_privilege(selected_role.oid, selected_function.oid, 'EXECUTE')
      ORDER BY function_signature`,
  );
  const publicFunctionGrantResult = await client.query(
    `SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              selected_function.proname,
              pg_catalog.oidvectortypes(selected_function.proargtypes)
            ) AS function_signature,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_proc selected_function
       JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = selected_function.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN selected_function.proacl IS NULL THEN pg_catalog.acldefault('f'::"char", selected_function.proowner)
             WHEN pg_catalog.array_ndims(selected_function.proacl) = 1 THEN selected_function.proacl
             ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND selected_function.prokind = 'f'
        AND privilege.grantee = 0
      ORDER BY function_signature, privilege.privilege_type`,
  );
  const defaultPrivilegeResult = await client.query(
    `WITH selected_role AS (
       SELECT oid, rolname
         FROM pg_catalog.pg_roles
        WHERE rolname = 'business_finlynq_app'
     ), relevant_owner_id(oid) AS (
       SELECT database.datdba
         FROM pg_catalog.pg_database database
        WHERE database.datname = current_database()
       UNION
       SELECT relation.relowner
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'app')
       UNION
       SELECT selected_function.proowner
         FROM pg_catalog.pg_proc selected_function
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = selected_function.pronamespace
        WHERE namespace.nspname IN ('public', 'app')
     ), relevant_owner AS (
       SELECT owner_role.oid, owner_role.rolname
         FROM relevant_owner_id
         JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relevant_owner_id.oid
     ), default_type(object_type_code, object_type) AS (
       VALUES
         ('r'::"char", 'table'::text),
         ('S'::"char", 'sequence'::text),
         ('f'::"char", 'function'::text)
     )
     SELECT relevant_owner.rolname AS owner_role_name,
            '<global>'::text AS scope_name,
            default_type.object_type,
            CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE selected_role.rolname
            END AS grantee_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM relevant_owner
      CROSS JOIN default_type
      CROSS JOIN selected_role
       LEFT JOIN pg_catalog.pg_default_acl default_acl
         ON default_acl.defaclrole = relevant_owner.oid
        AND default_acl.defaclnamespace = 0
        AND default_acl.defaclobjtype = default_type.object_type_code
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN default_acl.defaclacl IS NULL THEN pg_catalog.acldefault(default_type.object_type_code, relevant_owner.oid)
             WHEN pg_catalog.array_ndims(default_acl.defaclacl) = 1 THEN default_acl.defaclacl
             ELSE NULL::aclitem[] END
      ) privilege
      WHERE privilege.grantee IN (0, selected_role.oid)
      UNION ALL
     SELECT owner_role.rolname AS owner_role_name,
            namespace.nspname AS scope_name,
            CASE default_acl.defaclobjtype
              WHEN 'r' THEN 'table'
              WHEN 'S' THEN 'sequence'
              WHEN 'f' THEN 'function'
            END AS object_type,
            CASE
              WHEN privilege.grantee = 0 THEN 'PUBLIC'
              ELSE selected_role.rolname
            END AS grantee_name,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_catalog.pg_default_acl default_acl
       JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN selected_role
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE WHEN pg_catalog.array_ndims(default_acl.defaclacl) = 1 THEN default_acl.defaclacl ELSE NULL::aclitem[] END
      ) privilege
      WHERE namespace.nspname IN ('public', 'app')
        AND default_acl.defaclobjtype IN ('r', 'S', 'f')
        AND privilege.grantee IN (0, selected_role.oid)
      ORDER BY owner_role_name, scope_name, object_type,
               grantee_name, privilege_type`,
  );
  return buildDatabaseRuntimeGrantContract({
    roleRows: roleResult.rows,
    relationRows: relationResult.rows,
    grantRows: grantResult.rows,
    effectiveGrantRows: effectiveGrantResult.rows,
    publicGrantRows: publicGrantResult.rows,
    membershipRows: membershipResult.rows,
    columnGrantRows: columnGrantResult.rows,
    publicColumnGrantRows: publicColumnGrantResult.rows,
    functionRows: functionResult.rows,
    functionGrantRows: functionGrantResult.rows,
    effectiveFunctionGrantRows: effectiveFunctionGrantResult.rows,
    publicFunctionGrantRows: publicFunctionGrantResult.rows,
    defaultPrivilegeRows: defaultPrivilegeResult.rows,
    databasePrivilegeRows: databasePrivilegeResult.rows,
    schemaPrivilegeRows: schemaPrivilegeResult.rows,
    unsafeObjectGrantRows: unsafeObjectGrantResult.rows,
  });
}

function safeErrorMessage(error, connectionConfig) {
  const message = error instanceof Error ? error.message : "Unknown verifier failure";
  let redacted = message;
  if (connectionConfig?.connectionString) {
    redacted = redacted.replaceAll(connectionConfig.connectionString, "[database-url-redacted]");
  }
  if (connectionConfig?.password) {
    redacted = redacted.replaceAll(connectionConfig.password, "[database-password-redacted]");
  }
  return redacted.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[database-url-redacted]",
  );
}

export function migrationConnectionConfig(environment = process.env) {
  const connectionString = environment.TEST_DATABASE_URL ?? environment.DATABASE_MIGRATION_URL;
  if (connectionString) return { connectionString };

  const host = environment.BUSINESS_FINLYNQ_MIGRATION_DB_HOST?.trim();
  const database = environment.BUSINESS_FINLYNQ_MIGRATION_DB_NAME?.trim();
  const user = environment.BUSINESS_FINLYNQ_MIGRATION_DB_USER?.trim();
  const password = environment.BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD;
  const port = Number(environment.BUSINESS_FINLYNQ_MIGRATION_DB_PORT ?? "5432");
  if (!host || !database || !user || password === undefined
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "TEST_DATABASE_URL, DATABASE_MIGRATION_URL, or complete BUSINESS_FINLYNQ_MIGRATION_DB_* settings "
      + "are required for database schema verification",
    );
  }
  return { database, host, password, port, user };
}

export async function verifyDatabaseSchema({
  connectionConfig,
  connectionString,
  metaDirectory = defaultMetaDirectory,
} = {}) {
  const selectedConnection = connectionConfig
    ?? (connectionString ? { connectionString } : migrationConnectionConfig());
  const latest = await loadLatestJournalSnapshot(metaDirectory);
  const snapshotContract = applyMigrationOwnedConstraintContract(
    buildSnapshotSchemaContract(latest.snapshot),
    await loadMigrationOwnedConstraintContract(join(metaDirectory, "..")),
  );
  const client = new Client({
    application_name: "business-finlynq-schema-verifier",
    ...selectedConnection,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await client.connect();
    const databaseContract = await readDatabaseSchemaContract(client);
    const runtimeGrantContract = await readDatabaseRuntimeGrantContract(client);
    const diagnostics = [
      ...compareSchemaContracts(snapshotContract, databaseContract),
      ...compareRuntimeGrantContracts(runtimeGrantContract),
    ].sort();
    return {
      diagnostics,
      grantRelationCount: buildExpectedRuntimeGrantContract().grants.size,
      latest,
      tableCount: snapshotContract.tables.size,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  let selectedConnection;
  try {
    selectedConnection = migrationConnectionConfig();
    const result = await verifyDatabaseSchema({ connectionConfig: selectedConnection });
    if (result.diagnostics.length > 0) {
      console.error(
        `Database schema verification failed against ${result.latest.journalEntry.tag} `
        + `with ${result.diagnostics.length} mismatch(es):`,
      );
      for (const diagnostic of result.diagnostics) console.error(`- ${diagnostic}`);
      console.error("Update forward migration SQL and Drizzle declarations together; never edit a snapshot by hand.");
      process.exitCode = 1;
      return;
    }
    console.log(
      `Database schema matches ${result.latest.journalEntry.tag}: `
      + `${result.tableCount} public base tables, required RLS/FORCE/policy controls, and `
      + `${result.grantRelationCount} relations in the exact ${runtimeRoleName} table/view grant matrix.`,
    );
  } catch (error) {
    console.error(`Database schema verification could not complete: ${safeErrorMessage(error, selectedConnection)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
