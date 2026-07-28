import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, deriveDirState, computeDirty, computeBPreview } from '../public/elements/bucketPanel.js';
// NOTE: deriveDirState is implemented in Task 5, imported here for integration testing with overrides.

function mkTree() {
  return [
    { id: 'skill:s', label: 'skill:s', kind: 'skill', selectable: true, defaultSelected: true, selected: true, tokens: 2000, children: null },
    { id: 'dir:paths:lib/', label: 'lib/', kind: 'dir', selectable: true, children: [
      { id: 'file:lib/a.js', label: 'lib/a.js', kind: 'file', selectable: true, defaultSelected: true, selected: true, tokens: 3000, children: null },
      { id: 'file:lib/b.js', label: 'lib/b.js', kind: 'file', selectable: true, defaultSelected: true, selected: true, tokens: 1000, children: null },
    ] },
    { id: 'bash:npm test', label: 'npm test', kind: 'bash', selectable: true, defaultSelected: false, selected: false, tokens: 12000, children: null },
    { id: 'others', label: 'others', kind: 'others', locked: true, selectable: false, tokens: 5000, children: null },
  ];
}

test('applyOverrides: leaf reverts to defaultSelected when no override', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map());
  assert.equal(tree[2].selected, false, 'bash reverts to default (unchecked)');
  assert.equal(tree[1].children[0].selected, true, 'file reverts to default (checked)');
});

test('applyOverrides: override wins over default', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map([['lib/a.js', false], ['npm test', true]]));
  assert.equal(tree[1].children[0].selected, false);
  assert.equal(tree[2].selected, true);
});

// deriveDirState pure tests are in Task 5's test/bucketPanel.summarize.test.js.
// Here we only test deriveDirState in combination with applyOverrides (integration).
test('deriveDirState + applyOverrides integration: override flips dir from checked to half', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map([['lib/a.js', false]]));
  assert.equal(deriveDirState(tree[1]), 'half', 'one child unchecked → half');
  applyOverrides(tree, new Map([['lib/a.js', false], ['lib/b.js', false]]));
  assert.equal(deriveDirState(tree[1]), 'unchecked', 'all children unchecked → unchecked');
});

test('computeDirty: false at default, true after a toggle', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map());
  assert.equal(computeDirty(tree), false, 'default = not dirty');
  applyOverrides(tree, new Map([['lib/a.js', false]]));
  assert.equal(computeDirty(tree), true);
});

test('computeBPreview: uncheck kept path subtracts, add discarded bash adds', () => {
  const tree = mkTree();
  const Bdefault = 50000;
  const empty = new Map();
  applyOverrides(tree, empty);
  assert.equal(computeBPreview(tree, Bdefault, empty), Bdefault, 'default → no delta');
  const uncheckA = new Map([['lib/a.js', false]]);
  applyOverrides(tree, uncheckA);
  assert.equal(computeBPreview(tree, Bdefault, uncheckA), Bdefault - 3000, 'uncheck kept path');
  const checkBash = new Map([['npm test', true]]);
  applyOverrides(tree, checkBash);
  assert.equal(computeBPreview(tree, Bdefault, checkBash), Bdefault + 12000, 'check discarded bash');
});

test('computeBPreview: floored at MIN_B_PREVIEW', () => {
  const tree = mkTree();
  const overrides = new Map([['skill:s', false], ['lib/a.js', false], ['lib/b.js', false]]);
  applyOverrides(tree, overrides);
  assert.ok(computeBPreview(tree, 1000, overrides) >= 1000, 'never below floor');
});
