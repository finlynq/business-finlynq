/** Registration jurisdiction is distinct from the customer's place of supply. */
export function registrationDestinationMatches(registration: {
  regime_key: string; destination_country: string | null; destination_region: string | null;
  destination_city: string | null; location_code: string | null;
}, destination: { destinationCountry?: string; destinationRegion?: string; destinationCity?: string | null; locationCode?: string | null }) {
  if (registration.destination_country !== destination.destinationCountry || registration.destination_region !== destination.destinationRegion) return false;
  // Ontario HST is province-level. Preserve the actual customer city and other
  // source facts; a legacy registration city does not restrict ON coverage.
  if (registration.regime_key === "ca.on.hst" && registration.destination_country === "CA" && registration.destination_region === "ON") return true;
  // Keep explicit location matching for Seattle and unsupported/manual regimes.
  return registration.destination_city === (destination.destinationCity || null)
    && registration.location_code === (destination.locationCode || null);
}
