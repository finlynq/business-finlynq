-- Owners may hide any tax report, including imported, reviewed, locked and
-- referenced history. Snapshots and existing links remain recoverable.
CREATE OR REPLACE FUNCTION app.guard_tax_workpaper_control() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_version integer; required_permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-governance:'||NEW.organization_id::text,0));
 required_permission:=CASE NEW.action WHEN 'CREATED' THEN 'tax.filings.prepare' WHEN 'EXPORT' THEN 'tax.read' ELSE 'tax.filing.canonical.manage' END;
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NOT app.current_actor_has_permission(required_permission) THEN
  RAISE EXCEPTION 'Workpaper control requires the authorized tenant actor' USING ERRCODE='42501'; END IF;
 IF NEW.action IN ('DELETE','RESTORE') AND NOT EXISTS (
  SELECT 1 FROM organization_memberships membership
  JOIN organizations organization ON organization.id=membership.organization_id
  JOIN membership_roles membership_role ON membership_role.organization_id=membership.organization_id AND membership_role.membership_id=membership.id
  JOIN roles role ON role.organization_id=membership_role.organization_id AND role.id=membership_role.role_id
  WHERE membership.organization_id=NEW.organization_id AND membership.user_id=NEW.created_by
    AND membership.active AND organization.active AND role.active AND role.key='OWNER'
 ) THEN RAISE EXCEPTION 'Only an active organization owner can move tax reports to Trash or restore them' USING ERRCODE='42501'; END IF;
 SELECT max(version) INTO previous_version FROM tax_workpaper_control_events WHERE organization_id=NEW.organization_id AND filing_id=NEW.filing_id;
 IF NEW.version<>coalesce(previous_version,0)+1 OR (NEW.action='CREATED' AND (previous_version IS NOT NULL OR pg_trigger_depth()<2)) THEN
  RAISE EXCEPTION 'Workpaper control version is stale' USING ERRCODE='23514'; END IF;
 IF NEW.action<>'RESTORE' AND app.tax_workpaper_deleted(NEW.organization_id,NEW.filing_id) THEN RAISE EXCEPTION 'Restore this report from Trash before use' USING ERRCODE='23514'; END IF;
 IF NEW.action='RESTORE' AND NOT app.tax_workpaper_deleted(NEW.organization_id,NEW.filing_id) THEN RAISE EXCEPTION 'Only a report in Trash can be restored' USING ERRCODE='23514'; END IF;
 PERFORM app.append_tenant_business_audit(NEW.organization_id,'tax.workpaper.'||lower(NEW.action),'tax-workpaper',NEW.filing_id::text,
 jsonb_build_object('eventId',NEW.id,'version',NEW.version,'reason',NEW.reason),NULL);
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_tax_workpaper_control() FROM PUBLIC;
