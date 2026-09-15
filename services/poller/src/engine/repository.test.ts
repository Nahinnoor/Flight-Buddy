import { describe, expect, it } from 'vitest';

import type { DetectedEvent } from './changeDetector';
import { createFakePool } from './fakePool';
import {
  RECORD_POLL_FAILURE_SQL,
  RECORD_POLL_SUCCESS_SQL,
  buildInsertEventsSql,
  insertFlightEvents,
  recordPollFailure,
  recordPollSuccess,
} from './repository';

const NOW = new Date('2026-09-15T12:00:00.000Z');

const GATE_CHANGE: DetectedEvent = {
  type: 'gate_change',
  previousValue: { gate: 'B24', terminal: '5' },
  newValue: { gate: 'C11', terminal: '5' },
  source: 'poll',
};

const DELAY: DetectedEvent = {
  type: 'delay',
  previousValue: null,
  newValue: { departureUtc: '2026-09-15T14:00:00.000Z', movedByMinutes: 45 },
  source: 'poll',
};

describe('scheduling statements', () => {
  it('touch only scheduling columns — never provider data (rule 7)', () => {
    for (const sql of [RECORD_POLL_SUCCESS_SQL, RECORD_POLL_FAILURE_SQL]) {
      for (const providerColumn of [
        'status',
        'gate',
        'terminal',
        'scheduled_departure_utc',
        'estimated_departure_utc',
        'actual_arrival_utc',
        'raw_payload',
        'tracking_tier',
      ]) {
        expect(sql).not.toContain(providerColumn);
      }
    }
  });

  it('never delete, and never leave a lease behind', () => {
    for (const sql of [RECORD_POLL_SUCCESS_SQL, RECORD_POLL_FAILURE_SQL]) {
      expect(sql.toLowerCase()).not.toContain('delete');
      expect(sql).toContain('poll_lease_until = null');
      expect(sql).toContain('where id = $1');
    }
  });

  it('leave archived_at alone on the failure path (§8.8: unknown is not cancelled)', () => {
    expect(RECORD_POLL_SUCCESS_SQL).toContain('archived_at = $4');
    expect(RECORD_POLL_FAILURE_SQL).not.toContain('archived_at');
  });

  it('resets the failure counter on success and sets it on failure', () => {
    expect(RECORD_POLL_SUCCESS_SQL).toContain('poll_failure_count = 0');
    expect(RECORD_POLL_FAILURE_SQL).toContain('poll_failure_count = $4');
  });
});

describe('recordPollSuccess', () => {
  it('binds every value', async () => {
    const fake = createFakePool();

    await recordPollSuccess(fake.pool, {
      flightId: 'flight-1',
      nextPollAt: new Date('2026-09-15T13:00:00.000Z'),
      polledAt: NOW,
      archivedAt: null,
    });

    expect(fake.statements[0]?.values).toEqual([
      'flight-1',
      new Date('2026-09-15T13:00:00.000Z'),
      NOW,
      null,
    ]);
  });

  it('stops the ladder and archives in one statement', async () => {
    const fake = createFakePool();

    await recordPollSuccess(fake.pool, {
      flightId: 'flight-1',
      nextPollAt: null,
      polledAt: NOW,
      archivedAt: NOW,
    });

    expect(fake.statements[0]?.values).toEqual(['flight-1', null, NOW, NOW]);
  });
});

describe('recordPollFailure', () => {
  it('binds the new failure count and the backed-off next poll', async () => {
    const fake = createFakePool();
    const next = new Date('2026-09-15T18:00:00.000Z');

    await recordPollFailure(fake.pool, {
      flightId: 'flight-1',
      nextPollAt: next,
      polledAt: NOW,
      failureCount: 3,
    });

    expect(fake.statements[0]?.values).toEqual(['flight-1', next, NOW, 3]);
  });
});

describe('buildInsertEventsSql', () => {
  it('generates placeholders from the row index, never from a value', () => {
    expect(buildInsertEventsSql(1)).toContain('($1, $2, $3::jsonb, $4::jsonb, $5)');
    expect(buildInsertEventsSql(2)).toContain(
      '($1, $2, $3::jsonb, $4::jsonb, $5), ($6, $7, $8::jsonb, $9::jsonb, $10)',
    );
  });

  it('inlines no literal at all', () => {
    const sql = buildInsertEventsSql(3);
    expect(sql).not.toContain("'");
    expect(sql).not.toContain(';');
  });
});

describe('insertFlightEvents', () => {
  it('writes nothing, and asks nothing, for an empty batch', async () => {
    const fake = createFakePool();
    await expect(insertFlightEvents(fake.pool, 'flight-1', [])).resolves.toEqual([]);
    expect(fake.statements).toHaveLength(0);
  });

  it('writes one statement for the batch and returns the new ids', async () => {
    const fake = createFakePool();
    fake.queue([{ id: 'event-1' }, { id: 'event-2' }]);

    const ids = await insertFlightEvents(fake.pool, 'flight-1', [DELAY, GATE_CHANGE]);

    expect(ids).toEqual(['event-1', 'event-2']);
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.values).toEqual([
      'flight-1',
      'delay',
      null,
      JSON.stringify(DELAY.newValue),
      'poll',
      'flight-1',
      'gate_change',
      JSON.stringify(GATE_CHANGE.previousValue),
      JSON.stringify(GATE_CHANGE.newValue),
      'poll',
    ]);
  });

  it('passes provider values as JSON parameters, never as statement text', async () => {
    const fake = createFakePool();
    fake.queue([{ id: 'event-1' }]);

    // A gate the provider "returned" that is really an injection attempt. It is
    // data: it must appear in the parameters and nowhere near the statement.
    const hostile: DetectedEvent = {
      type: 'gate_change',
      previousValue: { gate: null, terminal: null },
      newValue: { gate: "A1'); drop table public.flights; --", terminal: null },
      source: 'poll',
    };

    await insertFlightEvents(fake.pool, 'flight-1', [hostile]);

    expect(fake.statements[0]?.text).not.toContain('drop table');
    expect(fake.statements[0]?.text).toBe(buildInsertEventsSql(1));
    expect(JSON.stringify(fake.statements[0]?.values)).toContain('drop table');
  });
});
