// lib/working-tree-text.js — the one read of Working Tree text that shows file lines to a model: which lines of
// a file a caller asked for, why a file cannot be read, and the compact rendering of such lines, a file's path once
// over its runs of numbered lines. The text is the tree's, so a line number here is the one Resource Attribution
// matches against (`splitLines` in `lib/line-align.js`), and its `N: text` rows are the ones the `read` tool prints,
// minus its cut of a long line (ADR 0030); `test/dsh.load.integration.test.js` `each row of a block` compares them on
// the real tool.
//
// `readableText` is the judgement of whether a file's text may be used at all, which the matcher
// (`readCandidates` in `lib/resource-attribution.js`) and `readTreeWindows` share: the size limit is decided
// from the `stat` the caller holds before the text is asked for, and a text with a NUL is binary.
import { splitLines } from './line-align.js';

const unreadable = reason => ({ status: 'unreadable', reason });

/**
 * Whether the text of a regular file may be used, and the text. `stat` is the tree's answer for `key`, of which
 * only `size` is read; a file over `fileBytes` is `too-large` without its text being asked for, a text the tree
 * cannot give is `unreadable`, and one holding a NUL is `binary`.
 * @returns {{ status: 'readable', text: string } | { status: 'unreadable', reason: 'too-large'|'unreadable'|'binary' }}
 */
export function readableText(tree, key, { size }, { fileBytes }) {
  if (size > fileBytes) return unreadable('too-large');
  const text = tree.readText(key);
  if (text === null) return unreadable('unreadable');
  if (text.includes('\u0000')) return unreadable('binary');
  return { status: 'readable', text };
}

/**
 * The lines of `key` that `ranges`, each `{ offset, limit }`, ask for: a window `{ offset, lines: [{ number, text }] }`
 * for every range that holds a line, in the order asked, and the file's `totalLines`.
 * A line past the file's end is dropped, and a range left with no line has no window, except a range at line 1 of an
 * empty file, whose window holds no line. A file that cannot be read answers its `reason`: `missing`, `not-file`,
 * `too-large`, `binary` or `unreadable`.
 * @returns {{ status: 'readable', totalLines: number, windows: { offset: number, lines: { number: number, text: string }[] }[] }
 *   | { status: 'unreadable', reason: string }}
 */
export function readTreeWindows(tree, key, ranges, { fileBytes }) {
  const stat = tree.stat(key);
  if (stat === null) return unreadable('missing');
  if (!stat.isFile) return unreadable('not-file');
  const judged = readableText(tree, key, stat, { fileBytes });
  if (judged.status !== 'readable') return judged;

  const all = splitLines(judged.text);
  const windows = [];
  for (const { offset, limit } of ranges) {
    const lines = all.slice(offset - 1, offset - 1 + limit).map((text, index) => ({ number: offset + index, text }));
    if (lines.length > 0 || (all.length === 0 && offset === 1)) windows.push({ offset, lines });
  }
  return { status: 'readable', totalLines: all.length, windows };
}

// ── Compact evidence ─────────────────────────────────────────────────────────

const headerOf = (displayPath, totalLines) => `${displayPath} (total lines: ${totalLines})`;
const SEPARATOR = '--';
/** The row a line is shown as: its number, a colon and a space, then its text. */
export const rowOf = ({ number, text }) => `${number}: ${text}`;
const noticeOf = endLine => `(Output capped after line ${endLine}. Use offset=${endLine + 1} to continue.)`;

// Whether a run opening at line `first` is set apart from what the block shows before it, `previous` when that is
// anything: the last line shown, and whether the notice follows it. A run whose first line follows on the last line shown
// runs on from it, so the block shows them as one stretch.
const apartFrom = (previous, first) => previous !== null && (previous.capped || first !== previous.last + 1);

// The largest count of leading `lines` whose block, the separator line when `apart` and, when lines are left out, the
// notice of where to continue fit in `room`, with the block's length; 0 when none does. Not monotone in the count: the
// whole run carries no notice.
function fittingLines(lines, room, apart) {
  let rows = apart ? 1 + SEPARATOR.length : 0;
  let best = { count: 0, length: 0 };
  lines.forEach((line, index) => {
    rows += 1 + rowOf(line).length;
    const left = index + 1 < lines.length;
    const length = rows + (left ? 1 + noticeOf(line.number).length : 0);
    if (length <= room) best = { count: index + 1, length };
  });
  return best;
}

/**
 * One file's lines as evidence for a model: the path once with the file's `totalLines`, then the numbered rows of its
 * runs, so no run repeats a path or a footer. A run that does not follow on the last line shown, and any run after a
 * capped one, is set apart by a line `--`, as grep and rg set apart matches that are not contiguous; runs whose line
 * numbers are consecutive are one stretch. A run is `{ lines: [{ number, text }] }`, which prints nothing without a
 * line (how an empty file reads). No line is cut for its length. The `--` line only marks a gap; the text is no patch.
 * With `maxChars`, the whole `text` fits by its `.length`: the runs take the room in order, a run that does not fit ends
 * at the last whole line that does, followed by the notice of where to continue, and a run of which no line fits is left
 * out. `shown[i]` counts the lines of run `i` in `text`. `null` when the header alone exceeds `maxChars`, or no line of a
 * run that has some fits.
 * @returns {{ text: string, shown: number[] } | null}
 */
export function renderFileEvidence(displayPath, { totalLines, runs }, { maxChars = Infinity } = {}) {
  const header = headerOf(displayPath, totalLines);
  const whole = [header];
  let previous = null;
  for (const { lines } of runs) {
    if (lines.length === 0) continue;
    if (apartFrom(previous, lines[0].number)) whole.push(SEPARATOR);
    whole.push(...lines.map(rowOf));
    previous = { last: lines.at(-1).number, capped: false };
  }
  const text = whole.join('\n');
  const available = runs.map(({ lines }) => lines.length);
  if (text.length <= maxChars) return { text, shown: available };

  let room = maxChars - header.length;
  if (room < 0) return null;
  const parts = [header];
  const shown = runs.map(() => 0);
  previous = null;
  runs.forEach(({ lines }, at) => {
    if (lines.length === 0) return;
    const apart = apartFrom(previous, lines[0].number);
    const { count, length } = fittingLines(lines, room, apart);
    if (count === 0) return;
    const taken = lines.slice(0, count);
    const capped = count < lines.length;
    parts.push(...(apart ? [SEPARATOR] : []), ...taken.map(rowOf), ...(capped ? [noticeOf(taken.at(-1).number)] : []));
    shown[at] = count;
    previous = { last: taken.at(-1).number, capped };
    room -= length;
  });
  return shown.every(count => count === 0) && available.some(count => count > 0) ? null : { text: parts.join('\n'), shown };
}
