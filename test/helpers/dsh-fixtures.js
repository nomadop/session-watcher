// test/helpers/dsh-fixtures.js — the local DSH fixture corpus: `fixtures/dsh/<name>.jsonl.gz`, a session log as
// `scripts/dsh-fixture-extract.mjs` writes it, and `<name>.expected.json` beside it, which
// `scripts/dsh-fixture-expect.mjs` derives from the log's events. Both are produced on the machine that recorded the
// sessions and never committed, so a fixture case runs only where both are present.
import { existsSync, readFileSync } from 'node:fs';
import { decodeDshLog } from '../../lib/harness/dsh/log-frames.js';

const FIXTURE_DIR = new URL('../../fixtures/dsh/', import.meta.url);

const logUrl = name => new URL(`${name}.jsonl.gz`, FIXTURE_DIR);
const expectationUrl = name => new URL(`${name}.expected.json`, FIXTURE_DIR);

/** Whether both files of the named fixture are present; a fixture case skips on `!hasDshFixture(name)`. */
export function hasDshFixture(name) {
  return existsSync(logUrl(name)) && existsSync(expectationUrl(name));
}

/** The named fixture log as `{ header, events }`: its header line and its events in log order. */
export function readDshFixture(name) {
  return decodeDshLog(readFileSync(logUrl(name)));
}

/** The named fixture's `.expected.json`: `{ source, reducer, application }`. */
export function expectationsOf(name) {
  return JSON.parse(readFileSync(expectationUrl(name), 'utf8'));
}
