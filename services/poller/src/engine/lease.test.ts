import { describe, expect, it } from 'vitest';

import { createFakePool } from './fakePool';
import {
  CLAIM_DUE_FLIGHTS_SQL,
  DEFAULT_LEASE_MS,
  RELEASE_LEASE_SQL,
  claimDueFlights,
  releaseLease,
} from './lease';

describe('CLAIM_DUE_FLIGHTS_SQL', () => {
  it('is the §7.5 statement: update … where id in (select … for update skip locked)', () => {
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('update public.flights');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('set poll_lease_until = now()');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('where id in (');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('for update skip locked');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('returning *');
    // The overview prints `skip lock`; Postgres spells it `skip locked`.
    expect(CLAIM_DUE_FLIGHTS_SQL).not.toMatch(/skip lock\b(?!ed)/);
  });

  it('claims only unarchived, due, unleased flights', () => {
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('archived_at is null');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('next_poll_at <= now()');
    // A null next_poll_at is the "do not poll" state: manual tier, or (wave 3) a
    // flight whose alerts arrive by webhook. It must never be claimable.
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('next_poll_at is not null');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain(
      '(poll_lease_until is null or poll_lease_until < now())',
    );
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('order by next_poll_at');
  });

  it('binds the batch size and the lease length, and inlines nothing', () => {
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('limit $1');
    expect(CLAIM_DUE_FLIGHTS_SQL).toContain('$2::double precision');
    // The only quoted literal is the interval unit, which is not a value.
    const literals = CLAIM_DUE_FLIGHTS_SQL.match(/'[^']*'/g) ?? [];
    expect(literals).toEqual(["'1 millisecond'"]);
    expect(CLAIM_DUE_FLIGHTS_SQL).not.toContain(';');
  });

  it('holds no lock across the HTTP call: one statement, no explicit transaction', () => {
    // §7.5, §8.7. `begin`/`commit` here would mean the lease is held, not taken.
    expect(CLAIM_DUE_FLIGHTS_SQL.toLowerCase()).not.toContain('begin');
    expect(CLAIM_DUE_FLIGHTS_SQL.toLowerCase()).not.toContain('commit');
  });

  it('never deletes: the worker role has no DELETE grant', () => {
    expect(CLAIM_DUE_FLIGHTS_SQL.toLowerCase()).not.toContain('delete');
    expect(RELEASE_LEASE_SQL.toLowerCase()).not.toContain('delete');
  });
});

describe('claimDueFlights', () => {
  it('sends the batch size and lease length as bound parameters', async () => {
    const fake = createFakePool();
    fake.queue([{ id: 'flight-1' }, { id: 'flight-2' }]);

    const rows = await claimDueFlights(fake.pool, 25, 90_000);

    expect(rows).toHaveLength(2);
    expect(fake.statements[0]?.text).toBe(CLAIM_DUE_FLIGHTS_SQL);
    expect(fake.statements[0]?.values).toEqual([25, 90_000]);
  });

  it('defaults to a two-minute lease (§7.5)', async () => {
    const fake = createFakePool();

    await claimDueFlights(fake.pool, 25);

    expect(DEFAULT_LEASE_MS).toBe(120_000);
    expect(fake.statements[0]?.values[1]).toBe(120_000);
  });

  it('returns an empty batch when nothing is due', async () => {
    const fake = createFakePool();
    await expect(claimDueFlights(fake.pool, 25)).resolves.toEqual([]);
  });

  it('refuses a batch size or lease that would misbehave', async () => {
    const fake = createFakePool();
    await expect(claimDueFlights(fake.pool, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(claimDueFlights(fake.pool, 2.5)).rejects.toBeInstanceOf(RangeError);
    await expect(claimDueFlights(fake.pool, 25, 0)).rejects.toBeInstanceOf(RangeError);
    // Nothing reached the database.
    expect(fake.statements).toHaveLength(0);
  });

  it('propagates a database failure so the pass ends and the leases expire', async () => {
    const fake = createFakePool();
    fake.failNext(new Error('connection terminated'));
    await expect(claimDueFlights(fake.pool, 25)).rejects.toThrow('connection terminated');
  });
});

describe('releaseLease', () => {
  it('clears the lease by id, parameterised', async () => {
    const fake = createFakePool();

    await releaseLease(fake.pool, 'flight-1');

    expect(fake.statements[0]?.text).toBe(RELEASE_LEASE_SQL);
    expect(fake.statements[0]?.text).toContain('poll_lease_until = null');
    expect(fake.statements[0]?.text).toContain('where id = $1');
    expect(fake.statements[0]?.values).toEqual(['flight-1']);
  });
});
