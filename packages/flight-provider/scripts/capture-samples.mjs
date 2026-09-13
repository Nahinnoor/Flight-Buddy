/**
 * Capture one real AeroDataBox response into `docs/api-samples/`.
 *
 * Exploration is rationed: §12.1 allows 20 calls per agent, and every call
 * spends real quota, so this script does exactly one request per invocation and
 * appends a line to `docs/api-samples/calls.tsv` so the budget is auditable.
 *
 * The response body is written verbatim (pretty-printed when it is JSON). The
 * key is read from the root `.env` via dotenv, is never printed, and the write
 * is refused outright if the body echoes it back — fixtures are committed.
 *
 *   node packages/flight-provider/scripts/capture-samples.mjs \
 *     flights-number-simple "/flights/number/DL1234/2026-09-15?dateLocalRole=Departure"
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT_DIR = resolve(REPO_ROOT, 'docs/api-samples');
const CALL_LOG = resolve(OUT_DIR, 'calls.tsv');
const HOST = process.env.AERODATABOX_HOST ?? 'aerodatabox.p.rapidapi.com';

config({ path: resolve(REPO_ROOT, '.env'), quiet: true });

const apiKey = process.env.RAPIDAPI_KEY;
if (!apiKey) {
  console.error('RAPIDAPI_KEY is not set (expected in the root .env).');
  process.exit(1);
}

const [, , caseName, path] = process.argv;
if (!caseName || !path) {
  console.error('usage: capture-samples.mjs <case-name> <api-path>');
  process.exit(1);
}

const response = await fetch(`https://${HOST}${path}`, {
  headers: {
    'X-RapidAPI-Key': apiKey,
    'X-RapidAPI-Host': HOST,
    Accept: 'application/json',
  },
});
const text = await response.text();

if (text.includes(apiKey)) {
  console.error('Refusing to write: the response body echoes the API key.');
  process.exit(2);
}

let body = text;
if (body.trim() === '') {
  body = JSON.stringify(
    { _note: `HTTP ${response.status} ${response.statusText} with an empty body` },
    null,
    2,
  );
}
try {
  body = JSON.stringify(JSON.parse(body), null, 2);
} catch {
  // Not JSON (an HTML gateway error, say) — keep it exactly as received.
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, `${caseName}.json`), `${body}\n`);
appendFileSync(CALL_LOG, `${new Date().toISOString()}\t${caseName}\t${path}\t${response.status}\n`);

const summary = { case: caseName, path, status: response.status, bytes: text.length };
try {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    summary.items = parsed.length;
    summary.legs = parsed.map((flight) => ({
      number: flight.number,
      callSign: flight.callSign,
      codeshareStatus: flight.codeshareStatus,
      status: flight.status,
      airline: flight.airline?.iata,
      from: flight.departure?.airport?.iata,
      to: flight.arrival?.airport?.iata,
      depLocal: flight.departure?.scheduledTime?.local,
      depUtc: flight.departure?.scheduledTime?.utc,
      quality: flight.departure?.quality,
    }));
  }
} catch {
  // Non-JSON body: the status and byte count are all the summary there is.
}
console.log(JSON.stringify(summary, null, 2));
