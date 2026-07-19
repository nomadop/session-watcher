import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDefaultDiscard, discardReason } from '../lib/gitignore.js';
import { loadIsIgnored } from '../gitignore-loader.js';

const cwd = '/repo/app';
// isIgnored stub: pretend node_modules/** and dist/** are gitignored.
const isIgnored = (rel) => rel.startsWith('node_modules/') || rel.startsWith('dist/');

test('in-project, not gitignored → not discarded', () => {
  assert.equal(isDefaultDiscard('src/auth.js', isIgnored, cwd, '/repo/app/src/auth.js'), false);
  assert.equal(discardReason('src/auth.js', isIgnored, cwd, '/repo/app/src/auth.js'), null);
});

test('gitignored → discarded with reason gitignore', () => {
  const abs = '/repo/app/node_modules/pkg/index.js';
  assert.equal(isDefaultDiscard('node_modules/pkg/index.js', isIgnored, cwd, abs), true);
  assert.equal(discardReason('node_modules/pkg/index.js', isIgnored, cwd, abs), 'gitignore');
});

test('outside project (path.relative, NOT startsWith) → discarded outside-project', () => {
  // sibling dir that shares a prefix must NOT be treated as inside.
  const abs = '/repo/app2/foo.js';
  assert.equal(isDefaultDiscard(null, isIgnored, cwd, abs), true);
  assert.equal(discardReason(null, isIgnored, cwd, abs), 'outside-project');
});

test('home-dir config outside project → outside-project', () => {
  const abs = '/home/u/.config/claude.json';
  assert.equal(discardReason(null, isIgnored, cwd, abs), 'outside-project');
});

test('no isIgnored (no .gitignore) → in-project paths kept', () => {
  assert.equal(isDefaultDiscard('src/x.js', null, cwd, '/repo/app/src/x.js'), false);
});

// --- Loader integration test (nested .gitignore + POSIX) ---
test('loadIsIgnored: nested .gitignore rules layer correctly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sw-gi-'));
  try {
    // fake git project
    mkdirSync(join(tmp, '.git'));
    writeFileSync(join(tmp, '.gitignore'), 'dist/\n');
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', '.gitignore'), 'local.log\n');

    const cwdSub = join(tmp, 'sub');
    const fn = loadIsIgnored(cwdSub);
    assert.ok(typeof fn === 'function', 'returns a function');

    // root rule reaches down — dist/x.js ignored from sub
    assert.equal(fn('../dist/x.js'), true, 'root .gitignore dist/ rule applies');

    // nested rule — local.log from sub
    assert.equal(fn('local.log'), true, 'sub .gitignore local.log rule applies');

    // non-ignored file — keep.js
    assert.equal(fn('keep.js'), false, 'non-ignored file is kept');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadIsIgnored: returns null when no .gitignore exists', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sw-gi-'));
  try {
    mkdirSync(join(tmp, '.git'));
    // no .gitignore anywhere
    const fn = loadIsIgnored(tmp);
    assert.equal(fn, null, 'null when no ignore rules found');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
