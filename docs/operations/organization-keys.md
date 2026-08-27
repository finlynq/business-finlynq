# Organization key operations

Business Finlynq provisions one random 256-bit data-encryption key (DEK) per real organization. The DEK is wrapped by the root key mounted through `ORGANIZATION_ROOT_KEK_FILE`; plaintext DEKs and the root key are never stored in PostgreSQL or printed by operator commands.

Initial provisioning is supported in two controlled paths:

- `npm run org:onboard` creates a new organization foundation and its first wrapped DEK using the migration-owner connection.
- Self-service owner signup generates the DEK in the server process, wraps it before any database call, and installs only the envelope inside the same atomic email-verification transaction that creates the real organization. The plaintext DEK and loaded root key are zeroed in a `finally` block.
- An existing organization owner with `organization.recovery.manage` may call the application provisioning service, which installs only version 1 through `app.install_initial_organization_key`.

The database permits exactly one active key. Public demo sessions and inactive organizations cannot install key material through the runtime service.

## Rotation boundary

Online DEK rotation is deliberately **not enabled**. Party ciphertext and equality-search blind indexes are bound to their row key version. Activating a new key without atomically re-encrypting every protected field and rebuilding every blind index would make old records unreadable or undiscoverable.

A future rotation job must inventory all encrypted columns, lock each organization rotation, retain old envelopes during migration, re-encrypt and reindex in resumable batches, verify row counts and decryptability, cut over the active version atomically, and support rollback before retiring the old envelope. Until that tested workflow exists, attempts to install a second key fail closed. Password reset and account recovery never rotate or replace the organization DEK.
