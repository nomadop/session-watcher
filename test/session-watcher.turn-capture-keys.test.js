// The resource keys a Turn Note capture takes at the shared SessionWatcher: the injected `resourceKeysOf`
// is handed the attribution `recall` bound to the session at capture, a binding that cannot write and has
// no diagnostics exit. The capture is the real `_captureTurns` over a real Dialogue projection and a
// readable Source; the interpreter is a double that does what a consumer of the binding does — keys the
// call from its record when the session holds one, and from the call's input when it holds none.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, ts, userMessage,
} from './helpers/transcript-fixtures.js';

const NOOP_POLICY = { resolve: () => ({ selectedByDefault: true, defaultDiscardReason: null }), infer: () => ({}) };
const NO_RECORD_KEY = '/work/lib/store.js';
const RECORDED_KEY = '/recorded/index.js';

// A record in the shape the interpreter keeps: each effect names the resources it impacted.
const RECORD = {
  v: 1,
  effects: [{ access: 'read', impacts: [{ resourceKey: RECORDED_KEY, kind: 'replace-fragments', entries: [] }] }],
  residual: null,
};

// The no-record key is the call's input under the working tree; a record names its own keys.
const resourceKeysOf = (pair, { recall }) => {
  const record = recall?.(pair.toolUseId) ?? null;
  if (record) return record.effects.flatMap(effect => effect.impacts.map(impact => impact.resourceKey));
  return pair.name === 'Read' ? [`/work/${pair.input.file_path}`] : [];
};

const observations = observationsOf(chain([
  userMessage({ uuid: 'u-1', text: 'read the store', timestamp: ts(1) }),
  assistantToolUse({ uuid: 'a-1', messageId: 'm-1', toolUseId: 'tu-1', name: 'Read',
    input: { file_path: 'lib/store.js' }, timestamp: ts(2) }),
  toolResult({ uuid: 'r-1', toolUseId: 'tu-1', content: 'export const x = 1;' }),
  assistantObservation({ uuid: 'a-2', messageId: 'm-2', timestamp: ts(3),
    blocks: [{ type: 'text', text: 'read it' }] }),
  userMessage({ uuid: 'u-cur', text: 'prepare the handoff', timestamp: ts(4) }),
]));

// The two attribution-adjacent store methods in the real shapes, plus the turn-note pair capture uses. A
// throw happens after the call is logged, so a failed attempt is still visible in `calls`.
function makeStore({ recallThrows = false, recalled = null } = {}) {
  const store = {
    calls: [],
    rows: [],
    recallAttribution(sessionId, toolUseId) {
      store.calls.push({ sessionId, toolUseId });
      if (recallThrows) throw new Error('database is locked');
      return recalled;
    },
    listTurnNotes: () => [],
    upsertTurnNotes(rows) { store.rows.push(...rows); },
  };
  return store;
}

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'sw-capture-keys-')); });
after(() => rmSync(root, { recursive: true, force: true }));

function build({ sessionId = 'sid-a', store = makeStore(), ...over } = {}) {
  return new SessionWatcher({
    sessionId,
    sourceLocator: '/t/a.jsonl',
    projectId: '/work',
    projectRoot: '/work',
    turnNotesRoot: root,
    resourcePolicy: NOOP_POLICY,
    resourceEnrichment: { warm: () => {} },
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store,
    dialogueSource: { read: async () => ({ status: 'ok', observations }) },
    dialogueProjection: createClaudeCodeDialogueProjection(),
    createEngine: () => ({}),
    createMeasurementProjection: () => ({}),
    modelPolicyFor: () => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 1, pricing: {} }),
    now: () => 4242,
    resourceKeysOf,
    ...over,
  });
}

// Fetch the skeleton, fill every slot it asks for, submit: what a producer does. A commit retires the
// epoch directory, so the skeleton's tool row is read before it.
async function captureAndCommit(watcher) {
  const skeleton = await watcher.getTurnSkeleton();
  const toolsRow = readFileSync(skeleton.skeleton_path, 'utf8').match(/^ +\| A×1 · 1 tools.*$/m)?.[0];
  const notes = readFileSync(skeleton.notes_path, 'utf8');
  const slots = [...notes.matchAll(/^## NOTE\[(\d+)\]$/gm)].map(match => match[1]);
  writeFileSync(skeleton.notes_path, slots.map(slot => `## NOTE[${slot}]\n\nbody ${slot}\n`).join('\n'));
  return { skeleton, toolsRow, committed: await watcher.submitTurnNotes({ snapshot_id: skeleton.snapshot_id }) };
}

describe('the recall bound at capture', () => {
  test('a record the session holds supplies the keys, looked up under the current session', async () => {
    const store = makeStore({ recalled: RECORD });
    const { toolsRow } = await captureAndCommit(build({ store }));
    assert.deepEqual(store.calls.map(call => [call.sessionId, call.toolUseId]), [['sid-a', 'tu-1'], ['sid-a', 'tu-1']],
      'once per capture operation, for the one call the epoch holds');
    assert.match(toolsRow, /tools: index\.js$/);
    assert.deepEqual(store.rows.map(row => row.searchTerms), [RECORDED_KEY]);
  });

  test('a recall that throws is a miss: the skeleton resolves and the notes commit with the no-record keys', async () => {
    const store = makeStore({ recallThrows: true });
    const { skeleton, toolsRow, committed } = await captureAndCommit(build({ store }));
    assert.ok(store.calls.length > 0, 'fixture self-proof: the store was asked and refused');
    assert.deepEqual(Object.keys(skeleton).sort(), ['notes_path', 'protocol', 'skeleton_path', 'snapshot_id']);
    assert.match(toolsRow, /tools: store\.js$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(store.rows.map(row => row.searchTerms), [NO_RECORD_KEY]);
  });

  test('a store without recallAttribution is a miss as well', async () => {
    const store = makeStore();
    delete store.recallAttribution;
    const { toolsRow, committed } = await captureAndCommit(build({ store }));
    assert.match(toolsRow, /tools: store\.js$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(store.rows.map(row => row.searchTerms), [NO_RECORD_KEY]);
  });

  test('the binding carries recall alone, and none while the session is unnamed', async () => {
    const seen = [];
    const spy = (pair, context) => { seen.push(context); return []; };
    await build({ resourceKeysOf: spy }).getTurnSkeleton();
    await build({ sessionId: null, resourceKeysOf: spy }).getTurnSkeleton();
    assert.deepEqual(seen.map(context => Object.keys(context)), [['recall'], []]);
    assert.equal(typeof seen[0].recall, 'function');
  });
});

describe('without a resourceKeysOf', () => {
  test('the pairs carry no keys and the store is never asked', async () => {
    const store = makeStore();
    const { toolsRow, committed } = await captureAndCommit(build({ store, resourceKeysOf: undefined }));
    assert.deepEqual(store.calls, []);
    assert.match(toolsRow, /tools$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(store.rows.map(row => row.searchTerms), ['']);
  });

  test('one that is not a function is refused at construction', () => {
    assert.throws(() => build({ resourceKeysOf: 'not-callable' }),
      /session watcher invariant: resourceKeysOf must be a function/);
  });
});
