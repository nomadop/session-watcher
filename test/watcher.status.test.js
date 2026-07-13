import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { lStar } from '../lib/metrics.js';
import { contextWindowFor } from '../lib/extract.js';
import { RESERVED_OUTPUT, CTX_SAFETY_MARGIN } from '../lib/constants.js';

function line(o) { return JSON.stringify(o) + '\n'; }
function asst(id, cr, input, out) {
  return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'deepseek-v4-pro', usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}
// Same row shape as asst() but with an explicit model — used by the #9 cap tests, which pick a
// small-window vehicle (claude-sonnet-4-6, Lcap 160000) to exercise the context cap binding
// WITHOUT coupling to any model whose window constant might change (e.g. deepseek is now 1M).
function asstM(id, cr, input, out, model) {
  return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}

// deepseek: on real data, tokens SENT in round t-1 (input+output) become the cache stock read in
// round t, so gField[t-1] ≈ ΔL[t]. Emit each row with input+output sized to the NEXT round's ΔL
// so the lag-aligned metricsReliable probe sees ~0 residual (healthy).
function buildSession() {
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];   // warmup
  for (let i = 0; i < 40; i++) deltas.push(940);         // stable
  let s = ''; let cr = 42000; let id = 0;
  // row t carries input+output ≈ deltas[t] (the growth it will cause next round); split ~60/40.
  s += asst('m' + id++, cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4)); // seed row at dead bottom
  for (let t = 0; t < deltas.length; t++) {
    cr += deltas[t];
    const nextGrowth = deltas[t + 1] ?? 940;
    s += asst('m' + id++, cr, Math.round(nextGrowth * 0.6), Math.round(nextGrowth * 0.4));
  }
  return { text: s, finalL: cr };
}

function tmp(text) { const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl'); writeFileSync(p, text); return p; }

test('getStatus emits full Status JSON with correct L and L* relationship', () => {
  const { text, finalL } = buildSession();
  const w = new SessionWatcher(tmp(text), 42000);
  w.poll();
  const s = w.getStatus();
  assert.equal(s.L, finalL);
  assert.ok(s.baseline.total > 42000, 'task ctx folded into baseline');
  assert.ok(s.kAvg > 0);
  // L* uses k_avg post-knee; recompute and compare
  assert.ok(Math.abs(s.Lstar - lStar(s.baseline.total, 50, s.kAvg)) < 1);
  assert.equal(s.Lthreshold, Math.min(s.Lstar, s.Lcap));
  assert.equal(typeof s.restart, 'boolean');
  assert.equal(s.metricsReliable, true, 'deepseek input+output≈ΔL → reliable');
});

// Task 10 (ER-2): the kFit extrapolation chain is retired. getStatus MUST NO LONGER emit
// LstarFit / kFitSlope / etaCalls — burnRate/hBreak (rate-lamp) own the "rounds-remaining /
// extrapolation" role now, and §17.3 forbids surfacing rounds-remaining on a plateau. RED before
// the production deletion (all three fields present today), GREEN after.
test('Task 10 (ER-2): getStatus no longer emits LstarFit / kFitSlope / etaCalls', () => {
  const w = new SessionWatcher(tmp(buildSession().text), 42000);
  w.poll();
  const s = w.getStatus();
  assert.equal('LstarFit' in s, false, 'LstarFit retired from the Status contract');
  assert.equal('kFitSlope' in s, false, 'kFitSlope retired from the Status contract');
  assert.equal('etaCalls' in s, false, 'etaCalls retired from the Status contract');
  assert.equal(s.etaCalls, undefined, 'etaCalls is undefined (not just null)');
});

test('phi = 1 + paybackP/(1+rho) holds in assembled status', () => {
  const w = new SessionWatcher(tmp(buildSession().text), 42000);
  w.poll();
  const s = w.getStatus();
  assert.ok(Math.abs(s.phi - (1 + s.paybackP / (1 + s.rho))) < 1e-6);
});

test('restart fires with a reason once past the gate; empty data does NOT restart', () => {
  // Empty watcher → must NOT restart (gate blocks L=0,Lstar=0 trivial crossing).
  const empty = new SessionWatcher(tmp(''), 10000);
  empty.poll();
  const es = empty.getStatus();
  assert.equal(es.restart, false, 'no data → no hard restart');
  assert.ok(es.calibratingReason, 'empty data reports a calibratingReason');

  // High-growth segment past warmup → crosses L* and passes the credibility gate.
  let s = ''; let cr = 10000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 20000; s += asst('m' + id++, cr, 12000, 8000); } // input+output≈ΔL
  const w = new SessionWatcher(tmp(s), 10000);
  w.poll();
  const st = w.getStatus();
  assert.equal(st.metricsReliable, true, 'lag-aligned residual healthy');
  if (st.restart) assert.ok(['cost', 'context_cap'].includes(st.restartReason));
  else assert.ok(st.calibratingReason, 'if not restarting, a calibratingReason explains why');
});

test('metricsReliable=false when Claude cache_creation is zeroed (field moved away)', () => {
  // Claude model but cache_creation forced to 0 and input≈2 → gField collapses, residual explodes.
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) {
    cr += 2446;
    s += line({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: 't',
      message: { id: 'm' + id++, model: 'claude-opus-4-8', usage: {
        input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
  }
  const w = new SessionWatcher(tmp(s), 42000);
  w.poll();
  assert.equal(w.getStatus().metricsReliable, false);
});

test('getHistory returns one point per folded call with segment tags', () => {
  const w = new SessionWatcher(tmp(buildSession().text), 42000);
  w.poll();
  const h = w.getHistory();
  assert.ok(h.length > 10);
  assert.ok(h.every(p => typeof p.L === 'number' && typeof p.segment === 'number'));
});

// QF1: getStatus and getHistory now share one per-point metrics pipeline (_baselineAndKavg), so the
// current segment's LAST history point must agree with getStatus on L* and kAvg. This locks the
// shared-source contract even for single-model sessions; against the old per-call-cRatio getHistory
// it would diverge the moment the model changed mid-segment (see next test).
test('getHistory last point AGREES with getStatus on Lstar and kAvg (shared pipeline)', () => {
  const w = new SessionWatcher(tmp(buildSession().text), 42000);
  w.poll();
  const s = w.getStatus();
  const last = w.getHistory().at(-1);
  assert.equal(last.segment, s.segment, 'last history point is in the current segment');
  assert.equal(last.L, s.L, 'same L at the current segment tip');
  assert.ok(Math.abs(last.Lstar - s.Lstar) < 1, `history L* ${last.Lstar} ≈ status L* ${s.Lstar}`);
  assert.ok(Math.abs(last.kAvg - s.kAvg) < 1e-6, `history kAvg ${last.kAvg} ≈ status kAvg ${s.kAvg}`);
});

// QF1 drift proof: C_RATIO is LOCKED at segment creation. A mid-segment model switch (deepseek→claude,
// ratio 50→10) must NOT change the ratio the chart uses — getHistory must use the model locked at the
// segment's first call (deepseek/50), matching getStatus. The old per-call cRatioFor(c.model) would
// have used claude/10 for the tail, making the final history L* diverge from the status L*.
test('getHistory uses the SEGMENT-LOCKED model for cRatio, not the per-call model', () => {
  function asstM(id, cr, input, out, model) {
    return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id, model, usage: {
        input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
  }
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 0; i < 40; i++) deltas.push(940);
  let s = ''; let cr = 42000; let id = 0;
  // Single segment (cacheRead only ever grows). First call = deepseek (locks ratio 50); switch the
  // model to claude at the halfway mark — same rising cacheRead, only the reported model changes.
  const modelAt = (t) => (t < deltas.length / 2 ? 'deepseek-v4-pro' : 'claude-opus-4-8');
  s += asstM('m' + id++, cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4), modelAt(0));
  for (let t = 0; t < deltas.length; t++) {
    cr += deltas[t];
    const nextGrowth = deltas[t + 1] ?? 940;
    s += asstM('m' + id++, cr, Math.round(nextGrowth * 0.6), Math.round(nextGrowth * 0.4), modelAt(t + 1));
  }
  const w = new SessionWatcher(tmp(s), 42000);
  w.poll();
  const st = w.getStatus();
  const last = w.getHistory().at(-1);
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'all one segment (no L-drop)');
  assert.equal(st.model, 'deepseek-v4-pro', 'status locked the first-call model');
  // Segment-locked ratio (deepseek=50) → the two must still agree despite the mid-segment switch.
  assert.ok(Math.abs(last.Lstar - st.Lstar) < 1, `segment-locked history L* ${last.Lstar} ≈ status L* ${st.Lstar}`);
  // Prove it is NOT the per-call (claude=10) ratio: that would give a strictly smaller L*.
  assert.ok(Math.abs(last.Lstar - lStar(st.baseline.total, 10, last.kAvg)) > 1,
    'history L* is NOT computed with the per-call claude ratio (10)');
});

// ── #9: getHistory must emit Lthreshold = min(Lstar, Lcap) per point ───────────────────────────
// claude-sonnet-4-6 window = 200k → Lcap = 200000 - RESERVED_OUTPUT - CTX_SAFETY_MARGIN = 160000.
// A steep, long-growth segment drives Lstar above 160000, so the CONTEXT CAP binds (Lcap < Lstar)
// and Lthreshold must equal Lcap, NOT Lstar. This is the whole point of #9: the chart's decision
// line has to match the capped statusbar decision. Vehicle is claude-sonnet-4-6 (a small-window
// model, NOT a constant we ever change) so the test never re-couples to a mutable window value.
test('#9 getHistory emits Lthreshold=min(Lstar,Lcap) per point; cap binds so Lthreshold<Lstar', () => {
  // Steep growth (30k/call) over many calls on a 200k-window model → Lstar > Lcap once past warmup.
  let s = ''; let cr = 10000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 30000; s += asstM('m' + id++, cr, 12000, 8000, 'claude-sonnet-4-6'); }
  const w = new SessionWatcher(tmp(s), 10000);
  w.poll();
  const h = w.getHistory();
  const Lcap = contextWindowFor('claude-sonnet-4-6') - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;
  assert.equal(Lcap, 160000, 'claude-sonnet-4-6 Lcap = 200000-32000-8000');
  // Every point: Lthreshold field present and exactly min(Lstar, Lcap).
  for (const p of h) {
    assert.equal(typeof p.Lthreshold, 'number', 'each history point carries a numeric Lthreshold');
    assert.equal(typeof p.Lstar, 'number', 'Lstar field is KEPT alongside Lthreshold');
    assert.equal(p.Lthreshold, Math.min(p.Lstar, Lcap), 'Lthreshold === min(Lstar, Lcap) per point');
  }
  // In the capped regime the tail points must actually be capped (Lthreshold < Lstar), proving the
  // min() is not a no-op tautology.
  const capped = h.filter(p => p.Lthreshold < p.Lstar);
  assert.ok(capped.length > 0, 'at least some points are genuinely capped (Lcap < Lstar)');
  assert.ok(h.at(-1).Lthreshold < h.at(-1).Lstar, 'final point is capped: Lthreshold < Lstar');
  assert.equal(h.at(-1).Lthreshold, Lcap, 'final capped point pins Lthreshold to Lcap');
});

// #9 history↔status agreement (QF1 invariant extended to Lthreshold): the LAST point of the
// current segment must equal getStatus().Lthreshold exactly, in the capped regime.
test('#9 history last-point Lthreshold === getStatus().Lthreshold (capped regime)', () => {
  let s = ''; let cr = 10000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 30000; s += asstM('m' + id++, cr, 12000, 8000, 'claude-sonnet-4-6'); }
  const w = new SessionWatcher(tmp(s), 10000);
  w.poll();
  const st = w.getStatus();
  const last = w.getHistory().at(-1);
  assert.equal(last.segment, st.segment, 'last history point is in the current segment');
  assert.ok(st.Lcap < st.Lstar, 'sanity: cap binds in getStatus too');
  assert.equal(last.Lthreshold, st.Lthreshold, 'history tip Lthreshold agrees with status Lthreshold');
});

// #9 uses the SEGMENT-LOCKED model for Lcap (same model getHistory uses for cRatio). The segment's
// first call is claude-sonnet-4-6 (window 200k → Lcap 160000); a mid-segment switch to a LARGER
// window model, claude-opus-4-8 (window 1M), must NOT lift the cap. If getHistory wrongly used the
// per-call model, the opus tail would compute Lcap = 960000 (never binding) and Lthreshold would
// jump to Lstar. (Small→large window pair; the locked small window must win.)
test('#9 Lcap uses the segment-locked model, not the per-call model', () => {
  let s = ''; let cr = 10000; let id = 0;
  // First call claude-sonnet-4-6 (locks window 200k/Lcap 160000); switch to claude-opus-4-8 (1M
  // window) at the halfway mark. Same rising cacheRead; the tail window would be 1M if the per-call
  // model leaked in.
  const N = 30;
  for (let i = 0; i < N; i++) {
    cr += 30000;
    const model = i < N / 2 ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
    s += asstM('m' + id++, cr, 12000, 8000, model);
  }
  const w = new SessionWatcher(tmp(s), 10000);
  w.poll();
  const lockedLcap = contextWindowFor('claude-sonnet-4-6') - RESERVED_OUTPUT - CTX_SAFETY_MARGIN; // 160000
  const last = w.getHistory().at(-1);
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'all one segment (no L-drop)');
  assert.equal(last.Lthreshold, Math.min(last.Lstar, lockedLcap),
    'Lcap resolved from the segment-locked claude-sonnet model → 160000');
  assert.equal(last.Lthreshold, lockedLcap, 'capped to the segment-locked claude-sonnet Lcap (160000), NOT the 1M tail window');
});

// ── #13: distinct no_transcript calibrating reason for a missing/never-openable path ────────────
test('#13 nonexistent transcript path → poll() no-throw, calibratingReason=no_transcript, restart=false', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'sw-')), 'does-not-exist.jsonl');
  const w = new SessionWatcher(missing); // NO injectedDead (a bad path is not a carried baseline)
  assert.doesNotThrow(() => w.poll(), 'poll must not throw on a missing path');
  const s = w.getStatus();
  assert.equal(s.calibratingReason, 'no_transcript', 'never-openable path → no_transcript');
  assert.equal(s.restart, false, 'no_transcript never restarts');
});

// The distinction that is the whole point of #13: an existing-but-EMPTY file is legitimate warmup,
// NOT no_transcript. Once the path is openable, it must fall back to insufficient_data.
test('#13 existing-but-EMPTY transcript → insufficient_data (NOT no_transcript)', () => {
  const w = new SessionWatcher(tmp('')); // empty file, no injectedDead
  assert.doesNotThrow(() => w.poll());
  const s = w.getStatus();
  assert.equal(s.calibratingReason, 'insufficient_data', 'empty-but-present file is warmup, not no_transcript');
});

// no_transcript clears the instant the file becomes readable with real calls.
test('#13 real calls → no_transcript cleared (data-driven reason or null)', () => {
  const w = new SessionWatcher(tmp(buildSession().text), 42000);
  w.poll();
  const s = w.getStatus();
  assert.notEqual(s.calibratingReason, 'no_transcript', 'a seen transcript is never no_transcript');
});

// A file that does not exist at first poll but APPEARS later: once successfully opened+read, the
// no_transcript flag must not revert (flag-on-first-successful-open, robust to late-appearing files).
test('#13 late-appearing transcript → no_transcript sticks off once seen', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 'later.jsonl');
  const w = new SessionWatcher(p, 42000);
  w.poll(); // path missing now
  assert.equal(w.getStatus().calibratingReason, 'no_transcript', 'missing at first poll → no_transcript');
  writeFileSync(p, buildSession().text); // file appears
  w.poll();
  assert.notEqual(w.getStatus().calibratingReason, 'no_transcript', 'once the file is read, no_transcript is gone');
});
