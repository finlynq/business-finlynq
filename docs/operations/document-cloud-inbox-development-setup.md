# Enable cloud document storage on development

Target: `https://dev.business.finlynq.com`. Each customer signs in to their own Google or Microsoft account. These registrations identify FinLynQ on the provider's consent screen; files are stored in the consenting customer's drive.

## Baseline inspected before this update (2026-09-04)

- Revision `795c39647209cd436d11258e849bd0323c5b098d` is deployed and accepted on dev.
- Public health, privacy, and terms URLs return HTTP 200. Both callback routes reject requests without a valid OAuth handoff with HTTP 400, as expected.
- Neither provider has a configured client ID; both client-secret mounts use the empty placeholder.
- This session has no Google Cloud or Microsoft Entra administration connection. No provider registration has been created.
- The server's `deploy` account can start and inspect the managed deployment service. Installing credentials or editing the protected Compose environment requires a server administrator.

## Google registration (legacy recovery only)

New Google connections are blocked while a suitable personal-account authorization model is chosen. Keep the original OAuth client for existing connections and historical evidence; changing client IDs can invalidate refresh tokens and per-app access. Do not register broad Drive access as the new folder-only solution.

For existing-connection recovery, in its FinLynQ-owned Google Cloud project, enable the Google Drive API. Configure Google Auth Platform with the following values:

| Field | Development value |
| --- | --- |
| App name | Business FinLynQ Development |
| Audience | External; keep the development registration in Testing |
| Test users | The Google accounts that will test the dev integration |
| Support and developer email | A monitored address available to the project owner |
| App homepage | `https://dev.business.finlynq.com` |
| Privacy policy | `https://dev.business.finlynq.com/privacy` |
| Terms | `https://dev.business.finlynq.com/terms` |
| Authorized domain | `finlynq.com` |
| Requested Drive scope | `https://www.googleapis.com/auth/drive` |
| OAuth client type | Web application |
| Authorized redirect URI | `https://dev.business.finlynq.com/api/document-storage/callback/GOOGLE_DRIVE` |

Existing Google connections use the restricted `drive` scope. Google does not enforce the application folder filter. `drive.file` plus selecting a folder does not establish access to all existing children or future external drops; explicit per-file import is a separate workflow. Google requires restricted-scope verification and, where applicable, a security assessment before public rollout. The folder restriction in FinLynQ does not narrow the provider's account-wide grant. Development testing does not establish public verification.

**Testing-mode expiry:** Google external OAuth apps in Testing receive Drive refresh tokens that expire after seven days. Reconnect the original account after expiry. The profile-only exception does not apply to Drive. See [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Save the generated client ID and client secret in the server's protected configuration. If Google supplies a JSON download, the mounted secret file must contain only the `web.client_secret` value, not the JSON document.

References: [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent), [web OAuth credentials](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Microsoft registration

Create an application in the FinLynQ-owned Microsoft Entra tenant:

| Field | Development value |
| --- | --- |
| Name | Business FinLynQ Development |
| Supported account types | Any organizational directory and personal Microsoft accounts |
| Redirect platform | Web |
| Redirect URI | `https://dev.business.finlynq.com/api/document-storage/callback/ONEDRIVE` |
| Microsoft Graph delegated permissions | `Files.ReadWrite.AppFolder`, `offline_access` |
| Credential | A development client secret, with its expiry recorded for rotation |

This is the self-service option for personal OneDrive. The provider grant covers the complete app folder, with a separate connection-specific Inbox/Archive subtree. An arbitrary existing folder or sharing URL cannot be substituted. Microsoft 365 Selected permissions require administrator consent and a separately provisioned resource grant; that enterprise setup is deferred following the personal-account requirement. See the [feasibility and alternatives](document-cloud-inbox.md).

Record the Application (client) ID and the secret **Value**. OneDrive folders are created beneath the consenting user's app folder. Validate both personal and work/school accounts before claiming support for both.

References: [register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [app-folder access](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder), [create credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

## Server activation

A server administrator must install the provider secrets as single-line files, owned by `root:business-finlynq-secrets` with mode `0440`, under `/etc/business-finlynq-development/secrets`. Keep secret values out of chat, Git, command-line arguments, and shell history.

Set or replace these keys in `/etc/business-finlynq-development/compose.env`, preserving the file's existing `root:deploy` ownership and `0600` mode. Values below are placeholders; configure only providers whose registrations are complete.

```dotenv
DOCUMENT_GOOGLE_CLIENT_ID=<Google web client ID>
DOCUMENT_GOOGLE_CLIENT_SECRET_FILE=/etc/business-finlynq-development/secrets/document-google-client-secret
DOCUMENT_MICROSOFT_CLIENT_ID=<Microsoft application client ID>
DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE=/etc/business-finlynq-development/secrets/document-microsoft-client-secret
DOCUMENT_INBOX_MAX_DEPTH=8
DOCUMENT_INBOX_MAX_PROVIDER_CALLS=10
```

Before connecting a real account, verify the live reverse proxy excludes `/api/document-storage/callback/*` from access logs. The supplied Caddy files include `log_skip`; the shared edge is managed separately from the dev app deployment.

The updated source deployer compares both document-provider client IDs, container secret-file variables, host mount paths/modes, and secret content against the running app. A same-revision mismatch proceeds with deployment; a stale bind mount after secret rotation triggers recreation of only the dev app. Secret values and digests are never printed or persisted as deployment metadata. CI signals and live acceptance still apply.

The managed service runs a root-owned installed copy of the deployer. Deploying application source alone does not update that copy. From the reviewed dev checkout, a server administrator must run `sudo bash deploy/development/install-development.sh --enable` to install the updated deployer, then start `business-finlynq-development-deployment.service`. This updates only the development installer and preserves existing provider secrets; do not run the production installer or change production configuration.

Verify that Document inbox offers the enabled provider, then complete a real connection from an organization administrator's session. Test direct and at least three-level nested cloud Inbox drops. Call MCP sync until `hasMore` is false and confirm its discovered/unchanged/skipped/unsupported/failed counts and relative paths. Read synthetic PDF, CSV, XLS, and XLSX samples; confirm formulas/links are omitted, then create a draft, archive its original, and download the linked evidence with the same SHA-256. Record the outcome and the Microsoft secret expiry. On 2026-09-04 a personal OneDrive account completed registration, OAuth connection, a direct PDF drop, MCP sync/list, and claim on dev. The first page read returned `STORAGE_DOWNLOAD_HOST`; BUSINESS-FINLYNQ-8 tracks the compatibility fix. Repeat read through draft creation, archive filing, and evidence download after deploying that fix.

## Verification and remaining work

The authorization-model update suites passed 63 tests, including real disposable PostgreSQL RLS, historical attachments, safe callback errors, and in-flight authorization policy checks, with provider transport/scanning mocked. Production build, lint, TypeScript, and shell syntax checks passed. Dev provider registration, secret installation, the installed-deployer refresh, live OAuth, direct-drop discovery, and claim are complete for a personal OneDrive account. Live page read, draft creation, archive filing, and evidence-download hash verification must still be repeated after BUSINESS-FINLYNQ-8 is deployed. A private share-link recipient model and password-only unlock are design alternatives, not enabled features; see the related guide before selecting one.

## Structured-file and recursive-sync validation

The application pins SheetJS CE 0.20.3 from its official CDN tarball with package-lock integrity. It is used in server-only, in-memory values-preview mode for legacy XLS and XLSX; no filesystem extraction, formula evaluation, macro execution, or network link resolution is enabled. The app image needs no additional workbook binary. ClamAV remains mandatory.

`DOCUMENT_INBOX_MAX_DEPTH` must be 1–15 and `DOCUMENT_INBOX_MAX_PROVIDER_CALLS` 2–20, with the call budget at least the depth plus one. Defaults are 8 and 10. The development installer writes both defaults; Compose passes them to the app; final deployment acceptance compares the rendered and running values. Invalid values fail the sync before provider traversal.

Automated provider calls are mocked. A live personal-OneDrive acceptance remains required for nested folders, Graph pagination/throttling behavior, CSV files reported as `application/vnd.ms-excel`, and final evidence download after filing. Legacy Google can receive the same application-level traversal only for grandfathered whole-drive connections; this does not narrow Google's grant and is not evidence of provider-enforced folder authorization.

For statement-import acceptance, follow the [bank statement import guide](bank-statement-import.md). Use a non-production company and verify representative PDF, CSV/TXT, XLS, and XLSX statements through preview, explicit confirmation, draft reconciliation, archive retry, and evidence download. Record mocked/unit, disposable-PostgreSQL, and live OneDrive/MCP results separately.
