// The held-set projection (`lib/held-view.js`) over the DSH Measurement Projection, the factory a harness hands it. The
// interpreter and the tree are assembled as `composeWatcher` assembles them: the tool-evidence interpreter over the
// DSH profile and a matcher reading an editable working tree. Observations come from `reduceDshSnapshot`, as the
// composition reduces a raw event slice.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHeldView } from '../lib/held-view.js';
import { ATTRIBUTION_LIMITS, DEFAULT_CACHE_TTL } from '../lib/constants.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { createResourceAttribution } from '../lib/resource-attribution.js';
import { createToolEvidenceInterpreter } from '../lib/tool-evidence.js';
import { createDshMeasurementProjection } from '../lib/harness/dsh/measurement-projection.js';
import { dshToolEvidenceProfile } from '../lib/harness/dsh/tool-evidence-profile.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { CWD, dshCallLog, editableTree, readResultText } from './helpers/attribution-fixtures.js';
import {
  assistantMessage, compactCheckpoint, prunedResult, sessionLog, stepEnd, stepStart, toolResult, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';

const A = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;', 'export const delta = 4;', 'export const epsilon = 5;'];
const B = ['const one = "first";', 'const two = "second";', 'const three = "third";'];
const C = ['export const first = 1;', 'export const second = 2;'];
const A_PATH = '/repo/src/a.js';
const B_PATH = '/repo/src/b.js';
const C_PATH = '/repo/src/c.js';
const textOf = lines => `${lines.join('\n')}\n`;
const FILES = { [A_PATH]: textOf(A), [B_PATH]: textOf(B), [C_PATH]: textOf(C) };

// A read of lines 2 to 4 of a.js, a `cat` of b.js, a write of c.js and the first read of a.js again, unchanged.
const READ_A = { name: 'read', args: { file_path: 'src/a.js', offset: 2, limit: 3 }, text: readResultText(A_PATH, A, { from: 2, to: 4 }) };
const CALLS = [
  READ_A,
  { name: 'bash', args: { command: 'cat src/b.js' }, text: textOf(B) },
  { name: 'write', args: { file_path: 'src/c.js', content: textOf(C) }, text: 'Wrote 2 lines to src/c.js' },
  READ_A,
];

// The held view over `files`, answering a raw event slice: the factory and interpreter the composition builds, and
// `frameCtx` as the composition hands it.
function heldViewOver(files = FILES, frameCtx = {}) {
  const tree = editableTree(files);
  const attribution = createResourceAttribution({ workingTree: tree.workingTree, limits: ATTRIBUTION_LIMITS });
  const interpreter = createToolEvidenceInterpreter({ attribution, profile: dshToolEvidenceProfile, limits: ATTRIBUTION_LIMITS });
  const resolveModelPolicy = modelId => modelPolicyFor(modelId, DEFAULT_CACHE_TTL);
  const view = createHeldView({
    createProjection: ({ completeToolResult }) => createDshMeasurementProjection({
      cwd: CWD, projectRoot: CWD, resolveModelPolicy, interpretToolUse: interpreter.interpretToolUse, completeToolResult,
    }),
    completeToolResult: interpreter.completeToolResult,
    resolveModelPolicy,
    frameCtx,
  });
  return events => view(reduceDshSnapshot(events).observations);
}

const USAGE = { inputTokens: 3, outputTokens: 40, cacheWriteTokens: 9600 };
const skillCall = (step, callId, name, turn = 1) => assistantMessage({ turn, step, usage: USAGE, toolCalls: [{ id: callId, name: 'skill', arguments: JSON.stringify({ name }) }] });
const skillResult = (step, callId, text, isError = false, turn = 1) => toolResult({ turn, step, callId, text, isError });

// The tool result of a step: the event whose seq an effect of the step's call belongs to.
const resultOf = (events, step) => events.find(event => event.type === 'tool/result' && event.data.step === step);
const effectOf = (event, kind, key) => ({ seq: event.seq, kind, key });

describe('the held lines and skills', () => {
  test('the paths are the files the Engine holds, by line key, and no skill key is one of them', () => {
    const view = heldViewOver();
    const { events } = dshCallLog(CALLS.slice(0, 2));
    assert.deepEqual(view(events).paths, new Map([[A_PATH, [2, 3, 4]], [B_PATH, [1, 2, 3]]]));
    const loading = sessionLog([
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD body'), stepEnd({ step: 1 }), turnEnd(),
    ]);
    assert.deepEqual(view(loading).paths, new Map());
  });

  test('a pass shares no state with the next: the same observations answer the same view again', () => {
    const view = heldViewOver();
    const { events } = dshCallLog(CALLS);
    assert.deepEqual(view(events), view(events));
  });
});

// ── Skills ───────────────────────────────────────────────────────────────────

describe('the held skills', () => {
  test('a skill\'s text is the one its latest successful load answered', () => {
    const events = sessionLog([
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD v1'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'tdd'), skillResult(2, 'c2', 'TDD v2'), stepEnd({ step: 2 }),
      stepStart({ step: 3 }), skillCall(3, 'c3', 'grill'), skillResult(3, 'c3', 'Grill body'), stepEnd({ step: 3 }),
      stepStart({ step: 4 }), skillCall(4, 'c4', 'tdd'), skillResult(4, 'c4', 'tdd failed', true), stepEnd({ step: 4 }),
      turnEnd(),
    ]);
    assert.deepEqual(heldViewOver()(events).skills, new Map([['tdd', 'TDD v2'], ['grill', 'Grill body']]));
  });

  test('an epoch boundary leaves only the skills loaded after it', () => {
    const before = [
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD v1'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'grill'), skillResult(2, 'c2', 'Grill body'), stepEnd({ step: 2 }),
      turnEnd(),
    ];
    const view = heldViewOver();
    assert.deepEqual(view(sessionLog(before)).skills, new Map([['tdd', 'TDD v1'], ['grill', 'Grill body']]));
    const events = sessionLog([
      ...before,
      compactCheckpoint({ startSeq: before[1].seq, endSeq: before.at(-2).seq }),
      turnStart({ turn: 2 }), userMessage({ text: 'Go on.' }),
      stepStart({ turn: 2, step: 1 }), skillCall(1, 'c9', 'domain', 2), skillResult(1, 'c9', 'Domain body', false, 2),
      stepEnd({ turn: 2, step: 1 }), turnEnd({ turn: 2 }),
    ]);
    assert.deepEqual(view(events).skills, new Map([['domain', 'Domain body']]));
  });

  test('a skill\'s text is the result behind its effect: a result held until its call arrives counts, a call the interpreter gave no effect loads no text', () => {
    const events = sessionLog([
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillResult(1, 'c1', 'Domain body'), skillCall(1, 'c1', 'domain'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'unread'), skillResult(2, 'c2', 'never loaded', true), stepEnd({ step: 2 }),
      turnEnd(),
    ]);
    assert.deepEqual(heldViewOver()(events).skills, new Map([['domain', 'Domain body']]));
  });
});

// ── The effects ──────────────────────────────────────────────────────────────

describe('the effects, one for each resource a call touched', () => {
  test('each belongs to the result that completes its call, a read, a write and an unchanged re-read alike, and no call message has one', () => {
    const { events } = dshCallLog(CALLS);
    const { effects } = heldViewOver()(events);
    assert.deepEqual(effects, [
      effectOf(resultOf(events, 1), 'path', A_PATH),
      effectOf(resultOf(events, 2), 'path', B_PATH),
      effectOf(resultOf(events, 3), 'path', C_PATH),
      effectOf(resultOf(events, 4), 'path', A_PATH),
    ]);
    const calls = new Set(events.filter(event => event.type === 'assistant/message').map(event => event.seq));
    assert.ok(effects.every(({ seq }) => !calls.has(seq)), 'no effect belongs to a call\'s own message');
  });

  test('a result the pruner replaced belongs to its original\'s seq: the replacement\'s own seq has none', () => {
    const { events } = dshCallLog(CALLS);
    const original = resultOf(events, 2);
    const replacement = prunedResult(original, { text: 'pruned' });
    const at = events.indexOf(original) + 1;
    const log = sessionLog([...events.slice(0, at), replacement, ...events.slice(at)]);
    assert.equal(log[at].surfaceOp.startSeq, original.seq, 'the replacement stands for the original');
    const { effects } = heldViewOver()(log);
    assert.deepEqual(effects.filter(({ key }) => key === B_PATH), [{ seq: original.seq, kind: 'path', key: B_PATH }]);
    assert.ok(effects.every(({ seq }) => seq !== log[at].seq));
  });

  test('each successful skill load has one, the key without its prefix, a repeated load included, and a failed load has none', () => {
    const events = sessionLog([
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD body'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'grill'), skillResult(2, 'c2', 'Grill body'), stepEnd({ step: 2 }),
      stepStart({ step: 3 }), skillCall(3, 'c3', 'tdd'), skillResult(3, 'c3', 'TDD again'), stepEnd({ step: 3 }),
      stepStart({ step: 4 }), skillCall(4, 'c4', 'domain'), skillResult(4, 'c4', 'no such skill', true), stepEnd({ step: 4 }),
      turnEnd(),
    ]);
    assert.deepEqual(heldViewOver()(events).effects, [
      effectOf(resultOf(events, 1), 'skill', 'tdd'),
      effectOf(resultOf(events, 2), 'skill', 'grill'),
      effectOf(resultOf(events, 3), 'skill', 'tdd'),
    ]);
  });
});
