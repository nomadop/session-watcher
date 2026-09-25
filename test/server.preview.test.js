// The preview route and the read-only scenario it serves: a candidate override set folded on read, with the
// applied position left exactly where it was. The Apply-equals-preview case is the whole point of the route —
// a preview a consumer cannot trust to match the Apply it precedes is worse than no preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

// Initialize a temp store so server.js imports don't fail
const TMP = mkdtempSync(join(tmpdir(), 'sw-preview-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';

const RESIDENT = ['/workspace/src/app.js', '/workspace/dist/bundle.js'];

async function withServer(fn, transcriptPath = null) {
  const composed = composeForTranscript({
    transcriptPath: transcriptPath ?? writeMeasuredTranscript({ steps: 6, paths: RESIDENT }),
    sessionId: 'test-preview', projectRoot: '/workspace',
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher); } finally { stopTimers(); await composed.teardown(); }
}

// A Source holding no usage row at all: the only shape that leaves the baseline invalid, since a fixture's
// Read rows carry usage of their own and would make B positive.
function writeUnmeasuredTranscript() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-preview-empty-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, '');
  return path;
}

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
// A status body carries its landmarks on `rateLamp`; a scenario carries them at top level.
const positionOf = (s) => [s.u, s.pp, s.mf, s.br, s.bDefault,
  ...['xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR'].map(k => (s.rateLamp ? s.rateLamp[k] : s[k]))];

test('POST /api/preview rejects a malformed body', async () => {
  await withServer(async (port) => {
    const res = await post(port, '/api/preview', { overrides: [] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_body');
  });
});

test('POST /api/preview returns the scenario and mutates nothing', async () => {
  await withServer(async (port, w) => {
    const before = w.getStatus();
    const res = await post(port, '/api/preview', { overrides: { '/workspace/src/app.js': 'exclude' } });
    assert.equal(res.status, 200);
    const { scenario } = await res.json();
    assert.equal(scenario.reliable, true);
    assert.ok(scenario.bDefault < before.bDefault);
    assert.deepEqual(positionOf(w.getStatus()), positionOf(before));
  });
});

test('Apply after preview equals the preview, end to end, with no records between the two calls', async () => {
  await withServer(async (port, w) => {
    const overrides = { '/workspace/src/app.js': 'exclude' };
    const { scenario } = await (await post(port, '/api/preview', { overrides })).json();
    const applied = await (await post(port, '/api/user-overrides', { overrides })).json();
    assert.deepEqual(positionOf(applied), positionOf(scenario));
    assert.deepEqual(applied.rateLamp.reference, scenario.reference);
    const status = w.getStatus();
    assert.equal(status.u, scenario.u);
  });
});

test('GET /api/history points carry bDefault, u and pp, and the last u is the status u', async () => {
  await withServer(async (port) => {
    const history = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const last = history.at(-1);
    assert.equal(last.u, status.u);
    assert.equal(last.pp, status.pp);
    assert.equal(last.bDefault, status.bDefault);
    assert.equal(history[0].pp, null);
  });
});

test('POST /api/preview while unreliable answers { reliable: false }', async () => {
  await withServer(async (port) => {
    const { scenario } = await (await post(port, '/api/preview', { overrides: {} })).json();
    assert.deepEqual(scenario, { reliable: false });
  }, writeUnmeasuredTranscript());
});
