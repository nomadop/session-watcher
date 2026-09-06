// test/replay-server.test.js
import { describe, it, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReplayServer } from '../lib/replay-server.js';
import { indexTranscript, ReplayController } from '../lib/replay.js';
import { SessionWatcher } from '../lib/watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the smallest available real fixture for testing
const FIXTURE = join(__dirname, '..', 'fixtures', 'decf0f2c-20260703.jsonl');

test('replay index keeps the final byte offset for repeated usage snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-replay-index-'));
  const path = join(dir, 'session.jsonl');
  const first = JSON.stringify({ timestamp: '2026-07-01T00:00:01Z', type: 'assistant',
    message: { id: 'm1', usage: { output_tokens: 9 } } }) + '\n';
  const middle = JSON.stringify({ timestamp: '2026-07-01T00:00:02Z', type: 'user',
    message: { content: 'continue' } }) + '\n';
  const final = JSON.stringify({ timestamp: '2026-07-01T00:00:03Z', type: 'assistant',
    message: { id: 'm1', usage: { output_tokens: 1 } } }) + '\n';
  const next = JSON.stringify({ timestamp: '2026-07-01T00:00:04Z', type: 'assistant',
    message: { id: 'm2', usage: { output_tokens: 2 } } }) + '\n';
  writeFileSync(path, first + middle + final + next);

  const index = indexTranscript(path);

  assert.equal(index.length, 2);
  assert.deepEqual(index.map(step => step.byteEnd), [
    Buffer.byteLength(first + middle + final),
    Buffer.byteLength(first + middle + final + next),
  ]);
  assert.deepEqual(index.map(step => step.ts), [
    Date.parse('2026-07-01T00:00:03Z'),
    Date.parse('2026-07-01T00:00:04Z'),
  ]);
});

test('finite replay leaves a newline-less streaming tail unsealed during cold fork replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-replay-valve-'));
  const path = join(dir, 'session.jsonl');
  const line = entry => JSON.stringify(entry) + '\n';
  const root = line({ type: 'user', uuid: 'u-root', parentUuid: null, isSidechain: false,
    timestamp: '2026-07-01T00:00:01Z', message: { role: 'user', content: 'start' } });
  const first = line({ type: 'assistant', uuid: 'a-main', parentUuid: 'u-root', isSidechain: false,
    timestamp: '2026-07-01T00:00:02Z', message: { id: 'm1', model: 'claude-opus-4-8', usage: {
      input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 5000, cache_creation_input_tokens: 0,
    } } });
  const fork = line({ type: 'user', uuid: 'u-new', parentUuid: 'u-root', isSidechain: false,
    timestamp: '2026-07-01T00:00:03Z', message: { role: 'user', content: 'retry' } });
  const accepted = line({ type: 'assistant', uuid: 'a-new', parentUuid: 'u-new', isSidechain: false,
    timestamp: '2026-07-01T00:00:04Z', message: { id: 'm2', model: 'claude-opus-4-8', usage: {
      input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 6000, cache_creation_input_tokens: 0,
    } } });
  const unsealedTail = JSON.stringify({
    type: 'assistant', uuid: 'a-tail', parentUuid: 'a-new', isSidechain: false,
    timestamp: '2026-07-01T00:00:05Z', message: { id: 'm2', model: 'claude-opus-4-8', usage: {
      input_tokens: 10, output_tokens: 50,
      cache_read_input_tokens: 6000, cache_creation_input_tokens: 0,
    } },
  });
  writeFileSync(path, root + first + fork + accepted + unsealedTail);

  const index = indexTranscript(path);
  const watcher = new SessionWatcher(path, 42000);
  const controller = new ReplayController(watcher, index, { speed: 100 });

  try {
    assert.equal(index.length, 2, 'the repeated m2 tail revises the second replay step');
    controller.start();
    controller.pause();
    assert.equal(controller.progress.current, 1);
    assert.equal(watcher._replayByteLimit, index[0].byteEnd);
    assert.equal(watcher._offset, index[0].byteEnd);
    assert.deepEqual(watcher._calls.map(call => call.messageId), ['m1']);

    controller.start();
    controller.pause();
    assert.equal(controller.progress.current, 2);
    assert.equal(watcher._replayByteLimit, index[1].byteEnd);
    assert.equal(watcher._offset, index[1].byteEnd);
    assert.equal(watcher._activeLeafUuid, 'a-new');
    assert.deepEqual(watcher._calls.map(call => ({ id: call.messageId, output: call.output })), [
      { id: 'm2', output: 5 },
    ]);
  } finally {
    controller.stop();
  }
});

describe('replay-server', () => {
  let instance;

  after(async () => { if (instance) await instance.stop(); });

  it('starts and serves /api/status', async () => {
    instance = await startReplayServer({ transcriptPath: FIXTURE, speed: 100, port: 0 });
    assert.ok(instance.url.startsWith('http://127.0.0.1:'));
    assert.ok(instance.totalSteps > 0);

    const res = await fetch(`${instance.url}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('model' in body || 'rateLamp' in body || 'L' in body);
  });

  it('serves /api/replay/status with progress', async () => {
    const res = await fetch(`${instance.url}/api/replay/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, true);
    assert.ok('current' in body);
    assert.ok('total' in body);
    assert.ok(body.total > 0);
  });

  it('serves static dashboard at /', async () => {
    const res = await fetch(`${instance.url}/`);
    assert.equal(res.status, 200);
    // Byte equality against the served file identifies which file the static route reached, where a
    // literal from inside it would only prove that some page mentions the product.
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = readFileSync(join(__dirname, '..', 'public', 'dashboard.html'));
    assert.deepEqual(served, onDisk);
  });

  it('does not create port-discovery state files', async () => {
    const { readdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const stateDir = join(homedir(), '.session-watcher');
    try {
      const files = readdirSync(stateDir);
      const port = new URL(instance.url).port;
      const match = files.find(f => f.includes(port));
      assert.equal(match, undefined, 'should not write port-discovery files');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  });

  it('stop() is idempotent', async () => {
    await instance.stop();
    await instance.stop(); // second call must not throw
  });
});
