import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-res-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('residual: single unmatched Bash tool absorbs all deltaResidual for its turn', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(500) } ] } },
    // next usage row: L jumps 10k → 22k, no B change → deltaResidual ≈ 12k
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 22000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const rec = w._residualByTool.get('npm test');
  assert.ok(rec, 'npm test recorded as residual');
  assert.equal(rec.kind, 'bash');
  // Review GPT-backend: assert on invariant (present + kind + 0 < tokens ≤ this turn's residual upper
  // bound), NOT a hard 1000 threshold that drifts if BRebuild/dead math changes. deltaResidual here is
  // ~12k (L 10k→22k, no B change); the bound is generous.
  assert.ok(rec.tokens > 0 && rec.tokens <= 13000, `absorbs deltaResidual within bound, got ${rec.tokens}`);
});

test('residual: MCP tool recorded with mcp kind and tool name', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__serena__find_symbol', input: { q: 'X' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'y'.repeat(300) } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 18000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  // key is the prettified mcpDisplay() name (Task 0b), not the raw mcp__ tool id
  const rec = w._residualByTool.get('serena find_symbol');
  assert.ok(rec && rec.kind === 'mcp', 'MCP tool recorded under mcpDisplay key');
});

test('residual: matched Read tool does NOT appear in residualByTool', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/p/a.js' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: '1\tconst a = 1;\n2\tconst b = 2;\n' } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 15000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._residualByTool.size, 0, 'Read is a matched adapter → not residual');
});

test('residual: touchSeqs accumulates {seq, mode} per tool invocation', () => {
  // Two Bash invocations across two fold cycles → 2 touchSeqs entries
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu2', content: 'ok again' } ] } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 30000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const rec = w._residualByTool.get('npm test');
  assert.ok(rec, 'npm test recorded');
  assert.ok(Array.isArray(rec.touchSeqs), 'touchSeqs is array');
  assert.equal(rec.touchSeqs.length, 2, 'two invocations → two entries');
  assert.equal(rec.touchSeqs[0].mode, 'w');
  assert.equal(rec.touchSeqs[1].mode, 'w');
  assert.ok(rec.touchSeqs[0].seq > 0 && rec.touchSeqs[1].seq > rec.touchSeqs[0].seq, 'seqs are monotonic');
});

test('residual: segmentReset clears residualByTool', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 50000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git log' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'z'.repeat(200) } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 60000, output_tokens: 5 }, content: [] } },
    // /clear: totalStock collapses → segmentReset
    { type: 'assistant', uuid: 'a3', parentUuid: 'u1', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._residualByTool.size, 0, 'residual cleared on segment boundary');
});
