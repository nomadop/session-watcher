// The carried evidence shared by every carrier of file text and skill text: what a chain of sources holds once folded, the
// changes a seal carries against that fold, the lines a carrier leaves out, the text and the structure its `source` states,
// and the runs of consecutive line numbers they and the seal's reads share.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import nodePath from 'node:path';

import {
  CARRIED_WORDING, carriedEvidence, carriedNote, carriedOf, carryChanges, foldCarried, omitShown, renderCarried, runsOf,
} from '../lib/carried-evidence.js';
import { readTreeWindows } from '../lib/working-tree-text.js';
import { createMemoryWorkingTree } from '../lib/working-tree.js';

const KIND = 'test-carrier';

const carrier = ({ paths = [], removed, skills } = {}) => ({
  kind: KIND, v: 1, slots: [], paths,
  ...(removed === undefined ? {} : { removed }), ...(skills === undefined ? {} : { skills }),
});

// A fold as plain values: each path's state, reason and lines in line order, and each skill's text.
const plainFold = ({ paths, skills }) => ({
  paths: Object.fromEntries([...paths].map(([path, { lines, ...rest }]) => [
    path, { ...rest, lines: Object.fromEntries([...lines].sort(([a], [b]) => a - b)) },
  ])),
  skills: Object.fromEntries(skills),
});

describe('the baseline fold', () => {
  test('applies the carriers in order: a later write wins, a withdrawal and a removal take their lines and path away, and a skill follows its last entry', () => {
    const folded = foldCarried([
      carrier({
        paths: [
          { path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 3, state: 'readable', write: [[1, 'one'], [2, 'two'], [3, 'three']] },
          { path: '/r/b.txt', displayPath: '/r/b.txt', totalLines: 1, state: 'readable', write: [[1, 'bee']] },
        ],
        skills: [{ name: 'tdd', text: 'Test first.' }, { name: 'grill', text: 'Ask.' }],
      }),
      carrier({
        paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 3, write: [[2, 'TWO']], withdraw: [3] }],
        removed: ['/r/b.txt'],
        skills: [{ name: 'tdd', text: 'Test first, always.' }, { name: 'grill', removed: true }],
      }),
    ]);
    assert.deepEqual(plainFold(folded), {
      paths: { '/r/a.txt': { state: 'readable', lines: { 1: 'one', 2: 'TWO' } } },
      skills: { tdd: 'Test first, always.' },
    });
  });

  test('an unreadable path keeps its reason until it turns readable or empty', () => {
    const unreadable = foldCarried([
      carrier({ paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 1, state: 'readable', write: [[1, 'one']] }] }),
      carrier({ paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'unreadable', reason: 'missing', withdraw: [1] }] }),
    ]);
    assert.deepEqual(plainFold(unreadable).paths, { '/r/a.txt': { state: 'unreadable', reason: 'missing', lines: {} } });
    const empty = foldCarried([
      carrier({ paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'unreadable', reason: 'binary' }] }),
      carrier({ paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'empty' }] }),
    ]);
    assert.deepEqual(plainFold(empty).paths, { '/r/a.txt': { state: 'empty', lines: {} } });
  });
});

// ── The changes a seal carries ───────────────────────────────────────────────

// The view a seal reconstructs at its point: each held path read over the runs of its held lines from `tree`, with
// the display path its read would print, and the held skills.
function viewOf(tree, held, skills = {}, displayPathOf = path => path) {
  const paths = new Map();
  for (const [path, lines] of Object.entries(held)) {
    const ranges = [];
    for (const line of [...lines].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && last.offset + last.limit === line) last.limit += 1;
      else ranges.push({ offset: line, limit: 1 });
    }
    paths.set(path, { displayPath: displayPathOf(path), read: readTreeWindows(tree, path, ranges, { fileBytes: FILE_BYTES }) });
  }
  return { paths, skills: new Map(Object.entries(skills)) };
}

const FILE_BYTES = 10_000;
const memoryTree = files => createMemoryWorkingTree({ files, path: nodePath.posix, homeDir: null });

// One seal over `view`: the changes against the fold of the carriers before it, made into the next carrier.
const sealed = (chain, view) => ({ kind: KIND, v: 1, slots: [], ...carryChanges(foldCarried(chain), view) });

describe('the changes a seal carries', () => {
  test('a first seal writes every held line on disk under the display path and line count of its read, with each held skill', () => {
    const tree = memoryTree({ '/r/a.txt': 'one\ntwo\nthree\nfour\n', '/r/b.txt': 'bee\n' });
    const view = viewOf(tree, { '/r/a.txt': [1, 2, 4], '/r/b.txt': [1] }, { tdd: 'Test first.' }, path => `/shown${path}`);
    assert.deepEqual(carryChanges(foldCarried([]), view), {
      paths: [
        { path: '/r/a.txt', displayPath: '/shown/r/a.txt', totalLines: 4, state: 'readable', write: [[1, 'one'], [2, 'two'], [4, 'four']] },
        { path: '/r/b.txt', displayPath: '/shown/r/b.txt', totalLines: 1, state: 'readable', write: [[1, 'bee']] },
      ],
      skills: [{ name: 'tdd', text: 'Test first.' }],
    });
  });

  test('a later seal writes only a changed or newly held line, withdraws a line no longer held, removes a path no longer held, and repeats nothing unchanged', () => {
    const first = sealed([], viewOf(
      memoryTree({ '/r/a.txt': 'one\ntwo\nthree\nfour\n', '/r/b.txt': 'bee\n', '/r/c.txt': 'sea\n' }),
      { '/r/a.txt': [1, 2, 3], '/r/b.txt': [1], '/r/c.txt': [1] },
      { tdd: 'Test first.', grill: 'Ask.', domain: 'Name it.' },
    ));
    const changes = carryChanges(foldCarried([first]), viewOf(
      memoryTree({ '/r/a.txt': 'one\nTWO\nthree\nfour\n', '/r/b.txt': 'bee\n', '/r/c.txt': 'sea\n' }),
      { '/r/a.txt': [1, 2, 4], '/r/c.txt': [1] },
      { tdd: 'Test first, always.', domain: 'Name it.' },
    ));
    assert.deepEqual(changes, {
      paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 4, write: [[2, 'TWO'], [4, 'four']], withdraw: [3] }],
      removed: ['/r/b.txt'],
      skills: [{ name: 'tdd', text: 'Test first, always.' }, { name: 'grill', removed: true }],
    });
    const unchanged = sealed([first], viewOf(
      memoryTree({ '/r/a.txt': 'one\ntwo\nthree\nfour\n', '/r/b.txt': 'bee\n', '/r/c.txt': 'sea\n' }),
      { '/r/a.txt': [1, 2, 3], '/r/b.txt': [1], '/r/c.txt': [1] },
      { tdd: 'Test first.', grill: 'Ask.', domain: 'Name it.' },
    ));
    assert.deepEqual(unchanged, { kind: KIND, v: 1, slots: [], paths: [] }, 'an unchanged seal carries no path entry, removal or skill');
  });
});

describe('a held path whose state changes', () => {
  const held = { '/r/a.txt': [1, 2] };
  const chainOver = trees => trees.reduce((chain, files) => [...chain, sealed(chain, viewOf(memoryTree(files), held))], []);

  test('turning empty or unreadable withdraws every carried line, a new reason while unreadable is carried, and readable again writes the lines afresh', () => {
    const chain = chainOver([
      { '/r/a.txt': 'one\ntwo\n' },
      { '/r/a.txt': '' },
      { },
      { '/r/a.txt': 'one\u0000\n' },
      { '/r/a.txt': 'one\ntwo\n' },
    ]);
    assert.deepEqual(chain.slice(1).map(source => source.paths), [
      [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'empty', withdraw: [1, 2] }],
      [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'unreadable', reason: 'missing' }],
      [{ path: '/r/a.txt', displayPath: '/r/a.txt', state: 'unreadable', reason: 'binary' }],
      [{ path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 2, state: 'readable', write: [[1, 'one'], [2, 'two']] }],
    ]);
    assert.deepEqual(chainOver([{ }, { }]).map(source => source.paths.length), [1, 0], 'an unchanged reason is not carried again');
  });
});

describe('the chain of carriers', () => {
  test('concatenated in order, the carriers equal the disk on the held lines and the held skills at every seal, a shrink below the held lines and the growth back included', () => {
    const seals = [
      { files: { '/r/a.txt': 'a1\na2\na3\na4\n', '/r/b.txt': 'b1\n' }, held: { '/r/a.txt': [1, 2, 3, 4], '/r/b.txt': [1] }, skills: { tdd: 'T1' } },
      { files: { '/r/a.txt': 'a1\na2\n', '/r/b.txt': 'b1\n' }, held: { '/r/a.txt': [1, 2, 3, 4], '/r/b.txt': [1] }, skills: { tdd: 'T1' } },
      { files: { '/r/a.txt': 'a1\nA2\na3\nA4\n' }, held: { '/r/a.txt': [1, 2, 3, 4], '/r/b.txt': [1] }, skills: { tdd: 'T2', grill: 'G' } },
      { files: { '/r/a.txt': 'a1\nA2\na3\nA4\n', '/r/b.txt': 'b1\n' }, held: { '/r/a.txt': [2, 3] }, skills: { grill: 'G' } },
    ];
    const expected = [
      { paths: { '/r/a.txt': { state: 'readable', lines: { 1: 'a1', 2: 'a2', 3: 'a3', 4: 'a4' } }, '/r/b.txt': { state: 'readable', lines: { 1: 'b1' } } }, skills: { tdd: 'T1' } },
      { paths: { '/r/a.txt': { state: 'readable', lines: { 1: 'a1', 2: 'a2' } }, '/r/b.txt': { state: 'readable', lines: { 1: 'b1' } } }, skills: { tdd: 'T1' } },
      { paths: { '/r/a.txt': { state: 'readable', lines: { 1: 'a1', 2: 'A2', 3: 'a3', 4: 'A4' } }, '/r/b.txt': { state: 'unreadable', reason: 'missing', lines: {} } }, skills: { tdd: 'T2', grill: 'G' } },
      { paths: { '/r/a.txt': { state: 'readable', lines: { 2: 'A2', 3: 'a3' } } }, skills: { grill: 'G' } },
    ];
    const chain = [];
    seals.forEach(({ files, held, skills }, index) => {
      chain.push(sealed(chain, viewOf(memoryTree(files), held, skills)));
      assert.deepEqual(plainFold(foldCarried(chain)), expected[index], `at seal ${index + 1}`);
    });
    assert.deepEqual(chain[1].paths, [{ path: '/r/a.txt', displayPath: '/r/a.txt', withdraw: [3, 4] }], 'the lines past the shrunk end are withdrawn');
  });
});

// ── The lines a carrier does not show again ─────────────────────────────────

const BODY = ['alpha line of some length to show', 'beta line of some length to show', 'gamma line of some length to show'];
const entryOf = (path, first, texts, extra = {}) => ({
  path, displayPath: path, totalLines: 40, state: 'readable', write: texts.map((text, at) => [first + at, text]), ...extra,
});
const changing = (...paths) => ({ paths });
const omitted = (changes, earlier) => omitShown(changes, earlier).paths.map(entry => entry.omit);

describe('the lines a carrier does not show again', () => {
  test('a written line is omitted by its number when an earlier carrier shows a line of the same path with the very same text, whatever either number is, and the entry still writes every line', () => {
    const earlier = [carrier({ paths: [entryOf('/r/a.txt', 1, BODY)] })];
    const changes = changing(entryOf('/r/a.txt', 6, [...BODY, 'delta line, not shown before'], { withdraw: [1, 2, 3] }), entryOf('/r/b.txt', 20, ['other']));
    const kept = structuredClone({ earlier, changes });
    const answer = omitShown(changes, earlier);
    assert.deepEqual({ earlier, changes }, kept, 'the earlier carriers\' sources and the changes asked about are not touched');
    assert.deepEqual(answer.paths[0], { ...changes.paths[0], omit: [6, 7, 8] }, 'the source keeps every written line, withdrawal and state');
    assert.equal(answer.paths[1], changes.paths[1], 'an entry with nothing omitted is as it was');
    assert.deepEqual(plainFold(foldCarried([...earlier, { ...carrier(), ...answer }])).paths['/r/a.txt'].lines, { 6: BODY[0], 7: BODY[1], 8: BODY[2], 9: 'delta line, not shown before' }, 'the fold reads the lines, not the omission');
  });

  test('a block that moved a little is omitted whole, though a brace line the old and new places share leaves the new lines as separate writes and the old run is no longer one', () => {
    const OLD = ['alpha', '}', 'beta', '}', 'gamma'];
    const earlier = [carrier({ paths: [entryOf('/r/f.js', 1, OLD)] })];
    const held = (first, texts) => ({
      paths: new Map([['/r/f.js', { displayPath: '/r/f.js', read: { status: 'readable', totalLines: 12, windows: [{ offset: first, lines: texts.map((text, at) => ({ number: first + at, text })) }] } }]]),
      skills: new Map(),
    });
    const changes = carryChanges(foldCarried(earlier), held(3, OLD));
    assert.deepEqual(changes.paths[0].write, [[3, 'alpha'], [5, 'beta'], [6, '}'], [7, 'gamma']], 'fixture: the shared brace at 4 is carried by the baseline, so the write is in pieces');
    assert.deepEqual(omitShown(changes, earlier).paths[0].omit, [3, 5, 6, 7]);
  });

  test('a part of an earlier run is omitted as well as the whole of it, and the lines of the run that are new stay', () => {
    const earlier = [carrier({ paths: [entryOf('/r/a.txt', 1, [...BODY, 'delta line of some length to show'])] })];
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, BODY.slice(1))), earlier), [[20, 21]], 'a tail of the run');
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, [BODY[1], 'a new line', BODY[2]])), earlier), [[20, 22]], 'with a new line between');
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, ['a new line'])), earlier), [undefined]);
  });

  test('only the same path and the exact text count: another file, a trailing space, other case, other indentation and an empty line the earlier carrier lacks are shown', () => {
    const earlier = [carrier({ paths: [entryOf('/r/a.txt', 1, [...BODY, 'x = 1'])] })];
    const around = (path, texts) => omitted(changing(entryOf(path, 6, texts)), earlier);
    assert.deepEqual(around('/r/other.txt', BODY), [undefined], 'another file');
    assert.deepEqual(around('/r/a.txt', [`${BODY[0]} `, BODY[1].toUpperCase(), ` ${BODY[2]}`, '', 'x  =  1']), [undefined], 'a trailing space, other case, other indentation, an empty line, other spacing');
    assert.deepEqual(around('/r/a.txt', [BODY[2], BODY[0], 'x = 1']), [[6, 7, 8]], 'the same texts');
  });

  test('a repeat inside the carrier being built is shown: only the carriers already in the request are looked back at', () => {
    const twice = { ...entryOf('/r/a.txt', 1, BODY), write: [...BODY.map((text, at) => [1 + at, text]), ...BODY.map((text, at) => [10 + at, text])] };
    const twin = [entryOf('/r/a.txt', 1, BODY), entryOf('/r/b.txt', 1, BODY)];
    assert.deepEqual(omitted(changing(twice), []), [undefined]);
    assert.deepEqual(omitted(changing(...twin), []), [undefined, undefined]);
  });

  test('an earlier carrier is looked back at whatever its lines became: withdrawn, rewritten or removed by a later carrier, its text is still in the request', () => {
    const first = carrier({ paths: [entryOf('/r/a.txt', 1, BODY)] });
    const second = carrier({ paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', withdraw: [1, 2, 3], ...entryOf('/r/a.txt', 1, ['rewritten line one of some length', 'rewritten line two of some length', 'rewritten line three of some length']) }], removed: ['/r/gone.txt'] });
    const third = carrier({ removed: ['/r/a.txt'] });
    assert.deepEqual(plainFold(foldCarried([first, second])).paths['/r/a.txt'].lines[1], 'rewritten line one of some length');
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 30, [BODY[0], 'rewritten line two of some length'])), [first, second, third]), [[30, 31]]);
  });

  test('a line an earlier carrier itself left out is not counted as shown by it: the text has to be in a carrier that still shows it', () => {
    const shows = carrier({ paths: [entryOf('/r/a.txt', 1, BODY)] });
    const leaves = carrier({ paths: [entryOf('/r/a.txt', 10, BODY, { omit: [10, 11, 12] })] });
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, BODY)), [shows, leaves]), [[20, 21, 22]], 'with the carrier that shows it');
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, BODY)), [leaves]), [undefined], 'without it');
    const partly = carrier({ paths: [entryOf('/r/a.txt', 10, BODY, { omit: [11, 12] })] });
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 20, BODY)), [partly]), [[20]], 'only the line it does show');
  });

  test('a short line is omitted like any other: a brace the earlier carrier shows is not shown again', () => {
    const earlier = [carrier({ paths: [entryOf('/r/a.txt', 1, ['}'])] })];
    assert.deepEqual(omitted(changing(entryOf('/r/a.txt', 9, ['}', 'else'])), earlier), [[9]]);
  });
});

describe('carriedOf', () => {
  test('is the changes against the fold of the earlier carriers, with the lines they show left out', () => {
    const earlier = [carrier({ paths: [entryOf('/r/a.txt', 1, BODY)] })];
    const current = {
      paths: new Map([['/r/a.txt', { displayPath: '/r/a.txt', read: { status: 'readable', totalLines: 40, windows: [{ offset: 1, lines: [{ number: 1, text: 'rewritten' }] }, { offset: 9, lines: [{ number: 9, text: BODY[1] }] }] } }]]),
      skills: new Map([['tdd', 'Test first.']]),
    };
    const answer = carriedOf(earlier, current);
    assert.deepEqual(answer, omitShown(carryChanges(foldCarried(earlier), current), earlier));
    assert.deepEqual(answer.paths[0], {
      path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 40, write: [[1, 'rewritten'], [9, BODY[1]]], withdraw: [2, 3], omit: [9],
    });
    assert.deepEqual(answer.skills, [{ name: 'tdd', text: 'Test first.' }]);
  });
});

// ── The text and the structure of a source ───────────────────────────────────

const SOURCE = {
  kind: KIND, v: 1,
  slots: [{ seqs: [4, 5], text: 'The user asked for the parser.' }],
  paths: [
    { path: '/r/a.txt', displayPath: '/shown/a.txt', totalLines: 9, state: 'readable', write: [[1, 'one'], [2, 'two'], [5, 'five']], withdraw: [3, 4, 7] },
    { path: '/r/e.txt', displayPath: '/shown/e.txt', state: 'empty', withdraw: [1] },
    { path: '/r/m.txt', displayPath: '/shown/m.txt', state: 'unreadable', reason: 'missing' },
    { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' },
  ],
  removed: ['/r/gone.txt'],
  skills: [{ name: 'tdd', text: 'Test first.' }, { name: 'grill', removed: true }],
};

describe('renderCarried', () => {
  const W = CARRIED_WORDING;

  test('is the wording of what is carried, then each entry that is empty, unreadable or writes a line, and each written skill, separated by blank lines, a written run under its seal-time path and line count', () => {
    assert.equal(renderCarried(SOURCE), [
      carriedNote(),
      '/shown/a.txt (total lines: 9)\n1: one\n2: two\n--\n5: five',
      W.empty('/shown/e.txt'),
      W.unreadable('/shown/m.txt', 'missing'),
      W.skill('tdd', 'Test first.'),
    ].join('\n\n'));
  });

  test('a line in omit is left out with nothing in its place: the lines that remain are runs of their own under the path', () => {
    const DELTA = 'delta line of some length to show';
    const entry = entryOf('/r/a.txt', 6, [...BODY, DELTA], { displayPath: '/shown/a.txt' });
    const text = renderCarried(carrier({ paths: [{ ...entry, write: [...entry.write, [12, 'twelfth line']], omit: [7, 8, 9] }] }));
    assert.equal(text, [carriedNote(), `/shown/a.txt (total lines: 40)\n6: ${BODY[0]}\n--\n12: twelfth line`].join('\n\n'));
    for (const left of [BODY[1], BODY[2], DELTA]) assert.ok(!text.includes(left), left);
  });

  test('is null where the source has no B to say: no entry, or a file whose written lines are all in omit', () => {
    assert.equal(renderCarried({ kind: KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] }), null);
    const omitting = entryOf('/r/a.txt', 6, BODY, { displayPath: '/shown/a.txt', omit: [6, 7, 8] });
    assert.equal(renderCarried(carrier({ paths: [omitting] })), null, 'a file whose written lines are all left out says nothing');
  });

  describe('what a carrier no longer carries', () => {
    const withdrawing = { path: '/r/a.txt', displayPath: '/shown/a.txt', withdraw: [3, 4, 7] };
    const readable = { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' };
    const written = entryOf('/r/w.txt', 1, ['one'], { displayPath: '/shown/w.txt' });

    test('is no part of B: a source that withdraws lines, removes paths or skills or turns a path readable with no line to write has no B, and beside written lines B is what those lines alone give', () => {
      const only = [
        carrier({ paths: [withdrawing] }),
        carrier({ paths: [readable] }),
        carrier({ removed: ['/r/gone.txt', '/r/other.txt'] }),
        carrier({ skills: [{ name: 'grill', removed: true }] }),
        carrier({ paths: [withdrawing, readable], removed: ['/r/gone.txt'], skills: [{ name: 'grill', removed: true }] }),
      ];
      for (const source of only) assert.equal(renderCarried(source), null);
      const beside = carrier({ paths: [{ ...written, withdraw: [3, 4, 7] }, readable], removed: ['/r/gone.txt'], skills: [{ name: 'grill', removed: true }] });
      assert.equal(renderCarried(beside), renderCarried(carrier({ paths: [written] })));
      for (const name of ['/r/gone.txt', '/shown/back.txt', 'grill']) assert.ok(!renderCarried(beside).includes(name), name);
    });
  });
});

describe('carriedEvidence', () => {
  const omitting = (extra = {}) => entryOf('/r/a.txt', 6, BODY, { displayPath: '/shown/a.txt', omit: [6, 7, 8], ...extra });

  test('is what the source changes, as structure: each entry that changes something under its seal-time path, with its written runs, withdrawn spans and state, then the removed paths and the skills', () => {
    assert.deepEqual(carriedEvidence(SOURCE), {
      files: [
        {
          path: '/shown/a.txt', total: 9, state: 'readable', reason: null,
          runs: [{ offset: 1, lines: [{ number: 1, text: 'one' }, { number: 2, text: 'two' }] }, { offset: 5, lines: [{ number: 5, text: 'five' }] }],
          withdrawn: [{ first: 3, last: 4 }, { first: 7, last: 7 }],
        },
        { path: '/shown/e.txt', total: null, state: 'empty', reason: null, runs: [], withdrawn: [{ first: 1, last: 1 }] },
        { path: '/shown/m.txt', total: null, state: 'unreadable', reason: 'missing', runs: [], withdrawn: [] },
        { path: '/shown/back.txt', total: null, state: 'readable', reason: null, runs: [], withdrawn: [] },
      ],
      removed: ['/r/gone.txt'],
      skills: [{ name: 'tdd', text: 'Test first.' }, { name: 'grill', removed: true }],
    });
  });

  test('an entry that records no state, as a path whose state did not change and has lines to write does not, has none in the structure: nothing stands in for the state or the reason', () => {
    const entry = entryOf('/r/c.txt', 3, ['x'], { displayPath: '/shown/c.txt', state: undefined });
    assert.deepEqual(carriedEvidence(carrier({ paths: [entry] })).files, [{
      path: '/shown/c.txt', total: 40, state: null, reason: null, runs: [{ offset: 3, lines: [{ number: 3, text: 'x' }] }], withdrawn: [],
    }]);
  });

  test('shows the lines B shows: a line in omit is no line of a run, and a file whose written lines are all in omit is listed only where it still says something', () => {
    const lines = entry => carriedEvidence(carrier({ paths: [entry] }))?.files[0]?.runs.map(run => run.lines.map(line => line.number));
    assert.deepEqual(lines({ ...omitting(), omit: [7] }), [[6], [8]], 'a left-out line splits the run it was in');
    assert.equal(carriedEvidence(carrier({ paths: [omitting()] })), null, 'the entry says nothing');
    assert.deepEqual(carriedEvidence(carrier({ paths: [omitting({ withdraw: [1, 2, 3] })] })).files, [{
      path: '/shown/a.txt', total: 40, state: 'readable', reason: null, runs: [], withdrawn: [{ first: 1, last: 3 }],
    }], 'its withdrawals are said');
    assert.deepEqual(carriedEvidence(carrier({ paths: [omitting(), entryOf('/r/b.txt', 1, ['x'], { displayPath: '/shown/b.txt' })] })).files.map(file => file.path), ['/shown/b.txt']);
  });

  test('is null only where the source changes nothing, whether or not B says it: withdrawals, removals and a readable state with no line to write are evidence B does not print', () => {
    const back = { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' };
    const gone = { name: 'tdd', removed: true };
    // [source, what carriedEvidence lists, whether B renders text]
    const changing = [
      [carrier({ paths: [omitting({ withdraw: [4] })] }), { files: ['/shown/a.txt'], removed: [], skills: [] }, false],
      [carrier({ paths: [back] }), { files: ['/shown/back.txt'], removed: [], skills: [] }, false],
      [carrier({ removed: ['/r/gone.txt'] }), { files: [], removed: ['/r/gone.txt'], skills: [] }, false],
      [carrier({ skills: [gone] }), { files: [], removed: [], skills: [gone] }, false],
      [carrier({ paths: [{ path: '/r/e.txt', displayPath: '/shown/e.txt', state: 'empty' }] }), { files: ['/shown/e.txt'], removed: [], skills: [] }, true],
      [carrier({ paths: [{ path: '/r/m.txt', displayPath: '/shown/m.txt', state: 'unreadable', reason: 'missing' }] }), { files: ['/shown/m.txt'], removed: [], skills: [] }, true],
    ];
    for (const [source, expected, rendered] of changing) {
      const evidence = carriedEvidence(source);
      assert.deepEqual({ files: evidence.files.map(file => file.path), removed: evidence.removed, skills: evidence.skills }, expected);
      assert.equal(renderCarried(source) !== null, rendered, JSON.stringify(expected));
    }
    for (const source of [carrier(), carrier({ paths: [omitting()] })]) assert.equal(carriedEvidence(source), null, 'nothing changes');
  });

  test('hands the removed paths and the skills over as copies: changing them leaves the carrier\'s source as it was', () => {
    const evidence = carriedEvidence(SOURCE);
    evidence.removed.push('/r/other.txt');
    evidence.skills[0].text = 'changed';
    assert.deepEqual(SOURCE.removed, ['/r/gone.txt']);
    assert.equal(SOURCE.skills[0].text, 'Test first.');
  });
});

// ── Runs of consecutive line numbers ────────────────────────────────────────

describe('runsOf', () => {
  test('groups ascending line numbers into `[first, last]` runs of consecutive lines', () => {
    assert.deepEqual(runsOf([3, 4, 5, 6]), [[3, 6]]);
  });

  test('starts a run again at each gap', () => {
    assert.deepEqual(runsOf([1, 2, 4, 7, 8, 9, 12]), [[1, 2], [4, 4], [7, 9], [12, 12]]);
  });

  test('a single line is a run of its own, and no line is no run', () => {
    assert.deepEqual(runsOf([5]), [[5, 5]]);
    assert.deepEqual(runsOf([]), []);
  });
});
