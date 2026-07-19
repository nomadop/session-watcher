import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, deriveDirState, computeDirty, computeBPreview } from '../public/elements/bucketPanel.js';
// NOTE: deriveDirState is implemented in Task 5, imported here for integration testing with overrides.

function mkTree() {
  return [
    { id: 'skill:s', kind: 'skill', selectable: true, defaultSelected: true, selected: true, tokens: 2000, children: null },
    { id: 'dir:paths:lib/', kind: 'dir', selectable: true, children: [
      { id: 'file:lib/a.js', kind: 'file', selectable: true, defaultSelected: true, selected: true, tokens: 3000, children: null },
      { id: 'file:lib/b.js', kind: 'file', selectable: true, defaultSelected: true, selected: true, tokens: 1000, children: null },
    ] },
    { id: 'bash:npm test', kind: 'bash', selectable: true, defaultSelected: false, selected: false, tokens: 12000, children: null },
    { id: 'others', kind: 'others', locked: true, selectable: false, tokens: 5000, children: null },
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
  applyOverrides(tree, new Map([['file:lib/a.js', false], ['bash:npm test', true]]));
  assert.equal(tree[1].children[0].selected, false);
  assert.equal(tree[2].selected, true);
});

// deriveDirState pure tests are in Task 5's test/bucketPanel.summarize.test.js.
// Here we only test deriveDirState in combination with applyOverrides (integration).
test('deriveDirState + applyOverrides integration: override flips dir from checked to half', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map([['file:lib/a.js', false]]));
  assert.equal(deriveDirState(tree[1]), 'half', 'one child unchecked → half');
  applyOverrides(tree, new Map([['file:lib/a.js', false], ['file:lib/b.js', false]]));
  assert.equal(deriveDirState(tree[1]), 'unchecked', 'all children unchecked → unchecked');
});

test('computeDirty: false at default, true after a toggle', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map());
  assert.equal(computeDirty(tree), false, 'default = not dirty');
  applyOverrides(tree, new Map([['file:lib/a.js', false]]));
  assert.equal(computeDirty(tree), true);
});

test('computeBPreview: uncheck kept path subtracts, add discarded bash adds', () => {
  const tree = mkTree();
  const Bdefault = 50000;
  applyOverrides(tree, new Map());
  assert.equal(computeBPreview(tree, Bdefault), Bdefault, 'default → no delta');
  applyOverrides(tree, new Map([['file:lib/a.js', false]]));
  assert.equal(computeBPreview(tree, Bdefault), Bdefault - 3000, 'uncheck kept path');
  applyOverrides(tree, new Map([['bash:npm test', true]]));
  assert.equal(computeBPreview(tree, Bdefault), Bdefault + 12000, 'check discarded bash');
});

test('computeBPreview: floored at MIN_B_PREVIEW', () => {
  const tree = mkTree();
  applyOverrides(tree, new Map([['skill:s', false], ['file:lib/a.js', false], ['file:lib/b.js', false]]));
  assert.ok(computeBPreview(tree, 1000) >= 1000, 'never below floor');
});
