import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenLeaves, deriveDirState, summarize, donutSegments } from '../public/elements/bucketPanel.js';

// Minimal hand-built tree with a directory whose aggregate MUST be excluded from totals.
const tree = [
  { kind: 'system', locked: true, tokens: 8500, children: null },
  { kind: 'skill', locked: false, selected: true, tokens: 2000, children: null },
  { kind: 'dir', locked: false, tokens: 9999 /* aggregate — must be ignored */, children: [
    { kind: 'file', locked: false, selected: true, tokens: 5000, children: null },
    { kind: 'file', locked: false, selected: false, tokens: 1000, children: null },
  ] },
  { kind: 'bash', locked: false, selected: false, tokens: 3000, children: null },
  { kind: 'others', locked: true, tokens: 4000, children: null },
];

test('flattenLeaves excludes directory rows', () => {
  const leaves = flattenLeaves(tree);
  assert.ok(!leaves.some(n => n.kind === 'dir'), 'no dir nodes among leaves');
  assert.equal(leaves.length, 6, 'system, skill, 2 files, bash, others — dir excluded');
});

test('summarize: leaf-only fixed/selected/discarded', () => {
  const s = summarize(tree);
  assert.equal(s.fixed, 8500, 'system prompt only');
  assert.equal(s.selected, 2000 + 5000, 'checked skill + checked file');
  assert.equal(s.discarded, 1000 + 3000 + 4000, 'unchecked file + unchecked bash + locked others');
  assert.equal(s.total, s.fixed + s.selected + s.discarded);
  // Directory aggregate (9999) never contributes
  assert.notEqual(s.total, 8500 + 2000 + 9999 + 3000 + 4000);
});

test('donutSegments: three independent arcs summing to circumference', () => {
  const seg = donutSegments({ fixed: 10, selected: 30, discarded: 60 });
  const arc = (dash) => parseFloat(dash.dasharray.split(' ')[0]);
  const total = arc(seg.system) + arc(seg.selected) + arc(seg.discarded);
  assert.ok(Math.abs(total - 88) < 0.5, 'arcs sum to DONUT_CIRCUMFERENCE (88)');
  assert.equal(seg.system.dashoffset, 0);
});

test('donutSegments: total=0 → zero-length arcs (no NaN)', () => {
  const seg = donutSegments({ fixed: 0, selected: 0, discarded: 0 });
  assert.ok(!Number.isNaN(parseFloat(seg.selected.dasharray)), 'no NaN');
});

test('deriveDirState: checked/unchecked/half from descendant leaves', () => {
  assert.equal(deriveDirState([{ selected: true, selectable: true, children: null }, { selected: true, selectable: true, children: null }]), 'checked');
  assert.equal(deriveDirState([{ selected: false, selectable: true, children: null }, { selected: false, selectable: true, children: null }]), 'unchecked');
  assert.equal(deriveDirState([{ selected: true, selectable: true, children: null }, { selected: false, selectable: true, children: null }]), 'half');
});

test('deriveDirState: nested dir → half when a grandchild is unchecked', () => {
  const parent = { kind: 'dir', selectable: true, children: [
    { kind: 'dir', selectable: true, children: [
      { kind: 'file', selectable: true, selected: true, children: null },
      { kind: 'file', selectable: true, selected: false, children: null },
    ] },
  ] };
  assert.equal(deriveDirState(parent), 'half');
});

test('deriveDirState: zero selectable descendants → unchecked', () => {
  assert.equal(deriveDirState({ kind: 'dir', children: [{ selectable: false, children: null }] }), 'unchecked');
  assert.equal(deriveDirState([]), 'unchecked');
});
