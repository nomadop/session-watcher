import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../public/elements/bucketPanel.js';

const base = {
  dead: 8500, skills: [], paths: [], residual: { bash: [], mcp: [] },
  totalB: 0, totalL: 0, totalResidual: 0, totalResidualRaw: 0, ctpOvershootRatio: 0, currentTurnSeq: 0, segment: 0,
};

function flatten(nodes, out = []) {
  for (const n of nodes) { out.push(n); if (n.children) flatten(n.children, out); }
  return out;
}

test('buildTree: system group has locked system prompt + checkable skills', () => {
  const tree = buildTree({ ...base, skills: [{ name: 'brainstorming', tokens: 2100, lastTurn: 42 }] });
  const all = flatten(tree);
  const sys = all.find(n => n.kind === 'system');
  assert.ok(sys && sys.locked && sys.tokens === 8500, 'system prompt locked, tokens=dead');
  const skill = all.find(n => n.kind === 'skill');
  assert.ok(skill && skill.selectable && skill.defaultSelected === true, 'skill checkable + default checked');
  assert.equal(skill.name, 'brainstorming');
});

test('buildTree: single file under a dir shows full path inline (no dir row)', () => {
  const tree = buildTree({ ...base, paths: [{ path: 'src/api/routes.js', tokens: 4100, lastTurn: 41 }] });
  const all = flatten(tree);
  assert.ok(!all.some(n => n.kind === 'dir'), 'no directory row for a lone file');
  const f = all.find(n => n.kind === 'file');
  assert.equal(f.name, 'src/api/routes.js', 'full path shown inline');
  assert.equal(f.indent, 0);
});

test('buildTree: multiple files sharing a prefix create a dir row with indented children', () => {
  const tree = buildTree({ ...base, paths: [
    { path: 'src/auth/index.js', tokens: 5200, lastTurn: 42 },
    { path: 'src/auth/middleware.js', tokens: 2100, lastTurn: 40 },
  ] });
  const dir = tree.find(n => n.kind === 'dir');
  assert.ok(dir && dir.name.includes('auth'), 'directory row created');
  assert.equal(dir.children.length, 2, 'two children');
  assert.equal(dir.children[0].indent, 1, 'children indented one level');
  // directory aggregate is display-only sum of children
  assert.equal(dir.tokens, 7300);
});

test('buildTree: output group derives clamped others; bash/mcp default unchecked', () => {
  const tree = buildTree({ ...base,
    residual: { bash: [{ name: 'npm test', detail: '', tokens: 12000, lastTurn: 40 }], mcp: [{ tool: 'serena find_symbol', tokens: 3000, lastTurn: 41 }] },
    totalResidual: 50000, totalResidualRaw: 50000, totalL: 90000,
  });
  const all = flatten(tree);
  const bash = all.find(n => n.kind === 'bash');
  assert.ok(bash && bash.defaultSelected === false && bash.selectable, 'bash unchecked + selectable');
  const others = all.find(n => n.kind === 'others');
  assert.ok(others && others.locked, 'others locked');
  assert.equal(others.tokens, 50000 - 12000 - 3000, 'others = residualRaw − bash − mcp');
});

test('buildTree: others clamps to 0 and never negative', () => {
  const tree = buildTree({ ...base,
    residual: { bash: [{ name: 'ls', detail: '', tokens: 40000, lastTurn: 1 }], mcp: [] },
    totalResidual: 30000, totalResidualRaw: 30000, totalL: 100000,
  });
  const others = flatten(tree).find(n => n.kind === 'others');
  assert.equal(others.tokens, 0, 'clamped to 0, never negative');
});

test('buildTree: single bash leaf carries feature name + displayName (Task 0b / review GPT#3)', () => {
  const tree = buildTree({ ...base,
    // server already extracted the feature — no raw command reaches the client
    residual: { bash: [{ name: 'npm test', detail: '', tokens: 5000, lastTurn: 9 }], mcp: [] },
    totalResidual: 6000, totalResidualRaw: 6000, totalL: 20000,
  });
  const bash = flatten(tree).find(n => n.kind === 'bash');
  assert.equal(bash.name, 'npm test', 'feature name for compact/id');
  assert.ok(typeof bash.displayName === 'string' && bash.displayName.length, 'displayName present for DOM');
  assert.equal(bash.id, 'bash:npm test', 'id scheme bash:+name');
});

test('buildTree: negative others drift emits console.warn (review GPT-tests, spec §3.2)', () => {
  const warnings = [];
  const orig = console.warn; console.warn = (m) => warnings.push(m);
  try {
    buildTree({ ...base,
      residual: { bash: [{ name: 'ls', detail: '', tokens: 90000, lastTurn: 1 }], mcp: [] },
      // raw residual 30k − bash 90k = −60k; |−60k| > 0.02×100k=2k → warn
      totalResidual: 30000, totalResidualRaw: 30000, totalL: 100000,
    });
  } finally { console.warn = orig; }
  assert.ok(warnings.some(w => /bucket measurement drift/.test(w)), 'drift warning fired');
});

test('buildTree: empty directory (no selectable leaves) is not emitted (review Gemini三)', () => {
  // A degenerate input can only produce an empty dir via internal folding; assert no dir node has 0 children.
  const tree = buildTree({ ...base, paths: [{ path: 'a/x.js', tokens: 1, lastTurn: 1 }] });
  assert.ok(!flatten(tree).some(n => n.kind === 'dir' && (!n.children || n.children.length === 0)), 'no empty dir rows');
});

test('buildTree: absolute paths with mixed roots group correctly', () => {
  const tree = buildTree({ ...base, paths: [
    { path: '/a/b/c/1.js', tokens: 500, lastTurn: 1 },
    { path: '/a/b/c/2.js', tokens: 300, lastTurn: 2 },
    { path: '/ext/other.js', tokens: 100, lastTurn: 3 },
  ] });
  const all = flatten(tree);
  // /a/b/c should collapse into a single dir node containing 1.js and 2.js
  const dir = all.find(n => n.kind === 'dir' && n.children && n.children.length === 2);
  assert.ok(dir, 'dir node with 2 children exists');
  assert.equal(dir.displayName, 'a/b/c', 'dir label is collapsed path a/b/c');
  assert.equal(dir.children[0].kind, 'file');
  assert.equal(dir.children[1].kind, 'file');
  const names = dir.children.map(c => c.displayName).sort();
  assert.deepEqual(names, ['1.js', '2.js'], 'children are the two files');
  // /ext/other.js should be a standalone leaf
  const ext = all.find(n => n.kind === 'file' && n.label === '/ext/other.js');
  assert.ok(ext, '/ext/other.js is a standalone file leaf');
  // IDs should be unique
  const ids = all.filter(n => n.id).map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
});

test('buildTree: node ids follow the scheme and are unique', () => {
  const tree = buildTree({ ...base,
    skills: [{ name: 's1', tokens: 100, lastTurn: 1 }],
    paths: [{ path: 'a/x.js', tokens: 200, lastTurn: 1 }, { path: 'a/y.js', tokens: 300, lastTurn: 1 }],
    residual: { bash: [{ name: 'npm test', detail: '', tokens: 400, lastTurn: 1 }], mcp: [] },
    totalResidual: 1000, totalResidualRaw: 1000, totalL: 5000,
  });
  const all = flatten(tree);
  assert.ok(all.find(n => n.id === 'skill:s1'), 'skill id scheme');
  assert.ok(all.find(n => n.id === 'file:a/x.js'), 'file id scheme');
  assert.ok(all.find(n => n.id === 'bash:npm test'), 'bash id scheme');
  const ids = all.filter(n => n.selectable).map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
});
