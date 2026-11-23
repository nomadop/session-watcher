// The held-set projection (`lib/held-view.js`) over the DSH Measurement Projection, the factory a harness hands it. The
// interpreter and the tree are assembled as `composeWatcher` assembles them: the tool-evidence interpreter over the
// DSH profile and a matcher reading an editable working tree. Observations come from `heldObservationsOf`, as the
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
import { heldObservationsOf } from '../lib/harness/dsh/transcript-observation.js';
import { fingerprintOf, normalizeLine } from '../lib/line-align.js';
import { CWD, dshCallLog, editableTree, readResultText } from './helpers/attribution-fixtures.js';
import {
  assistantMessage, compactCheckpoint, innerSealCarrier, loadMessage, prunedResult, sessionLog, stepEnd, stepStart, toolResult,
  turnEnd, turnStart, userMessage,
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
// `frameCtx` as the composition hands it; the editable tree is the answer's `tree`.
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
  const answer = events => view(heldObservationsOf(events));
  answer.tree = tree;
  return answer;
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

// ── Reads of lines the epoch already held ────────────────────────────────────

const D_PATH = '/repo/src/d.js';
const E_PATH = '/repo/src/e.js';
const F_PATH = '/repo/src/f.js';
const linesOf = (prefix, count) => Array.from({ length: count }, (_, index) => `export const ${prefix}${String(index + 1).padStart(2, '0')} = ${index + 1};`);
const D = linesOf('dee', 10);
const E = linesOf('eee', 20);
const F = linesOf('eff', 3);
const LONG_FILES = { ...FILES, [D_PATH]: textOf(D), [E_PATH]: textOf(E), [F_PATH]: textOf(F) };

const fpOf = text => fingerprintOf(normalizeLine(text));
// The entries a record keeps of lines `from` to `to` of `lines`, and the effects a record is made of.
const entriesOf = (lines, from = 1, to = lines.length) => lines.slice(from - 1, to).map((text, index) => ({ key: from + index, chars: text.length, cjk: 0, fp: fpOf(text) }));
const impactOf = (resourceKey, entries, kind = 'merge-fragments') => ({ resourceKey, kind, entries });
const readOf = (...impacts) => ({ access: 'read', impacts });
const writeOf = (...impacts) => ({ access: 'write', impacts });
const recordOf = (...effects) => ({ v: 1, effects, residual: null });

// One step of the first turn: the model's calls, each `{ id, name, args, text, isError }`, then their results in the order of `answered`.
const callOf = (id, { name = 'read', args = {}, text = 'result', isError = false } = {}) => ({ id, name, args, text, isError });
function stepOf(step, calls, { turn = 1, answered = calls } = {}) {
  return [
    stepStart({ turn, step }),
    assistantMessage({ turn, step, usage: USAGE, toolCalls: calls.map(({ id, name, args }) => ({ id, name, arguments: JSON.stringify(args) })) }),
    ...answered.map(({ id, text, isError }) => toolResult({ turn, step, callId: id, text, isError })),
    stepEnd({ turn, step }),
  ];
}
const logOf = (...parts) => sessionLog([turnStart(), userMessage({ text: 'Work.' }), ...parts.flat(), turnEnd()]);
const idOf = (step, id, turn = 1) => `${turn}:${step}:${id}`;
const resultSeqOf = (events, step, id) => events.find(event => event.type === 'tool/result' && event.data.step === step && event.data.message.toolCallId === id).seq;
const hitOf = (events, step, id, oldLines, newLines) => ({ toolUseId: idOf(step, id), seq: resultSeqOf(events, step, id), oldLines, newLines });

// The records the calls of `events` leave when they are first ingested live over `files`, by tool-use id: a pass that remembers what it partitions. `changes` maps a tool-use id to the files the tree holds from the call after it on.
function recordsOf(events, files = FILES, changes = {}) {
  const records = new Map();
  const view = heldViewOver(files, {
    remember: (id, record) => {
      records.set(id, record);
      if (changes[id] !== undefined) view.tree.set(changes[id]);
    },
  });
  view(events);
  return records;
}
// The held view answering from `records`, as the composition's answers from the session's store: a call with none is matched afresh.
const replayOver = (records, files = FILES) => heldViewOver(files, { recall: id => records.get(id) ?? null });
const oldReadsOf = (events, records, files) => replayOver(records, files)(events).oldReads;

describe('the reads whose lines the epoch already held', () => {
  test('a successful call whose result is mostly lines held before its step is a hit, whatever tool made it: it names its call, the result\'s seq and the counts alone', () => {
    const events = logOf(
      stepOf(1, [callOf('c1', { name: 'read', args: { file_path: 'src/a.js', offset: 2, limit: 3 }, text: readResultText(A_PATH, A, { from: 2, to: 4 }) })]),
      stepOf(2, [callOf('c2', { name: 'inspect_file', args: { file_path: 'src/a.js' }, text: textOf(A.slice(1, 4)) })]),
      stepOf(3, [callOf('c3', { name: 'bash', args: { command: 'cat src/a.js' }, text: textOf(A.slice(1, 4)) })]),
      stepOf(4, [callOf('c4', { name: 'bash', args: { command: 'cat src/b.js' }, text: textOf(B) })]),
    );
    assert.deepEqual(oldReadsOf(events, recordsOf(events)), [hitOf(events, 2, 'c2', 3, 0), hitOf(events, 3, 'c3', 3, 0)]);
  });

  test('a result is a hit only above nine tenths of its determinable lines: nine of ten is not, nineteen of twenty and one of one are, and a call with no determinable line is none', () => {
    const events = logOf(
      stepOf(1, [
        callOf('d1', { args: { file_path: 'src/d.js', offset: 1, limit: 9 }, text: readResultText(D_PATH, D, { from: 1, to: 9 }) }),
        callOf('e1', { args: { file_path: 'src/e.js', offset: 1, limit: 19 }, text: readResultText(E_PATH, E, { from: 1, to: 19 }) }),
        callOf('f1', { args: { file_path: 'src/f.js', offset: 3, limit: 1 }, text: readResultText(F_PATH, F, { from: 3, to: 3 }) }),
      ]),
      stepOf(2, [
        callOf('d2', { args: { file_path: 'src/d.js' }, text: readResultText(D_PATH, D) }),
        callOf('e2', { args: { file_path: 'src/e.js' }, text: readResultText(E_PATH, E) }),
        callOf('f2', { args: { file_path: 'src/f.js', offset: 3, limit: 1 }, text: readResultText(F_PATH, F, { from: 3, to: 3 }) }),
        callOf('g2', { name: 'bash', args: { command: 'echo done' }, text: 'done\n' }),
      ]),
    );
    assert.deepEqual(oldReadsOf(events, recordsOf(events, LONG_FILES), LONG_FILES), [hitOf(events, 2, 'e2', 19, 1), hitOf(events, 2, 'f2', 1, 0)]);
  });

  test('a call counts each line once and only the lines its result returned: its writes, its residual and a line named by two of its impacts do not add', () => {
    const events = logOf(
      stepOf(1, [callOf('c1')]),
      stepOf(2, [callOf('c2')]),
    );
    const records = new Map([
      [idOf(1, 'c1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
      [idOf(2, 'c2'), { ...recordOf(writeOf(impactOf(C_PATH, entriesOf(C))), readOf(impactOf(A_PATH, entriesOf(A, 1, 3)), impactOf(A_PATH, entriesOf(A, 3, 5)))), residual: { groupKey: 'read', kind: 'tool', detail: '', weight: 900 } }],
    ]);
    assert.deepEqual(oldReadsOf(events, records), [hitOf(events, 2, 'c2', 5, 0)]);
  });

  describe('which lines are old, new or neither', () => {
    // A baseline of a file's lines 1 to 18 and the one call of the next step, whose result's entries `returned` makes.
    const over = (returned, baseline = entriesOf(E, 1, 18)) => {
      const events = logOf(stepOf(1, [callOf('c1')]), stepOf(2, [callOf('c2')]));
      const records = new Map([
        [idOf(1, 'c1'), recordOf(readOf(impactOf(E_PATH, baseline)))],
        [idOf(2, 'c2'), recordOf(readOf(impactOf(E_PATH, returned)))],
      ]);
      return { events, hits: oldReadsOf(events, records) };
    };

    test('a line is old on the same file, line and fingerprint, new when nothing held can be it, and neither when its fingerprint is held only at another line of the file', () => {
      const own = entriesOf(E, 1, 18);
      const moved = { key: 19, chars: E[4].length, cjk: 0, fp: fpOf(E[4]) };
      const fresh = { key: 20, chars: 9, cjk: 0, fp: fpOf('brand new') };
      const { events, hits } = over([...own, moved, fresh]);
      assert.deepEqual(hits, [hitOf(events, 2, 'c2', 18, 1)], 'eighteen old, one new, and the moved line in neither count');
      assert.deepEqual(over([...own, fresh, { key: 21, chars: 9, cjk: 0, fp: fpOf('brand two') }]).hits, [], 'eighteen of twenty is no hit');
    });

    test('an exact match wins though its fingerprint is held at another line too', () => {
      const dup = 'export const same = 0;';
      const lines = [E[0], E[1], dup, E[3], E[4], E[5], dup, E[7]];
      const { events, hits } = over(entriesOf(lines, 3, 3), entriesOf(lines));
      assert.deepEqual(hits, [hitOf(events, 2, 'c2', 1, 0)]);
    });

    test('a held line with no fingerprint leaves a result that matches nothing uncertain, not new, and a returned line with no fingerprint is in neither count', () => {
      const baseline = [entriesOf(E, 1, 1)[0], { key: 2, chars: E[1].length, cjk: 0 }];
      const returned = [
        ...entriesOf(E, 1, 1),
        { key: 2, chars: 9, cjk: 0, fp: fpOf('rewritten') },
        { key: 3, chars: 9, cjk: 0, fp: fpOf('another') },
        { key: 4, chars: 9, cjk: 0 },
      ];
      const { events, hits } = over(returned, baseline);
      assert.deepEqual(hits, [hitOf(events, 2, 'c2', 1, 0)]);
    });

    test('a file the epoch held nothing of has only new lines, whatever other files held', () => {
      const events = logOf(stepOf(1, [callOf('c1')]), stepOf(2, [callOf('c2')]));
      const records = new Map([
        [idOf(1, 'c1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
        [idOf(2, 'c2'), recordOf(readOf(impactOf(B_PATH, entriesOf(A))))],
      ]);
      assert.deepEqual(oldReadsOf(events, records), [], 'the same lines under another path are not inferred as a move');
    });

    test('the entries relocation inserted into a result are no returned lines, vacates and moved entries alike', () => {
      const returned = [
        ...entriesOf(E, 11, 18),
        { key: 3, chars: 0, cjk: 0 },
        { key: 9, chars: 9, cjk: 0, fp: fpOf('moved text'), moved: true },
      ];
      const { events, hits } = over(returned);
      assert.deepEqual(hits, [hitOf(events, 2, 'c2', 8, 0)]);
    });

    test('a record the real interpreter wrote after a line was inserted into the file scores the lines the call sent, not the entries it moved', () => {
      const inserted = [...E.slice(0, 9), 'export const inserted = 0;', ...E.slice(9)];
      const events = logOf(
        stepOf(1, [callOf('c1', { args: { file_path: 'src/e.js' }, text: readResultText(E_PATH, E) })]),
        stepOf(2, [callOf('c2', { args: { file_path: 'src/e.js', offset: 1, limit: 9 }, text: readResultText(E_PATH, inserted, { from: 1, to: 9 }) })]),
      );
      const files = { ...FILES, [E_PATH]: textOf(E) };
      const records = recordsOf(events, files, { [idOf(1, 'c1')]: { ...files, [E_PATH]: textOf(inserted) } });
      assert.ok(records.get(idOf(2, 'c2')).effects[0].impacts[0].entries.some(entry => entry.moved === true), 'the record holds relocation entries');
      assert.deepEqual(oldReadsOf(events, records, files), [hitOf(events, 2, 'c2', 9, 0)]);
    });
  });
});

describe('the baseline a read is compared with', () => {
  test('every call of a step is compared with the file lines held when the step started, whichever sibling wrote or completed before it', () => {
    const events = logOf(
      stepOf(1, [callOf('c1')]),
      stepOf(2, [callOf('w'), callOf('r1'), callOf('r2')], { answered: [callOf('w'), callOf('r1'), callOf('r2')] }),
      stepOf(3, [callOf('c3')]),
    );
    const records = new Map([
      [idOf(1, 'c1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A, 2, 4))))],
      // The edit writes every line of a.js and completes first; the two reads that follow share the pre-step lines 2 to 4.
      [idOf(2, 'w'), recordOf(writeOf(impactOf(A_PATH, entriesOf(A), 'replace-fragments')))],
      [idOf(2, 'r1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
      [idOf(2, 'r2'), recordOf(readOf(impactOf(B_PATH, entriesOf(B))))],
      [idOf(3, 'c3'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))), readOf(impactOf(B_PATH, entriesOf(B))))],
    ]);
    // Step 2: three of five lines of a.js held and none of b.js, so no read is a hit, though the write and the first read left all of a.js held for the second sibling; step 3 finds a.js and b.js held whole by step 2's calls.
    assert.deepEqual(oldReadsOf(events, records), [hitOf(events, 3, 'c3', 8, 0)]);
  });

  test('a sibling that replaced the whole file takes none of its pre-step lines from the calls that follow it', () => {
    const events = logOf(
      stepOf(1, [callOf('c1')]),
      stepOf(2, [callOf('w'), callOf('r')]),
    );
    const records = new Map([
      [idOf(1, 'c1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
      [idOf(2, 'w'), recordOf(writeOf(impactOf(A_PATH, entriesOf(A, 1, 2), 'replace-fragments')))],
      [idOf(2, 'r'), recordOf(readOf(impactOf(A_PATH, entriesOf(A, 3, 5))))],
    ]);
    assert.deepEqual(oldReadsOf(events, records), [hitOf(events, 2, 'r', 3, 0)]);
  });

  test('a sibling that completes after a call leaves its lines to the next step, and two calls reading the same new lines in one step are both new', () => {
    const events = logOf(
      stepOf(1, [callOf('x'), callOf('y')]),
      stepOf(2, [callOf('z')]),
    );
    const records = new Map([
      [idOf(1, 'x'), recordOf(readOf(impactOf(B_PATH, entriesOf(B))))],
      [idOf(1, 'y'), recordOf(readOf(impactOf(B_PATH, entriesOf(B))))],
      [idOf(2, 'z'), recordOf(readOf(impactOf(B_PATH, entriesOf(B))))],
    ]);
    assert.deepEqual(oldReadsOf(events, records), [hitOf(events, 2, 'z', 3, 0)]);
  });

  test('a write of an earlier step establishes old lines, and the lines of a failed call count as held while the failed call is no hit', () => {
    const events = logOf(
      stepOf(1, [callOf('c1', { name: 'write' })]),
      stepOf(2, [callOf('c2')]),
      stepOf(3, [callOf('c3', { isError: true })]),
      stepOf(4, [callOf('c4', { isError: true }), callOf('c5')]),
    );
    const records = new Map([
      [idOf(1, 'c1'), recordOf(writeOf(impactOf(C_PATH, entriesOf(C), 'replace-fragments')))],
      [idOf(2, 'c2'), recordOf(readOf(impactOf(C_PATH, entriesOf(C))))],
      [idOf(3, 'c3'), recordOf(readOf(impactOf(C_PATH, entriesOf(C))))],
      [idOf(4, 'c4'), recordOf(readOf(impactOf(C_PATH, entriesOf(C))))],
      [idOf(4, 'c5'), recordOf(readOf(impactOf(C_PATH, entriesOf(C))))],
    ]);
    assert.deepEqual(oldReadsOf(events, records), [hitOf(events, 2, 'c2', 2, 0), hitOf(events, 4, 'c5', 2, 0)]);
  });

  test('an inner seal resets nothing, a Context Epoch boundary starts the baseline clean', () => {
    const first = stepOf(1, [callOf('c1')]);
    const second = stepOf(2, [callOf('c2')]);
    const third = stepOf(3, [callOf('c3')]);
    const records = new Map(['c1', 'c2', 'c3'].map((id, at) => [idOf(at + 1, id), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))]));
    const resultOf1 = first.find(event => event.type === 'tool/result');
    const sealed = logOf(first, innerSealCarrier({ sourceEventSeqs: [resultOf1.seq] }), second, third);
    assert.deepEqual(oldReadsOf(sealed, records), [hitOf(sealed, 2, 'c2', 5, 0), hitOf(sealed, 3, 'c3', 5, 0)], 'the seal is no boundary');
    const compacted = logOf(first, compactCheckpoint({ startSeq: first[0].seq, endSeq: first.at(-1).seq }), second, third);
    assert.deepEqual(oldReadsOf(compacted, records), [hitOf(compacted, 3, 'c3', 5, 0)], 'the first read after the boundary finds nothing held');
  });

  test('a call of a result pruned in the log is a hit under the seq of its original result, never the replacement\'s', () => {
    const first = stepOf(1, [callOf('c1')]);
    const second = stepOf(2, [callOf('c2')]);
    const original = second.find(event => event.type === 'tool/result');
    const replacement = prunedResult(original, { text: 'pruned' });
    const events = logOf(first, second.slice(0, second.indexOf(original) + 1), replacement, second.slice(second.indexOf(original) + 1));
    const records = new Map([
      [idOf(1, 'c1'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
      [idOf(2, 'c2'), recordOf(readOf(impactOf(A_PATH, entriesOf(A))))],
    ]);
    const [hit, ...others] = oldReadsOf(events, records);
    assert.equal(others.length, 0);
    assert.equal(hit.seq, events.find(event => event.type === 'tool/result' && event.data.step === 2 && event.surfaceOp === 'append').seq);
    assert.notEqual(hit.seq, events.find(event => event.surfaceOp?.op === 'replace' && event.type === 'tool/result').seq);
  });
});

describe('the evidence a read needs', () => {
  const recorded = id => recordOf(readOf(impactOf(A_PATH, entriesOf(A))));
  const stepsOf = (...calls) => logOf(...calls.map((entries, at) => stepOf(at + 1, entries)));

  test('a call with no record, an unreadable one included, is no hit and puts every later step of its epoch out of reach, where a present empty record does not', () => {
    const events = stepsOf([callOf('c1')], [callOf('c2')], [callOf('c3')], [callOf('c4')]);
    const withRecord = empty => new Map([
      [idOf(1, 'c1'), recorded()], [idOf(2, 'c2'), empty], [idOf(3, 'c3'), recorded()], [idOf(4, 'c4'), recorded()],
    ]);
    assert.deepEqual(oldReadsOf(events, withRecord(recordOf())), [hitOf(events, 3, 'c3', 5, 0), hitOf(events, 4, 'c4', 5, 0)], 'a present empty record is no gap');
    assert.deepEqual(oldReadsOf(events, withRecord(null)), [], 'a missing record');
    assert.deepEqual(oldReadsOf(events, withRecord({ v: 99, effects: [] })), [], 'a record this version cannot read');
    assert.deepEqual(oldReadsOf(events, withRecord({ v: 1, effects: [{ access: 'read', impacts: [] }] })), [], 'a record of another shape');
  });

  test('a gap inside a step leaves that step\'s frozen baseline alone and the lines the matcher found for the call without a record are no evidence', () => {
    const events = stepsOf([callOf('c1')], [callOf('gap', { name: 'bash', args: { command: 'cat src/b.js' }, text: textOf(B) }), callOf('c2'), callOf('c3')], [callOf('c4')]);
    const records = new Map([
      [idOf(1, 'c1'), recorded()],
      [idOf(2, 'c2'), recorded()],
      // The call before it matched b.js afresh: the held lines show it, and this sibling still finds b.js new.
      [idOf(2, 'c3'), recordOf(readOf(impactOf(B_PATH, entriesOf(B))))],
      [idOf(3, 'c4'), recorded()],
    ]);
    const view = replayOver(records)(events);
    assert.deepEqual(view.oldReads, [hitOf(events, 2, 'c2', 5, 0)], 'the sibling after the gap is scored, the next step is not');
    assert.deepEqual(view.paths.get(B_PATH), [1, 2, 3], 'the held view still renders what the matcher found');
  });

  test('a Context Epoch boundary starts a clean scope after a gap, and a skill call, which the interpreter knows is no file read, makes none', () => {
    const first = stepOf(1, [callOf('c1')]);
    const gap = stepOf(2, [callOf('gap')]);
    const skill = stepOf(3, [callOf('s', { name: 'skill', args: { name: 'tdd' }, text: 'TDD body' })]);
    const reread = stepOf(4, [callOf('c4')]);
    const afterGap = logOf(first, gap, reread);
    const records = new Map([[idOf(1, 'c1'), recorded()], [idOf(4, 'c4'), recorded()]]);
    assert.deepEqual(oldReadsOf(afterGap, records), []);
    const afterSkill = logOf(first, skill, reread);
    assert.deepEqual(oldReadsOf(afterSkill, records), [hitOf(afterSkill, 4, 'c4', 5, 0)]);

    const boundary = compactCheckpoint({ startSeq: first[0].seq, endSeq: gap.at(-1).seq });
    const opened = logOf(first, gap, boundary, stepOf(5, [callOf('c5')]), stepOf(6, [callOf('c6')]));
    const clean = new Map([[idOf(1, 'c1'), recorded()], [idOf(5, 'c5'), recorded()], [idOf(6, 'c6'), recorded()]]);
    assert.deepEqual(oldReadsOf(opened, clean), [hitOf(opened, 6, 'c6', 5, 0)]);
  });

  test('with no record to recall, every call is matched afresh for the held view alone: the paths, skills and effects are the same and no call is a hit', () => {
    const { events } = dshCallLog(CALLS);
    const records = recordsOf(events);
    const matched = heldViewOver()(events);
    const recalled = replayOver(records)(events);
    assert.deepEqual(matched.oldReads, []);
    assert.deepEqual({ ...recalled, oldReads: [] }, matched, 'the records change nothing the held view renders');
    assert.deepEqual(replayOver(new Map())(events).oldReads, []);
  });

  test('a call is scored only against the step it names that has started: a result of a step that never started, and a call of a load message, have none', () => {
    const events = logOf(
      stepOf(1, [callOf('c1')]),
      stepOf(2, [callOf('c2')]),
      stepOf(3, [callOf('c3')]),
      stepOf(4, [callOf('c4')]),
    );
    const records = new Map([['c1', 1], ['c2', 2], ['c3', 3], ['c4', 4]].map(([id, step]) => [idOf(step, id), id === 'c2' ? recordOf() : recorded()]));
    assert.deepEqual(oldReadsOf(events, records).map(hit => hit.toolUseId), [idOf(3, 'c3'), idOf(4, 'c4')]);

    const withoutStart = events.filter(event => !(event.type === 'step/start' && event.data.step === 3));
    assert.deepEqual(oldReadsOf(withoutStart, records).map(hit => hit.toolUseId), [idOf(4, 'c4')], 'step 3 was never opened, and step 2 that is open names another');

    const loaded = logOf(
      stepOf(1, [callOf('c1')]),
      loadMessage({ calls: [{ id: 'sw-load-1', name: 'read', arguments: '{}', text: 'read result' }] }),
    );
    const loads = new Map([[idOf(1, 'c1'), recorded()], ['sw-load-1', recorded()]]);
    assert.deepEqual(oldReadsOf(loaded, loads), [], 'a load belongs to no step');
  });
});
