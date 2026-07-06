import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

// ── Task 2 (H1): getHistory per-instance memoization ─────────────────────────────────────────────
// These tests are the EQUIVALENCE ORACLE for the O(n²·log n) → O(n) memoization: a cache-warmed,
// incrementally-polled watcher MUST emit a byte-identical history array to a fresh watcher fed the
// same data in one shot (a cold getHistory == today's proven full-rebuild code path). Plus the three
// invalidation hazards (in-place fold, fitWindow change, truncation/length-shrink) each force a full
// rebuild rather than silently serving a stale prefix.

function line(o) { return JSON.stringify(o) + '\n'; }
function asst(id, cr, input, out, model = 'deepseek-v4-pro') {
  return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}
function asstOf(o) { return asst(o.id, o.cr, o.input, o.out, o.model); }
function textOf(calls) { return calls.map(asstOf).join(''); }
function tmp(text) { const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl'); writeFileSync(p, text); return p; }
function tmpPath() { return join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl'); }

// Single segment (cacheRead only ever rises): warmup deltas then a stable tail. Each row carries
// input+output ≈ the NEXT round's ΔL (healthy lag-aligned residual, same shape as buildSession).
function makeCalls(n, startCr = 42000) {
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < n; i++) deltas.push(940);
  const calls = []; let cr = startCr;
  for (let i = 0; i < n; i++) {
    cr += deltas[i];
    const next = deltas[i + 1] ?? 940;
    calls.push({ id: 'm' + i, cr, input: Math.round(next * 0.6), out: Math.round(next * 0.4) });
  }
  return calls;
}

// ── (1) Equivalence under incremental polls ──────────────────────────────────────────────────────
test('H1 cache: incremental polls produce byte-identical history to a fresh one-shot watcher', () => {
  const calls = makeCalls(48);
  const half = Math.floor(calls.length / 2);

  // Incremental: warm the cache on the first half, then append + re-poll + getHistory again.
  const pInc = tmpPath();
  writeFileSync(pInc, textOf(calls.slice(0, half)));
  const wInc = new SessionWatcher(pInc, 42000);
  wInc.poll();
  wInc.getHistory();                                   // warms the cache
  appendFileSync(pInc, textOf(calls.slice(half)));
  wInc.poll();
  const incremental = wInc.getHistory();               // reuse-prefix + tail path

  // Fresh: one watcher fed everything at once (cold getHistory = today's full-rebuild oracle).
  const wFresh = new SessionWatcher(tmp(textOf(calls)), 42000);
  wFresh.poll();
  const fresh = wFresh.getHistory();

  assert.deepEqual(incremental, fresh, 'memoized incremental history must equal a fresh full recompute');
  assert.equal(incremental.length, calls.length, 'one point per folded call');
});

test('H1 cache: repeated getHistory calls with no new data are stable and equal a fresh recompute', () => {
  const calls = makeCalls(30);
  const w = new SessionWatcher(tmp(textOf(calls)), 42000);
  w.poll();
  const a = w.getHistory();
  const b = w.getHistory();                             // second call: pure cache hit, zero tail
  const fresh = (() => { const f = new SessionWatcher(tmp(textOf(calls)), 42000); f.poll(); return f.getHistory(); })();
  assert.deepEqual(a, fresh);
  assert.deepEqual(b, fresh, 'a pure cache hit still equals a fresh recompute');
});

// ── (2) Fold invalidation ────────────────────────────────────────────────────────────────────────
test('H1 cache: an in-place fold of an EARLIER call invalidates that point AND all later points', () => {
  const calls = makeCalls(48);
  const foldIdx = 5;                                   // mutate a call with ~42 later points after it

  // Warm the cache on the original session.
  const p = tmpPath();
  writeFileSync(p, textOf(calls));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  const before = w.getHistory();                       // warms cache (cachedCount = 48, foldRev snapshot)

  // Late snapshot of an EARLIER call with a higher cacheRead → folds in place (isNew=false, changed).
  const foldLine = asst(calls[foldIdx].id, calls[foldIdx].cr + 25000, calls[foldIdx].input, calls[foldIdx].out);
  appendFileSync(p, foldLine);
  w.poll();
  const after = w.getHistory();

  // Oracle: a fresh watcher fed EVERY line including the fold folds identically → authoritative.
  const wFresh = new SessionWatcher(tmp(textOf(calls) + foldLine), 42000);
  wFresh.poll();
  const fresh = wFresh.getHistory();

  assert.deepEqual(after, fresh, 'post-fold history equals a fresh full recompute (no stale cached prefix)');
  // Prove the fold actually changed the mutated point (guards against a no-op test).
  assert.notDeepEqual(after[foldIdx], before[foldIdx], 'the folded call\'s own point changed');
  assert.notDeepEqual(after.at(-1), before.at(-1), 'a LATER point in the same segment also changed');
});

// ── (3) fitWindow change invalidation ────────────────────────────────────────────────────────────
test('H1 cache: changing fitWindow rebuilds; each fitWindow equals a fresh watcher at that window', () => {
  const calls = makeCalls(48);
  const w = new SessionWatcher(tmp(textOf(calls)), 42000);
  w.poll();

  const h10 = w.getHistory(10);
  const h40 = w.getHistory(40);                         // different window → must NOT reuse the fw=10 cache
  const h10again = w.getHistory(10);                    // flip back → must NOT reuse the fw=40 cache

  const fresh = (fw) => { const f = new SessionWatcher(tmp(textOf(calls)), 42000); f.poll(); return f.getHistory(fw); };
  assert.deepEqual(h10, fresh(10), 'fitWindow=10 equals a fresh fw=10 recompute');
  assert.deepEqual(h40, fresh(40), 'fitWindow=40 equals a fresh fw=40 recompute');
  assert.deepEqual(h10again, fresh(10), 'flipping fitWindow back rebuilds correctly');
  assert.notDeepEqual(h10, h40, 'the two windows genuinely differ (kFitSlope tail width)');
});

// ── (4a) Rotation/truncation via the public poll() API ───────────────────────────────────────────
// _calls is append-only, so a rotation resets _offset/_segment/_byId and re-folds from 0 into a NEW
// segment. The cached prefix (old segment, unchanged calls) stays valid; new calls append. Result
// must equal a watcher that replayed the same file states but only computed history at the end.
test('H1 cache: rotation (file shrinks → re-read into a new segment) equals a fresh replay', () => {
  const big = makeCalls(30);
  const small = makeCalls(12);                          // fewer bytes than `big` → size < offset → rotation

  const p = tmpPath();
  writeFileSync(p, textOf(big));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  w.getHistory();                                       // warm on the pre-rotation content
  writeFileSync(p, textOf(small));                      // shrink → next poll rotates (segment++)
  w.poll();
  const rotated = w.getHistory();

  // Oracle: identical poll sequence, but getHistory only ONCE at the end (cold full rebuild).
  const pB = tmpPath();
  writeFileSync(pB, textOf(big));
  const wB = new SessionWatcher(pB, 42000);
  wB.poll();
  writeFileSync(pB, textOf(small));
  wB.poll();
  const fresh = wB.getHistory();

  assert.deepEqual(rotated, fresh, 'post-rotation history equals a fresh replay recompute');
  assert.ok(new Set(rotated.map(pt => pt.segment)).size >= 2, 'rotation opened a second segment');
});

// ── (4b) Length-shrink guard (white-box: the public API cannot shrink _calls, this is the defense) ─
// If _calls is ever shorter than the cache's snapshot count, the cached tail is stale and the whole
// thing must be rebuilt from the (now shorter) _calls — never serve the longer stale cached array.
test('H1 cache: _calls shrinking below cachedCount forces a full rebuild (length guard)', () => {
  const calls = makeCalls(30);
  const w = new SessionWatcher(tmp(textOf(calls)), 42000);
  w.poll();
  w.getHistory();                                       // warms cache with cachedCount = 30

  w._calls.length = 8;                                  // simulate a truncation the guard must catch
  const guarded = w.getHistory();                       // length 8 < cachedCount 30 → must full-rebuild

  // Oracle: recompute cold from the SAME truncated _calls.
  w._historyCache = null;
  const cold = w.getHistory();

  assert.deepEqual(guarded, cold, 'length-guard rebuild equals a cold recompute on the shrunken _calls');
  assert.equal(guarded.length, 8, 'must reflect the shrunken _calls, not the stale 30-point cache');
});

// ── (Cost) the memoized tail is O(new calls), not O(n) — the whole point of the optimization ──────
test('H1 cache: after appending ONE call, getHistory does O(tail) baseline work, not O(n)', () => {
  const calls = makeCalls(48);
  const p = tmpPath();
  writeFileSync(p, textOf(calls.slice(0, 47)));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  w.getHistory();                                       // warm (cachedCount = 47)

  appendFileSync(p, asstOf(calls[47]));                 // exactly one new call
  w.poll();

  // Count _baselineAndKavg invocations for the NEXT getHistory only.
  let count = 0;
  const orig = w._baselineAndKavg.bind(w);
  w._baselineAndKavg = (arr) => { count++; return orig(arr); };
  w.getHistory();

  assert.ok(count < 47, `steady-state getHistory must be O(tail), not O(n); got ${count} baseline calls`);
  assert.ok(count <= 2, `expected ~1 tail recompute for a single appended call; got ${count}`);
});
