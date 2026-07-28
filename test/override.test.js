// test/override.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferOverride } from '../lib/override.js';

test('inferOverride: no siblings → null', () => {
  const userOverrides = new Map();
  const bRebuildKeys = ['src/a.js'];
  const discardFn = () => null; // all default-included
  assert.equal(inferOverride('src/a.js', bRebuildKeys, userOverrides, discardFn), null);
});

test('inferOverride: all siblings excluded, new file default-included → exclude', () => {
  const userOverrides = new Map([['src/b.js', 'exclude'], ['src/c.js', 'exclude']]);
  const bRebuildKeys = ['src/b.js', 'src/c.js', 'src/new.js'];
  const discardFn = () => null; // all default-included
  assert.equal(inferOverride('src/new.js', bRebuildKeys, userOverrides, discardFn), 'exclude');
});

test('inferOverride: all siblings included (via override), new file default-excluded → include', () => {
  const userOverrides = new Map([['dist/a.js', 'include'], ['dist/b.js', 'include']]);
  const bRebuildKeys = ['dist/a.js', 'dist/b.js', 'dist/new.js'];
  const discardFn = (rel) => rel.startsWith('dist/') ? 'gitignore' : null;
  assert.equal(inferOverride('dist/new.js', bRebuildKeys, userOverrides, discardFn), 'include');
});

test('inferOverride: mixed sibling states → null', () => {
  const userOverrides = new Map([['src/b.js', 'exclude']]);
  const bRebuildKeys = ['src/b.js', 'src/c.js', 'src/new.js'];
  const discardFn = () => null;
  assert.equal(inferOverride('src/new.js', bRebuildKeys, userOverrides, discardFn), null);
});

test('inferOverride: siblings unanimous but same as default → null', () => {
  // All siblings default-included, no overrides → effective state = include = same as new file default
  const userOverrides = new Map();
  const bRebuildKeys = ['src/a.js', 'src/b.js', 'src/new.js'];
  const discardFn = () => null; // all default-included
  assert.equal(inferOverride('src/new.js', bRebuildKeys, userOverrides, discardFn), null);
});

test('inferOverride: new path has no parent dir (root-level) → null', () => {
  const userOverrides = new Map([['other/a.js', 'exclude']]);
  const bRebuildKeys = ['README.md', 'other/a.js'];
  const discardFn = () => null;
  assert.equal(inferOverride('README.md', bRebuildKeys, userOverrides, discardFn), null);
});

test('inferOverride: project-root file (absolute path, direct child of cwd) → null (C12)', () => {
  const userOverrides = new Map([['/workspace/CLAUDE.md', 'exclude'], ['/workspace/package.json', 'exclude']]);
  const bRebuildKeys = ['/workspace/CLAUDE.md', '/workspace/package.json', '/workspace/newfile.txt'];
  const discardFn = () => null;
  // Without C12 fix, siblings in /workspace/ would infer 'exclude'. With fix, returns null.
  assert.equal(inferOverride('/workspace/newfile.txt', bRebuildKeys, userOverrides, discardFn, '/workspace'), null);
});

test('inferOverride: nested dir still infers normally with projectRoot set', () => {
  const userOverrides = new Map([['/workspace/src/a.js', 'exclude'], ['/workspace/src/b.js', 'exclude']]);
  const bRebuildKeys = ['/workspace/src/a.js', '/workspace/src/b.js', '/workspace/src/c.js'];
  const discardFn = () => null;
  assert.equal(inferOverride('/workspace/src/c.js', bRebuildKeys, userOverrides, discardFn, '/workspace'), 'exclude');
});
