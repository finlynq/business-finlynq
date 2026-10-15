# Sign-in notification policy

Successful password, MFA, trusted-browser and OIDC sign-ins retain their existing
authentication and audit controls. Notification eligibility is a separate atomic
decision. A new browser, country or coarse region independently qualifies for
one email. A familiar context produces no routine email.

A separate signed, HttpOnly, host-only browser cookie lasts 90 days. Its value
cannot grant a session, step-up or MFA exemption. Recognition digests are scoped
to user, organization and authentication realm. Clearing cookies/private browsing
creates a new browser context. Security-epoch changes revoke recognition, and
each recognized country/region expires after 90 days without use. Only a
successfully issued real session can update the baseline. The first observed
successful context after rollout generates an alert.

Country/location headers are ignored by default. Enable
SIGNIN_TRUSTED_GEO_HEADERS only after the trusted edge strips and replaces
x-finlynq-country, x-finlynq-region, x-finlynq-geo-confidence and
x-finlynq-network-type, and TRUSTED_PROXY_HOPS identifies that boundary.
Country must be an uppercase two-letter code with high confidence; region uses
the country-prefixed subdivision code. Only residential high-confidence regions
are compared. VPN/mobile/unknown network classifications use reliable country
only, so routine IP changes and city-coordinate drift cannot create location
alerts. No IP address or coordinates are stored by notification recognition.

The current edge supplies no trusted geo feed and leaves the flag disabled.
Unavailable/low-confidence geo is explicitly recorded as unknown; it is never
invented or labelled familiar. A known browser with unknown geo suppresses
routine mail while security logging and independent risk alerts continue.
A newly known country or region is compared independently whenever trusted
data becomes available. Recognition never trains from failed authentication.

The outbox trigger serializes each user's decisions. A decision is unique per
issued session, and email retries reuse the existing outbox identity. Only
minimal context labels, reason codes and UTC time enter email metadata.
The notification decision is inspectable in auth_login_notification_decisions;
ordinary app and email-worker roles receive no direct access to baselines.
