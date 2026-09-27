import { describe, expect, it } from 'vitest';

import type { FlightEventType } from './changeDetector';
import { notifyingEventTypes } from './notificationPolicy';

const batch = (...types: FlightEventType[]) => types.map((type) => ({ type }));
const onGround = { status: 'scheduled' as const, actualDepartureUtc: null };
const airborne = { status: 'en_route' as const, actualDepartureUtc: '2026-09-11T20:00:00.000Z' };

describe('notifyingEventTypes (§9)', () => {
  it('passes every §9 type on its own', () => {
    for (const type of ['delay', 'gate_change'] as const) {
      expect(notifyingEventTypes(batch(type), onGround)).toEqual([type]);
    }
    expect(
      notifyingEventTypes(batch('cancelled'), { status: 'cancelled', actualDepartureUtc: null }),
    ).toEqual(['cancelled']);
    expect(notifyingEventTypes(batch('departed'), airborne)).toEqual(['departed']);
    expect(
      notifyingEventTypes(batch('landed'), { status: 'landed', actualDepartureUtc: 'x' }),
    ).toEqual(['landed']);
    expect(
      notifyingEventTypes(batch('diverted'), { status: 'diverted', actualDepartureUtc: null }),
    ).toEqual(['diverted']);
  });

  it('an already-cancelled flight notifies nothing further', () => {
    expect(
      notifyingEventTypes(batch('gate_change', 'delay'), {
        status: 'cancelled',
        actualDepartureUtc: null,
      }),
    ).toEqual([]);
  });

  it('once airborne, gate and delay news is moot; the departure push carries the time', () => {
    expect(notifyingEventTypes(batch('delay', 'gate_change', 'departed'), airborne)).toEqual([
      'departed',
    ]);
    expect(notifyingEventTypes(batch('gate_change'), airborne)).toEqual([]);
  });

  it('landed supersedes departed in one poll; diverted supersedes landed', () => {
    expect(
      notifyingEventTypes(batch('departed', 'landed'), {
        status: 'landed',
        actualDepartureUtc: 'x',
      }),
    ).toEqual(['landed']);
    expect(
      notifyingEventTypes(batch('diverted', 'departed', 'landed'), {
        status: 'diverted',
        actualDepartureUtc: 'x',
      }),
    ).toEqual(['diverted']);
  });

  it('keeps delay and gate together on the ground', () => {
    expect(notifyingEventTypes(batch('delay', 'gate_change'), onGround)).toEqual([
      'delay',
      'gate_change',
    ]);
  });
});
