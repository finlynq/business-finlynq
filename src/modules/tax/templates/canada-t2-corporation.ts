import manifest from "./canada-t2-corporation.json";
import { taxFilingTemplateDefinitionSchema } from "../filing-template";

export const CANADA_T2_CORPORATION_TEMPLATE_ID = manifest.id;
export const CANADA_T2_CORPORATION_TEMPLATE_KEY = manifest.templateKey;
export const CANADA_T2_CORPORATION_TEMPLATE_VERSION = manifest.version;
export const CANADA_T2_CORPORATION_SOURCE = manifest.sourceUri;
export const CANADA_T2_CORPORATION_GUIDE_SOURCE =
  "https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4012.html";

export const canadaT2CorporationTemplate = taxFilingTemplateDefinitionSchema.parse(
  manifest.definition,
);
