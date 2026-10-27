// scripts/synthesize-working-tree.mjs over authored sessions: the files it derives from the lines a transcript
// shows and writes, and that the matcher, run over the tree it made, places the evidence the transcript showed. Every
// path and line here is authored; no session log is read.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectDialogue } from '../lib/dialogue-fold.js';
import { createResourceAttribution } from '../lib/resource-attribution.js';
import { createMemoryWorkingTree } from '../lib/working-tree.js';
import { pathFlavorOf, readSession, synthesizeWorkingTree } from '../scripts/synthesize-working-tree.mjs';
import { header } from './helpers/dsh-events.js';
import { transcriptBytes } from './helpers/transcript-fixtures.js';
import {
  CC_HOME, LIMITS, ccCallLog, ccReadResultText, dshCallLog, linesText, readResultText, treeOf,
} from './helpers/attribution-fixtures.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'synthesize-working-tree.mjs');

const linesOf = (...names) => names.map(name => `export const ${name} = '${name} value';`);
const A_LINES = linesOf('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta');
const B_LINES = linesOf('bravo', 'brisk', 'brave', 'bright', 'broad', 'brief');
const C_LINES = linesOf('charlie', 'chosen', 'chorus', 'chrome', 'chunky', 'church');
const D_LINES = linesOf('delta', 'dapper', 'dainty');
const E_LINES = linesOf('echo', 'early', 'eager');
const F_LINES = linesOf('foxtrot', 'fabled', 'famous');
const G_LINES = ['first heredoc line', 'second heredoc line'];
const H_LINES = linesOf('hotel', 'hasty', 'happy', 'handy');
const I_LINES = linesOf('india', 'idle', 'ideal', 'ivory');
const J_LINES = linesOf('juliet', 'jolly', 'jaunty');

const dshBytes = (calls, cwd = '/repo') => Buffer.from(
  [header({ cwd }), ...dshCallLog(calls).events].map(event => JSON.stringify(event)).join('\n'),
);

const GREP_RESULT = [
  'Found 2 matches', '', 'src/c.js', `Line 2: ${C_LINES[1]}`, `Line 5: ${C_LINES[4]}`,
].join('\n');

const DSH_CALLS = [
  { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText('/repo/src/a.js', A_LINES) },
  { name: 'read', args: { file_path: 'src/b.js' }, text: readResultText('/repo/src/b.js', B_LINES, { from: 3, to: 4 }) },
  { name: 'grep', args: { pattern: 'ch', path: 'src' }, text: GREP_RESULT },
  { name: 'write', args: { file_path: 'src/d.js', content: linesText(D_LINES) }, text: 'Created file' },
  { name: 'bash', args: { command: 'cat src/e.js' }, text: linesText(E_LINES) },
  { name: 'bash', args: { command: "sed -n '2,3p' src/f.js" }, text: linesText(F_LINES.slice(1)) },
  {
    name: 'bash', args: { command: 'cat -n src/j.js' },
    text: J_LINES.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n'),
  },
  { name: 'bash', args: { command: `cat > src/g.js <<'EOF'\n${G_LINES.join('\n')}\nEOF` }, text: '' },
  { name: 'read', args: { file_path: 'src/h.js' }, text: readResultText('/repo/src/h.js', H_LINES) },
  {
    name: 'edit', args: { file_path: 'src/h.js', old_string: H_LINES[1], new_string: "export const hasty = 'changed';" },
    text: 'The file has been edited',
  },
  { name: 'read', args: { file_path: 'src/i.js' }, text: readResultText('/repo/src/i.js', I_LINES) },
  {
    name: 'edit',
    args: { file_path: 'src/i.js', old_string: `${I_LINES[1]}\n${I_LINES[2]}`, new_string: "export const merged = 'merged';" },
    text: 'The file has been edited',
  },
  { name: 'read', args: { file_path: 'src/missing.js' }, text: 'Error: not found', isError: true },
  { name: 'bash', args: { command: 'git status --short' }, text: ' M src/a.js\n?? notes.txt\n' },
];

// Every call of a session as the pair the lab and the matcher see.
function pairsOf(session) {
  return projectDialogue(session.observations).folds.flatMap(fold => fold.toolPairs);
}

// What the matcher places for one call over a tree: the resource keys it matched, each with the lines it matched.
function matchedBy(files, pair, base, flavor = path.posix) {
  const workingTree = createMemoryWorkingTree({ files, path: flavor, homeDir: null });
  const { attribute } = createResourceAttribution({ workingTree, limits: LIMITS });
  const { matches } = attribute({ base, input: pair.input, output: pair.result });
  return matches.map(match => [match.resourceKey, match.lines.length]).sort();
}

describe('a DSH session', () => {
  const session = readSession(dshBytes(DSH_CALLS));
  const { files, stats } = synthesizeWorkingTree(session);

  test('derives each file from the lines the session showed, wrote and edited', () => {
    assert.deepEqual(files, {
      '/repo/src/a.js': linesText(A_LINES),
      // A partial read names lines 3 and 4 only; the lines before them are empty and nothing follows.
      '/repo/src/b.js': linesText(['', '', B_LINES[2], B_LINES[3]]),
      '/repo/src/c.js': linesText(['', C_LINES[1], '', '', C_LINES[4]]),
      '/repo/src/d.js': linesText(D_LINES),
      '/repo/src/e.js': linesText(E_LINES),
      '/repo/src/f.js': linesText(['', F_LINES[1], F_LINES[2]]),
      '/repo/src/g.js': linesText(G_LINES),
      '/repo/src/j.js': linesText(J_LINES),
      '/repo/src/h.js': linesText([H_LINES[0], "export const hasty = 'changed';", H_LINES[2], H_LINES[3]]),
      // The edit's old text is two lines of the file, so its one new line takes their place and the lines after it
      // move up.
      '/repo/src/i.js': linesText([I_LINES[0], "export const merged = 'merged';", I_LINES[3]]),
    });
  });

  test('adds no file for a failed call or a result of no known format', () => {
    assert.ok(!('/repo/src/missing.js' in files));
    assert.ok(!('/repo/notes.txt' in files));
  });

  test('counts what it derived from, and what it could not place', () => {
    assert.deepEqual(stats, {
      harness: 'dsh', files: 10, lines: stats.lines, pairs: DSH_CALLS.length, contributing: 12,
      formats: { 'dsh read': 4, 'sectioned hits': 1, 'shell show': 2, 'numbered read': 1 },
      skipped: { homeRelative: 0, unresolved: 0, lineBeyondLimit: 0 },
    });
    assert.equal(stats.lines, [A_LINES, B_LINES.slice(2, 4), C_LINES.filter((unused, index) => index === 1 || index === 4),
      D_LINES, E_LINES, F_LINES.slice(1), G_LINES, H_LINES, [I_LINES[0], 'merged', I_LINES[3]], J_LINES].flat().length);
  });

  test('is a tree the matcher places the session\'s own evidence in', () => {
    const [readA, readB, grepC, writeD, catE, sedF, catNumbered, , readH] = pairsOf(session);
    const base = '/repo';
    assert.deepEqual(matchedBy(files, readA, base), [['/repo/src/a.js', A_LINES.length]]);
    assert.deepEqual(matchedBy(files, readB, base), [['/repo/src/b.js', 2]]);
    assert.deepEqual(matchedBy(files, grepC, base), [['/repo/src/c.js', 2]]);
    assert.deepEqual(matchedBy(files, writeD, base), [['/repo/src/d.js', D_LINES.length]]);
    assert.deepEqual(matchedBy(files, catE, base), [['/repo/src/e.js', E_LINES.length]]);
    assert.deepEqual(matchedBy(files, sedF, base), [['/repo/src/f.js', 2]]);
    assert.deepEqual(matchedBy(files, catNumbered, base), [['/repo/src/j.js', J_LINES.length]]);
    // The read of h.js showed a line the edit then replaced: the tree is the file as it ends, so that line is
    // the one the read can no longer place.
    assert.deepEqual(matchedBy(files, readH, base), [['/repo/src/h.js', H_LINES.length - 1]]);
  });

  test('puts the lines of a DSH path under a directory named ~ like any other', () => {
    const calls = [{ name: 'read', args: { file_path: '~/notes.md' }, text: readResultText('/repo/~/notes.md', A_LINES) }];
    assert.deepEqual(Object.keys(synthesizeWorkingTree(readSession(dshBytes(calls))).files), ['/repo/~/notes.md']);
  });
});

describe('a Claude Code session', () => {
  const calls = [
    { name: 'Read', input: { file_path: '/repo/src/a.js' }, content: ccReadResultText(A_LINES), cwd: '/repo' },
    { name: 'Read', input: { file_path: 'src/b.js', offset: 3, limit: 2 }, content: ccReadResultText(B_LINES.slice(2, 4), 3), cwd: '/repo' },
    { name: 'Write', input: { file_path: '/repo/src/d.js', content: linesText(D_LINES) }, content: 'File created', cwd: '/repo' },
    {
      name: 'Grep', input: { pattern: 'ch', output_mode: 'content', '-n': true },
      content: `/repo/src/c.js:2:${C_LINES[1]}\n/repo/src/c.js:5:${C_LINES[4]}`, cwd: '/repo',
    },
    { name: 'Read', input: { file_path: '~/notes.md' }, content: ccReadResultText(E_LINES), cwd: '/repo' },
    { name: 'Edit', input: { file_path: '/repo/src/a.js', old_string: A_LINES[5], new_string: "export const zeta = 'last';" }, content: 'edited', cwd: '/repo' },
  ];
  const session = readSession(transcriptBytes(ccCallLog(calls).entries));
  const { files, stats } = synthesizeWorkingTree(session);

  test('derives each file from the lines the session showed, wrote and edited', () => {
    assert.deepEqual(files, {
      '/repo/src/a.js': linesText([...A_LINES.slice(0, 5), "export const zeta = 'last';"]),
      '/repo/src/b.js': linesText(['', '', B_LINES[2], B_LINES[3]]),
      '/repo/src/c.js': linesText(['', C_LINES[1], '', '', C_LINES[4]]),
      '/repo/src/d.js': linesText(D_LINES),
    });
  });

  test('leaves out a path under the recorder\'s home directory, which names no file here', () => {
    assert.equal(stats.skipped.homeRelative, 1);
    assert.ok(Object.keys(files).every(key => key.startsWith('/repo/')));
  });

  test('is a tree the matcher places the session\'s own evidence in', () => {
    const [readA, readB, , grepC] = pairsOf(session);
    assert.deepEqual(matchedBy(files, readB, '/repo'), [['/repo/src/b.js', 2]]);
    assert.deepEqual(matchedBy(files, grepC, '/repo'), [['/repo/src/c.js', 2]]);
    // The edit replaced the last line the read had shown.
    assert.deepEqual(matchedBy(files, readA, '/repo'), [['/repo/src/a.js', A_LINES.length - 1]]);
  });

  test('keys a Windows session\'s files by its drive path with forward slashes, and reads them back in that namespace', () => {
    const windows = [{
      name: 'Read', input: { file_path: 'C:\\proj\\src\\a.js' }, content: ccReadResultText(A_LINES), cwd: 'C:\\proj',
    }];
    const windowsSession = readSession(transcriptBytes(ccCallLog(windows).entries));
    const tree = synthesizeWorkingTree(windowsSession);
    assert.deepEqual(Object.keys(tree.files), ['C:/proj/src/a.js']);
    assert.equal(pathFlavorOf('C:\\proj'), path.win32);
    assert.equal(pathFlavorOf('/repo'), path.posix);
    assert.equal(pathFlavorOf(null), path.posix);
    assert.deepEqual(matchedBy(tree.files, pairsOf(windowsSession)[0], 'C:\\proj', path.win32), [['C:/proj/src/a.js', A_LINES.length]]);
  });
});

describe('the command line', () => {
  let dir;
  let log;
  let expected;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sw-synth-'));
    log = join(dir, 'session.jsonl');
    writeFileSync(log, dshBytes(DSH_CALLS));
    expected = synthesizeWorkingTree(readSession(readFileSync(log))).files;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('writes the tree as JSON to the file named, creating its directory, and the counts to standard error', () => {
    const out = join(dir, 'nested', 'tree.json');
    const run = spawnSync('node', [SCRIPT, log, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), expected);
    assert.equal(JSON.parse(run.stderr).files, Object.keys(expected).length);
    assert.equal(run.stdout, '');
  });

  test('writes the tree to standard output when no file is named', () => {
    const run = spawnSync('node', [SCRIPT, log], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), expected);
  });

  test('refuses a call that names no log or an option it does not have', () => {
    for (const args of [[], [log, '--tree', 'x'], [log, '--out']]) {
      const run = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
      assert.equal(run.status, 2, JSON.stringify(args));
      assert.match(run.stderr, /usage: node scripts\/synthesize-working-tree\.mjs/);
    }
  });

  test('is read back by a memory tree of the namespace its keys are in', () => {
    const tree = treeOf(expected, CC_HOME);
    assert.equal(tree.readText('/repo/src/a.js'), linesText(A_LINES));
  });
});
