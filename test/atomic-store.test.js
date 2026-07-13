import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../lib/atomic-store.js';

test('writeJsonAtomic creates dirs, writes valid JSON, leaves no temp file', () => {
  const dir = join(tmpdir(), `atomic-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const p = join(dir, 'nested', 'state.json');
  writeJsonAtomic(p, { a: 1, b: 'x' });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 1, b: 'x' });
  // no leftover unique-tmp sibling (name is `${base}.${pid}.${seq}.tmp`)
  const leftovers = readdirSync(join(dir, 'nested')).filter(f => f.startsWith(basename(p) + '.') && f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'renameSync consumed the temp file');
  rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic overwrite is not partial (rename is atomic)', () => {
  const dir = join(tmpdir(), `atomic2-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const p = join(dir, 's.json');
  writeJsonAtomic(p, { v: 1 });
  writeJsonAtomic(p, { v: 2 });
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).v, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('round-7 gemini#1: a failing write leaves NO orphan .tmp (unlinked in finally)', () => {
  const dir = join(tmpdir(), `atomic3-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const p = join(dir, 's.json');
  // Force writeFileSync to throw AFTER the temp path is chosen: pass a non-serializable value (a BigInt
  // makes JSON.stringify throw) — the throw happens before rename, exercising the finally cleanup.
  assert.throws(() => writeJsonAtomic(p, { bad: 1n }));
  const leftovers = existsSync(join(dir)) ? readdirSync(dir).filter(f => f.endsWith('.tmp')) : [];
  assert.equal(leftovers.length, 0, 'no dangling .tmp after a failed write');
  rmSync(dir, { recursive: true, force: true });
});
