// test/statusline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
import { SessionWatcher } from '../lib/watcher.js';

const execFileP = promisify(execFile);

// A reliable base status (bar/eta path) so the B3 rate-lamp string is exercised on top of the live line.
const reliableBase = (rateLamp) => ({
  model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
  metricsReliable: true, calibratingReason: null, phi: 2.4, paybackP: 0.6, etaCalls: 40,
  baseline: { total: 55000 }, rateLamp,
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
  const srv = createHttpServer((req, res) => {
    if (req.url.startsWith('/api/status')) { res.setHeader('content-type', 'text/plain'); res.end('METRICS_LINE'); return; }
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
    assert.ok(out.includes(`http://127.0.0.1:${port}`), 'appends the full dashboard URL');
  } finally {
    srv.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── B3: formatLine rate-lamp contract ─────────────────────────────────────────────────────────────

// Task 10 (ER-2): the kFit eta segment (`~N轮` / `已过线` / `—`) is retired from the statusline — the
// Task-7 break-even (from hBreak) replaces it. Even when a status still carries etaCalls (reliableBase
// passes etaCalls:40), formatLine must NOT render the `~N轮` kFit eta. RED before the production
// deletion (the base string rendered `~40轮`), GREEN after. Does NOT touch the break-even/bill/rent copy.
test('Task 10 (ER-2): formatLine no longer renders the kFit `~N轮` eta segment', () => {
  const s = reliableBase({ reliable: true, hBreak: 12.4, billProgress: 0.37, inDeepWater: true, currentTurnSeq: 5 });
  const out = formatLine(s);
  assert.ok(!/~\d+轮/.test(out), 'no `~N轮` kFit eta rendered');
  assert.ok(!out.includes('已过线'), 'no `已过线` kFit-crossing eta rendered');
  assert.ok(out.includes('break-even ~12 turns'), 'the Task-7 break-even segment (replacement) still renders');
});

// Test 43: a reliable deep-water rateLamp appends `break-even ~N turns` (N = Math.round(hBreak)) and
// `bill NN%` (from billProgress) — and NEVER a cumulative restart/cycle count (§4.2/§10.1#11).
test('B3 test 43: reliable rateLamp appends break-even ~N turns + bill NN%, never a cumulative total', () => {
  const s = reliableBase({ reliable: true, hBreak: 12.4, billProgress: 0.37, inDeepWater: true, currentTurnSeq: 5 });
  const out = formatLine(s);
  assert.ok(out.includes('L ') && out.includes('L*'), 'keeps the existing bar/eta line');
  assert.ok(out.includes('break-even ~12 turns'), 'rounds hBreak to the nearest turn (§3.8)');
  assert.ok(out.includes('bill 37%'), 'renders billProgress as a percentage');
  assert.ok(!/cycle|count|billCycle|×\d|周期/.test(out), 'no cumulative cycle/restart total surfaced');
});

// Review A7#15: hBreak may be Infinity (burnRate=0, below the floor). Must render `break-even —`,
// NEVER `break-even ~Infinity turns`.
test('B3 A7#15: hBreak Infinity (burnRate=0) renders break-even — , not ~Infinity', () => {
  const s = reliableBase({ reliable: true, hBreak: Infinity, billProgress: 0, inDeepWater: false, currentTurnSeq: 3 });
  const out = formatLine(s);
  assert.ok(out.includes('break-even —'), 'Infinity hBreak → em-dash sentinel');
  assert.ok(!out.includes('Infinity'), 'never leaks the literal Infinity');
  assert.ok(out.includes('bill 0%'), 'billProgress 0 still rendered');
});

// Test 44: a settlement turn (lastBillEvent.turnSeq === currentTurnSeq) renders the pulse.
test('B3 test 44: a non_idle_burn settlement turn renders `rent +Nx · ctx growing`', () => {
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, inDeepWater: false, currentTurnSeq: 7,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 2, delivery: 'statusline_pulse', turnSeq: 7 } });
  const out = formatLine(s);
  assert.ok(out.includes('rent +2x'), 'shows the per-turn pulse count (+Nx)');
  assert.ok(/ctx growing|growing/.test(out), 'non_idle_burn copy = ctx growing');
  assert.ok(!/verdict|建议重启|restart|α|alpha/i.test(out.replace('L≥L*', '')), 'neutral copy — no verdict word / no α');
});

test('B3: an empty_burn settlement turn renders `rent +Nx · idle`', () => {
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, inDeepWater: false, currentTurnSeq: 9,
    lastBillEvent: { kind: 'empty_burn', billCount: 1, delivery: 'statusline_pulse', turnSeq: 9 } });
  const out = formatLine(s);
  assert.ok(out.includes('rent +1x'), 'per-turn pulse count');
  assert.ok(/idle/.test(out) && !/growing/.test(out), 'empty_burn copy = idle (not growing)');
});

// round-2 GPT#13: a cache_unstable settlement is a NEGATIVE jump — render the neutral calibrating copy,
// NOT the "ctx growing" pulse (the opposite of growing).
test('B3 GPT#13: a cache_unstable settlement renders the neutral calibrating copy, not `ctx growing`', () => {
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, inDeepWater: false, currentTurnSeq: 11,
    lastBillEvent: { kind: 'cache_unstable', billCount: 1, delivery: 'statusline_pulse', turnSeq: 11 } });
  const out = formatLine(s);
  assert.ok(/校准|calibrat|unstable/i.test(out), 'cache_unstable → neutral calibrating copy');
  assert.ok(!/ctx growing|growing/.test(out), 'never the ctx-growing copy for a negative jump');
});

// TTL: a stale event from an earlier turn must not keep flashing.
test('B3 TTL: a stale lastBillEvent (turnSeq !== currentTurnSeq) renders NO pulse', () => {
  const s = reliableBase({ reliable: true, hBreak: 20, billProgress: 0.5, inDeepWater: false, currentTurnSeq: 12,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 2, delivery: 'statusline_pulse', turnSeq: 11 } });
  const out = formatLine(s);
  assert.ok(!/rent \+/.test(out), 'stale pulse (turnSeq 11 vs current 12) does not render');
  assert.ok(out.includes('break-even ~20 turns') && out.includes('bill 50%'), 'the always-on rate-lamp segment still renders');
});

// Single merged-presentation stack (STRICT priority, never both): stop_hook alert wins the turn.
// A deep-water empty_burn turn is BOTH a stop_hook alert AND leaves a bill pulse — render the prominent
// alert and NOT a second bill-pulse line.
test('B3 single-stack: a deep-water empty_burn turn renders the prominent stop alert, NOT a second bill pulse', () => {
  const s = reliableBase({ reliable: true, hBreak: 8, billProgress: 0.9, inDeepWater: true, currentTurnSeq: 20,
    lastStopEvent: { kind: 'empty_burn', delivery: 'stop_hook', message: '深水空烧：建议交接/重启', billCount: 1, turnSeq: 20 },
    lastBillEvent: { kind: 'empty_burn', billCount: 1, delivery: 'stop_hook', turnSeq: 20 } });
  const out = formatLine(s);
  assert.ok(out.includes('深水空烧：建议交接/重启'), 'the stop_hook alert message wins the turn');
  assert.ok(!/rent \+1x/.test(out), 'no second bill-pulse line — single merged presentation');
});

test('B3 priority: with only a stop event this turn, the stop message renders', () => {
  const s = reliableBase({ reliable: true, hBreak: 5, billProgress: 0.95, inDeepWater: true, currentTurnSeq: 22,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: '接近速率墙', billCount: 0, turnSeq: 22 } });
  const out = formatLine(s);
  assert.ok(out.includes('接近速率墙'), 'stop alert rendered');
  assert.ok(!/rent \+/.test(out), 'no bill pulse (none present)');
});

// tests 32/33 sense at the statusline layer: BOTH the gate/deep-water info and the bill info show without
// a double-red. Here a settlement turn with NO stop event surfaces the pulse AND the break-even/bill.
test('B3 tests 32/33 sense: a settlement turn shows both the rate-lamp segment and the bill pulse, no double red', () => {
  const s = reliableBase({ reliable: true, hBreak: 15, billProgress: 0.6, inDeepWater: true, currentTurnSeq: 30,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 3, delivery: 'statusline_pulse', turnSeq: 30 } });
  const out = formatLine(s);
  assert.ok(out.includes('break-even ~15 turns') && out.includes('bill 60%'), 'rate-lamp segment present');
  assert.ok(out.includes('rent +3x'), 'bill pulse present in the same line');
  assert.equal((out.match(/🔴/g) || []).length <= 1, true, 'at most one red marker — no double red');
});

// Unreliable rateLamp → no rate-lamp string appended (existing bar line unchanged).
test('B3 fallback: an unreliable rateLamp appends nothing (existing line only)', () => {
  const s = reliableBase({ reliable: false, unavailableReason: 'insufficient_data' });
  const out = formatLine(s);
  assert.ok(out.includes('L ') && out.includes('L*'), 'existing bar/eta line intact');
  assert.ok(!/break-even|bill \d|rent \+/.test(out), 'no rate-lamp segment when unreliable');
});

test('B3: an ABSENT rateLamp appends nothing and does not throw', () => {
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

test('Step 4 regression: fmt=line output contains `break-even` when reliable, and statusline.sh passes it through', async () => {
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
    // The fmt=line endpoint itself must carry the rate-lamp string.
    const lineTxt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(lineTxt.includes('break-even'), 'fmt=line includes the break-even segment when reliable');
    // And statusline.sh passes the server line through unmodified (then appends the dashboard URL).
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ port }));
    const child = execFileP('bash', [SCRIPT], { env: { ...process.env, SW_STATE_DIR: stateDir } });
    child.child.stdin.end(JSON.stringify({ session_id: sid, model: { display_name: 'Opus', id: 'claude-opus-4-8' } }));
    const { stdout: out } = await child;
    assert.ok(out.includes('break-even'), 'statusline.sh passes the rate-lamp string through unmodified');
    assert.ok(out.includes(`http://127.0.0.1:${port}`), 'and still appends the dashboard URL');
  } finally {
    srv.stopTimers();
    await new Promise((r) => srv.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
