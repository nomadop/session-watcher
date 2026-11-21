// public/lib/fileRows.js — the rows of one file's lines, shared by the dashboard's file drawer and the DSH tab's evidence and files pages: which rows an open file shows (its lines, the lines no run shows, the lines withdrawn) and the elements that draw them.
// It holds no state, no wording and no framework: `h` is `(tag, props, ...children) => node` and each text comes from the caller's `words`, so a React tree and a DOM tree are drawn from the same rows. The style is `public/themes/file-rows.css`.

/** A span of lines as `[first, last]` as the list writes it: the one line, or the first and the last. */
export const spanText = ([first, last]) => (first === last ? String(first) : `${first}–${last}`);

/** The lines of a text as `splitLines` of `lib/line-align.js`, the host's one reading of lines, has them. */
export function linesOf(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The rows an open file shows, in the order of the file: a `line` row `{ type, number, text }` for each line of its runs, a `gap` row `{ type, first, last }` for the lines of the file that no run shows, and a `withdrawn` row for the lines it withdrew, the rows of the spans placed by their first line.
 * A gap stops at the file's end where its line count is known, and there is a gap to the end too; where it is not, a gap opens the file but none closes it. A skill shows its text line by line, with no number.
 * `item` is `{ skill, text, total, runs, withdrawn }`: a skill's `text`, else the file's line count `total` (null where unknown), its `runs` `{ offset, lines: [{ number, text }] }` and the `withdrawn` spans `{ first, last }`.
 */
export function bodyRowsOf({ skill, text, total, runs, withdrawn }) {
  if (skill) return linesOf(text).map(line => ({ type: 'line', number: null, text: line }));
  const spans = [
    ...runs.map(run => ({ type: 'run', run, first: run.offset, last: run.offset + run.lines.length - 1 })),
    ...withdrawn.map(({ first, last }) => ({ type: 'withdrawn', first, last })),
  ].sort((a, b) => a.first - b.first);
  const known = Number.isFinite(total);
  const rows = [];
  let next = 1;
  const gap = (first, last) => {
    const end = known ? Math.min(last, total) : last;
    if (first <= end) rows.push({ type: 'gap', first, last: end });
  };
  for (const span of spans) {
    gap(next, span.first - 1);
    if (span.type === 'run') rows.push(...span.run.lines.map(line => ({ type: 'line', number: line.number, text: line.text })));
    else rows.push({ type: 'withdrawn', first: span.first, last: span.last });
    next = Math.max(next, span.last + 1);
  }
  if (known) gap(next, total);
  return rows;
}

function rowOf(h, row, key, words) {
  switch (row.type) {
    case 'gap': return h('div', { className: 'sw-fl-sep', key }, h('span', null, words.gap(spanText([row.first, row.last]))));
    case 'withdrawn': return h('div', { className: 'sw-fl-wd', key }, h('span', null, h('b', { 'aria-hidden': 'true' }, '−'), words.withdrawn(spanText([row.first, row.last]), row.last - row.first + 1)));
    default: return h('div', { className: 'sw-fl-row', key }, h('div', { className: 'sw-fl-n' }, row.number), h('div', { className: 'sw-fl-t' }, row.text));
  }
}

/**
 * The block of `rows`, the output of `bodyRowsOf`: `.sw-fl-scroll[data-wrap]` over `.sw-fl-rows` over one element per row, each keyed by its place. `words.gap(range)` and `words.withdrawn(range, count)` give the text of a gap and of a withdrawn row, `range` being `spanText` of its lines; the lines wrap unless `wrap` is false.
 * `h` is called with a string tag, props that are null or limited to `className`, `key`, `aria-hidden` and `data-*`, and children that are strings, numbers, arrays, null or nodes `h` returned.
 */
export function fileRows(h, rows, words, wrap = true) {
  return h('div', { className: 'sw-fl-scroll', 'data-wrap': wrap ? 'on' : 'off' },
    h('div', { className: 'sw-fl-rows' }, rows.map((row, at) => rowOf(h, row, at, words))));
}
