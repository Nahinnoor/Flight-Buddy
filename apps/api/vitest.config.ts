import { defineConfig } from 'vitest/config';

/**
 * These are integration tests: each one builds the real Fastify app and drives
 * it through `app.inject()`. The very first `Fastify()` call in a worker pulls
 * in the whole framework's module graph — over a second, and more under vitest's
 * transform — and that one-time cost lands on whichever test happens to run
 * first, not on anything that test is doing. The default 5s timeout turns that
 * into a flake that moves around when tests are reordered.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
