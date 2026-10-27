// lib/line-align.js — the line primitives Resource Attribution shares: splitting text into lines, the
// normalization every comparison uses, the line fingerprint, the recognizer for generic line-number cues,
// and the order-preserving alignment of two arrays.
//
// A fingerprint is the only trace of a file line a record keeps, so `fingerprintOf` is defined here once
// and every stored `fp` depends on it. `alignOrdered` answers pairs of equal elements, compared with `===`,
// so one routine aligns normalized text (the matcher) and fingerprints (key relocation).
//
// `stripLinePrefix` runs on the raw line, before `normalizeLine`: a blank numbered line such as `4\t`
// normalizes to `4`, which is no longer a cue. It names no tool. It cannot tell a cue from content that starts
// like one: an unnumbered exact copy of such a line (a date, a time, `1: …`, `3-4 …`) has its start cut, never
// equals the file's line, and stays unmatched. The rest of what it answers is checked: a `declaredLine` is only
// accepted when the file's line equals the stripped text apart from leading whitespace, and a `path` only
// becomes a candidate when it stats to a regular file.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// ── Lines and fingerprints ───────────────────────────────────────────────────

// A final terminator opens no further line; the empty text has no line at all.
export function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// `trimEnd` rather than a `\s+$` pattern: a long whitespace run inside a line would make the pattern
// quadratic.
export function normalizeLine(line) {
  return line.trimEnd();
}

// FNV-1a 32-bit over UTF-16 code units, not UTF-8 bytes, so the hash needs no encoder in the synchronous
// callback; the result is an unsigned integer.
export function fingerprintOf(normalizedLine) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < normalizedLine.length; i++) {
    hash = Math.imul(hash ^ normalizedLine.charCodeAt(i), FNV_PRIME);
  }
  return hash >>> 0;
}

// ── Line-number cues ─────────────────────────────────────────────────────────

// Tried in order, first valid cue wins; `path` is set only by the colon form. The `N:` and `Line N:` forms
// give up one space after the colon whenever one follows, whether it separates the number from the line or
// is the first space of an indented line: a single-file `grep -n` prints `N:` and the line with nothing
// between, so the two cannot be told apart. `declaredRuns` in `lib/resource-attribution.js` absorbs the
// difference.
const CUES = [
  { pattern: /^ *(\d+)\t(.*)$/s, line: 1, text: 2 },
  { pattern: /^ *(\d+)→(.*)$/s, line: 1, text: 2 },
  { pattern: /^Line (\d+): ?(.*)$/s, line: 1, text: 2 },
  { pattern: /^(\d+): ?(.*)$/s, line: 1, text: 2 },
  { pattern: /^(.+?):(\d+):(.*)$/s, path: 1, line: 2, text: 3 },
  { pattern: /^(\d+)-(.*)$/s, line: 1, text: 2 },
  // The path of a context row is not kept: its separators are indistinguishable from the path's own dashes.
  { pattern: /^(\S+?)-(\d+)-(.*)$/s, line: 2, text: 3 },
];

export function stripLinePrefix(line) {
  for (const cue of CUES) {
    const match = cue.pattern.exec(line);
    if (!match) continue;
    const declaredLine = Number(match[cue.line]);
    // Line numbers are 1-based, and a digit run past the safe integers names no line.
    if (!Number.isSafeInteger(declaredLine) || declaredLine < 1) continue;
    return { text: match[cue.text], declaredLine, path: cue.path ? match[cue.path] : null };
  }
  return { text: line, declaredLine: null, path: null };
}

// ── Ordered alignment ────────────────────────────────────────────────────────

// An equal head or tail of at least `minTrim` elements pairs off position by position. A shorter one says
// nothing about a shared position (a window whose last line equals the file's last line is not at the file's
// end), so it stays in the middle. The tail is measured after the head, so the two never overlap.
function trimEnds(a, b, minTrim) {
  const shared = Math.min(a.length, b.length);
  let head = 0;
  while (head < shared && a[head] === b[head]) head++;
  if (!(head >= minTrim)) head = 0;
  const room = shared - head;
  let tail = 0;
  while (tail < room && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (!(tail >= minTrim)) tail = 0;
  return { head, tail, cells: (a.length - head - tail) * (b.length - head - tail) };
}

// The product of the two middle lengths: what `alignOrdered` compares with `maxCells`.
export function alignCells(a, b, { minTrim }) {
  return trimEnds(a, b, minTrim).cells;
}

// Pairs `[indexInA, indexInB]`, ascending in both. Null when the middle product exceeds `maxCells`; a
// `maxCells` that is not a number also answers null, so a missing bound never means an unbounded table.
// The middle is a longest common subsequence, walked forward over a suffix table: an equal pair is always
// taken, which puts duplicates at their earliest position, and a tie between dropping from `a` or from `b`
// drops from `b`, which keeps the earlier element of `a`.
export function alignOrdered(a, b, { maxCells, minTrim }) {
  const { head, tail, cells } = trimEnds(a, b, minTrim);
  if (!(cells <= maxCells)) return null;

  const pairs = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n > 0 && m > 0) {
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = a[head + i] === b[head + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] > lcs[i * width + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}
