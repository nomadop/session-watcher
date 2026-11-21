// The inner-seal carrier's `source` and its one renderer: the content a stored `source` renders to, where its B and its
// state block stand, the order of the events a carrier cites, and what the carrier's own read of the working tree stores.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CARRIER_WORDING, INNER_SEAL_KIND, assembleCarrierSource, callSeqOf, renderCarrier, sourceEventSeqsOf,
} from '../lib/inner-seal/carrier.js';
import { renderState } from '../lib/inner-seal/state-block.js';
import { CARRIED_WORDING, carriedNote, carryChanges, foldCarried, renderCarried } from '../lib/carried-evidence.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';
import { createNodeWorkingTree } from '../lib/working-tree.js';
import { readObserved } from '../dsh/src/observed-read.js';

const carrier = ({ paths = [], removed, skills } = {}) => ({
  kind: INNER_SEAL_KIND, v: 1, slots: [], paths,
  ...(removed === undefined ? {} : { removed }), ...(skills === undefined ? {} : { skills }),
});

const FILE_BYTES = 10_000;

// One seal over `view`: the changes against the fold of the carriers before it, made into the next carrier.
const sealed = (chain, view) => ({ kind: INNER_SEAL_KIND, v: 1, slots: [], ...carryChanges(foldCarried(chain), view) });

const BODY = ['alpha line of some length to show', 'beta line of some length to show', 'gamma line of some length to show'];
const entryOf = (path, first, texts, extra = {}) => ({
  path, displayPath: path, totalLines: 40, state: 'readable', write: texts.map((text, at) => [first + at, text]), ...extra,
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

describe('the body', () => {
  test('renders C slot by slot under the address sentence with each slot\'s attachments after its line, then B entry by entry, written runs under their seal-time path and line count shown once per file, each text block breaking from the block before it and to a file after it, B after a blank line', () => {
    const W = CARRIER_WORDING;
    assert.deepEqual(renderCarrier(SOURCE, CARRIER_TABLE), [
      { type: 'text', text: `${[CARRIER_TABLE.addresses, `${W.slotLine([4, 5])}The user asked for the parser.`].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${[`${W.slotLine([7])}The agent read the module.`, W.imageSaved('screen.png', CARRIER_TABLE.imageReadTool)].join('\n')}\n` },
      { type: 'file', attachment: SAVED },
      { type: 'text', text: `\n${W.slotLine([9, 10])}` },
      {
        type: 'text',
        text: `\n\n${[
          carriedNote(CARRIER_TABLE),
          '/shown/a.txt (total lines: 9)\n1: one\n2: two\n--\n5: five',
          CARRIED_WORDING.empty('/shown/e.txt'),
          CARRIED_WORDING.unreadable('/shown/m.txt', 'missing'),
          CARRIED_WORDING.skill('tdd', 'Test first.'),
        ].join('\n\n')}`,
      },
    ]);
  });

  test('a line in omit is left out of the body with nothing in its place: the lines that remain are runs of their own under the path, and no omitted row is in the body', () => {
    const DELTA = 'delta line of some length to show';
    const entry = entryOf('/r/a.txt', 6, [...BODY, DELTA], { displayPath: '/shown/a.txt' });
    const source = carrier({ paths: [{ ...entry, write: [...entry.write, [12, 'twelfth line']], omit: [7, 8, 9] }] });
    const body = renderCarrier(source, CARRIER_TABLE).at(-1).text;
    assert.equal(body, `\n\n${[carriedNote(CARRIER_TABLE), `/shown/a.txt (total lines: 40)\n6: ${BODY[0]}\n--\n12: twelfth line`].join('\n\n')}`);
    for (const text of [BODY[1], BODY[2], DELTA]) assert.ok(!body.includes(text), text);
  });

  test('a file whose written lines are all in omit has no path header and no run, whatever else its entry holds; a carrier with nothing else in B renders C alone', () => {
    const omitting = (extra = {}) => ({ ...entryOf('/r/a.txt', 6, BODY, { displayPath: '/shown/a.txt', omit: [6, 7, 8], ...extra }) });
    for (const extra of [{}, { withdraw: [1, 2, 3] }]) {
      const blocks = renderCarrier({ ...carrier({ paths: [omitting(extra)] }), slots: [{ seqs: [3], text: 'Done.' }] }, CARRIER_TABLE);
      assert.deepEqual(blocks, [{ type: 'text', text: [CARRIER_TABLE.addresses, `${CARRIER_WORDING.slotLine([3])}Done.`].join('\n') }]);
    }
  });

  describe('what a carrier no longer carries', () => {
    const withdrawing = { path: '/r/a.txt', displayPath: '/shown/a.txt', withdraw: [3, 4, 7] };
    const readable = { path: '/r/back.txt', displayPath: '/shown/back.txt', state: 'readable' };

    test('is no part of B: a source that withdraws lines, removes paths or skills or turns a path readable with no line to write renders C alone', () => {
      const only = [
        carrier({ paths: [withdrawing] }),
        carrier({ paths: [readable] }),
        carrier({ removed: ['/r/gone.txt', '/r/other.txt'] }),
        carrier({ skills: [{ name: 'grill', removed: true }] }),
        carrier({ paths: [withdrawing, readable], removed: ['/r/gone.txt'], skills: [{ name: 'grill', removed: true }] }),
      ];
      for (const source of only) {
        assert.deepEqual(renderCarrier({ ...source, slots: [{ seqs: [3], text: 'Done.' }] }, CARRIER_TABLE).map(block => block.type), ['text'], 'C alone');
      }
    });
  });

  test('renderCarried is the text of the carrier\'s B block without the break that block opens with', () => {
    const body = renderCarrier(SOURCE, CARRIER_TABLE).at(-1).text;
    assert.ok(body.startsWith('\n\n'));
    assert.equal(renderCarried(SOURCE, CARRIER_TABLE), body.slice(2));
  });

  test('a carrier that changes no B evidence renders C alone', () => {
    const blocks = renderCarrier({ kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] }, CARRIER_TABLE);
    assert.deepEqual(blocks, [{ type: 'text', text: [CARRIER_TABLE.addresses, `${CARRIER_WORDING.slotLine([3])}Done.`].join('\n') }]);
  });

  // The raw call and result of an ask an older source holds as `asks` are no part of what a carrier renders.
  test('a slot\'s `asks` render nothing: the source with them renders as the same slots without them, the raw texts nowhere in the body', () => {
    const W = CARRIER_WORDING;
    const ask = {
      call: { id: 'a', name: 'ask_user_question', arguments: '{"questions":[{"id":"q-a","question":"Which raw question?"}]}' },
      result: { text: '{"answers":[{"id":"q-a","selected":["Yes"]}]}', isError: false },
    };
    const slots = [{ seqs: [3, 4], text: 'Asked twice.\nThe note has two lines.', attachments: [{ file: FILE }] }, { seqs: [5], text: 'Next.' }];
    const source = { kind: INNER_SEAL_KIND, v: 1, paths: [] };
    const blocks = renderCarrier({ ...source, slots: slots.map((slot, at) => (at === 0 ? { ...slot, asks: [ask] } : slot)) }, CARRIER_TABLE);
    assert.deepEqual(blocks, renderCarrier({ ...source, slots }, CARRIER_TABLE));
    assert.deepEqual(blocks, [
      { type: 'text', text: `${[CARRIER_TABLE.addresses, `${W.slotLine([3, 4])}Asked twice.\nThe note has two lines.`].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
    assert.equal(blocks.some(block => block.type === 'text' && (block.text.includes('Which raw question?') || block.text.includes('Original'))), false);
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
    const blocks = renderCarrier(source, CARRIER_TABLE);
    assert.deepEqual(blocks, [
      { type: 'text', text: `${[`${CARRIER_TABLE.addresses} ${W.questionMark}`, note, W.questionLine(LONG_QUESTION), W.userLine(LONG_USER), W.questionLine('Who owns it?'), W.userLine('Platform')].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
    // Independent of the wording: the originals stand whole in the block, in order.
    const places = ['The note has two lines.', LONG_QUESTION, LONG_USER, 'Who owns it?', 'Platform'].map(part => blocks[0].text.indexOf(part));
    assert.ok(places.every((at, index) => at >= 0 && (index === 0 || at > places[index - 1])), 'the note, then each question and its answer whole, in order');
    assert.deepEqual(renderCarrier({ ...source, slots: slots.map(({ questions: _, ...rest }) => rest) }, CARRIER_TABLE), [
      { type: 'text', text: `${[CARRIER_TABLE.addresses, note].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      { type: 'text', text: `\n${W.slotLine([5])}Next.` },
    ]);
  });

  // The state block a source shows (`test/inner-seal.state-block.test.js` holds its text).
  const W = CARRIER_WORDING;
  const STATE = {
    asOfSeq: 41,
    items: {
      workingDirectory: { value: '/repo/app' },
      subagents: { value: [{ id: 'agent-1', label: 'review the parser' }] },
      jobs: { value: [] },
      todos: { value: [{ content: 'Announce', status: 'pending' }], unchanged: true },
    },
  };
  const stateOf = state => renderCarrier({ kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [], state }, CARRIER_TABLE);

  test('a source with a state renders its state block last as its own text block, the block opening after a blank line', () => {
    assert.deepEqual(stateOf(STATE), [
      { type: 'text', text: [CARRIER_TABLE.addresses, `${W.slotLine([3])}Done.`].join('\n') },
      { type: 'text', text: `\n\n${renderState(STATE, CARRIER_TABLE.stateItems)}` },
    ]);
  });

  test('the state opens after the blank line whichever section stands before it, every earlier block keeping its break, and a source with no state renders as it did', () => {
    const withState = { ...SOURCE, state: STATE };
    const block = stateOf(STATE).at(-1);
    assert.deepEqual(renderCarrier(withState, CARRIER_TABLE), [...renderCarrier(SOURCE, CARRIER_TABLE), block], 'B stays where it was, the state behind it');
    const lastFile = { kind: INNER_SEAL_KIND, v: 1, slots: SOURCE.slots.slice(0, 1), paths: [], state: STATE };
    assert.deepEqual(renderCarrier(lastFile, CARRIER_TABLE), [
      { type: 'text', text: `${[CARRIER_TABLE.addresses, `${W.slotLine([4, 5])}The user asked for the parser.`].join('\n')}\n` },
      { type: 'file', attachment: FILE },
      block,
    ], 'a file block last: the state breaks from its handle by a blank line');
    const bare = { kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [] };
    assert.deepEqual(renderCarrier({ ...bare, state: STATE }, CARRIER_TABLE), [...renderCarrier(bare, CARRIER_TABLE), block]);
  });
});

// ── The source a seal assembles ──────────────────────────────────────────────

describe('assembleCarrierSource', () => {
  const SLOTS = [{ seqs: [4, 5], step: { turn: 1, step: 1 } }, { seqs: [6] }];
  const CHANGES = { paths: [entryOf('/r/a.txt', 1, BODY)], removed: ['/r/gone.txt'], skills: [{ name: 'tdd', text: 'Test first.' }] };
  const QUESTION = { question: 'Which parser?', user: 'The fast one' };
  const STATE = { asOfSeq: 9, items: { todos: [] } };

  test('holds each slot\'s seqs and summary, with its questions and attachments where it has any, then the changes and the state, under the carrier\'s kind', () => {
    const source = assembleCarrierSource({
      slots: SLOTS, summaries: ['first', 'second'], questions: [[QUESTION], []], attachments: [[], [{ file: FILE }]], changes: CHANGES, state: STATE,
    });
    assert.deepEqual(source, {
      kind: INNER_SEAL_KIND, v: 1,
      slots: [{ seqs: [4, 5], text: 'first', questions: [QUESTION] }, { seqs: [6], text: 'second', attachments: [{ file: FILE }] }],
      ...CHANGES,
      state: STATE,
    });
  });

  test('a null state is no field, and a slot with no question and no attachment holds neither field', () => {
    const source = assembleCarrierSource({
      slots: SLOTS, summaries: ['first', 'second'], questions: [[], []], attachments: [[], []], changes: { paths: [] }, state: null,
    });
    assert.deepEqual(source, { kind: INNER_SEAL_KIND, v: 1, slots: [{ seqs: [4, 5], text: 'first' }, { seqs: [6], text: 'second' }], paths: [] });
    assert.equal(Object.hasOwn(source, 'state'), false);
  });
});

// ── The events a carrier cites ───────────────────────────────────────────────

describe('the events a carrier cites', () => {
  test('sourceEventSeqsOf cites the call record, then the prune, then the replaced events in the order given, neither sorted nor deduplicated', () => {
    assert.deepEqual(sourceEventSeqsOf({ callSeq: 30, pruneSeq: 31, replaced: [12, 13, 14, 7, 13] }), [30, 31, 12, 13, 14, 7, 13]);
    assert.deepEqual(sourceEventSeqsOf({ callSeq: 5, pruneSeq: 6, replaced: [] }), [5, 6]);
  });

  test('callSeqOf reads the call record\'s seq, the first a carrier cites', () => {
    assert.equal(callSeqOf([30, 31, 12, 13]), 30);
    assert.equal(callSeqOf(sourceEventSeqsOf({ callSeq: 9, pruneSeq: 4, replaced: [2, 3] })), 9);
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sw-inner-seal-carrier-')));
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
  const rendered = renderCarrier(source, CARRIER_TABLE);
  writeFileSync(join(cwd, 'other.txt'), 'other\n');
  rmSync(key);
  symlinkSync(join(cwd, 'other.txt'), key);
  writeFileSync(join(cwd, 'real.txt'), 'changed\n');
  assert.deepEqual(renderCarrier(stored, CARRIER_TABLE), rendered);
  assert.ok(rendered.at(-1).text.includes(`${join(cwd, 'real.txt')} (total lines: 3)\n1: one\n2: two`));
});
