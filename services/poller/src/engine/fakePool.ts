/**
 * Test support: a `Pool` that records statements instead of running them.
 *
 * The engine's SQL is asserted two ways — its text, here, against a fake, and its
 * behaviour in `lease.integration.test.ts` against a real database when
 * `INTEGRATION=1` asks for it. Unit tests never open a connection (§12.2).
 */
import type { Pool } from '../db';

export interface RecordedStatement {
  text: string;
  values: readonly unknown[];
}

export interface FakePool {
  pool: Pool;
  statements: RecordedStatement[];
  /** Queue a result for the next query. Exhausted queues fall back to no rows. */
  queue(rows: unknown[]): void;
  /** Make the next query reject. */
  failNext(error: Error): void;
}

export function createFakePool(): FakePool {
  const statements: RecordedStatement[] = [];
  const results: unknown[][] = [];
  let nextError: Error | null = null;

  const query = async (config: unknown, maybeValues?: unknown): Promise<{ rows: unknown[] }> => {
    // Supports both call shapes: `query(config)` and `query(text, values)`.
    const text = typeof config === 'string' ? config : (config as { text: string }).text;
    const values =
      typeof config === 'string'
        ? ((maybeValues ?? []) as readonly unknown[])
        : (((config as { values?: readonly unknown[] }).values ?? []) as readonly unknown[]);

    statements.push({ text, values });

    if (nextError !== null) {
      const error = nextError;
      nextError = null;
      throw error;
    }

    return { rows: results.shift() ?? [] };
  };

  return {
    pool: { query } as unknown as Pool,
    statements,
    queue(rows) {
      results.push(rows);
    },
    failNext(error) {
      nextError = error;
    },
  };
}
