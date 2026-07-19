import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRebuild } from '../lib/measure.js';

test('first fullSet sets totalSpent = B_current → churn 1.0', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100], [2, 100]], overhead: 40, spent: 240 }, 'a.js', 1, 1);
  const snap = b.snapshot();
  const row = snap.find(r => r.path === 'a.js');
  assert.equal(row.tokens, 240);         // 200 content + 40 overhead
  assert.equal(row.totalSpent, 240);
  assert.equal(row.churn, 1);
  assert.equal(row.efficiency, 100);
  assert.equal(row.readCount, 1);
  assert.equal(row.editCount, 0);
  assert.deepEqual(row.touchSeqs, [{ seq: 1, mode: 'r' }]);
});

test('re-reading the same file accumulates totalSpent but B_current stays flat → churn grows', () => {
  const b = new BRebuild();
  for (let i = 1; i <= 4; i++) {
    b.apply({ type: 'fullSet', lines: [[1, 100], [2, 100]], overhead: 40, spent: 240 }, 'a.js', i, i);
  }
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.tokens, 240);          // snapshot value unchanged (fullSet clears + resets)
  assert.equal(row.totalSpent, 960);      // 4 × 240
  assert.equal(row.churn, 4);
  assert.equal(row.efficiency, 25);       // round(240/960*100)
  assert.equal(row.readCount, 4);
  assert.deepEqual(row.touchSeqs, [{ seq: 1, mode: 'r' }, { seq: 2, mode: 'r' }, { seq: 3, mode: 'r' }, { seq: 4, mode: 'r' }]);
});

test('editDelta accumulates spent and editCount, not readCount', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'editDelta', value: 0, spent: 300 }, 'a.js', 2, 2);
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.totalSpent, 440);
  assert.equal(row.readCount, 1);
  assert.equal(row.editCount, 1);
  // touchSeqs carries r/w mode: fullSet→'r', editDelta→'w'
  assert.deepEqual(row.touchSeqs, [{ seq: 1, mode: 'r' }, { seq: 2, mode: 'w' }]);
});

test('churn/efficiency are null when B_current is 0 (no crash)', () => {
  const b = new BRebuild();
  // editDelta that nets B_current to 0 but spent > 0
  b.apply({ type: 'editDelta', value: 0, spent: 500 }, 'gone.js', 1, 1);
  const rows = b.snapshot();
  // B_current is 0 → excluded from snapshot (tokens>0 gate), so no row emitted; verify no throw:
  assert.ok(Array.isArray(rows));
});

test('grepMultiFile distributes spent by each file\'s injected share, preserving churn >= 1', () => {
  const b = new BRebuild();
  // a.js content 100 + b.js content 300, overhead 40 split evenly (20 each) → injected a=120, b=320.
  // total injected = 440. Distribute the reported spent (say 440) by share: a gets 120, b gets 320.
  b.apply({
    type: 'grepMultiFile',
    files: { 'a.js': [[1, 100]], 'b.js': [[1, 300]] },
    overhead: 40, spent: 440,
  }, null, 1, 1);
  const a = b.snapshot().find(r => r.path === 'a.js');
  const bb = b.snapshot().find(r => r.path === 'b.js');
  // per-file spent = fileTokens + perFileOverhead (NOT spent/fileCount — even split would give
  // b.js totalSpent 220 < tokens 320 → churn 0.69, violating invariant 3).
  assert.equal(a.totalSpent, 120);
  assert.equal(bb.totalSpent, 320);
  assert.ok(a.churn >= 1 && bb.churn >= 1);
  assert.ok(a.efficiency <= 100 && bb.efficiency <= 100);
});

test('snapshot clamps totalSpent >= tokens (churn never below 1, efficiency never above 100)', () => {
  const b = new BRebuild();
  // Force an under-report: report spent smaller than the file's injected tokens.
  b.apply({ type: 'fullSet', lines: [[1, 100], [2, 100]], overhead: 40, spent: 50 }, 'a.js', 1, 1);
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.tokens, 240);
  assert.equal(row.totalSpent, 240);   // clamped up to tokens (Math.max)
  assert.equal(row.churn, 1);
  assert.equal(row.efficiency, 100);
});

test('clear() resets totalSpent/counters/touchSeqs but preserves the existing dead contract', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.clear();
  assert.equal(b.snapshot().length, 0);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 2, 2);
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.totalSpent, 140);      // fresh, not 280
  assert.deepEqual(row.touchSeqs, [{ seq: 2, mode: 'r' }]);
});

test('clear() does NOT reset dead (existing contract: caller pairs clear() with setDead(0))', () => {
  const b = new BRebuild();
  b.setDead(5000);
  b.clear();
  // dead is deliberately preserved by clear() (domain_model: segmentReset calls setDead separately).
  assert.equal(b.dead, 5000);
});

// ─── Pure-reread detection (Task 6: A3 struggling detection) ────────────────

test('first fullSet is NOT a reread', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 0);
});

test('second fullSet with no intermediate edit IS a pure reread', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 2, 2);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 1);
});

test('fullSet after an edit is NOT a reread (edit resets the flag)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'editDelta', value: 50, spent: 200 }, 'a.js', 2, 2);
  b.apply({ type: 'fullSet', lines: [[1, 150]], overhead: 40, spent: 190 }, 'a.js', 3, 3);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 0);
});

test('multiple consecutive rereads accumulate pureRereads count', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 2, 2);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 3, 3);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 4, 4);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 3);
});

test('write update resets the edited flag (read after write is NOT a reread)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'write', lines: [[1, 120]], overhead: 90, spent: 210 }, 'a.js', 2, 2);
  b.apply({ type: 'fullSet', lines: [[1, 120]], overhead: 40, spent: 160 }, 'a.js', 3, 3);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 0);
});

test('clear() resets pureRereads and reread tracking state', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 2, 2);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 1);
  b.clear();
  // After clear, start fresh — first fullSet should NOT be a reread
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 3, 3);
  assert.equal(b.snapshot().find(r => r.path === 'a.js').pureRereads, 0);
});

// ─── §2.4 Reasoning attribution accounting (Task 11: A4) ────────────────────────

test('addReasoningSpent adds to reasoning ledger (separate from content)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.addReasoningSpent('a.js', 200);
  // Content spent is 140, reasoning is 200; snapshot totalSpent = content + reasoning (clamped >= tokens)
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.totalSpent, 340);  // 140 content + 200 reasoning
  assert.equal(row.tokens, 140);
  assert.ok(row.churn > 1);
});

test('addReasoningSpent does not alter B() (display-only)', () => {
  const b = new BRebuild();
  b.setDead(1000);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  const B_before = b.B();
  b.addReasoningSpent('a.js', 5000);
  assert.equal(b.B(), B_before, 'B unchanged after reasoning attribution');
});

test('dropReasoningSpent clears reasoning but preserves content spent (reversible degrade)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.addReasoningSpent('a.js', 500);
  // Before drop: totalSpent = 140 + 500 = 640
  assert.equal(b.snapshot().find(r => r.path === 'a.js').totalSpent, 640);
  b.dropReasoningSpent();
  // After drop: totalSpent = 140 (content only, clamped >= tokens)
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.totalSpent, 140);
  assert.equal(row.churn, 1);
});

test('_spentFor combines both ledgers', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.addReasoningSpent('a.js', 300);
  assert.equal(b._spentFor('a.js'), 440);  // 140 + 300
});

test('snapshotTotalSpentSum sums _spentFor across all paths', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 40, spent: 240 }, 'b.js', 1, 2);
  b.addReasoningSpent('a.js', 100);
  // a.js: _spentFor = 140+100=240; b.js: _spentFor = 240+0=240. Sum=480
  assert.equal(b.snapshotTotalSpentSum(), 480);
});

test('totalReasoningSpentSum sums ONLY reasoning ledger (not content)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 40, spent: 240 }, 'b.js', 1, 2);
  b.addReasoningSpent('a.js', 100);
  b.addReasoningSpent('b.js', 50);
  // Only reasoning: 100 + 50 = 150 (content 140+240=380 excluded)
  assert.equal(b.totalReasoningSpentSum(), 150);
  assert.equal(b.snapshotTotalSpentSum(), 530); // full sum still works: 240+290=530
});

test('clear() also clears the reasoning ledger', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.addReasoningSpent('a.js', 500);
  b.clear();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 2, 2);
  // After clear, reasoning should be gone
  const row = b.snapshot().find(r => r.path === 'a.js');
  assert.equal(row.totalSpent, 140);  // no residual reasoning from before clear
});

test('addReasoningSpent with null path or non-positive tokens is a no-op', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40, spent: 140 }, 'a.js', 1, 1);
  b.addReasoningSpent(null, 100);
  b.addReasoningSpent('a.js', 0);
  b.addReasoningSpent('a.js', -5);
  assert.equal(b._totalSpentReasoning.size, 0);
});
