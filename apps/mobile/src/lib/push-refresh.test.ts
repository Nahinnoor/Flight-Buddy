import { describe, expect, it } from 'vitest';

import {
  PushRefreshGate,
  REREGISTER_INTERVAL_MS,
  RETRY_AFTER_MISS_MS,
  type RefreshOutcome,
  type RefreshRequest,
} from './push-refresh';

// Fabricated device tokens, not real ones.
type Token = { type: string; data: string };
const TOKEN_A: Token = { type: 'ios', data: 'test-device-token-a' };
const TOKEN_B: Token = { type: 'ios', data: 'test-device-token-b' };

interface Deferred {
  request: RefreshRequest<Token>;
  resolve: (outcome: RefreshOutcome) => void;
}

/**
 * A gate with a hand-driven clock, session state and register function.
 * `auto` answers every register at once; otherwise each call waits in
 * `pending` until the test resolves it.
 */
function harness(options: { auto?: RefreshOutcome } = {}) {
  const state = {
    now: 1_000_000,
    canRegister: true,
    registered: null as Token | null,
  };
  const calls: RefreshRequest<Token>[] = [];
  const pending: Deferred[] = [];

  const gate = new PushRefreshGate<Token>({
    now: () => state.now,
    canRegister: () => state.canRegister,
    isRegistered: (token) =>
      state.registered !== null &&
      token.type === state.registered.type &&
      token.data === state.registered.data,
    register: (request) => {
      calls.push(request);
      const settle = (outcome: RefreshOutcome) => {
        if (outcome === 'registered') state.registered = request.token ?? TOKEN_A;
        return outcome;
      };
      if (options.auto !== undefined) return Promise.resolve(settle(options.auto));
      return new Promise<RefreshOutcome>((resolve) => {
        pending.push({ request, resolve: (outcome) => resolve(settle(outcome)) });
      });
    },
  });

  return { gate, state, calls, pending };
}

describe('foreground re-registration', () => {
  it('registers on foreground, without the permission prompt', async () => {
    const { gate, calls } = harness({ auto: 'registered' });
    await gate.foreground();
    expect(calls).toEqual([{ trigger: 'foreground', prompt: false }]);
  });

  it('is throttled for the interval after a successful registration', async () => {
    const { gate, state, calls } = harness({ auto: 'registered' });
    await gate.signedIn();
    expect(calls).toEqual([{ trigger: 'sign-in', prompt: true }]);

    state.now += REREGISTER_INTERVAL_MS - 1;
    await gate.foreground();
    await gate.foreground();
    expect(calls).toHaveLength(1);

    state.now += 1;
    await gate.foreground();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ trigger: 'foreground', prompt: false });

    state.now += 1_000;
    await gate.foreground();
    expect(calls).toHaveLength(2);
  });

  it.each<RefreshOutcome>(['failed', 'skipped'])(
    'retries sooner after a %s attempt, but not on every foreground',
    async (outcome) => {
      const { gate, state, calls } = harness({ auto: outcome });
      await gate.foreground();
      state.now += RETRY_AFTER_MISS_MS - 1;
      await gate.foreground();
      expect(calls).toHaveLength(1);

      state.now += 1;
      await gate.foreground();
      expect(calls).toHaveLength(2);
    },
  );

  it('treats a wait left far in the future by a clock set backwards as over', async () => {
    const { gate, state, calls } = harness({ auto: 'registered' });
    await gate.foreground();
    state.now -= 24 * 60 * 60_000;
    await gate.foreground();
    expect(calls).toHaveLength(2);
    // The fresh registration throttles normally from the new clock.
    state.now += REREGISTER_INTERVAL_MS - 1;
    await gate.foreground();
    expect(calls).toHaveLength(2);
  });

  it('treats a register that throws as failed', async () => {
    let now = 0;
    let calls = 0;
    const gate = new PushRefreshGate<Token>({
      now: () => now,
      canRegister: () => true,
      isRegistered: () => false,
      register: () => {
        calls += 1;
        return Promise.reject(new Error('boom'));
      },
    });
    await expect(gate.foreground()).resolves.toBeUndefined();
    await gate.foreground();
    expect(calls).toBe(1);
    now += RETRY_AFTER_MISS_MS;
    await gate.foreground();
    expect(calls).toBe(2);
  });

  it('does not start a second registration while one is running', async () => {
    const { gate, calls, pending } = harness();
    const first = gate.signedIn();
    // iOS goes inactive → active around the permission prompt itself.
    await gate.foreground();
    expect(calls).toHaveLength(1);

    pending[0]!.resolve('registered');
    await first;
    await gate.foreground();
    expect(calls).toHaveLength(1);
  });
});

describe('token change', () => {
  it('bypasses the throttle when the token is new', async () => {
    const { gate, calls } = harness({ auto: 'registered' });
    await gate.signedIn();
    await gate.tokenChanged(TOKEN_B);
    expect(calls).toEqual([
      { trigger: 'sign-in', prompt: true },
      { trigger: 'token-changed', prompt: false, token: TOKEN_B },
    ]);
  });

  it('ignores the token that is already registered', async () => {
    const { gate, calls } = harness({ auto: 'registered' });
    await gate.signedIn();
    await gate.tokenChanged(TOKEN_A);
    expect(calls).toHaveLength(1);
  });

  it('waits for a running registration, then drops its own echo', async () => {
    const { gate, calls, pending } = harness();
    const first = gate.signedIn();
    const echo = gate.tokenChanged(TOKEN_A);
    expect(calls).toHaveLength(1);

    pending[0]!.resolve('registered');
    await Promise.all([first, echo]);
    expect(calls).toHaveLength(1);
  });

  it('waits for a running registration, then registers a token it did not cover', async () => {
    const { gate, calls, pending } = harness();
    const first = gate.foreground();
    const changed = gate.tokenChanged(TOKEN_B);
    pending[0]!.resolve('registered');
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.request).toEqual({ trigger: 'token-changed', prompt: false, token: TOKEN_B });
    pending[1]!.resolve('registered');
    await Promise.all([first, changed]);
    expect(calls).toHaveLength(2);
  });

  it('does not let the echo of a failed attempt skip the backoff', async () => {
    const { gate, state, calls, pending } = harness();
    const first = gate.foreground();
    const echo = gate.tokenChanged(TOKEN_A);
    pending[0]!.resolve('failed');
    await Promise.all([first, echo]);
    expect(calls).toHaveLength(1);

    state.now += RETRY_AFTER_MISS_MS - 1;
    await gate.foreground();
    expect(calls).toHaveLength(1);
    state.now += 1;
    void gate.foreground();
    expect(calls).toHaveLength(2);
  });

  it('also makes the next foreground wait the full interval', async () => {
    const { gate, state, calls } = harness({ auto: 'registered' });
    await gate.tokenChanged(TOKEN_B);
    state.now += REREGISTER_INTERVAL_MS - 1;
    await gate.foreground();
    expect(calls).toHaveLength(1);
  });
});

describe('never while signed out, signing out or resetting a password', () => {
  it('skips foreground and token change when not allowed', async () => {
    const { gate, state, calls } = harness({ auto: 'registered' });
    state.canRegister = false;
    await gate.foreground();
    await gate.tokenChanged(TOKEN_B);
    expect(calls).toHaveLength(0);
  });

  it('drops a queued token when a sign-out starts meanwhile', async () => {
    const { gate, state, calls, pending } = harness();
    const first = gate.foreground();
    const changed = gate.tokenChanged(TOKEN_B);
    state.canRegister = false; // sign-out began while the registration ran
    pending[0]!.resolve('registered');
    await Promise.all([first, changed]);
    expect(calls).toHaveLength(1);
  });

  it('forgets the throttle and the queue when the session ends', async () => {
    const { gate, state, calls, pending } = harness();
    const first = gate.foreground();
    void gate.tokenChanged(TOKEN_B);
    gate.reset();
    pending[0]!.resolve('registered');
    await first;
    expect(calls).toHaveLength(1);

    // The old attempt set no throttle for whoever signs in next.
    state.registered = null;
    const next = gate.foreground();
    expect(calls).toHaveLength(2);
    pending[1]!.resolve('registered');
    await next;
  });

  it('registers a new sign-in at once, even inside the window', async () => {
    const { gate, calls } = harness({ auto: 'registered' });
    await gate.signedIn();
    await gate.signedIn();
    expect(calls).toEqual([
      { trigger: 'sign-in', prompt: true },
      { trigger: 'sign-in', prompt: true },
    ]);
  });
});
