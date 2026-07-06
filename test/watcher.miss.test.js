// test/watcher.miss.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { effectiveL, classifyMiss } from '../lib/l-measure.js';

function line(o) { return JSON.stringify(o) + '\n'; }
// Independent control of cacheRead AND cacheCreation (a miss row = cacheRead 0, cacheCreation full).
function asst(id, cacheRead, cacheCreation, output = 10, model = 'claude-opus-4-8') {
  return line({ type: 'assistant', uuid: id + '_' + cacheRead + '_' + output, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: 2, output_tokens: output,
      cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead } } });
}
function tmp(text) { const p = join(mkdtempSync(join(tmpdir(), 'sw-miss-')), 's.jsonl'); writeFileSync(p, text); return p; }

// A rising Claude segment, then a MISS row (cacheRead 0, cacheCreation carries the full stock),
// then recovery (cacheRead back to the pre-miss stock). Signature per spec §0.2 / §3.1.1.
function buildWithMiss() {
  let s = '';
  s += asst('m0', 20000, 5000, 10);   // cold-start-ish (has some read already, not seg-first miss)
  s += asst('m1', 40000, 3000, 10);
  s += asst('m2', 80000, 2000, 10);   // peakRead now 80000, peakTotal now 82000
  s += asst('m3', 0, 82000, 10);      // MISS: read collapses, cc reconstructs full 82000 stock
  s += asst('m4', 82000, 2000, 10);   // recovery: read back to stock
  s += asst('m5', 83000, 2000, 10);
  return s;
}

// A2 fixture: the NEWEST call (seg[-1]) is the recovery row immediately after a miss (seg[-2]).
// Ends ON the recovery frame so the `growth` display stat's previous-call term reads the miss row.
function buildMissThenRecoveryLast() {
  let s = '';
  s += asst('m0', 20000, 5000, 10);
  s += asst('m1', 40000, 3000, 10);
  s += asst('m2', 80000, 2000, 10);   // peakRead 80000, peakTotal 82000
  s += asst('m3', 0, 82000, 10);      // MISS: read collapses, cc reconstructs 82000 stock → L 82000
  s += asst('m4', 83000, 2000, 10);   // recovery = NEWEST call, cr back up to 83000 (L 83000)
  return s;
}

// B2: a model-less miss row → gField = input + output (small), so ΔL[recovery] ≫ gField[miss].
function missLine(id, cc, out = 10) {
  return line({ type: 'assistant', uuid: id, isSidechain: false, timestamp: 't',
    message: { id, /* model omitted → gField = input + output */
      usage: { input_tokens: 2, output_tokens: out, cache_creation_input_tokens: cc, cache_read_input_tokens: 0 } } });
}

test('effectiveL prefers finite c.L, falls back to cacheRead, null-safe', () => {
  assert.equal(effectiveL({ L: 82000, cacheRead: 0 }), 82000);
  assert.equal(effectiveL({ cacheRead: 137000 }), 137000);        // no L field (old record)
  assert.equal(effectiveL({ L: undefined, cacheRead: 5 }), 5);
  assert.equal(effectiveL(null), 0, 'nullish record → 0, never throws');
  assert.equal(effectiveL({}), 0, 'no L and no cacheRead → 0');
});

test('classifyMiss: three structural criteria, provider-agnostic, cold-start excluded', () => {
  // read collapses, total stock preserved, established read peak → MISS (no provider arg at all)
  assert.equal(classifyMiss({ cacheRead: 0, cacheCreation: 82000, peakTotalBefore: 82000, peakReadBefore: 80000 }), true);
  // cold start: no established read peak → NOT a miss (免阈值排除, criterion 3)
  assert.equal(classifyMiss({ cacheRead: 0, cacheCreation: 18770, peakTotalBefore: 0, peakReadBefore: 0 }), false);
  // DeepSeek-shape (cc=0 → total==read → ratio 1) → criterion 1 fails structurally → NOT a miss.
  // No isClaude flag involved — the STRUCTURE (cc≡0) makes it a no-op.
  assert.equal(classifyMiss({ cacheRead: 32351, cacheCreation: 0, peakTotalBefore: 30000, peakReadBefore: 30000 }), false);
  // /clear: total ALSO drops below kept fraction → NOT a miss (criterion 2 fails)
  assert.equal(classifyMiss({ cacheRead: 0, cacheCreation: 3000, peakTotalBefore: 82000, peakReadBefore: 80000 }), false);
});

test('miss row: rec.L reconstructs stock, rec.miss true; normal rows L==cacheRead', () => {
  const w = new SessionWatcher(tmp(buildWithMiss()), null);
  w.poll();
  const miss = w._calls[3];
  assert.equal(miss.miss, true, 'idx3 detected as miss');
  assert.equal(miss.cacheRead, 0, 'raw cacheRead preserved on the record');
  assert.equal(miss.L, 82000, 'L reconstructed = cacheRead + cacheCreation');
  for (const i of [0, 1, 2, 4, 5]) {
    assert.equal(w._calls[i].miss, false, `idx${i} not a miss`);
    assert.equal(w._calls[i].L, w._calls[i].cacheRead, `idx${i} L==cacheRead`);
  }
});

test('miss row does NOT open a new segment', () => {
  const w = new SessionWatcher(tmp(buildWithMiss()), null);
  w.poll();
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'miss stays in one segment');
});

test('a real /clear (total also drops) segments, is NOT classified as miss', () => {
  let s = '';
  s += asst('m0', 40000, 3000, 10);
  s += asst('m1', 80000, 2000, 10);      // peakTotal 82000
  s += asst('m2', 0, 3000, 10);          // total 3000 << 0.7*82000 → NOT miss → segments
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  assert.equal(w._calls[2].miss, false, 'clear is not a miss');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 2, 'clear opened a new segment');
});

test('cold-start / segment-first row is never a miss (peakReadBefore==0)', () => {
  // First row of the session: read 0, cc large — this is cold start, MUST NOT reconstruct.
  const w = new SessionWatcher(tmp(asst('m0', 0, 18770, 10) + asst('m1', 18000, 2000, 10)), null);
  w.poll();
  assert.equal(w._calls[0].miss, false, 'cold start excluded with no absolute constant');
  assert.equal(w._calls[0].L, 0, 'cold-start L stays raw cacheRead (0), b anchor not poisoned');
});

test('DeepSeek (cacheCreation≡0) never classifies as miss — structural no-op', () => {
  let s = '';
  s += line({ type: 'assistant', uuid: 'd0', isSidechain: false, timestamp: 't',
    message: { id: 'd0', model: 'deepseek-v4-pro', usage: { input_tokens: 32351, output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 40000 } } });
  s += line({ type: 'assistant', uuid: 'd1', isSidechain: false, timestamp: 't',
    message: { id: 'd1', model: 'deepseek-v4-pro', usage: { input_tokens: 32351, output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }); // read 0 but cc 0 → ratio 1
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  assert.ok(w._calls.every(c => c.miss === false), 'no DeepSeek row is a miss');
});

test('miss detection is PROVIDER-AGNOSTIC: a renamed/rehosted model with the miss signature IS detected', () => {
  // User ruling: "claude 不能保证是孤例". A model string providerOf() does NOT map to 'claude'
  // (a Bedrock ARN, a future name) but WITH the real miss signature (read collapse + stock preserved +
  // established read peak) must still be reconstructed — no vendor-name gate.
  let s = '';
  s += asst('x0', 40000, 3000, 10, 'anthropic.claude-opus-4-8-v1:0'); // ARN-ish, unmatched by regex
  s += asst('x1', 80000, 2000, 10, 'anthropic.claude-opus-4-8-v1:0'); // peakRead 80000
  s += asst('x2', 0, 82000, 10, 'anthropic.claude-opus-4-8-v1:0');    // miss signature
  s += asst('x3', 82000, 2000, 10, 'anthropic.claude-opus-4-8-v1:0'); // recovery
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  assert.equal(w._calls[2].miss, true, 'miss signature detected regardless of vendor name');
  assert.equal(w._calls[2].L, 82000, 'stock reconstructed for the renamed model too');
});

test('model-LESS row with the miss signature is still detected (no provider dependence)', () => {
  // A row that OMITS model entirely: miss classification does not read `model` at all, so a genuine
  // miss signature is reconstructed. (Contrast the old plan, which fail-closed on missing provider;
  // that gate is gone — detection is structural.)
  let s = '';
  s += asst('c0', 40000, 3000, 10, 'claude-opus-4-8');
  s += asst('c1', 80000, 2000, 10, 'claude-opus-4-8'); // peakRead 80000
  s += line({ type: 'assistant', uuid: 'c2', isSidechain: false, timestamp: 't',
    message: { id: 'c2', /* model omitted */ usage: { input_tokens: 2, output_tokens: 10,
      cache_creation_input_tokens: 82000, cache_read_input_tokens: 0 } } });
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  assert.equal(w._calls[2].miss, true, 'model-less miss-signature row is detected structurally');
  assert.equal(w._calls[2].L, 82000, 'stock reconstructed');
});

test('miss rows are excluded from the metricsReliable probe', () => {
  // Build a healthy Claude session with one miss; probe must not see the miss ΔL spike.
  let s = ''; let cr = 42000;
  for (let i = 0; i < 20; i++) { cr += 940; s += asst('a' + i, cr, 940, 10); }
  s += asst('miss', 0, cr, 10);            // miss (read collapses, cc = full stock)
  for (let i = 0; i < 10; i++) { cr += 940; s += asst('b' + i, cr, 940, 10); }
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  // The presence of a miss must not flip an otherwise-reliable segment to unreliable.
  assert.equal(w.getStatus().metricsReliable, true, 'miss row excluded → probe stays healthy');
});

test('A2 growth stat: recovery-after-miss uses effectiveL(prev), not miss-row raw 0 (no L-0 phantom)', () => {
  // The NEWEST call is the recovery row immediately after a miss. The `growth` display stat's
  // previous-call term reads seg[-2] = the miss row (raw cacheRead 0). PRE-FIX it used raw
  // seg[-2].cacheRead (0) → growth = L - 0 = L (a one-frame phantom spike). POST-FIX it routes the
  // previous-call term through effectiveL(seg[-2]) = the reconstructed stock → a small, sane growth.
  const w = new SessionWatcher(tmp(buildMissThenRecoveryLast()), null);
  w.poll();
  const seg = w._currentSegmentCalls();
  const prev = seg[seg.length - 2];
  assert.equal(prev.miss, true, 'precondition: previous call is the miss row');
  assert.equal(prev.cacheRead, 0, 'precondition: miss row raw cacheRead is 0 (the phantom source)');
  assert.equal(effectiveL(prev), 82000, 'precondition: miss row effectiveL reconstructs the 82000 stock');
  const s = w.getStatus();
  assert.equal(s.L, 83000, 'sanity: current L is the recovery read');
  // POST-FIX: growth = max(0, L - effectiveL(prev)) = 83000 - 82000 = 1000 (NOT the L-0 = 83000 spike).
  assert.equal(s.growth, 1000, 'growth = L - effectiveL(prev miss) = 83000 - 82000');
  assert.notEqual(s.growth, s.L, 'growth is not the phantom L-0 spike (== L)');
});

test('B2 metricsReliable: small-gField miss row is EXCLUDED — recovery ΔL≫gField, exclusion load-bearing', () => {
  // A single well-aligned healthy pair, then a MODEL-LESS miss (gField = input+output = 12, tiny) and
  // its recovery. The recovery pair's ΔL (≈82000) dwarfs the miss row's gField → its residual ≈1.0.
  // With only ONE healthy pair surviving, WITHOUT the `seg[i].miss||seg[i-1].miss` exclusion the probe
  // sees rates [~0, ~1.0] → median ≈0.5 ≥ RESIDUAL_MAX(0.3) → metricsReliable FALSE. WITH the exclusion
  // the miss pair is dropped → the recovery outlier never enters → metricsReliable TRUE. (Contrast the
  // existing Claude-miss test whose gField = cc+output ≈ ΔL, so its residual is small either way —
  // vacuous: it passes with or without the exclusion.)
  let s = '';
  s += asst('e0', 40000, 39990, 10);   // claude warmup: gField = cc+out = 40000 (aligns with next ΔL 40000)
  s += asst('e1', 80000, 2000, 10);    // ΔL 40000 == prev gField → healthy pair; peakRead 80000, peakTotal 82000
  s += missLine('e2', 82000, 10);      // MODEL-LESS miss: cr 0, cc 82000 (stock kept) → gField = 2+10 = 12
  s += asst('e3', 82000, 2000, 10);    // recovery: cr back to 82000 → ΔL 82000 ≫ 12 → residual ≈ 1.0
  const w = new SessionWatcher(tmp(s), null);
  w.poll();
  assert.equal(w._calls[2].miss, true, 'precondition: model-less row classified as miss');
  assert.equal(w._calls[2].gField, 12, 'precondition: miss gField is input+output (12), NOT cc+output');
  assert.equal(w._calls.length, 4, 'sanity: 4 rows, one segment');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'sanity: all in one segment');
  assert.equal(w.getStatus().metricsReliable, true, 'small-gField miss excluded → probe stays healthy');
});

test('getHistory emits miss + raw cacheRead/cacheCreation passthrough', () => {
  const w = new SessionWatcher(tmp(buildWithMiss()), null);
  w.poll();
  const h = w.getHistory();
  const p = h[3];
  assert.equal(p.miss, true);
  assert.equal(p.cacheRead, 0, 'raw cacheRead passed through for tooltip');
  assert.equal(p.cacheCreation, 82000, 'raw cacheCreation passed through');
  assert.equal(p.L, 82000, 'L line uses reconstructed stock (no dip to 0)');
});

test('rotation/truncation resets _segmentMaxRead in lockstep — no stale-peak false miss', () => {
  // Task-1-review fix (pull-forward of a Task 5 line): the _readNewText rotation/truncation guard
  // must reset _segmentMaxRead alongside _segmentMaxTotal. Otherwise a legitimate post-rotation row
  // whose read is small vs the PRIOR segment's stale read peak (but NOT vs the fresh segment's true
  // peak) passes criterion 3 on a stale peakReadBefore and is misclassified as a miss.
  const dir = mkdtempSync(join(tmpdir(), 'sw-rot-'));
  const p = join(dir, 's.jsonl');
  // Pre-rotation segment (3 rows, deliberately LONGER in bytes) establishes read peak 80000.
  let pre = '';
  pre += asst('q0', 40000, 3000, 10);
  pre += asst('q1', 60000, 2000, 10);
  pre += asst('q2', 80000, 2000, 10);
  writeFileSync(p, pre);
  const w = new SessionWatcher(p, null);
  w.poll();
  assert.equal(w._segmentMaxRead, 80000, 'pre-rotation read peak established');
  // Truncate to a SHORTER file (size < prior offset) → rotation/truncation guard fires.
  let post = '';
  post += asst('r0', 30000, 5000, 10);   // fresh segment's TRUE read peak = 30000
  post += asst('r1', 20000, 30000, 10);  // read small vs STALE 80000 (crit3 stale) but NOT vs 30000
  writeFileSync(p, post);
  w.poll();
  const r1 = w._calls[w._calls.length - 1];
  assert.equal(r1.cacheRead, 20000, 'sanity: last record is the post-rotation r1 row');
  assert.equal(r1.miss, false, 'stale read peak must not survive rotation and force a false miss');
});
