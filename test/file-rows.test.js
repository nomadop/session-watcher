// The rows of one file's lines, `public/lib/fileRows.js`: which rows an open file shows, and the elements that draw them through whichever `h` the caller hands over, so the DSH tab's React tree and the dashboard's DOM are drawn from the same rows.
// `h` here builds plain objects, so the expected values state each element, class and attribute the style and the screen reader read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanText, bodyRowsOf, fileRows } from '../public/lib/fileRows.js';

const FOUR = () => 'abcd';
/** The lines `first` to `last` as one run, each a text of `text(number)`. */
const run = (first, last, text = FOUR) => ({ offset: first, lines: Array.from({ length: last - first + 1 }, (_, at) => ({ number: first + at, text: text(first + at) })) });
const lineRow = (number, text = 'abcd') => ({ type: 'line', number, text });

// ── spanText ──────────────────────────────────────────────────────────────────

test('a span of one line is that line and any other is its first and last line with a dash between', () => {
  assert.equal(spanText([7, 7]), '7');
  assert.equal(spanText([7, 12]), '7–12');
});

// ── bodyRowsOf ────────────────────────────────────────────────────────────────

test('an open file shows its lines in order with a gap row between what is not shown and a withdrawn row where lines were withdrawn, and a gap to the end of the file', () => {
  const item = { skill: false, total: 200, runs: [run(1, 3), run(10, 11)], withdrawn: [{ first: 5, last: 6 }] };
  assert.deepEqual(bodyRowsOf(item), [
    lineRow(1), lineRow(2), lineRow(3), { type: 'gap', first: 4, last: 4 }, { type: 'withdrawn', first: 5, last: 6 }, { type: 'gap', first: 7, last: 9 },
    lineRow(10), lineRow(11), { type: 'gap', first: 12, last: 200 },
  ]);
});

test('a file whose line count is not known has no gap to its end, and one whose last line is shown has none either', () => {
  assert.deepEqual(bodyRowsOf({ skill: false, total: null, runs: [run(5, 6)], withdrawn: [] }), [{ type: 'gap', first: 1, last: 4 }, lineRow(5), lineRow(6)]);
  assert.deepEqual(bodyRowsOf({ skill: false, total: 3, runs: [run(1, 3)], withdrawn: [] }), [lineRow(1), lineRow(2), lineRow(3)]);
  assert.deepEqual(bodyRowsOf({ skill: false, total: null, runs: [], withdrawn: [{ first: 1, last: 4 }] }), [{ type: 'withdrawn', first: 1, last: 4 }]);
});

test('a gap stops at the end of the file, and lines withdrawn past it are still said', () => {
  assert.deepEqual(bodyRowsOf({ skill: false, total: 10, runs: [run(1, 2)], withdrawn: [{ first: 12, last: 14 }] }), [
    lineRow(1), lineRow(2), { type: 'gap', first: 3, last: 10 }, { type: 'withdrawn', first: 12, last: 14 },
  ]);
  assert.deepEqual(bodyRowsOf({ skill: false, total: 2, runs: [run(1, 2)], withdrawn: [{ first: 5, last: 5 }] }), [lineRow(1), lineRow(2), { type: 'withdrawn', first: 5, last: 5 }]);
});

test('a span inside a span already shown does not move the place the next gap starts from', () => {
  assert.deepEqual(bodyRowsOf({ skill: false, total: 12, runs: [run(2, 8)], withdrawn: [{ first: 3, last: 4 }] }), [
    { type: 'gap', first: 1, last: 1 }, lineRow(2), lineRow(3), lineRow(4), lineRow(5), lineRow(6), lineRow(7), lineRow(8), { type: 'withdrawn', first: 3, last: 4 }, { type: 'gap', first: 9, last: 12 },
  ]);
});

test('a skill shows its text line by line with no line number', () => {
  assert.deepEqual(bodyRowsOf({ skill: true, text: 'a\n\nb' }), [
    { type: 'line', number: null, text: 'a' }, { type: 'line', number: null, text: '' }, { type: 'line', number: null, text: 'b' },
  ]);
});

// ── fileRows ──────────────────────────────────────────────────────────────────

const h = (tag, props, ...children) => ({ tag, props, children });
const words = { gap: range => `gap ${range}`, withdrawn: (range, count) => `withdrawn ${range} x${count}` };

const line = (key, number, text) => h('div', { className: 'sw-fl-row', key }, h('div', { className: 'sw-fl-n' }, number), h('div', { className: 'sw-fl-t' }, text));
const gap = (key, text) => h('div', { className: 'sw-fl-sep', key }, h('span', null, text));
const withdrawn = (key, text) => h('div', { className: 'sw-fl-wd', key }, h('span', null, h('b', { 'aria-hidden': 'true' }, '−'), text));
const scroll = (wrap, ...rows) => h('div', { className: 'sw-fl-scroll', 'data-wrap': wrap }, h('div', { className: 'sw-fl-rows' }, rows));

test('each row is drawn by its kind, a line with its number and its text, a gap and a withdrawn row with the words the caller gives for their range, each keyed by its place', () => {
  const rows = bodyRowsOf({ skill: false, total: 12, runs: [run(2, 3, number => `<b>${number}</b>`)], withdrawn: [{ first: 5, last: 8 }] });
  assert.deepEqual(fileRows(h, rows, words), scroll(
    'on',
    gap(0, 'gap 1'), line(1, 2, '<b>2</b>'), line(2, 3, '<b>3</b>'), gap(3, 'gap 4'), withdrawn(4, 'withdrawn 5–8 x4'), gap(5, 'gap 9–12'),
  ));
});

test('a skill line has no number', () => {
  assert.deepEqual(fileRows(h, bodyRowsOf({ skill: true, text: 'a\n\nb' }), words), scroll('on', line(0, null, 'a'), line(1, null, ''), line(2, null, 'b')));
});

test('the lines wrap unless the caller says they do not, which the block carries as its own attribute', () => {
  const rows = [lineRow(1, 'x')];
  assert.equal(fileRows(h, rows, words, true).props['data-wrap'], 'on');
  assert.equal(fileRows(h, rows, words, false).props['data-wrap'], 'off');
  assert.equal(fileRows(h, rows, words).props['data-wrap'], 'on', 'wrapping is the default');
});

test('a file with no row is the block with none', () => {
  assert.deepEqual(fileRows(h, [], words), scroll('on'));
});
