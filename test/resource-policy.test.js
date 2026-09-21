// Shared Resource Policy: project containment, ignore selection, Skill defaults, and sibling inference,
// as one pure value. Everything the Engine's default selection and the application's inference decide is
// decided here, so the two can never disagree about the same resource key.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createResourcePolicy } from '../lib/resource-policy.js';
import { loadIsIgnored } from '../gitignore-loader.js';

const PROJECT = '/repo/app';
// Only node_modules/ and dist/ are ignored, so a discard reason is a property of the key rather than of
// the injected matcher's mood.
const isIgnored = (rel) => rel.startsWith('node_modules/') || rel.startsWith('dist/');
const policy = () => createResourcePolicy({ projectRoot: PROJECT, isIgnored });

describe('resolve', () => {
  test('an in-project, non-ignored file is selected with no discard reason', () => {
    assert.deepEqual(policy().resolve('/repo/app/src/auth.js'), { selectedByDefault: true, defaultDiscardReason: null });
  });

  test('an ignored file is not selected and names gitignore', () => {
    assert.deepEqual(policy().resolve('/repo/app/node_modules/pkg/index.js'),
      { selectedByDefault: false, defaultDiscardReason: 'gitignore' });
  });

  test('containment is a relative-path test, so a prefix-sharing sibling directory is outside the project', () => {
    assert.deepEqual(policy().resolve('/repo/app2/foo.js'),
      { selectedByDefault: false, defaultDiscardReason: 'outside-project' });
  });

  test('a home-directory config outside the project is outside-project', () => {
    assert.equal(policy().resolve('/home/u/.config/claude.json').defaultDiscardReason, 'outside-project');
  });

  test('with no ignore matcher every in-project file is kept', () => {
    const open = createResourcePolicy({ projectRoot: PROJECT, isIgnored: null });
    assert.equal(open.resolve('/repo/app/node_modules/pkg/index.js').defaultDiscardReason, null);
  });

  test('with no project root a key is judged by the ignore matcher alone', () => {
    const rootless = createResourcePolicy({ projectRoot: null, isIgnored: (rel) => rel.includes('dist/') });
    assert.equal(rootless.resolve('/anywhere/src/a.js').defaultDiscardReason, null);
    assert.equal(rootless.resolve('/anywhere/dist/a.js').defaultDiscardReason, 'gitignore');
  });

  test('a Skill resource is always selected, wherever the project root sits', () => {
    assert.deepEqual(policy().resolve('skill:brainstorming'), { selectedByDefault: true, defaultDiscardReason: null });
    const outside = createResourcePolicy({ projectRoot: '/elsewhere', isIgnored: () => true });
    assert.deepEqual(outside.resolve('skill:sw-handoff'), { selectedByDefault: true, defaultDiscardReason: null });
  });
});

describe('infer', () => {
  const infer = (input) => policy().infer(input);

  test('a key with no sibling in the snapshot infers nothing', () => {
    assert.deepEqual(infer({ newResourceKeys: ['/repo/app/src/a.js'], resourceKeys: ['/repo/app/src/a.js'], overrides: {} }), {});
  });

  test('unanimously excluded siblings pull a default-included newcomer to exclude', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/src/new.js'],
      resourceKeys: ['/repo/app/src/b.js', '/repo/app/src/c.js', '/repo/app/src/new.js'],
      overrides: { '/repo/app/src/b.js': 'exclude', '/repo/app/src/c.js': 'exclude' },
    }), { '/repo/app/src/new.js': 'exclude' });
  });

  test('unanimously included siblings pull a default-excluded newcomer to include', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/dist/new.js'],
      resourceKeys: ['/repo/app/dist/a.js', '/repo/app/dist/b.js', '/repo/app/dist/new.js'],
      overrides: { '/repo/app/dist/a.js': 'include', '/repo/app/dist/b.js': 'include' },
    }), { '/repo/app/dist/new.js': 'include' });
  });

  test('mixed sibling state infers nothing', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/src/new.js'],
      resourceKeys: ['/repo/app/src/b.js', '/repo/app/src/c.js', '/repo/app/src/new.js'],
      overrides: { '/repo/app/src/b.js': 'exclude' },
    }), {});
  });

  test('a unanimous state that matches the newcomer\'s own default infers nothing', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/src/new.js'],
      resourceKeys: ['/repo/app/src/a.js', '/repo/app/src/b.js', '/repo/app/src/new.js'],
      overrides: {},
    }), {});
  });

  test('a key with no parent directory infers nothing', () => {
    const rootless = createResourcePolicy({ projectRoot: null, isIgnored: null });
    assert.deepEqual(rootless.infer({
      newResourceKeys: ['README.md'],
      resourceKeys: ['README.md', 'other/a.js'],
      overrides: { 'other/a.js': 'exclude' },
    }), {});
  });

  test('a direct child of the project root is too heterogeneous to infer from', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/newfile.txt'],
      resourceKeys: ['/repo/app/CLAUDE.md', '/repo/app/package.json', '/repo/app/newfile.txt'],
      overrides: { '/repo/app/CLAUDE.md': 'exclude', '/repo/app/package.json': 'exclude' },
    }), {});
  });

  test('a nested directory still infers with a project root set', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/src/c.js'],
      resourceKeys: ['/repo/app/src/a.js', '/repo/app/src/b.js', '/repo/app/src/c.js'],
      overrides: { '/repo/app/src/a.js': 'exclude', '/repo/app/src/b.js': 'exclude' },
    }), { '/repo/app/src/c.js': 'exclude' });
  });

  test('a Skill resource is never inferred about', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['skill:brainstorming'],
      resourceKeys: ['skill:other', 'skill:brainstorming'],
      overrides: { 'skill:other': 'exclude' },
    }), {});
  });

  test('one batch\'s earlier inference is visible to its later keys', () => {
    // Two newcomers in one flush: the first is pulled to exclude by unanimous siblings, and the second
    // sees that decision rather than the pre-flush state.
    const result = infer({
      newResourceKeys: ['/repo/app/src/one.js', '/repo/app/lib/two.js'],
      resourceKeys: ['/repo/app/src/a.js', '/repo/app/src/one.js', '/repo/app/lib/two.js', '/repo/app/lib/three.js'],
      overrides: { '/repo/app/src/a.js': 'exclude', '/repo/app/lib/three.js': 'exclude' },
    });
    assert.deepEqual(result, { '/repo/app/src/one.js': 'exclude', '/repo/app/lib/two.js': 'exclude' });
  });

  test('inference never rewrites a key that already carries an override', () => {
    assert.deepEqual(infer({
      newResourceKeys: ['/repo/app/src/new.js'],
      resourceKeys: ['/repo/app/src/b.js', '/repo/app/src/new.js'],
      overrides: { '/repo/app/src/b.js': 'exclude', '/repo/app/src/new.js': 'include' },
    }), {});
  });
});

// The .gitignore matcher itself lives outside lib/ and is injected, so its own layering stays pinned here.
describe('injected ignore matcher', () => {
  test('nested .gitignore rules layer correctly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sw-rp-'));
    try {
      mkdirSync(join(tmp, '.git'));
      writeFileSync(join(tmp, '.gitignore'), 'dist/\n');
      mkdirSync(join(tmp, 'sub'));
      writeFileSync(join(tmp, 'sub', '.gitignore'), 'local.log\n');
      const fn = loadIsIgnored(join(tmp, 'sub'));
      assert.equal(typeof fn, 'function');
      assert.equal(fn('../dist/x.js'), true);
      assert.equal(fn('local.log'), true);
      assert.equal(fn('keep.js'), false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('no .gitignore anywhere yields no matcher', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sw-rp-'));
    try {
      mkdirSync(join(tmp, '.git'));
      assert.equal(loadIsIgnored(tmp), null);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
