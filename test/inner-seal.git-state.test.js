// The git state item's read (`lib/inner-seal/git-state.js`): the two git commands' real output, read from throwaway repositories made with the same git. The failure cases run a stand-in `git` first on PATH where the real one cannot be made to fail on demand.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GIT_STATE_ITEM, GIT_STATUS_LINE_LIMIT, readGitState } from '../lib/inner-seal/git-state.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sw-git-state-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd, message) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
const write = (cwd, name, text = `${name}\n`) => writeFileSync(join(cwd, name), text);

// A repository on branch `main`; with `committed` files it holds one commit of them.
function repository({ committed = ['a.txt'] } = {}) {
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  if (committed.length === 0) return cwd;
  for (const name of committed) write(cwd, name);
  git(cwd, 'add', '.');
  commit(cwd, 'first commit');
  return cwd;
}
// What the two commands print when run by hand, the status's own lines apart from the log's.
const statusOf = cwd => git(cwd, 'status', '--short', '--branch').trimEnd().split('\n');
const headOf = cwd => git(cwd, 'log', '-1', '--oneline').trimEnd();

test('a clean repository reads as its branch line and its HEAD line, as the commands print them and with no placeholder for the empty status', async () => {
  const cwd = repository();
  const text = await readGitState({ cwd });
  assert.deepEqual(text.split('\n'), ['## main', `${git(cwd, 'rev-parse', '--short', 'HEAD').trim()} first commit`]);
  assert.deepEqual(text.split('\n'), [...statusOf(cwd), headOf(cwd)]);
});

test('changes stand between the branch line and the HEAD line, one line each as `git status --short` prints them', async () => {
  const cwd = repository();
  write(cwd, 'a.txt', 'changed\n');
  write(cwd, 'new.txt');
  const lines = (await readGitState({ cwd })).split('\n');
  assert.deepEqual(lines.slice(0, 3), ['## main', ' M a.txt', '?? new.txt']);
  assert.deepEqual(lines, [...statusOf(cwd), headOf(cwd)]);
});

test('a repository with no commit yet reads as its status alone: the failed log is no failure', async () => {
  const cwd = repository({ committed: [] });
  write(cwd, 'new.txt');
  const lines = (await readGitState({ cwd })).split('\n');
  assert.deepEqual(lines, statusOf(cwd));
  assert.equal(lines.at(-1), '?? new.txt');
});

test('a directory that is no repository reads as nothing, and a failure is not that', async () => {
  assert.equal(await readGitState({ cwd: root }), null);
});

test('a directory that is no repository reads as nothing in the language git is set to speak', async () => {
  const kept = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  Object.assign(process.env, { LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' });
  try {
    assert.equal(await readGitState({ cwd: root }), null);
  } finally {
    for (const [name, value] of Object.entries(kept)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('the read does not rewrite the index: a status that would refresh stale entries is left to the git commands running beside the session, which would find the index locked', async () => {
  const cwd = repository();
  git(cwd, 'status', '--short');
  const index = join(cwd, '.git', 'index');
  const touched = new Date(Date.now() + 60_000);
  utimesSync(join(cwd, 'a.txt'), touched, touched);
  const inode = statSync(index).ino;
  await readGitState({ cwd });
  assert.equal(statSync(index).ino, inode, 'the index is the file it was');
  git(cwd, 'status', '--short');
  assert.notEqual(statSync(index).ino, inode, 'the entries were stale: a status that may take the lock rewrites it');
});

const untracked = (cwd, count) => { for (let at = 0; at < count; at += 1) write(cwd, `f${String(at).padStart(3, '0')}.txt`); };

test('status lines past the limit are cut to the limit with one line saying how many are left, the branch line and the HEAD line kept', async () => {
  const cwd = repository();
  const left = 7;
  untracked(cwd, GIT_STATUS_LINE_LIMIT + left);
  const [branch, ...entries] = statusOf(cwd);
  const lines = (await readGitState({ cwd })).split('\n');
  assert.deepEqual(lines.slice(0, 1 + GIT_STATUS_LINE_LIMIT), [branch, ...entries.slice(0, GIT_STATUS_LINE_LIMIT)]);
  assert.equal(lines.length, 1 + GIT_STATUS_LINE_LIMIT + 1 + 1, 'the notice is one line');
  assert.deepEqual(lines[1 + GIT_STATUS_LINE_LIMIT].match(/\d+/gu), [String(left)], 'the count left is the one number it carries');
  assert.equal(lines.at(-1), headOf(cwd));
});

test('status lines up to the limit are all shown with no notice, the first line past it is the notice\'s', async () => {
  const cwd = repository();
  untracked(cwd, GIT_STATUS_LINE_LIMIT);
  assert.deepEqual((await readGitState({ cwd })).split('\n'), [...statusOf(cwd), headOf(cwd)]);
  untracked(cwd, GIT_STATUS_LINE_LIMIT + 1);
  const lines = (await readGitState({ cwd })).split('\n');
  assert.equal(lines.length, 1 + GIT_STATUS_LINE_LIMIT + 1 + 1);
  assert.deepEqual(lines[1 + GIT_STATUS_LINE_LIMIT].match(/\d+/gu), ['1'], 'one left');
});

// `script` run as the `git` first on PATH while `body` runs: a command the real git cannot be made to get wrong on demand.
async function withGit(script, body) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return await body();
  } finally {
    process.env.PATH = path;
  }
}
// The stand-in drops the leading `-c name=value` pairs the way git takes them as options before the subcommand.
const printing = ({ status = '## main', log = 'abc1234 subject' }) => `while [ "$1" = -c ]; do shift 2; done\ncase "$1" in status) printf '%s\\n' '${status}';; log) printf '%s\\n' '${log}';; esac`;

test('a read that fails is a rejection, not an absent state: a command that does not finish in time, a git that fails for any reason but the directory being no repository, and a directory that cannot be entered', async () => {
  const hanging = Date.now();
  await withGit('exec sleep 30', () => assert.rejects(readGitState({ cwd: root, timeoutMs: 50 }), Error, 'a timeout'));
  assert.ok(Date.now() - hanging < 10_000, 'the hanging command was stopped, not waited for');
  await withGit('echo "fatal: unable to read the index" >&2; exit 128', () => assert.rejects(readGitState({ cwd: root }), Error, 'a failed status'));
  await withGit(`${printing({})}\nif [ "$1" = log ]; then echo "fatal: bad object HEAD" >&2; exit 2; fi`, async () => {
    assert.equal(await readGitState({ cwd: root }), '## main', 'a log that exits non-zero is a repository with no commit yet');
  });
  await withGit('exit 0', () => assert.rejects(readGitState({ cwd: root }), Error, 'a git that prints nothing'));
  await assert.rejects(readGitState({ cwd: join(root, 'missing') }), Error, 'a directory that does not exist');
  for (const cwd of [undefined, '']) await assert.rejects(readGitState({ cwd }), Error, `a working directory of ${JSON.stringify(cwd)} would read the host's own`);
});

test('an output that is not what the two commands print is a rejection: a status with no branch line, a log of more than one line', async () => {
  await withGit(printing({ status: ' M a.txt' }), () => assert.rejects(readGitState({ cwd: root }), Error, 'no branch line'));
  await withGit(printing({ log: 'abc1234 one\nfedcba9 two' }), () => assert.rejects(readGitState({ cwd: root }), Error, 'two HEAD lines'));
  await withGit(printing({}), async () => assert.equal(await readGitState({ cwd: root }), '## main\nabc1234 subject'));
});

test('a signal that aborts stops the read: a read under way rejects at once and one already aborted never starts', async () => {
  const controller = new AbortController();
  const started = Date.now();
  await withGit('exec sleep 30', async () => {
    setTimeout(() => controller.abort(new Error('cancelled')), 50);
    await assert.rejects(readGitState({ cwd: root, signal: controller.signal, timeoutMs: 20_000 }), Error);
  });
  assert.ok(Date.now() - started < 10_000, 'the command was stopped by the signal, not waited for');
  const marker = join(root, 'ran');
  await withGit(`touch '${marker}'\n${printing({})}`, async () => {
    await assert.rejects(readGitState({ cwd: root, signal: AbortSignal.abort() }), Error);
  });
  assert.throws(() => execFileSync('test', ['-e', marker]), 'git was never run');
});

test('the item holds the read text as it is: any text, never empty, compared by equality and shown as it is', () => {
  const text = '## main\n abc1234 subject';
  assert.equal(GIT_STATE_ITEM.normalize(text), text);
  assert.equal(GIT_STATE_ITEM.isEmpty(text), false);
  assert.equal(GIT_STATE_ITEM.same(text, `${text}`), true);
  assert.equal(GIT_STATE_ITEM.same(text, `${text}\n`), false);
  assert.equal(GIT_STATE_ITEM.text(text), text);
  for (const refused of [undefined, null, '', 7, ['## main']]) assert.throws(() => GIT_STATE_ITEM.normalize(refused), Error);
});

test('the repository\'s own config does not get a program run by the read: a `core.fsmonitor` hook is left uncalled', async () => {
  const cwd = repository();
  const marker = join(root, 'fsmonitor-ran');
  const hook = join(root, 'fsmonitor-hook');
  writeFileSync(hook, `#!/bin/sh\n: > '${marker}'\n`);
  chmodSync(hook, 0o755);
  git(cwd, 'config', 'core.fsmonitor', hook);
  assert.deepEqual((await readGitState({ cwd })).split('\n')[0], '## main');
  assert.equal(existsSync(marker), false);
});
