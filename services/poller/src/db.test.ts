import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from './config';
import {
  APPLICATION_NAME,
  MAX_POOL_CONNECTIONS,
  SUPABASE_ROOT_CA_PATH,
  connectionSettings,
  poolConfig,
} from './db';

const FAKE_RAPIDAPI_KEY = 'not-a-real-rapidapi-key-0000';

function configFor(databaseUrl: string): Config {
  return parseConfig({ DATABASE_URL: databaseUrl, RAPIDAPI_KEY: FAKE_RAPIDAPI_KEY });
}

describe('connectionSettings', () => {
  it('splits a session-pooler URL into fields', () => {
    const settings = connectionSettings(
      configFor(
        'postgresql://flightbuddy_worker.abcdef:not-a-real-password@aws-0-us-west-2.pooler.example.invalid:5432/postgres?sslmode=require',
      ),
    );

    expect(settings.host).toBe('aws-0-us-west-2.pooler.example.invalid');
    expect(settings.port).toBe(5432);
    expect(settings.user).toBe('flightbuddy_worker.abcdef');
    expect(settings.password).toBe('not-a-real-password');
    expect(settings.database).toBe('postgres');
  });

  it('percent-decodes a password with URL-significant characters', () => {
    const settings = connectionSettings(
      configFor('postgres://worker:p%40ss%2Fword%3F1@host.invalid:5432/postgres'),
    );

    expect(settings.password).toBe('p@ss/word?1');
  });

  it('defaults the port and the database name', () => {
    const settings = connectionSettings(configFor('postgres://worker:pw@host.invalid/'));

    expect(settings.port).toBe(5432);
    expect(settings.database).toBe('postgres');
  });

  describe('TLS', () => {
    it('verifies against the pinned Supabase CA, and never turns verification off', () => {
      const ca = readFileSync(SUPABASE_ROOT_CA_PATH, 'utf8');

      for (const url of [
        'postgres://worker:pw@host.invalid:5432/postgres?sslmode=require',
        'postgres://worker:pw@host.invalid:5432/postgres?sslmode=verify-full',
        // No sslmode at all still means TLS: the default is `require`, never off.
        'postgres://worker:pw@host.invalid:5432/postgres',
      ]) {
        const { ssl } = connectionSettings(configFor(url));
        expect(ssl, url).toEqual({ ca, rejectUnauthorized: true });
      }
    });

    it('bundles a CA certificate that is the Supabase root, not an empty file', () => {
      const ca = readFileSync(SUPABASE_ROOT_CA_PATH, 'utf8');

      expect(ca).toMatch(/^-----BEGIN CERTIFICATE-----/);
      expect(ca.trimEnd()).toMatch(/-----END CERTIFICATE-----$/);
      expect(ca).not.toContain('PRIVATE KEY');
    });

    it('honours sslmode=disable, for a local Postgres with no TLS', () => {
      const { ssl } = connectionSettings(
        configFor('postgres://worker:pw@localhost.invalid:5432/postgres?sslmode=disable'),
      );

      expect(ssl).toBe(false);
    });
  });
});

describe('poolConfig', () => {
  it('caps the pool below the role connection limit and names itself', () => {
    const config = poolConfig(
      configFor('postgres://worker:pw@host.invalid:5432/postgres?sslmode=require'),
    );

    // The role allows 10 and pg-boss opens its own pool on the same login.
    expect(MAX_POOL_CONNECTIONS * 2).toBeLessThanOrEqual(6); // two pools under the role's limit of 10
    expect(config.max).toBe(MAX_POOL_CONNECTIONS);
    expect(config.application_name).toBe(APPLICATION_NAME);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('does not pass a connectionString, which would overwrite the pinned CA', () => {
    const config = poolConfig(
      configFor('postgres://worker:pw@host.invalid:5432/postgres?sslmode=require'),
    );

    expect(config.connectionString).toBeUndefined();
  });

  it('never sets a statement timeout: that belongs to the database role', () => {
    const config = poolConfig(
      configFor('postgres://worker:pw@host.invalid:5432/postgres?sslmode=require'),
    );

    expect(config.statement_timeout).toBeUndefined();
  });
});
