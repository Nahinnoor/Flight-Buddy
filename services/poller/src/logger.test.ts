import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { REDACT_CENSOR, createLogger } from './logger';

/** Collects each JSON line pino writes. */
function captureLines(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { lines, stream };
}

function logOnce(
  payload: object,
  message = 'test',
): { raw: string; parsed: Record<string, unknown> } {
  const { lines, stream } = captureLines();
  createLogger({ level: 'info', destination: stream }).info(payload, message);
  const raw = lines.join('');
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

/**
 * Obvious stand-ins. If one of these ever appears in real output, the grep that
 * finds it should find a test file, not a credential.
 */
const FAKE = {
  token: 'not-a-real-token-ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  password: 'not-a-real-password-91b2',
  email: 'not-a-real-person@example.invalid',
  displayName: 'Not A Real Person',
  connectionString: 'postgresql://user:not-a-real-password-91b2@host.invalid:5432/postgres',
  authorization: 'Bearer not-a-real-jwt.not-a-real-payload.not-a-real-signature',
  apiKey: 'not-a-real-rapidapi-key-0000',
};

describe('createLogger', () => {
  it('writes one JSON line tagged with the service', () => {
    const { parsed } = logOnce({ flightId: 'abc' }, 'hello');

    expect(parsed.service).toBe('poller');
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.flightId).toBe('abc');
    expect(typeof parsed.time).toBe('string');
  });

  it('redacts secrets and personal data at the top level', () => {
    const { raw } = logOnce({
      authorization: FAKE.authorization,
      password: FAKE.password,
      connectionString: FAKE.connectionString,
      expo_push_token: FAKE.token,
      email: FAKE.email,
      display_name: FAKE.displayName,
      apiKey: FAKE.apiKey,
      flightId: '0f2b9b4e-4a1d-4f4e-9a3f-1c2d3e4f5a6b',
    });

    for (const value of Object.values(FAKE)) {
      expect(raw).not.toContain(value);
    }
    // Redaction is not deletion: the key is still there, so a log line still
    // shows that a field was present.
    expect(raw).toContain(REDACT_CENSOR);
    // Ids are the whole point of the log line and must survive.
    expect(raw).toContain('0f2b9b4e-4a1d-4f4e-9a3f-1c2d3e4f5a6b');
  });

  it('redacts one and two levels deep, which is where rows and headers arrive', () => {
    const { raw, parsed } = logOnce({
      headers: { authorization: FAKE.authorization, 'x-request-id': 'req-1' },
      profile: { id: 'p1', email: FAKE.email, expo_push_token: FAKE.token },
      job: { data: { password: FAKE.password, displayName: FAKE.displayName } },
    });

    expect(raw).not.toContain(FAKE.authorization);
    expect(raw).not.toContain(FAKE.email);
    expect(raw).not.toContain(FAKE.token);
    expect(raw).not.toContain(FAKE.password);
    expect(raw).not.toContain(FAKE.displayName);

    expect((parsed.headers as Record<string, unknown>)['x-request-id']).toBe('req-1');
    expect((parsed.profile as Record<string, unknown>).id).toBe('p1');
  });

  it('redacts the environment variable names the worker reads', () => {
    const { raw } = logOnce({
      DATABASE_URL: FAKE.connectionString,
      RAPIDAPI_KEY: FAKE.apiKey,
      WEBHOOK_URL: 'https://api.example.invalid/webhooks/aerodatabox/not-a-real-token',
    });

    expect(raw).not.toContain(FAKE.connectionString);
    expect(raw).not.toContain(FAKE.apiKey);
    expect(raw).not.toContain('not-a-real-token');
  });

  it('does not redact a secret pasted into the message string', () => {
    // Documenting the limit rather than pretending it away: pino redacts object
    // keys, not text. Every call site logs fields, never interpolated values.
    const { raw } = logOnce({}, `token=${FAKE.token}`);

    expect(raw).toContain(FAKE.token);
  });

  it('honours the configured level', () => {
    const { lines, stream } = captureLines();
    const logger = createLogger({ level: 'warn', destination: stream });

    logger.info({}, 'not this one');
    logger.warn({}, 'this one');

    expect(lines.join('')).not.toContain('not this one');
    expect(lines.join('')).toContain('this one');
  });
});
