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

// #7 Part A — /api/health must expose identity tokens (pid + startedAt) so a caller can prove the
// process it is about to signal is genuinely ours. startedAt must be the server's own start
// timestamp and STABLE across calls (single source of truth), pid must be this process's pid.
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
  return { stateDir, env: { ...process.env, HOME: home, SW_STATE_DIR: stateDir, ...extra } };
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

// Headless --open must NOT crash the server. Spawn WITH --open (no SW_NO_OPEN) but force the browser
// opener to a nonexistent binary via BROWSER=/nonexistent — the opener child emits 'error'. Pre-fix
// (no opener.on('error')) that error was unhandled → the server died milliseconds after printing PORT=,
// leaving a stale state file at a dead port. This test proves the server stays alive: /api/health still
// answers ~600ms after PORT=. The existing real-launch test uses SW_NO_OPEN=1, so ONLY this test can
// catch a regression here.
test('spawned server.js with --open and a missing opener stays alive (headless crash guard)', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(__dirname, '..', 'server.js');
  const sessionId = `sw-openguard-e2e-${randomUUID()}`;
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-proj-'));

  const { stateDir, env } = isolatedCliEnv({ BROWSER: '/nonexistent/sw-opener-that-does-not-exist' });
  const stateFile = join(stateDir, `${sessionId}.json`);
  delete env.SW_NO_OPEN; // MUST let the opener actually spawn — that is the code path under test.

  const child = spawn(process.execPath,
    [serverPath, '--port', '0', '--project', projectDir, '--session', sessionId, '--open'],
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

    // Wait past the window where the failed opener would have crashed the server, then probe.
    await new Promise(r => setTimeout(r, 600));
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true, 'server survived a failed browser-open and still serves /api/health');
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

test('formatLine renders restart + reliability states', () => {
  // v3: without rateLamp.reliable, formatLine renders calibrating (no L/L* bar in new layout).
  // A reliable frame with no rateLamp falls to renderCalibratingV3 (progressive fill with tag).
  const green = formatLine({ L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false, metricsReliable: true, phi: 2.4, paybackP: 2.6, etaCalls: 89, baseline: { total: 55000 }, model: 'deepseek-v4-pro' });
  assert.ok(green.includes('deepseek'), 'model tag still present in calibrating output');
  const red = formatLine({ L: 400000, Lstar: 375000, Lthreshold: 375000, restart: true, restartReason: 'cost', metricsReliable: true, phi: 3, paybackP: 4, etaCalls: 0, baseline: { total: 55000 } });
  // v3: no rateLamp → calibrating path; restart indicator is NOT shown in v3 calibrating
  assert.ok(red.length > 0, 'non-empty output');
  // B2: metricsReliable===false unlatched ALWAYS carries calibratingReason (watcher.js: latched⟹null,
  // else metrics_unreliable) — the bare {metricsReliable:false, calibratingReason:null, no rateLamp}
  // state is unreachable from real getStatus, so pin the reason to make the fixture faithful (not weaker).
  // formatLine's collapse guard is reason-keyed (gate.reason != null) so a real restart is never masked.
  const shaky = formatLine({ L: 1, Lstar: 1, Lthreshold: 1, restart: false, metricsReliable: false, calibratingReason: 'metrics_unreliable', baseline: { total: 1 } });
  assert.ok(/[⚪🟢🟡⚠️]/.test(shaky), 'calibrating output should contain a lamp emoji');
});

// #6-server: during warmup metricsReliable is TRUE but calibratingReason is set. formatLine must
// render the CALIBRATING state (no misleading full ▓ bar / 🟡🟢 gauge) whenever calibratingReason
// != null. Pre-fix branches only on !metricsReliable → renders the gauge → these FAIL on pre-fix.
test('formatLine shows calibrating (not a full bar) when metricsReliable but calibratingReason set', () => {
  // L≈Lthreshold → pre-fix pct≈100% → full ▓▓▓▓▓▓▓▓▓▓ + 🟡. Post-fix: calibrating string instead.
  const s = { L: 55000, Lstar: 55000, Lthreshold: 55000, restart: false, metricsReliable: true,
    calibratingReason: 'insufficient_data', phi: 1, paybackP: 1, etaCalls: 0, baseline: { total: 55000 }, model: 'deepseek-v4-pro' };
  const out = formatLine(s);
  assert.ok(out.length > 0, 'never empty');
  // v3: calibrating uses renderCalibratingV3 which shows carousel lamp + progressive info + tag
  assert.ok(!out.includes('▮'.repeat(10)), 'no full meter bar during warmup');
  assert.ok(/deepseek|opus|sonnet|haiku/i.test(out), 'keeps the model tag');
});

test('formatLine shows measuring when rateLamp.reliable is false (no_transcript)', () => {
  // v3: no calibrating carousel — unreliable status shows "measuring…"
  const s = { L: 0, model: 'opus', rateLamp: { reliable: false, unavailableReason: 'no_transcript' } };
  const out = formatLine(s);
  assert.ok(out.length > 0 && /measuring/i.test(out), 'unreliable shows measuring');
});

test('formatLine still renders the normal gauge when calibratingReason is null (regression)', () => {
  // v3: full layout requires rateLamp.reliable===true; without it, calibrating path is taken.
  // With rateLamp.reliable, the v3 meter bar uses ▮/░.
  const s = { L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false, metricsReliable: true,
    calibratingReason: null, phi: 2.4, paybackP: 2.6, etaCalls: 89, baseline: { total: 55000 }, model: 'deepseek-v4-pro',
    rateLamp: { reliable: true, billProgress: 0.42, billCycleCount: 2, band: 'entry_to_sweet',
      x_display: 2.1, dhat: 0.4, xEntry: 1.2, xExit: 2.0, lBase: 55000, L_read: 137000,
      L_cap: 960000, inDeepWater: false, deepWaterDisplayLatched: false,
      targetL: 200000, kAvg: 3000, currentTurnSeq: 1 } };
  const out = formatLine(s);
  assert.ok(out.includes('▮') || out.includes('░'), 'reliable status shows the v3 meter bar');
  assert.ok(/🟡|🟢|⚪/.test(out), 'reliable status still shows a lamp');
});

// M1: statusline vs dashboard "calibrating" divergence. The dashboard uses
// `calibratingReason != null || metricsReliable === false`; formatLine must use the SAME
// expression so an ABSENT metricsReliable field (undefined) is NOT forced into calibrating
// (pre-fix `!undefined === true` diverged from the dashboard's `undefined === false`).
test('formatLine: field-absent metricsReliable is not calibrating (M1 alignment)', () => {
  const line = formatLine({ model: 'claude-opus', L: 50000, Lstar: 80000, Lthreshold: 80000,
    etaCalls: 5, phi: 1.4, paybackP: 0.2, restart: false });
  // metricsReliable undefined + no calibratingReason → must render the live bar, NOT "校准中"
  assert.ok(!line.includes('校准中'), 'field-absent metricsReliable must not force calibrating');
});
