-- Custom SQL migration file, put your code below! --
-- Keep the encrypted database upload cap at 2 MiB. Cloud assets store only
-- metadata and a provider reference, so their originals can be 20 MiB.
ALTER TABLE document_evidence_assets
  ADD CONSTRAINT document_evidence_assets_metadata_check_v4 CHECK (
    owner_module IN ('receivables','payables')
    AND mime_type IN (
      'application/pdf', 'image/png', 'image/jpeg', 'text/csv',
      'text/tab-separated-values', 'text/plain', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'message/rfc822'
    )
    AND ((storage_backend = 'CLOUD' AND byte_size BETWEEN 1 AND 20971520)
      OR (storage_backend = 'DATABASE' AND byte_size BETWEEN 1 AND 2097152))
    AND key_version > 0 AND sha256 ~ '^[a-f0-9]{64}$'
    AND command_hash ~ '^[a-f0-9]{64}$'
    AND length(scanner_version) BETWEEN 1 AND 200
    AND length(filename_ciphertext) BETWEEN 1 AND 4096
    AND (content_ciphertext IS NULL OR length(content_ciphertext) BETWEEN 1 AND 4000000)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  VALIDATE CONSTRAINT document_evidence_assets_metadata_check_v4;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  DROP CONSTRAINT document_evidence_assets_metadata_check_v3;
