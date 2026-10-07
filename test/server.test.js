import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer, formatLine } from '../server.js';
import { composeForTranscript } from './helpers/server-boot.js';
import { lampZone } from '../lib/bill-regret.js';

// One session's worth of measured steps, CHAINED into a single topology. Chaining is load-bearing: a
// null-parent row is a topology root and a root with a call behind it is a compact epoch, so a run built from
// the builders' defaults would open an epoch on every row after its first call and leave the segment holding
// one step.
function fixtureTranscript() {
  const rows = [];
  let cr = 42000;
  for (let i = 0; i < 30; i++) {
    cr += 940;
    rows.push({
      type: 'assistant', uuid: 'u' + i, parentUuid: i === 0 ? null : 'u' + (i - 1),
      isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + i, role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: {
        input_tokens: 560, output_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } },
    });
  }
  const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl');
  writeFileSync(p, rows.map(r => JSON.stringify(r) + '\n').join(''));
  return p;
}

async function withServer(fn) {
  const composed = composeForTranscript({ transcriptPath: fixtureTranscript() });
  const { handle } = composed;
  await new Promise(r => handle.server.listen(0, r));
  const port = handle.server.address().port;
  try { await fn(port, composed.watcher); } finally { await composed.teardown(); }
}

test('GET /api/health returns ok', async () => {
  await withServer(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.port, 'number');
  });
});

// /api/health exposes pid + startedAt, the values the discovery record carries. startedAt is the
// server's own start timestamp and STABLE across calls (single source of truth), pid is this process's pid.
test('GET /api/health returns pid and a stable startedAt (identity tokens)', async () => {
  await withServer(async (port) => {
    const a = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(a.pid, process.pid, 'health.pid is the running process pid');
    assert.equal(typeof a.startedAt, 'number', 'health.startedAt is a number (ms)');
    assert.ok(Number.isFinite(a.startedAt) && a.startedAt > 0, 'health.startedAt is a real timestamp');
    // Stable across calls — it is the fixed server start time, not a fresh Date.now() per request.
    const b = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(b.startedAt, a.startedAt, 'health.startedAt is stable across requests');
  });
});

// #7 Part A (end-to-end shared source) — the value the CLI writes to the state file's `startedAt`
// MUST be the SAME number /api/health returns, and likewise for pid. This spawns the REAL server.js
// CLI (the code path that writes the state file), proving health.startedAt === stateFile.startedAt
// and health.pid === stateFile.pid. Pre-fix this FAILS: health used a Date.now() computed inside
// createServer while the state file wrote a separate Date.now() in the listen callback.
// Both spawned-CLI tests below run server.js's real entry path, which initialises the store, sweeps
// legacy JSON and reaps stale port files — every one of those resolved from homedir(). Given the
// developer's own HOME they run a real GC and unlink real state files, so each child gets its own.
function isolatedCliEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sw-cli-home-'));
  const stateDir = join(home, 'state');
  return { stateDir, env: { PATH: process.env.PATH, HOME: home, SW_STATE_DIR: stateDir, ...extra } };
}

test('spawned server.js: state file startedAt/pid EQUAL /api/health startedAt/pid', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(__dirname, '..', 'server.js');
  const sessionId = `sw-health-e2e-${randomUUID()}`;
  // Point --project at an empty temp dir so the watcher has no transcript (fine for /api/health).
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-proj-'));
  const { stateDir, env } = isolatedCliEnv({ SW_NO_OPEN: '1' });
  const stateFile = join(stateDir, `${sessionId}.json`);

  const child = spawn(process.execPath,
    [serverPath, '--port', '0', '--project', projectDir, '--session', sessionId],
    { stdio: ['ignore', 'pipe', 'ignore'], env });

  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/PORT=(\d+)/);
        if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
      });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));

    assert.equal(health.pid, st.pid, 'health.pid === stateFile.pid');
    assert.equal(health.pid, child.pid, 'health.pid is the spawned server pid');
    assert.equal(health.startedAt, st.startedAt, 'health.startedAt === stateFile.startedAt (single source)');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    // Give the server's SIGTERM handler a beat to unlink its own state file; then force-clean.
    await new Promise(r => setTimeout(r, 300));
    try { unlinkSync(stateFile); } catch {}
  }
});

// A failed --open is handled where the opener is spawned, not left to the process-level
// uncaughtException handler, which logs `[uncaught]` under SW_DEBUG and would otherwise hide it.
test('spawned server.js with --open and a missing opener handles the failure itself', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(__dirname, '..', 'server.js');
  const sessionId = `sw-openguard-e2e-${randomUUID()}`;
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-proj-'));

  const { stateDir, env } = isolatedCliEnv({ BROWSER: '/nonexistent/sw-opener-that-does-not-exist', SW_DEBUG: '1' });
  const stateFile = join(stateDir, `${sessionId}.json`);

  const child = spawn(process.execPath,
    [serverPath, '--port', '0', '--project', projectDir, '--session', sessionId, '--open'],
    { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/PORT=(\d+)/);
        if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
      });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    await new Promise(r => setTimeout(r, 600));
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true, 'server still serves /api/health after a failed browser-open');
    assert.doesNotMatch(stderr, /\[uncaught\]/, 'the opener failure never reaches the uncaughtException handler');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 300));
    try { unlinkSync(stateFile); } catch {}
  }
});

test('GET /api/status returns full Status JSON', async () => {
  await withServer(async (port) => {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(typeof j.L, 'number');
    // v3 status shape: L, B, g, model, rateLamp, segment
    assert.ok('rateLamp' in j && 'model' in j && 'segment' in j);
  });
});

test('GET /api/status carries lamp, the zone of its reliable rateLamp', async () => {
  await withServer(async (port) => {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(j.rateLamp.reliable, true, 'the fixture measures');
    assert.equal(j.lamp, lampZone(j.rateLamp.br, { u: j.rateLamp.u, mf: j.rateLamp.mf }));
  });
});

test('GET /api/status includes rentMeter on rateLamp (spec invariant 10)', async () => {
  await withServer(async (port) => {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    // rentMeter must always be present (never undefined) — even when rateLamp is unreliable.
    assert.ok('rentMeter' in j.rateLamp, 'rateLamp.rentMeter is always present');
    const rm = j.rateLamp.rentMeter;
    // Null-safe defaults: all required fields present with correct types.
    assert.ok('cycleProgress' in rm, 'rentMeter.cycleProgress present');
    assert.ok('depthActive' in rm, 'rentMeter.depthActive present');
    assert.ok('depthProgress' in rm, 'rentMeter.depthProgress present');
    assert.ok('backstopInterval' in rm, 'rentMeter.backstopInterval present');
    assert.ok('backstopLapCount' in rm, 'rentMeter.backstopLapCount present');
    assert.ok('depthHot' in rm, 'rentMeter.depthHot present');
  });
});

test('GET /api/status?fmt=line returns a non-empty single line', async () => {
  await withServer(async (port) => {
    const txt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(txt.length > 0);
    assert.ok(!txt.trimEnd().includes('\n'), 'single line');
  });
});

test('GET /dashboard serves the same document as /', async () => {
  await withServer(async (port) => {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    const alias = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(alias.status, 200);
    assert.match(alias.headers.get('content-type') ?? '', /html/);
    // Same booted server answering both routes, so the comparison is live-to-live rather than a
    // stored baseline that could drift from the page it mirrors.
    assert.equal(await alias.text(), await root.text());
  });
});

// cycleCountInSegment is debug-only: its absence without the query param is what makes its
// presence with the param mean anything, so both halves are one case's subject.
test('GET /api/status?debug=1 attaches billingCycle.cycleCountInSegment, absent without debug', async () => {
  await withServer(async (port) => {
    const plain = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.ok(plain.rateLamp?.billingCycle, 'scenario carries a billingCycle to attach onto');
    assert.equal('cycleCountInSegment' in plain.rateLamp.billingCycle, false, 'absent without debug');

    const debug = await (await fetch(`http://127.0.0.1:${port}/api/status?debug=1`)).json();
    assert.ok('cycleCountInSegment' in debug.rateLamp.billingCycle, 'present with debug=1');
  });
});

// Transcript Playback merges its controller's ledger onto the status, so the debug count must come from that
// same ledger. The run grows L steeply enough that the replayed ledger completes cycles: with none, a debug
// read of zero would agree with the wire whichever ledger it came from.
test('GET /api/status?debug=1 during Transcript Playback counts the replayed ledger\'s cycles', async () => {
  const rows = [];
  let cr = 42000;
  for (let i = 0; i < 24; i++) {
    cr += 20000;
    rows.push({
      type: 'assistant', uuid: 'p' + i, parentUuid: i === 0 ? null : 'p' + (i - 1),
      isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'pm' + i, role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: {
        input_tokens: 560, output_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } },
    });
  }
  const replayed = join(mkdtempSync(join(tmpdir(), 'sw-')), 'replayed.jsonl');
  writeFileSync(replayed, rows.map(r => JSON.stringify(r) + '\n').join(''));
  await withServer(async (port) => {
    const url = (path) => `http://127.0.0.1:${port}${path}`;
    const started = await (await fetch(url('/api/replay/start'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: replayed, speed: 1000 }),
    })).json();
    assert.equal(started.ok, true);
    for (let i = 0; i < 200; i++) {
      const progress = await (await fetch(url('/api/replay/status'))).json();
      if (progress.current >= progress.total) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const debug = await (await fetch(url('/api/status?debug=1'))).json();
    assert.ok(debug.rateLamp.billCycleCount > 0, 'the replayed ledger completed cycles');
    assert.equal(debug.rateLamp.billingCycle.cycleCountInSegment, debug.rateLamp.billCycleCount);
  });
});

test('GET /api/history returns an array of points', async () => {
  await withServer(async (port) => {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    assert.ok(Array.isArray(j) && j.length > 0 && typeof j[0].L === 'number');
  });
});

// Regression: the poll loop must push an SSE `scan` frame on watcher.poll() `changed`
// (snapshot output growth of an existing message.id), NOT only on `newCalls > 0`.
// The other server tests use pollIntervalMs:0 (loop never runs) — this one actually drives it.
test('poll loop emits SSE scan on snapshot output growth (changed, not just newCalls)', async () => {
  const mkLine = (id, output, cacheRead) => JSON.stringify({
    type: 'assistant', uuid: 'u' + id, parentUuid: null, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id: 'm' + id, role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: {
      input_tokens: 560, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } },
  }) + '\n';

  // One assistant call; the host's synchronous bootstrap applies it before the server is exposed.
  const p = join(mkdtempSync(join(tmpdir(), 'sw-poll-')), 's.jsonl');
  writeFileSync(p, mkLine(0, 380, 42940));

  const composed = composeForTranscript({ transcriptPath: p, pollIntervalMs: 25 });
  const { server, startPolling, stopTimers, sseClients } = composed.handle;
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  let reader;
  try {
    startPolling();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
    reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Ensure the SSE client is registered before we trigger the change.
    const t0 = Date.now();
    while (sseClients.size === 0 && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 10));
    assert.equal(sseClients.size, 1, 'SSE client registered');

    // Append a snapshot of the SAME message.id: output grows, cacheRead unchanged.
    // → watcher.poll() returns { newCalls: 0, changed: true }; the loop must still emit.
    appendFileSync(p, mkLine(0, 900, 42940));

    // Read frames until a scan event arrives; the timer cancels the reader if it never does
    // (loop exits with got=false → assertion fails cleanly, no hang).
    let got = false, buf = '';
    const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, 2000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('"type":"scan"')) { got = true; break; }
      }
    } finally { clearTimeout(timer); }
    assert.ok(got, 'received a scan SSE frame after snapshot output growth');
  } finally {
    try { await reader?.cancel(); } catch {}
    stopTimers();
    await new Promise(r => server.close(r));
  }
});

test('formatLine shows measuring when rateLamp.reliable is false (no_transcript)', () => {
  // v3: no calibrating carousel — unreliable status shows "measuring…"
  const s = { L: 0, model: 'opus', rateLamp: { reliable: false, unavailableReason: 'no_transcript' } };
  const out = formatLine(s);
  assert.ok(out.length > 0 && /measuring/i.test(out), 'unreliable shows measuring');
});

test('formatLine renders the v3 meter and a lamp for a reliable rateLamp', () => {
  // v3: full layout requires rateLamp.reliable===true; without it, the measuring… line is taken.
  const s = { L: 137000, model: 'deepseek-v4-pro',
    rateLamp: { reliable: true, billProgress: 0.42, billCycleCount: 2,
      x_display: 2.1, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 1 } };
  const out = formatLine(s);
  assert.match(out, /[▓░]/, 'reliable status shows the v3 meter bar');
  assert.ok(/🟡|🟢|⚪/.test(out), 'reliable status still shows a lamp');
});
