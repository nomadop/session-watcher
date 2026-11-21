// `public/lib/domH.js`, the `h` the dashboard hands `fileRows`: elements of the page's `document`, drawn from the same calls the DSH tab draws with React.
// The repo has no DOM environment, so `document` is the two functions `domH` calls and the nodes they make hold what is set on them.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { domH } from '../public/lib/domH.js';
import { bodyRowsOf, fileRows } from '../public/lib/fileRows.js';

const element = tag => ({
  tag, attrs: {}, children: [],
  setAttribute(name, value) { this.attrs[name] = value; },
  appendChild(child) { this.children.push(child); return child; },
});

let saved;
beforeEach(() => {
  saved = globalThis.document;
  globalThis.document = { createElement: element, createTextNode: text => ({ text }) };
});
afterEach(() => {
  if (saved === undefined) delete globalThis.document;
  else globalThis.document = saved;
});

// A tree as `[tag, attrs, ...children]`, a text node as its text.
const shape = node => (node.tag === undefined ? node.text : [node.tag, node.attrs, ...node.children.map(shape)]);

test('an element carries its class as the class attribute and each other prop as a string attribute, and a key is no attribute', () => {
  assert.deepEqual(shape(domH('div', { className: 'a b', key: 3, 'data-wrap': 'on', 'aria-hidden': 'true' })), ['div', { class: 'a b', 'data-wrap': 'on', 'aria-hidden': 'true' }]);
});

test('a prop that is null, undefined or false sets nothing, and the props themselves may be null', () => {
  assert.deepEqual(shape(domH('span', { className: undefined, 'data-x': null, 'data-y': false, 'data-z': 0 })), ['span', { 'data-z': '0' }]);
  assert.deepEqual(shape(domH('span', null, 'x')), ['span', {}, 'x']);
});

test('a string or a number child is a text node, a zero included, and a null, undefined or false child is none', () => {
  assert.deepEqual(shape(domH('div', null, 'a', 7, 0, null, undefined, false, '')), ['div', {}, 'a', '7', '0', '']);
});

test('an array child is flattened in place and an element child is appended as it is', () => {
  const inner = domH('b', { 'aria-hidden': 'true' }, '−');
  assert.deepEqual(shape(domH('div', null, [domH('i'), [inner, 'x']], 'y')), ['div', {}, ['i', {}], ['b', { 'aria-hidden': 'true' }, '−'], 'x', 'y']);
});

test('the rows of a file are drawn as the same elements the React tree gets: the block, its rows, a line\'s number and text, a gap row, each as it is', () => {
  const rows = bodyRowsOf({ skill: false, total: 4, runs: [{ offset: 2, lines: [{ number: 2, text: 'b' }, { number: 3, text: 'c' }] }], withdrawn: [] });
  const tree = fileRows(domH, rows, { gap: range => `gap ${range}` }, false);
  assert.deepEqual(shape(tree), ['div', { class: 'sw-fl-scroll', 'data-wrap': 'off' },
    ['div', { class: 'sw-fl-rows' },
      ['div', { class: 'sw-fl-sep' }, ['span', {}, 'gap 1']],
      ['div', { class: 'sw-fl-row' }, ['div', { class: 'sw-fl-n' }, '2'], ['div', { class: 'sw-fl-t' }, 'b']],
      ['div', { class: 'sw-fl-row' }, ['div', { class: 'sw-fl-n' }, '3'], ['div', { class: 'sw-fl-t' }, 'c']],
      ['div', { class: 'sw-fl-sep' }, ['span', {}, 'gap 4']]]]);
});
