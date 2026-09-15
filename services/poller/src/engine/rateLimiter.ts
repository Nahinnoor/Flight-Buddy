/**
 * The worker's 1 request/second token bucket (§7.5, §7.8, §8.3).
 *
 * The RapidAPI plan allows 2 req/s; the worker takes one and leaves the other for
 * the API's interactive lookups (ADR 0003 §7). Exceeding it costs a 429, which the
 * provider counts as a failed poll — so the limiter is a correctness control, not
 * a politeness one.
 *
 * ## Why reservation rather than "check then wait"
 *
 * A pass can have 25 flights in hand and the failover ladder can make many more
 * due at once. A limiter that reads the clock, decides it may go, and *then*
 * awaits, lets every waiter wake into the same millisecond and fire together. So
 * `acquire()` **reserves** its slot synchronously — `nextAvailableAt` moves before
 * any `await` — and only then sleeps until that slot. Callers are served strictly
 * in the order they asked, one per `1000 / rps` ms, however many arrive at once.
 *
 * The bucket holds `burst` tokens (default 1, i.e. no burst): an idle limiter does
 * not bank credit it could spend all at once, which is the whole failure §8.3
 * describes.
 *
 * ## Clock
 *
 * `now()` and `sleep()` are injected so the 200-flight test runs in virtual time.
 * Nothing here reads `Date.now()` or `setTimeout` directly.
 */

/** The two clock operations the limiter needs. */
export interface Clock {
  /** Milliseconds on a monotonic-enough timeline. Only differences are used. */
  now(): number;
  /** Resolve after at least `ms`. */
  sleep(ms: number): Promise<void>;
}

/** Wall clock + `setTimeout`. What the worker runs on. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // A pending limiter slot must not hold the process open during shutdown.
      timer.unref?.();
    }),
};

export interface RateLimiterOptions {
  /** Requests per second. `PROVIDER_RPS`, default 1. */
  rps?: number;
  /**
   * How many slots may be taken back to back after an idle period. Default 1:
   * no burst at all, which is what a 1 req/s account actually allows.
   */
  burst?: number;
  clock?: Clock;
}

export interface RateLimiter {
  /** Resolves when the caller may make exactly one request. */
  acquire(): Promise<void>;
  /** Slots handed out so far. Diagnostics only. */
  readonly granted: number;
}

export const DEFAULT_PROVIDER_RPS = 1;

/**
 * Build a token bucket.
 *
 * @throws RangeError for a non-positive rate, which would hang every caller.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const rps = options.rps ?? DEFAULT_PROVIDER_RPS;
  const burst = options.burst ?? 1;
  const clock = options.clock ?? systemClock;

  if (!Number.isFinite(rps) || rps <= 0) {
    throw new RangeError('rate limiter rps must be a positive, finite number');
  }
  if (!Number.isInteger(burst) || burst < 1) {
    throw new RangeError('rate limiter burst must be a positive integer');
  }

  const intervalMs = 1000 / rps;
  /** The earliest instant the next slot may be used. `-Infinity` until the first call. */
  let nextAvailableAt = Number.NEGATIVE_INFINITY;
  let granted = 0;

  return {
    get granted() {
      return granted;
    },

    async acquire(): Promise<void> {
      const now = clock.now();

      // An idle limiter may hand out `burst` slots immediately, and no more: the
      // reservation line is never allowed to sit further back than that.
      const earliest = now - (burst - 1) * intervalMs;
      const slot = Math.max(earliest, nextAvailableAt);

      // Synchronous, before any await: two concurrent callers cannot take the
      // same slot however the event loop interleaves them.
      nextAvailableAt = slot + intervalMs;
      granted += 1;

      const waitMs = slot - now;
      if (waitMs > 0) await clock.sleep(waitMs);
    },
  };
}
