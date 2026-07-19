import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-skill-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const SKILL_CONTENT = 'Base directory for this skill: /path/to/skill\n\n# Brainstorming\n\n' + 'x'.repeat(5000);

test('Skill content via sourceToolUseID attributes real token count to skill path', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'brainstorming' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: superpowers:brainstorming' } ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, sourceToolUseID: 'tu1',
      message: { content: [{ type: 'text', text: SKILL_CONTENT }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 10 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const skillTokens = w._bRebuild.pathTotal('skill:brainstorming');
  // 5066 chars / 3.0 ctp + 40 overhead ≈ 1728 tokens (NOT ~14 from the confirmation)
  assert.ok(skillTokens > 1000, `skill tokens should be >1000, got ${skillTokens}`);
});

test('Skill content: isMeta message does NOT bump turnSeq', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'brainstorming' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: brainstorming' } ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, sourceToolUseID: 'tu1',
      message: { content: [{ type: 'text', text: SKILL_CONTENT }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 10 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._turnSeq, 1, 'isMeta should not bump turnSeq');
});

test('Skill content: failed Skill (is_error) has no sourceToolUseID, B unchanged', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'nonexistent' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: true,
        content: '<tool_use_error>Unknown skill: nonexistent</tool_use_error>' } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 12000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._bRebuild.pathTotal('skill:nonexistent'), 0, 'failed skill should have 0 tokens');
});

test('Skill content: multiple skills in one session each get correct attribution', () => {
  const SKILL_A = 'Skill A content ' + 'a'.repeat(3000);
  const SKILL_B = 'Skill B content ' + 'b'.repeat(9000);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'debugging' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: debugging' } ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, sourceToolUseID: 'tu1',
      message: { content: [{ type: 'text', text: SKILL_A }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 10 }, content: [] } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'm3', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 25000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'code-review' } }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a3', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu2', content: 'Launching skill: code-review' } ] } },
    { type: 'user', uuid: 'u4', parentUuid: 'u3', isMeta: true, sourceToolUseID: 'tu2',
      message: { content: [{ type: 'text', text: SKILL_B }] } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u4', message: { id: 'm4', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 35000, output_tokens: 10 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const tokA = w._bRebuild.pathTotal('skill:debugging');
  const tokB = w._bRebuild.pathTotal('skill:code-review');
  assert.ok(tokA > 500, `skill:debugging should be >500, got ${tokA}`);
  assert.ok(tokB > 2000, `skill:code-review should be >2000, got ${tokB}`);
  assert.ok(tokB > tokA, `code-review (9k chars) should be larger than debugging (3k chars)`);
});
