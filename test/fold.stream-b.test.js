import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-b-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, out, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: { cache_read_input_tokens: cr, output_tokens: out }, content: [] } });

test('Stream B: linear no-Read session → g accumulates positive, prevB carries', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 12000, 100, 'a2', 'a1'), asst('m3', 15000, 100, 'a3', 'a2')]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.ok(w._g_ema > 0, 'residual growth accumulates');
});

test('Stream B: cold-start first row (cr=0, input>0) anchors dead from input, not 0', () => {
  // Real cold start: system prompt sent as input (not yet cached), cacheRead=0.
  const coldStart = (id, cr, inp, out, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
    message: { id, model: 'claude-opus-4-8', usage: { cache_read_input_tokens: cr, input_tokens: inp, output_tokens: out }, content: [] } });
  const path = tmpJsonl([
    coldStart('m1', 0, 42000, 100, 'a1'),        // cold: cr=0, input=42k (system prompt)
    coldStart('m2', 42000, 0, 100, 'a2', 'a1'),  // warm: system prompt now cached
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.ok(w._bRebuild.dead >= 40000, `dead should anchor from input≈42k, got ${w._bRebuild.dead}`);
});

test('Stream B: topology compact (null-parent root) → segmentReset clears B_rebuild + bumps epoch', () => {
  const path = tmpJsonl([
    asst('m1', 50000, 100, 'a1'),
    asst('m2', 60000, 100, 'a2', 'a1'),
    asst('m3', 5000, 100, 'a3', null), // /clear: null-parent root → segment
  ]);
  const w = new SessionWatcher(path);
  const epoch0 = w._segmentEpoch;
  w.poll();
  assert.ok(w._segmentEpoch > epoch0, 'epoch bumped on segment boundary');
  assert.equal(w._bRebuild.paths.size, 0, 'B_rebuild cleared on reset');
});

test('Stream B: per-call metadata attached (B_at_call, g_at_call, deltaResidual)', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 12000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const last = w._calls[w._calls.length - 1];
  assert.ok(Number.isFinite(last.B_at_call));
  assert.ok(Number.isFinite(last.g_at_call));
  assert.ok(Number.isFinite(last.deltaResidual));
});

test('Stream B: g feeds on ΔtotalStock — growth parked in cacheCreation still reaches g', () => {
  // cacheRead is FLAT while 5k of new content sits in cacheCreation: ΔL = 0 but ΔtotalStock = 5000.
  const row = (id, cr, cc, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
    message: { id, model: 'claude-opus-4-8', content: [],
      usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 5 } } });
  const path = tmpJsonl([row('m1', 10000, 0, 'a1'), row('m2', 10000, 5000, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  // Cold start seeds g at G_FLOOR=100; ΔB=0, so the step is 0.06·5000 + 0.94·100 = 394, rate-limited
  // to 100 + 250 = 350. On the ΔcacheRead channel g's input would be 0 and g would stay at 100.
  assert.equal(w._g_ema, 350);
  assert.equal(w._calls[1].deltaResidual, 0, 'the settled ΔL residual channel is untouched');
});

test('Stream B: when a released cache_creation drops stock below the segment anchor, g does not bill the recovery', () => {
  // A released cache_creation shrinks the stock without replacing the prefix. While the shrink stays
  // inside foldCall's relative floor the segment holds, which leaves _prevTotalStock BELOW
  // the warm-up ceiling — the one path where g's ceiling guard fires.
  const row = (id, cr, cc, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
    message: { id, model: 'claude-opus-4-8', content: [],
      usage: { cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 5 } } });
  const path = tmpJsonl([
    row('m1', 0, 44000, 'a1', null),      // anchor: dead = ceiling = totalStock = 44000, g = G_FLOOR
    row('m2', 44000, 8000, 'a2', 'a1'),   // stock 44k → 52k; g = 100 + cap = 350
    row('m3', 43000, 0, 'a3', 'a2'),      // cc released: stock 52000 → 43000, a 17.3% drop inside the floor (13000)
    row('m4', 46000, 0, 'a4', 'a3'),      // recovery: stock 43000 → 46000
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._segment, 0, 'a drop inside the floor must not open a new segment (else the guard is untested)');
  // m2's ΔtotalStock of 8000 hits the G_DELTA_CAP, leaving g = 350; m3's stock falls, so its clamped
  // input is 0 and g = 0.94·350 = 329. Recovery then counts only growth ABOVE the anchor:
  // 46000 − 44000 = 2000, so g = 0.06·2000 + 0.94·329 = 429.26. Billing the whole 3000 would give 489.26.
  assert.ok(Math.abs(w._g_ema - 429.26) < 1e-9, `expected ≈429.26, got ${w._g_ema}`);
});
