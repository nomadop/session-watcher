// The display model of the evidence page and the handoff files page, `monitor-files-model.js`: the groups and items each page lists as plain data with the texts worded, the rows an open file shows, the shortened path, the count a row carries, and the view state of the lists.
// Each function is tested on its own, against expected values written out by hand; the translate is the key followed by its parameters, so a wrong key or a wrong parameter shows in the expected literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactCount, commonRoot, compactPath, spanText, carriedFilesOf, readFilesOf, bodyRowsOf, createFilesState, reduceFiles, isFileOpen, isGroupOpen, isFootOpen, controlsOf,
} from '../dsh/src/client/monitor-files-model.js';

const t = (key, params) => (params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);

const FOUR = () => 'abcd';
/** The lines `first` to `last` as one run, each a text of `text(number)`. */
const run = (first, last, text = FOUR) => ({ offset: first, lines: Array.from({ length: last - first + 1 }, (_, at) => ({ number: first + at, text: text(first + at) })) });

// ── compactCount ──────────────────────────────────────────────────────────────

test('a count under a thousand is written as it is, thousands and millions to one decimal with k and m, and a count that rounds up to the next unit reads in that unit', () => {
  const cases = [[0, '0'], [7, '7'], [999, '999'], [1000, '1.0k'], [6300, '6.3k'], [6349, '6.3k'], [6350, '6.4k'], [999_949, '999.9k'], [999_950, '1.0m'], [1_234_567, '1.2m'], [12_000_000, '12.0m']];
  for (const [count, text] of cases) assert.equal(compactCount(count), text, String(count));
});

// ── commonRoot ────────────────────────────────────────────────────────────────

test('the common root of paths is the longest directory they all share, ending in a slash, and none where they share no directory or only the filesystem root', () => {
  assert.equal(commonRoot(['/work/a/x.js', '/work/a/y.js']), '/work/a/');
  assert.equal(commonRoot(['/work/a/x.js', '/work/b/y.js']), '/work/');
  assert.equal(commonRoot(['/work/ab/x.js', '/work/abc/y.js']), '/work/', 'a shared prefix of a name is no shared directory');
  assert.equal(commonRoot(['/work/a/x.js']), '/work/a/', 'one file is its own directory\'s');
  assert.equal(commonRoot(['/a/x.js', '/b/y.js']), '', 'the filesystem root is no shared directory');
  assert.equal(commonRoot(['/x.js']), '');
  assert.equal(commonRoot(['/x.js', '/y.js']), '');
  assert.equal(commonRoot(['a/x.js', 'a/y.js']), 'a/', 'a relative root of one directory is a root');
  assert.equal(commonRoot(['a/x.js', 'b/y.js']), '');
  assert.equal(commonRoot(['x.js', '/work/y.js']), '', 'a path with no directory shares none, and the search ends');
  assert.equal(commonRoot(['/x.js', 'y.js']), '');
  assert.equal(commonRoot([]), '');
});

// ── compactPath ───────────────────────────────────────────────────────────────

test('a path that fits is as it is, split into its directory and its name', () => {
  assert.deepEqual(compactPath('dsh/src/client/mode.js'), { dir: 'dsh/src/client/', base: 'mode.js', cut: false });
  assert.deepEqual(compactPath('Makefile'), { dir: '', base: 'Makefile', cut: false });
});

test('a directory too long keeps its first segment and the last ones that fit between ellipses, the leading slash of an absolute one kept', () => {
  assert.deepEqual(compactPath('packages/very-long-organisation-name/services/payment-gateway-integration/src/a.js'), { dir: 'packages/…/src/', base: 'a.js', cut: true });
  assert.deepEqual(compactPath(`root/${'x'.repeat(36)}/mid/leaf/a.js`), { dir: 'root/…/mid/leaf/', base: 'a.js', cut: true });
  assert.deepEqual(compactPath(`/root/${'x'.repeat(36)}/mid/leaf/a.js`), { dir: '/root/…/mid/leaf/', base: 'a.js', cut: true });
});

test('the leading slash of an absolute directory takes a column of the room the last segments have, so one that fits to the limit is kept and one column more is cut in the middle', () => {
  const dir = length => `/root/${'x'.repeat(36)}/${'a'.repeat(length)}/`;
  assert.deepEqual(compactPath(`${dir(21)}f.js`), { dir: `/root/…/${'a'.repeat(21)}/`, base: 'f.js', cut: true });
  assert.deepEqual(compactPath(`${dir(22)}f.js`), { dir: `/root/${'x'.repeat(10)}…${'a'.repeat(9)}/`, base: 'f.js', cut: true });
});

test('a directory of which not even the last segment fits beside the first is cut in the middle', () => {
  assert.deepEqual(compactPath(`${'a'.repeat(40)}/${'b'.repeat(40)}/x.js`), { dir: `${'a'.repeat(16)}…${'b'.repeat(9)}/`, base: 'x.js', cut: true });
  assert.deepEqual(compactPath(`${'d'.repeat(60)}/x.js`), { dir: `${'d'.repeat(16)}…${'d'.repeat(9)}/`, base: 'x.js', cut: true });
});

test('a name too long keeps its head and its tail around an ellipsis, a character of the CJK range counting for two columns and no character split', () => {
  assert.deepEqual(compactPath(`src/${'a'.repeat(80)}.ts`), { dir: 'src/', base: `${'a'.repeat(18)}…${'a'.repeat(8)}.ts`, cut: true });
  assert.deepEqual(compactPath('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸.md'), { dir: '', base: '一二三四五六七八九…庚辛壬癸.md', cut: true });
  assert.deepEqual(compactPath('😀'.repeat(30)), { dir: '', base: `${'😀'.repeat(9)}…${'😀'.repeat(5)}`, cut: true });
});

test('a name and a directory at their limits are not cut, and one column more is', () => {
  assert.deepEqual(compactPath('b'.repeat(34)), { dir: '', base: 'b'.repeat(34), cut: false });
  assert.equal(compactPath('b'.repeat(35)).cut, true);
  const dir = `${'c'.repeat(29)}/`;
  assert.deepEqual(compactPath(`${dir}x`), { dir, base: 'x', cut: false });
  assert.equal(compactPath(`${'c'.repeat(30)}/x`).cut, true);
  const several = `${'a'.repeat(10)}/bb/${'c'.repeat(15)}/`;
  assert.deepEqual(compactPath(`${several}x`), { dir: several, base: 'x', cut: false }, 'a directory of several segments, exactly at the limit, keeps them all');
});

test('a span of one line is that line and any other is its first and last line with a dash between', () => {
  assert.equal(spanText([7, 7]), '7');
  assert.equal(spanText([7, 12]), '7–12');
});

// ── carriedFilesOf ────────────────────────────────────────────────────────────

// Its removed path lies outside the directory of its files, so the page shares no root and its paths read whole.
const CARRIED = {
  text: 'B text',
  note: 'The note.',
  files: [
    { path: 'src/a.js', total: 200, state: 'readable', reason: null, runs: [run(1, 50), run(100, 110, number => `x${number}`)], withdrawn: [{ first: 60, last: 69 }, { first: 150, last: 150 }] },
    { path: 'src/gone-from.js', total: null, state: 'unreadable', reason: 'missing', runs: [], withdrawn: [{ first: 1, last: 4 }] },
    { path: 'src/e.js', total: null, state: 'empty', reason: null, runs: [], withdrawn: [{ first: 1, last: 2 }] },
    { path: 'src/only-withdrawn.js', total: 80, state: null, reason: null, runs: [], withdrawn: [{ first: 30, last: 40 }] },
    { path: 'src/b.js', total: 100, state: null, reason: null, runs: [run(5, 6, number => `b${number}`)], withdrawn: [] },
    { path: 'src/m.js', total: null, state: 'unreadable', reason: 'binary', runs: [], withdrawn: [] },
    { path: 'src/n.js', total: null, state: 'unreadable', reason: 'weird', runs: [], withdrawn: [] },
    { path: 'src/z.js', total: null, state: 'empty', reason: null, runs: [], withdrawn: [] },
    { path: 'src/held.js', total: null, state: 'readable', reason: null, runs: [], withdrawn: [] },
  ],
  removed: ['lib/old.js'],
  skills: [{ name: 'grilling', text: 'ask\nuntil done' }, { name: 'tdd', removed: true }],
};

const groupOf = (model, id) => model.groups.find(group => group.id === id);

test('the evidence page lists the groups that hold something, in the order changed files, files with no text, removed, skills, each by its label', () => {
  const model = carriedFilesOf(CARRIED, t);
  assert.equal(model.mode, 'carried');
  assert.deepEqual(model.groups.map(({ id, label }) => [id, label]), [
    ['changed', 'monitor.files.group.changed'], ['bare', 'monitor.files.group.bare'], ['gone', 'monitor.files.group.gone'], ['skills', 'monitor.files.group.skills'],
  ]);
  const onlySkills = carriedFilesOf({ ...CARRIED, files: [], removed: [], skills: [CARRIED.skills[0]] }, t);
  assert.deepEqual(onlySkills.groups.map(group => group.id), ['skills']);
});

test('a file that writes or withdraws lines is a changed file, its count the lines written and withdrawn, its bar the places of its runs and withdrawn spans on its line count, its statistics the segments and the characters written', () => {
  const [a, , , onlyWithdrawn, b] = groupOf(carriedFilesOf(CARRIED, t), 'changed').items;
  assert.deepEqual(groupOf(carriedFilesOf(CARRIED, t), 'changed').items.map(item => item.path), ['src/a.js', 'src/gone-from.js', 'src/e.js', 'src/only-withdrawn.js', 'src/b.js']);

  assert.deepEqual(a, {
    id: 'changed:0', kind: 'file', skill: false, path: 'src/a.js', name: { dir: 'src/', base: 'a.js', cut: false }, total: 200,
    runs: CARRIED.files[0].runs, withdrawn: CARRIED.files[0].withdrawn, text: null,
    count: [{ text: '+61', tone: 'ok' }, { text: '−11', tone: 'warn' }],
    stat: { segments: 'monitor.files.segments(count=2)', chars: 'monitor.files.chars(count=244)', empty: null },
    bar: {
      title: 'monitor.files.bar.written(spans=1–50, 100–110) · monitor.files.bar.withdrawn(spans=60–69, 150)',
      marks: [
        { left: 0, width: 25, withdrawn: false }, { left: 49.5, width: 5.5, withdrawn: false },
        { left: 29.5, width: 5, withdrawn: true }, { left: 74.5, width: 0.5, withdrawn: true },
      ],
    },
    meta: 'monitor.files.meta.total(count=200) · monitor.files.meta.lines(spans=1–50, 100–110)',
  });
  assert.deepEqual([onlyWithdrawn.count, onlyWithdrawn.stat, onlyWithdrawn.bar, onlyWithdrawn.meta], [
    [{ text: '−11', tone: 'warn' }],
    { segments: null, chars: null, empty: { text: 'monitor.files.noWrites', tone: null } },
    { title: 'monitor.files.bar.withdrawn(spans=30–40)', marks: [{ left: 36.25, width: 13.75, withdrawn: true }] },
    'monitor.files.meta.total(count=80)',
  ]);
  assert.deepEqual([b.count, b.stat, b.bar, b.meta], [
    [{ text: '+2', tone: 'ok' }],
    { segments: 'monitor.files.segments(count=1)', chars: 'monitor.files.chars(count=4)', empty: null },
    { title: 'monitor.files.bar.written(spans=5–6)', marks: [{ left: 4, width: 2, withdrawn: false }] },
    'monitor.files.meta.total(count=100) · monitor.files.meta.lines(spans=5–6)',
  ]);
});

test('a changed file whose state says it could not be read or has no line says so in the place of its statistics and on its meta line, and has no bar where it has no line count', () => {
  const [, gone, empty] = groupOf(carriedFilesOf(CARRIED, t), 'changed').items;
  const unreadable = { text: 'monitor.files.unreadable(reason=monitor.files.reason.missing)', tone: 'err' };
  assert.deepEqual([gone.count, gone.stat, gone.bar, gone.meta], [[{ text: '−4', tone: 'warn' }], { segments: null, chars: null, empty: unreadable }, null, unreadable.text]);
  assert.deepEqual([empty.count, empty.stat, empty.bar, empty.meta], [[{ text: '−2', tone: 'warn' }], { segments: null, chars: null, empty: { text: 'monitor.files.empty', tone: null } }, null, 'monitor.files.empty']);
});

test('a span that reaches past the end of the file, as a withdrawn one can, is drawn to the end of the bar and no further, and one that starts past it has no width at the end', () => {
  const file = { path: 'a', total: 10, state: null, reason: null, runs: [run(1, 2)], withdrawn: [{ first: 9, last: 14 }, { first: 12, last: 14 }] };
  const [item] = carriedFilesOf({ files: [file], removed: [], skills: [] }, t).groups[0].items;
  assert.deepEqual(item.bar.marks, [{ left: 0, width: 20, withdrawn: false }, { left: 80, width: 20, withdrawn: true }, { left: 100, width: 0, withdrawn: true }]);
});

test('the characters written read in thousands and millions', () => {
  const big = { path: 'a', total: 500, state: null, reason: null, runs: [run(1, 2, () => 'x'.repeat(600))], withdrawn: [] };
  assert.equal(carriedFilesOf({ ...CARRIED, files: [big], removed: [], skills: [] }, t).groups[0].items[0].stat.chars, 'monitor.files.chars(count=1.2k)');
});

test('a file with no line to show, written or withdrawn, is a plain row that says why: unreadable with its reason, empty, or holding none of its lines', () => {
  const bare = groupOf(carriedFilesOf(CARRIED, t), 'bare');
  assert.deepEqual(bare.items.map(({ id, kind, path, why, tone, removed }) => ({ id, kind, path, why, tone, removed })), [
    { id: 'bare:0', kind: 'plain', path: 'src/m.js', why: 'monitor.files.unreadable(reason=monitor.files.reason.binary)', tone: 'err', removed: false },
    { id: 'bare:1', kind: 'plain', path: 'src/n.js', why: 'monitor.files.unreadable(reason=weird)', tone: 'err', removed: false },
    { id: 'bare:2', kind: 'plain', path: 'src/z.js', why: 'monitor.files.empty', tone: null, removed: false },
    { id: 'bare:3', kind: 'plain', path: 'src/held.js', why: 'monitor.files.noLines', tone: null, removed: false },
  ]);
  assert.deepEqual(bare.items[0].name, { dir: 'src/', base: 'm.js', cut: false });
});

test('each reason the host gives for a path it could not read has a word of its own, and any other reason is shown as it is', () => {
  const whyOf = reason => carriedFilesOf({ files: [{ path: 'p', total: null, state: 'unreadable', reason, runs: [], withdrawn: [] }], removed: [], skills: [] }, t).groups[0].items[0].why;
  for (const reason of ['missing', 'not-file', 'too-large', 'binary', 'unreadable']) assert.equal(whyOf(reason), `monitor.files.unreadable(reason=monitor.files.reason.${reason})`, reason);
  assert.equal(whyOf('EACCES'), 'monitor.files.unreadable(reason=EACCES)');
});

test('an unreadable file with no reason reads a dash for it', () => {
  const model = carriedFilesOf({ ...CARRIED, files: [{ path: 'q', total: null, state: 'unreadable', reason: null, runs: [], withdrawn: [] }], removed: [], skills: [] }, t);
  assert.equal(model.groups[0].items[0].why, 'monitor.files.unreadable(reason=—)');
});

test('a removed path and a removed skill are plain rows marked removed, and a skill with text is a file of its lines and characters, with no bar and no meta line', () => {
  const model = carriedFilesOf(CARRIED, t);
  assert.deepEqual(groupOf(model, 'gone').items.map(({ id, kind, path, why, tone, removed }) => ({ id, kind, path, why, tone, removed })), [
    { id: 'gone:0', kind: 'plain', path: 'lib/old.js', why: 'monitor.files.removed', tone: null, removed: true },
    { id: 'gone:1', kind: 'plain', path: 'tdd', why: 'monitor.files.removed', tone: null, removed: true },
  ]);
  assert.deepEqual(groupOf(model, 'skills').items, [{
    id: 'skills:0', kind: 'file', skill: true, path: 'grilling', name: { dir: '', base: 'grilling', cut: false }, total: null, runs: [], withdrawn: [], text: 'ask\nuntil done',
    count: [{ text: 'monitor.files.lines(count=2)', tone: null }],
    stat: { segments: null, chars: 'monitor.files.chars(count=14)', empty: null },
    bar: null,
    meta: '',
  }]);
});

test('a skill is counted and shown by the host\'s lines: a final line break opens no further line, a carriage return is no part of one, and the empty text has none', () => {
  const skillOf = text => carriedFilesOf({ files: [], removed: [], skills: [{ name: 's', text }] }, t).groups[0].items[0];
  assert.equal(skillOf('one\n\nthree\n').count[0].text, 'monitor.files.lines(count=3)');
  assert.deepEqual(bodyRowsOf(skillOf('one\r\ntwo\n')), [{ type: 'line', number: null, text: 'one' }, { type: 'line', number: null, text: 'two' }]);
  assert.equal(skillOf('a\n\n').count[0].text, 'monitor.files.lines(count=2)', 'only one final line break is dropped');
  assert.equal(skillOf('a\rb').count[0].text, 'monitor.files.lines(count=1)', 'a lone carriage return breaks no line');
  assert.equal(skillOf('').count[0].text, 'monitor.files.lines(count=0)');
  assert.deepEqual(bodyRowsOf(skillOf('')), []);
  assert.equal(skillOf('one\n').stat.chars, 'monitor.files.chars(count=4)', 'the characters are those of the whole text');
});

test('the evidence page\'s foot is the carrier\'s wording as a paragraph and B\'s whole text preformatted, and the files page has none', () => {
  assert.deepEqual(carriedFilesOf(CARRIED, t).foot, [
    { key: 'note', label: 'monitor.files.foot.note', text: 'The note.', pre: false },
    { key: 'text', label: 'monitor.files.foot.text', text: 'B text', pre: true },
  ]);
  assert.deepEqual(readFilesOf(FILES, t).foot, []);
});

test('the plain row flags a reason too long to share the line with the path, by the columns of its text', () => {
  const longOf = text => carriedFilesOf({ files: [], removed: ['p'], skills: [] }, () => text).groups[0].items[0].long;
  assert.equal(longOf('x'.repeat(16)), false);
  assert.equal(longOf('x'.repeat(17)), true);
  assert.equal(longOf('一二三四五六七八'), false, 'eight characters of two columns each');
  assert.equal(longOf('一二三四五六七八九'), true);
});

test('the summary is the lines written, the lines withdrawn where there are any and the changed files, and the sub line counts what else the carrier says, none where it says nothing else', () => {
  assert.deepEqual(carriedFilesOf(CARRIED, t).summary, [
    { text: 'monitor.files.summary.written(count=63)', tone: 'ok' },
    { text: 'monitor.files.summary.withdrawn(count=28)', tone: 'warn' },
    { text: 'monitor.files.summary.files(count=5)', tone: null },
  ]);
  assert.equal(carriedFilesOf(CARRIED, t).sub, 'monitor.files.sub.more(parts=monitor.files.sub.skills(count=1) · monitor.files.sub.bare(count=4) · monitor.files.sub.gone(count=2))');

  const written = { path: 'a', total: 9, state: null, reason: null, runs: [run(1, 2)], withdrawn: [] };
  const plain = carriedFilesOf({ files: [written], removed: [], skills: [] }, t);
  assert.deepEqual(plain.summary, [{ text: 'monitor.files.summary.written(count=2)', tone: 'ok' }, { text: 'monitor.files.summary.files(count=1)', tone: null }]);
  assert.equal(plain.sub, null);
  assert.equal(carriedFilesOf({ files: [], removed: ['x'], skills: [] }, t).sub, 'monitor.files.sub.more(parts=monitor.files.sub.gone(count=1))');
});

test('the evidence page shows the paths of its files and removed paths relative to the root they share, and its sub line names that root before it counts what else the carrier says', () => {
  const model = carriedFilesOf({
    files: [
      { path: '/work/src/a.js', total: 9, state: null, reason: null, runs: [run(1, 2)], withdrawn: [] },
      { path: '/work/lib/m.js', total: null, state: 'unreadable', reason: 'binary', runs: [], withdrawn: [] },
    ],
    removed: ['/work/old/x.js'],
    skills: [{ name: 'tdd', removed: true }, { name: 'grilling', text: 'ask' }],
  }, t);

  assert.deepEqual(model.groups.map(group => group.items.map(item => item.path)), [['src/a.js'], ['lib/m.js'], ['old/x.js', 'tdd'], ['grilling']], 'the name of a skill is no path: it neither narrows the root nor is cut by it');
  assert.deepEqual(groupOf(model, 'changed').items[0].name, { dir: 'src/', base: 'a.js', cut: false });
  assert.equal(model.sub, 'monitor.files.sub.root(root=/work) · monitor.files.sub.more(parts=monitor.files.sub.skills(count=1) · monitor.files.sub.bare(count=1) · monitor.files.sub.gone(count=2))');
});

test('a removed path outside the directory of the files narrows the root, and where the paths share none they stay whole and the sub line names no root', () => {
  const written = path => ({ path, total: 9, state: null, reason: null, runs: [run(1, 1)], withdrawn: [] });
  const narrowed = carriedFilesOf({ files: [written('/work/src/a.js'), written('/work/src/b.js')], removed: ['/work/lib/old.js'], skills: [] }, t);
  assert.deepEqual(groupOf(narrowed, 'changed').items.map(item => item.path), ['src/a.js', 'src/b.js']);
  assert.deepEqual(groupOf(narrowed, 'gone').items.map(item => item.path), ['lib/old.js']);
  assert.equal(narrowed.sub, 'monitor.files.sub.root(root=/work) · monitor.files.sub.more(parts=monitor.files.sub.gone(count=1))');

  const apart = carriedFilesOf({ files: [written('/work/src/a.js'), written('rel/b.js')], removed: [], skills: [] }, t);
  assert.deepEqual(groupOf(apart, 'changed').items.map(item => item.path), ['/work/src/a.js', 'rel/b.js']);
  assert.equal(apart.sub, null);
});

test('a sub line that holds only the root is the root alone', () => {
  const written = path => ({ path, total: 9, state: null, reason: null, runs: [run(1, 1)], withdrawn: [] });
  assert.equal(carriedFilesOf({ files: [written('/work/src/a.js'), written('/work/src/b.js')], removed: [], skills: [] }, t).sub, 'monitor.files.sub.root(root=/work/src)');
});

test('paths that share only the filesystem root stay absolute on the evidence page and its sub line names no root', () => {
  const written = path => ({ path, total: 9, state: null, reason: null, runs: [run(1, 1)], withdrawn: [] });
  const model = carriedFilesOf({ files: [written('/Users/me/repo/a.js'), written('/private/tmp/b.mjs')], removed: ['/Users/me/repo/old.js'], skills: [{ name: 'tdd', text: 'ask' }] }, t);
  assert.deepEqual(groupOf(model, 'changed').items.map(item => item.path), ['/Users/me/repo/a.js', '/private/tmp/b.mjs']);
  assert.deepEqual(groupOf(model, 'gone').items.map(item => item.path), ['/Users/me/repo/old.js']);
  assert.equal(model.sub, 'monitor.files.sub.more(parts=monitor.files.sub.skills(count=1) · monitor.files.sub.gone(count=1))');
  assert.equal(carriedFilesOf({ files: [written('/a/x.js'), written('/b/y.js')], removed: [], skills: [] }, t).sub, null);
});

test('a long path is shortened in the row and kept whole in the item', () => {
  const path = `packages/${'x'.repeat(50)}/services/a.js`;
  const written = file => ({ path: file, total: 1, state: null, reason: null, runs: [run(1, 1)], withdrawn: [] });
  // The second file is in another directory, so the long path is not cut to its name.
  const [item] = groupOf(carriedFilesOf({ files: [written(path), written('lib/b.js')], removed: [], skills: [] }, t), 'changed').items;
  assert.equal(item.path, path);
  assert.deepEqual(item.name, { dir: 'packages/…/services/', base: 'a.js', cut: true });
});

// ── readFilesOf ───────────────────────────────────────────────────────────────

const FILES = [
  { path: '/work/src/a.js', total: 100, runs: [run(1, 2), run(50, 50)] },
  { path: '/work/src/b.js', total: 4, runs: [run(1, 4, () => 'ab')] },
  { path: '/work/old/c.js', total: null, runs: [] },
  { path: '/work/old/e.js', total: 0, runs: [] },
];

test('the files page lists the files in one group by their paths relative to the root they share, each with its lines read as its count, its segments and characters, its bar and its meta line', () => {
  const model = readFilesOf(FILES, t);
  assert.equal(model.mode, 'read');
  assert.deepEqual(model.groups.map(({ id, label }) => [id, label]), [['read', 'monitor.files.group.read']]);
  const [a, b] = model.groups[0].items;
  assert.deepEqual(a, {
    id: 'read:0', kind: 'file', skill: false, path: 'src/a.js', name: { dir: 'src/', base: 'a.js', cut: false }, total: 100,
    runs: FILES[0].runs, withdrawn: [], text: null,
    count: [{ text: 'monitor.files.lines(count=3)', tone: null }],
    stat: { segments: 'monitor.files.segments(count=2)', chars: 'monitor.files.chars(count=12)', empty: null },
    bar: { title: 'monitor.files.bar.read(spans=1–2, 50)', marks: [{ left: 0, width: 2, withdrawn: false }, { left: 49, width: 1, withdrawn: false }] },
    meta: 'monitor.files.meta.total(count=100) · monitor.files.meta.lines(spans=1–2, 50)',
  });
  assert.deepEqual([b.path, b.count, b.bar], ['src/b.js', [{ text: 'monitor.files.lines(count=4)', tone: null }], { title: 'monitor.files.bar.read(spans=1–4)', marks: [{ left: 0, width: 100, withdrawn: false }] }]);
});

test('a file with no line, which an older load recorded in another form or which was empty, is a plain row that says which', () => {
  const [, , c, e] = readFilesOf(FILES, t).groups[0].items;
  assert.deepEqual([c.kind, c.path, c.why, c.tone, c.removed], ['plain', 'old/c.js', 'monitor.files.unrecorded', null, false]);
  assert.deepEqual([e.kind, e.path, e.why, e.tone, e.removed], ['plain', 'old/e.js', 'monitor.files.empty', null, false]);
});

test('the files page sums its files, the lines of the ones read and their segments, and names the root the paths are relative to, none where they share none or only the filesystem root', () => {
  const model = readFilesOf(FILES, t);
  assert.deepEqual(model.summary, [
    { text: 'monitor.files.summary.files(count=4)', tone: null }, { text: 'monitor.files.lines(count=7)', tone: null }, { text: 'monitor.files.segments(count=3)', tone: null },
  ]);
  assert.equal(model.sub, 'monitor.files.sub.root(root=/work)');
  const apart = readFilesOf([{ path: '/a/x.js', total: 1, runs: [run(1, 1)] }, { path: '/b/y.js', total: 1, runs: [run(1, 1)] }], t);
  assert.equal(apart.sub, null);
  assert.deepEqual(apart.groups[0].items.map(item => item.path), ['/a/x.js', '/b/y.js']);
  assert.equal(readFilesOf([{ path: '/a.js', total: 1, runs: [run(1, 1)] }], t).sub, null);
  assert.equal(readFilesOf([{ path: 'a.js', total: 1, runs: [run(1, 1)] }, { path: '/b.js', total: 1, runs: [run(1, 1)] }], t).sub, null);
  assert.deepEqual(readFilesOf([], t).groups, []);
});

// ── bodyRowsOf ────────────────────────────────────────────────────────────────

const lineRow = (number, text = 'abcd') => ({ type: 'line', number, text });

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

// ── the view state ────────────────────────────────────────────────────────────

test('a new list has every file folded, every group open, the lines wrapping and the foot folded', () => {
  const state = createFilesState();
  assert.deepEqual([isFileOpen(state, 'a'), isGroupOpen(state, 'g'), isFootOpen(state, 'note'), state.wrap], [false, true, false, true]);
});

test('a file and a group toggle on their own, and the foot folds toggle by key', () => {
  let state = reduceFiles(createFilesState(), { type: 'toggle', id: 'a' });
  assert.deepEqual([isFileOpen(state, 'a'), isFileOpen(state, 'b')], [true, false]);
  state = reduceFiles(state, { type: 'toggle', id: 'a' });
  assert.equal(isFileOpen(state, 'a'), false);
  state = reduceFiles(state, { type: 'group', id: 'g' });
  assert.deepEqual([isGroupOpen(state, 'g'), isGroupOpen(state, 'h')], [false, true]);
  state = reduceFiles(state, { type: 'group', id: 'g' });
  assert.equal(isGroupOpen(state, 'g'), true);
  state = reduceFiles(state, { type: 'fold', key: 'note' });
  assert.deepEqual([isFootOpen(state, 'note'), isFootOpen(state, 'text')], [true, false]);
  state = reduceFiles(state, { type: 'fold', key: 'note' });
  assert.equal(isFootOpen(state, 'note'), false);
});

test('expanding all opens the files it is given and every group, collapsing all folds the files and leaves the groups', () => {
  let state = reduceFiles(createFilesState(), { type: 'group', id: 'g' });
  state = reduceFiles(state, { type: 'expand', ids: ['a', 'b'] });
  assert.deepEqual([isFileOpen(state, 'a'), isFileOpen(state, 'b'), isGroupOpen(state, 'g')], [true, true, true]);
  state = reduceFiles(reduceFiles(state, { type: 'group', id: 'g' }), { type: 'collapse' });
  assert.deepEqual([isFileOpen(state, 'a'), isFileOpen(state, 'b'), isGroupOpen(state, 'g')], [false, false, false]);
});

test('the wrap switch flips, an action of an unknown type answers the state it was given, and no action changes the state it was given', () => {
  const state = createFilesState();
  const flipped = reduceFiles(state, { type: 'wrap' });
  assert.equal(flipped.wrap, false);
  assert.equal(state.wrap, true);
  assert.equal(reduceFiles(flipped, { type: 'wrap' }).wrap, true);
  assert.equal(reduceFiles(state, { type: 'nothing' }), state);
  const opened = reduceFiles(state, { type: 'toggle', id: 'a' });
  assert.equal(isFileOpen(state, 'a'), false);
  assert.notEqual(opened, state);
});

test('the expand control is disabled when every file is open and the collapse control when none is, and both when there is no file', () => {
  let state = createFilesState();
  assert.deepEqual(controlsOf(state, ['a', 'b']), { expandDisabled: false, collapseDisabled: true });
  state = reduceFiles(state, { type: 'toggle', id: 'a' });
  assert.deepEqual(controlsOf(state, ['a', 'b']), { expandDisabled: false, collapseDisabled: false });
  state = reduceFiles(state, { type: 'expand', ids: ['a', 'b'] });
  assert.deepEqual(controlsOf(state, ['a', 'b']), { expandDisabled: true, collapseDisabled: false });
  assert.deepEqual(controlsOf(state, []), { expandDisabled: true, collapseDisabled: true });
});
