import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from './config';

/**
 * A stand-in that looks like the real thing — same shape, same length class — so
 * "the error does not contain the value" is a meaningful assertion. Nothing here
 * is a credential; the database it names does not exist.
 */
const FAKE_PASSWORD = 'not-a-real-password-8f3a1c';
const FAKE_DATABASE_URL = `postgresql://flightbuddy_worker.example:${FAKE_PASSWORD}@aws-0-us-west-2.pooler.example.invalid:5432/postgres?sslmode=require`;
const FAKE_RAPIDAPI_KEY = 'not-a-real-rapidapi-key-0000000000000000000000000000';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: FAKE_DATABASE_URL,
    RAPIDAPI_KEY: FAKE_RAPIDAPI_KEY,
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('fills in every default from the two required variables', () => {
    const config = parseConfig(env());

    expect(config.AERODATABOX_HOST).toBe('aerodatabox.p.rapidapi.com');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.POLL_INTERVAL_MS).toBe(30_000);
    expect(config.POLL_BATCH_SIZE).toBe(25);
    expect(config.WEBHOOK_URL).toBeUndefined();
    expect(config.OPERATOR_USER_ID).toBeUndefined();
  });

  it('coerces the numeric knobs from strings', () => {
    const config = parseConfig(env({ POLL_INTERVAL_MS: '5000', POLL_BATCH_SIZE: '10' }));

    expect(config.POLL_INTERVAL_MS).toBe(5_000);
    expect(config.POLL_BATCH_SIZE).toBe(10);
  });

  it('treats a variable set to the empty string as unset', () => {
    // `.env.example` ships blanks like `WEBHOOK_URL=`; "present but empty" is
    // never what anybody meant, and an empty string is not a URL.
    const config = parseConfig(env({ WEBHOOK_URL: '', OPERATOR_USER_ID: '', LOG_LEVEL: '' }));

    expect(config.WEBHOOK_URL).toBeUndefined();
    expect(config.OPERATOR_USER_ID).toBeUndefined();
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('accepts the optional wave 3 and wave 4 variables', () => {
    const config = parseConfig(
      env({
        WEBHOOK_URL: 'https://api.example.invalid/webhooks/aerodatabox/deadbeef',
        OPERATOR_USER_ID: '0f2b9b4e-4a1d-4f4e-9a3f-1c2d3e4f5a6b',
      }),
    );

    expect(config.WEBHOOK_URL).toBe('https://api.example.invalid/webhooks/aerodatabox/deadbeef');
    expect(config.OPERATOR_USER_ID).toBe('0f2b9b4e-4a1d-4f4e-9a3f-1c2d3e4f5a6b');
  });

  it('accepts an optional EXPO_ACCESS_TOKEN, and never echoes a bad one', () => {
    const token = 'not-a-real-expo-access-token-0000000';
    expect(parseConfig(env()).EXPO_ACCESS_TOKEN).toBeUndefined();
    expect(parseConfig(env({ EXPO_ACCESS_TOKEN: token })).EXPO_ACCESS_TOKEN).toBe(token);

    // A space or newline could split the Authorization header; too short is a paste error.
    for (const bad of [`${token} x`, `${token}\r\nX-Evil: 1`, 'short']) {
      let caught: unknown;
      try {
        parseConfig(env({ EXPO_ACCESS_TOKEN: bad }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).variables).toEqual(['EXPO_ACCESS_TOKEN']);
      expect((caught as Error).message).not.toContain(token);
    }
  });

  it('requires WEBHOOK_URL to be https, and never echoes it', () => {
    const plain = 'http://api.example.invalid/webhooks/aerodatabox/FAKE-TEST-TOKEN-not-a-secret';
    for (const bad of [plain, 'not a url', 'ftp://example.invalid/x']) {
      let thrown: unknown;
      try {
        parseConfig(env({ WEBHOOK_URL: bad }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).variables).toEqual(['WEBHOOK_URL']);
      expect((thrown as ConfigError).message).not.toContain('FAKE-TEST-TOKEN');
      expect((thrown as ConfigError).message).not.toContain('example.invalid');
    }
  });

  describe('when the environment is unusable', () => {
    it('names the missing required variables and nothing else', () => {
      let thrown: unknown;
      try {
        parseConfig({});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConfigError);
      const error = thrown as ConfigError;
      expect([...error.variables].sort()).toEqual(['DATABASE_URL', 'RAPIDAPI_KEY']);
      expect(error.message).toContain('DATABASE_URL');
      expect(error.message).toContain('RAPIDAPI_KEY');
    });

    it('rejects a DATABASE_URL that is not a postgres URL', () => {
      expect(() => parseConfig(env({ DATABASE_URL: 'https://example.invalid/postgres' }))).toThrow(
        ConfigError,
      );
      expect(() => parseConfig(env({ DATABASE_URL: 'not a url at all' }))).toThrow(ConfigError);
      // A `postgres://` URL through the pooler is the shape that must pass.
      expect(parseConfig(env()).DATABASE_URL).toBe(FAKE_DATABASE_URL);
    });

    it('rejects a WEBHOOK_URL that is not a URL and an OPERATOR_USER_ID that is not a uuid', () => {
      expect(() => parseConfig(env({ WEBHOOK_URL: 'not-a-url' }))).toThrow(ConfigError);
      expect(() => parseConfig(env({ OPERATOR_USER_ID: 'nope' }))).toThrow(ConfigError);
    });

    it('rejects out-of-range and non-numeric poll settings', () => {
      expect(() => parseConfig(env({ POLL_INTERVAL_MS: '10' }))).toThrow(ConfigError);
      expect(() => parseConfig(env({ POLL_BATCH_SIZE: '0' }))).toThrow(ConfigError);
      expect(() => parseConfig(env({ POLL_BATCH_SIZE: 'lots' }))).toThrow(ConfigError);
      expect(() => parseConfig(env({ LOG_LEVEL: 'chatty' }))).toThrow(ConfigError);
    });

    it('never puts a value in the error, only names and issue codes', () => {
      const values = [FAKE_PASSWORD, FAKE_RAPIDAPI_KEY, 'aws-0-us-west-2.pooler.example.invalid'];

      const cases: NodeJS.ProcessEnv[] = [
        // Unparseable: the whole secret is the thing that failed validation.
        {
          DATABASE_URL: FAKE_DATABASE_URL.replace('postgresql://', ''),
          RAPIDAPI_KEY: FAKE_RAPIDAPI_KEY,
        },
        // Wrong protocol, password still present.
        {
          DATABASE_URL: FAKE_DATABASE_URL.replace('postgresql:', 'mysql:'),
          RAPIDAPI_KEY: FAKE_RAPIDAPI_KEY,
        },
        // A valid secret alongside an unrelated failure.
        { ...env(), LOG_LEVEL: 'chatty' },
        { ...env(), POLL_BATCH_SIZE: '999' },
      ];

      for (const source of cases) {
        let message = '';
        try {
          parseConfig(source);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).not.toBe('');
        for (const value of values) {
          expect(message).not.toContain(value);
        }
      }
    });
  });
});
