// test/bucketPanel.override-delta.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, flattenLeaves } from '../public/elements/bucketPanel.js';

test('delta computation: toggled leaves produce correct override payload', () => {
  const bd = {
    dead: 1000,
    skills: [],
    paths: [
      { path: 'src/a.js', tokens: 500, defaultSelected: true, defaultDiscardReason: null, userOverride: null },
      { path: 'src/b.js', tokens: 300, defaultSelected: true, defaultDiscardReason: null, userOverride: null },
      { path: 'dist/x.js', tokens: 200, defaultSelected: false, defaultDiscardReason: 'gitignore', userOverride: null },
    ],
    residual: { bash: [], mcp: [], agent: [] },
    totalB: 2000, totalL: 3000, totalResidual: 0, totalResidualRaw: 0,
    ctpOvershootRatio: 0, currentTurnSeq: 1, segment: 0,
  };

  const tree = buildTree(bd);
  const leaves = flattenLeaves(tree).filter(n => n.selectable);

  // Simulate: user excludes src/a.js, includes dist/x.js
  const aLeaf = leaves.find(l => l.label === 'src/a.js');
  const xLeaf = leaves.find(l => l.label === 'dist/x.js');
  assert.ok(aLeaf && xLeaf);
  aLeaf.selected = false;
  xLeaf.selected = true;

  // Compute delta (logic from spec §4.5)
  const overrides = {};
  for (const leaf of leaves) {
    if (leaf.selected && !leaf.defaultSelected) {
      overrides[leaf.label] = 'include';
    } else if (!leaf.selected && leaf.defaultSelected) {
      overrides[leaf.label] = 'exclude';
    }
  }

  assert.deepEqual(overrides, { 'src/a.js': 'exclude', 'dist/x.js': 'include' });
});

test('delta computation: inferred override reflected in selected state is included in payload', () => {
  const bd = {
    dead: 1000,
    skills: [],
    paths: [
      { path: 'src/a.js', tokens: 500, defaultSelected: true, defaultDiscardReason: null, userOverride: 'exclude' },
    ],
    residual: { bash: [], mcp: [], agent: [] },
    totalB: 2000, totalL: 3000, totalResidual: 0, totalResidualRaw: 0,
    ctpOvershootRatio: 0, currentTurnSeq: 1, segment: 0,
  };

  const tree = buildTree(bd);
  const leaves = flattenLeaves(tree).filter(n => n.selectable);
  const aLeaf = leaves.find(l => l.label === 'src/a.js');
  // With userOverride='exclude', the frontend should show it as unchecked
  // (the applyOverrides in mount() handles this; but buildTree sets defaultSelected from discardReason)
  // The leaf's `defaultSelected` is still true (from discardReason), but the displayed state
  // after applying backend override should be false
  aLeaf.selected = false; // simulating after applyOverrides with backend state

  const overrides = {};
  for (const leaf of leaves) {
    if (leaf.selected && !leaf.defaultSelected) {
      overrides[leaf.label] = 'include';
    } else if (!leaf.selected && leaf.defaultSelected) {
      overrides[leaf.label] = 'exclude';
    }
  }

  assert.deepEqual(overrides, { 'src/a.js': 'exclude' });
});
