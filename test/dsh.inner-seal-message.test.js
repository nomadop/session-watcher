// The inner-seal carrier's `source` and its one renderer: what a chain of carriers holds once folded, the changes a seal
// carries against that fold, and the content a stored `source` renders to.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CARRIER_WORDING, INNER_SEAL_KIND, STATE_ITEMS, carriedEvidence, carryChanges, carryState, foldCarried, omitShown, renderCarried, renderCarrier,
} from '../lib/harness/dsh/inner-seal-message.js';
import { readTreeWindows } from '../lib/working-tree-text.js';
import { createMemoryWorkingTree, createNodeWorkingTree } from '../lib/working-tree.js';
import { readObserved } from '../dsh/src/observed-read.js';

const carrier = ({ paths = [], removed, skills } = {}) => ({
  kind: INNER_SEAL_KIND, v: 1, slots: [], paths,
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
const sealed = (chain, view) => ({ kind: INNER_SEAL_KIND, v: 1, slots: [], ...carryChanges(foldCarried(chain), view) });

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
    assert.deepEqual(unchanged, { kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [] }, 'an unchanged seal carries no path entry, removal or skill');
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

// ── The body ─────────────────────────────────────────────────────────────────

const FILE = { attachmentId: 'att-file', name: 'notes.txt', bytes: 12 };
const SAVED = { attachmentId: 'att-saved', name: 'shot.png', bytes: 40 };

const SOURCE = {
  kind: INNER_SEAL_KIND, v: 1,
  slots: [
    { seqs: [4, 5], text: 'The user asked for the parser.', attachments: [{ file: FILE }] },
    { seqs: [7], text: 'The agent read the module.', attachments: [{ file: SAVED, image: { attachmentId: 'att-image', name: 'screen.png' } }] },
    { seqs: [9, 10], text: '' },
  ],
  paths: [
    { path: '/r/a.txt', displayPath: '/shown/a.txt', totalLines: 9, state: 'readable', write: [[1, 'one'], [2, 'two'], [5, 'five']], withdraw: [3, 4, 7] },
    { path: '/r/e.txt', displayPath: '/shown/e.txt', state: 'empty', withdraw: [1] },
    { path: '/r/m.txt', displayPath: '/shown/m.txt', state: 'unreadable', reason: 'missing' },
    { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' },
  ],
  removed: ['/r/gone.txt'],
  skills: [{ name: 'tdd', text: 'Test first.' }, { name: 'grill', removed: true }],
};

const toolOf = key => STATE_ITEMS.find(item => item.key === key).tool;

describe('the body', () => {
  test('renders C slot by slot under the address sentence with each slot\'s attachments after its line, then B entry by entry, written runs under their seal-time path and line count shown once per file, each text block breaking from the block before it and to a file after it, B after a blank line', () => {
    const W = CARRIER_WORDING;
    assert.deepEqual(renderCarrier(SOURCE), [
      { type: 'text', text: `${[W.addresses, `${W.slotLine([4, 5])}The user asked for the parser.`].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${[`${W.slotLine([7])}The agent read the module.`, W.imageSaved('screen.png')].join('\n')}\n` },
      { type: 'file', attachment: SAVED },
      { type: 'text', text: `\n${W.slotLine([9, 10])}` },
      {
        type: 'text',
        text: `\n\n${[
          W.carried,
          '/shown/a.txt (total lines: 9)\n1: one\n2: two\n--\n5: five',
          W.empty('/shown/e.txt'),
          W.unreadable('/shown/m.txt', 'missing'),
          W.skill('tdd', 'Test first.'),
        ].join('\n\n')}`,
      },
    ]);
  });

  test('a line in omit is left out of the body with nothing in its place: the lines that remain are runs of their own under the path, and no omitted row is in the body', () => {
    const DELTA = 'delta line of some length to show';
    const entry = entryOf('/r/a.txt', 6, [...BODY, DELTA], { displayPath: '/shown/a.txt' });
    const source = carrier({ paths: [{ ...entry, write: [...entry.write, [12, 'twelfth line']], omit: [7, 8, 9] }] });
    const body = renderCarrier(source).at(-1).text;
    assert.equal(body, `\n\n${[CARRIER_WORDING.carried, `/shown/a.txt (total lines: 40)\n6: ${BODY[0]}\n--\n12: twelfth line`].join('\n\n')}`);
    for (const text of [BODY[1], BODY[2], DELTA]) assert.ok(!body.includes(text), text);
  });

  test('a file whose written lines are all in omit has no path header and no run, whatever else its entry holds; a carrier with nothing else in B renders C alone', () => {
    const omitting = (extra = {}) => ({ ...entryOf('/r/a.txt', 6, BODY, { displayPath: '/shown/a.txt', omit: [6, 7, 8], ...extra }) });
    for (const extra of [{}, { withdraw: [1, 2, 3] }]) {
      const blocks = renderCarrier({ ...carrier({ paths: [omitting(extra)] }), slots: [{ seqs: [3], text: 'Done.' }] });
      assert.deepEqual(blocks, [{ type: 'text', text: [CARRIER_WORDING.addresses, `${CARRIER_WORDING.slotLine([3])}Done.`].join('\n') }]);
    }
  });

  describe('what a carrier no longer carries', () => {
    const withdrawing = { path: '/r/a.txt', displayPath: '/shown/a.txt', withdraw: [3, 4, 7] };
    const readable = { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' };
    const written = entryOf('/r/w.txt', 1, ['one'], { displayPath: '/shown/w.txt' });

    test('is no part of B: a source that withdraws lines, removes paths or skills or turns a path readable with no line to write renders no B block, and beside written lines B is what those lines alone give', () => {
      const only = [
        carrier({ paths: [withdrawing] }),
        carrier({ paths: [readable] }),
        carrier({ removed: ['/r/gone.txt', '/r/other.txt'] }),
        carrier({ skills: [{ name: 'grill', removed: true }] }),
        carrier({ paths: [withdrawing, readable], removed: ['/r/gone.txt'], skills: [{ name: 'grill', removed: true }] }),
      ];
      for (const source of only) {
        assert.equal(renderCarried(source), null);
        assert.deepEqual(renderCarrier({ ...source, slots: [{ seqs: [3], text: 'Done.' }] }).map(block => block.type), ['text'], 'C alone');
      }
      const beside = carrier({ paths: [{ ...written, withdraw: [3, 4, 7] }, readable], removed: ['/r/gone.txt'], skills: [{ name: 'grill', removed: true }] });
      assert.equal(renderCarried(beside), renderCarried(carrier({ paths: [written] })));
      for (const name of ['/r/gone.txt', '/shown/back.txt', 'grill']) assert.ok(!renderCarried(beside).includes(name), name);
    });
  });

  test('renderCarried is the text of the carrier\'s B block without the break that block opens with, and null where the source has no B to say', () => {
    const body = renderCarrier(SOURCE).at(-1).text;
    assert.ok(body.startsWith('\n\n'));
    assert.equal(renderCarried(SOURCE), body.slice(2));
    assert.equal(renderCarried({ kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] }), null);
    const omitting = entryOf('/r/a.txt', 6, BODY, { displayPath: '/shown/a.txt', omit: [6, 7, 8] });
    assert.equal(renderCarried({ ...carrier({ paths: [omitting] }), slots: [{ seqs: [3], text: 'Done.' }] }), null, 'a file whose written lines are all left out says nothing');
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

  test('a carrier that changes no B evidence renders C alone', () => {
    const blocks = renderCarrier({ kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] });
    assert.deepEqual(blocks, [{ type: 'text', text: [CARRIER_WORDING.addresses, `${CARRIER_WORDING.slotLine([3])}Done.`].join('\n') }]);
  });

  // The sources of the carriers sealed before the original questions were carried as text hold the raw call and result of each ask as `asks`: they render as they did, and no seal writes the field any more.
  const askOf = (id, text, isError = false, args = `{"questions":[{"id":"q-${id}","question":"Which?"}]}`) => ({
    call: { id, name: 'ask_user_question', arguments: args },
    result: { text, isError },
  });

  // Raw texts as a model and a tool may write them: pretty-printed arguments with line breaks and a long text, an answer with a line break in its custom text.
  const LONG_ARGUMENTS = JSON.stringify({ questions: [{ id: 'q-a', question: `Which?\nA second line.\n${'A long sentence of the question. '.repeat(120)}`, options: [{ label: 'Yes', description: 'Go.\nNow.' }, { label: 'No' }] }] }, null, 2);
  const LONG_RESULT = JSON.stringify({ answers: [{ id: 'q-a', selected: ['Yes'], custom: `Yes,\nbut later. ${'A long custom answer. '.repeat(120)}` }] });

  test('older source: a result the tool marked as an error renders differently from the same text that is no error: the answer is told from a failure, whatever the text says, and either way the text stands whole', () => {
    const of = isError => renderCarrier({ kind: INNER_SEAL_KIND, v: 1, paths: [], slots: [{ seqs: [3], text: 'Asked.', asks: [askOf('a', LONG_RESULT, isError)] }] });
    assert.notDeepEqual(of(true), of(false));
    for (const isError of [true, false]) assert.ok(of(isError)[0].text.includes(LONG_RESULT), `the result text is in the body whole, error flag ${isError}`);
  });

  test('older source: the original exchanges of a slot follow its note as lines of their own, each call before its own result and the next call after it, ahead of the slot\'s attachments and the next slot\'s line, the raw arguments and result texts whole whatever wording frames them, and the same slots without exchanges render as they did', () => {
    const W = CARRIER_WORDING;
    const first = askOf('a', LONG_RESULT, false, LONG_ARGUMENTS);
    const second = askOf('b', 'two\nlines', true);
    const slots = [
      { seqs: [3, 4], text: 'Asked twice.\nThe note has two lines.', asks: [first, second], attachments: [{ file: FILE }] },
      { seqs: [5], text: 'Next.' },
    ];
    const source = { kind: INNER_SEAL_KIND, v: 1, paths: [], slots };
    const note = `${W.slotLine([3, 4])}Asked twice.\nThe note has two lines.`;
    const lines = [W.addresses, note, W.askCall(first.call), W.askResult('a', first.result), W.askCall(second.call), W.askResult('b', second.result)];
    const blocks = renderCarrier(source);
    assert.deepEqual(blocks, [
      { type: 'text', text: `${lines.join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
    const places = ['The note has two lines.', LONG_ARGUMENTS, LONG_RESULT, second.call.arguments, 'two\nlines'].map(part => blocks[0].text.indexOf(part));
    assert.ok(places.every(at => at >= 0), 'the note and the raw texts are in the block whole');
    assert.deepEqual(places, [...places].sort((a, b) => a - b), 'in the order note, first call, first result, second call, second result');
    assert.deepEqual(renderCarrier({ ...source, slots: slots.map(({ asks, ...rest }) => rest) }), [
      { type: 'text', text: `${[W.addresses, note].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
  });

  // The question and answer texts as a model and a user may write them: multi-line, and long past any cut of a user's text.
  const LONG_QUESTION = `Which plan?\nPick one.\n${'A long sentence of the question. '.repeat(120)}`;
  const LONG_USER = `Ship now\nSplit\nShip the API,\nhold the UI. ${'A long custom answer. '.repeat(120)}`;

  test('the questions of a slot follow its note, each as a question line and the user\'s answer under it, ahead of the slot\'s attachments and the next slot\'s line, the texts whole; the address sentence names the question lines only for a carrier that has some, and the same slots without them render as they did', () => {
    const W = CARRIER_WORDING;
    const questions = [{ question: LONG_QUESTION, user: LONG_USER }, { question: 'Who owns it?', user: 'Platform' }];
    const slots = [
      { seqs: [3, 4], text: 'Asked twice.\nThe note has two lines.', questions, attachments: [{ file: FILE }] },
      { seqs: [5], text: 'Next.' },
    ];
    const source = { kind: INNER_SEAL_KIND, v: 1, paths: [], slots };
    const note = `${W.slotLine([3, 4])}Asked twice.\nThe note has two lines.`;
    const blocks = renderCarrier(source);
    assert.deepEqual(blocks, [
      { type: 'text', text: `${[`${W.addresses} ${W.questionMark}`, note, W.questionLine(LONG_QUESTION), W.userLine(LONG_USER), W.questionLine('Who owns it?'), W.userLine('Platform')].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
    // Independent of the wording: the originals stand whole in the block, in order.
    const places = ['The note has two lines.', LONG_QUESTION, LONG_USER, 'Who owns it?', 'Platform'].map(part => blocks[0].text.indexOf(part));
    assert.ok(places.every((at, index) => at >= 0 && (index === 0 || at > places[index - 1])), 'the note, then each question and its answer whole, in order');
    assert.deepEqual(renderCarrier({ ...source, slots: slots.map(({ questions: _, ...rest }) => rest) }), [
      { type: 'text', text: `${[W.addresses, note].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
  });

  const TODOS = { asOfSeq: 41, value: [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it\nand check the bundle', status: 'in_progress' }, { content: 'Announce', status: 'pending' }] };

  // The state block: the items a seal shows, each in its own line behind one heading with the cut.
  const W = CARRIER_WORDING;
  const AGENTS = [{ id: 'agent-1', label: 'review the parser' }, { id: 'agent-2', label: 'port the tests; then the docs' }];
  const JOBS = [{ id: 'bash-1a2b', label: 'npm run watch' }];
  const STATE = {
    asOfSeq: 41,
    items: {
      workingDirectory: { value: '/repo/app' },
      subagents: { value: AGENTS },
      jobs: { value: JOBS },
      todos: { value: TODOS.value },
    },
  };
  const lineOf = (key, tail) => `${W.stateLabels[key](toolOf(key))} ${tail}`;
  const stateText = (asOfSeq, lines) => `\n\n${[W.stateHeading(asOfSeq), ...lines].join('\n')}`;
  const stateOf = state => renderCarrier({ kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [], state });

  test('a source with a state renders its shown items last, after a blank line, under one heading with the session seq of the cut: each item one line in the fixed order working directory, running subagents, running jobs, todo list, whatever order the source holds them in', () => {
    const C = { type: 'text', text: [W.addresses, `${W.slotLine([3])}Done.`].join('\n') };
    const lines = [
      lineOf('workingDirectory', '/repo/app'),
      lineOf('subagents', W.stateList(AGENTS)),
      lineOf('jobs', W.stateList(JOBS)),
      lineOf('todos', JSON.stringify(TODOS.value.map(({ content, status }) => ({ content, status })))),
    ];
    assert.deepEqual(stateOf(STATE), [C, { type: 'text', text: stateText(41, lines) }]);
    const reversed = { asOfSeq: 41, items: Object.fromEntries(Object.entries(STATE.items).reverse()) };
    assert.deepEqual(stateOf(reversed), stateOf(STATE), 'the order of the keys is no part of the source');
    const some = { asOfSeq: 8, items: { jobs: { value: JOBS }, workingDirectory: { value: '/x' } } };
    assert.deepEqual(stateOf(some).at(-1), { type: 'text', text: stateText(8, [lineOf('workingDirectory', '/x'), lineOf('jobs', W.stateList(JOBS))]) }, 'only the shown items have a line');
  });

  test('an unchanged item says so after its colon in place of its value, and an empty one says it is empty; the source still holds the value of each', () => {
    const state = {
      asOfSeq: 5,
      items: {
        workingDirectory: { value: '/repo', unchanged: true },
        subagents: { value: [] },
        jobs: { value: [] },
        todos: { value: [{ content: 'Same', status: 'pending' }], unchanged: true },
      },
    };
    assert.deepEqual(stateOf(state).at(-1), {
      type: 'text',
      text: stateText(5, [
        lineOf('workingDirectory', W.stateUnchanged), lineOf('subagents', W.stateEmpty), lineOf('jobs', W.stateEmpty), lineOf('todos', W.stateUnchanged),
      ]),
    });
  });

  test('the state opens after the blank line whichever section stands before it, every earlier block keeping its break, and a source with no state renders as it did', () => {
    const withState = { ...SOURCE, state: STATE };
    const block = stateOf(STATE).at(-1);
    assert.deepEqual(renderCarrier(withState), [...renderCarrier(SOURCE), block], 'B stays where it was, the state behind it');
    const lastFile = { kind: INNER_SEAL_KIND, v: 1, slots: SOURCE.slots.slice(0, 1), paths: [], state: STATE };
    assert.deepEqual(renderCarrier(lastFile), [
      { type: 'text', text: `${[W.addresses, `${W.slotLine([4, 5])}The user asked for the parser.`].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      block,
    ], 'a file block last: the state breaks from its handle by a blank line');
    const bare = { kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] };
    assert.deepEqual(renderCarrier({ ...bare, state: STATE }), [...renderCarrier(bare), block]);
  });

  test('values that are not what their item holds render nothing, whichever item holds them: no substitute text stands for them', () => {
    const of = (key, value, ...cut) => () => stateOf({ asOfSeq: cut.length === 0 ? 3 : cut[0], items: { [key]: { value } } });
    const refused = [
      ['a working directory that is no text', of('workingDirectory', 5)],
      ['a working directory that is empty text', of('workingDirectory', '')],
      ['subagents that are no list', of('subagents', 'agent-1')],
      ['a subagent with no label', of('subagents', [{ id: 'agent-1' }])],
      ['a job that is no object', of('jobs', [null])],
      ['a job whose id is no text', of('jobs', [{ id: 4, label: 'x' }])],
      ['todos that are no list', of('todos', { content: 'x', status: 'pending' })],
      ['a todo with no status', of('todos', [{ content: 'x' }])],
      ['a value that is absent', of('jobs', undefined)],
      ['a cut that is no seq', of('jobs', JOBS, '3')],
      ['a cut that names none', of('jobs', JOBS, undefined)],
    ];
    for (const [why, render] of refused) assert.throws(render, Error, why);
    assert.doesNotThrow(of('jobs', JOBS, -1), 'an empty log\'s cut is a cut');
    assert.doesNotThrow(of('todos', null), 'a null todo list is the empty list');
  });

  test('an unknown item key in a source has no line and does not fail the render', () => {
    const state = { asOfSeq: 6, items: { jobs: { value: JOBS }, later: { value: 'x' } } };
    assert.deepEqual(stateOf(state).at(-1), { type: 'text', text: stateText(6, [lineOf('jobs', W.stateList(JOBS))]) });
  });
});

describe('the state a seal carries', () => {
  const TODO_A = [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }];
  const TODO_B = [{ content: 'Review it', status: 'pending' }];
  const MULTILINE = [{ content: 'Check the bundle\nthen the build', status: 'pending' }];
  const AGENT_A = [{ id: 'agent-1', label: 'review' }];
  const AGENT_B = [{ id: 'agent-1', label: 'review' }, { id: 'agent-2', label: 'port' }];
  const JOB_A = [{ id: 'bash-1', label: 'watch' }];
  const JOB_B = [{ id: 'bash-1', label: 'watch' }, { id: 'bash-2', label: 'serve' }];
  const ALL_TOOLS = new Set(STATE_ITEMS.map(({ tool }) => tool));

  // A carrier source an earlier seal left, showing `items` as `{ key: { value, unchanged? } }`, at the cut `asOfSeq`.
  const showing = (items, asOfSeq = 3) => ({ kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [], state: { asOfSeq, items } });
  // The items read as `{ key: value }`, each a read that answers its value.
  const readOf = (values, asOfSeq) => ({ asOfSeq, items: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, () => value])) });
  const carry = (values, earlier = [], options = {}) => {
    const { tools = ALL_TOOLS } = options;
    const failures = [];
    const state = carryState(readOf(values, Object.hasOwn(options, 'asOfSeq') ? options.asOfSeq : 9), { tools, earlier, failed: (item, error) => failures.push([item.key, error]) });
    return { state, failures };
  };

  // Per item: a value, a different value, the empty value, and a state that is the item's value with the same content spelled again.
  const ITEMS = {
    workingDirectory: { first: '/repo', other: '/repo/sub', again: '/repo', empty: undefined },
    subagents: { first: AGENT_A, other: AGENT_B, again: AGENT_A.map(entry => ({ ...entry })), empty: [] },
    jobs: { first: JOB_A, other: JOB_B, again: JOB_A.map(entry => ({ ...entry })), empty: [] },
    todos: { first: TODO_A, other: TODO_B, again: TODO_A.map(entry => ({ ...entry })), empty: [] },
  };

  test('each item follows the value the nearest retained carrier showing it left: never shown and empty it is left out, never shown and not empty it is shown whole, the same as shown it is shown as unchanged with its value unless it is empty, another it is shown whole, and an empty one is shown as empty whether or not it is the one last shown', () => {
    for (const [key, { first, other, again, empty }] of Object.entries(ITEMS)) {
      const alone = (value, earlier = []) => carry({ [key]: value }, earlier).state?.items[key];
      assert.deepEqual(alone(first), { value: first }, `${key}: never shown, not empty`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: first } })]), { value: first, unchanged: true }, `${key}: the same as shown`);
      assert.deepEqual(alone(again, [showing({ [key]: { value: first } })]), { value: again, unchanged: true }, `${key}: equal content, not the same object`);
      assert.deepEqual(alone(other, [showing({ [key]: { value: first } })]), { value: other }, `${key}: another value`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: first, unchanged: true } })]), { value: first, unchanged: true }, `${key}: a carrier that showed it as unchanged still shows it`);
      if (empty === undefined) continue;
      assert.equal(alone(empty), undefined, `${key}: never shown, empty`);
      assert.deepEqual(alone(empty, [showing({ [key]: { value: first } })]), { value: empty }, `${key}: empty after a value`);
      assert.deepEqual(alone(empty, [showing({ [key]: { value: empty } })]), { value: empty }, `${key}: empty again after an empty shown, still empty and not unchanged`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: empty } })]), { value: first }, `${key}: a value after an empty shown`);
    }
  });

  test('the nearest retained carrier that shows an item decides, whatever carriers that show other items or none stand between: A, B, A is shown again, and an earlier source of another kind or one without the item is no anchor', () => {
    const todos = value => showing({ todos: { value } });
    const other = showing({ jobs: { value: JOB_A } });
    const load = { kind: 'session-watcher-load', paths: [] };
    const rows = [
      ['A then carriers showing other items', [todos(TODO_A), other, showing({ workingDirectory: { value: '/x' } })], TODO_A, true],
      ['A, B, then A again', [todos(TODO_A), todos(TODO_B)], TODO_A, false],
      ['B, A, then none, then A', [todos(TODO_B), todos(TODO_A), other], TODO_A, true],
      ['A then the empty state, then A again', [todos(TODO_A), todos([])], TODO_A, false],
      ['a source that is not a carrier', [load], TODO_A, false],
      ['a multiline content the same', [todos(MULTILINE)], MULTILINE.map(entry => ({ ...entry })), true],
      ['a multiline content with its break read as a space', [todos(MULTILINE)], [{ content: 'Check the bundle then the build', status: 'pending' }], false],
      ['the same items in another order', [todos(TODO_A)], [...TODO_A].reverse(), false],
      ['one status changed', [todos(TODO_A)], TODO_A.map((entry, at) => (at === 0 ? { ...entry, status: 'pending' } : entry)), false],
    ];
    for (const [why, earlier, current, unchanged] of rows) {
      const { state } = carry({ todos: current }, earlier);
      assert.equal(state?.items.todos.unchanged === true, unchanged, why);
    }
  });

  test('the block is the shown items under one cut, in the fixed order of the items, and no block where no item is shown', () => {
    const { state } = carry({ todos: TODO_A, jobs: JOB_A, workingDirectory: '/repo', subagents: AGENT_A }, [], { asOfSeq: 41 });
    assert.equal(state.asOfSeq, 41);
    assert.deepEqual(Object.keys(state.items), STATE_ITEMS.map(({ key }) => key));
    assert.equal(carry({ todos: [], jobs: [], subagents: [] }).state, null, 'every item empty and never shown');
    assert.equal(carry({}).state, null, 'no item read at all');
    const settled = [showing({ todos: { value: [] }, jobs: { value: [] } })];
    assert.deepEqual(Object.keys(carry({ todos: [], jobs: [] }, settled).state.items), ['jobs', 'todos'], 'an empty item that was shown is shown again, not left out');
  });

  test('an item whose tool the session does not list is not read and not shown, and an item the host has no read for is neither, with no failure for either', () => {
    const reads = [];
    const read = { asOfSeq: 4, items: Object.fromEntries(STATE_ITEMS.map(({ key }) => [key, () => { reads.push(key); return key === 'workingDirectory' ? '/repo' : [{ id: 'x', label: 'y', content: 'z', status: 'pending' }]; }])) };
    const failures = [];
    const state = carryState(read, { tools: new Set([toolOf('jobs'), toolOf('todos'), 'read']), earlier: [], failed: (...args) => failures.push(args) });
    assert.deepEqual(Object.keys(state.items), ['jobs', 'todos']);
    assert.deepEqual(reads, ['jobs', 'todos'], 'only the items the session can read again are read');
    const { items: { jobs, ...rest } } = read;
    const without = carryState({ asOfSeq: 4, items: rest }, { tools: ALL_TOOLS, earlier: [], failed: () => failures.push('failed') });
    assert.deepEqual(Object.keys(without.items), ['workingDirectory', 'subagents', 'todos']);
    assert.deepEqual(failures, []);
    assert.equal(carryState(read, { tools: new Set(), earlier: [], failed: () => failures.push('failed') }), null, 'a session that lists none of them');
  });

  test('an item whose read throws or whose value is not what the item holds is left out and reported once with the item and the error, while every other item stands', () => {
    const boom = new Error('the jobs registry could not be read');
    const read = {
      asOfSeq: 12,
      items: {
        workingDirectory: () => '/repo',
        subagents: () => 'not a list',
        jobs: () => { throw boom; },
        todos: () => TODO_A,
      },
    };
    const failures = [];
    const state = carryState(read, { tools: ALL_TOOLS, earlier: [], failed: (item, error) => failures.push([item.key, error]) });
    assert.deepEqual(Object.keys(state.items), ['workingDirectory', 'todos']);
    assert.deepEqual(failures.map(([key]) => key), ['subagents', 'jobs'], 'one report per failing item, in the items\' order');
    assert.equal(failures[1][1], boom);
    assert.ok(failures[0][1] instanceof Error);
    const allFailing = carryState({ asOfSeq: 1, items: { jobs: () => { throw boom; } } }, { tools: ALL_TOOLS, earlier: [], failed: () => {} });
    assert.equal(allFailing, null, 'no item shown, no block');
    const badEarlier = carry({ todos: TODO_A }, [showing({ todos: { value: 'later' } })]);
    assert.equal(badEarlier.state, null, 'an earlier source that holds no list for the item fails the item, not the block');
    assert.deepEqual(badEarlier.failures.map(([key]) => key), ['todos']);
  });

  test('a cut that is no session seq is refused with an error, and the values handed out are copied: changing them later leaves the carried state as it was', () => {
    assert.throws(() => carry({ jobs: JOB_A }, [], { asOfSeq: undefined }), Error);
    assert.throws(() => carry({ jobs: JOB_A }, [], { asOfSeq: '3' }), Error);
    const live = { agents: AGENT_A.map(entry => ({ ...entry })), todos: TODO_A.map(entry => ({ ...entry })) };
    const { state } = carry({ subagents: live.agents, todos: live.todos });
    live.agents[0].label = 'rewritten';
    live.agents.push({ id: 'late', label: 'late' });
    live.todos[0].status = 'pending';
    assert.deepEqual(state.items.subagents.value, AGENT_A);
    assert.deepEqual(state.items.todos.value, TODO_A);
  });

  test('the carried state renders from the source alone and the carriers chain: a state carried against the first one renders its unchanged item as unchanged, its changed one whole', () => {
    const first = { kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [], state: carry({ workingDirectory: '/repo', todos: TODO_A }, [], { asOfSeq: 7 }).state };
    const second = { ...first, state: carry({ workingDirectory: '/repo', todos: TODO_B }, [first], { asOfSeq: 20 }).state };
    const tail = source => renderCarrier(source).at(-1).text;
    assert.ok(tail(first).includes(CARRIER_WORDING.stateHeading(7)));
    assert.ok(tail(second).includes(CARRIER_WORDING.stateHeading(20)));
    assert.ok(tail(second).includes(`${CARRIER_WORDING.stateLabels.workingDirectory(toolOf('workingDirectory'))} ${CARRIER_WORDING.stateUnchanged}`));
    assert.ok(tail(second).includes(JSON.stringify(TODO_B)) && !tail(second).includes(CARRIER_WORDING.stateLabels.todos(toolOf('todos')) + ' ' + CARRIER_WORDING.stateUnchanged));
    assert.deepEqual(JSON.parse(JSON.stringify(second)), second, 'the source is plain JSON');
  });
});

// ── Over the real `fs` ───────────────────────────────────────────────────────

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';
const skipReal = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;
const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

test('over a symlinked path the source keeps the Working Tree key, its rendered path is the realpath its seal read, and the stored source alone renders the same content after the link and the file change', { skip: skipReal }, async (t) => {
  const [{ Context }, fsLocal] = await Promise.all([CORDIS, 'packages/fs/fs-local/lib/index.js'].map(fromCheckout));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sw-inner-seal-message-')));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  await ctx.plugin(fsLocal.default, { cwd });
  writeFileSync(join(cwd, 'real.txt'), 'one\ntwo\nthree\n');
  symlinkSync(join(cwd, 'real.txt'), join(cwd, 'link.txt'));
  const key = join(cwd, 'link.txt');
  const tree = createNodeWorkingTree({ path: nodePath, homeDir: null, cacheEntries: 16, cacheChars: 1_000_000 });
  const { read, displayPath } = await readObserved({
    fs: ctx.fs, emit: () => {}, agent: {}, tree, key, ranges: [{ offset: 1, limit: 2 }], fileBytes: FILE_BYTES,
    signal: new AbortController().signal,
  });
  const source = sealed([], { paths: new Map([[key, { displayPath, read }]]), skills: new Map() });
  assert.equal(source.paths[0].path, key);
  assert.equal(source.paths[0].displayPath, join(cwd, 'real.txt'));

  const stored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(stored, source, 'the source is plain JSON with no absent key');
  const rendered = renderCarrier(source);
  writeFileSync(join(cwd, 'other.txt'), 'other\n');
  rmSync(key);
  symlinkSync(join(cwd, 'other.txt'), key);
  writeFileSync(join(cwd, 'real.txt'), 'changed\n');
  assert.deepEqual(renderCarrier(stored), rendered);
  assert.ok(rendered.at(-1).text.includes(`${join(cwd, 'real.txt')} (total lines: 3)\n1: one\n2: two`));
});
