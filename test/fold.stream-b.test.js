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
