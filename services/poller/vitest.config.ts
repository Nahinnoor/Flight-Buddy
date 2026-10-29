import { defineConfig } from 'vitest/config';

/**
 * Integration files (`INTEGRATION=1`, only on the throwaway cluster that
 * `supabase/tests/run-local.sh --exec` builds; see `src/throwawayDb.ts`) share one
 * database per run, and each refuses to start unless `auth.users` is empty, so they
 * run one file at a time. pg-boss's first `start()` against an empty schema builds
 * its tables and indexes, past vitest's 5 s default, and the unit tests in this
 * workspace are not fast enough for the default to be earning anything anyway.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: process.env.INTEGRATION !== '1',
  },
});
