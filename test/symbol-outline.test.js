import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initParser, loadGrammar, extractSymbols, fitLinesToSymbols, activeSymbolsForPath, buildSymbolRanges, resolveSymbolLines, isSupported, canExtract } from '../lib/symbol-outline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NM = join(__dirname, '..', 'node_modules');

test('extractSymbols: setup', async () => {
  await initParser({ wasmDir: join(NM, 'web-tree-sitter') });
  await loadGrammar('.js', { wasmDir: join(NM, 'tree-sitter-javascript') });
});

test('extractSymbols: top-level function', () => {
  const code = `function hello() {\n  return 1;\n}\n`;
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [{ name: 'hello', startLine: 1, endLine: 3, depth: 0 }]);
});

test('extractSymbols: class with methods', () => {
  const code = [
    'class Store {',
    '  constructor() {',
    '    this.x = 1;',
    '  }',
    '  get() {',
    '    return this.x;',
    '  }',
    '}',
  ].join('\n');
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [
    { name: 'Store', startLine: 1, endLine: 8, depth: 0 },
    { name: 'Store.constructor', startLine: 2, endLine: 4, depth: 1 },
    { name: 'Store.get', startLine: 5, endLine: 7, depth: 1 },
  ]);
});

test('extractSymbols: generator function', () => {
  const code = `function* migrate() {\n  yield 1;\n  yield 2;\n}\n`;
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [{ name: 'migrate', startLine: 1, endLine: 4, depth: 0 }]);
});

test('extractSymbols: variable declaration ≥3 lines included', () => {
  const code = `const handler = (\n  req,\n  res\n) => {};\n`;
  const syms = extractSymbols(code, '.js');
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, 'handler');
});

test('extractSymbols: variable declaration <3 lines excluded', () => {
  const code = `const x = 5;\n`;
  const syms = extractSymbols(code, '.js');
  assert.equal(syms.length, 0);
});

test('extractSymbols: exported function unwrapped', () => {
  const code = `export function run() {\n  doStuff();\n}\n`;
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [{ name: 'run', startLine: 1, endLine: 3, depth: 0 }]);
});

test('extractSymbols: export default function unwrapped', () => {
  const code = `export default function main() {\n  init();\n  start();\n}\n`;
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [{ name: 'main', startLine: 1, endLine: 4, depth: 0 }]);
});

test('extractSymbols: export default class unwrapped', () => {
  const code = [
    'export default class App {',
    '  render() {',
    '    return null;',
    '  }',
    '}',
  ].join('\n');
  const syms = extractSymbols(code, '.js');
  assert.deepEqual(syms, [
    { name: 'App', startLine: 1, endLine: 5, depth: 0 },
    { name: 'App.render', startLine: 2, endLine: 4, depth: 1 },
  ]);
});

// ── Fitting tests ──

test('fitLinesToSymbols: tightest enclosing wins', () => {
  const symbols = [
    { name: 'Store', startLine: 1, endLine: 50 },
    { name: 'Store.constructor', startLine: 5, endLine: 20 },
  ];
  const { activeSymbols, coveredCount, orphanLines } = fitLinesToSymbols([10, 25], symbols);
  assert.deepEqual(activeSymbols.sort(), ['Store', 'Store.constructor']);
  assert.equal(coveredCount, 2);
  assert.deepEqual(orphanLines, []);
});

test('fitLinesToSymbols: orphan lines', () => {
  const symbols = [{ name: 'foo', startLine: 5, endLine: 10 }];
  const { activeSymbols, orphanLines } = fitLinesToSymbols([1, 7, 15], symbols);
  assert.deepEqual(activeSymbols, ['foo']);
  assert.deepEqual(orphanLines, [1, 15]);
});

test('activeSymbolsForPath: gate degrades below 50%', async () => {
  await initParser();
  await loadGrammar('.js');
  // Code with mostly structural orphans (if/for blocks, no named symbols)
  const code = [
    'if (true) {', '  x = 1;', '  y = 2;', '  z = 3;', '}',
    'for (let i = 0; i < 10; i++) {', '  arr.push(i);', '}',
  ].join('\n');
  const lines = [1, 2, 3, 4, 5, 6, 7, 8];
  const result = activeSymbolsForPath(code, '.js', lines, false);
  assert.equal(result.activeSymbols, null);
});

test('activeSymbolsForPath: full-file snapshot returns all symbols capped', async () => {
  const code = Array.from({ length: 10 }, (_, i) =>
    `function f${i}() {\n  return ${i};\n}\n`
  ).join('\n');
  const lines = Array.from({ length: 40 }, (_, i) => i + 1);
  const result = activeSymbolsForPath(code, '.js', lines, true);
  assert.ok(result.activeSymbols);
  assert.equal(result.activeSymbols.length, 10); // flat cap=30, file has 10 functions
});

test('buildSymbolRanges: maps kept names to bucket lines within symbol', () => {
  const code = [
    'function foo() {', '  return 1;', '}',
    'function bar() {', '  return 2;', '}',
  ].join('\n');
  const result = buildSymbolRanges(code, '.js', ['foo'], [1, 2, 3, 4, 5]);
  assert.deepEqual(result.foo, [[1, 3]]);
  assert.deepEqual(Object.keys(result), ['foo']);
});

test('buildSymbolRanges: omits kept name not found', () => {
  const code = `function foo() { return 1; }\n`;
  const result = buildSymbolRanges(code, '.js', ['nonexistent'], [1]);
  assert.deepEqual(Object.keys(result), []);
});

test('resolveSymbolLines: found symbols get current range', () => {
  const code = [
    'function foo() {', '  return 1;', '}',
  ].join('\n');
  const { resolved, stale } = resolveSymbolLines(code, '.js', { foo: [[1, 2]] });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, 'foo');
  assert.equal(resolved[0].startLine, 1);
  assert.equal(resolved[0].endLine, 3);
  assert.equal(stale.length, 0);
});

test('resolveSymbolLines: missing symbols are stale', () => {
  const code = `function bar() { return 1; }\n`;
  const { resolved, stale } = resolveSymbolLines(code, '.js', { foo: [[10, 15]] });
  assert.equal(resolved.length, 0);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].name, 'foo');
  assert.deepEqual(stale[0].storedRanges, [[10, 15]]);
});

// ── TypeScript tests ──

test('extractSymbols: TypeScript interface ≥3 lines', async () => {
  await loadGrammar('.ts', { wasmDir: join(NM, 'tree-sitter-typescript') });
  const code = [
    'interface Config {',
    '  port: number;',
    '  host: string;',
    '}',
  ].join('\n');
  const syms = extractSymbols(code, '.ts');
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, 'Config');
});

test('extractSymbols: TypeScript interface <3 lines excluded', async () => {
  const code = `interface Foo { x: number; }\n`;
  const syms = extractSymbols(code, '.ts');
  assert.equal(syms.length, 0);
});

// ── Python tests ──

test('extractSymbols: Python function and class', async () => {
  await loadGrammar('.py', { wasmDir: join(NM, 'tree-sitter-python') });
  const code = [
    'def hello():',
    '    return 1',
    '',
    'class Store:',
    '    def __init__(self):',
    '        self.x = 1',
    '',
    '    def get(self):',
    '        return self.x',
  ].join('\n');
  const syms = extractSymbols(code, '.py');
  const names = syms.map(s => s.name);
  assert.ok(names.includes('hello'));
  assert.ok(names.includes('Store'));
  assert.ok(names.includes('Store.__init__'));
  assert.ok(names.includes('Store.get'));
});

test('extractSymbols: Python decorated function includes decorator in span', async () => {
  const code = [
    '@app.route("/")',
    'def index():',
    '    return "hello"',
  ].join('\n');
  const syms = extractSymbols(code, '.py');
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, 'index');
  assert.equal(syms[0].startLine, 1); // includes decorator
  assert.equal(syms[0].endLine, 3);
});

test('extractSymbols: Python async def recognized', async () => {
  const code = [
    'async def fetch_data():',
    '    resp = await client.get(url)',
    '    return resp.json()',
  ].join('\n');
  const syms = extractSymbols(code, '.py');
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, 'fetch_data');
});

// ── canExtract / isSupported tests ──

test('isSupported: .md returns true', () => {
  assert.equal(isSupported('.md'), true);
});

test('isSupported: .js returns true', () => {
  assert.equal(isSupported('.js'), true);
});

test('isSupported: .unknown returns false', () => {
  assert.equal(isSupported('.unknown'), false);
});

test('canExtract: .md returns true without parser init', () => {
  // .md never needs tree-sitter — should be true even before initParser
  assert.equal(canExtract('.md'), true);
});

test('canExtract: .js returns true when grammar loaded', () => {
  // .js grammar was loaded in setup test
  assert.equal(canExtract('.js'), true);
});

test('canExtract: .tsx returns false before grammar load', () => {
  // .tsx grammar not loaded (separate WASM from .js) — should not be extractable
  assert.equal(canExtract('.tsx'), false);
});

// ── Markdown extraction tests ──

test('extractSymbols: markdown h1 + h2 + h3 nested', () => {
  const code = [
    '# Project',           // line 1
    '',                     // line 2
    'Intro paragraph.',     // line 3
    '',                     // line 4
    '## Setup',             // line 5
    '',                     // line 6
    'Setup details.',       // line 7
    '',                     // line 8
    '### Install',          // line 9
    '',                     // line 10
    'npm install',          // line 11
    '',                     // line 12
    '### Configure',        // line 13
    '',                     // line 14
    'Edit config.',         // line 15
    '',                     // line 16
    '## Usage',             // line 17
    '',                     // line 18
    'Use it.',              // line 19
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Project', startLine: 1, endLine: 19, depth: 0 },
    { name: 'Project > Setup', startLine: 5, endLine: 16, depth: 1 },
    { name: 'Project > Setup > Install', startLine: 9, endLine: 12, depth: 2 },
    { name: 'Project > Setup > Configure', startLine: 13, endLine: 16, depth: 2 },
    { name: 'Project > Usage', startLine: 17, endLine: 19, depth: 1 },
  ]);
});

test('extractSymbols: markdown code fence not treated as heading', () => {
  const code = [
    '# Doc',               // line 1
    '',                     // line 2
    '```markdown',          // line 3
    '## Not a heading',     // line 4
    '### Also not',         // line 5
    '```',                  // line 6
    '',                     // line 7
    '## Real Section',      // line 8
    '',                     // line 9
    'Content.',             // line 10
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Doc', startLine: 1, endLine: 10, depth: 0 },
    { name: 'Doc > Real Section', startLine: 8, endLine: 10, depth: 1 },
  ]);
});

test('extractSymbols: markdown h4+ ignored', () => {
  const code = [
    '# Top',                // line 1
    '',                     // line 2
    '## Section',           // line 3
    '',                     // line 4
    '#### Deep heading',    // line 5 — ignored
    '',                     // line 6
    'Text.',                // line 7
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Top', startLine: 1, endLine: 7, depth: 0 },
    { name: 'Top > Section', startLine: 3, endLine: 7, depth: 1 },
  ]);
});

test('extractSymbols: markdown no h1 — h2 is top level', () => {
  const code = [
    '## First',             // line 1
    '',                     // line 2
    'Content.',             // line 3
    '',                     // line 4
    '## Second',            // line 5
    '',                     // line 6
    '### Sub',              // line 7
    '',                     // line 8
    'Detail.',              // line 9
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'First', startLine: 1, endLine: 4, depth: 0 },
    { name: 'Second', startLine: 5, endLine: 9, depth: 0 },
    { name: 'Second > Sub', startLine: 7, endLine: 9, depth: 1 },
  ]);
});

test('extractSymbols: markdown tilde fence', () => {
  const code = [
    '## Section',           // line 1
    '',                     // line 2
    '~~~',                  // line 3
    '## fake',              // line 4
    '~~~',                  // line 5
    '',                     // line 6
    '## Next',              // line 7
    '',                     // line 8
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Section', startLine: 1, endLine: 6, depth: 0 },
    { name: 'Next', startLine: 7, endLine: 7, depth: 0 },
  ]);
});

test('extractSymbols: markdown mixed fence chars — tilde inside backtick not a close', () => {
  const code = [
    '## Section',           // line 1
    '',                     // line 2
    '````',                 // line 3 — open with 4 backticks
    '~~~',                  // line 4 — tilde inside backtick fence, NOT a close
    '## fake heading',      // line 5 — still inside fence
    '````',                 // line 6 — close (same char, same length)
    '',                     // line 7
    '## Real',              // line 8
    '',                     // line 9
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Section', startLine: 1, endLine: 7, depth: 0 },
    { name: 'Real', startLine: 8, endLine: 8, depth: 0 },
  ]);
});

test('extractSymbols: markdown trailing # stripped', () => {
  const code = '## Section Title ##\n\nContent.\n';
  const syms = extractSymbols(code, '.md');
  assert.equal(syms[0].name, 'Section Title');
});

test('extractSymbols: markdown YAML frontmatter skipped', () => {
  const code = [
    '---',                  // line 1
    '# yaml comment',       // line 2 — NOT a heading
    'title: Demo',          // line 3
    '---',                  // line 4
    '',                     // line 5
    '# Real Title',         // line 6
    '',                     // line 7
    '## Section',           // line 8
    '',                     // line 9
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Real Title', startLine: 6, endLine: 8, depth: 0 },
    { name: 'Real Title > Section', startLine: 8, endLine: 8, depth: 1 },
  ]);
});

test('extractSymbols: markdown CRLF line endings handled', () => {
  const code = '## Section\r\n\r\nContent.\r\n';
  const syms = extractSymbols(code, '.md');
  assert.equal(syms[0].name, 'Section'); // no trailing \r
  assert.equal(syms[0].startLine, 1);
});

test('extractSymbols: markdown fence with trailing text is not a close', () => {
  const code = [
    '## Section',           // line 1
    '',                     // line 2
    '```js',                // line 3 — open (info string OK on open)
    '```not a close',       // line 4 — NOT a close (has trailing text)
    '## fake',              // line 5 — still inside fence
    '```',                  // line 6 — real close (only whitespace after)
    '',                     // line 7
    '## Real',              // line 8
    '',                     // line 9
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Section', startLine: 1, endLine: 7, depth: 0 },
    { name: 'Real', startLine: 8, endLine: 8, depth: 0 },
  ]);
});

test('extractSymbols: markdown indented heading (up to 3 spaces)', () => {
  const code = [
    '# Top',               // line 1
    '',                     // line 2
    '   ## Indented',       // line 3 — valid (3 spaces)
    '',                     // line 4
    'Content.',             // line 5
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Top', startLine: 1, endLine: 5, depth: 0 },
    { name: 'Top > Indented', startLine: 3, endLine: 5, depth: 1 },
  ]);
});

test('extractSymbols: markdown duplicate heading names → returns empty', () => {
  const code = [
    '# Doc',               // line 1
    '',                     // line 2
    '## Notes',             // line 3
    '',                     // line 4
    '## Notes',             // line 5 — duplicate full name "Doc > Notes"
    '',                     // line 6
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, []); // bail out — can't safely resolve
});

test('extractSymbols: markdown backtick fence with backtick in info string is not a fence', () => {
  const code = [
    '## Section',           // line 1
    '',                     // line 2
    '``` foo ` bar',        // line 3 — NOT a fence (backtick in info string)
    '## Real Heading',      // line 4 — IS a heading (not inside fence)
    '',                     // line 5
    'Content.',             // line 6
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Section', startLine: 1, endLine: 3, depth: 0 },
    { name: 'Real Heading', startLine: 4, endLine: 6, depth: 0 },
  ]);
});

test('extractSymbols: markdown tilde fence with backtick in info string IS valid', () => {
  const code = [
    '## Section',           // line 1
    '',                     // line 2
    '~~~ foo ` bar',        // line 3 — valid tilde fence (backticks OK in info)
    '## fake',              // line 4 — inside fence
    '~~~',                  // line 5 — close
    '',                     // line 6
    '## Next',              // line 7
    '',                     // line 8
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Section', startLine: 1, endLine: 6, depth: 0 },
    { name: 'Next', startLine: 7, endLine: 7, depth: 0 },
  ]);
});

test('extractSymbols: markdown exceeding MAX_SYMBOL_FILE_BYTES returns empty', () => {
  const bigCode = '# Title\n' + 'x'.repeat(512 * 1024 + 1);
  const syms = extractSymbols(bigCode, '.md');
  assert.deepEqual(syms, []);
});

test('extractSymbols: markdown trailing newline does not inflate endLine', () => {
  const code = '# Title\n\nContent.\n';  // trailing \n → 4 elements after split, but line 4 is phantom
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Title', startLine: 1, endLine: 3, depth: 0 },
  ]);
});

test('extractSymbols: markdown file with only frontmatter returns empty', () => {
  const code = '---\ntitle: No headings\nauthor: Test\n---\n';
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, []);
});

test('extractSymbols: markdown unclosed frontmatter within 50 lines treated as not frontmatter', () => {
  const code = '---\ntitle: never closed\n# This IS extracted\n';
  const syms = extractSymbols(code, '.md');
  // No closing --- within 50 lines → not frontmatter, parse from start; # heading on line 3 extracted
  assert.deepEqual(syms, [
    { name: 'This IS extracted', startLine: 3, endLine: 3, depth: 0 },
  ]);
});

test('extractSymbols: markdown unicode heading names', () => {
  const code = [
    '# 安装指南',             // line 1
    '',                       // line 2
    '## 🚀 Getting Started',  // line 3
    '',                       // line 4
    'Content.',               // line 5
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: '安装指南', startLine: 1, endLine: 5, depth: 0 },
    { name: '安装指南 > 🚀 Getting Started', startLine: 3, endLine: 5, depth: 1 },
  ]);
});

test('extractSymbols: markdown empty file returns empty', () => {
  const syms = extractSymbols('', '.md');
  assert.deepEqual(syms, []);
});

// ── Markdown integration tests (activeSymbolsForPath, buildSymbolRanges, resolveSymbolLines) ──

test('activeSymbolsForPath: markdown full snapshot returns all headings', () => {
  const code = [
    '# Doc',
    '',
    '## Part A',
    '',
    'Text.',
    '',
    '## Part B',
    '',
    '### Sub B1',
    '',
    'Detail.',
  ].join('\n');
  const { activeSymbols } = activeSymbolsForPath(code, '.md', [], true);
  assert.deepEqual(activeSymbols, ['Doc', 'Doc > Part A', 'Doc > Part B', 'Doc > Part B > Sub B1']);
});

test('activeSymbolsForPath: markdown bucket lines fit to tightest heading', () => {
  const code = [
    '# Doc',           // 1
    '',                 // 2
    '## Setup',        // 3
    '',                 // 4
    '### Install',     // 5
    '',                 // 6
    'npm install',     // 7
    '',                 // 8
    '## Usage',        // 9
    '',                 // 10
    'Use it.',         // 11
  ].join('\n');
  // Lines 6,7 are inside "Install" (tightest), line 10 is inside "Usage"
  const { activeSymbols } = activeSymbolsForPath(code, '.md', [6, 7, 10], false);
  assert.deepEqual(activeSymbols, ['Doc > Setup > Install', 'Doc > Usage']);
});

test('buildSymbolRanges: markdown produces correct ranges', () => {
  const code = [
    '# Doc',           // 1
    '',                 // 2
    '## Setup',        // 3
    '',                 // 4
    'Step 1.',          // 5
    '',                 // 6
    '## Run',          // 7
    '',                 // 8
    'Do it.',           // 9
  ].join('\n');
  const ranges = buildSymbolRanges(code, '.md', ['Doc > Setup'], [4, 5, 6]);
  assert.deepEqual(ranges['Doc > Setup'], [[4, 6]]);
});

test('resolveSymbolLines: markdown resolves headings to current lines', () => {
  const code = [
    '# Doc',           // 1
    '',                 // 2
    '## Setup',        // 3  — was at lines 5-8 in old version
    '',                 // 4
    'New content.',     // 5
    '',                 // 6
    '## Run',          // 7
    '',                 // 8
  ].join('\n');
  const symbolRanges = { 'Doc > Setup': [[5, 8]] }; // old stored ranges
  const { resolved, stale } = resolveSymbolLines(code, '.md', symbolRanges);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, 'Doc > Setup');
  assert.equal(resolved[0].startLine, 3);
  assert.equal(resolved[0].endLine, 6);
  assert.equal(stale.length, 0);
});

test('resolveSymbolLines: markdown renamed heading → stale', () => {
  const code = [
    '# Doc',
    '',
    '## Installation',  // was "Setup" before
    '',
    'Content.',
  ].join('\n');
  const symbolRanges = { 'Doc > Setup': [[3, 5]] };
  const { resolved, stale } = resolveSymbolLines(code, '.md', symbolRanges);
  assert.equal(resolved.length, 0);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].name, 'Doc > Setup');
});

test('activeSymbolsForPath: markdown 31+ headings exercises depth-aware cap', () => {
  // Generate a file with 1 h1, 10 h2, each with 3 h3 → 1 + 10 + 30 = 41 symbols
  const lines = ['# Root'];
  for (let i = 1; i <= 10; i++) {
    lines.push('', `## Section ${i}`);
    for (let j = 1; j <= 3; j++) {
      lines.push('', `### Sub ${i}.${j}`, '', `Content ${i}.${j}.`);
    }
  }
  const code = lines.join('\n');
  const { activeSymbols } = activeSymbolsForPath(code, '.md', [], true);
  assert.ok(activeSymbols);
  // Partial trim: others (depth!=2) = 11, keep = 30-11 = 19 h3 symbols → total 30
  assert.equal(activeSymbols.length, 30);
  assert.ok(activeSymbols.includes('Root'));
  assert.ok(activeSymbols.includes('Root > Section 1'));
  assert.ok(activeSymbols.includes('Root > Section 10'));
  // Partial trim keeps the first 19 h3 in source order
  assert.ok(activeSymbols.includes('Root > Section 1 > Sub 1.1'));
  // The last h3 (Sub 10.3 would be the 30th h3) is trimmed
  assert.ok(!activeSymbols.includes('Root > Section 7 > Sub 7.2'));
});

test('activeSymbolsForPath: tree-sitter path still works after _selectActiveSymbols refactor', () => {
  // Regression: ensure the refactored tree-sitter path produces same results
  const code = [
    'function foo() {', '  return 1;', '}',
    'function bar() {', '  return 2;', '}',
  ].join('\n');
  const lines = [1, 2, 3, 4, 5, 6];
  const result = activeSymbolsForPath(code, '.js', lines, false);
  assert.deepEqual(result.activeSymbols, ['foo', 'bar']);
});

test('activeSymbolsForPath: tree-sitter full snapshot after refactor', () => {
  // Regression: full snapshot path through _selectActiveSymbols for code
  const code = Array.from({ length: 5 }, (_, i) =>
    `function f${i}() {\n  return ${i};\n}\n`
  ).join('\n');
  const result = activeSymbolsForPath(code, '.js', [], true);
  assert.ok(result.activeSymbols);
  assert.equal(result.activeSymbols.length, 5);
  assert.deepEqual(result.activeSymbols, ['f0', 'f1', 'f2', 'f3', 'f4']);
});

// ── Frontmatter 50-line cap test ──

test('extractSymbols: markdown frontmatter unclosed beyond 50 lines → headings after line 50 extracted', () => {
  // Build a file: line 1 is '---', lines 2-60 are filler (no closing ---), line 61 is a heading
  const lines = ['---'];
  for (let i = 2; i <= 60; i++) lines.push(`filler line ${i}`);
  lines.push('# Heading After 50');
  const code = lines.join('\n');
  const syms = extractSymbols(code, '.md');
  // No closing --- within 50 lines → not frontmatter, parse from start
  // The # on line 61 should be extracted
  assert.ok(syms.length >= 1);
  assert.equal(syms[syms.length - 1].name, 'Heading After 50');
  assert.equal(syms[syms.length - 1].startLine, 61);
});

// ── Extension case insensitivity test ──

test('extractSymbols: .MD (uppercase) works same as .md', () => {
  const code = '# Hello\n\nWorld.\n';
  const syms = extractSymbols(code, '.MD');
  assert.deepEqual(syms, [
    { name: 'Hello', startLine: 1, endLine: 3, depth: 0 },
  ]);
});

test('isSupported: .MD (uppercase) returns true', () => {
  assert.equal(isSupported('.MD'), true);
});

test('canExtract: .MD (uppercase) returns true', () => {
  assert.equal(canExtract('.MD'), true);
});

test('extractSymbols: markdown whitespace-only heading is skipped', () => {
  const code = [
    '# Doc',
    '',
    '## \t',      // whitespace-only — should be skipped
    '',
    '## Real',
    '',
    'Content.',
  ].join('\n');
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Doc', startLine: 1, endLine: 7, depth: 0 },
    { name: 'Doc > Real', startLine: 5, endLine: 7, depth: 1 },
  ]);
});

test('extractSymbols: markdown BOM prefix does not break first heading', () => {
  const code = '﻿# Title\n\nContent.\n';
  const syms = extractSymbols(code, '.md');
  assert.deepEqual(syms, [
    { name: 'Title', startLine: 1, endLine: 3, depth: 0 },
  ]);
});
