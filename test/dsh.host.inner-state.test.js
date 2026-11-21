// The host's inner child hands its seal the state read: `readState(session)`, the DSH adapter over `child.sessionProjections.snapshot(session, ['todos', 'subagentCatalog'])` and the `agents`, `workingDirectory` and `jobs` services, and `readGit(session, signal)`, the git state of the session's working directory, mounted through `applyHost` over a fake context and a real detached `Session` of the checkout `SW_DSH_CHECKOUT` names, driven by a pre-step the seal answers. Without the checkout every case skips.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { INNER_QUOTE } from '../lib/inner-seal/quote.js';
import { MODE_RECORD_TYPE } from '../dsh/src/inner-mode.js';
import { INNER_SEAL_KIND, renderCarrier } from '../lib/inner-seal/carrier.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';
import { closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { assistantMessage, requestHeader, stepEnd, stepStart, systemMessage, turnEnd, turnStart, userMessage } from './helpers/dsh-events.js';
import { createFakeContext, fakeFs, fakeTokenMeter } from './helpers/dsh-fake-context.js';
import { DEFAULT_SETTINGS, fakeAgents, newSession } from './helpers/dsh-mode-kit.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const LIBS = {
  session: 'packages/core/session/lib/index.js',
  llm: 'packages/llm/llm/lib/index.js',
  compaction: 'packages/compaction/compaction/lib/index.js',
};
const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : Object.values(LIBS).find(path => !existsSync(join(CHECKOUT, path)))?.replace(/^/, 'SW_DSH_CHECKOUT names no ') ?? false;
const [sessionPackage, llmPackage, compactionPackage] = skip ? [] : await Promise.all(Object.values(LIBS).map(path => import(pathToFileURL(join(CHECKOUT, path)).href)));

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const SELECTION = { provider: 'deepseek', model: 'deepseek-v4-pro' };
const TODOS = [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }];
const STATE_TOOLS = CARRIER_TABLE.stateItems.filter(({ tool }) => tool !== undefined).map(({ tool }) => ({ name: tool, description: `The ${tool} tool.`, parameters: { type: 'object', properties: {} } }));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-host-state-'));
  _resetRateLampManagerForTest();
});
afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const settled = () => new Promise(resolve => setImmediate(resolve));

// The kit the host's inner child hands its seal: the `dsh-session`, `dsh-llm` and `dsh-compaction` values of the checkout.
const innerKit = () => ({
  appendPluginRecord: sessionPackage.appendPluginRecord,
  pluginRecordOf: sessionPackage.pluginRecordOf,
  AssistantStreamAccumulator: llmPackage.AssistantStreamAccumulator,
  BlockAssembler: llmPackage.BlockAssembler,
  assembleAssistantStream: llmPackage.assembleAssistantStream,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
  errorChain: llmPackage.errorChain,
  createUserMessage: llmPackage.createUserMessage,
  toolPairingBalancedBefore: compactionPackage.toolPairingBalancedBefore,
  toolPairingBalancedAfter: compactionPackage.toolPairingBalancedAfter,
});

// A session in mode on whose first turn holds the minimum counted steps of replies long enough that their quote passes.
function sessionAtMinimum(id, listed = STATE_TOOLS) {
  const session = newSession(id, { header: { cwd: '/repo' } });
  sessionPackage.appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const events = [systemMessage(), turnStart(), userMessage({ text: 'please work' })];
  for (let step = 1; step <= INNER_QUOTE.minSteps; step += 1) {
    events.push(stepStart({ step }));
    if (step === 1) events.push(listed.length === 0 ? requestHeader() : { ...requestHeader(), data: { ...requestHeader().data, header: { ...requestHeader().data.header, tools: listed } } });
    events.push(assistantMessage({ text: `reply 1.${step} ${'z'.repeat(40_000)}`, step }), stepEnd({ step }));
  }
  events.push(turnEnd());
  for (const event of events) session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: event.surfaceOp }]));
  return session;
}

// An `sessionProjections` service whose `snapshot` answers `answer(session, keys)` and records each call; like the real method it works only when called on the service, and it registers each unit as a handle folding the session's log under it.
function projectionsAnswering(answer) {
  const calls = [];
  const projections = {
    calls,
    register: async definition => ({
      stateOf: session => session.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()),
    }),
    snapshot(session, keys) {
      if (this !== projections) throw new TypeError('snapshot called without its service');
      calls.push([session, keys]);
      return answer(session, keys);
    },
  };
  return projections;
}

// A summary stream that answers one summary per slot the tail message names, its usage under the diagnostic's alert.
const llmSummarizing = () => ({
  async resolveModelInfo(provider, id) { return { provider, id, name: id }; },
  listConfigurableProviders: () => [],
  async* stream(options) {
    const count = Number(/slot numbers "1" to "(\d+)"/.exec(options.messages.at(-1).content[0].text)[1]);
    const text = JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), `summary ${index + 1}`])));
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
});

// The host over `session`, its seal run once at the pre-step of the next turn: answers the projections service, the events the seal appended and the stderr lines it wrote.
// `services` are the services the host's context holds besides the ones the inner child needs; `agents` answers `get(id)` as the service does; `signal` is the pre-step's, and a `cancelled` reason says the seal ends the turn as that cancel.
async function sealThroughHost(t, session, answer, { services = {}, agents = fakeAgents(), signal = new AbortController().signal, cancelled } = {}) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.map(String).join(' ')); });
  const projections = projectionsAnswering(answer);
  const ctx = createFakeContext({
    sessions: [session], readSession: async () => ({ session: session.header, inheritedEventCount: 0, events: session.snapshotEvents() }),
    llm: llmSummarizing(), tokenMeter: fakeTokenMeter(), fs: fakeFs(), agents, attachments: {}, sessionProjections: projections, ...services,
  });
  applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR, innerKit: innerKit(), readSettings: () => DEFAULT_SETTINGS,
  });
  await settled();
  const before = session.seq;
  const decision = { kind: 'enter', messages: [] };
  const payload = { agent: { id: session.id, session }, messages: [], turn: 2, step: 1, signal, modelSelection: SELECTION };
  // The epoch model listener answers beside the seal, each with the decision `next()` answered.
  if (cancelled === undefined) assert.deepEqual(await ctx.emit('agent/pre-step', payload, async () => decision), [decision, decision]);
  else await assert.rejects(ctx.emit('agent/pre-step', payload, async () => decision), cancelled);
  ctx.dispose();
  return { projections, appended: session.snapshotEvents().slice(before), lines };
}

const carrierOf = appended => appended.find(event => event.type === 'user/message');

// The services the state items read, each answering as the real method does, on the service alone.
const workingDirectoryAt = (path) => {
  const service = {
    get(session) {
      if (this !== service) throw new TypeError('get called without its service');
      return session === undefined ? '' : path;
    },
  };
  return service;
};
const jobsListing = rows => {
  const calls = [];
  const jobs = {
    calls,
    list(caller) {
      if (this !== jobs) throw new TypeError('list called without its service');
      calls.push(caller);
      return rows;
    },
  };
  return jobs;
};
// An `agents` service whose `get(id)` answers an agent with the status `statuses` gives the id, undefined for an id it names none.
function agentsWith(statuses) {
  const agents = fakeAgents();
  agents.get = function get(id) {
    if (this !== agents) throw new TypeError('get called without its service');
    return statuses[id] === undefined ? undefined : { status: statuses[id] };
  };
  return agents;
}
const CATALOG = [
  { id: 'child-run', createdAt: 1, mode: 'continuable', label: 'review the parser' },
  { id: 'child-idle', createdAt: 2, mode: 'continuable', label: 'idle one' },
  { id: 'child-shot', createdAt: 3, mode: 'one-shot', label: 'a one-shot' },
  { id: 'child-ext', createdAt: 4, mode: 'external', label: 'an external one' },
  { id: 'child-unknown', createdAt: 5, mode: 'unknown' },
  { id: 'child-gone', createdAt: 6, mode: 'continuable', label: 'not loaded' },
  { id: 'child-run-2', createdAt: 7, mode: 'continuable', label: 'port the tests' },
];
const STATUSES = { 'child-run': 'running', 'child-idle': 'idle', 'child-shot': 'running', 'child-ext': 'running', 'child-unknown': 'running', 'child-run-2': 'running' };
const JOB_ROWS = [
  { id: 'bash-1', kind: 'bash', label: 'npm run watch', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } },
  { id: 'bash-2', kind: 'bash', label: 'npm test', status: 'completed', startedAt: 2, output: { total: 0, earliest: 0 } },
  { id: 'bash-3', kind: 'bash', label: 'server', status: 'stopping', startedAt: 3, output: { total: 0, earliest: 0 } },
  { id: 'bash-4', kind: 'bash', label: 'old build', status: 'killed', startedAt: 4, output: { total: 0, earliest: 0 } },
  { id: 'bash-5', kind: 'bash', label: 'flaky', status: 'failed', startedAt: 5, output: { total: 0, earliest: 0 } },
];
const everything = () => ({ asOfSeq: 77, values: { todos: TODOS, subagentCatalog: CATALOG } });
// The working directory is a real directory that is no repository: the git state is read in it.
const allServices = () => ({ workingDirectory: workingDirectoryAt(dir), jobs: jobsListing(JOB_ROWS) });

test('the seal the host builds reads the state through one snapshot of the todos and the subagent catalog and the three services: the carrier shows the working directory, the continuable children whose agent is running with their labels, the running and stopping jobs with theirs and the todo list, under the cut of that snapshot', { skip }, async (t) => {
  const session = sessionAtMinimum('s-host-state-all');
  const services = allServices();
  const { projections, appended, lines } = await sealThroughHost(t, session, everything, { services, agents: agentsWith(STATUSES) });

  const carrier = carrierOf(appended);
  assert.equal(carrier?.data.source.kind, INNER_SEAL_KIND, 'the seal committed');
  assert.deepEqual(carrier.data.source.state, {
    asOfSeq: 77,
    items: {
      workingDirectory: { value: dir },
      subagents: { value: [{ id: 'child-run', label: 'review the parser' }, { id: 'child-run-2', label: 'port the tests' }] },
      jobs: { value: [{ id: 'bash-1', label: 'npm run watch' }, { id: 'bash-3', label: 'server' }] },
      todos: { value: TODOS },
    },
  });
  assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE));
  assert.deepEqual(lines.filter(line => line.includes('inner_')), [], lines.join('\n'));
  assert.equal(projections.calls.length, 1, 'one cut for the seal');
  const [[read, keys]] = projections.calls;
  assert.equal(read, session, 'the session whose carrier it is');
  assert.deepEqual([...keys].sort(), ['subagentCatalog', 'todos'], 'the two units of one snapshot');
  assert.deepEqual(services.jobs.calls, [session.id], 'the jobs of the session');
});

test('an item whose service or unit the host does not hold is unavailable and nothing is reported: no jobs service, no working directory service, a todo unit or a catalog unit that is not registered, and a todo list that is null and was never shown', { skip }, async (t) => {
  const rows = [
    ['no jobs service', { workingDirectory: workingDirectoryAt(dir) }, everything, ['workingDirectory', 'subagents', 'todos']],
    ['no working directory service', { jobs: jobsListing(JOB_ROWS) }, everything, ['subagents', 'jobs', 'todos']],
    ['no todo unit', allServices(), () => ({ asOfSeq: 5, values: { subagentCatalog: CATALOG } }), ['workingDirectory', 'subagents', 'jobs']],
    ['no catalog unit', allServices(), () => ({ asOfSeq: 5, values: { todos: TODOS } }), ['workingDirectory', 'jobs', 'todos']],
    ['a null todo list', allServices(), () => ({ asOfSeq: 5, values: { todos: null, subagentCatalog: CATALOG } }), ['workingDirectory', 'subagents', 'jobs']],
    ['no unit and no service', {}, () => ({ asOfSeq: 5, values: {} }), []],
  ];
  for (const [why, services, answer, shown] of rows) {
    const session = sessionAtMinimum(`s-host-state-${why.replace(/\W+/gu, '-')}`);
    const { appended, lines } = await sealThroughHost(t, session, answer, { services, agents: agentsWith(STATUSES) });
    const carrier = carrierOf(appended);
    assert.equal(carrier?.data.source.kind, INNER_SEAL_KIND, `${why}: the seal committed`);
    assert.deepEqual(Object.keys(carrier.data.source.state?.items ?? {}), shown, why);
    assert.deepEqual(lines.filter(line => line.includes('inner_')), [], `${why}: ${lines.join('\n')}`);
  }
});

test('a state item whose tool the session does not list is not read: no service call and no line for it, a session that lists none of them shows no state', { skip }, async (t) => {
  const session = sessionAtMinimum('s-host-state-unlisted', []);
  const services = allServices();
  const { appended, lines } = await sealThroughHost(t, session, everything, { services, agents: agentsWith(STATUSES) });

  assert.equal(Object.hasOwn(carrierOf(appended).data.source, 'state'), false);
  assert.deepEqual(services.jobs.calls, []);
  assert.deepEqual(lines.filter(line => line.includes('inner_')), []);
});

test('a snapshot that throws fails the state as a whole: one line, no state on the source, and the carrier stands', { skip }, async (t) => {
  const session = sessionAtMinimum('s-host-state-snapshot-throws');
  const { appended, lines } = await sealThroughHost(t, session, () => { throw new Error('the projections could not be read'); }, { services: allServices(), agents: agentsWith(STATUSES) });

  const carrier = carrierOf(appended);
  assert.equal(carrier?.data.source.kind, INNER_SEAL_KIND, 'the seal committed');
  assert.equal(Object.hasOwn(carrier.data.source, 'state'), false);
  assert.deepEqual(lines.filter(line => line.includes('inner_')), [
    `${session.id} [dsh-host] inner_state_failed: the projections could not be read`,
  ]);
});

test('a service read that throws fails its item alone: one line naming it, the other items shown and the carrier standing', { skip }, async (t) => {
  const session = sessionAtMinimum('s-host-state-service-throws');
  const services = {
    workingDirectory: { get() { throw new Error('the directory could not be read'); } },
    jobs: { list() { throw new Error('the jobs could not be listed'); } },
  };
  const { appended, lines } = await sealThroughHost(t, session, everything, { services, agents: agentsWith(STATUSES) });

  assert.deepEqual(Object.keys(carrierOf(appended).data.source.state.items), ['subagents', 'todos']);
  assert.deepEqual(lines.filter(line => line.includes('inner_')), [
    `${session.id} [dsh-host] inner_state_failed: workingDirectory: the directory could not be read`,
    `${session.id} [dsh-host] inner_state_failed: jobs: the jobs could not be listed`,
    `${session.id} [dsh-host] inner_state_failed: git: the directory could not be read`,
  ], 'the git state reads in the same directory, so it fails with it');
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const gitText = cwd => `${git(cwd, 'status', '--short', '--branch').trimEnd()}\n${git(cwd, 'log', '-1', '--oneline').trimEnd()}`;

test('the seal the host builds reads the git state in the session\'s working directory and carries it as the last item: the two commands\' output of a real repository, the other items as they were', { skip }, async (t) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first commit');
  writeFileSync(join(repo, 'new.txt'), 'new\n');
  const session = sessionAtMinimum('s-host-state-git');
  const services = { ...allServices(), workingDirectory: workingDirectoryAt(repo) };
  const { appended, lines } = await sealThroughHost(t, session, everything, { services, agents: agentsWith(STATUSES) });

  const carrier = carrierOf(appended);
  assert.equal(carrier?.data.source.kind, INNER_SEAL_KIND, 'the seal committed');
  assert.deepEqual(Object.keys(carrier.data.source.state.items), ['workingDirectory', 'subagents', 'jobs', 'todos', 'git']);
  assert.deepEqual(carrier.data.source.state.items.git, { value: gitText(repo) });
  assert.match(carrier.data.source.state.items.git.value, /^## main\n\?\? new\.txt\n[0-9a-f]+ first commit$/u);
  assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE));
  assert.deepEqual(lines.filter(line => line.includes('inner_')), [], lines.join('\n'));
});

test('a git state that cannot be read costs the item and one line, never the seal: a working directory that does not exist', { skip }, async (t) => {
  const session = sessionAtMinimum('s-host-state-git-fails');
  const services = { ...allServices(), workingDirectory: workingDirectoryAt(join(dir, 'missing')) };
  const { appended, lines } = await sealThroughHost(t, session, everything, { services, agents: agentsWith(STATUSES) });

  const carrier = carrierOf(appended);
  assert.equal(carrier?.data.source.kind, INNER_SEAL_KIND, 'the seal committed');
  assert.deepEqual(Object.keys(carrier.data.source.state.items), ['workingDirectory', 'subagents', 'jobs', 'todos']);
  const reported = lines.filter(line => line.includes('inner_'));
  assert.equal(reported.length, 1, lines.join('\n'));
  assert.ok(reported[0].startsWith(`${session.id} [dsh-host] inner_state_failed: git: `), reported[0]);
});

test('the git read hears the pre-step\'s signal: a cancel met as the working directory is read ends the turn as that cancel with git never started', { skip }, async (t) => {
  const bin = join(dir, 'bin');
  const marker = join(dir, 'git-ran');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const controller = new AbortController();
  const cancelled = new Error('the user cancelled');
  const workingDirectory = { get() { controller.abort(cancelled); return dir; } };
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const session = sessionAtMinimum('s-host-state-git-cancel');
    await sealThroughHost(t, session, everything, { services: { ...allServices(), workingDirectory }, agents: agentsWith(STATUSES), signal: controller.signal, cancelled });
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(marker), false, 'git was never started');
});
