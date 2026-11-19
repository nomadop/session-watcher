// dsh/src/client/monitor-files-model.js — the display model of the evidence page and the handoff files page: the groups and files each lists as plain data with the texts already worded, the rows an open file shows, the shortened path and the view state of the list.
// The React list renders this one model, so the two pages never disagree on what a file says. It imports the pure state module beside it and nothing else, so Node and the browser bundle load it alike.
import { NOT_AVAILABLE, PART_SEPARATOR } from './monitor-state.js';

const PERCENT = 100;
const SPAN_SEPARATOR = ', ';
const LINES_PER_KILO = 1000;

/** A count as the list writes it: a whole number under a thousand, else thousands, then millions, to one decimal, with `k` and `m`. A count that rounds up into the next unit reads in that unit. */
export function compactCount(count) {
  if (count < LINES_PER_KILO) return String(count);
  const tenthsOfKilo = Math.round(count / (LINES_PER_KILO / 10));
  if (tenthsOfKilo < LINES_PER_KILO * 10) return `${Math.floor(tenthsOfKilo / 10)}.${tenthsOfKilo % 10}k`;
  const tenthsOfMega = Math.round(count / (LINES_PER_KILO * 100));
  return `${Math.floor(tenthsOfMega / 10)}.${tenthsOfMega % 10}m`;
}

/** The longest directory, ending in a slash, that all of `paths` lie in, a directory being compared whole; none, the empty text, where they share none or only the filesystem root. */
export function commonRoot(paths) {
  const directories = paths.map(path => path.split('/').slice(0, -1));
  const [first = [], ...rest] = directories;
  let shared = first.length;
  for (const directory of rest) {
    for (let at = 0; at < shared; at += 1) {
      if (directory[at] !== first[at]) {
        shared = at;
        break;
      }
    }
  }
  const root = first.slice(0, shared).join('/');
  return root === '' ? '' : `${root}/`;
}

// What a path column of the list holds before a path is shortened: a directory, a name, and what the two keep around an ellipsis.
const DIR_COLUMNS = 30;
const BASE_COLUMNS = 34;
const HEAD_SHARE = 0.55;
const TAIL_SHARE = 0.35;
// A character of the East Asian wide ranges and an emoji take two columns of the monospace text.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

const columnsOf = text => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

// The leading characters of `chars` that fit in `room` columns.
function fitting(chars, room) {
  const taken = [];
  let used = 0;
  for (const char of chars) {
    used += columnsOf(char);
    if (used > room) break;
    taken.push(char);
  }
  return taken;
}

// `text` as it is when it fits in `max` columns, else its head and its tail around an ellipsis, no character split.
function cutMiddle(text, max) {
  if (columnsOf(text) <= max) return text;
  const chars = [...text];
  const head = fitting(chars, Math.floor(max * HEAD_SHARE));
  const tail = fitting(chars.reverse(), Math.floor(max * TAIL_SHARE)).reverse();
  return `${head.join('')}…${tail.join('')}`;
}

// A directory (ending in a slash) as it is when it fits, else its first segment and the last ones that fit around an ellipsis, the leading slash of an absolute one kept; where not even the last one fits beside the first, cut in the middle.
function compactDirectory(directory) {
  if (columnsOf(directory) <= DIR_COLUMNS) return directory;
  const lead = directory.startsWith('/') ? '/' : '';
  const segments = directory.split('/').filter(segment => segment !== '');
  const tail = [];
  for (let at = segments.length - 1; at > 0; at -= 1) {
    if (columnsOf(`${lead}${segments[0]}/…/${[segments[at], ...tail].join('/')}/`) > DIR_COLUMNS) break;
    tail.unshift(segments[at]);
  }
  return tail.length === 0 ? cutMiddle(directory, DIR_COLUMNS) : `${lead}${segments[0]}/…/${tail.join('/')}/`;
}

/**
 * A path as a row shows it, `{ dir, base, cut }`: its directory, which ends in a slash, and its name, each shortened where it is longer than its column, and `cut`, whether either was.
 * The row keeps the whole path elsewhere; this is for the line a sticky head must keep short.
 */
export function compactPath(path) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const shownDir = compactDirectory(dir);
  const shownBase = cutMiddle(base, BASE_COLUMNS);
  return { dir: shownDir, base: shownBase, cut: shownDir !== dir || shownBase !== base };
}

// A reason longer than this many columns does not share its line with the path.
const SHORT_REASON_COLUMNS = 16;
// The reasons a path cannot be read that carry a word of their own, `monitor.files.reason.<reason>`; any other reason is shown as it is.
const REASONS = Object.freeze(['missing', 'not-file', 'too-large', 'binary', 'unreadable']);

/** A span of lines as `[first, last]` as the list writes it: the one line, or the first and the last. */
export const spanText = ([first, last]) => (first === last ? String(first) : `${first}–${last}`);
const spansText = spans => spans.map(spanText).join(SPAN_SEPARATOR);
const runSpan = run => [run.offset, run.offset + run.lines.length - 1];
const runLines = runs => runs.reduce((sum, run) => sum + run.lines.length, 0);
const runChars = runs => runs.reduce((sum, run) => sum + run.lines.reduce((chars, line) => chars + line.text.length, 0), 0);
// The lines of a text as `splitLines` of `lib/line-align.js`, the host's one reading of lines, has them.
function linesOf(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
const withdrawnLines = spans => spans.reduce((sum, { first, last }) => sum + last - first + 1, 0);

const plainItem = (id, path, why, tone, removed) => ({
  id, kind: 'plain', path, name: compactPath(path), why, tone, removed, long: columnsOf(why) > SHORT_REASON_COLUMNS,
});

// What the state of a path says in the place of lines: it could not be read, with the reason, or it has none; null for any other state.
function stateNoteOf({ state, reason }, t) {
  if (state === 'unreadable') {
    const word = REASONS.includes(reason) ? t(`monitor.files.reason.${reason}`) : (reason ?? NOT_AVAILABLE);
    return { text: t('monitor.files.unreadable', { reason: word }), tone: 'err' };
  }
  return state === 'empty' ? { text: t('monitor.files.empty'), tone: null } : null;
}

// The place of each written and withdrawn span on a file of `total` lines, as a share of its width, and the text that names them; none where the file has no line count.
function barOf({ total, runs, withdrawn, verb }, t) {
  if (!(total > 0)) return null;
  const mark = (first, count, isWithdrawn) => {
    const left = Math.min(PERCENT, (first - 1) * PERCENT / total);
    return { left, width: Math.min(PERCENT - left, count * PERCENT / total), withdrawn: isWithdrawn };
  };
  const titles = [];
  if (runs.length > 0) titles.push(t(`monitor.files.bar.${verb}`, { spans: spansText(runs.map(runSpan)) }));
  if (withdrawn.length > 0) titles.push(t('monitor.files.bar.withdrawn', { spans: spansText(withdrawn.map(({ first, last }) => [first, last])) }));
  return {
    title: titles.join(PART_SEPARATOR),
    marks: [...runs.map(run => mark(run.offset, run.lines.length, false)), ...withdrawn.map(({ first, last }) => mark(first, last - first + 1, true))],
  };
}

// A file with lines to show: `verb` is `written` for the evidence page and `read` for the files page, `note` what stands in the place of the statistics of a file that wrote none.
function fileItem({ id, path, total, runs, withdrawn, verb, note }, t) {
  const written = runLines(runs);
  const withdrawnCount = withdrawnLines(withdrawn);
  const count = verb === 'written'
    ? [...(written > 0 ? [{ text: `+${written}`, tone: 'ok' }] : []), ...(withdrawnCount > 0 ? [{ text: `−${withdrawnCount}`, tone: 'warn' }] : [])]
    : [{ text: t('monitor.files.lines', { count: written }), tone: null }];
  const stated = runs.length === 0 ? (note ?? { text: t('monitor.files.noWrites'), tone: null }) : null;
  const meta = note !== null
    ? note.text
    : [Number.isFinite(total) ? t('monitor.files.meta.total', { count: total }) : null, runs.length > 0 ? t('monitor.files.meta.lines', { spans: spansText(runs.map(runSpan)) }) : null]
      .filter(part => part !== null).join(PART_SEPARATOR);
  return {
    id,
    kind: 'file',
    skill: false,
    path,
    name: compactPath(path),
    total,
    runs,
    withdrawn,
    text: null,
    count,
    stat: runs.length > 0
      ? { segments: t('monitor.files.segments', { count: runs.length }), chars: t('monitor.files.chars', { count: compactCount(runChars(runs)) }), empty: null }
      : { segments: null, chars: null, empty: stated },
    bar: barOf({ total, runs, withdrawn, verb }, t),
    meta,
  };
}

function skillItem(id, { name, text }, t) {
  return {
    id,
    kind: 'file',
    skill: true,
    path: name,
    name: compactPath(name),
    total: null,
    runs: [],
    withdrawn: [],
    text,
    count: [{ text: t('monitor.files.lines', { count: linesOf(text).length }), tone: null }],
    stat: { segments: null, chars: t('monitor.files.chars', { count: compactCount(text.length) }), empty: null },
    bar: null,
    meta: '',
  };
}

const groupOf = (id, t, items) => ({ id, label: t(`monitor.files.group.${id}`), items });

// The note that names the directory the paths of a list are relative to, none where they share none.
const rootNoteOf = (root, t) => (root === '' ? null : t('monitor.files.sub.root', { root: root.slice(0, -1) }));

/**
 * The evidence page's model, `{ mode: 'carried', groups, summary, sub, foot }`, from the `carried` of the `inner-monitor/call` detail: the groups that hold something in the order changed files, files with no text, removed, skills; each item a `file` (with its count, statistics, bar and meta line, and the lines it shows by `bodyRowsOf`) or a one-line `plain` item that says why it has no lines, and every text worded by `t`.
 * The paths of the files and the removed paths are each relative to the root they all share; the name of a removed skill is no path and is shown as it is.
 * `summary` is the lines written, the lines withdrawn where there are any and the changed files, each `{ text, tone }`; `sub` the text that names that root and counts what else the carrier says, null where it says neither; `foot` the folds at the page's foot, each `{ key, label, text, pre }`: the carrier's wording as a paragraph and B's whole text preformatted.
 * A file counts as changed where it writes or withdraws a line; the others say their state.
 */
export function carriedFilesOf({ files, removed, skills, note, text }, t) {
  const root = commonRoot([...files.map(file => file.path), ...removed]);
  const relative = path => path.slice(root.length);
  const changed = files.filter(file => file.runs.length > 0 || file.withdrawn.length > 0);
  const bare = files.filter(file => !(file.runs.length > 0 || file.withdrawn.length > 0));
  const withText = skills.filter(skill => skill.removed !== true);
  const gone = [...removed.map(relative), ...skills.filter(skill => skill.removed === true).map(skill => skill.name)];
  const groups = [
    groupOf('changed', t, changed.map((file, at) => fileItem({ id: `changed:${at}`, path: relative(file.path), total: file.total, runs: file.runs, withdrawn: file.withdrawn, verb: 'written', note: stateNoteOf(file, t) }, t))),
    groupOf('bare', t, bare.map((file, at) => {
      const note = stateNoteOf(file, t) ?? { text: t('monitor.files.noLines'), tone: null };
      return plainItem(`bare:${at}`, relative(file.path), note.text, note.tone, false);
    })),
    groupOf('gone', t, gone.map((path, at) => plainItem(`gone:${at}`, path, t('monitor.files.removed'), null, true))),
    groupOf('skills', t, withText.map((skill, at) => skillItem(`skills:${at}`, skill, t))),
  ].filter(group => group.items.length > 0);
  const withdrawnCount = changed.reduce((sum, file) => sum + withdrawnLines(file.withdrawn), 0);
  const more = [
    withText.length > 0 ? t('monitor.files.sub.skills', { count: withText.length }) : null,
    bare.length > 0 ? t('monitor.files.sub.bare', { count: bare.length }) : null,
    gone.length > 0 ? t('monitor.files.sub.gone', { count: gone.length }) : null,
  ].filter(part => part !== null);
  const moreNote = more.length === 0 ? null : t('monitor.files.sub.more', { parts: more.join(PART_SEPARATOR) });
  return {
    mode: 'carried',
    groups,
    summary: [
      { text: t('monitor.files.summary.written', { count: changed.reduce((sum, file) => sum + runLines(file.runs), 0) }), tone: 'ok' },
      ...(withdrawnCount > 0 ? [{ text: t('monitor.files.summary.withdrawn', { count: withdrawnCount }), tone: 'warn' }] : []),
      { text: t('monitor.files.summary.files', { count: changed.length }), tone: null },
    ],
    sub: [rootNoteOf(root, t), moreNote].filter(part => part !== null).join(PART_SEPARATOR) || null,
    foot: [
      { key: 'note', label: t('monitor.files.foot.note'), text: note, pre: false },
      { key: 'text', label: t('monitor.files.foot.text'), text, pre: true },
    ],
  };
}

// A file of the files page with no line: one whose rendering an older load wrote in another form, an empty one, or one whose lines the rendering shows none of.
function readNoteOf({ total }, t) {
  if (total === null) return t('monitor.files.unrecorded');
  return t(total === 0 ? 'monitor.files.empty' : 'monitor.files.noLines');
}

/**
 * The files page's model, `{ mode: 'read', groups, summary, sub, foot }`, from the `files` of the `inner-monitor/handoff` detail: one group of the files, each by its path relative to the root they share, a `file` item for a file with lines and a `plain` item for one with none.
 * `summary` is the files, the lines they show and their segments; `sub` names the root the paths are relative to, null where they share none; `foot` is empty.
 */
export function readFilesOf(files, t) {
  const root = commonRoot(files.map(file => file.path));
  const items = files.map((file, at) => {
    const path = file.path.slice(root.length);
    return file.runs.length === 0
      ? plainItem(`read:${at}`, path, readNoteOf(file, t), null, false)
      : fileItem({ id: `read:${at}`, path, total: file.total, runs: file.runs, withdrawn: [], verb: 'read', note: null }, t);
  });
  return {
    mode: 'read',
    groups: items.length === 0 ? [] : [groupOf('read', t, items)],
    summary: [
      { text: t('monitor.files.summary.files', { count: files.length }), tone: null },
      { text: t('monitor.files.lines', { count: files.reduce((sum, file) => sum + runLines(file.runs), 0) }), tone: null },
      { text: t('monitor.files.segments', { count: files.reduce((sum, file) => sum + file.runs.length, 0) }), tone: null },
    ],
    sub: rootNoteOf(root, t),
    foot: [],
  };
}

/**
 * The rows an open file shows, in the order of the file: a `line` row `{ type, number, text }` for each line of its runs, a `gap` row `{ type, first, last }` for the lines of the file that no run shows, and a `withdrawn` row for the lines it withdrew, the rows of the spans placed by their first line.
 * A gap stops at the file's end where its line count is known, and there is a gap to the end too; where it is not, a gap opens the file but none closes it. A skill shows its text line by line, with no number.
 * `item` is a `file` item of the models.
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

/** A new list: every file folded, every group open, the lines wrapping and the foot folded. `files` and `groups` hold what the user chose, by id, `foot` the foot's folds by key. */
export function createFilesState() {
  return { files: {}, groups: {}, foot: {}, wrap: true };
}

/** Whether the file `id` shows open, the group `id` shows open and the foot fold `key` shows open. */
export const isFileOpen = (state, id) => state.files[id] ?? false;
export const isGroupOpen = (state, id) => state.groups[id] ?? true;
export const isFootOpen = (state, key) => state.foot[key] ?? false;

/**
 * The state after `action`, never changed in place; an action of an unknown type answers the state it was given.
 * `{ type: 'toggle', id }` flips a file, `{ type: 'group', id }` a group, `{ type: 'fold', key }` a fold of the foot and `{ type: 'wrap' }` the wrapping of the lines. `{ type: 'expand', ids }` opens the files `ids` and every group; `{ type: 'collapse' }` folds every file and leaves the groups as they are.
 */
export function reduceFiles(state, action) {
  switch (action.type) {
    case 'toggle': return { ...state, files: { ...state.files, [action.id]: !isFileOpen(state, action.id) } };
    case 'group': return { ...state, groups: { ...state.groups, [action.id]: !isGroupOpen(state, action.id) } };
    case 'fold': return { ...state, foot: { ...state.foot, [action.key]: !isFootOpen(state, action.key) } };
    case 'wrap': return { ...state, wrap: !state.wrap };
    case 'expand': return { ...state, files: { ...state.files, ...Object.fromEntries(action.ids.map(id => [id, true])) }, groups: {} };
    case 'collapse': return { ...state, files: {} };
    default: return state;
  }
}

/** Which of the two controls of the page head, expand all and collapse all, is of no use over the files `ids`: expand where every one is open, collapse where none is. */
export function controlsOf(state, ids) {
  return { expandDisabled: ids.every(id => isFileOpen(state, id)), collapseDisabled: !ids.some(id => isFileOpen(state, id)) };
}
