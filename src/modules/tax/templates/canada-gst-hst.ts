import manifest from "./canada-gst-hst-v2.json";
import { taxFilingTemplateDefinitionSchema } from "../filing-template";

export const CANADA_GST_HST_TEMPLATE_ID = manifest.id;
export const CANADA_GST_HST_TEMPLATE_KEY = manifest.templateKey;
export const CANADA_GST_HST_TEMPLATE_VERSION = manifest.version;
export const CANADA_GST_HST_SOURCE = manifest.sourceUri;
export const CANADA_GST_HST_REGISTRATION_SOURCE =
  "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html";
export const CANADA_GST_HST_RATE_SOURCE =
  "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html";

export const canadaGstHstTemplate = taxFilingTemplateDefinitionSchema.parse(
  manifest.definition,
);
