import { ontarioHstPack } from "./packs/ontario";
import { atlanticHstPack } from "./packs/atlantic";
import { washingtonSalesUsePack } from "./packs/washington";
import { genericUnsupportedTaxPack } from "./packs/generic-unsupported";
import type { TaxDecision, TaxFacts, TaxPack } from "./types";

const registeredPacks = new Map<string, TaxPack>([
  [ontarioHstPack.key, ontarioHstPack],
  [atlanticHstPack.key, atlanticHstPack],
  [washingtonSalesUsePack.key, washingtonSalesUsePack],
  [genericUnsupportedTaxPack.key, genericUnsupportedTaxPack],
]);

export function decideTax(packKey: string, facts: TaxFacts): TaxDecision {
  const pack = registeredPacks.get(packKey);

  if (!pack) {
    throw new Error(`Tax pack is not registered: ${packKey}`);
  }

  return pack.decide(facts);
}

export function listTaxPacks(): readonly Pick<TaxPack, "key" | "version">[] {
  return [...registeredPacks.values()].map(({ key, version }) => ({ key, version }));
}
