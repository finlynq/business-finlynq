CREATE INDEX "audit_events_org_previous_hash_idx"
  ON "audit_events" USING btree ("organization_id", "previous_event_hash");
