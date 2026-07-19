import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';
import { discardReason } from '../lib/gitignore.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-bk-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('getBucketData: splits skills from paths, uses lastTurn field', () => {
  const SKILL_BODY = 'Base directory for this skill: /path\n\n# Brainstorming\n\n' + 'content '.repeat(100);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a.js' } },
        { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'brainstorming' } },
      ] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: '1\tconst a = 1;\n2\tconst b = 2;\n' },
      { type: 'tool_result', tool_use_id: 't2', content: 'Launching skill: brainstorming' },
    ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, sourceToolUseID: 't2',
      message: { content: [{ type: 'text', text: SKILL_BODY }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const bd = w.getBucketData();
  assert.ok(Array.isArray(bd.skills) && bd.skills.length === 1, 'one skill');
  assert.equal(bd.skills[0].name, 'brainstorming', 'skill: prefix stripped');
  assert.ok(bd.skills[0].tokens > 100, `skill tokens should reflect real content, got ${bd.skills[0].tokens}`);
  assert.ok('lastTurn' in bd.skills[0], 'skills use lastTurn');
  assert.ok(bd.paths.every(p => !p.path.startsWith('skill:')), 'paths exclude skill: entries');
  assert.ok(bd.paths.some(p => p.path === '/p/a.js'), 'file path present');
  assert.ok('lastTurn' in bd.paths[0], 'paths use lastTurn (not lastActiveTurn)');
  assert.equal(bd.paths[0].lastActiveTurn, undefined, 'lastActiveTurn renamed away');
});

test('getBucketData: residual bash/mcp arrays with name/detail/tool fields (no raw cmd)', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'FAIL '.repeat(200) } ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 25000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const bd = w.getBucketData();
  assert.ok(Array.isArray(bd.residual.bash) && Array.isArray(bd.residual.mcp));
  // Task 0b: bash residual carries the extracted feature `name` (+ redacted `detail`), never raw `cmd`.
  assert.ok(bd.residual.bash.some(b => b.name === 'npm test'), 'bash uses feature name');
  assert.ok(bd.residual.bash.every(b => b.cmd === undefined), 'no raw cmd over the wire');
  assert.ok(bd.residual.bash[0].tokens > 0 && 'lastTurn' in bd.residual.bash[0] && 'detail' in bd.residual.bash[0]);
});

test('getBucketData: exposes segment + currentTurnSeq + totals', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 20000, output_tokens: 5 }, content: [] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 40000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const bd = w.getBucketData();
  assert.equal(typeof bd.segment, 'number', 'segment exposed for override GC');
  assert.equal(typeof bd.currentTurnSeq, 'number');
  assert.equal(bd.totalResidualRaw, bd.totalL - bd.totalB, 'raw is signed L-B');
  assert.equal(bd.totalResidual, Math.max(0, bd.totalL - bd.totalB), 'display is clamped');
  assert.equal(typeof bd.dead, 'number');
});

test('getBucketData: defaultSelected annotation + bDefault excludes gitignored paths', () => {
  const CWD = '/project';
  // isIgnored stub: only node_modules/ is gitignored
  const isIgnored = (rel) => rel.startsWith('node_modules/');

  const SKILL_BODY = 'Base directory for this skill: /path\n\n# Brainstorming\n\n' + 'content '.repeat(100);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/project/src/app.js' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/project/node_modules/pkg/index.js' } },
        { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'brainstorming' } },
      ] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'const app = 1;\n'.repeat(50) },
      { type: 'tool_result', tool_use_id: 't2', content: 'module.exports = {};\n'.repeat(200) },
      { type: 'tool_result', tool_use_id: 't3', content: 'Launching skill: brainstorming' },
    ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, sourceToolUseID: 't3',
      message: { content: [{ type: 'text', text: SKILL_BODY }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 30000, output_tokens: 5 }, content: [] } },
  ]);
  const w = new SessionWatcher(path, null, { cwd: CWD, isIgnored });
  w.poll();
  const bd = w.getBucketData();

  // Skills always defaultSelected
  assert.ok(bd.skills.length >= 1, 'at least one skill');
  assert.equal(bd.skills[0].defaultSelected, true, 'skills are defaultSelected');
  assert.equal(bd.skills[0].defaultDiscardReason, null, 'skills have null discard reason');

  // In-project file: defaultSelected
  const appPath = bd.paths.find(p => p.path === '/project/src/app.js');
  assert.ok(appPath, 'in-project path present');
  assert.equal(appPath.defaultSelected, true, 'in-project path is defaultSelected');
  assert.equal(appPath.defaultDiscardReason, null);

  // Gitignored file: NOT defaultSelected
  const nmPath = bd.paths.find(p => p.path === '/project/node_modules/pkg/index.js');
  assert.ok(nmPath, 'node_modules path present');
  assert.equal(nmPath.defaultSelected, false, 'gitignored path is not defaultSelected');
  assert.equal(nmPath.defaultDiscardReason, 'gitignore');

  // bDefault excludes the gitignored path tokens but includes dead + selected paths + skills
  assert.equal(typeof bd.bDefault, 'number', 'bDefault exposed');
  assert.ok(bd.bDefault > 0, 'bDefault is positive');
  // bDefault should be less than totalB (because node_modules tokens are excluded)
  assert.ok(bd.bDefault <= bd.totalB, 'bDefault <= totalB (gitignored excluded)');
  // bDefault includes the app.js tokens + skill tokens + dead, but NOT node_modules
  if (nmPath.tokens > 0) {
    assert.ok(bd.bDefault < bd.totalB, 'bDefault < totalB when gitignored path has tokens');
  }
});
