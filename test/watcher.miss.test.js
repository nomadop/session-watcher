// test/watcher.miss.test.js — v3.1 miss detection (prevL-based, spec §4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { effectiveL, classifyMiss } from '../lib/l-measure.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-miss-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, cc, out, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: {
    input_tokens: 100, output_tokens: out,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

test('effectiveL prefers finite c.L, falls back to cacheRead, null-safe', () => {
  assert.equal(effectiveL({ L: 82000, cacheRead: 0 }), 82000);
  assert.equal(effectiveL({ cacheRead: 137000 }), 137000);
  assert.equal(effectiveL({ L: undefined, cacheRead: 5 }), 5);
  assert.equal(effectiveL(null), 0, 'nullish record → 0, never throws');
  assert.equal(effectiveL({}), 0, 'no L and no cacheRead → 0');
});

test('classifyMiss v3.1: prevL-based — cr below 0.95·prevL with stock preserved → miss', () => {
  // full miss: cacheRead dropped to 0, totalStock preserved
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 82000, prevL: 80000, prevTotalStock: 80000 }), true);
  // partial miss: cacheRead at 50% of prevL, totalStock preserved
  assert.equal(classifyMiss({ cacheRead: 40000, totalStock: 82000, prevL: 80000, prevTotalStock: 80000 }), true);
  // cold start: prevL=0 → never a miss
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 18770, prevL: 0, prevTotalStock: 0 }), false);
  // /clear: totalStock drops → not a miss (segment boundary)
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 3000, prevL: 80000, prevTotalStock: 80000 }), false);
  // healthy: cacheRead above 0.95·prevL threshold
  assert.equal(classifyMiss({ cacheRead: 77000, totalStock: 82000, prevL: 80000, prevTotalStock: 80000 }), false);
});

test('miss row: rec.L reconstructs stock (cacheRead+cacheCreation), rec.miss true; normal rows L==cacheRead', () => {
  // Build: growth → miss row (cr=0, cc carries stock) → recovery
  const path = tmpJsonl([
    asst('m0', 20000, 5000, 10, 'a0'),
    asst('m1', 40000, 3000, 10, 'a1', 'a0'),
    asst('m2', 80000, 2000, 10, 'a2', 'a1'),
    asst('m3', 0, 82000, 10, 'a3', 'a2'),     // MISS: cr collapses, cc reconstructs 82000 stock
    asst('m4', 82000, 2000, 10, 'a4', 'a3'),  // recovery
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const miss = w._calls[3];
  assert.equal(miss.miss, true, 'idx3 detected as miss');
  assert.equal(miss.cacheRead, 0, 'raw cacheRead preserved on the record');
  assert.equal(miss.L, 82000, 'L reconstructed = cacheRead + cacheCreation');
  // Normal rows: L == cacheRead
  for (const i of [0, 1, 2, 4]) {
    assert.equal(w._calls[i].miss, false, `idx${i} not a miss`);
    assert.equal(w._calls[i].L, w._calls[i].cacheRead, `idx${i} L==cacheRead`);
  }
});

test('miss row does NOT open a new segment (totalStock preserved → no drop)', () => {
  const path = tmpJsonl([
    asst('m0', 20000, 5000, 10, 'a0'),
    asst('m1', 80000, 2000, 10, 'a1', 'a0'),
    asst('m2', 0, 82000, 10, 'a2', 'a1'),    // miss: totalStock=82100 (cr+cc+input) ≈ stable
    asst('m3', 82000, 2000, 10, 'a3', 'a2'),
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'miss stays in one segment');
});

test('cold-start / segment-first row (prevL=null) is never a miss', () => {
  // First row: cr=0, cc large — cold start, prevL=null → never a miss
  const path = tmpJsonl([
    asst('m0', 0, 18770, 10, 'a0'),
    asst('m1', 18000, 2000, 10, 'a1', 'a0'),
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._calls[0].miss, false, 'cold start excluded (prevL=null)');
  assert.equal(w._calls[0].L, 0, 'cold-start L stays raw cacheRead (0)');
});

test('DeepSeek (cacheCreation≡0) never classifies as miss — structural no-op', () => {
  // DeepSeek: cc=0 always → totalStock = cr + input. Even if cr drops, totalStock from input
  // prevents stock-preserved criterion from triggering in a meaningful pattern.
  const ds = (id, cr, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
    message: { id, model: 'deepseek-v4-pro', usage: {
      input_tokens: 32351, output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
  const path = tmpJsonl([
    ds('d0', 40000, 'a0'),
    ds('d1', 0, 'a1', 'a0'), // cr drops, cc=0 → totalStock=32351 < prevTotalStock(72351)-100 → stock NOT preserved → not a miss
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.ok(w._calls.every(c => c.miss === false), 'no DeepSeek row is a miss');
});
