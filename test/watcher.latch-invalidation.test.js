// test/watcher.latch-invalidation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { baselineFingerprint } from '../lib/latch.js';

function line(o) { return JSON.stringify(o) + '\n'; }
// Default model DEEPSEEK (GPT-plan-review #3): deepseek's lag-aligned input+output≈ΔL keeps
// metricsReliable healthy so the gate passes and the segment actually latches. A Claude default with
// cache_creation=0 would collapse gField → metricsReliable false → never latches (that's the "bad
// data" Task 4's no-release test deliberately appends, not what a healthy latch fixture wants).
function asst(id, cr, input, out, model = 'deepseek-v4-pro') {
  return line({ type: 'assistant', uuid: id + '_' + cr + '_' + out, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}
function tmpPath() { return join(mkdtempSync(join(tmpdir(), 'sw-inv-')), 's.jsonl'); }
function tmp(text) { const p = tmpPath(); writeFileSync(p, text); return p; } // GPT #1: was undefined

// Returns { text, finalCr } so an APPENDED batch can start at the true last cacheRead (GPT #4) —
// healthy(24)'s warmup deltas are large, so 42000 + 24*940 would UNDERSHOOT the real tail and trip an
// L-drop segmentation. `idPrefix` (GPT #2) keeps appended-batch ids unique so they append, not fold.
function healthy(n, startCr = 42000, idPrefix = 'm') {
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < n; i++) deltas.push(940);
  let s = ''; let cr = startCr;
  s += asst(idPrefix + '0', cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4));
  for (let t = 0; t < n; t++) { cr += deltas[t]; const g = deltas[t + 1] ?? 940;
    s += asst(idPrefix + (t + 1), cr, Math.round(g * 0.6), Math.round(g * 0.4)); }
  return { text: s, finalCr: cr };
}

// NOTE (GPT-plan-review #3, refined in final review): the oracle for a data-revision test is a FRESH
// watcher fed the same bytes — NOT the same watcher with `_historyCache = null`. A fresh watcher starts
// with an EMPTY `_latchedBaseline`/`_historyCache`, so it is an oracle for STALE LATCH/CACHE state:
// it verifies scoped latch clearing + QF1 under the DOCUMENTED idx-only cr/cc-rewrite semantics.
// It is NOT a "suffix replay" oracle — the fresh watcher, reading the late snapshot at end-of-file,
// still does an in-place update of the earlier `_calls[idx]` and does NOT replay idx+1.. segment/
// miss/peaks either (that suffix replay is the unreachable path we deliberately don't build). The
// tests below therefore only assert the reachable case (rewrite a NON-miss earlier row, monotone,
// no later classification flips).

test('H1 reuse: incremental getHistory equals a cold getHistory WITH latching active (same segment)', () => {
  // Cold-start baseline (null) so latching is active (carried baselines don't latch — Global
  // Constraints). Unique id-prefixes ('a' then 'b') so the appended batch APPENDS, never folds; the
  // second batch starts at the FIRST batch's real finalCr (rising, no L-drop → same segment).
  const first = healthy(24, 42000, 'a');
  const second = healthy(20, first.finalCr + 940, 'b'); // continues rising from the true tail
  const p = tmpPath();
  writeFileSync(p, first.text);
  const w = new SessionWatcher(p, null);
  w.poll();
  w.getHistory();                 // warm cache (latchBySeg populated)
  appendFileSync(p, second.text);
  w.poll();
  // Guard against silent regression: everything must be unique ids and ONE segment.
  assert.equal(new Set(w._calls.map(c => c.messageId)).size, w._calls.length, 'all ids unique → appended, not folded');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'rising stock → single segment (H1 latch reuse, not a boundary)');
  const incremental = w.getHistory();
  // Cold oracle: fresh watcher, same bytes, single getHistory.
  const wCold = new SessionWatcher(tmp(first.text + second.text), null);
  wCold.poll();
  const cold = wCold.getHistory();
  assert.deepEqual(incremental, cold, 'latched incremental history == cold rebuild (latch inherited through cache)');
});

test('in-place fold rewriting an earlier NON-miss cacheRead clears the latch; QF1 vs fresh replay', () => {
  // Rewrite an earlier NON-miss row's cacheRead UPWARD. This row is not a miss and stays not a miss;
  // no later row's miss classification depends on this peak flipping (see the documented limitation
  // below for the flip case). So idx-only miss recompute + scoped latch clear is provably sufficient,
  // and the fresh-replay oracle must match byte-for-byte.
  const text = healthy(30, 42000, 'a').text;
  const p = tmpPath();
  writeFileSync(p, text);
  const w = new SessionWatcher(p, null);
  w.poll();
  w.getStatus();                                    // latch established
  assert.ok(w._latchedBaseline.get(w._segment)?.entry, 'precondition: segment is latched');
  const foldIdx = 4;                                // a call BEFORE the latch point
  const target = w._calls[foldIdx];
  const next = w._calls[foldIdx + 1];
  assert.equal(target.miss, false, 'target row is not a miss (deepseek rising, cc 0)');
  // Late snapshot of that earlier call with a rewritten cacheRead → in-place fold (crCcChanged).
  // newCr = the MIDPOINT between this call's read and the next call's — derived entirely from the
  // fixture (NO magic constant), and since the fixture is strictly rising it is provably
  // target.cacheRead < newCr < next.cacheRead. That guarantees exactly what the test needs: (a) cr
  // actually changes (crCcChanged → scoped latch clear); (b) totalTok grows → the fold path fires;
  // (c) L stays monotone within the segment, so no spurious internal L-drop muddies whether a segment
  // boundary "should" move (irrelevant to what we test — idx-only recompute + latch clear).
  const newCr = Math.floor((target.cacheRead + next.cacheRead) / 2);
  const foldLine = asst(target.messageId, newCr, target.input, target.output);
  appendFileSync(p, foldLine);
  const revBefore = w._foldRev;
  w.poll();
  assert.ok(w._foldRev > revBefore, 'in-place cr rewrite bumped _foldRev');
  const s = w.getStatus();
  // Fresh replay oracle: a brand-new watcher fed the SAME bytes (incl. the fold line) recomputes the
  // entire forward fold — the authoritative result (GPT #3).
  const wFresh = new SessionWatcher(tmp(text + foldLine), null);
  wFresh.poll();
  const fresh = wFresh.getHistory().at(-1);
  assert.equal(fresh.L, s.L, 'QF1 L holds after in-place fold + latch clear (vs fresh replay)');
  assert.ok(Math.abs(fresh.Lstar - s.Lstar) < 1, 'QF1 Lstar holds after in-place fold + latch clear');
  // The affected segment's instance latch entry was cleared and re-scanned.
  assert.ok(w._latchedBaseline.get(w._segment)?.entry, 're-latched after the scoped clear');
});

test('in-place fold (even output-only) clears+rescans the latch so both stores stay in sync (ER-1)', () => {
  const p = tmpPath();
  writeFileSync(p, healthy(30).text);
  const w = new SessionWatcher(p, null);
  w.poll();
  const before = w.getStatus().baseline;
  // ER-1: an output-only fold bumps _foldRev, which forces getHistory to REBUILD its latchBySeg on the
  // (gField-perturbed) sequence. The getStatus instance store MUST re-scan the SAME sequence or the two
  // stores can freeze different prefixes → QF1 breaks. So an accepted in-place fold (even output-only)
  // now clears+rescans _latchedBaseline. The re-scan on the UNCHANGED cacheRead sequence re-derives
  // identical dead/task (still worth asserting), but builds a FRESH entry object literal — so
  // `!== entryBefore` is the discriminator that the clear+rescan fired (it stays === under the OLD
  // guarded-clear behavior, which is exactly the RED this inversion asserts against).
  const stateBefore = w._latchedBaseline.get(w._segment);
  assert.ok(stateBefore?.entry, 'precondition: segment is latched before the output-only fold');
  const entryBefore = stateBefore.entry;
  const fpBefore = baselineFingerprint(entryBefore);
  const target = w._calls[4];
  appendFileSync(p, asst(target.messageId, target.cacheRead, target.input, target.output + 500)); // only output grows
  w.poll();
  const after = w.getStatus().baseline;
  assert.equal(after.dead, before.dead, 'output-only re-scan re-derives identical dead (unchanged cacheRead seq)');
  assert.equal(after.task, before.task, 'output-only re-scan re-derives identical taskCtx');
  // FU-B1-coupling: assert the re-scan produced a baseline-EQUIVALENT entry by VALUE (fingerprint),
  // not by object identity — an output-only fold clears+rescans but must re-derive the SAME baseline.
  // Value-level survives a future mutate-and-reuse optimization (same object mutated in place), which
  // an object-identity `notStrictEqual` discriminator would spuriously fail.
  const stateAfter = w._latchedBaseline.get(w._segment);
  assert.ok(stateAfter?.entry, 're-latched after the scoped clear (segment still latched)');
  assert.equal(baselineFingerprint(stateAfter.entry), fpBefore,
    'output-only fold re-scans but re-derives the SAME baseline (value-level, not identity)');
});

test('ER-1 QF1: output-only fold into early calls keeps getStatus + getHistory latch stores in sync', () => {
  // The desync the ER-1 fix closes. Establish the latch on the INSTANCE store first (getStatus), then
  // fold LARGE outputs into SEVERAL early calls (cr/cc unchanged → output-only folds). Each fold bumps
  // _foldRev, so getHistory FULL-REBUILDS its latchBySeg on the gField-perturbed sequence and re-scans
  // for the earliest gate-passing prefix — while (pre-fix) getStatus kept its OLD frozen entry. A
  // single early fold's perturbation is absorbed by _metricsReliable's median, so we fold into idx
  // {1,2,3,5,6} (the controller's proven probe): pre-fix this moved getHistory's latchIndex 7→11 while
  // getStatus stayed at 7. Post-fix the instance store is cleared on every accepted fold → both re-scan
  // the same sequence → same latchIndex. This test is RED pre-fix on the gIdx===hIdx assertion.
  const p = tmpPath();
  writeFileSync(p, healthy(40).text);
  const w = new SessionWatcher(p, null);
  w.poll();
  w.getStatus();                                    // establish the instance-store latch
  const gIdx0 = w._latchedBaseline.get(w._segment).entry.latchIndex;
  assert.ok(Number.isInteger(gIdx0), 'precondition: segment latched on the instance store');
  const revBefore = w._foldRev;
  // Output-only folds into several EARLY calls (before the latch point).
  for (const i of [1, 2, 3, 5, 6]) {
    const t = w._calls[i];
    appendFileSync(p, asst(t.messageId, t.cacheRead, t.input, t.output + 300000)); // cr/cc unchanged
  }
  w.poll();
  assert.ok(w._foldRev > revBefore, 'output-only folds bumped _foldRev');
  const s = w.getStatus();
  const last = w.getHistory().at(-1);
  // QF1: the two stores must agree on the observable baseline-derived outputs.
  assert.equal(last.L, s.L, 'ER-1 QF1: L agrees after output-only fold');
  assert.ok(Math.abs(last.Lstar - s.Lstar) < 1e-6, 'ER-1 QF1: Lstar agrees (both stores froze the same prefix)');
  assert.ok(Math.abs(last.kAvg - s.kAvg) < 1e-6, 'ER-1 QF1: kAvg agrees');
  // The direct desync check — the load-bearing RED assertion. Pre-fix: gIdx 7 vs hIdx 11.
  const gIdx = w._latchedBaseline.get(w._segment).entry.latchIndex;
  const hIdx = w._historyCache.latchBySeg.get(w._segment).entry.latchIndex;
  assert.equal(gIdx, hIdx, 'ER-1: getStatus + getHistory latch at the SAME prefix after an output-only fold');
});

test('in-place cr/cc rewrite is provider-agnostic: a model-less miss-shaped fold IS reclassified miss', () => {
  // A later same-message.id snapshot OMITS model AND rewrites cr/cc into a miss shape. Detection does
  // NOT read model (spec §3.7 revised — no provider gate), so the rewritten record reclassifies to
  // miss=true with reconstructed L, identically to the new-call path. (Rewriting call index 2, whose
  // stored peaks-before come from the k0/k1 reads, so criteria 2/3 hold.)
  let s = '';
  s += asst('k0', 40000, 3000, 10, 'claude-opus-4-8');
  s += asst('k1', 80000, 2000, 10, 'claude-opus-4-8'); // peakRead 80000, peakTotal 82000
  s += asst('k2', 83000, 2000, 10, 'claude-opus-4-8'); // will be rewritten into a miss shape
  const p = tmpPath();
  writeFileSync(p, s);
  const w = new SessionWatcher(p, null);
  w.poll();
  const idx = 2;
  const foldLine = line({ type: 'assistant', uuid: 'k2_refold', isSidechain: false, timestamp: 't',
    message: { id: 'k2', /* model omitted */ usage: { input_tokens: 2, output_tokens: 999,
      cache_creation_input_tokens: 85000, cache_read_input_tokens: 0 } } }); // read collapse, stock kept
  appendFileSync(p, foldLine);
  w.poll();
  assert.equal(w._calls[idx].miss, true, 'model-less fold reclassified by structure, not vendor name');
  assert.equal(w._calls[idx].L, 85000, 'stock reconstructed (cr 0 + cc 85000)');
});

test('rotation/truncation reset clears _latchedBaseline and _segmentMaxRead', () => {
  const p = tmpPath();
  writeFileSync(p, healthy(30).text);
  const w = new SessionWatcher(p, null);
  w.poll();
  w.getStatus(); // establish the latch: poll() only folds; the latch is lazy on getStatus/getHistory (cf. test 2)
  assert.ok(w._latchedBaseline.size > 0, 'latched before rotation');
  assert.ok(w._segmentMaxRead > 0, 'read peak set before rotation');
  writeFileSync(p, healthy(8).text); // shrink → size < offset → rotation guard fires on next poll
  w.poll();
  // After rotation the latch map must not carry a stale entry keyed to a pre-rotation segment id that
  // collides with the new segment. The new segment re-calibrates from scratch.
  const newSeg = w._segment;
  const state = w._latchedBaseline.get(newSeg);
  assert.ok(!state || state.entry === null || state.scannedThrough <= w._calls.filter(c => c.segment === newSeg).length,
    'no stale latch survives rotation into the new segment');
});
