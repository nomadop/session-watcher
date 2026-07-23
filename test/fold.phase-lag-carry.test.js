import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-lag-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// ~600 lines × 40 chars, Read-adapter "N\t...." format → ~10.7k tokens at ctp.ascii=2.45
function fakeReadContent(lineCount, charsPerLine = 40) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) lines.push(`${i}\t${'x'.repeat(charsPerLine)}`);
  return lines.join('\n');
}

// Reproduces the "60k bash ls" topology (session 986d7bed):
//   - a large file is Read → B credited eagerly (§2.5 previously DELETED this)
//   - the batch sits in cache_creation for a row (uncached) — deferred settlement BANKS the overshoot
//   - a co-located `ls` is issued in that window (the innocent bystander)
//   - the NEXT row's cacheRead absorbs the batch (+~10.7k) → WITHOUT the ledger this ΔL becomes
//     phantom residual, spikes g, and is charged 100% to `ls`. WITH it, the ΔL retires the ledger.
test('§2.4c defer+retire: cc→cr phase lag is banked then retired — ls is NOT charged the phantom', () => {
  const fileContent = fakeReadContent(600, 40);
  const path = tmpJsonl([
    // Row 1 (anchor): dead=5000, warmupCeiling=5003
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'start' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'go' } },
    // Row 2: warm cacheRead past the ceiling so later rows are ceiling-free (prevL=10000 > 5003)
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'text', text: 'warming' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'read the file' } },
    // Row 3: Read the big file (tool_use). L unchanged this row.
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/proj/big.md' } }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a3', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-read', content: fileContent } ] } },
    // Row 4: batch is in cache_creation (uncached), NOT yet cacheRead. `ls` issued here.
    { type: 'assistant', uuid: 'a4', parentUuid: 'u3', message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 10775, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-ls', name: 'Bash', input: { command: 'ls /proj/reports/' } }] } },
    { type: 'user', uuid: 'u4', parentUuid: 'a4', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-ls', content: 'total 8\nfoo.md\nbar.md' } ] } },
    // Row 5: cacheRead catches up (+~10775). The ledger retires it → NOT residual.
    { type: 'assistant', uuid: 'a5', parentUuid: 'u4', message: { id: 'm5', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20775, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 40 },
      content: [{ type: 'text', text: 'done' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  // 1. The file bucket survived intact — deferred settlement did NOT delete it (unlike old §2.5).
  assert.ok(w._bRebuild.pathTotal('/proj/big.md') > 9000,
    `file bucket must survive (got ${w._bRebuild.pathTotal('/proj/big.md')})`);

  // 2. The catch-up row's residual is ~0 — the ledger absorbed the lag (protects BOTH g and buckets).
  const lastCall = w._calls[w._calls.length - 1];
  assert.ok(lastCall.deltaResidual < 500,
    `catch-up ΔL must retire the ledger, not become residual (got ${lastCall.deltaResidual})`);

  // 3. `ls` is NOT charged the phantom lag.
  const rec = w._residualByTool.get('ls');
  assert.ok(!rec || rec.tokens < 500, `ls must not absorb phantom lag (got ${rec?.tokens})`);

  // 4. Ledger fully retired by end of the (single) segment.
  assert.equal(w._bLagLedger.total, 0, `deferred ledger must retire to 0 after L catches up (got ${w._bLagLedger.total})`);
});

// Report-#1 regression: a SINGLE row that both banks new lag AND retires prior ledger must not
// double-count ΔL. Two files read across two rows with staggered catch-up; the row where file B is
// credited (ΔB>0) also sees file A's batch confirmed by L (ΔL>0). The buggy triple-netting order
// leaks phantom residual here; settleDeferred must keep it at 0.
test('§2.4c report-#1: same-row bank+retire does not double-count ΔL (no phantom residual)', () => {
  const fileA = fakeReadContent(600, 40); // ~10.7k
  const fileB = fakeReadContent(600, 40); // ~10.7k
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'warm' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'read A' } },
    // Row 2: Read A → B credited; L flat (A sits in cc). Banks A.
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, cache_creation_input_tokens: 10775, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-a', name: 'Read', input: { file_path: '/proj/a.md' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-a', content: fileA } ] } },
    // Row 3: Read B → B credited (banks B) AND L catches up file A (+10775 → retires A). Both happen
    // this row. A co-located `ls` sits here. Under the buggy order the double-netted ΔL leaks residual.
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 30775, cache_creation_input_tokens: 10775, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-b', name: 'Read', input: { file_path: '/proj/b.md' } },
                { type: 'tool_use', id: 'tu-ls', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a3', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-b', content: fileB },
      { type: 'tool_result', tool_use_id: 'tu-ls', content: 'a.md\nb.md' } ] } },
    // Row 4: L catches up file B (+10775 → retires B). Ledger should reach 0 with zero residual.
    { type: 'assistant', uuid: 'a4', parentUuid: 'u3', message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 41550, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 40 },
      content: [{ type: 'text', text: 'done' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  // The `ls` on row 3 must not absorb file A's catch-up ΔL as phantom residual (the report-#1 leak).
  const rec = w._residualByTool.get('ls');
  assert.ok(!rec || rec.tokens < 500, `ls must not absorb double-counted ΔL (got ${rec?.tokens})`);
  // Both files' lag fully retired → ledger 0.
  assert.ok(w._bLagLedger.total < 1, `both batches must retire (got ${w._bLagLedger.total})`);
});

// Pure phase lag → the entire overshoot retires → ctpOvershoot must stay ~0 (NOT ~10775 as it would
// if the lag were logged as CTP drift). Guards the per-row exclusion in Task 1 Step 7 (st.ctpImmediate).
test('§2.4c: pure phase-lag is excluded from ctpOvershoot telemetry', () => {
  const fileContent = fakeReadContent(600, 40);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'start' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'go' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'text', text: 'warming' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'read' } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/proj/big.md' } }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a3', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-read', content: fileContent } ] } },
    // Row 4: entire batch in cache_creation (uncached). Pure phase lag — zero true CTP error.
    { type: 'assistant', uuid: 'a4', parentUuid: 'u3', message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 10775, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'text', text: 'thinking' }] } },
    { type: 'user', uuid: 'u4', parentUuid: 'a4', message: { content: 'next' } },
    // Row 5: cacheRead catches up → ledger retires fully.
    { type: 'assistant', uuid: 'a5', parentUuid: 'u4', message: { id: 'm5', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20775, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 40 },
      content: [{ type: 'text', text: 'done' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  // Pure lag with all B-surplus attributable to the file path → ctpImmediate is mathematically 0.
  // Use a tight epsilon (not the 500-tok business threshold) — a nonzero value here is a real defect.
  assert.ok(w._ctpOvershoot < 1, `phase-lag must not register as CTP overshoot (got ${w._ctpOvershoot})`);
});

// During the lag window B (belief) exceeds L AND totalStock, but the REPORTED B must be capped to
// totalStock (physical invariant) while the underlying bucket keeps its full value. Reuses the repro
// topology: at row 4 the file is credited to B (~10.7k) but only ~10775 is uncached and cacheRead is
// flat, so B > totalStock transiently.
test('§I read-time cap: reported B ≤ totalStock during lag, bucket belief intact, _prevB uncapped', () => {
  const fileContent = fakeReadContent(600, 40);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'start' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'go' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'text', text: 'warming' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'read' } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/proj/big.md' } }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a3', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-read', content: fileContent } ] } },
    // Row 4 (session ends here, mid-lag): B ~= 6000 dead + ~10.7k file ≈ 16.7k, but totalStock is only
    // 6000 + 300 cc + 3 = 6303 → B(belief) > totalStock. Reported B must be capped to totalStock.
    { type: 'assistant', uuid: 'a4', parentUuid: 'u3', message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 6000, cache_creation_input_tokens: 300, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'text', text: 'thinking' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  const totalStock = 6000 + 300 + 3;
  const st = w.getStatus();
  // 1. Reported B is capped to totalStock (invariant holds).
  assert.ok(st.B <= totalStock + 1, `reported B must be ≤ totalStock (got B=${st.B}, totalStock=${totalStock})`);
  // 2. The bucket belief is intact (NOT capped) — content survives for when L catches up.
  assert.ok(w._bRebuild.pathTotal('/proj/big.md') > 9000,
    `bucket belief must be uncapped (got ${w._bRebuild.pathTotal('/proj/big.md')})`);
  // 3. The reconciliation snapshot is uncapped (capping it would create phantom residual next row).
  assert.ok(w._prevB > totalStock, `_prevB must stay uncapped (got ${w._prevB}, totalStock=${totalStock})`);
  // 4. Decision math reads Bfull, not the cap: rateLamp.B_rebuild is the display value (capped), but the
  //    archived profile b_total must equal the uncapped belief (dead + Σpaths), NOT the capped number (#2).
  const snap = w.getTerminalSnapshot();
  const pathSum = snap.paths.reduce((s, p) => s + p.tokens, 0);
  assert.ok(snap.b_total >= w._bRebuild.dead + pathSum - 1,
    `archived b_total must be the uncapped belief (got ${snap.b_total}, dead+Σpaths=${w._bRebuild.dead + pathSum})`);
  assert.ok(snap.b_total > totalStock,
    `archived b_total is B_full (uncapped), so it exceeds totalStock during lag (got ${snap.b_total})`);
});

// Genuine CTP overshoot that L NEVER confirms → the remainder stays deferred until the segment
// boundary, which finalizes it as a real bucket correction. Drive a /compact boundary (a second
// null-parent root) and assert the file bucket is corrected down after the boundary.
test('§2.4c: never-retired remainder is finalized as a bucket correction at the segment boundary', () => {
  const fileContent = fakeReadContent(600, 40); // ~10.7k tokens credited to B
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'start' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'read' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50100, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/proj/ctp.md' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-read', content: fileContent } ] } },
    // Row 3: B jumps ~10.7k, but cacheRead grows only ~150 and there is almost NO uncached headroom
    // (input tiny) — and crucially L NEVER catches up afterward. This is a genuine CTP overestimate.
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50250, cache_creation_input_tokens: 0, input_tokens: 100, output_tokens: 80 },
      content: [{ type: 'text', text: 'analysis' }] } },
    // Row 4: /compact boundary — a SECOND null-parent root (parentUuid: null) triggers a segment reset,
    // finalizing the still-deferred remainder as a correction just before the snapshot is archived.
    { type: 'assistant', uuid: 'a4', parentUuid: null, message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'text', text: 'post-compact' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  // After the boundary the segment was reset, so /proj/ctp.md no longer exists in the live buckets.
  // The assertion that matters: the deferred ledger was finalized (zeroed) at the boundary, not carried.
  assert.equal(w._bLagLedger.total, 0, `deferred ledger must be finalized at the segment boundary (got ${w._bLagLedger.total})`);
});
