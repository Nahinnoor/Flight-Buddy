/**
 * The keep-alive ping (ADR 0004): a Render free web service sleeps after 15
 * minutes without traffic, and waking takes longer than AeroDataBox's delivery
 * timeout, so the worker pokes `/healthz` on an interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './logger';
import { startKeepAlive } from './main';

const logger = createLogger({ level: 'silent' });
const URL_ = 'https://flightbuddy-api.example.invalid/healthz';

describe('startKeepAlive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings once immediately and then on the interval', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    startKeepAlive({
      url: URL_,
      intervalMs: 600_000,
      logger,
      signal: controller.signal,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([URL_]);

    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(3);
    controller.abort();
  });

  it('keeps running when a ping fails: the API being down must not stop the worker', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    startKeepAlive({ url: URL_, intervalMs: 60_000, logger, signal: controller.signal, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    controller.abort();
  });

  it('stops on shutdown', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();

    startKeepAlive({ url: URL_, intervalMs: 60_000, logger, signal: controller.signal, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(300_000);

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
