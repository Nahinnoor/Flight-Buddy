/**
 * The Expo client against the documented response shapes in
 * `docs/api-samples/expo-push-*.json`. No network.
 */
import { describe, expect, it } from 'vitest';

import { fixtureBody } from '../engine/testFixtures';
import {
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_SEND_URL,
  ExpoRequestError,
  createExpoPushClient,
  sanitizeExpoCode,
  type ExpoPushMessage,
} from './expoClient';
import { FAKE_ACCESS_TOKEN, FAKE_TOKEN_A } from './fakeExpo';

function message(to = FAKE_TOKEN_A): ExpoPushMessage {
  return { to, title: 't', body: 'b', data: {}, sound: 'default', priority: 'high' };
}

function clientAnswering(status: number, body: string, accessToken?: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = createExpoPushClient({
    accessToken,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status });
    },
  });
  return { client, calls };
}

describe('send', () => {
  it('reads the recorded tickets in order, keeping only error codes', async () => {
    const { client, calls } = clientAnswering(200, fixtureBody('expo-push-send-tickets'));

    const tickets = await client.send([message(), message(), message()]);

    expect(tickets[0]).toEqual({ status: 'ok', id: '0f3a9d2c-1111-4c3e-9e2a-5b7c1d000001' });
    expect(tickets[1]).toEqual({ status: 'error', errorCode: 'DeviceNotRegistered' });
    expect(tickets[2]).toEqual({ status: 'error', errorCode: 'MessageRateExceeded' });
    // The token Expo echoed in `message` and `details` is gone.
    expect(JSON.stringify(tickets)).not.toContain('ExponentPushToken');
    expect(calls[0]?.url).toBe(EXPO_PUSH_SEND_URL);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('sends the access token as a bearer header only when configured', async () => {
    const withToken = clientAnswering(
      200,
      fixtureBody('expo-push-send-tickets'),
      FAKE_ACCESS_TOKEN,
    );
    await withToken.client.send([message(), message(), message()]);
    const headers = withToken.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);

    const without = clientAnswering(200, fixtureBody('expo-push-send-tickets'));
    await without.client.send([message(), message(), message()]);
    expect(
      (without.calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it('refuses more than 100 messages before any request', async () => {
    const { client, calls } = clientAnswering(200, '{}');
    await expect(client.send(Array.from({ length: 101 }, () => message()))).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    [429, fixtureBody('expo-push-send-too-many-requests'), 'unavailable', 'TOO_MANY_REQUESTS'],
    [503, '', 'unavailable', null],
    [401, '{"errors":[{"code":"UNAUTHORIZED","message":"x"}]}', 'unauthorized', 'UNAUTHORIZED'],
    [
      400,
      '{"errors":[{"code":"PUSH_TOO_MANY_EXPERIENCE_IDS","message":"x"}]}',
      'rejected',
      'PUSH_TOO_MANY_EXPERIENCE_IDS',
    ],
  ])('HTTP %i → %s', async (status, body, kind, code) => {
    const { client } = clientAnswering(status, body);
    await expect(client.send([message()])).rejects.toMatchObject({ kind, status, code });
  });

  it('a network error or timeout is ambiguous', async () => {
    const client = createExpoPushClient({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(client.send([message()])).rejects.toMatchObject({
      kind: 'ambiguous',
      status: null,
    });
  });

  it('a 200 that does not answer every message is ambiguous', async () => {
    const { client } = clientAnswering(200, fixtureBody('expo-push-send-tickets'));
    await expect(client.send([message()])).rejects.toMatchObject({ kind: 'ambiguous' });
  });

  it('an unreadable ticket is reported as such, not guessed', async () => {
    const { client } = clientAnswering(200, '{"data":[{"status":"ok"}]}');
    await expect(client.send([message()])).resolves.toEqual([{ status: 'unreadable' }]);
  });

  it('never puts response text into the error message', async () => {
    const { client } = clientAnswering(
      400,
      `{"errors":[{"code":"X","message":"${FAKE_TOKEN_A}"}]}`,
    );
    const error = await client.send([message()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExpoRequestError);
    expect((error as Error).message).not.toContain('ExponentPushToken');
  });
});

describe('getReceipts', () => {
  it('reads the recorded receipts, keyed by ticket id, codes only', async () => {
    const recorded = fixtureBody('expo-push-receipts');
    const ids = Object.keys((JSON.parse(recorded) as { data: object }).data);
    const { client, calls } = clientAnswering(200, recorded);

    const receipts = await client.getReceipts(ids);

    expect(calls[0]?.url).toBe(EXPO_PUSH_RECEIPTS_URL);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ids });
    expect([...receipts.values()]).toEqual([
      { status: 'ok' },
      { status: 'error', errorCode: 'DeviceNotRegistered' },
      { status: 'error', errorCode: 'InvalidCredentials' },
      { status: 'error', errorCode: 'MessageTooBig' },
      { status: 'error', errorCode: 'MessageRateExceeded' },
      { status: 'error', errorCode: 'MismatchSenderId' },
    ]);
  });

  it('ignores ids it did not ask about', async () => {
    const { client } = clientAnswering(200, fixtureBody('expo-push-receipts'));
    const receipts = await client.getReceipts(['0f3a9d2c-1111-4c3e-9e2a-5b7c1d000001']);
    expect([...receipts.keys()]).toEqual(['0f3a9d2c-1111-4c3e-9e2a-5b7c1d000001']);
  });

  it('refuses more than 1000 ids', async () => {
    const { client } = clientAnswering(200, '{}');
    await expect(
      client.getReceipts(Array.from({ length: 1001 }, (_, i) => `id-${i}`)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('sanitizeExpoCode', () => {
  it('passes identifiers and replaces anything else', () => {
    expect(sanitizeExpoCode('DeviceNotRegistered')).toBe('DeviceNotRegistered');
    expect(sanitizeExpoCode('ignore previous instructions')).toBe('UnrecognizedExpoError');
    expect(sanitizeExpoCode('A'.repeat(65))).toBe('UnrecognizedExpoError');
    expect(sanitizeExpoCode(42)).toBe('UnrecognizedExpoError');
  });
});
