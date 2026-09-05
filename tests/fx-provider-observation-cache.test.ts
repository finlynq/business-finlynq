import { describe, expect, it, vi } from "vitest";
import type { BankOfCanadaFxObservation } from "@/modules/fx/bank-of-canada-valet-adapter";
import type { EcbFxReferenceObservation } from "@/modules/fx/ecb-reference-rate-adapter";
import {
  FX_PROVIDER_OBSERVATION_CACHE_MAX_ENTRIES,
  FX_PROVIDER_OBSERVATION_CACHE_TTL_MS,
  FxProviderObservationCache,
} from "@/modules/fx/provider-observation-cache";

function ecbObservation(rate = "1.47"): EcbFxReferenceObservation {
  return {
    rate,
    observedAt: "2026-09-04T00:00:00.000Z",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    calculation: "CROSS_VIA_EUR",
    formula: "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
    legs: [
      {
        currency: "USD",
        unitsPerEuro: "1.16",
        observedDate: "2026-09-04",
        seriesKey: "EXR.D.USD.EUR.SP00.A",
      },
      {
        currency: "CAD",
        unitsPerEuro: "1.7052",
        observedDate: "2026-09-04",
        seriesKey: "EXR.D.CAD.EUR.SP00.A",
      },
    ],
    retrievedAt: "2026-09-05T00:00:00.000Z",
    rawBodySha256: "a".repeat(64),
  };
}

function bankOfCanadaObservation(rate = "0.72"): BankOfCanadaFxObservation {
  return {
    rate,
    observedAt: "2026-09-04T00:00:00.000Z",
    sourceCurrency: "CAD",
    targetCurrency: "USD",
    calculation: "INVERSE_FROM_CAD",
    formula: "1 / CAD_PER_TARGET_UNIT",
    legs: [{
      currency: "USD",
      cadPerUnit: "1.3889",
      observedDate: "2026-09-04",
      seriesKey: "FXUSDCAD",
    }],
    retrievedAt: "2026-09-05T00:00:00.000Z",
    rawBodySha256: "b".repeat(64),
  };
}

describe("FX provider observation cache", () => {
  it("defaults to a five-minute TTL and 128-entry bound", () => {
    expect(FX_PROVIDER_OBSERVATION_CACHE_TTL_MS).toBe(300_000);
    expect(FX_PROVIDER_OBSERVATION_CACHE_MAX_ENTRIES).toBe(128);
  });

  it("coalesces concurrent loads and retains the parsed typed observation", async () => {
    const cache = new FxProviderObservationCache();
    const observation = ecbObservation();
    let release!: (value: EcbFxReferenceObservation) => void;
    const pending = new Promise<EcbFxReferenceObservation>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(() => pending);

    const first = cache.getOrLoad("ecb:USD:CAD:2026-09-04", load);
    const second = cache.getOrLoad("ecb:USD:CAD:2026-09-04", load);
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    release(observation);
    await expect(first).resolves.toBe(observation);
    await expect(cache.getOrLoad("ecb:USD:CAD:2026-09-04", load)).resolves.toBe(observation);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts TTL at successful resolution and reloads at the expiry boundary", async () => {
    let now = 1_000;
    const cache = new FxProviderObservationCache({ ttlMs: 100, now: () => now });
    const firstObservation = bankOfCanadaObservation("0.72");
    const secondObservation = bankOfCanadaObservation("0.73");
    let release!: (value: BankOfCanadaFxObservation) => void;
    const firstPending = new Promise<BankOfCanadaFxObservation>((resolve) => {
      release = resolve;
    });
    const load = vi.fn()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce(secondObservation);

    const first = cache.getOrLoad("boc:CAD:USD:2026-09-04", load);
    now = 5_000;
    release(firstObservation);
    await first;

    now = 5_099;
    await expect(cache.getOrLoad("boc:CAD:USD:2026-09-04", load))
      .resolves.toBe(firstObservation);
    now = 5_100;
    await expect(cache.getOrLoad("boc:CAD:USD:2026-09-04", load))
      .resolves.toBe(secondObservation);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected loads so the same key can retry", async () => {
    const cache = new FxProviderObservationCache();
    const observation = ecbObservation();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce(observation);

    await expect(cache.getOrLoad("ecb:USD:CAD:2026-09-04", load))
      .rejects.toThrow("temporary provider failure");
    await expect(cache.getOrLoad("ecb:USD:CAD:2026-09-04", load))
      .resolves.toBe(observation);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest insertion deterministically without promoting cache hits", async () => {
    const cache = new FxProviderObservationCache({ maxEntries: 2 });
    const a = ecbObservation("1.41");
    const b = ecbObservation("1.42");
    const c = ecbObservation("1.43");
    const loadA = vi.fn().mockResolvedValue(a);
    const loadB = vi.fn().mockResolvedValue(b);
    const loadC = vi.fn().mockResolvedValue(c);

    await cache.getOrLoad("a", loadA);
    await cache.getOrLoad("b", loadB);
    await cache.getOrLoad("a", loadA);
    await cache.getOrLoad("c", loadC);

    await cache.getOrLoad("b", loadB);
    expect(loadB).toHaveBeenCalledTimes(1);
    await cache.getOrLoad("a", loadA);
    expect(loadA).toHaveBeenCalledTimes(2);
    expect(loadC).toHaveBeenCalledTimes(1);
  });

  it("clears pending entries without allowing their later resolution to repopulate the cache", async () => {
    const cache = new FxProviderObservationCache();
    const firstObservation = ecbObservation("1.41");
    const secondObservation = ecbObservation("1.42");
    let release!: (value: EcbFxReferenceObservation) => void;
    const pending = new Promise<EcbFxReferenceObservation>((resolve) => {
      release = resolve;
    });
    const firstLoad = vi.fn(() => pending);
    const secondLoad = vi.fn().mockResolvedValue(secondObservation);

    const first = cache.getOrLoad("ecb:USD:CAD:2026-09-04", firstLoad);
    cache.clear();
    release(firstObservation);
    await expect(first).resolves.toBe(firstObservation);
    await expect(cache.getOrLoad("ecb:USD:CAD:2026-09-04", secondLoad))
      .resolves.toBe(secondObservation);
    expect(secondLoad).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bounds, clocks, and empty keys before invoking a loader", () => {
    expect(() => new FxProviderObservationCache({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new FxProviderObservationCache({ maxEntries: 1.5 })).toThrow(RangeError);

    const invalidClock = new FxProviderObservationCache({ now: () => Number.NaN });
    const load = vi.fn().mockResolvedValue(ecbObservation());
    expect(() => invalidClock.getOrLoad("ecb:key", load)).toThrow(RangeError);
    expect(() => new FxProviderObservationCache().getOrLoad("   ", load)).toThrow(TypeError);
    expect(load).not.toHaveBeenCalled();
  });
});
