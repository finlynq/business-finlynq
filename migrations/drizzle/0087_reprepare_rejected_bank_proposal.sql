-- A rejected proposal is terminal, but the same observation may need a new
-- reviewed draft with corrected accounting facts. Preserve the rejected row
-- and its lineage while allowing a new PREPARED successor.
CREATE OR REPLACE FUNCTION app.guard_bank_accounting_proposal_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor bank_accounting_proposals%ROWTYPE;
BEGIN
  IF (NEW.status = 'COMMITTED') IS DISTINCT FROM (NEW.journal_entry_id IS NOT NULL)
    OR (NEW.version = 1 AND (NEW.status <> 'PREPARED' OR NEW.supersedes_proposal_id IS NOT NULL))
    OR (NEW.version > 1 AND NEW.supersedes_proposal_id IS NULL) THEN
    RAISE EXCEPTION 'Bank proposal state and journal lineage are invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version > 1 THEN
    SELECT * INTO predecessor FROM bank_accounting_proposals proposal
    WHERE proposal.organization_id = NEW.organization_id
      AND proposal.id = NEW.supersedes_proposal_id
      AND NOT EXISTS (
        SELECT 1 FROM bank_accounting_proposals successor
        WHERE successor.organization_id = proposal.organization_id
          AND successor.supersedes_proposal_id = proposal.id
      );
    IF predecessor.id IS NULL
      OR predecessor.observation_version_id <> NEW.observation_version_id
      OR predecessor.version <> NEW.version - 1
      OR (NEW.status = 'PREPARED' AND predecessor.status <> 'REJECTED')
      OR (NEW.status IN ('REVIEWED', 'REJECTED') AND predecessor.status <> 'PREPARED')
      OR (NEW.status = 'COMMITTED' AND predecessor.status <> 'REVIEWED')
      OR (NEW.status <> 'PREPARED' AND (
        predecessor.proposal_snapshot <> NEW.proposal_snapshot
        OR predecessor.proposal_hash <> NEW.proposal_hash
      )) THEN
      RAISE EXCEPTION 'Bank proposal supersession must preserve valid reviewed lineage'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_accounting_proposal_integrity() FROM PUBLIC;
