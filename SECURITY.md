# Security policy

## Reporting a vulnerability

Please report vulnerabilities through the repository's private
[GitHub security advisory form](https://github.com/finlynq/business-finlynq/security/advisories/new).
Do not open a public issue and do not include real customer, credential, banking,
tax, or encryption-key data in a report.

Include the affected route or component, reproduction steps, observed impact,
and a safe proof of concept when possible. The maintainers will acknowledge the
report through GitHub and coordinate remediation and disclosure there.

## Supported release

Only the commit currently deployed at `https://business.finlynq.com` is
supported. The hosted release contains both disposable synthetic demo tenants
and private real-account tenants. Report whether an issue affects the demo,
real authentication, tenant isolation, accounting integrity, encryption,
banking, backup/recovery, or the deployment boundary. Never use production
customer data or credentials in a proof of concept.
