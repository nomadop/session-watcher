// test/watcher.latch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { computeCalibrationGate, callIdentity, applyFrozen } from '../lib/latch.js';

function line(o) { return JSON.stringify(o) + '\n'; }
function asst(id, cr, input, out, model = 'deepseek-v4-pro') {
  return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}
function tmp(text) { const p = join(mkdtempSync(join(tmpdir(), 'sw-latch-')), 's.jsonl'); writeFileSync(p, text); return p; }
function tmpPath() { return join(mkdtempSync(join(tmpdir(), 'sw-latch-')), 's.jsonl'); }
// Healthy warmup→stable session (lag-aligned input/output so metricsReliable is true). `idPrefix`
// keeps ids unique across batches so an APPENDED batch never folds into the first (same-segment
// folding is keyed on message.id — reused ids would rewrite in place, not append).
function healthy(n, startCr = 42000, idPrefix = 'm') {
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < n; i++) deltas.push(940);
  let s = ''; let cr = startCr;
  s += asst(idPrefix + '0', cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4));
  for (let t = 0; t < n; t++) { cr += deltas[t]; const g = deltas[t + 1] ?? 940;
    s += asst(idPrefix + (t + 1), cr, Math.round(g * 0.6), Math.round(g * 0.4)); }
  return s;
}

test('computeCalibrationGate: passes only when all criteria hold', () => {
  assert.deepEqual(computeCalibrationGate({ confidence: 0.92, postKneeGrowthCalls: 5, baselineTotal: 50000, L: 90000 }), { passed: true, reason: null });
  assert.deepEqual(computeCalibrationGate({ confidence: 0.6, postKneeGrowthCalls: 5, baselineTotal: 50000, L: 90000 }), { passed: false, reason: 'low_confidence' });
  assert.deepEqual(computeCalibrationGate({ confidence: 0.92, postKneeGrowthCalls: 2, baselineTotal: 50000, L: 90000 }), { passed: false, reason: 'insufficient_data' });
  assert.deepEqual(computeCalibrationGate({ confidence: 0.92, postKneeGrowthCalls: 5, baselineTotal: 50000, L: 40000 }), { passed: false, reason: 'insufficient_data' });
});

test('refactor is behavior-preserving: getStatus calibratingReason unchanged on empty + healthy data', () => {
  // "unseen" = a NEVER-openable transcript (missing file): only that path yields no_transcript.
  // tmpPath() creates the dir but not the file, so openSync fails → _transcriptSeen stays false.
  // (A real empty file via tmp('') is openable → _transcriptSeen=true → this would be low_confidence
  // under a carried baseline / insufficient_data cold — matching pre-refactor; the brief's tmp('')
  // literal here was a fixture bug, and the brief's own unused tmpPath() helper is the intended one.)
  const empty = new SessionWatcher(tmpPath(), 10000); empty.poll();
  assert.equal(empty.getStatus().calibratingReason, 'no_transcript', 'empty+unseen still no_transcript');

  const w = new SessionWatcher(tmp(healthy(40)), 42000); w.poll();
  const s = w.getStatus();
  assert.ok(s.calibratingReason === null || typeof s.calibratingReason === 'string', 'reason shape preserved');
  // The last history point still agrees with getStatus (QF1 holds through the refactor).
  const last = w.getHistory().at(-1);
  assert.equal(last.L, s.L);
  assert.ok(Math.abs(last.Lstar - s.Lstar) < 1);
});

// GOLDEN numeric snapshot (GPT-plan-review #7): a pure refactor must not shift ANY core number, not
// just the reason shape. Uses a CARRIED baseline (42000) as the vehicle: carried never latches
// (Global Constraints), so these numbers are identical pre-refactor, after Task 3, AND after Task 4 —
// a stable refactor-lock across the whole plan (a cold-start fixture would legitimately change when
// Task 4 adds latching). The literals below were MEASURED against the current (pre-refactor) code with
// this exact fixture (healthy(40,42000,'g'), model deepseek-v4-pro → cRatio 50). If Task 3's refactor
// shifts any of them the test fails — that is the whole point. If a future unrelated change to the
// healthy() shape moves these, re-measure with a one-off print script and update the literals.
test('refactor golden: core numbers on a fixed carried-baseline fixture match pre-refactor literals', () => {
  const w = new SessionWatcher(tmp(healthy(40, 42000, 'g')), 42000);
  w.poll();
  const s = w.getStatus();
  assert.equal(s.baseline.dead, 42000);
  assert.equal(s.baseline.task, 27000);
  assert.equal(s.baseline.total, 69000);
  assert.equal(s.baseline.kneeTurn, 4);
  assert.ok(Math.abs(s.kAvg - 954.4444444444445) < 1e-6, `kAvg ${s.kAvg}`);
  assert.equal(s.apiCalls, 36);
  assert.ok(Math.abs(s.Lstar - 231304.24106186096) < 1e-3, `Lstar ${s.Lstar}`);
  assert.ok(Math.abs(s.paybackP - 0.4979710144927536) < 1e-9, `paybackP ${s.paybackP}`);
});

// ER-7: isRealKnee is a latch-gate INTERNAL (ensureLatchForPrefix's `if (!live.baseline.isRealKnee)
// continue`), never part of the /api/status.baseline contract. getStatus must NOT emit it (a client
// validating with additionalProperties:false would reject the response). RED pre-fix (isRealKnee IS in
// s.baseline today); GREEN post-fix. The latch gate keeps reading it off the INTERNAL live baseline.
test('ER-7: getStatus().baseline does NOT emit isRealKnee (latch-gate internal, not a public field)', () => {
  const w = new SessionWatcher(tmp(healthy(40)), null); // cold-start latches → applyFrozen path emits baseline
  w.poll();
  const s = w.getStatus();
  assert.ok(!('isRealKnee' in s.baseline), 'ER-7: isRealKnee is a latch internal, not emitted in /api/status.baseline');
  // the real baseline fields still present:
  assert.equal(typeof s.baseline.dead, 'number');
  assert.equal(typeof s.baseline.kneeTurn, 'number');
  // and the latch still fired (proves isRealKnee is still doing its internal job upstream).
  assert.ok(w._latchedBaseline.get(w._segment)?.entry, 'latched → isRealKnee still drove ensureLatchForPrefix internally');
});

// ── Latch helpers (unit) — assert the exported surface directly (GPT-plan-review #11) ──────────────
test('callIdentity resolves messageId / message.id / id, else null', () => {
  assert.equal(callIdentity({ messageId: 'a' }), 'a');
  assert.equal(callIdentity({ message: { id: 'b' } }), 'b');
  assert.equal(callIdentity({ id: 'c' }), 'c');
  assert.equal(callIdentity({}), null);
  assert.equal(callIdentity(null), null);
});

test('applyFrozen derives total from dead+taskCtx and never reads a stored total', () => {
  const b = applyFrozen({ dead: 42000, taskCtx: 13000, kneeTurn: 5, total: 999999 /* ignored */ });
  assert.equal(b.total, 55000, 'total = dead + taskCtx, not the bogus stored 999999');
  assert.equal(b.kneeTurn, 5);
  assert.equal(b.source, 'latched');
});

// ── Latch behavior ────────────────────────────────────────────────────────────────────────────────
// NOTE: append tests split ONE full session (unique ids m0..mN, monotonic cacheRead) at a byte
// boundary — never append a second healthy() batch, whose repeated ids would FOLD, not append.
// Every latch test uses a COLD-START watcher (null) — carried baselines don't latch (Global Constraints).
test('latch freezes L_base: appending more calls does NOT change baseline.dead/task/kneeTurn', () => {
  const lines = healthy(50).split('\n').filter(Boolean);
  const p = tmpPath();
  writeFileSync(p, lines.slice(0, 30).join('\n') + '\n');
  const w = new SessionWatcher(p, null); // cold-start: carried baselines don't latch (Global Constraints)
  w.poll();
  const a = w.getStatus().baseline;
  appendFileSync(p, lines.slice(30).join('\n') + '\n'); // the rest of the SAME session (unique ids)
  w.poll();
  const b = w.getStatus().baseline;
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'still one segment');
  assert.equal(b.dead, a.dead, 'dead frozen');
  assert.equal(b.task, a.task, 'taskCtx frozen');
  assert.equal(b.kneeTurn, a.kneeTurn, 'kneeTurn frozen');
});

test('frozen baseline total is derived (dead+task), and the entry stores no total', () => {
  const w = new SessionWatcher(tmp(healthy(40)), null);
  w.poll();
  const b = w.getStatus().baseline;
  assert.equal(b.total, b.dead + b.task, 'frozen total derived, not independently stored');
  const entry = w._latchedBaseline.get(w._segment)?.entry;
  assert.ok(entry, 'latched');
  assert.equal(entry.total, undefined, 'entry does not persist a total field (spec §2.2)');
});

test('kAvg still declines with tail dilution after latch (x* down-drift signal preserved)', () => {
  const w = new SessionWatcher(tmp(healthy(60)), null);
  w.poll();
  const h = w.getHistory();
  // After the latch point, on a decelerating tail kAvg is non-increasing between late points.
  const late = h.slice(-10);
  for (let i = 1; i < late.length; i++) {
    assert.ok(late[i].kAvg <= late[i - 1].kAvg + 1e-6, `kAvg not rising on stable tail at ${i}`);
  }
});

test('paybackP is monotonic non-decreasing from the latch point onward (monotone-L segment)', () => {
  const w = new SessionWatcher(tmp(healthy(50)), null);
  w.poll();
  w.getStatus(); // establish the latch on the current segment
  const seg = w._segment;
  const latchIndex = w._latchedBaseline.get(seg)?.entry?.latchIndex;
  assert.ok(Number.isInteger(latchIndex), 'segment is latched');
  // From the latch point on, L_base is frozen and effective-L is monotone (no L-drop) → paybackP
  // (= L/L_base − 1) is monotonic non-decreasing. This is THE bug the latch fixes (spec §0.1).
  const h = w.getHistory().filter(p => p.segment === seg);
  for (let i = latchIndex + 1; i < h.length; i++) {
    assert.ok(h[i].paybackP >= h[i - 1].paybackP - 1e-9, `paybackP dropped at ${i}: ${h[i-1].paybackP}→${h[i].paybackP}`);
  }
});

test('no-release: once latched, a later metricsReliable=false does NOT unfreeze and calibratingReason stays null', () => {
  const p = tmpPath();
  writeFileSync(p, healthy(30));
  const w = new SessionWatcher(p, null);
  w.poll();
  const before = w.getStatus();
  assert.equal(before.calibratingReason, null, 'latched → not calibrating');
  // Append rows that would collapse gField (claude cache_creation=0) → metricsReliable would go false.
  let bad = ''; let cr = w._calls.at(-1).cacheRead;
  for (let i = 0; i < 6; i++) { cr += 5; bad += line({ type: 'assistant', uuid: 'bad' + i, isSidechain: false, timestamp: 't',
    message: { id: 'bad' + i, model: 'claude-opus-4-8', usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }); }
  appendFileSync(p, bad);
  w.poll();
  const after = w.getStatus();
  assert.equal(after.baseline.dead, before.baseline.dead, 'baseline unchanged (no release)');
  assert.equal(after.baseline.task, before.baseline.task, 'taskCtx unchanged');
  assert.equal(after.calibratingReason, null, 'latched calibratingReason stays null despite metrics turning unreliable');
});

test('fallback knee (no real knee) does NOT latch: baseline stays live', () => {
  // ACCELERATING growth (delta doubles each call) on DEEPSEEK → detectKnee fallback (isRealKnee=false)
  // on EVERY prefix, so the isRealKnee guard is the SOLE latch-blocker. Two design points, both
  // verified against the current code:
  //  • CONSTANT deltas would NOT work — self-scaling bg makes equal deltas a REAL knee (isRealKnee=true);
  //    and a Claude cc=0 fixture would collapse metricsReliable→false, so the test would pass via
  //    'metrics_unreliable' and never actually exercise the fallback guard (a false-green).
  //  • Deepseek (input+output ≈ ΔL, lag-aligned) keeps metricsReliable TRUE and the gate otherwise
  //    passing (confidence 0.92, postKneeGrowthCalls ≥ 3, L > total) — so ONLY the missing real knee
  //    prevents the latch. That is what makes this a genuine fallback regression, not an accident.
  // 8 calls → delta ×2 keeps every prefix in fallback (a 9th would surface a real knee).
  let s = ''; let cr = 1000; let d = 3000; const crs = []; const deltas = [];
  for (let i = 0; i < 8; i++) { cr += d; crs.push(cr); deltas.push(d); d *= 2; }
  // lag-aligned gField: call i's input+output ≈ ΔL of the NEXT call, so metricsReliable stays healthy.
  for (let i = 0; i < crs.length; i++) { const g = deltas[i + 1] ?? deltas[deltas.length - 1];
    s += asst('m' + i, crs[i], Math.round(g * 0.6), Math.round(g * 0.4), 'deepseek-v4-pro'); }
  const p = tmpPath(); writeFileSync(p, s);
  const w = new SessionWatcher(p, null);
  w.poll();
  assert.equal(w.getStatus().metricsReliable, true, 'deepseek accel → metrics stay reliable (isRealKnee is the sole blocker)');
  const store = w._latchedBaseline.get(w._segment);
  assert.ok(!store || store.entry === null, 'no latch entry while only fallback knee exists');
});

test('carried baseline (--lbase set, confidence 0.6) does NOT latch (GPT-plan-review #1)', () => {
  // An injected dead → confidence 0.6 < BASELINE_CONF_MIN 0.75 → gate never passes → never latch.
  // This is intended (spec-faithful): a carried baseline already never hard-signals, so its L_base
  // jitter is cosmetic. Documents WHY every other latch test constructs cold-start (null).
  const w = new SessionWatcher(tmp(healthy(48)), 42000); // carried
  w.poll();
  const store = w._latchedBaseline.get(w._segment);
  assert.ok(!store || store.entry === null, 'carried baseline never latches');
  assert.ok(w.getStatus().calibratingReason != null, 'carried baseline is always calibrating (conf 0.6)');
});

test('L-drop opens a new segment which latches independently', () => {
  const p = tmpPath();
  writeFileSync(p, healthy(40, 42000, 'a'));
  const w = new SessionWatcher(p, null);
  w.poll();
  w.getStatus();
  const seg0 = w._segment;
  // /clear: total drops → new segment, then re-warm it (long enough to latch) with a FRESH id-prefix.
  appendFileSync(p, healthy(40, 6000, 'b'));
  w.poll();
  w.getStatus();
  assert.ok(w._segment > seg0, 'a new segment opened');
  // BOTH segments must latch, and with DIFFERENT fingerprints (GPT-plan-review #9 — the old
  // `has(seg0) || has(newSeg)` passed even if only the old segment ever latched).
  assert.ok(w._latchedBaseline.get(seg0)?.entry, 'old segment latched');
  assert.ok(w._latchedBaseline.get(w._segment)?.entry, 'new segment latched independently');
  assert.notEqual(w._latchedBaseline.get(seg0).entry.segmentStartCallId,
    w._latchedBaseline.get(w._segment).entry.segmentStartCallId, 'independent latch fingerprints');
});

// ── QF1: getStatus == getHistory last point, including the batch-poll earliest-latch case ──────────
test('QF1: getStatus baseline == cold getHistory last-point baseline (single poll, healthy)', () => {
  const w = new SessionWatcher(tmp(healthy(40)), null);
  w.poll();
  const s = w.getStatus();
  const last = w.getHistory().at(-1);
  assert.equal(last.L, s.L);
  assert.ok(Math.abs(last.Lstar - s.Lstar) < 1, `Lstar ${last.Lstar} ≈ ${s.Lstar}`);
  assert.ok(Math.abs(last.paybackP - s.paybackP) < 1e-6, 'paybackP agrees');
});

test('QF1 batch-poll: earliest-passing prefix is mid-segment, getStatus does NOT freeze the final prefix', () => {
  // The whole session arrives in ONE poll (server-startup reading a long transcript). getStatus must
  // scan for the earliest gate+realKnee prefix, not freeze the last one. Compare against getHistory
  // (which walks prefix-by-prefix and naturally hits the earliest).
  const w = new SessionWatcher(tmp(healthy(48)), null);
  w.poll(); // single batch poll
  const s = w.getStatus();
  const store = w._latchedBaseline.get(w._segment);
  assert.ok(store && store.entry, 'a latch entry exists');
  assert.ok(store.entry.latchIndex < w._calls.length - 1, 'latched at an EARLIER prefix, not the final one');
  const last = w.getHistory().at(-1);
  assert.equal(last.L, s.L, 'QF1 L agrees under batch poll');
  assert.ok(Math.abs(last.Lstar - s.Lstar) < 1, 'QF1 Lstar agrees under batch poll');
  // The frozen dead/task must be the EARLIEST-passing prefix's, which getHistory reaches by walking.
  assert.equal(s.baseline.dead, store.entry.dead, 'status baseline uses the frozen (earliest) dead');
  assert.equal(s.baseline.task, store.entry.taskCtx, 'status baseline uses the frozen (earliest) taskCtx');
});

test('getHistory does NOT mutate the instance _latchedBaseline store (store isolation)', () => {
  const w = new SessionWatcher(tmp(healthy(40)), null);
  w.poll();
  const before = w._latchedBaseline.size;
  w.getHistory(); // uses _historyCache.latchBySeg, must not touch instance store
  assert.equal(w._latchedBaseline.size, before, 'getHistory left the instance latch store untouched');
});

test('latch cache anti-pollution: a stale-fingerprint entry is discarded, not reused', () => {
  const w = new SessionWatcher(tmp(healthy(30)), null);
  w.poll();
  w.getStatus(); // establish the latch on the instance store (poll folds calls; getStatus latches)
  const seg = w._segment;
  const store = w._latchedBaseline.get(seg);
  assert.ok(store && store.entry, 'latched');
  const staleStartId = store.entry.segmentStartCallId;
  // Simulate segment-id reuse with a DIFFERENT first-call identity (e.g. after a replay/reset that
  // put unrelated content under the same numeric segment id).
  w._calls[0] = { ...w._calls[0], messageId: 'DIFFERENT_ID' };
  const seg0Calls = w._calls.filter(c => c.segment === seg);
  w._baselineAndKavg(seg0Calls, { latchStore: w._latchedBaseline });
  const after = w._latchedBaseline.get(seg).entry;
  // The stale entry (old fingerprint) must NOT be reused. A fresh scan either re-latches with the NEW
  // fingerprint or leaves entry null — never keeps the old segmentStartCallId.
  assert.notEqual(after?.segmentStartCallId, staleStartId, 'stale-fingerprint entry was not reused');
  if (after) assert.equal(after.segmentStartCallId, 'DIFFERENT_ID', 'any re-latch uses the new fingerprint');
});
