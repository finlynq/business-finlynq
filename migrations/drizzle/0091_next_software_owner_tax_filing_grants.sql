-- Explicitly approved for Next Software's existing fixed Owner role only.
-- The entity ID and code bind the display name to the intended tenant; other
-- Owner roles and all other permissions remain untouched. Replay is safe.
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM legal_entities entity
JOIN organizations organization ON organization.id = entity.organization_id
JOIN roles role ON role.organization_id = organization.id
JOIN permissions permission ON permission.key IN (
  'tax.filing.configuration.manage',
  'tax.filing.canonical.manage'
)
WHERE entity.id = '70eed0d9-289d-494d-b897-c1331fe0af3a'::uuid
  AND entity.code = 'CA01'
  AND organization.display_name = 'Next Software'
  AND organization.active
  AND role.key = 'OWNER'
  AND role.system_template
  AND role.active
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;
