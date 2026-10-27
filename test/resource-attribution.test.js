// Resource Attribution: the side text and its JSON views, the path cues and candidate files, the match tiers
// and their adjudication, and the interface invariants, all over in-memory working trees.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import path from 'node:path';

import { createResourceAttribution, sideTextOf } from '../lib/resource-attribution.js';
import { createMemoryWorkingTree } from '../lib/working-tree.js';
import { alignCells, fingerprintOf } from '../lib/line-align.js';
import { BASE, CORPUS, fileOf } from './helpers/attribution-corpus.js';

const LIMITS = {
  candidates: 8,
  fileBytes: 10_000,
  sideChars: 100_000,
  decodeDepth: 4,
  alignCells: 100_000,
  evidenceFloor: 2,
};

const treeOf = files => createMemoryWorkingTree({ files, path: path.posix, homeDir: null });

function attributionOver(files, limits = {}) {
  return createResourceAttribution({ workingTree: treeOf(files), limits: { ...LIMITS, ...limits } });
}

// Every `attribute` call but the one that asserts the failure answer goes through here, so the internal
// catch cannot hide a case a test missed.
function run(attribution, args) {
  const result = attribution.attribute({ base: BASE, ...args });
  assert.equal(result.stats.failed, false, result.stats.failure);
  return result;
}

describe('side text', () => {
  test('a string is its own text and an absent value is empty', () => {
    assert.equal(sideTextOf('alpha\nbeta\n'), 'alpha\nbeta\n');
    assert.equal(sideTextOf(undefined), '');
    assert.equal(sideTextOf(null), '');
  });

  test('a content-block array joins its text blocks with a newline and counts no other block', () => {
    const blocks = [
      { type: 'text', text: 'one' },
      { type: 'image', source: { data: 'x'.repeat(500) } },
      { type: 'text', text: 'two' },
    ];
    assert.equal(sideTextOf(blocks), 'one\ntwo');
    assert.equal(sideTextOf([{ type: 'image', source: {} }]), '');
  });

  test('any other JSON is its serialization', () => {
    assert.equal(sideTextOf({ a: 1 }), '{"a":1}');
    assert.equal(sideTextOf([1, 2]), '[1,2]');
    assert.equal(sideTextOf(42), '42');
    assert.equal(sideTextOf(() => 1), '');
  });

  test('a value that cannot be serialized is empty text', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(sideTextOf(cyclic), '');
    assert.equal(sideTextOf({ n: 1n }), '');
  });
});

describe('character conservation without a match', () => {
  const none = attributionOver({});
  const unmatchedOf = (input, output) => {
    const { unmatched } = run(none, { input, output });
    return [unmatched.input, unmatched.output];
  };

  test('plain text is all unmatched, by its hand-counted length', () => {
    // alpha(5) + LF + beta(4) + LF + gamma(5) + LF
    assert.deepEqual(unmatchedOf(undefined, 'alpha\nbeta\ngamma\n'), [0, 17]);
  });

  test('a content-block array with an image block counts the text blocks and their joining newline', () => {
    // l1(2) + LF + l2(2) + LF + l3(2) + LF(join) + l4(2)
    const blocks = [{ type: 'text', text: 'l1\nl2\nl3' }, { type: 'image', source: {} }, { type: 'text', text: 'l4' }];
    assert.deepEqual(unmatchedOf(undefined, blocks), [0, 11]);
  });

  test('JSON-wrapped text keeps its quotes, escapes and CJK in the side length', () => {
    // {"text":" (9) + 第一行 (3) + \n escape (2) + second line (11) + \n escape (2) + 第三行 (3) + "} (2)
    const wrapped = JSON.stringify({ text: '第一行\nsecond line\n第三行' });
    assert.equal(wrapped.length, 32);
    assert.deepEqual(unmatchedOf(undefined, wrapped), [0, 32]);
  });

  test('a Write input object counts its keys, quotes and escapes', () => {
    // {"file_path":" (14) + src/new.js (10) + ","content":" (13) + line one\n (8 + 2) + line two\n (8 + 2) + "} (2)
    const write = { file_path: 'src/new.js', content: 'line one\nline two\n' };
    assert.equal(sideTextOf(write).length, 59);
    assert.deepEqual(unmatchedOf(write, ''), [59, 0]);
  });

  test('a JSON string inside a JSON string counts every escape of both layers', () => {
    // {"result":" (11) + [{ (2) + \"body\" (8) + : (1) + \" (2) + a (1) + \\n (3) + b (1) + \" (2) + }] (2) + "} (2)
    const nested = JSON.stringify({ result: JSON.stringify([{ body: 'a\nb' }]) });
    assert.equal(nested.length, 35);
    assert.deepEqual(unmatchedOf(undefined, nested), [0, 35]);
  });

  test('a side that is not text at all is empty and conserves nothing', () => {
    assert.deepEqual(unmatchedOf(undefined, undefined), [0, 0]);
  });
});

describe('JSON decode depth', () => {
  const depthOf = (output, limits) => run(attributionOver({}, limits), { output }).stats.decodeDepth;

  test('plain text has no depth and a nested object reports its container depth', () => {
    assert.deepEqual(depthOf('plain text', {}), { observed: [0, 0], rejected: [] });
    assert.deepEqual(depthOf('{"a":{"b":{"c":"x"}}}', { decodeDepth: 4 }), { observed: [0, 3], rejected: [] });
  });

  test('a JSON string inside a JSON string is one container level deeper', () => {
    const nested = JSON.stringify({ result: JSON.stringify([{ body: 'a\nb' }]) });
    assert.deepEqual(depthOf(nested, { decodeDepth: 4 }), { observed: [0, 3], rejected: [] });
  });

  test('nesting past the depth limit is marked as rejected and conserves the whole text without a throw', () => {
    const nested = '{"a":{"b":{"c":"x"}}}';
    assert.deepEqual(depthOf(nested, { decodeDepth: 2 }), { observed: [0, 3], rejected: [3] });
    const deep = `${'['.repeat(300)}"x"${']'.repeat(300)}`;
    const result = run(attributionOver({}, { decodeDepth: 4 }), { output: deep });
    assert.deepEqual(result.stats.decodeDepth, { observed: [0, 300], rejected: [300] });
    assert.equal(result.unmatched.output, deep.length);
  });
});

// Each side's unmatched count is not negative and, with the matched lines' text, is the side text.
function assertConserved(result, { input, output }) {
  for (const [side, value] of [['input', input], ['output', output]]) {
    const matched = result.matches.filter(match => match.side === side)
      .reduce((sum, match) => sum + match.lines.reduce((chars, line) => chars + line.text.length, 0), 0);
    assert.ok(result.unmatched[side] >= 0, `${side} unmatched is not negative`);
    assert.equal(result.unmatched[side] + matched, sideTextOf(value).length, `${side} conserves its text`);
  }
}

// The matches of a result as `[resourceKey, side, [[line, tier, text]…]]`, in the order the answer gives them.
const shapeOf = result => result.matches.map(({ resourceKey, side, lines }) => [
  resourceKey, side, lines.map(({ line, tier, text }) => [line, tier, text]),
]);

describe('whole-line paths and sections', () => {
  test('a find-style list of existing files is only cues, even when a file holds the list as its text', () => {
    const list = ['/repo/src/a.js', '/repo/src/b.js', '/repo/src/index.js'].join('\n');
    const attribution = attributionOver({
      '/repo/src/a.js': 'export const a = 1;\n',
      '/repo/src/b.js': 'export const b = 2;\n',
      '/repo/src/index.js': `${list}\n`,
    });
    const result = run(attribution, { input: { command: 'find /repo/src -name "*.js"' }, output: list });
    assert.deepEqual(result.matches, []);
    assert.equal(result.unmatched.output, list.length);
    assert.deepEqual(result.stats.candidates.observed, [3]);
  });

  const SECTION = 'src/a.js\nLine 3: const a = 1;\nLine 9: a += 1;';
  const A_JS = fileOf(10, { 3: 'const a = 1;', 9: 'a += 1;' });

  test('a sectioned grep attributes its rows to the heading\'s file and leaves the heading unmatched', () => {
    const result = run(attributionOver({ '/repo/src/a.js': A_JS }), { input: { pattern: 'a' }, output: SECTION });
    assert.deepEqual(shapeOf(result), [['/repo/src/a.js', 'output', [
      [3, 'declared', 'Line 3: const a = 1;'],
      [9, 'declared', 'Line 9: a += 1;'],
    ]]]);
    // src/a.js (8) + two LF (2) are the characters no row carries
    assert.equal(SECTION.length, 45);
    assert.equal(result.unmatched.output, 10);
  });

  test('the same output whose heading names no file attributes nothing', () => {
    const result = run(attributionOver({ '/repo/src/other.js': A_JS }), { input: { pattern: 'a' }, output: SECTION });
    assert.deepEqual(result.matches, []);
    assert.equal(result.unmatched.output, SECTION.length);
  });

  test('a multi-file path:N:text output keys each row to its own prefix path', () => {
    const attribution = attributionOver({
      '/repo/src/a.js': fileOf(12, { 10: 'shared line', 11: 'third hit' }),
      '/repo/src/b.js': fileOf(22, { 10: 'shared line', 20: 'second hit' }),
    });
    const output = ['src/a.js:10:shared line', 'src/b.js:10:shared line', 'src/a.js:11:third hit', 'src/b.js:20:second hit']
      .join('\n');
    const result = run(attribution, { input: { pattern: 'hit' }, output });
    assert.deepEqual(shapeOf(result), [
      ['/repo/src/a.js', 'output', [[10, 'declared', 'src/a.js:10:shared line'], [11, 'declared', 'src/a.js:11:third hit']]],
      ['/repo/src/b.js', 'output', [[10, 'declared', 'src/b.js:10:shared line'], [20, 'declared', 'src/b.js:20:second hit']]],
    ]);
  });
});

describe('candidate limits', () => {
  test('input cues are kept before output cues when the candidate count is capped', () => {
    const attribution = attributionOver({
      '/repo/late.js': 'const late = 1;\nconst later = 2;\n',
      '/repo/f1.js': 'one\n',
      '/repo/f2.js': 'two\n',
    }, { candidates: 1 });
    const result = run(attribution, {
      input: { command: 'cat late.js' },
      output: 'f1.js\nf2.js\n1\tconst late = 1;\n2\tconst later = 2;',
    });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]), [['/repo/late.js', [1, 2]]]);
    assert.deepEqual(result.stats.candidates, { observed: [3], rejected: [3] });
  });

  test('a candidate beyond the count is never read, and its lines are not attributed', () => {
    const tree = treeOf({
      '/repo/first.js': 'const first = 1;\nexport default first;\n',
      '/repo/second.js': 'const second = 2;\nexport default second;\n',
    });
    const reads = [];
    const spy = { ...tree, readText: (file) => { reads.push(file); return tree.readText(file); } };
    const attribution = createResourceAttribution({ workingTree: spy, limits: { ...LIMITS, candidates: 1 } });
    const input = { command: 'cat first.js second.js' };
    const output = '1\tconst first = 1;\n2\texport default first;\n1\tconst second = 2;\n2\texport default second;';
    const result = run(attribution, { input, output });
    assert.deepEqual(reads, ['/repo/first.js']);
    assert.deepEqual(shapeOf(result), [['/repo/first.js', 'output', [
      [1, 'declared', '1\tconst first = 1;'],
      [2, 'declared', '2\texport default first;'],
    ]]]);
    assert.deepEqual(result.stats.candidates, { observed: [2], rejected: [2] });
    assertConserved(result, { input, output });
  });
});

describe('candidates that cannot be matched', () => {
  const GOOD_ROWS = '1\tconst good = 1;\n2\texport default good;';
  const GOOD_FILE = 'const good = 1;\nexport default good;\n';
  const GOOD_MATCH = [['/repo/good.js', 'output', [
    [1, 'declared', '1\tconst good = 1;'],
    [2, 'declared', '2\texport default good;'],
  ]]];
  const callWith = (attribution, bad) => run(attribution, {
    input: { command: `cat ${bad} /repo/good.js` },
    output: GOOD_ROWS,
  });

  test('an absent path and a directory are no candidate and leave the good one attributed', () => {
    const attribution = attributionOver({ '/repo/good.js': GOOD_FILE, '/repo/pkg/inner.js': 'x\n' });
    for (const bad of ['/repo/missing.js', '/repo/pkg']) {
      const result = callWith(attribution, bad);
      assert.deepEqual(shapeOf(result), GOOD_MATCH, bad);
      assert.deepEqual(result.stats.candidates.observed, [1], bad);
    }
  });

  test('an unreadable, a binary and an oversize file are candidates that match nothing', () => {
    // Each bad file holds every line of the good one and is cited first, so one that was read would take the rows.
    const tree = treeOf({
      '/repo/good.js': GOOD_FILE,
      '/repo/locked.js': GOOD_FILE,
      '/repo/blob.bin': `${GOOD_FILE}\u0000\n`,
      '/repo/huge.js': `${GOOD_FILE}${'// padding\n'.repeat(20)}`,
    });
    const unreadable = { ...tree, readText: file => (file === '/repo/locked.js' ? null : tree.readText(file)) };
    const attribution = createResourceAttribution({ workingTree: unreadable, limits: { ...LIMITS, fileBytes: 100 } });
    for (const bad of ['/repo/locked.js', '/repo/blob.bin', '/repo/huge.js']) {
      const result = callWith(attribution, bad);
      assert.deepEqual(shapeOf(result), GOOD_MATCH, bad);
      assert.deepEqual(result.stats.candidates.observed, [2], bad);
    }
  });

  test('a side over the length limit is neither scanned nor matched, and all its characters are unmatched', () => {
    const files = { '/repo/good.js': GOOD_FILE };
    const args = { input: { command: 'cat /repo/good.js' }, output: GOOD_ROWS };
    assert.deepEqual(shapeOf(run(attributionOver(files, { sideChars: GOOD_ROWS.length }), args)), GOOD_MATCH);
    const capped = run(attributionOver(files, { sideChars: GOOD_ROWS.length - 1 }), args);
    assert.deepEqual(capped.matches, []);
    assert.equal(capped.unmatched.output, GOOD_ROWS.length);
    assert.deepEqual(capped.stats.sideChars.rejected, [GOOD_ROWS.length]);
  });
});

describe('output that a harness or a shell has reshaped', () => {
  test('leading blank lines a harness trimmed from a whole-file read still key to the file\'s own line numbers', () => {
    const lines = ['alpha line', 'beta line', 'gamma line', 'delta line'];
    const input = { command: 'cat top.txt' };
    const output = lines.join('\n');
    // the harness trims the blank ends of the output as well, so the file's last line is no longer the output's
    for (const end of ['\n', '\n\n\n']) {
      const result = run(attributionOver({ '/repo/top.txt': `\n\n${lines.join('\n')}${end}` }), { input, output });
      assert.deepEqual(shapeOf(result), [['/repo/top.txt', 'output', lines.map((text, k) => [3 + k, 'aligned', text])]],
        JSON.stringify(end));
      assertConserved(result, { input, output });
    }
  });

  test('grep context rows are keyed to their own file and line beside the match rows', () => {
    // both files hold the context lines at the same numbers, so only the match rows beside them tell the files apart
    const before = 'const limit = options.limit;';
    const after = 'cleanup(limit);';
    const rows = name => [`src/${name}.js-9-${before}`, `src/${name}.js:10:return readAll(limit, "${name}");`, `src/${name}.js-11-${after}`];
    const output = [...rows('a'), '--', ...rows('b')].join('\n');
    const input = { command: 'grep -n -C1 readAll src/a.js src/b.js' };
    const files = Object.fromEntries(['a', 'b'].map(name => [`/repo/src/${name}.js`,
      fileOf(12, { 9: before, 10: `return readAll(limit, "${name}");`, 11: after })]));
    const result = run(attributionOver(files), { input, output });
    assert.deepEqual(shapeOf(result), ['a', 'b'].map(name => [`/repo/src/${name}.js`, 'output',
      rows(name).map((text, k) => [9 + k, 'declared', text])]));
    // the separator and the six LF are what no row carries
    assert.equal(result.unmatched.output, 8);
    assertConserved(result, { input, output });
  });

  test('a stderr line among the matched lines stays unmatched and attaches to no file', () => {
    const file = ['first line', 'second line', 'third line', 'fourth line', 'fifth line', 'sixth line', 'seventh line'];
    const missing = 'cat: gone.txt: No such file or directory';
    // a compiler-shaped line cites the file and a line number, but not the text of that line
    const diagnostic = 'a.txt:4:1: error: unexpected token';
    const output = [...file.slice(0, 3), missing, ...file.slice(4), diagnostic].join('\n');
    const input = { command: 'cat a.txt gone.txt 2>&1' };
    const result = run(attributionOver({ '/repo/a.txt': `${file.join('\n')}\n` }), { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/a.txt', 'output', [1, 2, 3, 5, 6, 7].map(line => [line, 'aligned', file[line - 1]])]]);
    // the two stderr lines and the seven LF
    assert.equal(result.unmatched.output, missing.length + diagnostic.length + 7);
    assertConserved(result, { input, output });
  });

  test('a path spelled with an unexpanded shell variable names no candidate, so nothing attributes', () => {
    const lines = ['first line', 'second line', 'third line'];
    const attribution = attributionOver({ '/repo/a.txt': `${lines.join('\n')}\n` });
    const output = lines.join('\n');
    for (const command of ['cat $DIR/a.txt', 'cat ${DIR}/a.txt']) {
      const result = run(attribution, { input: { command }, output });
      assert.deepEqual(result.matches, [], command);
      assert.deepEqual(result.stats.candidates.observed, [0], command);
      assert.deepEqual(result.unmatched, { input: sideTextOf({ command }).length, output: output.length }, command);
    }
    // spelled out, the same call attributes the output, so it is the token that names no file
    const spelled = run(attribution, { input: { command: 'cat a.txt' }, output });
    assert.deepEqual(shapeOf(spelled), [['/repo/a.txt', 'output', lines.map((text, k) => [1 + k, 'aligned', text])]]);
  });
});

describe('a command that changes directory', () => {
  // Every file holds lines of its own, so the key an attribution gets says which of them the call read.
  const linesOf = tag => ['opens the ledger', 'prices each entry', 'closes the books'].map(line => `${tag} ${line}`);
  const fileText = tag => `${linesOf(tag).join('\n')}\n`;
  const alignedLines = tag => linesOf(tag).map((text, k) => [k + 1, 'aligned', text]);
  // The directories of the tree, each with an x.txt and a y.txt of its own. Some are spelled like what a command
  // cannot name by writing it out: an option, a variable, a command substitution.
  const LOOKALIKES = [['/repo/-', 'dash'], ['/repo/-P', 'option'], ['/repo/$D', 'dollar'], ['/repo/`pwd`', 'tick']];
  const TAGS = new Map([
    ['/repo', 'base'], ['/repo/a', 'a'], ['/repo/b', 'b'], ['/repo/sub', 'sub'], ['/repo/dir with space', 'spaced'],
    ['/abs', 'abs'], ['/abs/lib', 'abs-lib'], ['/abs/d', 'abs-d'], ['/abs/d/sub', 'abs-d-sub'],
    ...LOOKALIKES,
  ]);
  const FILES = Object.fromEntries([...TAGS].flatMap(([dir, tag]) => [
    [`${dir}/x.txt`, fileText(tag)],
    [`${dir}/y.txt`, fileText(`${tag}-y`)],
  ]));
  const attribution = attributionOver(FILES);
  const tagOf = file => TAGS.get(path.posix.dirname(file));

  // A command and the file its last word reads: the one the shell would read.
  const READS = [
    ['cd a && cat x.txt', '/repo/a/x.txt'],
    ['cd a; cd ../b && cat x.txt', '/repo/b/x.txt'],
    ['cd a && cat x.txt | head', '/repo/a/x.txt'],
    ['cd sub && cd .. && cat x.txt', '/repo/x.txt'],
    ['cd /abs/ && cat x.txt', '/abs/x.txt'],
    ['cd /abs/ && cat lib/x.txt', '/abs/lib/x.txt'],
    ['cd / && cat repo/x.txt', '/repo/x.txt'],
    ['cd "dir with space" && cat x.txt', '/repo/dir with space/x.txt'],
    ['D=/abs/d; cd $D && cat x.txt', '/abs/d/x.txt'],
    ['D=/abs/d; cd "$D" && cat x.txt', '/abs/d/x.txt'],
    ['export D=/abs/d; cd ${D}/sub && cat x.txt', '/abs/d/sub/x.txt'],
    ['(D=/abs/d); cd $D && cat x.txt', '/abs/d/x.txt'],
    ['(cd a); cat x.txt', '/repo/x.txt'],
    ['echo a) ; cd a && cat x.txt', '/repo/a/x.txt'],
    ['echo hi | cd a && cat x.txt', '/repo/x.txt'],
    ['((cd a); (cd b); cat x.txt)', '/repo/x.txt'],
    ['cd a && echo "$(date)" && cat x.txt', '/repo/a/x.txt'],
    ['D=/abs/d; cd . && cat $D/x.txt', '/abs/d/x.txt'],
    ['D=/abs; E=d; cd $D/$E && cat x.txt', '/abs/d/x.txt'],
    ['D=/abs; E=d; cd ${D}/${E} && cat x.txt', '/abs/d/x.txt'],
    ['_D=/abs/d; cd $_D && cat x.txt', '/abs/d/x.txt'],
    ['D1=/abs/d; cd ${D1} && cat x.txt', '/abs/d/x.txt'],
    ['d_1=/abs/d; cd $d_1/sub && cat x.txt', '/abs/d/sub/x.txt'],
  ];

  for (const [command, file] of READS) {
    test(`\`${command}\` attributes to ${file}`, () => {
      const input = { command };
      const output = linesOf(tagOf(file)).join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(shapeOf(result), [[file, 'output', alignedLines(tagOf(file))]]);
      // the same name under another directory is no candidate at all, so no rival can have been outranked
      assert.deepEqual(result.stats.candidates.observed, [1]);
      assertConserved(result, { input, output });
    });
  }

  test('`(cd a && cat x.txt); cat y.txt` reads the first file under a and the second under the session directory', () => {
    const input = { command: '(cd a && cat x.txt); cat y.txt' };
    const output = [...linesOf('a'), ...linesOf('base-y')].join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [
      ['/repo/a/x.txt', 'output', alignedLines('a')],
      ['/repo/y.txt', 'output', alignedLines('base-y')],
    ]);
    assertConserved(result, { input, output });
  });

  test('each `)` restores the directory its own `(` left, however deep the parentheses are nested', () => {
    // three levels with a different directory in each, so a restore to any level but the matching one reads another file
    const input = { command: 'cd a && (cd ../b && (cd ../sub) && cat x.txt) && cat y.txt' };
    const output = [...linesOf('b'), ...linesOf('a-y')].join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [
      ['/repo/b/x.txt', 'output', alignedLines('b')],
      ['/repo/a/y.txt', 'output', alignedLines('a-y')],
    ]);
    assertConserved(result, { input, output });
  });

  test('the raw view of an object input gives no cue beside a cd: an escaped quote does not turn what the shell quoted into bare words', () => {
    // the same text under the session directory and under where the command moved to, so only the key says which was read
    const copies = attributionOver({ '/repo/x.txt': fileText('same'), '/tmp/copy/x.txt': fileText('same') });
    const output = linesOf('same').join('\n');
    for (const command of [
      'cd /tmp/copy && python3 -c "print(open(\'x.txt\').read())"',
      'cd "$D" && echo "$(cat x.txt)"',
      'cd nonexistent && echo "$(cat x.txt)"',
      'cd $(mktemp -d) && V="$(cat x.txt)" && echo "$V"',
      'cd /tmp/copy && git commit -m "fix x.txt now"',
    ]) {
      // as a string the command is one view and reads as the shell does; as an object it has a raw view too
      for (const input of [command, { command }]) {
        const result = run(copies, { input, output });
        assert.deepEqual(result.matches, [], JSON.stringify(input));
        assert.deepEqual(result.stats.candidates.observed, [0], JSON.stringify(input));
        assertConserved(result, { input, output });
      }
    }
  });

  test('an object input with no cd keeps its raw view: the bare word an escaped quote leaves in it is a cue', () => {
    // only the raw view holds `x.txt` as a word of its own; the command quoted it
    const input = { command: 'git commit -m "fix x.txt now"' };
    const output = linesOf('base').join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/x.txt', 'output', alignedLines('base')]]);
    assertConserved(result, { input, output });
  });

  test('the raw view of an object input with no cd is a plain line: a word in parentheses is not split out of a quoted span', () => {
    // read as a shell line, the raw view would split at the parentheses, and `x.txt` would be a word of its own
    const input = { command: 'git commit -m "see (x.txt) now"' };
    const output = linesOf('base').join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.stats.candidates.observed, [0]);
    assertConserved(result, { input, output });
  });

  test('the same text under the session directory and under the cd target is attributed to the target', () => {
    const files = { '/repo/x.txt': fileText('same'), '/repo/a/x.txt': fileText('same') };
    const input = { command: 'cd a && cat x.txt' };
    const output = linesOf('same').join('\n');
    const result = run(attributionOver(files), { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/a/x.txt', 'output', alignedLines('same')]]);
    assert.deepEqual(result.stats.candidates.observed, [1]);
    assertConserved(result, { input, output });
  });

  test('a name is resolved from the directory its statement began in, each time it is written', () => {
    const input = { command: 'cat x.txt; cd a && cat x.txt' };
    const output = [...linesOf('base'), ...linesOf('a')].join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [
      ['/repo/x.txt', 'output', alignedLines('base')],
      ['/repo/a/x.txt', 'output', alignedLines('a')],
    ]);
    assertConserved(result, { input, output });
  });

  test('a statement starts after `;`, `&&`, `||`, `&` and a line break, with or without spaces around them', () => {
    for (const separator of [' ; ', ';', ' && ', '&&', ' || ', ' & ', '\n']) {
      const input = { command: `cd a${separator}cat x.txt` };
      const output = linesOf('a').join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(shapeOf(result), [['/repo/a/x.txt', 'output', alignedLines('a')]], JSON.stringify(separator));
      assertConserved(result, { input, output });
    }
  });

  test('a cd on an indented line is a statement: the indentation before it is no word', () => {
    const output = linesOf('a').join('\n');
    for (const command of ['  cd a && cat x.txt', '\tcd a\ncat x.txt']) {
      for (const input of [command, { command }]) {
        const result = run(attribution, { input, output });
        assert.deepEqual(shapeOf(result), [['/repo/a/x.txt', 'output', alignedLines('a')]], JSON.stringify(input));
        assert.deepEqual(result.stats.candidates.observed, [1], JSON.stringify(input));
        assertConserved(result, { input, output });
      }
    }
  });

  // Each of these leaves the directory not known, so the relative word after it has no candidate, though the
  // session directory holds a file of that name and so does a directory spelled like the target. A name nothing
  // assigned is not the empty string, as it is to a shell: `$NOPE/abs` would otherwise name `/abs`.
  const UNKNOWN = [
    'cd "$D" && cat x.txt',
    'cd $NOPE/abs && cat x.txt',
    'cd "`pwd`" && cat x.txt',
    'cd nonexistent && cat x.txt',
    'cd && cat x.txt',
    'cd - && cat x.txt',
    'cd -P && cat x.txt',
    'cd $(mktemp -d) && cat x.txt',
    'T=$(mktemp -d); cd $T && cat x.txt',
    'D=/abs/d; D=$(mktemp -d); cd $D && cat x.txt',
    'cd nonexistent && cd a && cat x.txt',
    'cd nonexistent && cd .. && cat x.txt',
    'echo D=/abs/d; cd $D && cat x.txt',
    'cd "" && cat x.txt',
    'D=; cd $D && cat x.txt',
  ];

  for (const command of UNKNOWN) {
    test(`\`${command}\` gives the relative word no candidate`, () => {
      const input = { command };
      const output = linesOf('base').join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.stats.candidates.observed, [0]);
      assert.equal(result.unmatched.output, output.length);
      assertConserved(result, { input, output });
    });
  }

  test('a cd to a file moves nowhere known, so the directory above it is not reached either', () => {
    const input = { command: 'cd /abs/x.txt && cd .. && cat y.txt' };
    const output = linesOf('abs-y').join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(result.matches, []);
    // the file is a candidate as any path-shaped word naming one is; y.txt, which would be one from /abs, is not
    assert.deepEqual(result.stats.candidates.observed, [1]);
    assertConserved(result, { input, output });
  });

  test('after a cd, a path word with a name nothing assigned is no candidate, though a file is spelled like it', () => {
    const input = { command: 'cd . && cat $D/x.txt' };
    const output = linesOf('dollar').join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.stats.candidates.observed, [0]);
    assertConserved(result, { input, output });
  });

  test('a bare name after a cd is no cue, as it is none without the cd, and the same name spelled with ./ is', () => {
    // `Makefile` holds no `/`, `\` or `.`, which a word needs to be read as a path
    const files = { '/repo/Makefile': fileText('base-make'), '/repo/a/Makefile': fileText('a-make') };
    const makefiles = attributionOver(files);
    const output = linesOf('a-make').join('\n');
    for (const command of ['cat Makefile', 'cd a && cat Makefile']) {
      const input = { command };
      const result = run(makefiles, { input, output });
      assert.deepEqual(result.matches, [], command);
      assert.deepEqual(result.stats.candidates.observed, [0], command);
      assertConserved(result, { input, output });
    }
    const input = { command: 'cd a && cat ./Makefile' };
    const result = run(makefiles, { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/a/Makefile', 'output', alignedLines('a-make')]]);
    assertConserved(result, { input, output });
  });

  test('a name written many times in one word is not a literal: the port is never asked about the product', () => {
    // a value that is a path on its own, written many times in a cd target and in a path word after a cd
    const value = 'long/'.repeat(600);
    const references = '$A'.repeat(100);
    // far past any path, far below what the references make
    const NO_PATH_IS_LONGER = 8192;
    for (const [command, expected] of [
      [`A=${value}; cd ${references} && cat x.txt`, []],
      [`A=${value}; cd . && cat ${references} x.txt`, [['/repo/x.txt', 'output', alignedLines('base')]]],
    ]) {
      const tree = treeOf(FILES);
      const asked = [];
      const watched = createResourceAttribution({
        workingTree: { ...tree, resolve: (directory, spelling) => { asked.push(spelling); return tree.resolve(directory, spelling); } },
        limits: LIMITS,
      });
      const input = { command };
      const output = linesOf('base').join('\n');
      const result = run(watched, { input, output });
      const longest = Math.max(...asked.map(spelling => spelling.length));
      assert.ok(longest <= NO_PATH_IS_LONGER, `the port was asked about a word of ${longest} characters`);
      // the short word beside the references is asked about as always
      assert.ok(asked.includes('x.txt'), 'the port was asked about x.txt');
      assert.deepEqual(shapeOf(result), expected);
      assertConserved(result, { input, output });
    }
  });

  test('a name written so many times that no string could hold the product is no literal, and the rest of the call is read as always', () => {
    // twice the longest string the engine holds: built, the product would fail the whole call
    const size = 2 * Math.ceil(Math.sqrt(constants.MAX_STRING_LENGTH));
    const input = { command: `A=${'x'.repeat(size)}; cd ${'$A'.repeat(size / 2)} && cat /abs/x.txt` };
    const output = linesOf('abs').join('\n');
    const result = run(attributionOver(FILES, { sideChars: 4 * size }), { input, output });
    assert.deepEqual(shapeOf(result), [['/abs/x.txt', 'output', alignedLines('abs')]]);
    assertConserved(result, { input, output });
  });

  test('a segment is followed on its own: neither the directory nor the names of another carry into it', () => {
    const output = linesOf('base').join('\n');
    const moved = { setup: 'cd /abs', command: 'cat x.txt' };
    const read = run(attribution, { input: moved, output });
    assert.deepEqual(shapeOf(read), [['/repo/x.txt', 'output', alignedLines('base')]]);
    assertConserved(read, { input: moved, output });
    const named = { setup: 'D=/abs/d', command: 'cd $D && cat x.txt' };
    const unread = run(attribution, { input: named, output });
    assert.deepEqual(unread.matches, []);
    assert.deepEqual(unread.stats.candidates.observed, [0]);
    assertConserved(unread, { input: named, output });
  });

  test('the output is never read as a command: a cd line in a script it shows moves nothing', () => {
    const script = ['cd /abs', 'cat lib/a.js'];
    const files = {
      '/repo/run.sh': `${script.join('\n')}\n`,
      '/repo/lib/a.js': fileText('base-lib'),
      '/abs/lib/a.js': fileText('abs-lib'),
    };
    const input = { command: 'cat run.sh' };
    const output = [...script, ...linesOf('base-lib')].join('\n');
    const result = run(attributionOver(files), { input, output });
    assert.deepEqual(shapeOf(result), [
      ['/repo/run.sh', 'output', script.map((text, k) => [k + 1, 'aligned', text])],
      ['/repo/lib/a.js', 'output', alignedLines('base-lib')],
    ]);
    assertConserved(result, { input, output });
  });

  test('an absolute word still resolves after an unknown directory, and a relative word beside it does not', () => {
    const input = { command: 'cd nonexistent && cat /abs/x.txt y.txt' };
    const output = [...linesOf('abs'), ...linesOf('base-y')].join('\n');
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [['/abs/x.txt', 'output', alignedLines('abs')]]);
    assert.deepEqual(result.stats.candidates.observed, [1]);
    assertConserved(result, { input, output });
  });

  test('a literal absolute directory makes the directory known again, and so does the `)` that closes an unknown stretch', () => {
    for (const [command, file] of [
      ['cd nonexistent && cd /abs && cat x.txt', '/abs/x.txt'],
      ['cd a && (cd nonexistent && cat y.txt); cat x.txt', '/repo/a/x.txt'],
    ]) {
      const input = { command };
      const output = linesOf(tagOf(file)).join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(shapeOf(result), [[file, 'output', alignedLines(tagOf(file))]], command);
      assert.deepEqual(result.stats.candidates.observed, [1], command);
      assertConserved(result, { input, output });
    }
  });

  test('a heredoc body that holds a `cd` line has it read as a statement, and the file it writes is still attributed', () => {
    const body = ['hello there', 'cd foo', 'say goodbye', 'cat x.txt'];
    const input = { command: `cat <<'EOF' > out.txt\n${body.join('\n')}\nEOF` };
    const result = run(attributionOver({ '/repo/out.txt': `${body.join('\n')}\n`, '/repo/x.txt': fileText('base') }), {
      input, output: '',
    });
    assert.deepEqual(shapeOf(result), [['/repo/out.txt', 'input', body.map((text, k) => [k + 1, 'aligned', text])]]);
    // `foo` names no directory, so the x.txt after the `cd` line has none to be found under
    assert.deepEqual(result.stats.candidates.observed, [1]);
    assertConserved(result, { input, output: '' });
  });

  test('`cd ~/proj` is the home directory under a tree that has one and a directory called ~ under one that has none', () => {
    const files = {
      '/home/dev/proj/x.txt': fileText('home'),
      '/repo/~/proj/x.txt': fileText('tilde'),
      '/repo/x.txt': fileText('base'),
    };
    const input = { command: 'cd ~/proj && cat x.txt' };
    for (const [homeDir, tag, key] of [
      ['/home/dev', 'home', '/home/dev/proj/x.txt'],
      [null, 'tilde', '/repo/~/proj/x.txt'],
    ]) {
      const workingTree = createMemoryWorkingTree({ files, path: path.posix, homeDir });
      const output = linesOf(tag).join('\n');
      const result = run(createResourceAttribution({ workingTree, limits: LIMITS }), { input, output });
      assert.deepEqual(shapeOf(result), [[key, 'output', alignedLines(tag)]], String(homeDir));
      assertConserved(result, { input, output });
    }
  });

  test('an input without a cd resolves its words against the session directory, whatever else it assigns', () => {
    for (const command of ['cat x.txt', 'D=/abs/d; cat x.txt | head', 'true && cat x.txt || cat y.txt']) {
      const input = { command };
      const output = linesOf('base').join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(shapeOf(result), [['/repo/x.txt', 'output', alignedLines('base')]], command);
      assertConserved(result, { input, output });
    }
  });

  describe('a segment that holds no cd', () => {
    // Spelled so that a shell line would take them apart: a route group, a parallel slot with an intercepting route, a parameter, a backtick.
    const NAMES = [
      ['route', 'app/(marketing)/page.tsx'],
      ['paren', 'lib/a(1).js'],
      ['modal', 'app/@modal/(.)photo/[id]/page.tsx'],
      ['param', 'app/routes/posts.$postId.tsx'],
      ['tick', 'docs/`notes`.md'],
    ];
    // No line of a file holds its name, so the input is the only place a call can have cited the file.
    const tree = attributionOver(Object.fromEntries(NAMES.map(([tag, name]) => [`/repo/${name}`, fileText(tag)])));

    test('a file_path names its file, relative or absolute, read whole or through a window', () => {
      for (const [tag, name] of NAMES) {
        for (const spelling of [name, `/repo/${name}`]) {
          for (const range of [{}, { offset: 2, limit: 2 }]) {
            const input = { file_path: spelling, ...range };
            const first = range.offset ?? 1;
            const rows = linesOf(tag).slice(first - 1).map((text, k) => `${first + k}\t${text}`);
            const output = rows.join('\n');
            const result = run(tree, { input, output });
            assert.deepEqual(shapeOf(result), [[`/repo/${name}`, 'output', rows.map((text, k) => [first + k, 'declared', text])]],
              JSON.stringify(input));
            assertConserved(result, { input, output });
          }
        }
      }
    });

    test('a quoted command argument names its file, and a `cd` that is no statement\'s first word does not change that', () => {
      for (const [tag, name] of NAMES) {
        for (const command of [`cat '${name}'`, `echo cd && cat '${name}'`]) {
          const input = { command };
          const output = linesOf(tag).join('\n');
          const result = run(tree, { input, output });
          assert.deepEqual(shapeOf(result), [[`/repo/${name}`, 'output', alignedLines(tag)]], command);
          assertConserved(result, { input, output });
        }
      }
    });

    test('an assignment expands nothing: the words stay the spelling they were', () => {
      // `$D/x.txt` is, unexpanded, the spelling of a file of the session directory
      for (const command of ['cat $D/x.txt', 'D=/abs/d; cat $D/x.txt']) {
        const input = { command };
        const output = linesOf('dollar').join('\n');
        const result = run(attribution, { input, output });
        assert.deepEqual(shapeOf(result), [['/repo/$D/x.txt', 'output', alignedLines('dollar')]], command);
        assertConserved(result, { input, output });
      }
      // `${D}/x.txt` names no file of the session directory; expanded, it would name one under /abs/d
      const input = { command: 'D=/abs/d; cat ${D}/x.txt' };
      const output = linesOf('abs-d').join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.stats.candidates.observed, [0]);
      assertConserved(result, { input, output });
    });

    test('a segment beside a segment that holds a cd is read as it would be alone, whichever comes first', () => {
      const output = [...linesOf('param'), ...linesOf('a')].join('\n');
      const beside = attributionOver({
        '/repo/app/routes/posts.$postId.tsx': fileText('param'),
        '/repo/a/x.txt': fileText('a'),
      });
      for (const input of [
        { file_path: 'app/routes/posts.$postId.tsx', command: 'cd a && cat x.txt' },
        { command: 'cd a && cat x.txt', file_path: 'app/routes/posts.$postId.tsx' },
      ]) {
        const result = run(beside, { input, output });
        assert.deepEqual(shapeOf(result), [
          ['/repo/app/routes/posts.$postId.tsx', 'output', alignedLines('param')],
          ['/repo/a/x.txt', 'output', alignedLines('a')],
        ], JSON.stringify(input));
        assertConserved(result, { input, output });
      }
    });
  });

  describe('the relative cue of an output row', () => {
    const SOURCE = fileOf(14, { 12: '  const total = sumOf(entries);', 13: '  return total;' });
    const ROWS = ['lib/a.js:12:  const total = sumOf(entries);', 'lib/a.js:13:  return total;'];
    // the same lines under both directories, so the directory a row resolves against is the only difference
    const rows = attributionOver({ '/abs/lib/a.js': SOURCE, '/repo/lib/a.js': SOURCE });
    const output = ROWS.join('\n');
    const rowsFor = (input) => {
      const result = run(rows, { input, output });
      assertConserved(result, { input, output });
      return result;
    };
    const declared = key => [[key, 'output', [[12, 'declared', ROWS[0]], [13, 'declared', ROWS[1]]]]];

    test('resolves against the directory the last statement of the last segment holding a cd began in', () => {
      for (const input of [
        { command: 'cd /abs && grep -rn total .' },
        'cd /abs && grep -rn total .',
        { command: 'cd /abs && grep -rn total . ; cd /repo/lib' },
        { command: 'cd /abs && grep -rn total .', description: 'find the total' },
        { command: '(cd /abs && grep -rn total .)' },
      ]) {
        const result = rowsFor(input);
        assert.deepEqual(shapeOf(result), declared('/abs/lib/a.js'), JSON.stringify(input));
        assert.deepEqual(result.stats.candidates.observed, [1], JSON.stringify(input));
      }
    });

    test('of two segments that hold a cd, the last decides', () => {
      const result = rowsFor({ setup: 'cd /abs && ls', command: 'cd /repo && grep -rn total .' });
      assert.deepEqual(shapeOf(result), declared('/repo/lib/a.js'));
    });

    test('a listing of relative paths is only cues, though a file under that directory holds the listing as its text', () => {
      const listing = ['lib/a.js', 'lib/b.js', 'lib/index.js'].join('\n');
      const input = { command: 'cd /abs && find lib -name \'*.js\'' };
      const result = run(attributionOver({
        '/abs/lib/a.js': 'export const a = 1;\n',
        '/abs/lib/b.js': 'export const b = 2;\n',
        '/abs/lib/index.js': `${listing}\n`,
      }), { input, output: listing });
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.stats.candidates.observed, [3]);
      assert.equal(result.unmatched.output, listing.length);
    });

    test('resolves to nothing after an unknown or missing directory, though the session directory holds the rows', () => {
      for (const command of ['cd nonexistent && grep -rn total .', 'cd "$D" && grep -rn total .', 'cd && grep -rn total .']) {
        const result = rowsFor({ command });
        assert.deepEqual(result.matches, [], command);
        assert.deepEqual(result.stats.candidates.observed, [0], command);
        assert.equal(result.unmatched.output, output.length, command);
      }
    });

    test('resolves against the session directory when the input has no cd', () => {
      for (const command of ['grep -rn total .', 'D=/abs; grep -rn total . | head']) {
        assert.deepEqual(shapeOf(rowsFor({ command })), declared('/repo/lib/a.js'), command);
      }
    });
  });
});

describe('result shapes', () => {
  for (const block of CORPUS) {
    test(`${block.name} attributes to the disk lines, each line's text keeping its prefix`, () => {
      const attribution = attributionOver(block.files);
      const result = run(attribution, { input: block.input, output: block.output });
      assert.deepEqual(shapeOf(result), block.matches);
      assertConserved(result, block);
      assert.deepEqual(run(attribution, { input: block.input, output: block.output }), result);
      assert.deepEqual(run(attributionOver(block.files), { input: block.input, output: block.output }), result);
    });
  }

  test('a JSON-wrapped body is attributed without a tool-specific branch: other key names and wrapping do', () => {
    const attribution = attributionOver({ '/repo/lib/x.js': fileOf(8, { 5: 'function f() {', 6: '  return 1;', 7: '}' }) });
    const output = JSON.stringify({
      items: [{ file: 'lib/x.js', span: [5, 7], snippet: 'function f() {\n  return 1;\n}' }],
    });
    const input = { target: 'f' };
    const result = run(attribution, { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/lib/x.js', 'output', [
      [5, 'aligned', 'function f() {'],
      [6, 'aligned', '  return 1;'],
      [7, 'aligned', '}'],
    ]]]);
    assertConserved(result, { input, output });
  });
});

describe('declared and drifted positions', () => {
  const BLOCK = ['alpha', 'beta', 'gamma'];

  test('a declared line is keyed to its declared number even when the file repeats the block', () => {
    const special = Object.fromEntries([...BLOCK.entries()].flatMap(([i, text]) => [[2 + i, text], [8 + i, text]]));
    const result = run(attributionOver({ '/repo/dup.txt': fileOf(11, special) }), {
      input: { command: 'cat -n dup.txt' },
      output: '8\talpha\n9\tbeta\n10\tgamma',
    });
    assert.deepEqual(shapeOf(result), [['/repo/dup.txt', 'output', [
      [8, 'declared', '8\talpha'], [9, 'declared', '9\tbeta'], [10, 'declared', '10\tgamma'],
    ]]]);
  });

  test('a declaration the file no longer bears falls back to the line where its text now is, or to unmatched', () => {
    const moved = 'new top\nnew top again\none\ntwo\nthree\nfour\n';
    const output = '1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\tfive';
    const input = { command: 'cat -n old.txt' };
    const result = run(attributionOver({ '/repo/old.txt': moved }), { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/old.txt', 'output', [
      [3, 'drifted', '1\tone'], [4, 'drifted', '2\ttwo'], [5, 'drifted', '3\tthree'], [6, 'drifted', '4\tfour'],
    ]]]);
    // `5\tfive` (6) and the four LF are what no line carries
    assert.equal(result.unmatched.output, 10);
    assertConserved(result, { input, output });
  });
});

describe('a declared line and leading whitespace', () => {
  test('a row whose content differs from the file\'s line at its number, beyond indentation, is not declared and drifts to where its text is', () => {
    // Line 2 differs from the first row by an interior space, line 3 from the second by its words.
    const file = fileOf(12, {
      2: '    settle the  open balance',
      3: '  close the account books',
      7: '    settle the open balance',
      8: '  close the closed accounts',
    });
    const input = { file_path: 'books.txt', offset: 2, limit: 2 };
    const output = '2:     settle the open balance\n3:   close the closed accounts';
    const result = run(attributionOver({ '/repo/books.txt': file }), { input, output });
    assert.deepEqual(shapeOf(result), [['/repo/books.txt', 'output', [
      [7, 'drifted', '2:     settle the open balance'],
      [8, 'drifted', '3:   close the closed accounts'],
    ]]]);
    assertConserved(result, { input, output });
  });

  test('of two file lines that differ only in indentation, a row takes the one its number declares', () => {
    const AT_3 = '  settle the open balance of the account';
    const AT_9 = '    settle the open balance of the account';
    const attribution = attributionOver({ '/repo/books.txt': fileOf(12, { 3: AT_3, 9: AT_9 }) });
    const input = { command: 'grep -n settle books.txt' };
    const placed = output => {
      const result = run(attribution, { input, output });
      assertConserved(result, { input, output });
      return shapeOf(result).flatMap(([, , lines]) => lines.map(([line, tier]) => [line, tier]));
    };
    // `grep -n` prints a number, a colon and the line as it is
    assert.deepEqual(placed(`3:${AT_3}\n9:${AT_9}`), [[3, 'declared'], [9, 'declared']]);
    // a row whose text is exactly one line's, under the other line's number, takes the number
    assert.deepEqual(placed(`3: ${AT_9}`), [[3, 'declared']]);
    assert.deepEqual(placed(`9: ${AT_3}`), [[9, 'declared']]);
  });

  test('an unnumbered copy of lines with other indentation is matched neither by alignment nor by its text', () => {
    const lines = ['  gather the open entries', '    price each open entry', '  record the closing total'];
    const long = '  const settled = closeLedger(ledger, totals);';
    const attribution = attributionOver({ '/repo/steps.js': fileOf(12, { 3: lines[0], 4: lines[1], 5: lines[2], 9: long }) });
    const input = { command: 'cat steps.js' };
    // as the file holds them the lines are matched; the copies below differ from them only in indentation
    assert.deepEqual(shapeOf(run(attribution, { input, output: lines.join('\n') })), [
      ['/repo/steps.js', 'output', lines.map((text, k) => [3 + k, 'aligned', text])],
    ]);
    assert.deepEqual(shapeOf(run(attribution, { input, output: long })), [['/repo/steps.js', 'output', [[9, 'aligned', long]]]]);
    for (const indent of ['', '      ', '\t']) {
      for (const output of [lines.map(line => indent + line.trimStart()).join('\n'), indent + long.trimStart()]) {
        const result = run(attribution, { input, output });
        assert.deepEqual(result.matches, [], JSON.stringify(output));
        assert.equal(result.unmatched.output, output.length, JSON.stringify(output));
      }
    }
  });
});

describe('aligned and tied positions', () => {
  const TWICE = fileOf(11, { 2: 'alpha', 3: 'beta', 4: 'gamma', 7: 'alpha', 8: 'beta', 9: 'gamma' });

  test('a block that occurs twice in the file is placed deterministically at its first position and marked tied', () => {
    const attribution = attributionOver({ '/repo/twice.txt': TWICE });
    const args = { input: { command: 'sed -n 2,4p twice.txt' }, output: 'alpha\nbeta\ngamma' };
    const first = run(attribution, args);
    assert.deepEqual(shapeOf(first), [['/repo/twice.txt', 'output', [
      [2, 'tied', 'alpha'], [3, 'tied', 'beta'], [4, 'tied', 'gamma'],
    ]]]);
    assert.deepEqual(run(attribution, args), first);
  });

  test('a block that occurs once is aligned, not tied', () => {
    const attribution = attributionOver({ '/repo/once.txt': fileOf(6, { 2: 'alpha', 3: 'beta', 4: 'gamma' }) });
    const result = run(attribution, { input: { command: 'sed -n 2,4p once.txt' }, output: 'alpha\nbeta\ngamma' });
    assert.deepEqual(shapeOf(result).map(([, , lines]) => lines.map(([line, tier]) => [line, tier])),
      [[[2, 'aligned'], [3, 'aligned'], [4, 'aligned']]]);
  });

  test('a short or blank line that differs between two matched runs, at the same distance, is kept with them', () => {
    const file = 'first line\nsecond line\nthird line\n}\nfourth line\nfifth line\nsixth line\n';
    const attribution = attributionOver({ '/repo/gap.txt': file });
    const kept = run(attribution, {
      input: { command: 'cat gap.txt' }, output: 'first line\nsecond line\nthird line\n};\nfourth line\nfifth line\nsixth line',
    });
    assert.deepEqual(shapeOf(kept)[0][2].map(([line]) => line), [1, 2, 3, 4, 5, 6, 7]);
    const long = 'a much longer line than any short one';
    const apart = run(attribution, {
      input: { command: 'cat gap.txt' }, output: `first line\nsecond line\nthird line\n${long}\nfourth line\nfifth line\nsixth line`,
    });
    assert.deepEqual(shapeOf(apart)[0][2].map(([line]) => line), [1, 2, 3, 5, 6, 7]);
  });

  describe('a window that opens on lines the file repeats earlier', () => {
    // six blocks of alpha, beta, gamma and two lines of their own: 30 lines, the fourth block at 16 to 20
    const BLOCKS = Array.from({ length: 6 }, (_, k) => ['alpha', 'beta', 'gamma', `unique ${k + 1}a`, `unique ${k + 1}b`]).flat();
    const window = BLOCKS.slice(15, 20).join('\n');

    test('is left unplaced when the budget cannot pay to look for a longer run than the head it shares with the file', () => {
      const attribution = attributionOver({ '/repo/blocks.txt': `${BLOCKS.join('\n')}\n` }, { alignCells: 5 });
      const result = run(attribution, { input: { command: 'sed -n 16,20p blocks.txt' }, output: window });
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.stats.alignCells.rejected, [150]);
    });

    for (const evidenceFloor of [2, 3]) {
      test(`is placed at the one place all of it occurs, at a floor of ${evidenceFloor}`, () => {
        const attribution = attributionOver({ '/repo/blocks.txt': `${BLOCKS.join('\n')}\n` }, { evidenceFloor });
        const input = { command: 'sed -n 16,20p blocks.txt' };
        const result = run(attribution, { input, output: window });
        assert.deepEqual(shapeOf(result), [['/repo/blocks.txt', 'output', [
          [16, 'aligned', 'alpha'], [17, 'aligned', 'beta'], [18, 'aligned', 'gamma'],
          [19, 'aligned', 'unique 4a'], [20, 'aligned', 'unique 4b'],
        ]]]);
        // 5 + 4 + 5 + 9 + 9 characters of lines, and the four LF between them
        assert.equal(window.length, 36);
        assert.equal(result.unmatched.output, 4);
        assertConserved(result, { input, output: window });
      });
    }
  });

  describe('a window that closes on lines the file repeats later', () => {
    // six blocks of two lines of their own, then alpha, beta and gamma: the fourth block at 16 to 20
    const BLOCKS = Array.from({ length: 6 }, (_, k) => [`unique ${k + 1}a`, `unique ${k + 1}b`, 'alpha', 'beta', 'gamma']).flat();
    const window = BLOCKS.slice(15, 20).join('\n');

    for (const evidenceFloor of [2, 3]) {
      test(`is placed at the one place all of it occurs, at a floor of ${evidenceFloor}`, () => {
        const attribution = attributionOver({ '/repo/blocks.txt': `${BLOCKS.join('\n')}\n` }, { evidenceFloor });
        const input = { command: 'sed -n 16,20p blocks.txt' };
        const result = run(attribution, { input, output: window });
        assert.deepEqual(shapeOf(result), [['/repo/blocks.txt', 'output', [
          [16, 'aligned', 'unique 4a'], [17, 'aligned', 'unique 4b'],
          [18, 'aligned', 'alpha'], [19, 'aligned', 'beta'], [20, 'aligned', 'gamma'],
        ]]]);
        // 9 + 9 + 5 + 4 + 5 characters of lines, and the four LF between them
        assert.equal(window.length, 36);
        assert.equal(result.unmatched.output, 4);
        assertConserved(result, { input, output: window });
      });
    }
  });

  test('the lines two separate runs share are both found while the budget lasts, the shorter after the longer', () => {
    const file = 'pre\na line one\na line two\na line three\nmid\nb line one\nb line two\npost\n';
    const output = 'a line one\na line two\na line three\nnoise\nb line one\nb line two';
    const input = { command: 'cat parts.txt' };
    const both = run(attributionOver({ '/repo/parts.txt': file }, { alignCells: 61 }), { input, output });
    assert.deepEqual(shapeOf(both)[0][2].map(([line]) => line), [2, 3, 4, 6, 7]);
    // 8 x 6 for the whole, 4 x 3 for what follows the first run, 1 x 1 for what lies between
    assert.deepEqual(both.stats.alignCells, { observed: [48, 12, 1], rejected: [] });
    const short = run(attributionOver({ '/repo/parts.txt': file }, { alignCells: 59 }), { input, output });
    assert.deepEqual(shapeOf(short)[0][2].map(([line]) => line), [2, 3, 4]);
    assert.deepEqual(short.stats.alignCells, { observed: [48, 12], rejected: [12] });
  });

  test('the equal head and tail of a stretch are attributed though the budget cannot cover what lies between', () => {
    const middle = prefix => Array.from({ length: 30 }, (_, i) => `${prefix} ${i}`);
    const file = ['head 1', 'head 2', 'head 3', ...middle('file middle'), 'tail 1', 'tail 2', 'tail 3'];
    const output = ['head 1', 'head 2', 'head 3', ...middle('window middle'), 'tail 1', 'tail 2', 'tail 3'].join('\n');
    const result = run(attributionOver({ '/repo/ends.txt': `${file.join('\n')}\n` }, { alignCells: 10 }), {
      input: { command: 'cat ends.txt' }, output,
    });
    assert.deepEqual(shapeOf(result)[0][2].map(([line]) => line), [1, 2, 3, 34, 35, 36]);
    assert.deepEqual(result.stats.alignCells, { observed: [900], rejected: [900] });
  });

  test('the cells recorded for an alignment are the ones alignCells counts for the trimmed middle', () => {
    const file = ['h1', 'h2', 'f1', 'f2', 'f3', 't1', 't2'];
    const window = ['h1', 'h2', 'w1', 'w2', 't1', 't2'];
    const result = run(attributionOver({ '/repo/cells.txt': `${file.join('\n')}\n` }), {
      input: { command: 'cat cells.txt' }, output: window.join('\n'),
    });
    assert.deepEqual(result.stats.alignCells.observed, [alignCells(file, window, { minTrim: LIMITS.evidenceFloor })]);
    assert.deepEqual(result.stats.alignCells.observed, [6]);
  });

  test('the look for a run that beats the head of a window is paid for from the call\'s budget', () => {
    // twelve identical lines in the file, and a window of four of them then a line that is not there: no run
    // elsewhere is longer than the head, so only the budget can say the look is unaffordable
    const attribution = attributionOver({ '/repo/steps.txt': 'step();\n'.repeat(12) }, { alignCells: 5 });
    const output = 'step();\nstep();\nstep();\nstep();\nzz';
    const result = run(attribution, { input: { command: 'cat steps.txt' }, output });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.stats.alignCells.rejected, [60]);
    const funded = run(attributionOver({ '/repo/steps.txt': 'step();\n'.repeat(12) }), {
      input: { command: 'cat steps.txt' }, output,
    });
    assert.deepEqual(shapeOf(funded)[0][2].map(([line, tier]) => [line, tier]), [[1, 'tied'], [2, 'tied'], [3, 'tied'], [4, 'tied']]);
  });

  test('a window that ends on a block the file also holds earlier is placed at the earlier one', () => {
    const file = fileOf(10, { 2: 'alpha', 3: 'beta', 4: 'gamma', 8: 'alpha', 9: 'beta', 10: 'gamma' });
    const result = run(attributionOver({ '/repo/ends.txt': file }), {
      input: { command: 'tail -4 ends.txt' }, output: 'unrelated\nalpha\nbeta\ngamma',
    });
    assert.deepEqual(shapeOf(result), [['/repo/ends.txt', 'output', [
      [2, 'tied', 'alpha'], [3, 'tied', 'beta'], [4, 'tied', 'gamma'],
    ]]]);
  });

  test('a head or tail shorter than the floor is left to the search, as alignCells counts it', () => {
    const file = ['same', 'a', 'b', 'c', 'end'];
    const window = ['same', 'x', 'y', 'end'];
    const result = run(attributionOver({ '/repo/short.txt': `${file.join('\n')}\n` }), {
      input: { command: 'cat short.txt' }, output: window.join('\n'),
    });
    assert.deepEqual(result.stats.alignCells.observed, [alignCells(file, window, { minTrim: LIMITS.evidenceFloor })]);
    assert.deepEqual(result.stats.alignCells.observed, [20]);
  });

  test('at a floor of 3 a run of two lines is rejected and a run of three accepted', () => {
    const file = fileOf(11, { 2: 'alpha line', 3: 'beta line', 6: 'gamma', 7: 'delta', 8: 'epsilon' });
    const output = 'alpha line\nbeta line\nnoise one\ngamma\ndelta\nepsilon';
    const args = { input: { command: 'cat f.txt' }, output };
    const strict = run(attributionOver({ '/repo/f.txt': file }, { evidenceFloor: 3 }), args);
    assert.deepEqual(shapeOf(strict)[0][2].map(([line]) => line), [6, 7, 8]);
    assert.deepEqual(strict.stats.evidenceFloor, { observed: [2, 3], rejected: [2] });
    const lenient = run(attributionOver({ '/repo/f.txt': file }, { evidenceFloor: 2 }), args);
    assert.deepEqual(shapeOf(lenient)[0][2].map(([line]) => line), [2, 3, 6, 7, 8]);
  });

  test('a run shorter than the evidence floor is not a match', () => {
    const attribution = attributionOver({ '/repo/few.txt': fileOf(6, { 3: 'alpha' }) });
    const result = run(attribution, { input: { command: 'cat few.txt' }, output: 'alpha\nsomething else' });
    assert.deepEqual(result.matches, []);
  });

  test('a content line that looks like a line-number cue still matches on the input side', () => {
    const content = '5-star review\n12:30:45 started\nlast line\n';
    const attribution = attributionOver({ '/repo/log.txt': content });
    const input = { file_path: 'log.txt', content };
    const result = run(attribution, { input, output: '' });
    assert.deepEqual(shapeOf(result), [['/repo/log.txt', 'input', [
      [1, 'aligned', '5-star review'], [2, 'aligned', '12:30:45 started'], [3, 'aligned', 'last line'],
    ]]]);
    assertConserved(result, { input, output: '' });
  });

  test('a whole-file read without line numbers attributes in full though its length squared exceeds the cell budget', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `distinct line ${i}`);
    const attribution = attributionOver({ '/repo/whole.txt': `${lines.join('\n')}\n` }, { alignCells: 50 });
    const result = run(attribution, { input: { command: 'cat whole.txt' }, output: lines.join('\n') });
    assert.deepEqual(shapeOf(result)[0][2].map(([line]) => line), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('a three-line window whose last line equals the last line of the file stays at its own lines', () => {
    const file = fileOf(12, { 5: 'function two() {', 6: '  return 2;', 7: '}', 12: '}' });
    const result = run(attributionOver({ '/repo/win.js': file }), {
      input: { command: 'sed -n 5,7p win.js' },
      output: 'function two() {\n  return 2;\n}',
    });
    assert.deepEqual(shapeOf(result)[0][2].map(([line]) => line), [5, 6, 7]);
  });
});

describe('the characters an aligned run holds', () => {
  // The closing lines of nested blocks, indented as a file indents them: a bracket, a blank and bare keywords.
  // Trimmed they hold 1 + 0 + 2 + 4 + 4 characters, and ENOUGH one more.
  const LIGHT = ['    }', '', '    fi', '    esac', '    done'];
  const ENOUGH = ['    })', '', '    fi', '    esac', '    done'];
  const holding = (block, at, total) => fileOf(total, Object.fromEntries(block.map((text, k) => [at + k, text])));

  for (const evidenceFloor of [2, 3]) {
    test(`a run of enough lines whose trimmed characters fall short is left unmatched, at a floor of ${evidenceFloor}`, () => {
      const input = { command: 'sed -n 5,9p run.sh' };
      const placed = block => run(attributionOver({ '/repo/run.sh': holding(block, 5, 12) }, { evidenceFloor }), {
        input, output: block.join('\n'),
      });
      const light = placed(LIGHT);
      assert.deepEqual(light.matches, []);
      assert.equal(light.unmatched.output, LIGHT.join('\n').length);
      assert.deepEqual(light.stats.evidenceFloor, { observed: [5], rejected: [5] });
      const enough = placed(ENOUGH);
      assert.deepEqual(shapeOf(enough), [['/repo/run.sh', 'output', ENOUGH.map((text, k) => [5 + k, 'aligned', text])]]);
      assert.deepEqual(enough.stats.evidenceFloor, { observed: [5], rejected: [] });
      assertConserved(enough, { input, output: ENOUGH.join('\n') });
    });

    test(`the lines a stronger run leaves a weaker run must hold the characters too, though the weaker run holds them whole, at a floor of ${evidenceFloor}`, () => {
      const shared = 'const total = sumOf(items);';
      const attribution = attributionOver({
        '/repo/small.js': `${['    }', '', '    fi', shared].join('\n')}\n`,
        '/repo/big.js': `${[shared, 'report(total);', 'return total;', 'cleanup();', 'done();'].join('\n')}\n`,
      }, { evidenceFloor });
      const input = { command: 'cat small.js big.js' };
      const output = ['    }', '', '    fi', shared, 'report(total);', 'return total;', 'cleanup();', 'done();'].join('\n');
      const result = run(attribution, { input, output });
      assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]),
        [['/repo/big.js', [1, 2, 3, 4, 5]]]);
      // the three lines before the shared one (5 + 0 + 6 characters) and the seven LF
      assert.equal(result.unmatched.output, 18);
      assertConserved(result, { input, output });
    });
  }

  test('a block of light lines the file holds twice is left unmatched, and its heavy twin is placed tied', () => {
    const twice = block => fileOf(20, Object.fromEntries(block.flatMap((text, k) => [[3 + k, text], [12 + k, text]])));
    const input = { command: 'sed -n 3,7p run.sh' };
    const placed = block => run(attributionOver({ '/repo/run.sh': twice(block) }), { input, output: block.join('\n') });
    const light = placed(LIGHT);
    assert.deepEqual(light.matches, []);
    assert.deepEqual(light.stats.evidenceFloor, { observed: [5], rejected: [5] });
    const enough = placed(ENOUGH);
    assert.deepEqual(shapeOf(enough), [['/repo/run.sh', 'output', ENOUGH.map((text, k) => [3 + k, 'tied', text])]]);
    assertConserved(enough, { input, output: ENOUGH.join('\n') });
  });

  // A stronger run takes the shared line and the four after it, and the weaker run is left the lines before the
  // shared one, which it matched as part of a heavy run. Whatever the weaker run's tier, what is left of it must
  // hold the characters on its own.
  describe('the part of a weaker run that a stronger run leaves', () => {
    const shared = 'const total = sumOf(items);';
    const rest = [shared, 'report(total);', 'return total;', 'cleanup();', 'done();'];
    const LIGHT_LEAD = ['    }', '', '    fi'];
    const ENOUGH_LEAD = ['    flush(total);', '', '    return;'];
    const linesOf = result => shapeOf(result).map(([key, , lines]) => [key, lines.map(([line, tier]) => [line, tier])]);

    test('a tied run keeps it only when it holds the characters', () => {
      const input = { command: 'cat small.js big.js' };
      const placed = (lead) => {
        const output = [...lead, ...rest].join('\n');
        const result = run(attributionOver({
          '/repo/small.js': `${[...lead, shared, ...lead, shared].join('\n')}\n`,
          '/repo/big.js': `${rest.join('\n')}\n`,
        }), { input, output });
        assertConserved(result, { input, output });
        return result;
      };
      const bigLines = [[1, 'aligned'], [2, 'aligned'], [3, 'aligned'], [4, 'aligned'], [5, 'aligned']];
      assert.deepEqual(linesOf(placed(LIGHT_LEAD)), [['/repo/big.js', bigLines]]);
      assert.deepEqual(linesOf(placed(ENOUGH_LEAD)), [
        ['/repo/small.js', [[1, 'tied'], [2, 'tied'], [3, 'tied']]],
        ['/repo/big.js', bigLines],
      ]);
    });

    test('a drifted run keeps it only when it holds the characters', () => {
      const input = { command: 'cat -n small.js big.js' };
      const placed = (lead) => {
        const rows = [...lead, ...rest].map((text, k) => `${String(3 + k).padStart(6)}\t${text}`);
        const output = rows.join('\n');
        const result = run(attributionOver({
          '/repo/small.js': holding([...lead, shared], 20, 40),
          '/repo/big.js': holding(rest, 30, 40),
        }), { input, output });
        assertConserved(result, { input, output });
        return { result, rows };
      };
      const drifted = (at, rows) => rows.map((text, k) => [at + k, 'drifted', text]);
      const light = placed(LIGHT_LEAD);
      assert.deepEqual(shapeOf(light.result), [['/repo/big.js', 'output', drifted(30, light.rows.slice(3))]]);
      // the three rows before the shared one (12 + 7 + 13 characters) and the seven LF
      assert.equal(light.result.unmatched.output, 39);
      const enough = placed(ENOUGH_LEAD);
      assert.deepEqual(shapeOf(enough.result), [
        ['/repo/small.js', 'output', drifted(20, enough.rows.slice(0, 3))],
        ['/repo/big.js', 'output', drifted(30, enough.rows.slice(3))],
      ]);
    });
  });

  test('the characters count after the line-number cue: a numbered row whose number fails is no heavier for its prefix', () => {
    const rowsOf = block => block.map((text, k) => `${String(3 + k).padStart(6)}\t${text}`);
    const input = { command: 'cat -n run.sh' };
    const placed = block => run(attributionOver({ '/repo/run.sh': holding(block, 20, 40) }), {
      input, output: rowsOf(block).join('\n'),
    });
    const light = placed(LIGHT);
    assert.deepEqual(light.matches, []);
    assert.equal(light.unmatched.output, rowsOf(LIGHT).join('\n').length);
    assert.deepEqual(light.stats.evidenceFloor, { observed: [5], rejected: [5] });
    const enough = placed(ENOUGH);
    assert.deepEqual(shapeOf(enough), [['/repo/run.sh', 'output', rowsOf(ENOUGH).map((text, k) => [20 + k, 'drifted', text])]]);
  });

  test('a declared run of short lines is verified and placed as before', () => {
    const output = '     3\t  }\n     4\t\n     5\tend';
    const result = run(attributionOver({ '/repo/tiny.sh': fileOf(8, { 3: '  }', 4: '', 5: 'end' }) }), {
      input: { command: 'cat -n tiny.sh' }, output,
    });
    assert.deepEqual(shapeOf(result), [['/repo/tiny.sh', 'output', [
      [3, 'declared', '     3\t  }'], [4, 'declared', '     4\t'], [5, 'declared', '     5\tend'],
    ]]]);
    assert.deepEqual(result.stats.evidenceFloor, { observed: [], rejected: [] });
  });

  test('two runs that are each too light are not joined by the short line between them, though together they hold enough', () => {
    const file = 'one\ntwo\nthree\n}\nfour\nfive\nsix\n';
    const result = run(attributionOver({ '/repo/gap.txt': file }), {
      input: { command: 'cat gap.txt' }, output: 'one\ntwo\nthree\n};\nfour\nfive\nsix',
    });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.stats.evidenceFloor, { observed: [3, 3], rejected: [3, 3] });
  });
});

describe('lines placed by their text alone', () => {
  const LONG = 'export function computeTotals(items) { return items.reduce(add, 0); }';
  const OTHER = 'export function computeAverage(items) { return computeTotals(items) / items.length; }';
  const placesOf = result => shapeOf(result).map(([key, side, lines]) => [key, side, lines.map(([line, tier]) => [line, tier])]);

  test('a long line the one candidate holds once is placed where it is, on the input side too', () => {
    const attribution = attributionOver({ '/repo/src/totals.js': fileOf(12, { 7: LONG }) });
    const input = { file_path: 'src/totals.js', old_string: 'x', new_string: LONG };
    const result = run(attribution, { input, output: 'The file /repo/src/totals.js has been updated successfully.' });
    assert.deepEqual(shapeOf(result), [['/repo/src/totals.js', 'input', [[7, 'aligned', LONG]]]]);
    assertConserved(result, { input, output: 'The file /repo/src/totals.js has been updated successfully.' });
  });

  test('a line the candidate holds twice is not placed, nor one that two candidates hold', () => {
    const twice = attributionOver({ '/repo/a.js': fileOf(12, { 3: LONG, 9: LONG }) });
    const cat = { command: 'cat a.js' };
    assert.deepEqual(run(twice, { input: cat, output: LONG }).matches, []);
    const shared = attributionOver({ '/repo/a.js': fileOf(12, { 3: LONG }), '/repo/b.js': fileOf(20, { 11: LONG }) });
    const result = run(shared, { input: { command: 'cat a.js b.js' }, output: LONG });
    assert.deepEqual(result.matches, []);
    assert.equal(result.unmatched.output, LONG.length);
  });

  test('a row that names its file is placed in that file only, though another candidate holds its text', () => {
    const attribution = attributionOver({ '/repo/a.js': fileOf(12, { 3: LONG }), '/repo/b.js': fileOf(12, { 4: OTHER }) });
    const output = `b.js:9:${LONG}`;
    const result = run(attribution, { input: { command: 'cat a.js; grep -n totals b.js' }, output });
    assert.deepEqual(result.matches, []);
    const own = run(attribution, { input: { command: 'cat a.js; grep -n totals b.js' }, output: `a.js:9:${LONG}` });
    assert.deepEqual(placesOf(own), [['/repo/a.js', 'output', [[3, 'drifted']]]]);
  });

  test('a short line is not placed by its text, however alone it is in the file', () => {
    const attribution = attributionOver({ '/repo/few.js': fileOf(12, { 5: '  return total;' }) });
    const result = run(attribution, { input: { command: 'cat few.js' }, output: '  return total;\nsomething else' });
    assert.deepEqual(result.matches, []);
  });

  test('a line counts its characters trimmed: one padded with spaces to the anchor length that holds fewer is not placed', () => {
    const exact = 'const totalOfItems = 12;';
    const short = 'const totalOfItems = 1;';
    assert.equal(exact.length, 24);
    assert.equal(short.length, 23);
    const padded = `        ${short}`;
    const attribution = attributionOver({ '/repo/src/totals.js': fileOf(12, { 3: `    ${exact}`, 8: padded }) });
    // the lines are apart in the evidence, so no run of two forms between them
    const output = `${padded}\nsomething else\n    ${exact}`;
    const result = run(attribution, { input: { command: 'cat src/totals.js' }, output });
    assert.deepEqual(placesOf(result), [['/repo/src/totals.js', 'output', [[3, 'aligned']]]]);
    assert.equal(result.unmatched.output, output.length - `    ${exact}`.length);
  });

  test('a row without a prefix is placed in the only candidate that holds its text', () => {
    const attribution = attributionOver({ '/repo/a.js': fileOf(12, { 3: LONG }), '/repo/b.js': fileOf(12, { 4: OTHER }) });
    const result = run(attribution, { input: { command: 'cat a.js; grep -n totals b.js' }, output: LONG });
    assert.deepEqual(placesOf(result), [['/repo/a.js', 'output', [[3, 'aligned']]]]);
  });

  test('a candidate the size limit drops is not read, so it is no rival to the one that holds the line', () => {
    const big = `${'// padding\n'.repeat(40)}${LONG}\n`;
    const files = { '/repo/a.js': fileOf(12, { 3: LONG }), '/repo/b.js': big };
    const input = { command: 'cat a.js b.js' };
    assert.deepEqual(run(attributionOver(files), { input, output: LONG }).matches, []);
    const capped = run(attributionOver(files, { fileBytes: 300 }), { input, output: LONG });
    assert.deepEqual(placesOf(capped), [['/repo/a.js', 'output', [[3, 'aligned']]]]);
    assert.deepEqual(capped.stats.fileBytes.rejected, [big.length]);
  });

  test('a line that a run took and the decoded line inside it are attributed once', () => {
    const json = `{"snippet": "${LONG}"}`;
    const attribution = attributionOver({ '/repo/data.json': `${json}\n`, '/repo/a.js': fileOf(12, { 6: LONG }) });
    const input = { command: 'cat data.json a.js' };
    const result = run(attribution, { input, output: json });
    assert.deepEqual(placesOf(result), [['/repo/data.json', 'output', [[1, 'aligned']]]]);
    assert.equal(result.unmatched.output, 0);
    assertConserved(result, { input, output: json });
  });

  test('a listing of files is only cues, though one of the listed files holds the long paths as its text', () => {
    const listed = ['/repo/src/components/Header.js', '/repo/src/components/Footer.js', '/repo/src/components/index.js'];
    const attribution = attributionOver({
      [listed[0]]: 'export const Header = () => null;\n',
      [listed[1]]: 'export const Footer = () => null;\n',
      [listed[2]]: `${listed.join('\n')}\n`,
    });
    const output = listed.join('\n');
    const result = run(attribution, { input: { command: 'find /repo/src -name "*.js"' }, output });
    assert.deepEqual(result.matches, []);
    assert.equal(result.unmatched.output, output.length);
  });

  test('a stray line beside a run is placed with it, and a line the run took is not placed again', () => {
    const file = fileOf(40, { 5: 'alpha', 6: 'beta', 7: 'gamma', 30: LONG });
    const attribution = attributionOver({ '/repo/mix.txt': file });
    const output = `alpha\nbeta\ngamma\n${LONG}`;
    const input = { command: 'cat mix.txt' };
    const result = run(attribution, { input, output });
    assert.deepEqual(placesOf(result), [['/repo/mix.txt', 'output', [[5, 'aligned'], [6, 'aligned'], [7, 'aligned'], [30, 'aligned']]]]);
    assertConserved(result, { input, output });
  });
});

describe('adjudication', () => {
  const COLORS = 'red\ngreen\nblue\ncyan\npink';

  test('a line two candidates explain goes to the one with the stronger run, though the other is cited first', () => {
    const attribution = attributionOver({
      '/repo/a.js': 'red\ngreen\nsilver\n',
      '/repo/b.js': `${COLORS}\n`,
    });
    const result = run(attribution, { input: { command: 'cat a.js' }, output: `b.js\n${COLORS}` });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]),
      [['/repo/b.js', [1, 2, 3, 4, 5]]]);
  });

  test('at equal strength the candidate the input cites wins, and a line is attributed once', () => {
    const attribution = attributionOver({ '/repo/a.js': `${COLORS}\n`, '/repo/b.js': `${COLORS}\n` });
    const result = run(attribution, { input: { command: 'cat a.js' }, output: `b.js\n${COLORS}` });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.length]), [['/repo/a.js', 5]]);
    assertConserved(result, { input: { command: 'cat a.js' }, output: `b.js\n${COLORS}` });
  });

  test('the lines a stronger run leaves a weaker one still have to keep the evidence floor', () => {
    const attribution = attributionOver({ '/repo/a.js': 'green\nblue\ncyan\npink\n', '/repo/b.js': 'red\ngreen\nblue\n' });
    const result = run(attribution, { input: { command: 'cat a.js b.js' }, output: COLORS });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]),
      [['/repo/a.js', [1, 2, 3, 4]]]);
  });

  test('two identical files the output cites at the same distance go to the earlier cue', () => {
    const attribution = attributionOver({ '/repo/a.js': 'red\ngreen\nblue\n', '/repo/b.js': 'red\ngreen\nblue\n' });
    const result = run(attribution, { input: { pattern: 'e' }, output: 'compare a.js b.js\nred\ngreen\nblue' });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]), [['/repo/a.js', [1, 2, 3]]]);
  });

  test('two readings of the same lines of equal strength go to the earlier position in the file', () => {
    // the file holds the body first and, after it, the wrapper that carries the body as one escaped line
    const file = ['p-line', 'q-line', 'r-line', '{', '  "s": "p-line\\nq-line\\nr-line"', '}'];
    const wrapper = ['{', file[4], '}'].join('\n');
    const input = { command: 'cat wrapped.txt' };
    const result = run(attributionOver({ '/repo/wrapped.txt': `${file.join('\n')}\n` }), { input, output: wrapper });
    assert.deepEqual(shapeOf(result), [['/repo/wrapped.txt', 'output', [
      [1, 'aligned', 'p-line'], [2, 'aligned', 'q-line'], [3, 'aligned', 'r-line'],
    ]]]);
    // { (1) + the 31 characters of the middle line + } (1) and two LF; three lines of 6 are matched
    assert.equal(wrapper.length, 35);
    assert.equal(result.unmatched.output, 17);
    assertConserved(result, { input, output: wrapper });
  });

  test('identical copies take the earlier cue only', () => {
    const attribution = attributionOver({ '/repo/a/x.js': `${COLORS}\n`, '/repo/b/x.js': `${COLORS}\n` });
    const result = run(attribution, { input: { command: 'diff a/x.js b/x.js' }, output: COLORS });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.length]), [['/repo/a/x.js', 5]]);
  });

  test('rows under the heading of one of two identical files are that file\'s', () => {
    const attribution = attributionOver({ '/repo/src/a.js': 'red\ngreen\n', '/repo/src/b.js': 'red\ngreen\n' });
    const output = 'src/a.js\nLine 1: red\nLine 2: green\n\nsrc/b.js\nLine 1: red\nLine 2: green';
    const result = run(attribution, { input: { pattern: 'e' }, output });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line, , text]) => `${line}:${text}`)]), [
      ['/repo/src/a.js', ['1:Line 1: red', '2:Line 2: green']],
      ['/repo/src/b.js', ['1:Line 1: red', '2:Line 2: green']],
    ]);
  });
});

describe('character conservation with matches', () => {
  test('plain text', () => {
    const output = 'alpha\nbeta\ngamma\n';
    const result = run(attributionOver({ '/repo/notes.txt': output }), { input: { command: 'cat notes.txt' }, output });
    // alpha(5) + beta(4) + gamma(5) are matched; the three LF are not
    assert.equal(result.unmatched.output, 3);
    // {"command":" (12) + cat notes.txt (13) + "} (2)
    assert.equal(result.unmatched.input, 27);
    assertConserved(result, { input: { command: 'cat notes.txt' }, output });
  });

  test('a content-block array with an image block', () => {
    const output = [
      { type: 'text', text: 'first\nsecond\nthird' },
      { type: 'image', source: { data: 'x'.repeat(300) } },
      { type: 'text', text: 'fourth' },
    ];
    const result = run(attributionOver({ '/repo/t.txt': 'first\nsecond\nthird\nfourth\n' }), {
      input: { command: 'cat t.txt' }, output,
    });
    // first(5) + second(6) + third(5) + fourth(6) are matched; the three LF are not
    assert.equal(sideTextOf(output).length, 25);
    assert.equal(result.unmatched.output, 3);
    assertConserved(result, { input: { command: 'cat t.txt' }, output });
  });

  test('JSON-wrapped text with quoted newlines and CJK', () => {
    const output = JSON.stringify({ text: '第一行\nsecond line\n第三行' });
    const result = run(attributionOver({ '/repo/doc.md': '第一行\nsecond line\n第三行\n' }), {
      input: { path: 'doc.md' }, output,
    });
    // 32 characters, of which 3 + 11 + 3 are lines
    assert.equal(output.length, 32);
    assert.equal(result.unmatched.output, 15);
    assertConserved(result, { input: { path: 'doc.md' }, output });
  });

  test('a Write input object', () => {
    const input = { file_path: 'src/new.js', content: 'line one\nline two\n' };
    const output = 'File created successfully at: /repo/src/new.js';
    const result = run(attributionOver({ '/repo/src/new.js': input.content }), { input, output });
    // 59 characters, of which line one (8) and line two (8) are lines; the output's 46 hold only a cue
    assert.equal(result.unmatched.input, 43);
    assert.equal(result.unmatched.output, 46);
    assertConserved(result, { input, output });
  });

  test('a JSON string inside a JSON string', () => {
    const output = JSON.stringify({ result: JSON.stringify([{ body: 'first line\nsecond line' }]) });
    const result = run(attributionOver({ '/repo/lib/x.js': 'first line\nsecond line\n' }), { input: { relative_path: 'lib/x.js' }, output });
    // 54 characters, of which first line (10) and second line (11) are lines
    assert.equal(result.unmatched.output, 33);
    assertConserved(result, { input: { relative_path: 'lib/x.js' }, output });
  });

  test('JSON nested past the depth limit is decoded no deeper and still conserved', () => {
    const output = '{"a":{"b":{"c":"first line\\nsecond line"}}}';
    const files = { '/repo/c.txt': 'first line\nsecond line\n' };
    const input = { path: 'c.txt' };
    const shallow = run(attributionOver(files, { decodeDepth: 2 }), { input, output });
    assert.deepEqual(shallow.matches, []);
    assert.equal(shallow.unmatched.output, output.length);
    const deep = run(attributionOver(files, { decodeDepth: 3 }), { input, output });
    assert.equal(deep.matches.length, 1);
    assertConserved(deep, { input, output });
  });

  test('a decoded run longer than the raw run that holds it takes its lines, and the raw line is not counted again', () => {
    const body = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'];
    const json = `{\n  "snippet": "${body.join('\\n')}"\n}`;
    const attribution = attributionOver({ '/repo/data.json': `${json}\n`, '/repo/a.js': `${body.join('\n')}\n` });
    const input = { command: 'cat data.json a.js' };
    const result = run(attribution, { input, output: json });
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line, tier]) => [line, tier])]),
      [['/repo/a.js', [[1, 'aligned'], [2, 'aligned'], [3, 'aligned'], [4, 'aligned']]]]);
    // { (1) + LF + the snippet line (2 + 9 + 2 + 1 + 48 + 3 x 2 + 1 = 69) + LF + } (1); four lines of 12 are matched
    assert.equal(json.length, 73);
    assert.equal(result.unmatched.output, 25);
    assertConserved(result, { input, output: json });
  });

  test('a cat of a JSON file whose lines are hit both raw and decoded counts each character once', () => {
    const json = '{\n  "snippet": "const a = 1;\\nconst b = 2;"\n}';
    const attribution = attributionOver({ '/repo/data.json': `${json}\n`, '/repo/a.js': 'const a = 1;\nconst b = 2;\n' });
    const input = { command: 'cat data.json a.js' };
    const result = run(attribution, { input, output: json });
    // the raw lines are 1 + 41 + 1 characters, the two LF are not; the decoded lines inside the second raw line are not counted again
    assert.deepEqual(shapeOf(result).map(([key, , lines]) => [key, lines.map(([line]) => line)]), [['/repo/data.json', [1, 2, 3]]]);
    assert.equal(json.length, 45);
    assert.equal(result.unmatched.output, 2);
    assertConserved(result, { input, output: json });
  });
});

describe('the scan for a second home of a run', () => {
  // two blocks of 400 step lines and a finish line: the two lines that end the file occur once more, 400 lines earlier
  const PAIR = 'step();\nfinish();';
  const FILE = `${'step();\n'.repeat(400)}finish();\n`.repeat(2);
  const attributionWith = alignCells => attributionOver({ '/repo/blocks.txt': FILE }, { alignCells });
  const tiersOf = result => result.matches[0].lines.map(({ line, tier }) => [line, tier]);

  test('is paid for from the call\'s budget, and a run it cannot afford to check is not marked tied', () => {
    const args = { input: { command: 'tail -2 blocks.txt' }, output: PAIR };
    assert.deepEqual(tiersOf(run(attributionWith(100_000), args)), [[801, 'tied'], [802, 'tied']]);
    assert.deepEqual(tiersOf(run(attributionWith(300), args)), [[801, 'aligned'], [802, 'aligned']]);
  });

  test('is one budget for all the runs of a call, so the later ones go unchecked first', () => {
    const output = JSON.stringify(Array.from({ length: 40 }, () => PAIR));
    const result = run(attributionWith(3000), { input: { command: 'tail -2 blocks.txt' }, output });
    const tiers = result.matches[0].lines.map(({ tier }) => tier);
    assert.equal(tiers.length, 80);
    assert.deepEqual(tiers.slice(0, 2), ['tied', 'tied']);
    assert.deepEqual(tiers.slice(-2), ['aligned', 'aligned']);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => (a === 'tied' ? 0 : 1) - (b === 'tied' ? 0 : 1)));
  });
});

describe('files and stats', () => {
  test('files hold the fingerprints of the file\'s normalized lines, read once with the matches', () => {
    const first = 'const a = 1;  \r\nconst b = 2;\r\nconst c = 3;\r\n';
    let reads = 0;
    const tree = treeOf({ '/repo/a.js': first, '/repo/unused.js': 'never matched\n' });
    const changing = { ...tree, readText: file => {
      reads++;
      return reads === 1 ? first : 'something else entirely\n';
    } };
    const attribution = createResourceAttribution({ workingTree: changing, limits: LIMITS });
    const output = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const result = run(attribution, { input: { command: 'cat a.js' }, output });
    assert.equal(reads, 1);
    assert.deepEqual(Object.keys(result.files), ['/repo/a.js']);
    assert.deepEqual(result.files['/repo/a.js'], ['const a = 1;', 'const b = 2;', 'const c = 3;'].map(fingerprintOf));
    assert.equal(result.matches.length, 1);
  });

  test('files fingerprint each line with its indentation, though a declared row is compared without it', () => {
    const lines = [
      'export function openLedger(path) {',
      '  const ledgerFile = join(root, path);',
      '    ledger.entries.push(readEntry(ledgerFile));',
      '\treturn ledgerTotals(ledger.entries);',
    ];
    const attribution = attributionOver({ '/repo/ledger.js': lines.map(line => `${line}  \r\n`).join('') });
    const output = lines.map((line, k) => `${k + 1}:${line}`).join('\n');
    const result = run(attribution, { input: { command: 'grep -n ledger ledger.js' }, output });
    assert.deepEqual(shapeOf(result)[0][2].map(([line, tier]) => [line, tier]), [
      [1, 'declared'], [2, 'declared'], [3, 'declared'], [4, 'declared'],
    ]);
    assert.deepEqual(result.files, { '/repo/ledger.js': lines.map(fingerprintOf) });
  });

  test('a file named by a cue but never matched has no entry in files', () => {
    const attribution = attributionOver({ '/repo/a.js': 'const a = 1;\n', '/repo/b.js': 'const b = 2;\n' });
    const result = run(attribution, { input: { command: 'cat a.js b.js' }, output: '1\tconst b = 2;' });
    assert.deepEqual(Object.keys(result.files), ['/repo/b.js']);
  });

  test('the alignment cells a call needs are in stats whether or not the budget covers them', () => {
    const file = `${Array.from({ length: 30 }, (_, i) => `file line ${i}`).join('\n')}\n`;
    const output = Array.from({ length: 30 }, (_, i) => `other text ${i}`).join('\n');
    const args = { input: { command: 'cat f.txt' }, output };
    const within = run(attributionOver({ '/repo/f.txt': file }, { alignCells: 900 }), args);
    assert.deepEqual(within.stats.alignCells, { observed: [900], rejected: [] });
    const over = run(attributionOver({ '/repo/f.txt': file }, { alignCells: 899 }), args);
    assert.deepEqual(over.stats.alignCells, { observed: [900], rejected: [900] });
    assert.deepEqual(over.matches, []);
  });

  test('the alignments of one call draw on one budget', () => {
    const rows = n => Array.from({ length: n }, (_, i) => `row ${i} of the output`).join('\n');
    const fileRows = n => `${Array.from({ length: n }, (_, i) => `row ${i} of a file`).join('\n')}\n`;
    const attribution = attributionOver({ '/repo/a.txt': fileRows(10), '/repo/b.txt': fileRows(10) }, { alignCells: 150 });
    const result = run(attribution, { input: { command: 'cat a.txt b.txt' }, output: rows(10) });
    assert.deepEqual(result.stats.alignCells, { observed: [100, 100], rejected: [100] });
  });

  test('the lengths of runs below the evidence floor are in stats, marked as rejected', () => {
    const attribution = attributionOver({ '/repo/f.txt': fileOf(9, { 2: 'alpha', 6: 'beta', 7: 'gamma', 8: 'delta' }) });
    const output = 'alpha\nsomething else\nbeta\ngamma\ndelta';
    const result = run(attribution, { input: { command: 'cat f.txt' }, output });
    assert.deepEqual(result.stats.evidenceFloor, { observed: [1, 3], rejected: [1] });
    assert.deepEqual(shapeOf(result)[0][2].map(([line]) => line), [6, 7, 8]);
  });

  test('the sizes of every candidate file are in stats, those over the limit marked', () => {
    const attribution = attributionOver({ '/repo/small.js': 'x\n', '/repo/big.js': 'y'.repeat(300) }, { fileBytes: 100 });
    const result = run(attribution, { input: { command: 'cat small.js big.js' }, output: '' });
    assert.deepEqual(result.stats.fileBytes, { observed: [2, 300], rejected: [300] });
  });
});

describe('failure and construction', () => {
  test('an adapter fault answers as a call that matched nothing, with stats marking the failure, and does not throw', () => {
    const faulty = { ...treeOf({ '/repo/a.js': 'const a = 1;\n' }), stat: () => { throw new Error('stat fault'); } };
    const attribution = createResourceAttribution({ workingTree: faulty, limits: LIMITS });
    const input = { command: 'cat a.js' };
    const output = '1\tconst a = 1;';
    const result = attribution.attribute({ base: BASE, input, output });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.files, {});
    assert.deepEqual(result.unmatched, { input: sideTextOf(input).length, output: output.length });
    assert.equal(result.stats.failed, true);
  });

  test('construction throws when a limit is missing or not a finite positive number', () => {
    const workingTree = treeOf({});
    for (const name of Object.keys(LIMITS)) {
      const { [name]: _removed, ...rest } = LIMITS;
      assert.throws(() => createResourceAttribution({ workingTree, limits: rest }), TypeError, `${name} missing`);
      for (const bad of [0, -1, NaN, Infinity, '5', null]) {
        assert.throws(() => createResourceAttribution({ workingTree, limits: { ...LIMITS, [name]: bad } }), TypeError,
          `${name} = ${String(bad)}`);
      }
    }
    assert.throws(() => createResourceAttribution({ workingTree }), TypeError);
  });

  test('construction throws when the working tree lacks a port method', () => {
    for (const method of ['resolve', 'stat', 'readText']) {
      const tree = { ...treeOf({}), [method]: undefined };
      assert.throws(() => createResourceAttribution({ workingTree: tree, limits: LIMITS }), TypeError, method);
    }
    assert.throws(() => createResourceAttribution({ limits: LIMITS }), TypeError);
  });
});
