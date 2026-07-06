// test/mcp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectDir, probeHealth, stopWatcher, watcherStatus } from '../index.js';

test('resolveProjectDir prefers CLAUDE_PROJECT_DIR, falls back to projects root', () => {
  assert.equal(resolveProjectDir({ CLAUDE_PROJECT_DIR: '/tmp/proj' }), '/tmp/proj');
  const r = resolveProjectDir({ HOME: '/home/u' });
  assert.ok(r.includes('.claude') && r.includes('projects'));
});

test('probeHealth returns true for a live /api/health, false otherwise', async () => {
  const srv = createHttpServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type','application/json'); res.end('{"ok":true}'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  assert.equal(await probeHealth(port), true);
  await new Promise(r => srv.close(r));
  assert.equal(await probeHealth(port), false); // now dead
});

// A session id that cannot have a real state file on disk under ~/.session-watcher,
// so stopWatcher/watcherStatus exercise their real return paths WITHOUT spawning a server.
const noServerEnv = () => ({ CLAUDE_CODE_SESSION_ID: `qf3-test-${randomUUID()}` });

// Metric identifiers that MUST NEVER surface in an MCP tool reply / return shape.
// (The zero-pollution invariant: the dashboard shows metrics; the MCP surface exposes only URLs/state.)
const FORBIDDEN_METRIC_KEYS = [
  'L', 'Lstar', 'LstarFit', 'kAvg', 'kFitSlope', 'paybackP', 'phi', 'rho',
  'timingWeight', 'regret', 'etaCalls', 'Lthreshold', 'metricsReliable',
  'baseline', 'sweetP', 'growth', 'apiCalls',
];

// Fix ⑦ — stop_watcher liveness/no-live-server path.
test('stopWatcher returns {stopped:false} when no state file exists (no live server)', async () => {
  const res = await stopWatcher(noServerEnv());
  assert.deepEqual(res, { stopped: false });
});

// Fix ⑥ / 9b — behavioral zero-pollution guard on the real return shapes.
test('stopWatcher return shape: only {stopped}, no metric keys', async () => {
  const res = await stopWatcher(noServerEnv());
  const allowed = new Set(['stopped']);
  for (const k of Object.keys(res)) assert.ok(allowed.has(k), `unexpected key in stopWatcher reply: ${k}`);
  for (const k of FORBIDDEN_METRIC_KEYS) assert.ok(!(k in res), `forbidden metric key leaked from stopWatcher: ${k}`);
});

test('watcherStatus return shape: only {running,url}, no metric keys', async () => {
  const res = await watcherStatus(noServerEnv());
  // No live server for this random session → {running:false}, url absent.
  assert.deepEqual(res, { running: false });
  const allowed = new Set(['running', 'url']);
  for (const k of Object.keys(res)) assert.ok(allowed.has(k), `unexpected key in watcherStatus reply: ${k}`);
  for (const k of FORBIDDEN_METRIC_KEYS) assert.ok(!(k in res), `forbidden metric key leaked from watcherStatus: ${k}`);
});

// Fix ⑥ / 9b — source-level guard. Locks the invariant so a future edit that references
// any metric identifier ANYWHERE in the MCP launcher fails CI. Uses whole-word boundaries so
// benign substrings ('URL' contains 'L', 'flush' contains no key) do not false-positive.
test('index.js source contains no metric identifiers (zero-pollution source guard)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
  const re = new RegExp(`\\b(${FORBIDDEN_METRIC_KEYS.join('|')})\\b`);
  const m = src.match(re);
  assert.equal(m, null, m ? `metric identifier "${m[1]}" appears in index.js: ${JSON.stringify(src.slice(Math.max(0, m.index - 25), m.index + 25))}` : '');
});
