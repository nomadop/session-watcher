// Line primitives: the shared line normalization, the line fingerprint, the generic line-number cue
// recognizer and the order-preserving alignment of two arrays.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitLines, normalizeLine, fingerprintOf, stripLinePrefix, alignCells, alignOrdered,
} from '../lib/line-align.js';

describe('splitLines', () => {
  test('a final terminator opens no further line, and its absence loses nothing', () => {
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  });

  test('CRLF splits like LF and a lone CR does not split', () => {
    assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
    assert.deepEqual(splitLines('a\rb'), ['a\rb']);
  });

  test('blank lines are lines; only the empty text has none', () => {
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('\n'), ['']);
    assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
    assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  });
});

describe('normalizeLine', () => {
  test('drops a trailing CR and trailing whitespace and keeps everything before', () => {
    const table = [
      ['abc', 'abc'],
      ['abc\r', 'abc'],
      ['abc  \t', 'abc'],
      ['abc \r', 'abc'],
      ['  abc', '  abc'],
      ['\tabc d', '\tabc d'],
      ['a  b', 'a  b'],
      ['   ', ''],
      ['', ''],
    ];
    for (const [input, expected] of table) assert.equal(normalizeLine(input), expected, JSON.stringify(input));
  });
});

describe('fingerprintOf', () => {
  test('equal lines hash alike and a one-character difference changes the hash', () => {
    assert.equal(fingerprintOf('const a = 1;'), fingerprintOf('const a = 1;'));
    assert.notEqual(fingerprintOf('const a = 1;'), fingerprintOf('const a = 2;'));
    assert.notEqual(fingerprintOf('ab'), fingerprintOf('ba'));
  });

  test('matches the published FNV-1a 32-bit vectors, over UTF-16 code units for non-ASCII text', () => {
    assert.equal(fingerprintOf(''), 0x811c9dc5);
    assert.equal(fingerprintOf('a'), 0xe40c292c);
    assert.equal(fingerprintOf('foobar'), 0xbf9cf968);
    assert.equal(fingerprintOf('你好，世界'), 0xe49c1bfc);
  });

  test('is an unsigned 32-bit integer', () => {
    for (const line of ['', 'a', 'foobar', '你好，世界', 'x'.repeat(1000)]) {
      const fp = fingerprintOf(line);
      assert.ok(Number.isInteger(fp) && fp >= 0 && fp <= 0xffffffff, line.slice(0, 8));
    }
  });

  test('lines that differ only in leading whitespace keep different fingerprints once normalized, and trailing whitespace does not', () => {
    const print = line => fingerprintOf(normalizeLine(line));
    const indented = ['return total;', ' return total;', '  return total;', '    return total;', '\treturn total;'];
    assert.equal(new Set(indented.map(print)).size, indented.length);
    assert.equal(print('return total;  \t'), print('return total;'));
  });
});

describe('stripLinePrefix', () => {
  const cue = (text, declaredLine, path = null) => ({ text, declaredLine, path });
  const bare = line => cue(line, null);

  test('recognizes the generic line-number cues the result formats use', () => {
    const table = [
      ['1\tconst a = 1;', cue('const a = 1;', 1)],
      ['     12\tconst b = 2;', cue('const b = 2;', 12)],
      ['4\t', cue('', 4)],
      ['7\t\tindented', cue('\tindented', 7)],
      ['  7→indented', cue('indented', 7)],
      ['12→', cue('', 12)],
      ['1: const a = 1;', cue('const a = 1;', 1)],
      ['2:    wide', cue('   wide', 2)],
      ['2:text', cue('text', 2)],
      ['Line 3: const a = 1;', cue('const a = 1;', 3)],
      ['Line 30:   spaced', cue('  spaced', 30)],
      ['8-baz', cue('baz', 8)],
    ];
    for (const [line, expected] of table) assert.deepEqual(stripLinePrefix(line), expected, JSON.stringify(line));
  });

  test('a line that merely starts with a digit, or carries no cue, is left whole', () => {
    const lines = [
      '3 apples', '2024 report', '1.5 release', '12', '5 → spaced arrow', '0\tline zero', 'Line 0: zero',
      'const a = 1;', '  indented', '', 'Line: x', 'Line x: y', 'line 3: lower case', 'src/a.js', '# heading',
      '99999999999999999999\tbeyond a safe integer',
    ];
    for (const line of lines) assert.deepEqual(stripLinePrefix(line), bare(line), JSON.stringify(line));
  });

  test('a colon-form row cuts its path at the first `:digits:` and keeps the rest verbatim', () => {
    assert.deepEqual(stripLinePrefix('src/a.js:10:first hit'), cue('first hit', 10, 'src/a.js'));
    assert.deepEqual(stripLinePrefix('src/a.js:10: indented hit'), cue(' indented hit', 10, 'src/a.js'));
    assert.deepEqual(stripLinePrefix('src/a.js:10:'), cue('', 10, 'src/a.js'));
    assert.deepEqual(stripLinePrefix('a.js:3:x:4:y'), cue('x:4:y', 3, 'a.js'));
    assert.deepEqual(stripLinePrefix('my dir/a b.js:5:z'), cue('z', 5, 'my dir/a b.js'));
  });

  test('a drive-letter path keeps its letter', () => {
    assert.deepEqual(stripLinePrefix('C:\\repo\\a.js:10:hit'), cue('hit', 10, 'C:\\repo\\a.js'));
    assert.deepEqual(stripLinePrefix('D:/repo/a.js:3:hit'), cue('hit', 3, 'D:/repo/a.js'));
  });

  test('forms without a colon-form path carry none', () => {
    assert.equal(stripLinePrefix('8-baz').path, null);
    assert.equal(stripLinePrefix('Line 3: x').path, null);
    assert.equal(stripLinePrefix('3: x').path, null);
    assert.equal(stripLinePrefix('1\tx').path, null);
    assert.deepEqual(stripLinePrefix('src/a.js-12-context row'), cue('context row', 12));
  });
});

// An array of strings and the same array as fingerprints must align alike: relocation feeds fingerprints,
// the matcher feeds text.
const AS_TEXT = lines => lines;
const AS_FINGERPRINTS = lines => lines.map(fingerprintOf);

for (const [label, encode] of [['strings', AS_TEXT], ['fingerprints', AS_FINGERPRINTS]]) {
  describe(`alignOrdered over ${label}`, () => {
    const align = (a, b, options) => alignOrdered(encode(a), encode(b), options);
    const BIG = { maxCells: 1_000_000, minTrim: 4 };

    test('identical sequences pair position by position', () => {
      const lines = ['a', 'b', 'c'];
      assert.deepEqual(align(lines, lines, BIG), [[0, 0], [1, 1], [2, 2]]);
      assert.deepEqual(align(lines, lines, { ...BIG, minTrim: 2 }), [[0, 0], [1, 1], [2, 2]]);
    });

    test('a middle insertion leaves the inserted element unpaired and shifts what follows', () => {
      const before = ['a', 'b', 'c', 'd'];
      const after = ['a', 'b', 'x', 'c', 'd'];
      assert.deepEqual(align(before, after, BIG), [[0, 0], [1, 1], [2, 3], [3, 4]]);
      assert.deepEqual(align(before, after, { ...BIG, minTrim: 2 }), [[0, 0], [1, 1], [2, 3], [3, 4]]);
    });

    test('a middle deletion leaves the deleted element unpaired', () => {
      const before = ['a', 'b', 'x', 'c', 'd'];
      const after = ['a', 'b', 'c', 'd'];
      assert.deepEqual(align(before, after, BIG), [[0, 0], [1, 1], [3, 2], [4, 3]]);
    });

    test('empty inputs pair nothing', () => {
      assert.deepEqual(align([], [], BIG), []);
      assert.deepEqual(align([], ['a'], BIG), []);
      assert.deepEqual(align(['a'], [], BIG), []);
      assert.deepEqual(align([], ['a'], { maxCells: 0, minTrim: 4 }), []);
    });

    test('wholly different sequences pair nothing', () => {
      assert.deepEqual(align(['a', 'b'], ['c', 'd', 'e'], BIG), []);
    });

    test('a long sequence with one inserted element aligns under a tiny maxCells when head and tail reach minTrim', () => {
      const head = Array.from({ length: 50 }, (_, i) => `h${i}`);
      const tail = Array.from({ length: 50 }, (_, i) => `t${i}`);
      const a = [...head, ...tail];
      const b = [...head, 'inserted', ...tail];
      const pairs = align(a, b, { maxCells: 1, minTrim: 5 });
      assert.equal(pairs.length, a.length);
      assert.deepEqual(pairs[49], [49, 49]);
      assert.deepEqual(pairs[50], [50, 51]);
      assert.deepEqual(pairs[99], [99, 100]);
    });

    test('two wholly different sequences whose middle product exceeds maxCells answer null', () => {
      const a = Array.from({ length: 10 }, (_, i) => `a${i}`);
      const b = Array.from({ length: 10 }, (_, i) => `b${i}`);
      assert.equal(align(a, b, { maxCells: 99, minTrim: 4 }), null);
      assert.deepEqual(align(a, b, { maxCells: 100, minTrim: 4 }), []);
    });

    test('a missing maxCells answers null rather than aligning without a bound', () => {
      assert.equal(align(['a', 'b'], ['b', 'a'], { minTrim: 4 }), null);
    });

    test('an equal tail shorter than minTrim stays with the middle, so a window lands at its own position', () => {
      const file = ['a', 'b', 'c', '}', 'x', 'y', 'z', '}'];
      const window = ['b', 'c', '}'];
      assert.deepEqual(align(file, window, { maxCells: 1000, minTrim: 4 }), [[1, 0], [2, 1], [3, 2]]);
      // The same inputs with the floor lowered pair the window's last line with the file's last line.
      assert.deepEqual(align(file, window, { maxCells: 1000, minTrim: 1 }), [[1, 0], [2, 1], [7, 2]]);
    });

    test('a missing minTrim trims nothing, so a window still lands at its own position', () => {
      const file = ['a', 'b', 'c', '}', 'x', 'y', 'z', '}'];
      const window = ['b', 'c', '}'];
      assert.deepEqual(align(file, window, { maxCells: 1000 }), [[1, 0], [2, 1], [3, 2]]);
      assert.deepEqual(align(file, file, { maxCells: 1000 }), file.map((_, i) => [i, i]));
    });

    test('an equal tail of at least minTrim keeps its positional pair', () => {
      const file = ['x', '}', 'y', '}', '}', '}'];
      const run = ['}', '}', '}'];
      assert.deepEqual(align(file, run, { maxCells: 1000, minTrim: 3 }), [[3, 0], [4, 1], [5, 2]]);
      assert.deepEqual(align(file, run, { maxCells: 1000, minTrim: 4 }), [[1, 0], [3, 1], [4, 2]]);
    });

    test('an equal head of at least minTrim keeps its positional pair', () => {
      const file = ['}', '}', '}', 'y', '}', 'x'];
      const run = ['}', '}', '}'];
      assert.deepEqual(align(file, run, { maxCells: 1000, minTrim: 3 }), [[0, 0], [1, 1], [2, 2]]);
      assert.deepEqual(align(file, ['}', '}', '}', 'x'], { maxCells: 3, minTrim: 3 }), [[0, 0], [1, 1], [2, 2], [5, 3]]);
    });

    test('duplicate lines in the middle resolve to the earliest position', () => {
      const huge = { maxCells: 1000, minTrim: 100 };
      assert.deepEqual(align(['a', 'x', 'x'], ['x'], huge), [[1, 0]]);
      assert.deepEqual(align(['x'], ['x', 'x'], huge), [[0, 0]]);
      assert.deepEqual(align(['q', 'x', 'q', 'x'], ['x', 'q', 'x'], huge), [[1, 0], [2, 1], [3, 2]]);
      // Crossing choices keep the earlier element of the first array.
      assert.deepEqual(align(['x', 'y'], ['y', 'x'], huge), [[0, 1]]);
    });

    test('the same inputs always give the same pairs', () => {
      const a = ['a', 'x', 'b', 'x', 'c', 'x'];
      const b = ['x', 'a', 'x', 'c', 'x'];
      const first = align(a, b, { maxCells: 1000, minTrim: 100 });
      assert.deepEqual(align(a, b, { maxCells: 1000, minTrim: 100 }), first);
    });
  });
}

describe('alignCells', () => {
  test('is the product of the two middle lengths after the equal head and tail are trimmed', () => {
    const a = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 7 }, (_, i) => `b${i}`);
    assert.equal(alignCells(a, b, { minTrim: 4 }), 70);
    assert.equal(alignCells(a, a, { minTrim: 4 }), 0);
    assert.equal(alignCells([], b, { minTrim: 4 }), 0);

    const head = ['h0', 'h1', 'h2', 'h3'];
    const tail = ['t0', 't1', 't2', 't3', 't4'];
    assert.equal(alignCells([...head, ...a, ...tail], [...head, ...b, ...tail], { minTrim: 4 }), 70);
  });

  test('a missing minTrim trims nothing, so the cells are the product of the full lengths', () => {
    assert.equal(alignCells(['a', 'b', 'c', '}', 'x', 'y', 'z', '}'], ['b', 'c', '}'], {}), 24);
    assert.equal(alignCells(['a', 'b'], ['a', 'b'], {}), 4);
  });

  test('an equal head or tail shorter than minTrim stays in the middle', () => {
    assert.equal(alignCells(['x', 'a', 'b'], ['x', 'c'], { minTrim: 2 }), 6);
    assert.equal(alignCells(['x', 'a', 'b'], ['x', 'c'], { minTrim: 1 }), 2);
    assert.equal(alignCells(['a', 'b', 'x'], ['c', 'x'], { minTrim: 2 }), 6);
  });

  test('is the bound alignOrdered checks, so the largest passing maxCells is exactly the product', () => {
    const a = ['a0', 'a1', 'a2'];
    const b = ['b0', 'b1', 'b2', 'b3'];
    const cells = alignCells(a, b, { minTrim: 2 });
    assert.equal(cells, 12);
    assert.notEqual(alignOrdered(a, b, { maxCells: cells, minTrim: 2 }), null);
    assert.equal(alignOrdered(a, b, { maxCells: cells - 1, minTrim: 2 }), null);
  });
});
