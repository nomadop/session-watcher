// Working Tree port: the shared `resolve` namespace rules, the Node adapter's stat/read/cache behavior and
// the in-memory adapter.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createNodeWorkingTree, createMemoryWorkingTree } from '../lib/working-tree.js';

const BIG = 1_000_000;

function nodeTree(overrides = {}) {
  return createNodeWorkingTree({ path, homeDir: null, cacheEntries: BIG, cacheChars: BIG, ...overrides });
}

describe('resolve', () => {
  test('a home directory string and null put a leading tilde in different namespaces', () => {
    const home = createMemoryWorkingTree({ files: {}, path: path.posix, homeDir: '/home/u' });
    const none = createMemoryWorkingTree({ files: {}, path: path.posix, homeDir: null });
    assert.equal(home.resolve('/repo', '~/a.js'), '/home/u/a.js');
    assert.equal(none.resolve('/repo', '~/a.js'), '/repo/~/a.js');
    assert.equal(home.resolve('/repo', '~'), '/home/u');
    assert.equal(none.resolve('/repo', '~'), '/repo/~');
  });

  test('a relative path without a base is null', () => {
    const tree = createMemoryWorkingTree({ files: {}, path: path.posix, homeDir: null });
    assert.equal(tree.resolve(null, 'src/a.js'), null);
    assert.equal(tree.resolve('', 'src/a.js'), null);
    assert.equal(tree.resolve('/repo', 'src/a.js'), '/repo/src/a.js');
  });

  test('under win32 a backslash spelling resolves to the forward-slash key', () => {
    const tree = createMemoryWorkingTree({ files: {}, path: path.win32, homeDir: null });
    assert.equal(tree.resolve('C:\\repo', 'src\\lib\\auth.js'), 'C:/repo/src/lib/auth.js');
    assert.equal(tree.resolve(null, 'C:\\x\\a.js'), 'C:/x/a.js');
  });

  test('under posix a Windows-spelled relative path names the file its posix spelling names', () => {
    const tree = createMemoryWorkingTree({ files: {}, path: path.posix, homeDir: null });
    assert.equal(tree.resolve('/repo', 'src\\lib\\auth.js'), '/repo/src/lib/auth.js');
    assert.equal(tree.resolve('/repo', 'src\\lib\\..\\auth.js'), '/repo/src/auth.js');
  });
});

describe('Node adapter', () => {
  let dir;
  test.before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'working-tree-'));
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
  });
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('stat answers a file and a directory', () => {
    const tree = nodeTree();
    assert.deepEqual(tree.stat(path.join(dir, 'a.txt')), { size: 5, isFile: true });
    assert.equal(tree.stat(path.join(dir, 'sub')).isFile, false);
  });

  test('readText answers the text of a file', () => {
    assert.equal(nodeTree().readText(path.join(dir, 'a.txt')), 'hello');
  });

  describe('a path that cannot be answered is null from both methods', () => {
    const cases = {
      missing: () => path.join(dir, 'missing.txt'),
      'through a regular file': () => path.join(dir, 'a.txt', 'x'),
      'containing a NUL character': () => `${path.join(dir, 'a.txt')}\u0000x`,
      'with an over-long component': () => path.join(dir, 'x'.repeat(300)),
    };
    for (const [name, pathOf] of Object.entries(cases)) {
      test(name, () => {
        const tree = nodeTree();
        assert.equal(tree.stat(pathOf()), null);
        assert.equal(tree.readText(pathOf()), null);
      });
    }
  });

  test('readText of a directory is null', () => {
    assert.equal(nodeTree().readText(path.join(dir, 'sub')), null);
  });

  test('a file rewritten at the same size with a new mtime reads fresh', () => {
    const file = path.join(dir, 'rewrite.txt');
    const tree = nodeTree();
    writeFileSync(file, 'aaaa');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    assert.equal(tree.readText(file), 'aaaa');
    writeFileSync(file, 'bbbb');
    utimesSync(file, 1_700_000_001, 1_700_000_001);
    assert.equal(tree.readText(file), 'bbbb');
  });

  describe('eviction by one bound alone', () => {
    // A cached entry is revalidated by size and mtime only, so rewriting the file at the same size and the
    // same mtime is invisible to a cached entry: the new text appears only if the entry was evicted.
    function evictsFirstOf(treeOptions) {
      const tree = nodeTree(treeOptions);
      const [first, second, third] = ['e1.txt', 'e2.txt', 'e3.txt'].map(name => path.join(dir, name));
      for (const file of [first, second, third]) writeFileSync(file, 'old!');
      utimesSync(first, 1_700_000_000, 1_700_000_000);
      assert.equal(tree.readText(first), 'old!');
      writeFileSync(first, 'new!');
      utimesSync(first, 1_700_000_000, 1_700_000_000);
      assert.equal(tree.readText(first), 'old!', 'a cached entry is served while size and mtime match');
      assert.equal(tree.readText(second), 'old!');
      assert.equal(tree.readText(third), 'old!');
      return tree.readText(first) === 'new!';
    }

    test('cacheEntries', () => {
      assert.equal(evictsFirstOf({ cacheEntries: 2 }), true);
    });

    test('cacheChars', () => {
      assert.equal(evictsFirstOf({ cacheChars: 8 }), true);
    });

    test('a text over cacheChars by itself is read but not kept', () => {
      const file = path.join(dir, 'over.txt');
      const tree = nodeTree({ cacheChars: 3 });
      writeFileSync(file, 'abcd');
      utimesSync(file, 1_700_000_000, 1_700_000_000);
      assert.equal(tree.readText(file), 'abcd');
      writeFileSync(file, 'wxyz');
      utimesSync(file, 1_700_000_000, 1_700_000_000);
      assert.equal(tree.readText(file), 'wxyz');
    });
  });

  describe('construction', () => {
    for (const name of ['cacheEntries', 'cacheChars']) {
      for (const bad of [undefined, 0, -1, Infinity, NaN, '10', null]) {
        test(`throws for ${name} ${String(bad)}`, () => {
          assert.throws(() => nodeTree({ [name]: bad }), TypeError);
        });
      }
    }

    test('throws without a path or with an undefined homeDir', () => {
      assert.throws(() => createNodeWorkingTree({ homeDir: null, cacheEntries: 1, cacheChars: 1 }), TypeError);
      assert.throws(() => nodeTree({ homeDir: undefined }), TypeError);
    });
  });

  test('nothing returns a promise', () => {
    const tree = nodeTree();
    for (const result of [
      tree.resolve(dir, 'a.txt'),
      tree.stat(path.join(dir, 'a.txt')),
      tree.readText(path.join(dir, 'a.txt')),
      tree.stat(path.join(dir, 'missing')),
    ]) assert.equal(typeof result?.then, 'undefined');
  });
});

describe('memory adapter', () => {
  const tree = createMemoryWorkingTree({
    files: { '/repo/src/a.js': 'héllo', '/repo/b.js': 'b' },
    path: path.posix,
    homeDir: null,
  });

  test('a file answers its byte size and its text', () => {
    assert.deepEqual(tree.stat('/repo/src/a.js'), { size: 6, isFile: true });
    assert.equal(tree.readText('/repo/src/a.js'), 'héllo');
  });

  test('a directory prefix is a directory with no text, an absent path is null', () => {
    assert.equal(tree.stat('/repo/src').isFile, false);
    assert.equal(tree.stat('/repo').isFile, false);
    assert.equal(tree.readText('/repo/src'), null);
    assert.equal(tree.stat('/repo/src/missing.js'), null);
    assert.equal(tree.readText('/repo/src/missing.js'), null);
    assert.equal(tree.stat('/repo/sr'), null);
  });

  test('a file spelled with backslashes is stored under its resolved key', () => {
    const win = createMemoryWorkingTree({ files: { 'C:\\repo\\a.js': 'x' }, path: path.win32, homeDir: null });
    assert.equal(win.readText(win.resolve('C:\\repo', 'a.js')), 'x');
  });

  test('nothing returns a promise', () => {
    for (const result of [tree.resolve('/repo', 'b.js'), tree.stat('/repo/b.js'), tree.readText('/repo/b.js')]) {
      assert.equal(typeof result?.then, 'undefined');
    }
  });

  test('a relative or non-text file entry throws at construction', () => {
    assert.throws(() => createMemoryWorkingTree({ files: { 'a.js': 'x' }, path: path.posix, homeDir: null }), TypeError);
    assert.throws(() => createMemoryWorkingTree({ files: { '/a.js': 1 }, path: path.posix, homeDir: null }), TypeError);
  });
});
