/**
 * Test support: the real `createExpoPushClient` over an injected `fetch` that
 * answers with Expo's documented response shapes (`docs/api-samples/expo-push-*`).
 * No test touches the network or pushes to a real token.
 *
 * Not exported from `src/index.ts`: this is for tests.
 */
import { createExpoPushClient, type ExpoPushMessage } from './expoClient';

/** Obviously fake tokens, in the shape the app stores. */
export const FAKE_TOKEN_A = 'ExponentPushToken[FAKE-test-token-aaaa]';
export const FAKE_TOKEN_B = 'ExponentPushToken[FAKE-test-token-bbbb]';
export const FAKE_TOKEN_NEW = 'ExponentPushToken[FAKE-test-token-new0]';
export const FAKE_ACCESS_TOKEN = 'FAKE-expo-access-token-not-a-secret-0000';

export type SendAnswer =
  /** One ticket per message, built by the test. */
  | { tickets: (message: ExpoPushMessage, index: number) => Record<string, unknown> }
  | { status: number; body?: unknown }
  | { throws: Error };

export interface FakeExpoOptions {
  send?: SendAnswer | (() => SendAnswer);
  /** Receipts by ticket id; a missing id means "not ready". */
  receipts?: Record<string, unknown> | (() => Record<string, unknown>);
  receiptsStatus?: number;
  accessToken?: string;
}

let ticketCounter = 0;

/** An `ok` ticket with a fresh id. */
export function okTicket(): Record<string, unknown> {
  ticketCounter += 1;
  return { status: 'ok', id: `0f3a9d2c-2222-4c3e-9e2a-${String(ticketCounter).padStart(12, '0')}` };
}

/** An error ticket shaped like Expo's: the message and details repeat the token. */
export function errorTicket(
  code: string,
  token = 'ExponentPushToken[FAKE-in-error]',
): Record<string, unknown> {
  return {
    status: 'error',
    message: `"${token}" is not a registered push notification recipient`,
    details: { error: code, expoPushToken: token },
  };
}

export function fakeExpo(options: FakeExpoOptions = {}) {
  const sent: ExpoPushMessage[][] = [];
  const receiptRequests: string[][] = [];
  const headers: Record<string, string>[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    headers.push({ ...(init?.headers as Record<string, string>) });
    const body = JSON.parse(String(init?.body)) as unknown;

    if (url.endsWith('/push/send')) {
      const messages = body as ExpoPushMessage[];
      sent.push(messages);
      const raw = options.send ?? { tickets: () => okTicket() };
      const answer = typeof raw === 'function' ? raw() : raw;
      if ('throws' in answer) throw answer.throws;
      if ('status' in answer) {
        return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
          status: answer.status,
        });
      }
      return new Response(JSON.stringify({ data: messages.map(answer.tickets) }), { status: 200 });
    }

    if (url.endsWith('/push/getReceipts')) {
      const ids = (body as { ids: string[] }).ids;
      receiptRequests.push(ids);
      if (options.receiptsStatus !== undefined && options.receiptsStatus !== 200) {
        return new Response('', { status: options.receiptsStatus });
      }
      const all =
        typeof options.receipts === 'function' ? options.receipts() : (options.receipts ?? {});
      const data: Record<string, unknown> = {};
      for (const id of ids) if (all[id] !== undefined) data[id] = all[id];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    return new Response('', { status: 404 });
  };

  return {
    client: createExpoPushClient({ fetch: fetchImpl, accessToken: options.accessToken }),
    fetchImpl,
    sent,
    /** Every message sent, across requests. */
    messages: () => sent.flat(),
    receiptRequests,
    headers,
  };
}
