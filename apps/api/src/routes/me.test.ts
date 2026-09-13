/**
 * `GET /v1/me` — creates the two identity rows, and keeps creating exactly two
 * however many times it is called or however it races with itself.
 */
import { describe, expect, it } from 'vitest';

import { ensureSelfTraveler } from '../identity';
import { AUTH_HEADERS, TEST_USER, buildTestApp } from '../testing/app';
import { FakeDatabase } from '../testing/fakeSupabase';

describe('GET /v1/me', () => {
  it('creates the profile and the self traveller on the first call', async () => {
    const { app, db, serviceCalls } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { profile: { id: string }; traveler: Record<string, unknown> };
    expect(body.profile.id).toBe(TEST_USER.id);

    // `user_id = created_by = uid`: the user is the traveller and the person
    // who added them. Claiming somebody else's row is a different operation.
    expect(db.rows('travelers')).toHaveLength(1);
    expect(db.rows('travelers')[0]).toMatchObject({
      user_id: TEST_USER.id,
      created_by: TEST_USER.id,
    });
    expect(body.traveler.userId).toBe(TEST_USER.id);
    expect(body.traveler.createdBy).toBe(TEST_USER.id);

    // Identity is entirely user-scoped: the service-role client is untouched.
    expect(serviceCalls).toEqual([]);
  });

  it('falls back to the email local part when there is no display name', async () => {
    const { app, db } = buildTestApp();

    await app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS });

    expect(db.rows('profiles')[0]).toMatchObject({ display_name: 'ada' });
  });

  it('is idempotent: a second call creates nothing', async () => {
    const { app, db } = buildTestApp();

    const first = await app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS });
    const second = await app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(db.rows('profiles')).toHaveLength(1);
    expect(db.rows('travelers')).toHaveLength(1);
  });

  it('uses the profile the auth trigger already created', async () => {
    const db = new FakeDatabase();
    db.seed('profiles', {
      id: TEST_USER.id,
      display_name: 'Ada Lovelace',
      email: TEST_USER.email,
      quiet_hours_enabled: true,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    const { app } = buildTestApp({ db });

    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(db.rows('profiles')).toHaveLength(1);
    // The traveller's name comes from the profile, not from the email.
    expect(db.rows('travelers')[0]).toMatchObject({ display_name: 'Ada Lovelace' });
  });

  it('two concurrent first calls still produce one profile and one traveller', async () => {
    const { app, db } = buildTestApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS }),
      app.inject({ method: 'GET', url: '/v1/me', headers: AUTH_HEADERS }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(db.rows('profiles')).toHaveLength(1);
    expect(db.rows('travelers')).toHaveLength(1);
    expect(first.json()).toEqual(second.json());
  });
});

describe('ensureSelfTraveler under a lost-update race', () => {
  it('recovers from a unique violation by reading what the winner wrote', async () => {
    const db = new FakeDatabase();
    const { client } = db.client();

    // The row appears between our select and our insert — the exact ordering
    // the `23505` recovery path exists for.
    db.failNextWrite(
      'travelers',
      { code: '23505', message: 'duplicate key value violates travelers_self_traveler_uniq' },
      () => {
        db.seed('travelers', {
          id: '00000000-0000-4000-8000-0000000000ff',
          user_id: TEST_USER.id,
          created_by: TEST_USER.id,
          display_name: 'Ada Lovelace',
          claimed_at: null,
          created_at: '2026-09-12T00:00:00.000Z',
        });
      },
    );

    const traveler = await ensureSelfTraveler(client, TEST_USER.id, 'ada');

    expect(traveler.id).toBe('00000000-0000-4000-8000-0000000000ff');
    expect(traveler.displayName).toBe('Ada Lovelace');
    expect(db.rows('travelers')).toHaveLength(1);
  });
});
