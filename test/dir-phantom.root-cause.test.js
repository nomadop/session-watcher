// Root-cause verification: directory paths appearing as 10-token phantom items
// in the path bucket panel.
//
// Hypothesis chain:
// 1. `parseBashFileRead('grep -rn "x" src/')` → { type: 'grep-n', path: 'src/' }
//    (directory path passes _isUnresolvablePath — it only blocks '.' and '/')
// 2. `extractPath` canonicalizes 'src/' → '/workspace/src' (trailing slash stripped)
// 3. `computeUpdate` for grep-n: multi-file output ('file:line:content') doesn't
//    match the single-file regex /^(\d+):(.*)$/ → lineEntries = [] (empty)
// 4. Still returns { type: 'lineUpdate', lines: [], overhead: 10, spent: 10 }
// 5. BRebuild.apply stores overhead=10, total=0 → snapshot pathTotal = 10
// 6. foldPaths filter `!p.path.endsWith('/')` is useless (slash already stripped)
// 7. buildTree: '/workspace/src' lands in `here[]` as a file leaf, while
//    '/workspace/src/app.js' creates a dir group named 'src' → duplicate

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBashFileRead,
  canonicalizePath,
  BUILTIN_ADAPTERS,
  BRebuild,
} from '../lib/measure.js';
import { buildTree } from '../public/elements/bucketPanel.js';

const CTP = { ascii: 2.45, cjk: 0.59 };
const CWD = '/workspace';
const bashAdapter = BUILTIN_ADAPTERS.find(a => a.name === 'Bash');

// ─── Step 1: parseBashFileRead accepts directory paths ───────────────────────

test('root-cause step 1: grep -rn with directory target parses as grep-n with trailing slash', () => {
  const r = parseBashFileRead('grep -rn "pattern" src/');
  assert.notEqual(r, null, 'should not return null');
  assert.equal(r.type, 'grep-n');
  assert.equal(r.path, 'src/', 'path retains trailing slash from command');
});

test('root-cause step 1b: _isUnresolvablePath allows directory paths (only blocks . and /)', () => {
  // These directory-like paths pass through:
  const cases = ['src/', 'lib/', 'public/', '/workspace/'];
  for (const dir of cases) {
    const r = parseBashFileRead(`grep -rn "x" ${dir}`);
    assert.notEqual(r, null, `${dir} should NOT be blocked by _isUnresolvablePath`);
  }
});

// ─── Step 2: canonicalizePath strips trailing slash ───────────────────────────

test('root-cause step 2: canonicalizePath strips trailing slash from directory', () => {
  const canon = canonicalizePath('src/', CWD);
  assert.equal(canon, '/workspace/src', 'no trailing slash after canonicalization');
  assert.ok(!canon.endsWith('/'), 'definitely no trailing slash');
});

// ─── Step 3: computeUpdate returns null for multi-file grep output (THE FIX) ─

test('root-cause step 3 (fixed): grep-n computeUpdate returns null for multi-file output', () => {
  // Recursive grep output format: filename:linenum:content
  const multiFileOutput = [
    'src/app.js:1:import express from "express";',
    'src/app.js:5:const app = express();',
    'src/routes.js:3:export default router;',
  ].join('\n');

  const input = { command: 'grep -rn "express" src/' };
  const update = bashAdapter.computeUpdate(input, multiFileOutput, CWD, CTP);

  assert.equal(update, null, 'computeUpdate returns null — no phantom entry created');
});

test('root-cause step 3b: single-file grep output DOES match (control case)', () => {
  // Single-file grep output format: linenum:content
  const singleFileOutput = [
    '1:import express from "express";',
    '5:const app = express();',
  ].join('\n');

  const input = { command: 'grep -n "express" src/app.js' };
  const update = bashAdapter.computeUpdate(input, singleFileOutput, CWD, CTP);

  assert.notEqual(update, null);
  assert.equal(update.type, 'lineUpdate');
  assert.ok(update.lines.length === 2, 'both lines matched');
  assert.ok(update.spent > 10, 'spent includes actual line tokens');
});

// ─── Step 4-5: BRebuild produces pathTotal = 10 for directory entry ──────────

test('root-cause step 4-5: BRebuild entry for directory has total=0 + overhead=10 → snapshot tokens=10', () => {
  const br = new BRebuild();

  // Simulate: extractPath canonicalizes 'src/' → '/workspace/src'
  const dirPath = canonicalizePath('src/', CWD);

  // Simulate: computeUpdate returns empty lineUpdate with overhead
  const update = { type: 'lineUpdate', lines: [], overhead: 10, spent: 10 };
  br.apply(update, dirPath, 1, 1);

  // Check internal state
  const entry = br.paths.get(dirPath);
  assert.ok(entry, 'entry exists for /workspace/src');
  assert.equal(entry.total, 0, 'total is 0 — no line content');
  assert.equal(entry.overhead, 10, 'overhead = TOOL_OVERHEAD.Bash');
  assert.equal(entry.editDelta, 0);
  assert.equal(entry.correction, 0);

  // snapshot produces token=10 phantom
  const snap = br.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].path, '/workspace/src');
  assert.equal(snap[0].tokens, 10, 'phantom: total(0) + editDelta(0) + overhead(10) - correction(0) = 10');
});

// ─── Step 6: foldPaths filter is ineffective ─────────────────────────────────

test('root-cause step 6: foldPaths trailing-slash filter does not catch canonicalized dir paths', () => {
  // The filter is: paths.filter(p => !p.path.endsWith('/'))
  // After canonicalization, directory paths do NOT end with '/'
  const dirPath = canonicalizePath('src/', CWD);
  assert.ok(!dirPath.endsWith('/'), 'canonicalized dir has no trailing slash');

  // So the filter would KEEP this entry:
  const paths = [{ path: dirPath, tokens: 10 }];
  const filtered = paths.filter(p => !p.path.endsWith('/'));
  assert.equal(filtered.length, 1, 'filter fails to exclude canonicalized directory path');
});

// ─── Step 7: buildTree creates both a dir node AND a file leaf with same name ─

test('root-cause step 7: buildTree produces duplicate — dir node AND file leaf for same path', () => {
  const base = {
    dead: 0, skills: [], residual: { bash: [], mcp: [] },
    totalB: 0, totalL: 0, totalResidual: 0, totalResidualRaw: 0,
    ctpOvershootRatio: 0, currentTurnSeq: 0, segment: 0,
  };

  // This is the bug scenario: '/workspace/src' as a 10-token phantom alongside
  // real files under '/workspace/src/'
  const tree = buildTree({
    ...base,
    paths: [
      { path: '/workspace/src', tokens: 10, lastTurn: 1 },          // phantom dir entry
      { path: '/workspace/src/app.js', tokens: 500, lastTurn: 2 },  // real file
      { path: '/workspace/src/routes.js', tokens: 300, lastTurn: 3 }, // real file
    ],
  });

  // Flatten tree to inspect all nodes
  function flatten(nodes, out = []) {
    for (const n of nodes) { out.push(n); if (n.children) flatten(n.children, out); }
    return out;
  }
  const all = flatten(tree);

  // Find the dir node for 'src'
  const dirNodes = all.filter(n => n.kind === 'dir' && n.displayName && n.displayName.includes('src'));
  // Find the file leaf that represents the phantom '/workspace/src' directory
  const phantomLeaves = all.filter(n => n.kind === 'file' && n.tokens === 10);

  // THE BUG: both exist simultaneously
  assert.ok(dirNodes.length > 0, 'dir node "src" exists (for the real files)');
  assert.ok(phantomLeaves.length > 0, 'phantom file leaf with 10 tokens exists');

  // The phantom leaf displays a name that looks like a directory segment
  const phantom = phantomLeaves[0];
  assert.ok(
    phantom.displayName === 'src' || phantom.name === 'src',
    `phantom displays as directory name: got displayName="${phantom.displayName}", name="${phantom.name}"`,
  );
});

// ─── Full end-to-end: fix prevents phantom from being created ────────────────

test('end-to-end (fixed): recursive grep on directory does NOT create phantom entry', () => {
  const br = new BRebuild();

  // 1. Normal file reads create real entries (need files outside src/ too, so buildTree creates a dir node)
  br.apply({ type: 'fullSet', lines: [[1, 50], [2, 60], [3, 40]], overhead: 10, spent: 160 }, '/workspace/src/app.js', 1, 1);
  br.apply({ type: 'fullSet', lines: [[1, 30], [2, 45]], overhead: 10, spent: 85 }, '/workspace/src/routes.js', 2, 2);
  br.apply({ type: 'fullSet', lines: [[1, 20]], overhead: 10, spent: 30 }, '/workspace/config.js', 3, 3);

  // 2. A recursive grep on 'src/' — computeUpdate now returns null
  const grepInput = { command: 'grep -rn "express" src/' };
  const grepOutput = 'src/app.js:1:import express from "express";\nsrc/app.js:5:const app = express();';
  const grepPath = bashAdapter.extractPath(grepInput, CWD);
  const grepUpdate = bashAdapter.computeUpdate(grepInput, grepOutput, CWD, CTP);

  assert.equal(grepPath, '/workspace/src', 'extractPath still canonicalizes');
  assert.equal(grepUpdate, null, 'computeUpdate returns null — no phantom');

  // apply with null update is a no-op
  br.apply(grepUpdate, grepPath, 4, 4);

  // 3. Snapshot does NOT contain the directory phantom
  const snap = br.snapshot();
  const phantom = snap.find(p => p.path === '/workspace/src');
  assert.equal(phantom, undefined, 'no phantom entry for /workspace/src');

  const realFiles = snap.filter(p => p.path.includes('.js'));
  assert.equal(realFiles.length, 3, 'real files still tracked');

  // 4. buildTree has no duplication — dir node for src exists, no phantom leaf
  const base = {
    dead: 0, skills: [], residual: { bash: [], mcp: [] },
    totalB: 0, totalL: 0, totalResidual: 0, totalResidualRaw: 0,
    ctpOvershootRatio: 0, currentTurnSeq: 0, segment: 0,
  };
  const tree = buildTree({ ...base, paths: snap });

  function flatten(nodes, out = []) {
    for (const n of nodes) { out.push(n); if (n.children) flatten(n.children, out); }
    return out;
  }
  const all = flatten(tree);

  // src/ dir node groups app.js + routes.js; config.js is a standalone leaf
  const dirNodes = all.filter(n => n.kind === 'dir');
  const phantomLeaves = all.filter(n => n.kind === 'file' && n.tokens === 10);
  assert.ok(dirNodes.length > 0, 'dir node for src exists (groups the real files)');
  assert.equal(phantomLeaves.length, 0, 'no phantom file leaf');
});
