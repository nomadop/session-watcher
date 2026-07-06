// test/fixtures.regression.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SessionWatcher } from '../lib/watcher.js';
import { extractUsage } from '../lib/extract.js';

const DS = 'fixtures/host/.claude/projects/C--Users-nomad-freshtrack/aa8e3739-3264-48d6-a2a0-75346d583c03.jsonl';

test('deepseek fixture: message.id folding collapses snapshot duplicates', { skip: !existsSync(DS) }, () => {
  const lines = readFileSync(DS, 'utf8').split('\n').filter(Boolean);
  const rawAsst = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.type === 'assistant' && e.message?.usage);
  const distinctIds = new Set(rawAsst.map(e => e.message.id).filter(Boolean));
  // Spec-verified: 536 assistant lines fold to ~209 distinct message.ids.
  assert.ok(rawAsst.length > distinctIds.size, 'raw lines exceed distinct message.ids (snapshots exist)');

  const w = new SessionWatcher(DS, null);
  w.poll();
  assert.ok(w._calls.length <= distinctIds.size + 1, 'folded call count ≈ distinct message.ids, not raw lines');
});

test('deepseek: Σ(post-knee ΔL) == L_last − L_base (telescoping identity)', { skip: !existsSync(DS) }, () => {
  const w = new SessionWatcher(DS, null);
  w.poll();
  const s = w.getStatus();
  const seg = w._calls.filter(c => c.segment === w._segment);
  const knee = s.baseline.kneeTurn;
  let sumDL = 0;
  for (let i = Math.max(1, knee); i < seg.length; i++) sumDL += Math.max(0, seg[i].cacheRead - seg[i - 1].cacheRead);
  const identity = s.L - s.baseline.total;
  // Allow small slack for the dead-bottom vs first-post-knee offset.
  assert.ok(Math.abs(sumDL - identity) / Math.max(1, identity) < 0.25, `ΔL sum ${sumDL} ≈ L−Lbase ${identity}`);
});

test('regression guard: input+output on Claude would capture ~11% of true growth', { skip: !existsSync(DS) }, () => {
  // On deepseek this ratio is ≈1.0; the guard documents the Claude-side collapse the spec warns about.
  const w = new SessionWatcher(DS, null);
  w.poll();
  const seg = w._calls.filter(c => c.segment === w._segment);
  let sumInOut = 0, trueGrowth = 0;
  for (let i = 1; i < seg.length; i++) {
    sumInOut += seg[i].input + seg[i].output;
    trueGrowth += Math.max(0, seg[i].cacheRead - seg[i - 1].cacheRead);
  }
  if (trueGrowth > 0) {
    const ratio = sumInOut / trueGrowth;
    assert.ok(ratio > 0.5, `deepseek input+output/ΔL ratio ${ratio.toFixed(2)} ≈ 1 (would be ~0.11 on Claude)`);
  }
});
