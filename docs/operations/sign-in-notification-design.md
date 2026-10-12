# Novel sign-in notification design

This is the design record for BUSINESS-FINLYNQ-67. It does not change sign-in or email behavior. The current external edge supplies no trusted geo signal, so the notification gate must remain disabled until a separately reviewed implementation and edge configuration are deployed together.

## Trust boundary

The public edge must discard every client-supplied `X-Finlynq-Geo-*` header and replace it only from a configured, authenticated geo source. The release router must forward only the edge's replacement headers to the app. Direct app and router access must remain private. The application must ignore geo headers unless an explicit deployment setting confirms this contract; a request header by itself must never enable trust. Verify both spoofed-header rejection and trusted-source delivery during release acceptance.

Use a two-letter country code and a coarse location cell with a source accuracy radius. Do not persist the incoming IP address, precise coordinates, or raw proxy headers in notification history. If the source cannot provide a confident country or location, mark that signal **unknown**; an IP change alone is not a new location. Compare locations only within the same country and treat movement within the larger of 100 km or both source accuracy radii as familiar. A changed country is independently new even when location accuracy is low.

## Recognition and eligibility

Use a separate, random, account-scoped, HttpOnly/Secure/SameSite device cookie whose digest is stored server-side. It conveys no MFA trust or authorization. Bind a recognition record to user, organization, and security epoch; expire it after 90 days without a successful sign-in. A cleared cookie or private browser is a new device. Successful password, MFA, trusted-browser, and OIDC issuance should use the same eligibility service, after session creation succeeds. Failed or incomplete sign-ins never seed recognition.

On the first successful sign-in, send one notice and seed the recognized device and any confident geo signals. Thereafter send one notice when **any** of device, country, or meaningfully new location is new. Update recognized signals atomically with the notification decision. A known device with unknown geo is not recorded as a familiar location: send a single context-unavailable notice at most once per device in seven days, and keep the unknown decision observable in minimized security metadata. An unavailable device signal counts as a new device. Do not suppress a later independent new-country or new-location notice because of the context-unavailable limit.

Use a unique sign-in event/session ID as the email-outbox deduplication key. Concurrent callbacks and worker retries must return the same decision and at most one email job. A qualifying email should show the triggering reason(s), sign-in time and timezone, a coarse browser/device label, and country/approximate location only when confident. Retain existing safe account-security advice, audit events, MFA, risk controls, session policy, and authorization.

## Release gate

Test the full novelty matrix, first-login baseline, missing/low-confidence geo, minor location drift, VPN/mobile changes, cleared cookies, retry/concurrency, password and OIDC paths, and cross-account isolation against PostgreSQL. Verify edge header stripping with an untrusted request and a trusted geo source. Only then enable the notification gate. Until that gate is enabled, current sign-in notifications continue unchanged.
