import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Isolate gate-state writes to a temp CLAUDE_PLUGIN_DATA — gate-store's pathFor reads the env lazily
// per call, so setting it before importing the server is sufficient (mirrors server.rate-lamp.test.js).
const TMP = mkdtempSync(join(tmpdir(), 'sw-gate-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer, stateFileFor, PORT_DIR } from '../server.js';
import { loadGateState } from '../lib/gate-store.js';
import { landmarks } from '../lib/landmarks.js';
import { rawTierFor } from '../lib/notify-gate.js';

// A deterministic stub watcher: L / reliability / turnSeq are directly controllable so the gate math
// (landmarks(cRatio=10, kAvg=940, total=55000, dead=30000, L)) lands on a known tier. With those
// params xStar≈2.169, dhat≈0.585 → tier2 fires at L≥~151.5k, tier1 in ~119.3k..151.5k, else below.
// D4/RV-C15: `model` is optional (default '' — existing reliable callers carry C_RATIO:10 on the frame,
// so gateSnapshotFor's `?? cRatioFor(st.model)` fallback is never reached and their status stays
// behavior-identical). The D4 test drives a deepseek UNRELIABLE frame (C_RATIO omitted, mirroring the
// real getStatus unreliable branch) with model:'deepseek-chat' so the fallback must resolve via cRatioFor.
function gateWatcher({ L = 0, reliable = true, turnSeq = 1, model = '' } = {}) {
  return {
    _turnSeq: turnSeq, _L: L, _reliable: reliable, _foldedCallSeq: 0,
    poll() { return { changed: false, newCalls: 0 }; },
    // Task 8b widened POST /api/notify-gate to run through advanceRateLampToCurrent, which calls these
    // sample builders on the watcher (the real SessionWatcher has them, Task 3). This gate-only stub
    // predates that; add no-op builders so the widened handler exercises the gate path without a fresh
    // ledger drain (these tests assert gate-ratchet behavior, not ledger integration).
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    _currentSegmentCalls() { return []; },
    getStatus() {
      return {
        segment: 0, model, kAvg: 940, L: this._L,
        baseline: { total: 55000, dead: 30000 },
        rateLamp: this._reliable
          ? { reliable: true, C_RATIO: 10 }
          : { reliable: false, unavailableReason: 'insufficient_data' },
      };
    },
  };
}

async function withGateServer({ sessionId, watcher }, fn) {
  // Bind loopback explicitly (production server.js:263 does the same) so this harness proves createServer's
  // http.Server honors a 127.0.0.1 bind — POST mutates gate state and must not be reachable off-host.
  const srv = createServer({ watcher, pollIntervalMs: 0, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const addr = srv.server.address();
  try { await fn({ port: addr.port, address: addr.address, srv }); }
  finally { srv.stopTimers(); await new Promise(r => srv.server.close(r)); }
}

// ── test 66: POST advances+persists the ratchet; GET /peek is read-only ─────────────────────────────
test('66: POST advances+persists the ratchet; GET /peek reports the would-be tier without mutating', async () => {
  const sid = `gate-${randomUUID()}`;
  const w = gateWatcher({ L: 160000, reliable: true, turnSeq: 1 }); // tier2 range (immediate fire)
  await withGateServer({ sessionId: sid, watcher: w }, async ({ port, address }) => {
    // Loopback-bind assertion (round-2 GPT verify-only).
    assert.equal(address, '127.0.0.1', 'server bound loopback-only (a POST mutates gate state)');

    // /peek is read-only: reports the would-be raw tier and NEVER persists / advances the ratchet.
    const peek1 = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate/peek`)).json();
    assert.equal(peek1.rawTier, 2, 'peek reports the would-be raw tier (tier2 range)');
    assert.equal(peek1.maxTierFired, 0, 'no prior fire persisted');
    assert.equal(peek1.reliable, true, 'peek surfaces reliability');
    const peek2 = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate/peek`)).json();
    assert.equal(peek2.maxTierFired, 0, 'a repeat peek still shows an unadvanced ratchet (no mutation)');
    assert.equal(loadGateState(sid), null, 'peek wrote NO gate file');

    // POST fires as if peek never ran (tier2 is exempt from the tier1 confirm window → immediate fire).
    const post1 = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate`, { method: 'POST' })).json();
    assert.equal(post1.notify, true, 'first eligible POST fires');
    assert.equal(post1.tier, 2, 'fired at tier2');
    assert.equal(typeof post1.message, 'string', 'fire carries a message');
    const persisted = loadGateState(sid);
    assert.equal(persisted.maxTierFired, 2, 'POST persisted the advanced ratchet');
    assert.equal(persisted.turnSeq, 1, 'POST persisted the evaluated turnSeq');

    // A second POST at a higher turnSeq, same tier → ratchet suppresses (rawTier ≤ maxTierFired).
    w._turnSeq = 2;
    const post2 = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate`, { method: 'POST' })).json();
    assert.equal(post2.notify, false, 'the ratchet suppresses a repeat at the same tier');
    assert.equal(loadGateState(sid).turnSeq, 2, 'turnSeq advanced even on the suppressed turn');
  });
});

// ── D3 (#8): one POST does exactly one getStatus (gateSnapshotFor reuses the advance's status) ───────
test('D3: one POST /api/notify-gate calls watcher.getStatus exactly once', async () => {
  // #8: today the POST computes getStatus twice — once inside advanceRateLampToCurrent (manager) and
  // again inside gateSnapshotFor (route). Passing the already-computed status into gateSnapshotFor makes
  // it ONE per POST. gateWatcher is this file's fake watcher (test 66 drives the same full POST path).
  let getStatusCalls = 0;
  const watcher = gateWatcher({ L: 160000, reliable: true, turnSeq: 1 });
  const realGetStatus = watcher.getStatus.bind(watcher);
  watcher.getStatus = (...a) => { getStatusCalls++; return realGetStatus(...a); };
  const srv = createServer({ watcher, pollIntervalMs: 0, sessionId: 'sess-D3' });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  getStatusCalls = 0; // reset after the createServer initial poll (poll() only; not getStatus, but be safe)
  await fetch(`http://127.0.0.1:${port}/api/notify-gate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'sess-D3' }) });
  srv.stopTimers();
  await new Promise(r => srv.server.close(r));
  assert.equal(getStatusCalls, 1, '#8: gateSnapshotFor must reuse advanceRateLampToCurrent’s status');
});

// ── session-mismatch 409 + fail-open guard (round-6 GPT#3a + round-7 gemini#2) ──────────────────────
test('POST with a mismatched session_id → 409 and no mutation; matching sid proceeds', async () => {
  const sid = `gate-${randomUUID()}`;
  const w = gateWatcher({ L: 160000, reliable: true, turnSeq: 1 });
  await withGateServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const mismatch = await fetch(`http://127.0.0.1:${port}/api/notify-gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: `OTHER-${randomUUID()}` }) });
    assert.equal(mismatch.status, 409, 'cross-session POST refused with 409 (stale-port guard)');
    assert.equal((await mismatch.json()).error, 'session_mismatch');

    // No mutation: /peek still shows maxTierFired 0 and no gate file was written. (If a future edit
    // dropped/mis-ordered express.json, req.body would be undefined, the 409 would silently fail-open,
    // and the 409 assertion above would go red — this test doubles as the fail-open guard.)
    const peek = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate/peek`)).json();
    assert.equal(peek.maxTierFired, 0, 'a 409-refused POST did not mutate gate state');
    assert.equal(loadGateState(sid), null, 'no gate file written by a rejected POST');

    // A POST with the matching sid proceeds normally and fires.
    const ok = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid }) })).json();
    assert.equal(ok.notify, true, 'matching-sid POST proceeds and fires');
    assert.equal(ok.tier, 2);
  });
});

// ── error boundary: a throwing handler → 500 (daemon survives); an over-limit body → 413 ────────────
test('error boundary: a throwing getStatus → 500 (process survives); a >4kb body → 413', async () => {
  const sid = `gate-${randomUUID()}`;
  const w = { _turnSeq: 1, poll() { return { changed: false, newCalls: 0 }; }, getStatus() { throw new Error('boom'); } };
  await withGateServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/notify-gate`, { method: 'POST' });
    assert.equal(bad.status, 500, 'a thrown handler becomes HTTP 500, not a crash');
    assert.equal((await bad.json()).error, 'internal');

    // The process did not die — an unrelated healthy route still answers.
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true, 'daemon stayed up after the 500');

    // >4kb body → express.json throws a PayloadTooLargeError (status 413); the terminal middleware
    // honors err.status (round-8 gemini#3) rather than flattening it to 500. Still never crashes.
    const big = await fetch(`http://127.0.0.1:${port}/api/notify-gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413, 'over-limit body → 413, not 500');
    assert.equal((await big.json()).error, 'payload_too_large');

    // still alive after the 413 too.
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok, true);
  });
});

// ── not-reliable snapshot → gate does not fire (reason path) ─────────────────────────────────────────
test('an unreliable getStatus → POST does not fire (reliability gate), /peek still answers', async () => {
  const sid = `gate-${randomUUID()}`;
  const w = gateWatcher({ L: 160000, reliable: false, turnSeq: 1 }); // deep in tier2 range, but unreliable
  await withGateServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const post = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate`, { method: 'POST' })).json();
    assert.equal(post.notify, false, 'an unreliable snapshot never fires');
    const peek = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate/peek`)).json();
    assert.equal(peek.reliable, false, 'peek reflects the unreliable snapshot');
  });
});

// ── stateFileFor traversal sanitization (round-7 GPT#6 + round-8 GPT-small) ─────────────────────────
test('stateFileFor sanitizes a traversal sessionId: resolved path stays inside PORT_DIR', () => {
  // round-8 GPT-small: use path.relative, NOT startsWith — a sibling like /tmp/sw2 false-passes a
  // startsWith(/tmp/sw) check. A truly-contained path yields a relative with no leading ".." and non-absolute.
  const rel = relative(PORT_DIR, stateFileFor('../evil'));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'resolved path stays inside PORT_DIR');
});

// ── production bootstrap binds loopback (verify-only, round-2 GPT) ───────────────────────────────────
test('server.js bootstrap binds 127.0.0.1 (loopback-only, verify)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
  assert.match(src, /server\.listen\(\s*wantPort\s*,\s*'127\.0\.0\.1'/, 'the bootstrap listen binds 127.0.0.1');
});

// ── D4 (RV-C15): gateSnapshotFor C_RATIO fallback is model-derived (cRatioFor), not a hardcoded 10 ────
// ROUTE-LEVEL, not a tautological cRatioFor unit assertion: drive /peek with a deepseek UNRELIABLE frame
// that OMITS rateLamp.C_RATIO (the real getStatus omits it on the unreliable branch). Bug: `?? 10` computes
// landmarks with ratio 10; fix: `?? cRatioFor(st.model)` computes with 50 for deepseek-chat. The only
// landmark-derived value the read-only /peek exposes is `rawTier` (= rawTierFor(x, fullCarry)), so we assert
// on that. With L/total/kAvg/dead below, x=2.5: ratio-10 xStar≈2.17 → rawTier 1, ratio-50 xStar≈3.61 →
// rawTier 0. The `reliable:false` frame does NOT gate /peek (peek reports the would-be raw tier regardless
// of reliability — test 'an unreliable getStatus' above confirms /peek still answers), so the tier flips
// purely on the ratio the fallback picks. Expected is computed from landmarks(50,…), never a literal.
test('D4/RV-C15: peek gate snapshot uses cRatioFor(model)=50 for a deepseek unreliable frame, not 10', async () => {
  const sid = `gate-${randomUUID()}`;
  // Match the gateWatcher status shape (kAvg 940, total 55000, dead 30000); x = 137500/55000 = 2.5.
  const L = 137500, total = 55000, dead = 30000, kAvg = 940;
  const watcher = gateWatcher({ L, reliable: false, turnSeq: 1, model: 'deepseek-chat' }); // no C_RATIO on the frame
  await withGateServer({ sessionId: sid, watcher }, async ({ port }) => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/notify-gate/peek`)).json();
    const x = L / total;
    const expected = rawTierFor(x, landmarks(50, kAvg, total, dead, L).fullCarry); // cRatioFor('deepseek-chat')=50
    const wrong = rawTierFor(x, landmarks(10, kAvg, total, dead, L).fullCarry);     // the `?? 10` bug's tier
    assert.notEqual(expected, wrong, 'guard: params must make ratio 50 vs 10 yield different raw tiers');
    assert.equal(res.rawTier, expected, 'fallback is model-derived (cRatioFor=50), not the hardcoded 10');
  });
});
