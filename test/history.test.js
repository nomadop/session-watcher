import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';
import { getHistory } from '../lib/history.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-hist-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, out, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: { cache_read_input_tokens: cr, output_tokens: out }, content: [] } });

test('v3: history points carry L/B/x/g, no Lstar/kAvg', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 20000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  assert.ok(pts.length >= 1);
  const last = pts[pts.length - 1];
  assert.ok(Number.isFinite(last.L) && Number.isFinite(last.B) && Number.isFinite(last.x) && Number.isFinite(last.g));
  assert.equal(last.Lstar, undefined);
  assert.equal(last.kAvg, undefined);
});

test('v3: history point x = L/B when B > 0', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 20000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  const last = pts[pts.length - 1];
  if (last.B > 0) {
    // x must be exactly L/B (ratio of load to baseline)
    assert.ok(Math.abs(last.x - last.L / last.B) < 1e-9);
  } else {
    // x defaults to 1 when baseline is unknown
    assert.equal(last.x, 1);
  }
});

test('v3: history point miss is boolean', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  assert.ok(pts.length >= 1);
  assert.equal(typeof pts[0].miss, 'boolean');
});

test('v3: getHistory returns same number of points as _calls', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 20000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  assert.equal(pts.length, w._calls.length);
});

test('computeHistoryPoint carries turnSeq for bucket hover mapping', () => {
  const path = tmpJsonl([asst('m1', 10000, 100, 'a1'), asst('m2', 20000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  assert.ok(pts.length >= 1, 'at least one point');
  assert.ok(pts.every(p => typeof p.turnSeq === 'number'), 'every point has turnSeq as number');
});
