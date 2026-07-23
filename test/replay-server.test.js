// test/replay-server.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReplayServer } from '../lib/replay-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the smallest available real fixture for testing
const FIXTURE = join(__dirname, '..', 'fixtures', 'decf0f2c-20260703.jsonl');

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
    const html = await res.text();
    assert.ok(html.includes('Session Watcher'));
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
