/**
 * Vendored from the knowledge-crawler engine's retrieval layer (identical
 * semantics; golden tests kept in sync). PR0 promotes this kernel to
 * a shared politeness package and remove the duplication.
 */

/**
 * Per-domain rate limiter + circuit breaker (architecture §4.5).
 *
 * Deterministic: clock and sleep are injected, so tests (and replay mode) are
 * instantaneous. Behavior:
 * - min-interval per domain (max of configured floor and robots Crawl-delay);
 * - 429/5xx failures apply jittered exponential backoff on that domain;
 * - `breakerThreshold` consecutive failures open the breaker for
 *   `breakerCooldownMs` — acquire() then denies instead of waiting.
 */

export interface DomainRateLimiterOptions {
  minIntervalMsPerDomain: number;
  backoffBaseMs: number;
  maxBackoffMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type RateDecision =
  | { verdict: "allow"; waitedMs: number }
  | { verdict: "deny"; reason: "circuit_open" };

interface DomainState {
  nextAllowedAt: number;
  consecutiveFailures: number;
  blockedUntil: number;
}

export class DomainRateLimiter {
  private readonly domains = new Map<string, DomainState>();

  constructor(private readonly options: DomainRateLimiterOptions) {}

  private stateFor(domain: string): DomainState {
    let state = this.domains.get(domain);

    if (!state) {
      state = { nextAllowedAt: 0, consecutiveFailures: 0, blockedUntil: 0 };
      this.domains.set(domain, state);
    }

    return state;
  }

  async acquire(
    domain: string,
    overrides: { minIntervalMs?: number } = {},
  ): Promise<RateDecision> {
    const now = this.options.clock();
    const state = this.stateFor(domain);

    if (state.blockedUntil > now) {
      return { verdict: "deny", reason: "circuit_open" };
    }

    // Breaker cooldown elapsed: give the domain another chance.
    if (state.blockedUntil > 0 && state.blockedUntil <= now) {
      state.blockedUntil = 0;
      state.consecutiveFailures = 0;
    }

    const interval = Math.max(
      overrides.minIntervalMs ?? 0,
      this.options.minIntervalMsPerDomain,
    );

    const earliest = Math.max(state.nextAllowedAt, now);
    const waitedMs = earliest - now;

    if (waitedMs > 0) {
      await this.options.sleep(waitedMs);
    }

    state.nextAllowedAt = this.options.clock() + interval;

    return { verdict: "allow", waitedMs };
  }

  recordSuccess(domain: string): void {
    const state = this.stateFor(domain);

    state.consecutiveFailures = 0;
  }

  recordFailure(domain: string): void {
    const state = this.stateFor(domain);

    state.consecutiveFailures += 1;

    const backoff = Math.min(
      this.options.backoffBaseMs * 2 ** (state.consecutiveFailures - 1),
      this.options.maxBackoffMs,
    );

    const jitter = Math.floor(backoff / 4);
    const now = this.options.clock();

    state.nextAllowedAt = Math.max(state.nextAllowedAt, now + backoff + jitter);

    if (state.consecutiveFailures >= this.options.breakerThreshold) {
      state.blockedUntil = now + this.options.breakerCooldownMs;
    }
  }

  /** Test/introspection support. */
  snapshot(domain: string): DomainState | undefined {
    return this.domains.get(domain);
  }
}
