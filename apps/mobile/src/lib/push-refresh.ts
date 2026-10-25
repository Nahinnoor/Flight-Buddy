/**
 * When to register this device's push token again (ADR 0006, sub-step iii).
 *
 * The launch / sign-in registration alone is not enough: a device whose row
 * was moved to another account, retired over the cap, or invalidated by a
 * `DeviceNotRegistered` receipt stays silent until the next cold launch, which
 * on iOS can be days. So the app also registers:
 *
 * - **on foreground** (`AppState` → `active`), throttled: at most once per
 *   `REREGISTER_INTERVAL_MS` after a successful registration, or once per
 *   `RETRY_AFTER_MISS_MS` after one that failed or was skipped;
 * - **when Expo reports a new device token** (`addPushTokenListener`). That
 *   bypasses the throttle, unless it is the token already registered: asking
 *   Expo for a token can itself emit the event, and that echo must not loop.
 *
 * Neither path ever prompts for permission (only the sign-in registration
 * does), and neither runs unless `canRegister()` says so at that moment —
 * signed in, not in a password reset, not signing out.
 *
 * Pure and generic over the token type so it is testable without native
 * modules. It never sees an Expo push token, and never logs anything.
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */

/** A healthy device re-registers at most this often from foregrounds. */
export const REREGISTER_INTERVAL_MS = 10 * 60_000;

/** After a failed or skipped attempt, the next foreground may retry after this. */
export const RETRY_AFTER_MISS_MS = 60_000;

export type RefreshOutcome = 'registered' | 'skipped' | 'failed';

export type RefreshTrigger = 'sign-in' | 'foreground' | 'token-changed';

export interface RefreshRequest<T> {
  trigger: RefreshTrigger;
  /** Only the sign-in registration may show the permission prompt. */
  prompt: boolean;
  /** The device token Expo reported, for `token-changed`. */
  token?: T;
}

export interface PushRefreshDeps<T> {
  now: () => number;
  /** Read at the moment of each foreground / token-change attempt. */
  canRegister: () => boolean;
  /** Whether `token` is the device token this device last registered. */
  isRegistered: (token: T) => boolean;
  /** Must not throw; a throw is treated as `failed`. */
  register: (request: RefreshRequest<T>) => Promise<RefreshOutcome>;
}

export class PushRefreshGate<T> {
  private nextAllowedAt = Number.NEGATIVE_INFINITY;
  /** What the last attempt of this session returned, or null before the first. */
  private lastOutcome: RefreshOutcome | null = null;
  private inflight: Promise<void> | null = null;
  /** A token reported while a registration was running; checked when it ends. */
  private queued: { token: T } | null = null;
  /** Bumped by `reset`, so an attempt from a previous session changes nothing. */
  private generation = 0;

  constructor(private readonly deps: PushRefreshDeps<T>) {}

  /**
   * A user is signed in (launch or fresh sign-in): register now, prompting if
   * permission is undecided. Not throttled, and not gated on `canRegister`,
   * exactly like the registration it replaces.
   */
  signedIn(): Promise<void> {
    this.reset();
    return this.start({ trigger: 'sign-in', prompt: true });
  }

  /** The app came back to the foreground. */
  foreground(): Promise<void> {
    if (!this.deps.canRegister()) return Promise.resolve();
    if (this.inflight !== null) return Promise.resolve();
    if (this.throttled()) return Promise.resolve();
    return this.start({ trigger: 'foreground', prompt: false });
  }

  /** Expo reported a device push token. */
  tokenChanged(token: T): Promise<void> {
    if (!this.deps.canRegister()) return Promise.resolve();
    if (this.inflight !== null) {
      // Possibly the echo of the running registration's own token request;
      // decided once that registration has recorded what it registered.
      this.queued = { token };
      return this.inflight;
    }
    if (this.deps.isRegistered(token)) return Promise.resolve();
    return this.start({ trigger: 'token-changed', prompt: false, token });
  }

  /** The session ended or changed hands: forget the throttle and anything queued. */
  reset(): void {
    this.generation += 1;
    this.nextAllowedAt = Number.NEGATIVE_INFINITY;
    this.lastOutcome = null;
    this.queued = null;
    this.inflight = null;
  }

  private start(request: RefreshRequest<T>): Promise<void> {
    const generation = this.generation;
    const attempt = this.attempt(request, generation);
    this.inflight = attempt;
    return attempt.then(() => {
      if (generation !== this.generation) return;
      if (this.inflight === attempt) this.inflight = null;
      return this.drainQueued();
    });
  }

  private async attempt(request: RefreshRequest<T>, generation: number): Promise<void> {
    let outcome: RefreshOutcome;
    try {
      outcome = await this.deps.register(request);
    } catch {
      outcome = 'failed';
    }
    if (generation !== this.generation) return;
    this.lastOutcome = outcome;
    const wait = outcome === 'registered' ? REREGISTER_INTERVAL_MS : RETRY_AFTER_MISS_MS;
    this.nextAllowedAt = this.deps.now() + wait;
  }

  /**
   * Inside the wait set by the last attempt. `now` is wall-clock time, so a
   * clock set backwards could push the end of the wait far out; a wait longer
   * than the longest one ever set counts as over.
   */
  private throttled(): boolean {
    const remaining = this.nextAllowedAt - this.deps.now();
    return remaining > 0 && remaining <= REREGISTER_INTERVAL_MS;
  }

  /**
   * A token reported during the attempt that just ended. After a success it
   * is checked against what was registered (usually the attempt's own echo).
   * After a miss the echo cannot match, so it would retry at once: it waits
   * for the miss backoff instead, and the next foreground after it asks Expo
   * for the current token anyway.
   */
  private drainQueued(): Promise<void> {
    const queued = this.queued;
    this.queued = null;
    if (queued === null) return Promise.resolve();
    if (this.lastOutcome !== 'registered' && this.throttled()) return Promise.resolve();
    return this.tokenChanged(queued.token);
  }
}
