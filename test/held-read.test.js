// The read guard's rule (`lib/held-read.js`) over a scratch the real tool-evidence interpreter keeps: what a call's text left in it, read through the view (`lib/scratch-view.js`) that wraps the interpreter a Projection is built with.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { heldReadOf } from '../lib/held-read.js';
import { createScratchView } from '../lib/scratch-view.js';
import { createDshMeasurementProjection } from '../lib/harness/dsh/measurement-projection.js';
import { CWD, dshObservations, dshRig, editableTree, readResultText, resolveModelPolicy } from './helpers/attribution-fixtures.js';

const FILE = '/repo/src/a.js';
const LINES = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;', 'export const delta = 4;', 'export const epsilon = 5;'];
const textOf = lines => `${lines.join('\n')}\n`;
const shown = (lines, from = 1) => lines.map((text, index) => ({ number: from + index, text }));

// A Projection built over the view, fed the calls in order, and the scratch the view then reads. A call that carries `files` finds the tree as they say.
function scratchAfter(calls, files = { [FILE]: textOf(LINES) }) {
  const tree = editableTree(files);
  const rig = dshRig({ workingTree: tree.workingTree });
  const view = createScratchView();
  const projection = createDshMeasurementProjection({ cwd: CWD, resolveModelPolicy, ...view.observing(rig.interpreters) });
  calls.forEach((call, index) => {
    if (call.files !== undefined) tree.set(call.files);
    const { use, result } = dshObservations({ ...call, callId: `call_${index + 1}` });
    projection.project(use, {});
    projection.project(result, {});
  });
  return view.read();
}

const READ = { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, LINES) };
const entryAtOf = (scratch, key = FILE) => number => scratch.get(key)?.get(number);

describe('the scratch view', () => {
  test('it holds no scratch before a call and the Map a call was handed after it, whichever interpreter function took it', () => {
    const view = createScratchView();
    assert.equal(view.read(), null);
    const seen = [];
    const wrapped = view.observing({
      interpretToolUse: (...args) => { seen.push(args); return 'used'; },
      completeToolResult: (...args) => { seen.push(args); return 'completed'; },
    });
    const first = new Map();
    assert.equal(wrapped.interpretToolUse('a', 'b', { scratch: first }), 'used');
    assert.equal(view.read(), first);
    const second = new Map();
    assert.equal(wrapped.completeToolResult('p', 'o', 'c', { scratch: second }), 'completed');
    assert.equal(view.read(), second, 'a Projection that is built again hands the next call a new Map');
    assert.deepEqual(seen.map(args => args.length), [3, 4], 'each function is called with the arguments it was given');
    assert.equal(wrapped.interpretToolUse('a', 'b'), 'used');
    assert.equal(view.read(), second, 'a call handed no scratch leaves the view as it was');
  });

  test('over the real interpreter the scratch holds the lines a read returned', () => {
    const scratch = scratchAfter([READ]);
    assert.deepEqual([...scratch.get(FILE).keys()], [1, 2, 3, 4, 5]);
  });
});

describe('a read of lines the scratch holds', () => {
  const scratch = scratchAfter([READ]);

  test('every line held word for word answers its first and last line, whatever window of them was read', () => {
    assert.deepEqual(heldReadOf({ lines: shown(LINES), entryAt: entryAtOf(scratch) }), { first: 1, last: 5 });
    assert.deepEqual(heldReadOf({ lines: shown(LINES.slice(1, 3), 2), entryAt: entryAtOf(scratch) }), { first: 2, last: 3 });
  });

  test('one line past what the scratch holds, one line of other text and one line a line number off each answer null', () => {
    assert.equal(heldReadOf({ lines: shown([...LINES, 'export const zeta = 6;']), entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown([LINES[0], 'export const beta = 22;', ...LINES.slice(2)]), entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown(LINES.slice(1), 1), entryAt: entryAtOf(scratch) }), null);
  });

  test('a line whose trailing space changed in length is not the held line, though its fingerprint is', () => {
    const padded = [LINES[0], `${LINES[1]} `, ...LINES.slice(2)];
    assert.equal(heldReadOf({ lines: shown(padded), entryAt: entryAtOf(scratch) }), null);
  });

  test('a read with no line and a file the scratch holds none of answer null', () => {
    assert.equal(heldReadOf({ lines: [], entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown(LINES), entryAt: entryAtOf(scratch, '/repo/src/other.js') }), null);
  });

  test('a long line the read cut is not the file\'s line, so its read is never held', () => {
    const cut = [LINES[0], `${LINES[1].slice(0, 10)}... (line truncated to 10 chars)`, ...LINES.slice(2)];
    assert.equal(heldReadOf({ lines: shown(cut), entryAt: entryAtOf(scratch) }), null);
  });

  test('CJK text is compared as the scratch holds it', () => {
    const cjk = ['const 名 = "一";', 'const 姓 = "二";'];
    const held = scratchAfter([{ name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, cjk) }], { [FILE]: textOf(cjk) });
    assert.deepEqual(heldReadOf({ lines: shown(cjk), entryAt: entryAtOf(held) }), { first: 1, last: 2 });
    assert.equal(heldReadOf({ lines: shown(['const 名 = "三";', cjk[1]]), entryAt: entryAtOf(held) }), null);
  });
});

describe('a line with the reminder\'s closing tag', () => {
  // A carrier writes the closing tag escaped, so the context holds that line in another text than the file's, though the scratch holds the line the file has.
  const TAGGED = [...LINES.slice(0, 2), "const closing = '</system-reminder>';", ...LINES.slice(3)];
  const scratch = scratchAfter([{ name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, TAGGED) }], { [FILE]: textOf(TAGGED) });

  test('a read that returns it is not held, whichever lines it returns besides, and a read of the lines around it still is', () => {
    assert.equal(heldReadOf({ lines: shown(TAGGED), entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown(TAGGED.slice(2, 3), 3), entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown(TAGGED.slice(1, 4), 2), entryAt: entryAtOf(scratch) }), null);
    assert.deepEqual(heldReadOf({ lines: shown(TAGGED.slice(0, 2)), entryAt: entryAtOf(scratch) }), { first: 1, last: 2 });
    assert.deepEqual(heldReadOf({ lines: shown(TAGGED.slice(3), 4), entryAt: entryAtOf(scratch) }), { first: 4, last: 5 });
  });

  test('the same lines with the tag written as the carrier escapes it are held as any line is', () => {
    const escaped = TAGGED.map(line => line.replace('</system-reminder>', '<\\/system-reminder>'));
    const held = scratchAfter([{ name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, escaped) }], { [FILE]: textOf(escaped) });
    assert.deepEqual(heldReadOf({ lines: shown(escaped), entryAt: entryAtOf(held) }), { first: 1, last: 5 });
  });
});

describe('what another tool left in the scratch', () => {
  test('lines a `cat` showed as they stand, with no row number, are held as the read returns them', () => {
    const scratch = scratchAfter([{ name: 'bash', args: { command: 'cat src/a.js' }, text: textOf(LINES) }]);
    assert.deepEqual(heldReadOf({ lines: shown(LINES), entryAt: entryAtOf(scratch) }), { first: 1, last: 5 });
  });

  test('a file rewritten after it was read has other fingerprints at the lines it changed, so a read of it is not held', () => {
    const scratch = scratchAfter([READ]);
    const changed = [LINES[0], 'export const beta = 20;', ...LINES.slice(2)];
    assert.equal(heldReadOf({ lines: shown(changed), entryAt: entryAtOf(scratch) }), null);
    assert.deepEqual(heldReadOf({ lines: shown(changed.slice(2), 3), entryAt: entryAtOf(scratch) }), { first: 3, last: 5 }, 'the lines it left alone still are');
  });
});

describe('lines that moved since they were shown', () => {
  const ABOVE = 'export const zero = 0;';
  const inserted = [ABOVE, ...LINES];
  // The whole file is read, a line is put above it, and a read of that line alone touches the file: the lines the model was shown move down one number.
  const scratch = scratchAfter([
    READ,
    { files: { [FILE]: textOf(inserted) }, name: 'read', args: { file_path: 'src/a.js', offset: 1, limit: 1 }, text: readResultText(FILE, inserted, { from: 1, to: 1 }) },
  ]);

  test('a read of the whole file is not held, though each moved line shows as many characters at its new number as at its old one', () => {
    assert.equal(heldReadOf({ lines: shown(inserted), entryAt: entryAtOf(scratch) }), null);
    assert.equal(heldReadOf({ lines: shown(LINES, 2), entryAt: entryAtOf(scratch) }), null);
  });

  test('the line the touching call showed at its own number is held', () => {
    assert.deepEqual(heldReadOf({ lines: shown([ABOVE]), entryAt: entryAtOf(scratch) }), { first: 1, last: 1 });
  });

  test('a moved line shown again at its new number is held from then on', () => {
    const again = scratchAfter([
      READ,
      { files: { [FILE]: textOf(inserted) }, name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, inserted) },
    ]);
    assert.deepEqual(heldReadOf({ lines: shown(inserted), entryAt: entryAtOf(again) }), { first: 1, last: 6 });
  });
});
