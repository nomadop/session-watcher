// #8: resolveJsonl stats each path once inside a guard; newest wins; never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveJsonl, resolveBySessionId } from '../server.js';

test('resolveJsonl: returns the newest .jsonl by mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-resolve-'));
  const older = join(dir, 'a.jsonl');
  const newer = join(dir, 'b.jsonl');
  writeFileSync(older, 'x');
  writeFileSync(newer, 'y');
  const now = Date.now() / 1000; // deterministic mtimes: older = 1000s ago, newer = now.
  utimesSync(older, now - 1000, now - 1000);
  utimesSync(newer, now, now);
  assert.equal(resolveJsonl(dir), newer);
});

test('resolveJsonl: a plain file target is returned as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-resolve-'));
  const f = join(dir, 's.jsonl');
  writeFileSync(f, 'x');
  assert.equal(resolveJsonl(f), f);
});

test('resolveJsonl: a nonexistent target is returned as-is', () => {
  const missing = join(tmpdir(), 'sw-does-not-exist-' + Date.now(), 'nope.jsonl');
  assert.equal(resolveJsonl(missing), missing);
});

test('resolveJsonl: skips an unstattable (broken-symlink) .jsonl and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-resolve-'));
  const real = join(dir, 'real.jsonl');
  writeFileSync(real, 'x');
  // Broken symlink whose name ends in .jsonl → walk() lists it, statSync() throws on it.
  const broken = join(dir, 'broken.jsonl');
  symlinkSync(join(dir, 'no-such-target'), broken);
  let out;
  assert.doesNotThrow(() => { out = resolveJsonl(dir); });
  assert.equal(out, real, 'newest STATTABLE file wins; the broken symlink is skipped');
});

test('resolveJsonl: recurses into nested project dirs (CC layout)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-resolve-'));
  const nested = join(dir, 'projects', 'encoded-cwd');
  mkdirSync(nested, { recursive: true });
  const f = join(nested, 'session.jsonl');
  writeFileSync(f, 'x');
  assert.equal(resolveJsonl(dir), f);
});

// 1:1 identity binding: the server↔transcript link must key on session_id, not mtime. CC lays
// transcripts at <projectsRoot>/<encoded-cwd>/<sessionId>.jsonl; resolveBySessionId finds the file
// named for the session regardless of CC's cwd-encoding, so a subagent's newer .jsonl can't hijack.
test('resolveBySessionId: finds <sessionId>.jsonl nested under the projects root', () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-byid-'));
  const enc = join(root, '-Users-me-repo');
  mkdirSync(enc, { recursive: true });
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const mine = join(enc, `${sid}.jsonl`);
  writeFileSync(mine, 'x');
  // A newer sibling (a subagent's transcript) must NOT win when we resolve by id.
  const other = join(enc, 'ffffffff-0000-1111-2222-333333333333.jsonl');
  writeFileSync(other, 'y');
  const now = Date.now() / 1000;
  utimesSync(mine, now - 1000, now - 1000); // ours is OLDER — mtime would pick the other
  utimesSync(other, now, now);
  assert.equal(resolveBySessionId(root, sid), mine);
});

test('resolveBySessionId: returns null when no file matches the session id', () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-byid-'));
  const enc = join(root, '-Users-me-repo');
  mkdirSync(enc, { recursive: true });
  writeFileSync(join(enc, 'unrelated.jsonl'), 'x');
  assert.equal(resolveBySessionId(root, 'no-such-session-id'), null);
});

test('resolveBySessionId: null for a falsy/sentinel session id (never guesses)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-byid-'));
  writeFileSync(join(root, 'default.jsonl'), 'x'); // must not be matched by the 'default' sentinel
  assert.equal(resolveBySessionId(root, ''), null);
  assert.equal(resolveBySessionId(root, null), null);
  assert.equal(resolveBySessionId(root, 'default'), null);
});

test('resolveBySessionId: never throws on an unreadable/nonexistent root', () => {
  const missing = join(tmpdir(), 'sw-byid-missing-' + Date.now());
  let out;
  assert.doesNotThrow(() => { out = resolveBySessionId(missing, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'); });
  assert.equal(out, null);
});
