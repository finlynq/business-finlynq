import "server-only";

import type { BankOfCanadaFxObservation } from "./bank-of-canada-valet-adapter";
import type { EcbFxReferenceObservation } from "./ecb-reference-rate-adapter";
import type { YahooFxChartObservation } from "./yahoo-chart-adapter";

export const FX_PROVIDER_OBSERVATION_CACHE_TTL_MS = 5 * 60 * 1_000;
export const FX_PROVIDER_OBSERVATION_CACHE_MAX_ENTRIES = 128;

export type CacheableFxProviderObservation =
  | BankOfCanadaFxObservation
  | EcbFxReferenceObservation
  | YahooFxChartObservation;

export type FxProviderObservationCacheOptions = Readonly<{
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}>;

type CacheEntry = {
  promise: Promise<CacheableFxProviderObservation>;
  expiresAt: number | undefined;
};

function positiveFiniteInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Process-local cache for parsed public FX-provider observations.
 *
 * The caller owns the key namespace. Values remain in memory only; provider
 * response bodies are neither accepted separately nor persisted by this cache.
 */
export class FxProviderObservationCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: FxProviderObservationCacheOptions = {}) {
    this.#ttlMs = positiveFiniteInteger(
      options.ttlMs ?? FX_PROVIDER_OBSERVATION_CACHE_TTL_MS,
      "ttlMs",
    );
    this.#maxEntries = positiveFiniteInteger(
      options.maxEntries ?? FX_PROVIDER_OBSERVATION_CACHE_MAX_ENTRIES,
      "maxEntries",
    );
    this.#now = options.now ?? Date.now;
  }

  getOrLoad<TObservation extends CacheableFxProviderObservation>(
    key: string,
    load: () => Promise<TObservation>,
  ): Promise<TObservation> {
    if (key.trim().length === 0) {
      throw new TypeError("FX provider observation cache keys cannot be empty.");
    }

    const now = this.#readClock();
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.expiresAt === undefined || existing.expiresAt > now) {
        return existing.promise as Promise<TObservation>;
      }
      this.#entries.delete(key);
    }

    this.#deleteExpired(now);

    const entry: CacheEntry = {
      promise: Promise.resolve().then(load),
      expiresAt: undefined,
    };
    entry.promise = entry.promise.then<CacheableFxProviderObservation>(
      (observation) => {
        if (this.#entries.get(key) === entry) {
          entry.expiresAt = this.#readClock() + this.#ttlMs;
        }
        return observation;
      },
      (error: unknown) => {
        if (this.#entries.get(key) === entry) {
          this.#entries.delete(key);
        }
        throw error;
      },
    );

    this.#entries.set(key, entry);
    this.#evictOldestEntries();

    return entry.promise as Promise<TObservation>;
  }

  clear(): void {
    this.#entries.clear();
  }

  #readClock(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new RangeError("FX provider observation cache clock must return a finite number.");
    }
    return now;
  }

  #deleteExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }

  #evictOldestEntries(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.#entries.delete(oldestKey);
    }
  }
}

export const fxProviderObservationCache = new FxProviderObservationCache();
