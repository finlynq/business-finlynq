export type JournalTypeDefinition = Readonly<{
  key: string;
  version: number;
  ownerModule: string;
  label: string;
  correctionRoute: string;
  editableInGeneralLedger: boolean;
  deterministicSourceMayPost: boolean;
}>;

export type AccountingModuleManifest = Readonly<{
  key: string;
  version: number;
  journalTypes: readonly JournalTypeDefinition[];
}>;

const MODULE_KEY = /^[a-z][a-z0-9-]*$/;
const JOURNAL_TYPE_KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export function defineAccountingModule(manifest: AccountingModuleManifest): AccountingModuleManifest {
  if (!MODULE_KEY.test(manifest.key) || !Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error("Module manifests require a canonical key and positive integer version");
  }

  for (const journalType of manifest.journalTypes) {
    if (
      !JOURNAL_TYPE_KEY.test(journalType.key) ||
      !journalType.key.startsWith(`${manifest.key}.`) ||
      journalType.ownerModule !== manifest.key ||
      !Number.isInteger(journalType.version) ||
      journalType.version < 1
    ) {
      throw new Error(`Journal type ${journalType.key} is not canonically owned by ${manifest.key}`);
    }
  }

  return manifest;
}

export class JournalTypeRegistry {
  readonly #byIdentity = new Map<string, JournalTypeDefinition>();
  readonly #latestByKey = new Map<string, JournalTypeDefinition>();

  constructor(manifests: readonly AccountingModuleManifest[]) {
    const moduleKeys = new Set<string>();

    for (const manifest of manifests) {
      defineAccountingModule(manifest);
      if (moduleKeys.has(manifest.key)) {
        throw new Error(`Duplicate accounting module manifest: ${manifest.key}`);
      }
      moduleKeys.add(manifest.key);

      for (const journalType of manifest.journalTypes) {
        const identity = `${journalType.key}@${journalType.version}`;
        if (this.#byIdentity.has(identity)) {
          throw new Error(`Duplicate journal type definition: ${identity}`);
        }
        this.#byIdentity.set(identity, journalType);

        const current = this.#latestByKey.get(journalType.key);
        if (!current || current.version < journalType.version) {
          this.#latestByKey.set(journalType.key, journalType);
        }
      }
    }
  }

  get(key: string, version?: number): JournalTypeDefinition | undefined {
    return version === undefined
      ? this.#latestByKey.get(key)
      : this.#byIdentity.get(`${key}@${version}`);
  }

  list(): readonly JournalTypeDefinition[] {
    return [...this.#byIdentity.values()].sort((left, right) =>
      left.key.localeCompare(right.key) || left.version - right.version,
    );
  }
}
