import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLoadToken, redactSecrets, normalizeKeepPath, cjkBigrams, buildFtsMatch, SUFFIX_WORDS, STOP_WORDS } from '../lib/handoff.js';

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('SUFFIX_WORDS has 256 short lowercase entries', () => {
  assert.equal(SUFFIX_WORDS.length, 256);
  assert.ok(SUFFIX_WORDS.every(w => /^[a-z]{3,5}$/.test(w)), 'all 3-5 char lowercase');
  assert.equal(new Set(SUFFIX_WORDS).size, 256, 'no duplicates');
});

test('generateLoadToken: English keywords + suffix', () => {
  const ri = seq(0); // suffix index 0
  const tok = generateLoadToken('whatever', 'Fix the auth middleware token refresh bug', ri);
  const parts = tok.split('-');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'auth');        // first discriminating word (>3, not stop)
  assert.equal(parts[1], 'middleware');
  assert.equal(parts[2], SUFFIX_WORDS[0]);
});

test('generateLoadToken: stop words filtered', () => {
  const tok = generateLoadToken('', 'implement the new challenger baseline horizon', seq(1));
  const parts = tok.split('-');
  // 'implement','the','new' are stop/short → first kept are 'challenger','baseline'
  assert.equal(parts[0], 'challenger');
  assert.equal(parts[1], 'baseline');
});

test('generateLoadToken: pure CJK falls back to random suffix words', () => {
  const tok = generateLoadToken('重构登录流程', '重构登录流程', seq(0, 1, 2));
  const parts = tok.split('-');
  assert.equal(parts.length, 3);
  assert.ok(parts.every(p => SUFFIX_WORDS.includes(p)), 'all parts from suffix list');
});

test('generateLoadToken: all lowercase, hyphen-separated', () => {
  const tok = generateLoadToken('', 'Refactor AUTH Module', seq(5));
  assert.equal(tok, tok.toLowerCase());
  assert.ok(/^[a-z0-9-]+$/.test(tok));
});

test('redactSecrets covers sk-, ghp_, AKIA, PEM', () => {
  assert.match(redactSecrets('key sk-abc123DEF456ghi789jkl here'), /\[REDACTED\]/);
  assert.match(redactSecrets('token ghp_0123456789abcdefABCDEF here'), /\[REDACTED\]/);
  assert.match(redactSecrets('aws AKIAIOSFODNN7EXAMPLE key'), /\[REDACTED\]/);
  assert.match(redactSecrets('-----BEGIN RSA PRIVATE KEY-----'), /\[REDACTED\]/);
  assert.equal(redactSecrets('no secrets here'), 'no secrets here');
});

test('redactSecrets covers github_pat_, JWT/Bearer, Slack, .env', () => {
  assert.match(redactSecrets('pat github_pat_ABC123DEF456GHI789JKL0 end'), /\[REDACTED\]/);
  assert.match(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123'), /\[REDACTED\]/);
  assert.match(redactSecrets('token xoxb-123456789012-123456789012-AbCdEfGhIjKl here'), /\[REDACTED\]/);
  assert.match(redactSecrets('DB_PASSWORD=supersecret123'), /\[REDACTED\]/);
});

test('normalizeKeepPath: separators, leading slash, .. rejection', () => {
  assert.deepEqual(normalizeKeepPath('src\\auth\\mw.js'), { path: 'src/auth/mw.js', invalid: false });
  // Absolute without projectDir → external
  assert.deepEqual(normalizeKeepPath('/src/app.js'), { path: '/src/app.js', invalid: false, external: true });
  // R1-G: posix.normalize('src/../../etc/passwd') → '../etc/passwd'; starts with '..' → invalid
  assert.deepEqual(normalizeKeepPath('src/../../etc/passwd'), { path: '../etc/passwd', invalid: true });
  assert.equal(normalizeKeepPath('./a/../b.js').path, 'b.js');
});

test('normalizeKeepPath: projectDir relativizes in-project absolute paths', () => {
  assert.deepEqual(normalizeKeepPath('/workspace/lib/store.js', '/workspace'), { path: 'lib/store.js', invalid: false });
  assert.deepEqual(normalizeKeepPath('/workspace', '/workspace'), { path: '.', invalid: false });
  // Outside project → external
  assert.deepEqual(normalizeKeepPath('/home/user/.claude/settings.json', '/workspace'),
    { path: '/home/user/.claude/settings.json', invalid: false, external: true });
  // Relative path unaffected by projectDir
  assert.deepEqual(normalizeKeepPath('lib/foo.js', '/workspace'), { path: 'lib/foo.js', invalid: false });
});

test('cjkBigrams: contiguous CJK run → bigrams; ASCII → empty', () => {
  assert.equal(cjkBigrams('重构登录流程'), '重构 构登 登录 录流 流程');
  assert.equal(cjkBigrams('refactor auth'), '');
  // R1-G: '登录' is TWO CJK chars → one bigram '登录', not '' (the space splits the run from 'flow')
  assert.equal(cjkBigrams('登录 flow'), '登录');
});

test('buildFtsMatch: plain mode escapes and ANDs; never throws', () => {
  const m = buildFtsMatch('auth middleware', 'plain');
  assert.match(m, /"auth"/);
  assert.match(m, /"middleware"/);
  // malformed input must not throw
  assert.doesNotThrow(() => buildFtsMatch('bare OR "unclosed', 'plain'));
});

test('buildFtsMatch: advanced mode passes raw', () => {
  assert.equal(buildFtsMatch('auth OR session', 'advanced'), 'auth OR session');
});
