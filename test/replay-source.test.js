// test/replay-source.test.js — a replay source is opened by the file's bytes: a DSH log, zstd, gzip or plaintext,
// opens as `dsh` with its index, header and dialogue snapshot, any other unencoded file as a Claude Code transcript,
// and every open hands drivers that each start from the file's beginning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { openReplaySource } from '../lib/replay-source.js';
import { indexTranscript } from '../lib/replay.js';
import { indexDshLog } from '../lib/harness/dsh/playback.js';
import * as E from './helpers/dsh-events.js';

const CHECKSUMMED = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const jsonl = records => records.map(record => `${JSON.stringify(record)}\n`).join('');

const CLAUDE_CODE_ROWS = [
  { type: 'user', uuid: 'u-1', parentUuid: null, isSidechain: false, timestamp: '2026-09-27T00:00:01.000Z',
    message: { role: 'user', content: 'start' } },
  { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', isSidechain: false, timestamp: '2026-09-27T00:00:02.000Z',
    message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } },
  { type: 'assistant', uuid: 'a-2', parentUuid: 'a-1', isSidechain: false, timestamp: '2026-09-27T00:00:03.000Z',
    message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-8', content: [],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 } } },
];

function withFile(name, bytes, run) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-replay-source-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  try { return run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a zstd log opens as dsh with its index, header and a dialogue snapshot of its events', () => {
  const header = E.header({ id: 'session-replay-zstd', cwd: '/repo-zstd' });
  const events = E.reusedCallIdAcrossSteps();
  const log = Buffer.concat([[header], events.slice(0, 4), events.slice(4)]
    .map(records => zstdCompressSync(jsonl(records), CHECKSUMMED)));

  withFile('session.v4.jsonl.zstd', log, path => {
    const source = openReplaySource(path);
    assert.equal(source.harness, 'dsh');
    assert.deepEqual(source.index, indexDshLog(events));
    assert.equal(source.index.length, 2);
    assert.deepEqual(source.header, header);
    assert.deepEqual(source.dialogueSnapshot, { session: header, inheritedEventCount: 0, events });
    const frame = source.createDriver().advance({ captureMode: 'replay', limit: Infinity });
    assert.equal(frame.transition, 'replace');
    assert.equal(frame.sourceLocator, header.id);
  });
});

test('a gzip fixture and a plaintext log opening on a session header open as dsh', () => {
  const header = E.header({ id: 'session-replay-text' });
  const events = E.toolError();
  const plaintext = jsonl([header, ...events]);

  for (const [name, bytes] of [['log.jsonl.gz', gzipSync(plaintext)], ['session.v4.jsonl', plaintext]]) {
    withFile(name, bytes, path => {
      const source = openReplaySource(path);
      assert.equal(source.harness, 'dsh', name);
      assert.deepEqual(source.header, header, name);
      assert.deepEqual(source.index, indexDshLog(events), name);
      assert.deepEqual(source.dialogueSnapshot.events, events, name);
    });
  }
});

test('a gzip file whose first line is no session header throws', () => {
  withFile('transcript.jsonl.gz', gzipSync(jsonl(CLAUDE_CODE_ROWS)), path => {
    assert.throws(() => openReplaySource(path),
      { message: 'not a DSH session log: its first line is not a session header' });
  });
});

test('a plaintext file whose first line is no session header opens as claude-code with indexTranscript\'s limits', () => {
  const text = jsonl(CLAUDE_CODE_ROWS);
  withFile('transcript.jsonl', text, path => {
    const source = openReplaySource(path);
    assert.equal(source.harness, 'claude-code');
    assert.deepEqual(source.index, indexTranscript(path));
    assert.deepEqual(source.index.map(entry => entry.limit), [
      Buffer.byteLength(jsonl(CLAUDE_CODE_ROWS.slice(0, 2))), Buffer.byteLength(text),
    ]);
    assert.equal(source.header, null);
    assert.equal(source.dialogueSnapshot, null);
    const frame = source.createDriver().advance({ captureMode: 'replay', limit: Infinity });
    assert.equal(frame.transition, 'replace');
    assert.equal(frame.sourceLocator, path);
  });
});

test('each open hands a fresh driver', () => {
  const header = E.header({ id: 'session-replay-fresh' });
  const cases = [
    ['session.v4.jsonl', jsonl([header, ...E.askAborted()])],
    ['transcript.jsonl', jsonl(CLAUDE_CODE_ROWS)],
  ];
  for (const [name, bytes] of cases) {
    withFile(name, bytes, path => {
      const source = openReplaySource(path);
      const first = source.createDriver();
      const played = first.advance({ captureMode: 'replay', limit: Infinity });
      const second = source.createDriver();
      assert.notEqual(second, first, name);
      assert.deepEqual(second.advance({ captureMode: 'replay', limit: Infinity }), played,
        `${name}: a second driver replays from the start`);
    });
  }
});
