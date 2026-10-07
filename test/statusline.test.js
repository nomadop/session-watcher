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

import { formatLine, createServer } from '../server.js';
import { _resetRenderState } from '../lib/statusline-format.js';
import { composeForTranscript } from './helpers/server-boot.js';

const execFileP = promisify(execFile);

// The script's whole environment: nothing inherited from the developer's shell, so an exported SW_PROBE or
// SW_STATE_DIR cannot make it write into the real install.
const scriptEnv = (stateDir, extra = {}) => ({
  PATH: process.env.PATH, HOME: stateDir, SW_STATE_DIR: stateDir, ...extra,
});

// A reliable base status so the B3 rate-lamp string is exercised on top of the live line.
const reliableBase = (rateLamp) => ({
  model: 'claude-opus-4-8', port: 38017, L: 137000, B: 55000, rateLamp,
});

const SCRIPT = 'statusline.js';
const MOCK_STDIN = JSON.stringify({
  model: { display_name: 'Opus', id: 'claude-opus-4-8' },
  session_id: 'test-sid', transcript_path: '/tmp/x.jsonl',
  context_window: { current_usage: { cache_read_input_tokens: 137000 } },
});

// Not skipped: the script must exist. First run (before writing it) fails loudly, satisfying TDD.
test('statusline exits 0 and prints a fallback line when server is down', () => {
  assert.ok(existsSync(SCRIPT), 'statusline.js must exist');
  chmodSync(SCRIPT, 0o755);
  // An empty state dir holds no discovery record, so no server is found → fallback path.
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-state-'));
  let out;
  try {
    out = execFileSync(process.execPath, [SCRIPT], { input: MOCK_STDIN, env: scriptEnv(stateDir), encoding: 'utf8' });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
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
    const child = execFileP(process.execPath, [SCRIPT], { env: scriptEnv(stateDir) });
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

// Task 10 (ER-2) → v3: kFit eta is retired.
// Validate that no kFit eta artifact leaks.
test('Task 10 (ER-2) → A2: formatLine no longer renders the kFit `~N轮` eta', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: true, billProgress: 0.37, billCycleCount: 0,
    x_display: 2.5, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 5 });
  const out = formatLine(s);
  assert.ok(!/~\d+轮/.test(out), 'no `~N轮` kFit eta rendered');
  assert.ok(!out.includes('已过线'), 'no `已过线` kFit-crossing eta rendered');
});

// v3: new layout renders lamp + meter (▮ bar + % + ×N) + countdown u + delta L/b + tag :port.
// The old `break-even ~N turns` / `bill NN%` format is retired.
test('A2: reliable rateLamp renders the new v3 layout, no old break-even/bill format', () => {
  _resetRenderState();
  // The two clocks are given different phases on purpose: an equal pair cannot tell which one the meter
  // reads, and the bill clock is not what this line shows.
  const s = reliableBase({ reliable: true, billProgress: 0.68, billCycleCount: 2,
    br: 0.15, x_display: 2.5, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 5,
    rentMeter: { depthActive: true, depthProgress: 0.37 } });
  const out = formatLine(s);
  assert.ok(out.includes('▮') || out.includes('░'), 'v3 meter bar renders');
  assert.ok(out.includes('37%'), 'meter shows the wallet phase as floor percentage');
  assert.ok(!out.includes('68%'), 'the bill clock phase is not what the meter shows');
  assert.ok(out.includes('🟡'), 'amber lamp from br >= 0.10');
  assert.ok(out.includes('L137k'), 'L value renders fixed-width');
  assert.ok(out.includes('b55k'), 'baseline value renders tight-coupled');
  assert.ok(!/break-even ~\d+ turns/.test(out), 'old break-even format is gone');
  assert.ok(!/bill \d+%/.test(out), 'old bill format is gone');
});

test('A2: a missing br renders the b---% placeholder', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: true, billProgress: 0.63, billCycleCount: 0,
    x_display: 1.2, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 3, rentMeter: { depthActive: true, depthProgress: 0 } });
  // No br → renderBr(undefined) renders b---%
  const out = formatLine(s);
  assert.ok(out.includes('b---%'), 'missing br renders b---% placeholder');
  assert.ok(out.includes('0%'), 'wallet phase 0 rendered in meter');
  assert.ok(!out.includes('63%'), 'the bill clock is mid-cycle and the meter still reads the wallet clock');
});

test('B3 priority: with only a stop event this turn, the stop message renders', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: true, billProgress: 0.95, billCycleCount: 1,
    x_display: 5.0, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 22,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: '接近速率墙', billCount: 0, turnSeq: 22 } });
  const out = formatLine(s);
  assert.ok(out.includes('接近速率墙'), 'stop alert rendered');
});

// v3: a reliable frame with no stop event renders the full layout without any alert second line.
test('A2: a reliable frame with no stop event renders no alert line', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: true, billProgress: 0.19, billCycleCount: 3,
    x_display: 5.0, dhat: 0.4, L_read: 137000, L_cap: 960000, currentTurnSeq: 30,
    rentMeter: { depthActive: true, depthProgress: 0.6 } });
  const out = formatLine(s);
  assert.ok(out.includes('60%'), 'meter renders the wallet phase');
  assert.ok(!out.includes('19%'), 'the bill phase is not the meter\'s clock');
  assert.ok(!out.includes('\n'), 'no second line without a current-turn stop event');
});

// Unreliable rateLamp → v3 measuring… neutral line (no carousel, no progressive fill).
test('B3 fallback: an unreliable rateLamp renders measuring… (v3 neutral line)', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: false, unavailableReason: 'insufficient_data' });
  const out = formatLine(s);
  // v3: unreliable → single "⚪ measuring… · model" line
  assert.ok(out.length > 0, 'non-empty output');
  assert.match(out, /^⚪ measuring…/, 'white lamp leads the measuring… line');
  assert.ok(!out.includes('▮'.repeat(5)), 'no full v3 meter bar when unreliable');
  assert.ok(!/break-even|bill \d|rent \+/.test(out), 'no rate-lamp segment when unreliable');
});

test('B3: an ABSENT rateLamp renders measuring… and does not throw', () => {
  _resetRenderState();
  const s = reliableBase(undefined);
  const out = formatLine(s);
  assert.ok(out.length > 0 && !/break-even/.test(out), 'no rate-lamp segment, still non-empty');
  assert.match(out, /measuring…/, 'measuring… line');
});

// ── Step 4: statusline.js passes the fmt=line rate-lamp string through unmodified ───────────────────
// A REAL server (a latched healthy fixture → reliable rateLamp) → /api/status?fmt=line contains
// `break-even`, and statusline.js renders it verbatim (plus the dashboard URL).
function healthyFixtureFile() {
  // Chained into ONE topology on purpose: a null-parent row is a topology root and a root with a call behind
  // it is a compact epoch, so an unchained run of these would be one epoch per row rather than the single
  // healthy session this fixture is named for.
  let prevUuid = null;
  const asst = (id, cr, input, out) => {
    const uuid = id + '_' + cr;
    const row = JSON.stringify({ type: 'assistant', uuid, parentUuid: prevUuid, isSidechain: false,
      timestamp: '2026-07-01T00:00:00Z',
      message: { id, role: 'assistant', model: 'deepseek-v4-pro', content: [],
        usage: { input_tokens: input, output_tokens: out,
          cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
    prevUuid = uuid;
    return row;
  };
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < 40; i++) deltas.push(940);
  let s = ''; let cr = 42000;
  s += asst('m0', cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4));
  for (let t = 0; t < 40; t++) { cr += deltas[t]; const g = deltas[t + 1] ?? 940;
    s += asst('m' + (t + 1), cr, Math.round(g * 0.6), Math.round(g * 0.4)); }
  const dir = mkdtempSync(join(tmpdir(), 'sw-sl-fx-'));
  const p = join(dir, 's.jsonl'); writeFileSync(p, s); return p;
}

test('Step 4 regression → A2: fmt=line output contains the new v2.2 layout when reliable, and statusline.js passes it through', async (t) => {
  chmodSync(SCRIPT, 0o755);
  const sid = `sl-fmt-${randomUUID()}`;
  // The host's synchronous bootstrap acquires the fixture before the server is exposed, so the reliable
  // frame this asserts on is already in place — no explicit poll.
  const composed = composeForTranscript({ transcriptPath: healthyFixtureFile(), sessionId: sid });
  const srv = composed.handle;
  // The composition owns the temp store as well as the server, and the precondition below can fail before the
  // stop-and-close the exit path performs, so its own `teardown` is the release registered from here on.
  t.after(() => composed.teardown());
  const st = composed.watcher.getStatus();
  assert.equal(st.rateLamp?.reliable, true, 'precondition: the healthy fixture latched → reliable rateLamp');
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-state-'));
  try {
    // The fmt=line endpoint itself must carry the new v2.2 layout (meter + position + bridge).
    const lineTxt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(lineTxt.includes('▓') || lineTxt.includes('░'), 'fmt=line includes the meter bar when reliable');
    assert.ok(lineTxt.includes('%'), 'fmt=line includes the meter percentage');
    // And statusline.js passes the server line through unmodified (then appends the dashboard URL).
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ port }));
    const child = execFileP(process.execPath, [SCRIPT], { env: scriptEnv(stateDir) });
    child.child.stdin.end(JSON.stringify({ session_id: sid, model: { display_name: 'Opus', id: 'claude-opus-4-8' } }));
    const { stdout: out } = await child;
    assert.ok(out.includes('▓') || out.includes('░'), 'statusline.js passes the meter through');
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

// Runs statusline.js once with the given stdin + optional state file, returns { out (trailing \n trimmed
// for ^…$ anchors), nodeSpawns }. Async execFileP (not execFileSync) so the mock server on this loop is
// not starved into the curl fallback.
async function runStatusline({ stdin, stateFile } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-d2-state-'));
  const { shimDir, countFile } = makeNodeShim();
  if (stateFile) writeFileSync(join(stateDir, stateFile.name), JSON.stringify(stateFile.json));
  chmodSync(SCRIPT, 0o755);
  const env = scriptEnv(stateDir, {
    PATH: `${shimDir}:${process.env.PATH}`, COUNT_FILE: countFile, REAL_NODE: process.execPath,
  });
  try {
    const child = execFileP('node', [SCRIPT], { env });
    child.child.stdin.end(stdin ?? '');
    const { stdout } = await child;
    return { out: stdout.replace(/\n$/, ''), nodeSpawns: readFileSync(countFile, 'utf8').length };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
}

test('D2: statusline.js spawns node exactly once and emits equivalent line', async () => {
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

// ── Task 3: u on the right arm renders beside the br-driven lamp ────────────────────────────────────
test('u=2.0 renders as u2.0 beside the amber lamp', () => {
  _resetRenderState();
  const s = reliableBase({ reliable: true, billProgress: 0.5, billCycleCount: 3,
    br: 0.15, u: 2.0, mf: 0.3, currentTurnSeq: 10 });
  const out = formatLine(s);
  assert.ok(out.includes('🟡'), 'an amber br lights the yellow lamp');
  assert.ok(out.includes('u2.0'), 'u renders as u2.0');
});
