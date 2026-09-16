/**
 * A fixed-window request counter per key (the client IP), held in memory.
 *
 * Deliberately small: one process, one route, no dependency. It is abuse
 * damping, not accounting — a restart forgets every window, and that is fine.
 *
 * **Bounded.** The map never holds more than `maxKeys` entries. When a new key
 * arrives at the bound, expired windows are swept first; if every tracked key
 * is still live, the oldest-inserted one is dropped. A flood from many source
 * addresses therefore costs at most `maxKeys` small objects, never unbounded
 * memory. Dropping a live key can only let that key through early, which is the
 * safe direction for a limiter whose failure mode must never be "the provider's
 * real delivery was refused".
 */

export interface FixedWindowLimiterOptions {
  /** Requests allowed per key per window. */
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys. */
  maxKeys: number;
  /** Injected so tests can move time; `buildApp` passes `deps.now`. */
  now: () => Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until this key's window resets (at least 1). For `Retry-After`. */
  retryAfterSeconds: number;
}

export interface FixedWindowLimiter {
  /** Count one request for `key` and say whether it is within the limit. */
  hit(key: string): RateLimitDecision;
  /** Keys currently tracked. */
  size(): number;
}

interface Window {
  startMs: number;
  count: number;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function createFixedWindowLimiter(options: FixedWindowLimiterOptions): FixedWindowLimiter {
  const { limit, windowMs, maxKeys, now } = options;
  assertPositiveInteger('limit', limit);
  assertPositiveInteger('windowMs', windowMs);
  assertPositiveInteger('maxKeys', maxKeys);

  // Insertion-ordered, which is what makes "drop the oldest" O(1).
  const windows = new Map<string, Window>();

  const expired = (window: Window, nowMs: number): boolean => nowMs - window.startMs >= windowMs;

  function makeRoom(nowMs: number): void {
    for (const [key, window] of windows) {
      if (expired(window, nowMs)) windows.delete(key);
    }
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    hit(key: string): RateLimitDecision {
      const nowMs = now().getTime();

      let window = windows.get(key);
      if (window !== undefined && expired(window, nowMs)) {
        windows.delete(key);
        window = undefined;
      }
      if (window === undefined) {
        if (windows.size >= maxKeys) makeRoom(nowMs);
        window = { startMs: nowMs, count: 0 };
        windows.set(key, window);
      }

      window.count += 1;
      const remainingMs = window.startMs + windowMs - nowMs;
      return {
        allowed: window.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    },
    size: () => windows.size,
  };
}
