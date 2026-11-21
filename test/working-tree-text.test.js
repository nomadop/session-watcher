// The shared read of Working Tree text: `readTreeWindows`, which turns the ranges a caller asks for into numbered lines or says why the file cannot be read, `renderFileEvidence`, which renders the runs of one file's lines under a single path header. Both trees the port has answer the same table. The rendered rows are compared with the real `read` tool's in `test/dsh.load.integration.test.js` `each row of a block`.
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';

import { createMemoryWorkingTree, createNodeWorkingTree } from '../lib/working-tree.js';
import { readTreeWindows, renderFileEvidence } from '../lib/working-tree-text.js';

const FILE_BYTES = 100;

const FILES = {
  'five.txt': 'l1\nl2\nl3\nl4\nl5\n',
  'empty.txt': '',
  'crlf.txt': 'a\r\nb\r\n',
  'no-final-newline.txt': 'a\nb',
  'blank-line.txt': 'a\n\nb\n',
  'at-limit.txt': 'x'.repeat(FILE_BYTES),
  'over-limit.txt': 'x'.repeat(FILE_BYTES + 1),
  'binary.dat': 'a\u0000b\n',
  'dir/inner.txt': 'inner\n',
};

const root = mkdtempSync(join(tmpdir(), 'sw-working-tree-text-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const [name, text] of Object.entries(FILES)) {
  mkdirSync(join(root, name, '..'), { recursive: true });
  writeFileSync(join(root, name), text);
}

// Both adapters over the same files; `at(name)` is the key of a file in each, and `reads` records the keys `readText` was asked for.
function treesOver() {
  const adapters = [
    ['memory', createMemoryWorkingTree({
      files: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [`/repo/${name}`, text])), path: nodePath.posix, homeDir: null,
    }), name => `/repo/${name}`],
    ['node', createNodeWorkingTree({ path: nodePath, homeDir: null, cacheEntries: 16, cacheChars: 1_000_000 }), name => join(root, name)],
  ];
  return adapters.map(([kind, tree, at]) => {
    const reads = [];
    return { kind, at, reads, tree: { ...tree, readText: (key) => { reads.push(key); return tree.readText(key); } } };
  });
}

const lines = (...numbers) => numbers.map(number => ({ number, text: `l${number}` }));

describe('readTreeWindows', () => {
  for (const { kind, tree, at } of treesOver()) {
    const read = (name, ranges) => readTreeWindows(tree, at(name), ranges, { fileBytes: FILE_BYTES });

    test(`${kind}: each requested range is a window of its own, numbered by the file's lines`, () => {
      assert.deepEqual(read('five.txt', [{ offset: 1, limit: 2 }, { offset: 4, limit: 2 }]), {
        status: 'readable', totalLines: 5, windows: [{ offset: 1, lines: lines(1, 2) }, { offset: 4, lines: lines(4, 5) }],
      });
      assert.deepEqual(read('five.txt', [{ offset: 3, limit: 1 }, { offset: 2, limit: 1 }]).windows, [
        { offset: 3, lines: lines(3) }, { offset: 2, lines: lines(2) },
      ], 'in the order asked, overlap and all');
    });

    test(`${kind}: a line past the end is dropped, and a range left with no line answers no window`, () => {
      assert.deepEqual(read('five.txt', [{ offset: 4, limit: 10 }]).windows, [{ offset: 4, lines: lines(4, 5) }]);
      assert.deepEqual(read('five.txt', [{ offset: 6, limit: 2 }]), { status: 'readable', totalLines: 5, windows: [] });
      assert.deepEqual(read('five.txt', [{ offset: 1, limit: 1 }, { offset: 9, limit: 1 }, { offset: 5, limit: 1 }]).windows, [
        { offset: 1, lines: lines(1) }, { offset: 5, lines: lines(5) },
      ]);
    });

    test(`${kind}: an empty file read at line 1 answers an empty window, and read anywhere else answers none`, () => {
      assert.deepEqual(read('empty.txt', [{ offset: 1, limit: 40 }]), {
        status: 'readable', totalLines: 0, windows: [{ offset: 1, lines: [] }],
      });
      assert.deepEqual(read('empty.txt', [{ offset: 2, limit: 40 }]), { status: 'readable', totalLines: 0, windows: [] });
    });

    test(`${kind}: lines split as the matcher splits them`, () => {
      const textsOf = name => read(name, [{ offset: 1, limit: 10 }]).windows[0].lines.map(line => line.text);
      assert.deepEqual(textsOf('crlf.txt'), ['a', 'b']);
      assert.deepEqual(textsOf('no-final-newline.txt'), ['a', 'b']);
      assert.deepEqual(textsOf('blank-line.txt'), ['a', '', 'b']);
      assert.equal(read('blank-line.txt', []).totalLines, 3);
    });

    test(`${kind}: a file of exactly the size limit is read and one byte more is too large, unread`, () => {
      assert.equal(read('at-limit.txt', [{ offset: 1, limit: 1 }]).status, 'readable');
      assert.deepEqual(read('over-limit.txt', [{ offset: 1, limit: 1 }]), { status: 'unreadable', reason: 'too-large' });
    });

    test(`${kind}: each way a path cannot be read answers its reason`, () => {
      const reasons = {
        'absent.txt': 'missing',
        dir: 'not-file',
        'over-limit.txt': 'too-large',
        'binary.dat': 'binary',
      };
      for (const [name, reason] of Object.entries(reasons)) {
        assert.deepEqual(read(name, [{ offset: 1, limit: 1 }]), { status: 'unreadable', reason }, name);
      }
    });
  }

  test('a file the tree cannot read although it stats is unreadable', () => {
    const [{ tree, at }] = treesOver();
    const refusing = { ...tree, readText: () => null };
    assert.deepEqual(readTreeWindows(refusing, at('five.txt'), [{ offset: 1, limit: 1 }], { fileBytes: FILE_BYTES }),
      { status: 'unreadable', reason: 'unreadable' });
  });

  test('a file over the size limit is judged by its stat and its text is never asked for', () => {
    for (const { kind, tree, at, reads } of treesOver()) {
      readTreeWindows(tree, at('over-limit.txt'), [{ offset: 1, limit: 1 }], { fileBytes: FILE_BYTES });
      assert.deepEqual(reads, [], kind);
    }
  });
});

const PATH = '/repo/five.txt';
const rows = (...numbers) => lines(...numbers);

describe('renderFileEvidence', () => {
  test('a file is one path header with its total lines, then its numbered rows, runs that are not adjacent apart by a `--` line, with no read envelope or per-run footer', () => {
    assert.deepEqual(renderFileEvidence(PATH, { totalLines: 9, runs: [{ offset: 1, lines: rows(1, 2) }, { offset: 5, lines: rows(5) }] }), {
      text: `${PATH} (total lines: 9)\n1: l1\n2: l2\n--\n5: l5`,
      shown: [2, 1],
    });
  });

  test('runs whose line numbers follow on are one stretch with no `--`, and a run of no line leaves no mark', () => {
    assert.deepEqual(renderFileEvidence(PATH, { totalLines: 9, runs: [{ offset: 1, lines: rows(1, 2) }, { offset: 3, lines: rows(3, 4) }, { offset: 9, lines: [] }, { offset: 5, lines: rows(5) }, { offset: 8, lines: rows(8) }] }), {
      text: `${PATH} (total lines: 9)\n1: l1\n2: l2\n3: l3\n4: l4\n5: l5\n--\n8: l8`,
      shown: [2, 2, 0, 1, 1],
    });
  });

  test('an empty file is its header alone, and a line is shown whole however long', () => {
    assert.deepEqual(renderFileEvidence('/repo/empty.txt', { totalLines: 0, runs: [{ offset: 1, lines: [] }] }),
      { text: '/repo/empty.txt (total lines: 0)', shown: [0] });
    const text = 'z'.repeat(5000);
    assert.ok(renderFileEvidence(PATH, { totalLines: 1, runs: [{ offset: 1, lines: [{ number: 1, text }] }] }).text.endsWith(`\n1: ${text}`));
  });

  describe('under a cap', () => {
    // Six lines of equal length, so a cap lands on a line boundary.
    const ROW = 'r'.repeat(40);
    const ROWS_PATH = '/repo/rows.txt';
    const ROWS = { totalLines: 6, runs: [{ offset: 1, lines: Array.from({ length: 6 }, (_, index) => ({ number: index + 1, text: ROW })) }] };
    const head = `${ROWS_PATH} (total lines: 6)`;
    const cut = (count) => {
      const shown = Array.from({ length: count }, (_, index) => `${index + 1}: ${ROW}`);
      return [head, ...shown, `(Output capped after line ${count}. Use offset=${count + 1} to continue.)`].join('\n');
    };
    const WHOLE = [head, ...Array.from({ length: 6 }, (_, index) => `${index + 1}: ${ROW}`)].join('\n');

    test('a cap the whole rendering fits leaves it as it is, and one it exceeds ends the run at the last whole line that fits with the notice of where to continue', () => {
      assert.deepEqual(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: WHOLE.length }), { text: WHOLE, shown: [6] });
      assert.deepEqual(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: cut(3).length }), { text: cut(3), shown: [3] });
      assert.deepEqual(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: cut(3).length + 1 }), { text: cut(3), shown: [3] }, 'a line that would not fit with its notice is not shown');
      assert.deepEqual(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: cut(3).length - 1 }), { text: cut(2), shown: [2] });
    });

    test('a capped rendering never exceeds the cap, and a larger cap never shows fewer lines of one run', () => {
      const long = { totalLines: 400, runs: [{ offset: 95, lines: Array.from({ length: 12 }, (_, index) => ({ number: 95 + index, text: 'y'.repeat(index * 3) })) }] };
      let shown = 0;
      for (let maxChars = 0; maxChars < 500; maxChars += 1) {
        const rendered = renderFileEvidence('/repo/long.txt', long, { maxChars });
        if (rendered === null) {
          assert.equal(shown, 0, `${maxChars}: a larger cap showed a line and this one shows none`);
          continue;
        }
        assert.ok(rendered.text.length <= maxChars, `${maxChars}: ${rendered.text.length}`);
        assert.ok(rendered.shown[0] >= shown, `${maxChars}: fewer lines than a smaller cap`);
        shown = rendered.shown[0];
      }
      assert.equal(shown, 12, 'the largest cap shows the whole run');
    });

    test('a cap under which no line fits, or under the header itself, answers null', () => {
      assert.equal(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: cut(1).length - 1 }), null);
      assert.equal(renderFileEvidence(ROWS_PATH, ROWS, { maxChars: 10 }), null);
      assert.deepEqual(renderFileEvidence('/repo/empty.txt', { totalLines: 0, runs: [{ offset: 1, lines: [] }] }, { maxChars: '/repo/empty.txt (total lines: 0)'.length }),
        { text: '/repo/empty.txt (total lines: 0)', shown: [0] });
      assert.equal(renderFileEvidence('/repo/empty.txt', { totalLines: 0, runs: [{ offset: 1, lines: [] }] }, { maxChars: 20 }), null);
    });

    test('the runs take the cap in order: one cut to its first lines leaves what it did not use to the next, and one of which no line fits is skipped', () => {
      const tiny = { offset: 20, lines: [{ number: 20, text: 'tiny' }, { number: 21, text: 'tiny' }] };
      const tail = `\n--\n20: tiny\n21: tiny`;
      const both = { totalLines: 21, runs: [ROWS.runs[0], tiny] };
      const expected = `${cut(2).replace('(total lines: 6)', '(total lines: 21)')}${tail}`;
      assert.deepEqual(renderFileEvidence(ROWS_PATH, both, { maxChars: expected.length }), { text: expected, shown: [2, 2] });

      const wide = { offset: 1, lines: [{ number: 1, text: 'w'.repeat(1000) }, { number: 2, text: 'narrow' }] };
      const skipped = `${ROWS_PATH} (total lines: 21)\n20: tiny\n21: tiny`;
      assert.deepEqual(renderFileEvidence(ROWS_PATH, { totalLines: 21, runs: [wide, tiny] }, { maxChars: skipped.length }), { text: skipped, shown: [0, 2] });
    });

    test('the `--` line between runs is counted in the cap, and adjacent runs have none to count', () => {
      const one = (number, text) => ({ offset: number, lines: [{ number, text }] });
      const apart = { totalLines: 9, runs: [one(1, 'aa'), one(5, 'bb')] };
      const whole = `${PATH} (total lines: 9)\n1: aa\n--\n5: bb`;
      assert.deepEqual(renderFileEvidence(PATH, apart, { maxChars: whole.length }), { text: whole, shown: [1, 1] });
      assert.deepEqual(renderFileEvidence(PATH, apart, { maxChars: whole.length - 1 }), { text: `${PATH} (total lines: 9)\n1: aa`, shown: [1, 0] });
      const together = `${PATH} (total lines: 9)\n1: aa\n2: bb`;
      assert.deepEqual(renderFileEvidence(PATH, { totalLines: 9, runs: [one(1, 'aa'), one(2, 'bb')] }, { maxChars: together.length }), { text: together, shown: [1, 1] });
    });

    test('a run that was capped is followed by `--` whatever line number the next one opens with, and one that follows a skipped run is judged by the last line shown', () => {
      const next = { offset: 4, lines: [{ number: 4, text: 'tiny' }] };
      const capped = `${cut(3).replace('(total lines: 6)', '(total lines: 9)')}\n--\n4: tiny`;
      assert.deepEqual(renderFileEvidence(ROWS_PATH, { totalLines: 9, runs: [ROWS.runs[0], next] }, { maxChars: capped.length }), { text: capped, shown: [3, 1] });

      const wide = { offset: 3, lines: [{ number: 3, text: 'w'.repeat(1000) }] };
      const joined = `${ROWS_PATH} (total lines: 9)\n1: tiny\n2: tiny\n4: tiny`;
      const first = { offset: 1, lines: [{ number: 1, text: 'tiny' }, { number: 2, text: 'tiny' }] };
      assert.deepEqual(renderFileEvidence(ROWS_PATH, { totalLines: 9, runs: [first, wide, next] }, { maxChars: joined.length + 3 }), { text: joined.replace('\n4: tiny', '\n--\n4: tiny'), shown: [2, 0, 1] });
    });
  });
});
