export const CURRENT_SIGNUP_TERMS_VERSION = "2026-08-27";

export const SIGNUP_REGIONS = {
  CA: [
    ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"],
    ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"],
    ["NS", "Nova Scotia"], ["NT", "Northwest Territories"],
    ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"],
    ["QC", "Quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
  ],
  US: [
    ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"],
    ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"],
    ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
    ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
    ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
    ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"],
    ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
    ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
    ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"],
    ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
    ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
    ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
    ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"],
    ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
    ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
    ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
    ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ],
} as const;

export const SIGNUP_ACCOUNTING_PROFILES = [
  ["CAN_ASPE", "Canadian ASPE"],
  ["US_GAAP_NONPUBLIC", "U.S. GAAP — non-public entities"],
] as const;

export type SignupCountry = string;
export type SignupAccountingProfile = (typeof SIGNUP_ACCOUNTING_PROFILES)[number][0];

export function isSignupCountry(country: string): boolean {
  return /^[A-Z]{2}$/.test(country);
}

export function isSignupRegion(country: string, region: string): boolean {
  if (!/^[A-Z0-9-]{2,10}$/.test(region)) return false;
  if (country === "CA" || country === "US") {
    return SIGNUP_REGIONS[country].some(([code]) => code === region);
  }
  return isSignupCountry(country);
}

export function signupCountryDefaults(country: string): Readonly<{
  functionalCurrency: string;
  accountingProfile: SignupAccountingProfile;
}> {
  return country === "CA"
    ? { functionalCurrency: "CAD", accountingProfile: "CAN_ASPE" }
    : { functionalCurrency: "USD", accountingProfile: "US_GAAP_NONPUBLIC" };
}
