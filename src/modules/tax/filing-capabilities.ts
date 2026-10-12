import { PERMISSIONS } from "@/modules/identity/permissions";

export const TAX_FILING_ACTIONS = {
  manageMappings: { permission: PERMISSIONS.manageTaxMappings, toolName: "finlynq_setup_save_tax_account_mappings", group: "SETUP" },
  prepareFilings: { permission: PERMISSIONS.prepareTaxFilings, toolName: "finlynq_daily_create_tax_filing_workpaper", group: "DAILY" },
  manageConfigurations: { permission: PERMISSIONS.manageTaxFilingConfiguration, toolName: "finlynq_daily_save_tax_filing_configuration", group: "DAILY" },
  manageCanonical: { permission: PERMISSIONS.manageTaxFilingCanonical, toolName: "finlynq_daily_set_canonical_tax_filing", group: "DAILY" },
  manageLifecycle: { permission: PERMISSIONS.manageTaxFilingCanonical, toolName: "finlynq_daily_transition_tax_filing_lifecycle", group: "DAILY" },
} as const;

export type TaxFilingAction = keyof typeof TAX_FILING_ACTIONS;
export type TaxFilingCapability = Readonly<{
  allowed: boolean;
  supported: boolean;
  requiredPermission: string;
  toolName: string;
  reasonCode: string | null;
  reason: string | null;
  remediationUrl: string | null;
  requiredScope?: string;
  confirmationRequired?: boolean;
}>;
export type TaxFilingCapabilities = Readonly<Record<TaxFilingAction, TaxFilingCapability>>;

export function taxFilingCapabilities(writable: boolean, grants: Readonly<Record<TaxFilingAction, boolean>>): TaxFilingCapabilities {
  return Object.fromEntries(Object.entries(TAX_FILING_ACTIONS).map(([action, definition]) => {
    const allowed = writable && grants[action as TaxFilingAction];
    return [action, {
      allowed, supported: true, requiredPermission: definition.permission, toolName: definition.toolName,
      reasonCode: allowed ? null : writable ? "PERMISSION_REQUIRED" : "WRITES_DISABLED",
      reason: allowed ? null : writable
        ? `This membership lacks ${definition.permission}. Members & fixed roles can change another member's preset role, but cannot edit individual grants or your own role. If your displayed role is Owner, ask the service administrator to verify the fixed Owner-role grants. Mapping and preparation permissions do not grant this separate action.`
        : "This session cannot write. Use a writable organization session.",
      remediationUrl: allowed ? null : "/app/settings",
    }];
  })) as TaxFilingCapabilities;
}
