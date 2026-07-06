import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SessionWatcher } from '../lib/watcher.js';
import { createServer, formatLine } from '../server.js';

function fixtureWatcher() {
  // input+output ≈ ΔL (=940) so the lag-aligned metricsReliable probe stays healthy.
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 940;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + id++, model: 'deepseek-v4-pro', usage: {
        input_tokens: 560, output_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  }
  const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl');
  writeFileSync(p, s);
  const w = new SessionWatcher(p, 42000);
  return w;
}

async function withServer(fn) {
  const w = fixtureWatcher();
  const { server } = createServer({ watcher: w, pollIntervalMs: 0 });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try { await fn(port, w); } finally { await new Promise(r => server.close(r)); }
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
test('spawned server.js: state file startedAt/pid EQUAL /api/health startedAt/pid', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(__dirname, '..', 'server.js');
  const sessionId = `sw-health-e2e-${randomUUID()}`;
  const stateFile = join(homedir(), '.session-watcher', `${sessionId}.json`);
  // Point --project at an empty temp dir so the watcher has no transcript (fine for /api/health).
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-proj-'));

  const child = spawn(process.execPath,
    [serverPath, '--port', '0', '--project', projectDir, '--session', sessionId],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SW_NO_OPEN: '1' } });

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
  const stateFile = join(homedir(), '.session-watcher', `${sessionId}.json`);
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-proj-'));

  const env = { ...process.env, BROWSER: '/nonexistent/sw-opener-that-does-not-exist' };
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
    assert.equal(typeof j.Lstar, 'number');
    assert.ok('restart' in j && 'metricsReliable' in j && 'baseline' in j);
  });
});

test('GET /api/status?fmt=line returns a non-empty single line', async () => {
  await withServer(async (port) => {
    const txt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(txt.length > 0);
    assert.ok(!txt.trimEnd().includes('\n'), 'single line');
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
    type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id: 'm' + id, model: 'deepseek-v4-pro', usage: {
      input_tokens: 560, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } },
  }) + '\n';

  // One assistant call; createServer's constructor poll() folds it (offset → EOF).
  const p = join(mkdtempSync(join(tmpdir(), 'sw-poll-')), 's.jsonl');
  writeFileSync(p, mkLine(0, 380, 42940));
  const w = new SessionWatcher(p, 42000);

  const { server, startPolling, stopTimers, sseClients } = createServer({ watcher: w, pollIntervalMs: 25 });
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
  const green = formatLine({ L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false, metricsReliable: true, phi: 2.4, paybackP: 2.6, etaCalls: 89, baseline: { total: 55000 }, model: 'deepseek-v4-pro' });
  assert.ok(green.includes('L ') && green.includes('L*'));
  const red = formatLine({ L: 400000, Lstar: 375000, Lthreshold: 375000, restart: true, restartReason: 'cost', metricsReliable: true, phi: 3, paybackP: 4, etaCalls: 0, baseline: { total: 55000 } });
  assert.ok(/restart|重启|🔴/i.test(red));
  const shaky = formatLine({ L: 1, Lstar: 1, Lthreshold: 1, restart: false, metricsReliable: false, baseline: { total: 1 } });
  assert.ok(/校准|calibrat/i.test(shaky));
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
  assert.ok(/校准|calibrat/i.test(out), 'renders calibrating');
  assert.ok(!out.includes('▓'), 'no filled gauge bar during warmup');
  assert.ok(!/🟡|🟢/.test(out), 'no reliability light during warmup');
  assert.ok(/deepseek|opus|sonnet|haiku/i.test(out), 'keeps the model tag');
});

test('formatLine shows calibrating for calibratingReason=no_transcript', () => {
  const s = { L: 0, Lstar: 0, Lthreshold: 0, restart: false, metricsReliable: true,
    calibratingReason: 'no_transcript', baseline: { total: 0 }, model: 'opus' };
  const out = formatLine(s);
  assert.ok(out.length > 0 && /校准|calibrat|转录|未找到/i.test(out), 'calibrating for no_transcript');
});

test('formatLine still renders the normal gauge when calibratingReason is null (regression)', () => {
  const s = { L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false, metricsReliable: true,
    calibratingReason: null, phi: 2.4, paybackP: 2.6, etaCalls: 89, baseline: { total: 55000 }, model: 'deepseek-v4-pro' };
  const out = formatLine(s);
  assert.ok(out.includes('▓') || out.includes('░'), 'reliable status still shows the gauge bar');
  assert.ok(/🟡|🟢/.test(out), 'reliable status still shows a reliability light');
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
