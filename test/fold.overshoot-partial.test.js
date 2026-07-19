import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-overshoot-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// Generate synthetic file content with line-number prefixes (matching Read adapter format)
function fakeReadContent(lineCount, charsPerLine = 40) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`${i}\t${'x'.repeat(charsPerLine)}`);
  }
  return lines.join('\n');
}

// ─── Case 1: Claude — large file first read, cacheCreation explains gap ───────
// Extracted from session 9984b209: mockup.html (1054 lines, 50k chars)
// prevL row: cR=55744, next row: cR=55788 cC=19410 → deltaL=44, uncached=19411
// The file contributes ~20k tokens to B but deltaL is only 44.
// Partial fix: uncached(19411) > overshoot(~20k-44≈20k) → unexplained ≈ 0 → no correction.

test('§2.5 partial: Claude large-file first-read — cacheCreation absorbs overshoot (no correction)', () => {
  // Simulate: 2 usage rows bracketing a Read of a large file.
  // Row 1: cR=10000 (establishes prevL)
  // Between rows: Read of 800-line file (~8000 tokens at ctp.ascii=2.45)
  // Row 2: cR=10050 cC=8000 (file went to cache creation, barely any cR growth)
  const fileContent = fakeReadContent(800, 40); // 800 lines × ~17 tok/line ≈ 13600 tokens at ctp 2.45

  const path = tmpJsonl([
    // Row 1: establishes prevL = 10000
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'Looking at the file...' }] } },
    // User turn boundary
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'read it' } },
    // Row 2: Read tool_use + usage (the Read is issued here, result comes in next user entry)
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10100, cache_creation_input_tokens: 50, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/big-file.html' } }] } },
    // tool_result with large file content
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: fileContent } ] } },
    // Row 3: cacheCreation is large (the file was added to cache), cR barely moved
    // deltaL = 10150 - 10100 = 50 (tiny)
    // uncached = totalStock - L = (10150 + 13000 + 1) - 10150 = 13001 (huge)
    // The file contributed ~13600 tokens to B, overshoot ≈ 13600 - 50 = 13550
    // unexplained = max(0, 13550 - 13001) = 549 (tiny residual CTP error)
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10150, cache_creation_input_tokens: 13000, input_tokens: 1, output_tokens: 100 },
      content: [{ type: 'text', text: 'Here is the file content analysis.' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  const pt = w._bRebuild.pathTotal('/proj/big-file.html');
  // Without the fix: correction would eat almost all tokens (pt ≈ 50).
  // With partial fix: most tokens survive (only tiny unexplained portion corrected).
  assert.ok(pt > 10000, `pathTotal should survive (got ${pt}, expected >10000). Partial correction should NOT destroy the path.`);
});

// ─── Case 2: DeepSeek — file read, input_tokens explains gap (cC=0 always) ───
// Extracted from session 489056b8: plan-a-agent-backend.md (2571 lines, 87k chars)
// DeepSeek pattern: prev cR=0 input=44318, next cR=0 input=44318 → deltaL=0, uncached=44318
// File ≈ 26887 tokens. overshoot = 26887 - 0 = 26887. uncached = 44318 > overshoot → unexplained=0.

test('§2.5 partial: DeepSeek large-file first-read — input_tokens absorbs overshoot (no correction)', () => {
  // DeepSeek first call: cR=0, input=high (cache write phase)
  const fileContent = fakeReadContent(600, 50); // ~600 lines × ~19 tok/line ≈ 9250 tokens at ctp 3.24

  const path = tmpJsonl([
    // Row 1: DeepSeek initial — everything in input (cache write), cR=0
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'deepseek-v4-pro',
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 20000, output_tokens: 200 },
      content: [{ type: 'text', text: 'I will read the file.' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'ok' } },
    // Row 2: cR still 0 (DeepSeek doesn't populate cR on first few calls), Read issued
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'deepseek-v4-pro',
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 20000, output_tokens: 100 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/design.md' } }] } },
    // tool_result
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: fileContent } ] } },
    // Row 3: cR=0, input=20000 still (DeepSeek cache write phase continues)
    // deltaL = 0 - 0 = 0. uncached = 20000. B grew by ~9250.
    // overshoot = 9250 - 0 = 9250. uncached(20000) > overshoot(9250) → unexplained=0.
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'deepseek-v4-pro',
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 20000, output_tokens: 150 },
      content: [{ type: 'text', text: 'Analysis complete.' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  const pt = w._bRebuild.pathTotal('/proj/design.md');
  assert.ok(pt > 5000, `pathTotal should survive (got ${pt}, expected >5000). DeepSeek input_tokens absorbs overshoot.`);
});

// ─── Case 3: True CTP overshoot — uncached < overshoot, correction IS valid ───
// Extracted from session 05b01d5a: gold-regression.test.ts (177 lines, 6883 chars)
// prev cR=230912, next cR=231040 input=1947 → deltaL=128, uncached=1947
// tokens≈2124. overshoot=2124-128=1996. uncached(1947) < overshoot(1996).
// unexplained = 1996 - 1947 = 49. Small correction IS applied (true CTP error).

test('§2.5 partial: true CTP overshoot — small unexplained portion is correctly corrected', () => {
  // Stable session (cR high and growing), Read adds moderate file.
  // deltaL is small, uncached is close to but less than overshoot → tiny correction valid.
  const fileContent = fakeReadContent(100, 45); // ~100 lines × ~19 tok/line ≈ 1900 tokens at ctp 2.45

  const path = tmpJsonl([
    // Row 1: stable session, high cR
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'checking' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'read' } },
    // Row 2: Read issued. cR grew a bit (100 tokens of output/framing added to cache)
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50100, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/small.ts' } }] } },
    // tool_result
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: fileContent } ] } },
    // Row 3: cR grew by 150 (deltaL=150), small input.
    // File adds ~1900 tokens to B. overshoot = 1900 - 150 = 1750.
    // uncached = (50250 + 0 + 100) - 50250 = 100.
    // unexplained = max(0, 1750 - 100) = 1650. Correction applies (true CTP overshoot).
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50250, cache_creation_input_tokens: 0, input_tokens: 100, output_tokens: 80 },
      content: [{ type: 'text', text: 'done' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  const pt = w._bRebuild.pathTotal('/proj/small.ts');
  // With correction applied, pathTotal should be reduced significantly
  // (but not to near-zero — partial correction only takes the unexplained portion).
  // Without correction pt ≈ 1900. With correction ≈ 1900 - 1650 = 250 (approx).
  assert.ok(pt < 1000, `pathTotal should be corrected down (got ${pt}, expected <1000). True CTP overshoot should be corrected.`);
  assert.ok(pt > 0, `pathTotal should remain positive (got ${pt}). Correction should not over-correct.`);
});

// ─── Case 4: No overshoot — deltaL >= deltaB, no correction needed ───────────

test('§2.5 partial: no overshoot when deltaL >= deltaB — correction never fires', () => {
  // Normal case: L grows enough to absorb B growth.
  const fileContent = fakeReadContent(50, 30); // small file ~700 tokens

  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: 'read' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10100, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 30 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/tiny.js' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: fileContent } ] } },
    // deltaL = 12000 - 10100 = 1900, larger than the ~700 tokens the file added → no overshoot
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 12000, cache_creation_input_tokens: 0, input_tokens: 3, output_tokens: 50 },
      content: [{ type: 'text', text: 'done' }] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  const pt = w._bRebuild.pathTotal('/proj/tiny.js');
  // No correction → pathTotal is the full Read value (lines + overhead)
  assert.ok(pt > 600, `pathTotal should be uncorrected (got ${pt}, expected >600). No overshoot = no correction.`);
});
