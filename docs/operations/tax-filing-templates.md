# Tax filing template publication

Tax filing templates are global, immutable platform artifacts. Every organization
can read a published template, while organization-owned account mappings and
filing workpapers remain tenant-isolated. Do not grant the runtime application
role or a tenant MCP connection permission to insert, update, or delete shared
templates.

## Publish a new form or version

1. Review the tax authority's current form and instructions. Record the official
   source URL, effective dates, currency, line definitions, formulas, validation
   rules, and reconciliation behavior. Template publication is a tax-control
   change and requires human review; generated content is not an authority.
2. Create a JSON manifest containing the metadata below and a `definition` that
   conforms to `taxFilingTemplateDefinitionSchema` in
   `src/modules/tax/filing-template.ts`:

   ```json
   {
     "id": "f1000000-0000-4000-8000-000000000099",
     "templateKey": "ca.gst-hst.return",
     "version": 2,
     "name": "Canada GST/HST Return",
     "authority": "Canada Revenue Agency",
     "jurisdiction": "CA-FEDERAL",
     "formCode": "GST34",
     "currencyCode": "CAD",
     "effectiveFrom": "2027-01-01",
     "effectiveTo": null,
     "sourceUri": "https://authority.example/form.pdf",
     "publishedAt": "2026-12-15T00:00:00Z",
     "definition": {
       "schemaVersion": 1,
       "instructions": "Prepare the reviewed return workpaper.",
       "reconciliationTolerance": "0.01",
       "fields": [{
         "key": "line_total",
         "code": "TOTAL",
         "label": "Reviewed total",
         "description": "Amount sourced from the mapped ledger accounts.",
         "kind": "ACCOUNT",
         "valueType": "MONEY",
         "allowAccountMapping": true,
         "required": true,
         "reconcile": true,
         "defaultBalanceBasis": "NET_CREDIT"
       }],
       "validations": []
     }
   }
   ```

3. Generate the validated deterministic seed SQL:

   ```bash
   npm run tax-templates:generate-seed -- /path/to/reviewed-template.json
   ```

   The command fails on malformed fields, forward formula references, unknown
   validation references, invalid dates, or unsupported rule shapes. It computes
   the SHA-256 digest over the exact serialized definition and emits only SQL to
   standard output.
4. Create a reviewed custom Drizzle migration and place the generated `INSERT`
   in it. Add the typed definition under `src/modules/tax/templates/` when the
   application or tests need a named bundled definition. Add a parity test like
   `tests/tax-filing-migration.test.ts` so the code definition, migration JSON,
   and digest cannot drift.
5. Never update an existing template row. Publish corrections as the next
   `(template_key, version)` and set effective dates explicitly. Existing filing
   workpapers retain their complete template and mapping snapshots.
6. Run `npm run check:predeploy`, review the migration and official sources, then
   deploy through the normal `dev` → `stage` → `main` promotion path.

## MCP boundary

Tenant MCP connections can inspect published templates and mapping context with
`finlynq_setup_get_tax_filing_configuration`, inspect filing history with
`finlynq_daily_get_tax_filing_workspace`, append client mapping versions with
`finlynq_setup_save_tax_account_mappings`, and create immutable workpapers with
`finlynq_daily_create_tax_filing_workpaper`. They cannot publish shared templates
or submit/pay a return. This prevents one organization's connection from
changing the form and rules used by every other organization.
