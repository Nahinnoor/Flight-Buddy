# 0002. Workspaces consume `@flightbuddy/shared` as TypeScript source

## Status

Accepted — 2026-09-11.

## Context

`packages/shared` is imported by three different runtimes: Metro/Hermes (`apps/mobile`), `tsx` and
later a bundled Node process (`apps/api`, `services/poller`), and `tsc` for typechecking. A
compiled `dist/` entry point would mean every workspace has to build `shared` before it can even
typecheck or start the Expo dev server, which is a stale-build footgun for four agents working in
parallel during Phase 1.

## Decision

`@flightbuddy/shared` and `@flightbuddy/flight-provider` point `main`, `types` and `exports` at
`./src/index.ts`. Every package sets `"moduleResolution": "bundler"` (via `tsconfig.base.json`) and
uses extensionless relative imports, which is the only specifier style Metro, `tsx` and `tsc` all
agree on. There is no build step in Phase 1.

## Consequences

- No build ordering: `npm run typecheck` and `npm test` work on a fresh clone after `npm install`.
- Consumers compile `shared` themselves, so anything in it must be plain TypeScript that Metro's
  Babel transform accepts — no `.js`-extension imports, no Node-only builtins in shared code.
- Shipping the API to Render in Phase 2 needs a bundle step (esbuild/tsup) or a switch to emitted
  `dist/` output with the same `exports` keys. That is a one-line change to two `package.json`
  files when it happens.
