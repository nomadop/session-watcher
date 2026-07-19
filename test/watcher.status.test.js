import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-st-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, out, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: { cache_read_input_tokens: cr, output_tokens: out, input_tokens: 10, cache_creation_input_tokens: 0 }, content: [] } });

test('getStatus: returns B/g/x with x = L/B and finite br', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1'), asst('m2', 40000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const s = w.getStatus();
  assert.ok(s.B > 0);
  assert.ok(Number.isFinite(s.x));
  assert.ok(Math.abs(s.x - s.L / s.B) < 1e-6);
  assert.ok(Number.isFinite(s.rateLamp.br));
});

test('getStatus: no baseline/kAvg/Lstar/metricsReliable fields (retired)', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const s = w.getStatus();
  assert.equal(s.baseline, undefined);
  assert.equal(s.Lstar, undefined);
  assert.equal(s.kAvg, undefined);
});

test('getStatus: ctpOvershootRatio exposed', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.ok(Number.isFinite(w.getStatus().ctpOvershootRatio));
});

test('getStatus: rateLamp unreliable when no data and no transcript', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'sw-st-')), 'does-not-exist.jsonl');
  const w = new SessionWatcher(missing);
  w.poll();
  const s = w.getStatus();
  assert.equal(s.rateLamp.reliable, false);
  assert.equal(s.rateLamp.unavailableReason, 'no_transcript');
});

test('getStatus: rateLamp reliable=true carries B/g/x/br bundle', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1'), asst('m2', 40000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const s = w.getStatus();
  if (s.rateLamp.reliable) {
    assert.equal(s.rateLamp.basis, 'fullCarry');
    assert.equal(s.rateLamp.L_read, s.L);
    assert.equal(s.rateLamp.B_post, s.B);
    assert.equal(s.rateLamp.B_rebuild, s.B);
    assert.equal(s.rateLamp.C_RATIO, s.cRatio);
    assert.equal(s.rateLamp.gEma, s.g);
    assert.equal(typeof s.rateLamp.inDeepWater, 'boolean');
  }
});

test('getTerminalSnapshot: returns profile object with required fields', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1'), asst('m2', 40000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const snap = w.getTerminalSnapshot();
  assert.ok(Number.isFinite(snap.b_total));
  assert.ok(Number.isFinite(snap.g_final));
  assert.ok(Number.isFinite(snap.l_peak));
  assert.ok(Number.isFinite(snap.c_ratio));
  assert.ok(Number.isFinite(snap.turns));
  assert.ok(Number.isFinite(snap.br_exit));
  assert.ok(Number.isFinite(snap.ctp_overshoot_ratio));
  assert.ok(Array.isArray(snap.paths));
  assert.ok(typeof snap.model === 'string');
});

test('getStatus: x uses B_default (excludes gitignored); g unchanged on B_full', () => {
  const CWD = '/project';
  // isIgnored stub: only node_modules/ is gitignored
  const isIgnored = (rel) => rel.startsWith('node_modules/');

  // Session: one in-project file (small) and one node_modules file (large).
  // The node_modules file is excluded from B_default, making bDefault < B_full.
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/project/src/app.js' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/project/node_modules/pkg/index.js' } },
      ] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'const app = 1;\n'.repeat(50) },
      { type: 'tool_result', tool_use_id: 't2', content: 'module.exports = {};\n'.repeat(200) },
    ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 30000, output_tokens: 5 }, content: [] } },
  ]);

  // Baseline run without isIgnored (B_full drives everything)
  const wFull = new SessionWatcher(path, null, { cwd: CWD });
  wFull.poll();
  const sFull = wFull.getStatus();
  const gFull = sFull.g;

  // Run with isIgnored → B_default excludes node_modules
  const w = new SessionWatcher(path, null, { cwd: CWD, isIgnored });
  w.poll();
  const s = w.getStatus();

  // g_ema unchanged whether or not node_modules is excluded (g uses ΔB_full):
  assert.equal(s.g, gFull, 'g unchanged (still uses B_full)');

  // B_default < B_full (node_modules excluded from position basis):
  assert.ok(s.rateLamp.B_default < s.rateLamp.B_rebuild,
    `B_default (${s.rateLamp.B_default}) should be < B_rebuild (${s.rateLamp.B_rebuild})`);

  // x uses B_default (excludes node_modules) → HIGHER than L/B_full:
  const L = s.L;
  assert.ok(s.rateLamp.x_display > L / s.rateLamp.B_rebuild,
    `x_display (${s.rateLamp.x_display}) should be > L/B_rebuild (${L / s.rateLamp.B_rebuild})`);

  // x_display should equal L / B_default
  const expectedX = L / s.rateLamp.B_default;
  assert.ok(Math.abs(s.rateLamp.x_display - expectedX) < 1e-6,
    `x_display (${s.rateLamp.x_display}) should equal L/B_default (${expectedX})`);
});

test('getBucketData: returns bucket structure', () => {
  const path = tmpJsonl([asst('m1', 20000, 100, 'a1'), asst('m2', 40000, 100, 'a2', 'a1')]);
  const w = new SessionWatcher(path);
  w.poll();
  const bd = w.getBucketData();
  assert.ok(Array.isArray(bd.paths));
  assert.ok(Number.isFinite(bd.totalB));
  assert.ok(Number.isFinite(bd.totalL));
  assert.ok(Number.isFinite(bd.totalResidual));
  assert.ok(Number.isFinite(bd.ctpOvershootRatio));
  assert.ok(Number.isFinite(bd.currentTurnSeq));
});
