import { defineConfig } from 'vitest/config';

/**
 * `queue.integration.test.ts` opens a real connection to the Supabase session
 * pooler and lets pg-boss run its migration. Both are network round trips over a
 * pooler in another region, and pg-boss's first `start()` against an empty schema
 * builds its tables and indexes — comfortably past vitest's 5 s default, and the
 * unit tests in this workspace are not fast enough for the default to be earning
 * anything anyway.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
