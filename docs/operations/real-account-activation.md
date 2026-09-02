# Real-account activation and emergency write disable

Real accounting writes require two independent controls:

1. the deployment-wide `BUSINESS_WRITES_ENABLED=true` gate; and
2. a non-null `organizations.writes_enabled_at` value for the exact active `REAL` organization UUID.

Neither layer substitutes for the other. An organization may be staged while the global gate is false, but its writes are not effective. Enabling one organization does not enable another. Demo write policy is separate and this procedure must never be used for a sandbox or public-demo organization.

A successfully completed self-service owner signup automatically sets its own organization layer through migration `0033`. The transition uses the same organization activation fence and emits the paired `organization.writes-enabled` audit/outbox records with the `SELF_SERVICE_SIGNUP` policy marker. It does not bypass the deployment-wide gate, tenant RLS, owner membership, role permissions, MFA step-up, posting policy, or accounting controls. An audited operator disable remains durable and is never reversed by the automatic policy or its forward reconciliation.

Use the operator command below for organizations that did not originate from completed self-service signup, for support inspection, and for reviewed re-enablement after an explicit disable. Do not use it as a routine signup-completion step.

The `org:writes` command connects with the migration-owner configuration and calls the audited, owner-only `app.operator_set_organization_writes` function. The application and authentication-worker roles must not receive execute permission on that function or direct update permission on organization activation state. Never use an ad hoc `UPDATE organizations` statement.

## Command contract

All commands require an organization UUID. Mutations also require a non-PII operator identifier and a single-line operational reason. Use a role or duty identifier such as `operator:release-1`, not a name or email. Put a change, incident, or support reference in the reason and do not include customer, identity, bank, or accounting data.

```text
npm run --silent org:writes -- status --organization 10000000-0000-4000-8000-000000000001

npm run --silent org:writes -- enable --organization 10000000-0000-4000-8000-000000000001 --operator-id operator:release-1 --reason "Approved pilot activation CHG-1042"

npm run --silent org:writes -- disable --organization 10000000-0000-4000-8000-000000000001 --operator-id operator:incident-1 --reason "Emergency write stop INC-204"
```

The command accepts no organization slug or display name. Always use npm's `--silent` form shown here so npm does not echo the expanded command and arguments before the script starts. It runs in a read-committed transaction with 15-second statement and 5-second lock timeouts; the database's exclusive activation fence serializes state changes after any in-flight tenant writer drains, while read-committed statement snapshots include that writer's committed audit event. A state-changing mutation includes an opaque request UUID that identifies its immutable audit event. An idempotent `already_enabled` or `already_disabled` result creates no duplicate audit/outbox event and therefore omits that request UUID. Failure output redacts database details. If the database returned a changed result but the final commit acknowledgement was lost, the failure includes only that opaque request UUID; run `status` and reconcile the audit event by that UUID before retrying. Shell history and the local process list can still expose command arguments, so use only the required non-PII duty identifier and operational reference from a restricted operator session. Never add raw database errors or tenant metadata to logs.

The single-line commands above run unchanged in POSIX shells, PowerShell, and `cmd.exe`. Successful output is exactly one JSON object on stdout; a failure emits exactly one redacted line on stderr. Interpret successful output as follows:

- `organizationWritesEnabled` reports the per-organization state.
- `globalGateEnabled` reports the exact `BUSINESS_WRITES_ENABLED` value visible to the operator process.
- `effectiveWritesEnabled` is true only when both layers are enabled and the organization remains active and `REAL`.
- `outcome` is `enabled`, `disabled`, `already_enabled`, or `already_disabled` for a mutation. Repeating the same reviewed request is safe and reports the idempotent state clearly.

In hosted Compose, run the same package script through the one-shot migration-owner image. Compose forwards the non-secret global flag to this image so status uses the same configured value as the application:

```text
docker compose run --rm --no-deps migrate npm run --silent org:writes -- status --organization 10000000-0000-4000-8000-000000000001
```

The database must already be healthy when `--no-deps` is used. Do not place an owner password, operator identity, or reason in a committed environment file.

## Operator-managed pilot activation procedure

Two authorized people perform and record the procedure. One operates; the other independently checks the organization UUID, release, evidence, and result.

1. Record the reviewed release SHA, change reference, exact pilot organization UUID, operators, UTC start time, and the expected global gate. Do not record an organization name, user email, or other identity material in command output.
2. Complete the release and database verification gates in [Release and rollback](./release-runbook.md). Confirm the runtime role cannot update organization activation state or execute the owner function.
3. Complete the full identity checklist in [Real-account authentication and recovery](./account-authentication.md), including live Resend delivery, invitation and signup, password-only and MFA login, later MFA enrollment, reset, co-owner and delayed sole-owner recovery, session revocation, and security notifications.
4. Complete a production-like restore with the matching identity secret and organization root KEK. Prove the restored user can authenticate and read the pilot, recovery completes, the active wrapped DEK version and ciphertext remain unchanged, and no identity or organization key was silently regenerated.
5. Keep the global write gate false for initial staging. Run `status` for the pilot and a separate control organization. Both must report `effectiveWritesEnabled=false`.
6. Run `enable` for the exact pilot UUID. Retain its request UUID and JSON result with the change evidence. Run `status` again; it should show the organization layer enabled and the global layer still false.
7. Set `BUSINESS_WRITES_ENABLED=true` through the reviewed deployment configuration, recreate the application, and update the monitoring expectation in the same change. Re-run `status`; the pilot should report effective writes while the untouched control organization remains ineffective.
8. Through a real pilot session, create and read back one approved low-risk draft, then void or reverse it through the normal product workflow. Verify tenant authorization, idempotency, immutable audit insertion, posting policy, and period controls. Do not use a direct database write as acceptance evidence.
9. Prove a mutation for the control organization is denied while its read-only reports remain available. Also prove the pilot remains readable after logout/login and session revocation behaves as documented.
10. Match the mutation request UUID to its append-only activation audit event. Both authorized people sign the evidence and record the UTC completion time. Keep browser automation and sanitized provider delivery evidence with the release artifact.

If any expectation fails, disable the pilot immediately and leave the global gate false until the failure is understood. A successful command alone is not production acceptance.

## Emergency disable

Use the organization-specific command when one tenant must stop writing while other approved tenants remain available. If an accounting-integrity or authorization incident may include in-flight requests, first set the global gate false and recreate/drain the application, then disable the affected organization. This closes the deployment-wide gate while the owner command records the durable tenant state.

1. Open an incident and obtain the exact affected organization UUID from trusted operational evidence. Do not search by display name in the command.
2. If scope or in-flight activity is uncertain, set `BUSINESS_WRITES_ENABLED=false`, recreate/drain the application, and confirm monitoring sees the expected disabled gate.
3. Run `disable` with a non-PII duty identifier and incident reference. Save the request UUID and result.
4. Run `status`. Require `organizationWritesEnabled=false` and `effectiveWritesEnabled=false`. A repeated command should return `already_disabled`.
5. Verify a new mutation is denied. Verify existing journals, audit history, receivables, payables, and reports remain readable. Do not deactivate the organization, revoke every session, delete records, unwrap keys, or modify accounting history merely to stop writes.
6. Confirm the append-only audit event by request UUID. Preserve relevant application request IDs and sanitized logs under the incident record.
7. If the incident is isolated and other approved organizations may resume, restore the global gate only after confirming the affected organization remains disabled. Re-run status for both the affected and an approved control organization.

Re-enablement is a new reviewed activation. Do not clear the incident by retrying `enable` casually.

An application rollback never rolls back the durable tenant activation column. If the target artifact predates the per-organization gate, first set `BUSINESS_WRITES_ENABLED=false`, drain/recreate the application, and retain read-only operation until a current artifact is restored. An older artifact with the global gate enabled cannot distinguish approved from unapproved real organizations.

## Support triage checklist

When a user reports that writes are unavailable:

- confirm the request is a real session for the exact organization and not a demo/session-mode mismatch;
- run `status` with the organization UUID and record only the sanitized JSON;
- distinguish global gate disabled, organization layer disabled, inactive organization, and non-`REAL` organization mode;
- check deployed release/readiness, migration completion, database health, and monitoring expectations;
- confirm the user has application authorization and any required MFA step-up; write activation never grants a role;
- verify the period, posting policy, idempotency, and domain controls separately from activation;
- never enable writes as a troubleshooting shortcut, and never paste raw database errors, email addresses, tokens, ciphertext, or financial content into a ticket; and
- escalate a state mismatch or missing audit event as a security/integrity incident and keep writes disabled.

When a user reports that reads are unavailable after disable, treat that as a separate availability defect. Per-organization disable is intended to block new mutations without hiding or deleting history.

## Evidence still requiring operators

Repository tests cannot provide these external acceptance artifacts:

- Resend domain/sender verification, restricted sending key, isolated deployed worker health, live delivery/retry/dead-letter alert evidence, and the complete production-like browser identity journey;
- a backup/restore exercise using the production-like identity secret and organization root KEK, including explicit DEK preservation evidence; and
- independent sign-off by at least two authorized people on the pilot runbook.

Keep `ACCOUNT_LOGIN_ENABLED`, `ACCOUNT_SIGNUP_ENABLED`, and the global write gate independently disabled until their corresponding evidence is complete. Keep operator-managed organizations disabled until their activation evidence is complete; completed self-service signups receive their organization layer automatically only after the global signup decision has been made.
