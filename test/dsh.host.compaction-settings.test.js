// The host's inner child hands the user's compaction settings to the two consumers that read them: the seal, which prices its quote under the policy and reaches the backup model after a content filter, and the plain-subagent inheritance. Mounted through `applyHost` over a fake context and real detached `Session`s of the checkout `SW_DSH_CHECKOUT` names, the settings a mutable object `readSettings` answers. The seal's quote is also priced under the pair the host reads from the session's epoch model. Without the checkout every case skips.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { INNER_QUOTE } from '../dsh/src/inner-quote.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE } from '../dsh/src/inner-seal.js';
import { MODE_RECORD_TYPE } from '../dsh/src/inner-mode.js';
import { closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { assistantMessage, requestHeader, stepEnd, stepStart, systemMessage, turnEnd, turnStart, userMessage } from './helpers/dsh-events.js';
import { createFakeContext, fakeFs, fakeTokenMeter } from './helpers/dsh-fake-context.js';
import { fakeAgents, newSession } from './helpers/dsh-mode-kit.js';

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
const BACKUP = { provider: 'backup-provider', model: 'backup-model' };
const STEP_USAGE = { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 };

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-host-settings-'));
  _resetRateLampManagerForTest();
});
afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const settled = () => new Promise(resolve => setImmediate(resolve));

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

// A session in mode on whose first turn holds the minimum counted steps of replies long enough that the quote is on the right arm under any policy; `modelOf(step)` names the model of a step's request and reply, the default model where it answers undefined.
function sessionAtMinimum(id, modelOf = () => undefined) {
  const session = newSession(id, { header: { cwd: '/repo' } });
  sessionPackage.appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const events = [systemMessage(), turnStart(), userMessage({ text: 'please work' })];
  for (let step = 1; step <= INNER_QUOTE.minSteps; step += 1) {
    events.push(stepStart({ step }));
    if (step === 1 || modelOf(step) !== modelOf(step - 1)) events.push(requestHeader({ model: modelOf(step) }));
    events.push(assistantMessage({ text: `reply 1.${step} ${'z'.repeat(40_000)}`, step, model: modelOf(step), usage: STEP_USAGE }), stepEnd({ step }));
  }
  events.push(turnEnd());
  for (const event of events) session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: event.surfaceOp }]));
  return session;
}

const projections = () => ({
  register: async definition => ({
    stateOf: session => session.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()),
  }),
  snapshot: () => ({ asOfSeq: 0, values: {} }),
});

// The summary streams `script(call)` answers: a content-filtered cut for a call number in `filteredCalls`, else one note per slot the tail names; `calls` keeps each request's route.
function llmScripted({ filteredCalls = [] } = {}) {
  const calls = [];
  return {
    calls,
    async resolveModelInfo(provider, id) { return { provider, id, name: id }; },
    listConfigurableProviders: () => [],
    async* stream(options) {
      calls.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });
      if (filteredCalls.includes(calls.length)) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider stopped with: content_filtered' } } };
        return;
      }
      const count = Number(/slot numbers "1" to "(\d+)"/.exec(options.messages.at(-1).content[0].text)[1]);
      const text = JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), `summary ${index + 1}`])));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

// The host over `sessions` and a settings object it reads at each use, the real `applyHost` and the real child that registers the seal and the inheritance.
async function hostOver(t, sessions, settings, llm) {
  t.mock.method(console, 'error', () => {});
  const ctx = createFakeContext({
    sessions,
    readSession: async id => ({ session: sessions.find(session => session.id === id).header, inheritedEventCount: 0, events: sessions.find(session => session.id === id).snapshotEvents() }),
    llm, tokenMeter: fakeTokenMeter(), fs: fakeFs(), agents: fakeAgents(), attachments: {}, sessionProjections: projections(),
  });
  applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR, innerKit: innerKit(), readSettings: () => settings,
  });
  await settled();
  t.after(() => { ctx.dispose(); });
  const preStep = (session) => ctx.emit('agent/pre-step', { agent: { id: session.id, session }, messages: [], turn: 2, step: 1, signal: new AbortController().signal, modelSelection: SELECTION }, async () => ({ kind: 'enter', messages: [] }));
  return { ctx, preStep };
}

test('the seal the host builds prices its quote under the policy the settings name when the pre-step runs: two sessions, two policies, and the attempt record of each keeps its own', { skip }, async (t) => {
  const settings = { preset: 'W2', fallbackModel: null, inheritInSubagents: false };
  const first = sessionAtMinimum('s-w2');
  const second = sessionAtMinimum('s-x3');
  const { preStep } = await hostOver(t, [first, second], settings, llmScripted());

  await preStep(first);
  settings.preset = 'X3';
  await preStep(second);

  const presetOf = session => session.snapshotEvents().find(event => event.type === INNER_ATTEMPT_RECORD_TYPE).data.quote.preset;
  assert.equal(presetOf(first), 'W2');
  assert.equal(presetOf(second), 'X3');
});

test('the seal the host builds reaches the backup model the settings name after the session\'s own model was filtered on both requests, and no model at all where they name none', { skip }, async (t) => {
  const named = sessionAtMinimum('s-backup');
  const withBackup = llmScripted({ filteredCalls: [1, 2] });
  const { preStep } = await hostOver(t, [named], { preset: 'M2', fallbackModel: BACKUP, inheritInSubagents: false }, withBackup);
  await preStep(named);
  assert.deepEqual(withBackup.calls, [
    { ...SELECTION, reasoningEffort: undefined }, { ...SELECTION, reasoningEffort: undefined }, { ...BACKUP, reasoningEffort: undefined },
  ]);
  assert.deepEqual(named.snapshotEvents().filter(event => event.type === INNER_CALL_RECORD_TYPE).map(event => event.data.selection), [SELECTION, SELECTION, BACKUP]);

  const bare = sessionAtMinimum('s-no-backup');
  const withoutBackup = llmScripted({ filteredCalls: [1, 2, 3] });
  const { preStep: failing } = await hostOver(t, [bare], { preset: 'M2', fallbackModel: null, inheritInSubagents: false }, withoutBackup);
  await assert.rejects(failing(bare), /content_filtered/);
  assert.equal(withoutBackup.calls.length, 2, 'the ladder ends on the session\'s own model');
});

test('the inheritance the host builds follows the settings as each child is created: a plain subagent gets its parent\'s mode record while they ask for it and none once they do not', { skip }, async (t) => {
  const settings = { preset: 'M2', fallbackModel: null, inheritInSubagents: true };
  const parent = newSession('p-host');
  sessionPackage.appendPluginRecord(parent, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const asked = newSession('child-asked', { header: { origin: 'subagent', parentSession: parent.id } });
  const unasked = newSession('child-unasked', { header: { origin: 'subagent', parentSession: parent.id } });
  const { ctx } = await hostOver(t, [parent, asked, unasked], settings, llmScripted());

  await ctx.emit('agent/created', { agent: { session: asked }, source: 'startup' });
  settings.inheritInSubagents = false;
  await ctx.emit('agent/created', { agent: { session: unasked }, source: 'startup' });

  const recordsOf = session => session.snapshotEvents().filter(event => event.type === MODE_RECORD_TYPE).map(event => event.data);
  assert.deepEqual(recordsOf(asked), [{ v: 1, enabled: true }]);
  assert.deepEqual(recordsOf(unasked), []);
});

test('the seal the host builds prices its quote under the pair of the session\'s epoch model, not the model of its latest request', { skip }, async (t) => {
  const settings = { preset: 'W2', fallbackModel: null, inheritInSubagents: false };
  const FIRST = 'claude-sonnet-4-6';
  const LATER = 'deepseek-v4-pro';
  const sessions = {
    claude: sessionAtMinimum('s-claude', () => FIRST),
    deepseek: sessionAtMinimum('s-deepseek', () => LATER),
    switched: sessionAtMinimum('s-switched', step => (step < INNER_QUOTE.minSteps ? FIRST : LATER)),
  };
  const { preStep } = await hostOver(t, Object.values(sessions), settings, llmScripted());
  for (const session of Object.values(sessions)) await preStep(session);

  const lAOf = session => session.snapshotEvents().find(event => event.type === INNER_ATTEMPT_RECORD_TYPE).data.quote.lA;
  assert.notEqual(lAOf(sessions.claude), lAOf(sessions.deepseek), 'the two models are quoted apart');
  assert.equal(lAOf(sessions.switched), lAOf(sessions.claude), 'a switch to the other model\'s request leaves the quote under the epoch model\'s pair');
});
