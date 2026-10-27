// test/helpers/attribution-corpus.js — the result shapes tool calls return,
// kept as data for Resource Attribution: each block is the input and the result of one call over a small
// working tree, and the attribution it must get. The lines and paths are authored; a block keeps the shape
// a real result showed (prefixes, wrapping, truncation), not its content. A block's `matches` read as
// `[resourceKey, side, [[line, tier, text]…]]`.

export const BASE = '/repo';

// A file of `total` filler lines with chosen lines replaced: `special` maps a line number to its text.
export const fileOf = (total, special = {}) => `${Array.from(
  { length: total },
  (_, i) => special[i + 1] ?? `// filler ${i + 1}`,
).join('\n')}\n`;

const SPILL_NOTICE = '(Omitted 4096 bytes. Full formatted result stored at: /tmp/dsh-spill/result-1.txt. '
  + 'Read it with offset and limit to page through it.)';

export const CORPUS = [
  {
    name: 'a read numbered with a tab',
    files: { '/repo/src/a.js': 'const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n\n' },
    input: { file_path: 'src/a.js' },
    output: '1\tconst a = 1;\n2\tconst b = 2;\n3\tmodule.exports = { a, b };\n4\t',
    matches: [['/repo/src/a.js', 'output', [
      [1, 'declared', '1\tconst a = 1;'],
      [2, 'declared', '2\tconst b = 2;'],
      [3, 'declared', '3\tmodule.exports = { a, b };'],
      [4, 'declared', '4\t'],
    ]]],
  },
  {
    name: 'a windowed read numbered as N: text inside an envelope',
    files: { '/repo/src/a.js': fileOf(9, { 4: 'a += 1;', 5: 'a *= 2;' }) },
    input: { file_path: 'src/a.js', offset: 4, limit: 2 },
    output: '<path>/repo/src/a.js</path>\n<type>file</type>\n<content>\n4: a += 1;\n5: a *= 2;\n\n'
      + '(Showing lines 4-5 of 9. Use offset=6 to continue.)\n</content>',
    matches: [['/repo/src/a.js', 'output', [
      [4, 'declared', '4: a += 1;'],
      [5, 'declared', '5: a *= 2;'],
    ]]],
  },
  {
    name: 'a windowed read numbered as N: text over indented lines',
    files: {
      '/repo/src/ledger.js': fileOf(12, {
        6: '  const ledgerFile = join(root, path);',
        7: '    ledger.entries.push(readEntry(ledgerFile));',
        8: '\treturn ledgerTotals(ledger.entries);',
      }),
    },
    input: { file_path: 'src/ledger.js', offset: 6, limit: 3 },
    output: '<path>/repo/src/ledger.js</path>\n<type>file</type>\n<content>\n6:   const ledgerFile = join(root, path);\n'
      + '7:     ledger.entries.push(readEntry(ledgerFile));\n8: \treturn ledgerTotals(ledger.entries);\n\n'
      + '(Showing lines 6-8 of 12. Use offset=9 to continue.)\n</content>',
    matches: [['/repo/src/ledger.js', 'output', [
      [6, 'declared', '6:   const ledgerFile = join(root, path);'],
      [7, 'declared', '7:     ledger.entries.push(readEntry(ledgerFile));'],
      [8, 'declared', '8: \treturn ledgerTotals(ledger.entries);'],
    ]]],
  },
  {
    name: 'a read without line numbers',
    files: { '/repo/notes.txt': 'alpha\nbeta\ngamma\ndelta\n' },
    input: { command: 'cat notes.txt' },
    output: 'alpha\nbeta\ngamma\ndelta\n',
    matches: [['/repo/notes.txt', 'output', [
      [1, 'aligned', 'alpha'],
      [2, 'aligned', 'beta'],
      [3, 'aligned', 'gamma'],
      [4, 'aligned', 'delta'],
    ]]],
  },
  {
    name: 'cat -n',
    files: { '/repo/lib/util.js': 'export const x = 1;\nexport const y = 2;\n\n' },
    input: { command: 'cat -n lib/util.js' },
    output: '     1\texport const x = 1;\n     2\texport const y = 2;\n     3\t',
    matches: [['/repo/lib/util.js', 'output', [
      [1, 'declared', '     1\texport const x = 1;'],
      [2, 'declared', '     2\texport const y = 2;'],
      [3, 'declared', '     3\t'],
    ]]],
  },
  {
    name: 'a single-file grep -n whose hits sit at every indentation',
    files: {
      '/repo/src/ledger.js': fileOf(16, {
        3: 'export function openLedger(path) {',
        5: '  const ledgerFile = join(root, path);',
        8: '    ledger.entries.push(readEntry(ledgerFile));',
        11: '\treturn ledgerTotals(ledger.entries);',
        13: ' ledger.dirty = false;',
      }),
    },
    input: { command: 'grep -in ledger src/ledger.js' },
    output: '3:export function openLedger(path) {\n5:  const ledgerFile = join(root, path);\n'
      + '8:    ledger.entries.push(readEntry(ledgerFile));\n11:\treturn ledgerTotals(ledger.entries);\n'
      + '13: ledger.dirty = false;',
    matches: [['/repo/src/ledger.js', 'output', [
      [3, 'declared', '3:export function openLedger(path) {'],
      [5, 'declared', '5:  const ledgerFile = join(root, path);'],
      [8, 'declared', '8:    ledger.entries.push(readEntry(ledgerFile));'],
      [11, 'declared', '11:\treturn ledgerTotals(ledger.entries);'],
      [13, 'declared', '13: ledger.dirty = false;'],
    ]]],
  },
  {
    name: 'a grep with a path prefix on every row',
    files: {
      '/repo/src/a.js': fileOf(12, { 10: 'first hit', 11: 'third hit' }),
      '/repo/src/b.js': fileOf(20, { 20: 'second hit' }),
    },
    input: { pattern: 'hit' },
    output: 'src/a.js:10:first hit\nsrc/b.js:20:second hit\nsrc/a.js:11:third hit\n',
    matches: [
      ['/repo/src/a.js', 'output', [[10, 'declared', 'src/a.js:10:first hit'], [11, 'declared', 'src/a.js:11:third hit']]],
      ['/repo/src/b.js', 'output', [[20, 'declared', 'src/b.js:20:second hit']]],
    ],
  },
  {
    name: 'a grep in sections: a heading, then its Line N: rows',
    files: {
      '/repo/src/a.js': fileOf(10, { 3: 'const a = 1;', 9: 'a += 1;' }),
      '/elsewhere/b.js': 'import a from "../repo/src/a.js";\n',
    },
    input: { pattern: 'a' },
    output: [
      'Found 3 of 7 matches',
      'src/a.js\nLine 3: const a = 1;\nLine 9: a += 1;',
      '/elsewhere/b.js\nLine 1: import a from "../repo/src/a.js";',
      '(Full grep result stored at: /tmp/dsh-spill/grep-1.txt. Read it with offset and limit to page through it.)',
    ].join('\n\n'),
    matches: [
      ['/repo/src/a.js', 'output', [[3, 'declared', 'Line 3: const a = 1;'], [9, 'declared', 'Line 9: a += 1;']]],
      ['/elsewhere/b.js', 'output', [[1, 'declared', 'Line 1: import a from "../repo/src/a.js";']]],
    ],
  },
  {
    name: 'a grep cut in the middle by a spill, its second half left without a heading',
    files: {
      '/repo/src/a.js': fileOf(31, { 3: 'const a = 1;', 30: 'a += 30;', 31: 'a -= 1;' }),
      '/repo/lib/b.js': fileOf(8, { 7: 'b();' }),
    },
    input: { pattern: 'a' },
    output: [
      'Found 40 matches\n\nsrc/a.js\nLine 3: const a = 1;',
      '[...]',
      'Line 30: a += 30;\nLine 31: a -= 1;\n\nlib/b.js\nLine 7: b();',
      SPILL_NOTICE,
    ].join('\n\n'),
    matches: [
      ['/repo/src/a.js', 'output', [
        [3, 'declared', 'Line 3: const a = 1;'],
        [30, 'declared', 'Line 30: a += 30;'],
        [31, 'declared', 'Line 31: a -= 1;'],
      ]],
      ['/repo/lib/b.js', 'output', [[7, 'declared', 'Line 7: b();']]],
    ],
  },
  {
    name: 'a JSON-wrapped result whose body is the lines of a file',
    files: { '/repo/lib/x.js': fileOf(8, { 5: 'function f() {', 6: '  return 1;', 7: '}' }) },
    input: { relative_path: 'lib/x.js', name_path: 'f' },
    output: JSON.stringify({
      result: JSON.stringify([{
        relative_path: 'lib/x.js',
        body_location: { start_line: 4, end_line: 6 },
        body: 'function f() {\n  return 1;\n}',
      }]),
    }),
    matches: [['/repo/lib/x.js', 'output', [
      [5, 'aligned', 'function f() {'],
      [6, 'aligned', '  return 1;'],
      [7, 'aligned', '}'],
    ]]],
  },
  {
    name: 'a heredoc written to a file',
    files: { '/repo/out.txt': 'hello\nworld\nagain\n' },
    input: { command: 'cat <<\'EOF\' > out.txt\nhello\nworld\nagain\nEOF' },
    output: '',
    matches: [['/repo/out.txt', 'input', [
      [1, 'aligned', 'hello'],
      [2, 'aligned', 'world'],
      [3, 'aligned', 'again'],
    ]]],
  },
  {
    name: 'a sectioned grep whose declared numbers no longer hold, one hit per row',
    files: {
      '/repo/src/catalog.js': fileOf(40, {
        12: 'export function openCatalog(location, options = {}) {',
        31: '  const schemaVersion = readSchemaVersion(handle);',
      }),
    },
    input: { pattern: 'openCatalog|schemaVersion' },
    output: [
      'src/catalog.js',
      'Line 9: export function openCatalog(location, options = {}) {',
      'Line 28:   const schemaVersion = readSchemaVersion(handle);',
    ].join('\n'),
    matches: [['/repo/src/catalog.js', 'output', [
      [12, 'drifted', 'Line 9: export function openCatalog(location, options = {}) {'],
      [31, 'drifted', 'Line 28:   const schemaVersion = readSchemaVersion(handle);'],
    ]]],
  },
  {
    name: 'the matching lines of one file, without numbers or neighbours',
    files: {
      '/repo/lib/config.js': fileOf(60, {
        8: 'export const CONFIG_FILE = path.join(homedir(), \'.example-tool\', \'config.json\');',
        33: 'export function readConfig(file = CONFIG_FILE) { return parseConfig(readText(file)); }',
        57: 'export function writeConfig(config, file = CONFIG_FILE) { writeText(file, stringify(config)); }',
      }),
    },
    input: { command: 'grep -h CONFIG_FILE lib/config.js' },
    output: [
      'export const CONFIG_FILE = path.join(homedir(), \'.example-tool\', \'config.json\');',
      'export function readConfig(file = CONFIG_FILE) { return parseConfig(readText(file)); }',
      'export function writeConfig(config, file = CONFIG_FILE) { writeText(file, stringify(config)); }',
    ].join('\n'),
    matches: [['/repo/lib/config.js', 'output', [
      [8, 'aligned', 'export const CONFIG_FILE = path.join(homedir(), \'.example-tool\', \'config.json\');'],
      [33, 'aligned', 'export function readConfig(file = CONFIG_FILE) { return parseConfig(readText(file)); }'],
      [57, 'aligned', 'export function writeConfig(config, file = CONFIG_FILE) { writeText(file, stringify(config)); }'],
    ]]],
  },
  {
    name: 'a result in content blocks whose text block is JSON',
    files: { '/repo/notes/todo.md': 'buy milk\nwrite spec\nreview PR\n' },
    input: { path: 'notes/todo.md' },
    output: [{ type: 'text', text: JSON.stringify({ path: 'notes/todo.md', text: 'buy milk\nwrite spec\nreview PR' }) }],
    matches: [['/repo/notes/todo.md', 'output', [
      [1, 'aligned', 'buy milk'],
      [2, 'aligned', 'write spec'],
      [3, 'aligned', 'review PR'],
    ]]],
  },
  {
    name: 'a read after a cd, the session directory holding a file of the same name',
    files: {
      '/repo/docs/guide.txt': 'install the tool\nrun the first check\nread the report\n',
      '/repo/guide.txt': 'a different guide\nwith other words\nand other lines\n',
    },
    input: { command: 'cd docs && cat guide.txt' },
    output: 'install the tool\nrun the first check\nread the report\n',
    matches: [['/repo/docs/guide.txt', 'output', [
      [1, 'aligned', 'install the tool'],
      [2, 'aligned', 'run the first check'],
      [3, 'aligned', 'read the report'],
    ]]],
  },
  {
    name: 'a read after a cd to a directory that is not there, the session directory holding the file',
    files: { '/repo/guide.txt': 'install the tool\nrun the first check\nread the report\n' },
    input: { command: 'cd missing && cat guide.txt' },
    output: 'install the tool\nrun the first check\nread the report\n',
    matches: [],
  },
  {
    name: 'a read through a variable that names the directory',
    files: {
      '/work/docs/guide.txt': 'install the tool\nrun the first check\nread the report\n',
      '/repo/guide.txt': 'a different guide\nwith other words\nand other lines\n',
    },
    input: { command: 'D=/work/docs; cd $D && cat guide.txt' },
    output: 'install the tool\nrun the first check\nread the report\n',
    matches: [['/work/docs/guide.txt', 'output', [
      [1, 'aligned', 'install the tool'],
      [2, 'aligned', 'run the first check'],
      [3, 'aligned', 'read the report'],
    ]]],
  },
  {
    name: 'a read in a subshell that changed directory, then a read after it',
    files: {
      '/repo/notes/todo.txt': 'buy milk\nwrite spec\nreview PR\n',
      '/repo/todo.txt': 'call the bank\nbook a room\nsend the invoice\n',
      '/repo/plan.txt': 'draft the outline\ncut the scope\nship on friday\n',
      '/repo/notes/plan.txt': 'sketch the layout\nlist the risks\nname an owner\n',
    },
    input: { command: '(cd notes && cat todo.txt); cat plan.txt' },
    output: 'buy milk\nwrite spec\nreview PR\ndraft the outline\ncut the scope\nship on friday\n',
    matches: [
      ['/repo/notes/todo.txt', 'output', [[1, 'aligned', 'buy milk'], [2, 'aligned', 'write spec'], [3, 'aligned', 'review PR']]],
      ['/repo/plan.txt', 'output', [[1, 'aligned', 'draft the outline'], [2, 'aligned', 'cut the scope'], [3, 'aligned', 'ship on friday']]],
    ],
  },
  {
    name: 'a grep -rn run in another directory, its rows named relative to it',
    files: {
      '/work/lib/store.js': fileOf(14, { 5: 'export function openStore(file) {', 12: '  return openStore(defaultFile);' }),
      '/repo/lib/store.js': fileOf(14, { 5: 'export function openStore(file) {', 12: '  return openStore(defaultFile);' }),
    },
    input: { command: 'cd /work && grep -rn openStore .' },
    output: 'lib/store.js:5:export function openStore(file) {\nlib/store.js:12:  return openStore(defaultFile);',
    matches: [['/work/lib/store.js', 'output', [
      [5, 'declared', 'lib/store.js:5:export function openStore(file) {'],
      [12, 'declared', 'lib/store.js:12:  return openStore(defaultFile);'],
    ]]],
  },
];
