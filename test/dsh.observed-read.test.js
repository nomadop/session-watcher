// The observed read: `readObserved` states the file's version through the host's `fs` before it reads the Working Tree, then records the observation DSH's guard needs for a later `edit`. The unit cases run over a recording `fs`, `emit` and tree; the cases at the end run it over the real `fs-local` and `fs-observation-policy` and the real `edit` tool of the checkout `SW_DSH_CHECKOUT` names, and skip without it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readObserved, readUnobserved } from '../dsh/src/observed-read.js';
import { createMemoryWorkingTree, createNodeWorkingTree } from '../lib/working-tree.js';

const FILE_BYTES = 1000;
const KEY = '/repo/a.txt';
const MAPPED = '/mnt/repo/a.txt';
const PROCESS_PATH = '/mnt/real/a.txt';
const RANGES = [{ offset: 2, limit: 2 }];

// A `fs` that records its calls in `log`, in the shapes of the real service; like the real methods each works only when called on it. `mapping` answers `processPathFromHostPath`, `version` the version `stat` states now, and `failing` names the method that rejects.
function recordingFs({ log, mapping = () => MAPPED, version = () => 'v1', failing = null, absent = false }) {
  const onService = (receiver, name) => {
    if (receiver !== fs) throw new TypeError(`${name} called without its service`);
  };
  const fs = {
    processPathFromHostPath(hostPath) {
      onService(this, 'processPathFromHostPath');
      log.push(['fs.processPathFromHostPath', hostPath]);
      return mapping(hostPath);
    },
    async resolve(path, opts) {
      onService(this, 'resolve');
      log.push(['fs.resolve', path, opts]);
      if (failing === 'resolve') throw new Error('resolve failed');
      return { targetKey: PROCESS_PATH, displayPath: path };
    },
    async stat(target, signal) {
      onService(this, 'stat');
      log.push(['fs.stat', target, signal]);
      if (failing === 'stat') throw new Error('stat failed');
      return absent ? undefined : { version: version(), type: 'file', size: 10 };
    },
    processPath(target) {
      onService(this, 'processPath');
      return String(target.targetKey);
    },
  };
  return fs;
}

// A memory tree holding `a.txt` that records the tree calls in `log`; `onRead` runs before the text is read.
function recordingTree({ log, files = { [KEY]: 'one\ntwo\nthree\nfour\n' }, onRead = () => {} }) {
  const tree = createMemoryWorkingTree({ files, path: nodePath.posix, homeDir: null });
  return {
    ...tree,
    stat: (key) => { log.push(['tree.stat', key]); return tree.stat(key); },
    readText: (key) => { onRead(); log.push(['tree.readText', key]); return tree.readText(key); },
  };
}

function setup({ fsOptions = {}, treeOptions = {}, signal = new AbortController().signal } = {}) {
  const log = [];
  const emitted = [];
  const agent = { name: 'the agent' };
  const emit = (...args) => { log.push(['emit', args[0]]); emitted.push(args); };
  const fs = recordingFs({ log, ...fsOptions });
  const tree = recordingTree({ log, ...treeOptions });
  const run = (overrides = {}) => readObserved({
    fs, emit, agent, tree, key: KEY, ranges: RANGES, fileBytes: FILE_BYTES, signal, ...overrides,
  });
  return { log, emitted, agent, fs, tree, signal, run };
}

const TWO_LINES = {
  status: 'readable', totalLines: 4, windows: [{ offset: 2, lines: [{ number: 2, text: 'two' }, { number: 3, text: 'three' }] }],
};

describe('a readable file', () => {
  test('emits one present observation of the version, with the agent as actor, and answers the read and the path the read tool would print', async () => {
    const { emitted, agent, run } = setup();
    const answer = await run();

    assert.deepEqual(answer, { read: TWO_LINES, displayPath: PROCESS_PATH });
    assert.equal(emitted.length, 1);
    const [name, target, observation, actor] = emitted[0];
    assert.equal(name, 'fs/observed');
    assert.deepEqual(target, { targetKey: PROCESS_PATH, displayPath: MAPPED });
    assert.deepEqual(observation, { kind: 'present', version: 'v1' });
    assert.deepEqual(Object.keys(actor), ['agent']);
    assert.equal(actor.agent, agent);
  });

  test('the displayed path is the process path of the resolved target, neither the key nor the mapped path', async () => {
    const { run } = setup();
    const { displayPath } = await run();
    assert.equal(displayPath, PROCESS_PATH);
    assert.notEqual(displayPath, KEY);
    assert.notEqual(displayPath, MAPPED);
  });

  test('the key is mapped, resolved and stated with the signal, all before the tree is read, and the observation follows the read', async () => {
    const { log, signal, run } = setup();
    await run();
    assert.deepEqual(log.map(([call]) => call), ['fs.processPathFromHostPath', 'fs.resolve', 'fs.stat', 'tree.stat', 'tree.readText', 'emit']);
    assert.deepEqual(log[0], ['fs.processPathFromHostPath', KEY]);
    assert.deepEqual(log[1], ['fs.resolve', MAPPED, { signal }]);
    assert.equal(log[2][2], signal);
  });

  test('a file rewritten between the stat and the tree read is observed at the version before the rewrite', async () => {
    let version = 'v1';
    const { emitted, run } = setup({ fsOptions: { version: () => version }, treeOptions: { onRead: () => { version = 'v2'; } } });
    await run();
    assert.deepEqual(emitted.map(args => args[2]), [{ kind: 'present', version: 'v1' }]);
  });
});

describe('an unobserved read', () => {
  test('answers the read and the path the observed read answers, mapping and resolving the key with the signal, and states no version and records nothing', async () => {
    const { log, fs, tree, signal, run } = setup();
    const observed = await run();
    log.length = 0;
    const answer = await readUnobserved({ fs, tree, key: KEY, ranges: RANGES, fileBytes: FILE_BYTES, signal });

    assert.deepEqual(answer, observed);
    assert.deepEqual(log.map(([call]) => call), ['fs.processPathFromHostPath', 'fs.resolve', 'tree.stat', 'tree.readText'], 'no stat, no emit');
    assert.deepEqual(log[1], ['fs.resolve', MAPPED, { signal }]);
  });

  test('a key the backend does not map and a resolve that throws read the tree by the key, displayed as the key', async () => {
    for (const fsOptions of [{ mapping: () => undefined }, { failing: 'resolve' }]) {
      const { fs, tree, signal } = setup({ fsOptions });
      assert.deepEqual(await readUnobserved({ fs, tree, key: KEY, ranges: RANGES, fileBytes: FILE_BYTES, signal }), { read: TWO_LINES, displayPath: KEY });
    }
  });
});

describe('a read that records no observation', () => {
  const cases = [
    ['a path the backend does not map', { mapping: () => undefined }, { displayPath: KEY, resolves: false }],
    ['a resolve that throws', { failing: 'resolve' }, { displayPath: KEY }],
    ['a stat that throws', { failing: 'stat' }, { displayPath: PROCESS_PATH }],
    ['a stat that finds nothing', { absent: true }, { displayPath: PROCESS_PATH }],
  ];
  for (const [title, fsOptions, { displayPath, resolves = true }] of cases) {
    test(`${title} emits nothing and still returns the read`, async () => {
      const { log, emitted, run } = setup({ fsOptions });
      assert.deepEqual(await run(), { read: TWO_LINES, displayPath });
      assert.deepEqual(emitted, []);
      assert.equal(log.some(([call]) => call === 'fs.resolve'), resolves);
    });
  }

  test('an unreadable file emits nothing and returns why it could not be read', async () => {
    for (const [files, key, reason] of [
      [{ [KEY]: 'a\u0000b\n' }, KEY, 'binary'],
      [{ [KEY]: 'one\n' }, '/repo/missing.txt', 'missing'],
    ]) {
      const { emitted, run } = setup({ treeOptions: { files } });
      assert.deepEqual((await run({ key })).read, { status: 'unreadable', reason });
      assert.deepEqual(emitted, [], reason);
    }
  });
});

// --- Over the real guard ---

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

// The real packages, mounted as `test/dsh.load.integration.test.js` mounts them: `fs-local` rooted at `cwd`, the testkit's dependencies with the real working directory, the token meter, the loop harness, the observation policy and the `edit` tool, and one agent. No request is ever made, so the adapter is a stub.
async function mountGuard(t, cwd) {
  const [{ Context }, testkit, fsLocal, observation, toolFs, tokenMeter, llm, session] = await Promise.all([
    CORDIS,
    'packages/test-support/agent-loop-testkit/lib/index.js',
    'packages/fs/fs-local/lib/index.js',
    'packages/fs/fs-observation-policy/lib/index.js',
    'packages/fs/tool-fs/lib/index.js',
    'packages/llm/token-meter/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/core/session/lib/index.js',
  ].map(fromCheckout));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(fsLocal.default, { cwd });
  await testkit.mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(tokenMeter.default);
  class StubAdapter extends llm.LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  }
  ctx.llm.registerAdapter(['mock'], new StubAdapter());
  const harness = await testkit.mountAgentLoopTestHarness(ctx);
  await ctx.plugin(observation);
  await ctx.plugin(toolFs);
  const agent = await harness.create(session.SessionId(`observed-${Math.random().toString(16).slice(2)}`), { provider: 'mock', model: 'opt-model' }, { cwd });
  return { ctx, agent };
}

async function edit({ ctx, agent }, file, from, to) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: `edit-${Math.random()}`, name: 'edit', arguments: JSON.stringify({ file_path: file, old_string: from, new_string: to }) }],
    signal: new AbortController().signal, agent,
  });
  return batch.results[0].result;
}

function guardFixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sw-observed-read-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const files = { read: join(cwd, 'read.txt'), unread: join(cwd, 'unread.txt') };
  writeFileSync(files.read, 'one\ntwo\nthree\nfour\n');
  writeFileSync(files.unread, 'one\ntwo\nthree\nfour\n');
  const tree = createNodeWorkingTree({ path: nodePath, homeDir: null, cacheEntries: 16, cacheChars: 1_000_000 });
  return { cwd, files, tree };
}

describe('over the real guard', () => {
  test('an edit after the read is accepted, and an edit of a file nobody read is not observed', { skip }, async (t) => {
    const { cwd, files, tree } = guardFixture(t);
    const guard = await mountGuard(t, cwd);
    const { ctx, agent } = guard;

    const answer = await readObserved({
      fs: ctx.fs, emit: (...args) => ctx.emit(...args), agent, tree, key: files.read, ranges: RANGES, fileBytes: FILE_BYTES,
      signal: new AbortController().signal,
    });
    assert.equal(answer.read.status, 'readable');
    assert.equal(answer.displayPath, files.read);

    const edited = await edit(guard, files.read, 'two\n', 'TWO\n');
    assert.equal(edited.isError, false, JSON.stringify(edited));
    assert.equal(readFileSync(files.read, 'utf8'), 'one\nTWO\nthree\nfour\n');

    const refused = await edit(guard, files.unread, 'two\n', 'TWO\n');
    assert.equal(refused.isError, true);
    assert.equal(refused.error.info?.code, 'FS_NOT_OBSERVED', JSON.stringify(refused.error));
  });

  test('a file rewritten between the stat and the tree read makes the edit fail as stale', { skip }, async (t) => {
    const { cwd, files, tree } = guardFixture(t);
    const guard = await mountGuard(t, cwd);
    const { ctx, agent } = guard;
    const rewriting = { ...tree, readText: (key) => { writeFileSync(key, 'one\ntwo\nthree\nfour\nfive, appended meanwhile\n'); return tree.readText(key); } };

    const answer = await readObserved({
      fs: ctx.fs, emit: (...args) => ctx.emit(...args), agent, tree: rewriting, key: files.read, ranges: RANGES, fileBytes: FILE_BYTES,
      signal: new AbortController().signal,
    });
    assert.equal(answer.read.status, 'readable');

    const refused = await edit(guard, files.read, 'two\n', 'TWO\n');
    assert.equal(refused.isError, true);
    assert.equal(refused.error.info?.code, 'FS_STALE_VERSION', JSON.stringify(refused.error));
    assert.equal(readFileSync(files.read, 'utf8'), 'one\ntwo\nthree\nfour\nfive, appended meanwhile\n');
  });
});
