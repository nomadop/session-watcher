// test/statusline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// v2.1 B3/Step-4: isolate the rate-lamp ledger checkpoint dir so the real-server fmt=line test never
// writes into ~/.session-watcher (pathFor reads process.env lazily per call, so setting it here suffices).
const RL_TMP = mkdtempSync(join(tmpdir(), 'sw-sl-rl-'));
process.env.CLAUDE_PLUGIN_DATA = RL_TMP;
process.on('exit', () => { try { rmSync(RL_TMP, { recursive: true, force: true }); } catch {} });

import { formatLine, createServer } from '../server.js';
import { _resetRenderState, _resetCarousel } from '../lib/statusline-format.js';
import { SessionWatcher } from '../lib/watcher.js';

const execFileP = promisify(execFile);

// A reliable base status (bar/eta path) so the B3 rate-lamp string is exercised on top of the live line.
const reliableBase = (rateLamp) => ({
  model: 'claude-opus-4-8', port: 38017, L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
  metricsReliable: true, calibratingReason: null, phi: 2.4, paybackP: 0.6, etaCalls: 40,
  baseline: { total: 55000 }, kAvg: 3000, rateLamp,
});

const SCRIPT = 'statusline.sh';
const MOCK_STDIN = JSON.stringify({
  model: { display_name: 'Opus', id: 'claude-opus-4-8' },
  session_id: 'test-sid', transcript_path: '/tmp/x.jsonl',
  context_window: { current_usage: { cache_read_input_tokens: 137000 } },
});

// Not skipped: the script must exist. First run (before writing it) fails loudly, satisfying TDD.
test('statusline exits 0 and prints a fallback line when server is down', () => {
  assert.ok(existsSync(SCRIPT), 'statusline.sh must exist');
  chmodSync(SCRIPT, 0o755);
  // Point state dir at an empty tmp so no server is found → fallback path.
  const out = execFileSync('bash', [SCRIPT], {
    input: MOCK_STDIN, env: { ...process.env, SW_STATE_DIR: '/nonexistent-sw-dir' }, encoding: 'utf8' });
  assert.ok(out.trim().length > 0, 'non-empty output (never blocks CC)');
  assert.ok(/Opus|session-watcher/.test(out), 'shows model or off-marker');
  assert.ok(!/http:\/\//.test(out), 'no dashboard URL when server is down');
});

// When a server IS reachable, the statusline appends a full, clickable dashboard URL so the
// human can reopen the dashboard after closing the tab. Must be a complete http:// string
// (a bare :PORT is not clickable/complete in a terminal).
test('statusline appends full dashboard URL when server is up', async () => {
  chmodSync(SCRIPT, 0o755);
  // v3: the server-side ?fmt=line response now includes the dashboard URL, so the mock must too.
  const srv = createHttpServer((req, res) => {
    const port = srv.address().port;
    if (req.url.startsWith('/api/status')) { res.setHeader('content-type', 'text/plain'); res.end(`METRICS_LINE · http://127.0.0.1:${port}`); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-state-'));
  try {
    writeFileSync(join(stateDir, 'test-sid.json'), JSON.stringify({ port }));
    // Async execFile (not execFileSync): the mock server shares this event loop, so a blocking
    // spawn would starve it and force curl into the fallback path.
    const child = execFileP('bash', [SCRIPT], { env: { ...process.env, SW_STATE_DIR: stateDir } });
    child.child.stdin.end(MOCK_STDIN);
    const { stdout: out } = await child;
    assert.ok(out.includes('METRICS_LINE'), 'renders the server metrics line');
    assert.ok(out.includes(`http://127.0.0.1:${port}`), 'URL is present (server-side appended)');
  } finally {
    srv.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── B3: formatLine rate-lamp contract ─────────────────────────────────────────────────────────────

// Task 10 (ER-2) → v3: kFit eta is retired; countdown renders from targetL/kAvg.
// Validate that no kFit eta artifact leaks.
test('Task 10 (ER-2) → A2: formatLine no longer renders the kFit `~N轮` eta', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 12.4, billProgress: 0.37, billCycleCount: 0,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: 2.5, dhat: 0.4,
    band: 'above_exit', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 5 });
  const out = formatLine(s);
  assert.ok(!/~\d+轮/.test(out), 'no `~N轮` kFit eta rendered');
  assert.ok(!out.includes('已过线'), 'no `已过线` kFit-crossing eta rendered');
});

// v3: new layout renders lamp + meter (▮ bar + % + ×N) + countdown u + delta L/b + tag :port.
// The old `break-even ~N turns` / `bill NN%` format is retired.
test('A2: reliable rateLamp renders the new v3 layout, no old break-even/bill format', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 12.4, billProgress: 0.37, billCycleCount: 2,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: 2.5, dhat: 0.4,
    band: 'above_exit', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 5 });
  const out = formatLine(s);
  assert.ok(out.includes('▮') || out.includes('░'), 'v3 meter bar renders');
  assert.ok(out.includes('37%'), 'meter shows billProgress as floor percentage');
  assert.ok(out.includes('🟡'), 'deep water lamp from frozen latch');
  assert.ok(out.includes('L137k'), 'L value renders fixed-width');
  assert.ok(out.includes('b55k'), 'baseline value renders tight-coupled');
  assert.ok(!/break-even ~\d+ turns/.test(out), 'old break-even format is gone');
  assert.ok(!/bill \d+%/.test(out), 'old bill format is gone');
});

// Review A7#15 → v3: hBreak Infinity (burnRate=0, below the floor) — countdown renders ---t, never Infinity.
test('A2 A7#15: hBreak Infinity (burnRate=0) renders countdown ---t, not Infinity', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: Infinity, billProgress: 0, billCycleCount: 0,
    inDeepWater: false, deepWaterDisplayLatched: false, x_display: 1.2, dhat: 0.4,
    band: 'below_entry', lBase: 55000, L_read: 137000, L_cap: 960000,
    currentTurnSeq: 3 });
  // No targetL/kAvg → countdown renders ---t
  const out = formatLine(s);
  assert.ok(out.includes('---t'), 'missing countdown renders ---t placeholder');
  assert.ok(!out.includes('Infinity'), 'never leaks the literal Infinity');
  assert.ok(out.includes('0%'), 'billProgress 0 rendered in meter');
});

// v2.2 H-B + I-pt2: the neutral bill pulse (rent +Nx / idle / ctx growing) is RETIRED. The meter's ×N
// shows the lifetime STOCK; per-turn increment is stop hook's job. These tests confirm the retirement.
test('A2/I-pt2: neutral bill pulse retired — non_idle_burn lastBillEvent does NOT render rent/growing', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, billCycleCount: 2,
    inDeepWater: false, deepWaterDisplayLatched: false, x_display: 2.0, dhat: 0.4,
    band: 'entry_to_sweet', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 7,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 2, delivery: 'statusline_pulse', turnSeq: 7 } });
  const out = formatLine(s);
  assert.ok(!/rent \+/.test(out), 'no rent +Nx in new layout (neutral pulse retired)');
  assert.ok(!/ctx growing|growing/.test(out), 'no ctx growing in new layout');
});

test('A2/I-pt2: neutral bill pulse retired — empty_burn lastBillEvent does NOT render rent/idle', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, billCycleCount: 1,
    inDeepWater: false, deepWaterDisplayLatched: false, x_display: 2.0, dhat: 0.4,
    band: 'entry_to_sweet', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 9,
    lastBillEvent: { kind: 'empty_burn', billCount: 1, delivery: 'statusline_pulse', turnSeq: 9 } });
  const out = formatLine(s);
  assert.ok(!/rent \+/.test(out), 'no rent +Nx (neutral pulse retired)');
  assert.ok(!/idle/.test(out), 'no idle suffix (retired)');
});

// v2.2 H-B + I-pt2: cache_unstable bill events also do not render (the neutral pulse is fully retired).
test('A2/I-pt2: neutral bill pulse retired — cache_unstable lastBillEvent silent', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, billCycleCount: 1,
    inDeepWater: false, deepWaterDisplayLatched: false, x_display: 2.0, dhat: 0.4,
    band: 'entry_to_sweet', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 11,
    lastBillEvent: { kind: 'cache_unstable', billCount: 1, delivery: 'statusline_pulse', turnSeq: 11 } });
  const out = formatLine(s);
  assert.ok(!/unstable/i.test(out), 'no cache_unstable copy in new layout (pulse retired)');
  assert.ok(!/ctx growing|growing/.test(out), 'no growing suffix');
});

// TTL: with neutral pulse retired, lastBillEvent has no rendering effect at all (stale or not).
test('A2/I-pt2: stale lastBillEvent also renders nothing (neutral pulse retired)', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, billCycleCount: 2,
    inDeepWater: false, deepWaterDisplayLatched: false, x_display: 2.0, dhat: 0.4,
    band: 'entry_to_sweet', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 12,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 2, delivery: 'statusline_pulse', turnSeq: 11 } });
  const out = formatLine(s);
  assert.ok(!/rent \+/.test(out), 'stale or current bill event — no pulse either way');
  assert.ok(out.includes('50%'), 'meter still renders');
});

// Single merged-presentation stack (STRICT priority, never both): stop_hook alert wins the turn.
// A deep-water empty_burn turn is BOTH a stop_hook alert AND leaves a bill pulse — render the prominent
// alert and NOT a second bill-pulse line.
test('B3 single-stack: a deep-water empty_burn turn renders the prominent stop alert, NOT a second bill pulse', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 8, billProgress: 0.9, billCycleCount: 1,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: 3.0, dhat: 0.4,
    band: 'above_exit', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 20,
    lastStopEvent: { kind: 'empty_burn', delivery: 'stop_hook', message: '深水空烧：建议交接/重启', billCount: 1, turnSeq: 20 },
    lastBillEvent: { kind: 'empty_burn', billCount: 1, delivery: 'stop_hook', turnSeq: 20 } });
  const out = formatLine(s);
  assert.ok(out.includes('深水空烧：建议交接/重启'), 'the stop_hook alert message wins the turn');
  assert.ok(!/rent \+1x/.test(out), 'no second bill-pulse line — single merged presentation');
});

test('B3 priority: with only a stop event this turn, the stop message renders', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 5, billProgress: 0.95, billCycleCount: 1,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: 5.0, dhat: 0.4,
    band: 'above_exit', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 22,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: '接近速率墙', billCount: 0, turnSeq: 22 } });
  const out = formatLine(s);
  assert.ok(out.includes('接近速率墙'), 'stop alert rendered');
  assert.ok(!/rent \+/.test(out), 'no bill pulse (none present)');
});

// v3: a reliable frame with no stop event renders the full layout without any alert second line.
// The neutral bill pulse is retired.
test('A2: a reliable frame with bill events but no stop event renders no alert line (neutral pulse retired)', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: true, hBreak: 15, billProgress: 0.6, billCycleCount: 3,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: 5.0, dhat: 0.4,
    band: 'above_exit', lBase: 55000, L_read: 137000, L_cap: 960000,
    targetL: 200000, kAvg: 3000, currentTurnSeq: 30,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 3, delivery: 'statusline_pulse', turnSeq: 30 } });
  const out = formatLine(s);
  assert.ok(out.includes('60%'), 'meter renders billProgress');
  assert.ok(!out.includes('\n'), 'no second line without a current-turn stop event');
});

// Unreliable rateLamp → calibrating path (v3 renders progressive fill, not the old L/L* bar).
test('B3 fallback: an unreliable rateLamp renders calibrating (v3 progressive fill)', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase({ reliable: false, unavailableReason: 'insufficient_data' });
  const out = formatLine(s);
  // v3: unreliable → renderCalibratingV3 (no full meter, progressive info only)
  assert.ok(out.length > 0, 'non-empty output');
  assert.ok(!out.includes('▮'.repeat(5)), 'no full v3 meter bar when unreliable');
  assert.ok(!/break-even|bill \d|rent \+/.test(out), 'no rate-lamp segment when unreliable');
});

test('B3: an ABSENT rateLamp renders calibrating and does not throw', () => {
  _resetRenderState(); _resetCarousel();
  const s = reliableBase(undefined);
  const out = formatLine(s);
  assert.ok(out.length > 0 && !/break-even/.test(out), 'no rate-lamp segment, still non-empty');
});

// ── Step 4: statusline.sh passes the fmt=line rate-lamp string through unmodified ───────────────────
// A REAL server (a latched healthy fixture → reliable rateLamp) → /api/status?fmt=line contains
// `break-even`, and statusline.sh renders it verbatim (plus the dashboard URL).
function healthyFixtureFile() {
  const asst = (id, cr, input, out) => JSON.stringify({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'deepseek-v4-pro', usage: { input_tokens: input, output_tokens: out,
      cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < 40; i++) deltas.push(940);
  let s = ''; let cr = 42000;
  s += asst('m0', cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4));
  for (let t = 0; t < 40; t++) { cr += deltas[t]; const g = deltas[t + 1] ?? 940;
    s += asst('m' + (t + 1), cr, Math.round(g * 0.6), Math.round(g * 0.4)); }
  const dir = mkdtempSync(join(tmpdir(), 'sw-sl-fx-'));
  const p = join(dir, 's.jsonl'); writeFileSync(p, s); return p;
}

test('Step 4 regression → A2: fmt=line output contains the new v2.2 layout when reliable, and statusline.sh passes it through', async () => {
  chmodSync(SCRIPT, 0o755);
  const watcher = new SessionWatcher(healthyFixtureFile(), null);
  watcher.poll();
  const st = watcher.getStatus();
  assert.equal(st.rateLamp?.reliable, true, 'precondition: the healthy fixture latched → reliable rateLamp');
  const sid = `sl-fmt-${randomUUID()}`;
  const srv = createServer({ watcher, pollIntervalMs: 0, sessionId: sid });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-state-'));
  try {
    // The fmt=line endpoint itself must carry the new v2.2 layout (meter + position + bridge).
    const lineTxt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(lineTxt.includes('▓') || lineTxt.includes('░'), 'fmt=line includes the meter bar when reliable');
    assert.ok(lineTxt.includes('%'), 'fmt=line includes the meter percentage');
    // And statusline.sh passes the server line through unmodified (then appends the dashboard URL).
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ port }));
    const child = execFileP('bash', [SCRIPT], { env: { ...process.env, SW_STATE_DIR: stateDir } });
    child.child.stdin.end(JSON.stringify({ session_id: sid, model: { display_name: 'Opus', id: 'claude-opus-4-8' } }));
    const { stdout: out } = await child;
    assert.ok(out.includes('▓') || out.includes('░'), 'statusline.sh passes the meter through');
    assert.ok(out.includes(`http://127.0.0.1:${port}`), 'and still appends the dashboard URL');
  } finally {
    srv.stopTimers();
    await new Promise((r) => srv.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── D2: single `node` spawn (sid+model+port in one parse) ───────────────────────────────────────────
// One node process parses CC's stdin (sid+model) AND reads `port` from the per-session state file, then
// prints tab-separated `sid<TAB>model<TAB>port`; the shell does one curl. These helpers give the two D2
// tests a spawn counter and a REAL mock status server (I-pt7: the server-up test must hit a real listener,
// not a bare port that silently false-greens through the off-branch).

// A `node` shim, prepended to PATH, that appends a byte to $COUNT_FILE per invocation then execs the real
// node — so behavior is identical and we count spawns by byte length. Chosen over a fake-curl-on-PATH
// argv-assert (brief §I-pt7 reject): stacking a second PATH mechanism on this counter is redundant; the
// existing mock-server idiom already asserts the real server-up output.
function makeNodeShim() {
  const shimDir = mkdtempSync(join(tmpdir(), 'sw-d2-shim-'));
  const countFile = join(shimDir, 'count');
  writeFileSync(countFile, '');
  const shimPath = join(shimDir, 'node');
  writeFileSync(shimPath, `#!/usr/bin/env bash\nprintf 'x' >> "$COUNT_FILE"\nexec "$REAL_NODE" "$@"\n`);
  chmodSync(shimPath, 0o755);
  return { shimDir, countFile };
}

// listen(0) real HTTP listener that curl can actually reach on the shared event loop (see :63 rationale).
async function startMockStatusServer({ line }) {
  const srv = createHttpServer((req, res) => {
    if (req.url.startsWith('/api/status')) {
      // v3: server-side appends the dashboard URL to ?fmt=line responses
      const port = srv.address().port;
      res.setHeader('content-type', 'text/plain');
      res.end(`${line} · http://127.0.0.1:${port}`);
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

// Runs statusline.sh once with the given stdin + optional state file, returns { out (trailing \n trimmed
// for ^…$ anchors), nodeSpawns }. Async execFileP (not execFileSync) so the mock server on this loop is
// not starved into the curl fallback.
async function runStatusline({ stdin, stateFile } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-d2-state-'));
  const { shimDir, countFile } = makeNodeShim();
  if (stateFile) writeFileSync(join(stateDir, stateFile.name), JSON.stringify(stateFile.json));
  chmodSync(SCRIPT, 0o755);
  const env = { ...process.env, SW_STATE_DIR: stateDir, PATH: `${shimDir}:${process.env.PATH}`,
    COUNT_FILE: countFile, REAL_NODE: process.execPath };
  try {
    const child = execFileP('bash', [SCRIPT], { env });
    child.child.stdin.end(stdin ?? '');
    const { stdout } = await child;
    return { out: stdout.replace(/\n$/, ''), nodeSpawns: readFileSync(countFile, 'utf8').length };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
}

test('D2: statusline.sh spawns node exactly once and emits equivalent line', async () => {
  // Fake `node` on PATH counts invocations into a counter file, then execs the real node.
  const { out, nodeSpawns } = await runStatusline({
    stdin: JSON.stringify({
      session_id: 'sess-D2',
      model: { display_name: 'opus' },
    }),
    stateFile: { name: 'sess-D2.json', json: { port: 0 } }, // port 0 → no server → off-branch
  });
  assert.equal(nodeSpawns, 1, 'exactly one node spawn per render (§4.4 perf)');
  assert.match(out, /^\[opus\] no port file$/); // port 0 (falsy) ⟹ no-port-file branch, model tag preserved
});

test('D2: a SPACED model display_name stays whole (A5 IFS=TAB failure mode) — server-up', async () => {
  // The real A5 bug: default IFS splits "Claude Opus 4" → "4" lands in $port → non-numeric → false
  // off-branch on every server-up session with a spaced model. IFS=$'\t' must keep the name intact.
  // I-pt7: MUST hit the server-up branch — use the async mock-server harness (a real listener curl can
  // reach), NOT a bare port. A bare unreachable port makes `curl -sf` fail → line="" → off-branch, which
  // would false-green the IFS check via the WRONG path.
  const server = await startMockStatusServer({ line: '▓▓░ 20% ×0' }); // real listener on an ephemeral port
  try {
    const { out } = await runStatusline({
      stdin: JSON.stringify({
        session_id: 'sess-D2b',
        model: { display_name: 'Claude Opus 4' },
      }),
      stateFile: { name: 'sess-D2b.json', json: { port: server.port } }, // numeric port → server-up branch
    });
    // The server-up branch prints `<line> · http://…` with NO `[model]` tag, so the brief's literal
    // `^\[Claude Opus 4\]` assertion is unreachable HERE (it belongs to the off-branch — asserted in the
    // companion render below). The real A5 proof on the server-up branch: the INTACT numeric port reached
    // the server, i.e. the spaced name did not bleed into $port.
    assert.match(out, /▓▓░ 20% ×0/, 'SERVER-UP branch actually taken (curl reached the numeric port) — NOT the off-branch');
    assert.doesNotMatch(out, /session-watcher off/, 'must NOT be the off-branch (that would false-green the IFS check)');
    assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${server.port}`), 'the intact numeric port reached the server (spaced name did not bleed into $port)');
  } finally {
    await server.close();
  }

  // Companion off-branch render: the `[model]` tag is printed ONLY on the off-branch, so THIS is where the
  // brief's whole-tag assertion is reachable. Under default IFS the spaced name would split (model="Claude",
  // "Opus"/"4" spilling into $port) → tag would read `[Claude]`; IFS=$'\t' keeps the whole name in the tag.
  const { out: offOut } = await runStatusline({
    stdin: JSON.stringify({ session_id: 'sess-D2b-off', model: { display_name: 'Claude Opus 4' } }),
    stateFile: { name: 'sess-D2b-off.json', json: { port: 0 } }, // port 0 → off-branch
  });
  assert.match(offOut, /^\[Claude Opus 4\] no port file$/, 'spaced model tag stays whole in the [model] tag, not split at the space');
});

// ── Task 3: u=2 at the exact lamp↔yellow transition (lamp/u alignment) ──────────────────────────────
test('u=2.0 at the exact point where lamp turns yellow (kStable alignment)', () => {
  _resetRenderState(); _resetCarousel();
  // kStable drives both xExit and dhat → u=2 at lamp transition
  const cRatio = 10, kStable = 1382, lBase = 55000;
  const dhat = Math.sqrt(2 * cRatio * kStable / lBase);
  const xExit = 1 + 2 * dhat;
  const L_at_exit = lBase * xExit;
  const s = reliableBase({ reliable: true, hBreak: 5, billProgress: 0.5, billCycleCount: 3,
    inDeepWater: true, deepWaterDisplayLatched: true, x_display: xExit, dhat,
    kStable, band: 'above_exit', lBase, L_read: L_at_exit, L_cap: 960000,
    targetL: 960000, kAvg: 1382, currentTurnSeq: 10 });
  s.kAvg = 1382;
  const out = formatLine(s);
  assert.ok(out.includes('🟡'), 'lamp is yellow at xExit');
  assert.ok(out.includes('u2.0'), 'u reads exactly 2.0 at the yellow transition');
});
