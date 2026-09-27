import { describe, expect, it } from 'vitest';

import { isExpoPushToken, safeRpcFailure, safeThrownFailure } from './push-token';

// Fabricated test values, not real device tokens.
const TOKEN = 'ExponentPushToken[test-token-0123456789]';

describe('isExpoPushToken', () => {
  it('accepts both Expo prefixes', () => {
    expect(isExpoPushToken(TOKEN)).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc_DEF-123]')).toBe(true);
  });

  it.each(['', 'ExponentPushToken[]', 'ExponentPushToken[a b]', `${TOKEN} `, 'token', null, 7])(
    'rejects %j',
    (value) => {
      expect(isExpoPushToken(value)).toBe(false);
    },
  );
});

describe('failure reasons never carry text from the error', () => {
  it('keeps a SQLSTATE or PostgREST code', () => {
    expect(safeRpcFailure({ code: '22023' })).toBe('rpc:22023');
    expect(safeRpcFailure({ code: 'PGRST202' })).toBe('rpc:PGRST202');
  });

  it('drops a code that is not one of those shapes, and never reads the message', () => {
    const error = { code: TOKEN, message: `could not register ${TOKEN}` };
    const reason = safeRpcFailure(error);
    expect(reason).toBe('rpc:error');
    expect(reason).not.toContain('Token');
    expect(safeRpcFailure(null)).toBe('rpc:error');
    expect(safeRpcFailure({})).toBe('rpc:error');
  });

  it('keeps only the class name of a thrown error', () => {
    const reason = safeThrownFailure(new TypeError(`Network request failed for ${TOKEN}`));
    expect(reason).toBe('thrown:TypeError');
    expect(reason).not.toContain('Token');
  });

  it('drops an error name that is not a plain identifier', () => {
    const error = new Error('x');
    error.name = TOKEN;
    expect(safeThrownFailure(error)).toBe('thrown:unknown');
    expect(safeThrownFailure('a string')).toBe('thrown:unknown');
  });
});
