// test/dsh.log-frames.test.js — the DSH log decoder: a session log is read as the independent zstd frames DSH
// appends, decoding every complete frame and leaving a final frame cut short by EOF behind, and a file is a DSH log
// exactly when its plaintext's first line is a session header, whether zstd, gzip or unencoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { decodeDshLog, walkZstdFrames } from '../lib/harness/dsh/log-frames.js';
import * as E from './helpers/dsh-events.js';

// DSH checksums every frame it appends, and the checksum trails the last block, so these frames carry one too.
const CHECKSUMMED = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

const jsonl = records => records.map(record => `${JSON.stringify(record)}\n`).join('');

// A zstd log as DSH appends it: the header line as one frame, then each batch of events as another.
function zstdLog(header, batches) {
  return Buffer.concat([[header], ...batches].map(records => zstdCompressSync(jsonl(records), CHECKSUMMED)));
}

const CLAUDE_CODE_ROWS = [
  { type: 'user', uuid: 'u-1', timestamp: '2026-09-27T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-27T00:00:01.000Z', message: { role: 'assistant', content: [] } },
];

const NOT_A_LOG = { message: 'not a DSH session log: its first line is not a session header' };

test('frames are walked to the last complete one', () => {
  const header = '{"type":"session","version":4,"id":"session-a"}\n';
  const batch = '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}\n'
    + '{"type":"step/start","seq":1,"time":2,"data":{"turn":1,"step":1}}\n';
  const torn = zstdCompressSync('{"type":"step/end","seq":2,"time":3,"data":{"turn":1,"step":1}}\n', CHECKSUMMED);
  const log = Buffer.concat([
    zstdCompressSync(header, CHECKSUMMED),
    zstdCompressSync(batch, CHECKSUMMED),
    torn.subarray(0, Math.floor(torn.length / 2)),
  ]);

  assert.deepEqual(walkZstdFrames(log).map(String), [header, batch]);
});

test('a zstd log decodes to its header line and its events in log order', () => {
  const header = E.header({ id: 'session-zstd' });
  const events = E.retryWithUsage();
  const log = zstdLog(header, [events.slice(0, 3), events.slice(3, 4), events.slice(4)]);

  assert.deepEqual(decodeDshLog(log), { header, events });
});

test('a gzip fixture decodes to the same header and events as its zstd log', () => {
  const header = E.header({ id: 'session-gzip' });
  const events = E.toolError();
  const log = zstdLog(header, [events.slice(0, 5), events.slice(5)]);
  // The fixture extraction's own output: every complete frame's plaintext, gzip-compressed whole.
  const fixture = gzipSync(Buffer.concat(walkZstdFrames(log)));

  assert.deepEqual(decodeDshLog(fixture), decodeDshLog(log));
  assert.deepEqual(decodeDshLog(fixture), { header, events });
});

test('unencoded bytes whose first line is a session header decode as a plaintext log, and any other unencoded bytes decode to null', () => {
  const header = E.header({ id: 'session-plain' });
  const events = E.askAborted();

  assert.deepEqual(decodeDshLog(Buffer.from(jsonl([header, ...events]))), { header, events });
  assert.deepEqual(decodeDshLog(Buffer.from(JSON.stringify(header))), { header, events: [] });
  assert.equal(decodeDshLog(Buffer.from(jsonl(CLAUDE_CODE_ROWS))), null);
  assert.equal(decodeDshLog(Buffer.from('null\n')), null);
  assert.equal(decodeDshLog(Buffer.from(`{"type":"session"\n${jsonl(events)}`)), null);
  assert.equal(decodeDshLog(Buffer.alloc(0)), null);
});

test('a zstd or gzip log whose first line is not a session header throws', () => {
  const plaintext = jsonl(CLAUDE_CODE_ROWS);

  assert.throws(() => decodeDshLog(zstdCompressSync(plaintext, CHECKSUMMED)), NOT_A_LOG);
  assert.throws(() => decodeDshLog(gzipSync(plaintext)), NOT_A_LOG);
  assert.throws(() => decodeDshLog(gzipSync(`{"type":"session"\n${jsonl(E.askAborted())}`)), NOT_A_LOG);
});

test('a log with a session header followed by a line that does not parse throws the parse error', () => {
  const log = `${jsonl([E.header({ id: 'session-torn' })])}{"type":"user/message"\n`;

  assert.throws(() => decodeDshLog(gzipSync(log)), SyntaxError);
});
