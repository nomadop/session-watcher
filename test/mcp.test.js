// test/mcp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { probeHealth, watcherStatus } from '../lib/launcher.js';

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
// so watcherStatus exercises its real return path WITHOUT spawning a server.
const noServerEnv = () => ({ CLAUDE_CODE_SESSION_ID: `qf3-test-${randomUUID()}` });

// Metric identifiers that MUST NEVER surface in a launcher reply / return shape (`lib/launcher.js`).
// (The launcher's own exports expose only URLs and state; a reading comes from an explicit tool call, `watcher_status` included, never from them.)
const FORBIDDEN_METRIC_KEYS = [
  'L', 'Lstar', 'LstarFit', 'kAvg', 'kFitSlope', 'paybackP', 'phi', 'rho',
  'timingWeight', 'regret', 'etaCalls', 'Lthreshold', 'metricsReliable',
  'baseline', 'sweetP', 'growth', 'apiCalls',
];

test('watcherStatus return shape: only {running,url}, no metric keys', async () => {
  const res = await watcherStatus(noServerEnv());
  // No live server for this random session → {running:false}, url absent.
  assert.deepEqual(res, { running: false });
  const allowed = new Set(['running', 'url']);
  for (const k of Object.keys(res)) assert.ok(allowed.has(k), `unexpected key in watcherStatus reply: ${k}`);
  for (const k of FORBIDDEN_METRIC_KEYS) assert.ok(!(k in res), `forbidden metric key leaked from watcherStatus: ${k}`);
});

// Task 11: handoff launcher helpers return {error:'no_server'} when no live server exists
import { getBucketSummary, prepareHandoff, loadHandoff, rotateSession } from '../lib/launcher.js';

test('handoff launcher helpers return {error:no_server} when no live server', async () => {
  const env = { CLAUDE_CODE_SESSION_ID: `qf3-test-${randomUUID()}` };
  assert.equal((await getBucketSummary(env)).error, 'no_server');
  assert.equal((await loadHandoff(env, {})).error, 'no_server');
  assert.equal((await prepareHandoff(env, { paths_to_keep: [], summary: 'x' })).error, 'no_server');
});

// These pin the launcher's own exports, re-exported from index.js: a caller of these helpers gets URLs and
// state. Every MCP handler in index.js builds its reply inline and reaches none of these, so the tools'
// replies are not covered here.
test('every no-server launcher reply is free of metric keys', async () => {
  const replies = await Promise.all([
    watcherStatus(noServerEnv()),
    getBucketSummary(noServerEnv()),
    loadHandoff(noServerEnv(), {}),
    prepareHandoff(noServerEnv(), { paths_to_keep: [], summary: 'x' }),
    rotateSession(noServerEnv(), {}),
  ]);
  for (const res of replies) {
    for (const k of FORBIDDEN_METRIC_KEYS) {
      assert.ok(!(k in res), `forbidden metric key ${k} leaked in ${JSON.stringify(res)}`);
    }
  }
});
