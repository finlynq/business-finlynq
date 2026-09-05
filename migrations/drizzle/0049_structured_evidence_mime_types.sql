-- Keep the original, narrower constraint in force while PostgreSQL prepares
-- and validates the expanded canonical MIME allowlist. NOT VALID skips the
-- table scan while the constraint is added, but still checks concurrent
-- inserts and updates. The original constraint is dropped only after every
-- historical row has passed the replacement constraint.
ALTER TABLE document_evidence_assets
  ADD CONSTRAINT document_evidence_assets_metadata_check_v2 CHECK (
    owner_module IN ('receivables','payables')
    AND mime_type IN (
      'application/pdf',
      'image/png',
      'image/jpeg',
      'text/csv',
      'text/tab-separated-values',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    AND byte_size BETWEEN 1 AND 2097152
    AND key_version > 0 AND sha256 ~ '^[a-f0-9]{64}$'
    AND command_hash ~ '^[a-f0-9]{64}$'
    AND length(scanner_version) BETWEEN 1 AND 200
    AND length(filename_ciphertext) BETWEEN 1 AND 4096
    AND length(content_ciphertext) BETWEEN 1 AND 4000000
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  VALIDATE CONSTRAINT document_evidence_assets_metadata_check_v2;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  DROP CONSTRAINT document_evidence_assets_metadata_check;
