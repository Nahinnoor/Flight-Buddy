/**
 * Test support: the captured AeroDataBox responses in `docs/api-samples/`.
 *
 * §12.1 rations real provider calls to 20 per agent and §12.2 says to build
 * against the saved responses thereafter, so every test in this package reads
 * from here and none of them touch the network. The files are verbatim bodies;
 * see `docs/api-samples/README.md` for the request that produced each one.
 *
 * Not exported from the package entry point — this is for tests only.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/api-samples');

/** The raw body of a captured response, exactly as the provider sent it. */
export function fixtureBody(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.json`), 'utf8');
}

/** A captured response parsed as JSON. */
export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureBody(name)) as T;
}
