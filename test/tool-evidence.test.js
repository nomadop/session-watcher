// Tool Evidence Interpreter over an injected matcher: how one call is partitioned into the Engine's effect and
// residual records, the record it keeps and replays, the keys Turn History asks it for, and the counts a real
// Engine keeps from it. The matcher is a stub that answers the shape of `attribute`; the real matcher meets the
// interpreter in `test/dsh.tool-evidence-profile.test.js`.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createToolEvidenceInterpreter } from '../lib/tool-evidence.js';
import { SKILL_FRAMING_TOKENS } from '../lib/constants.js';
import {
  CWD, MODEL, OTHER_MODEL, LIMITS, resolveModelPolicy, dshRig, dshObservations, makeEngine, stepOf, rowOf,
} from './helpers/attribution-fixtures.js';

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';

const CONTEXT = { sessionCwd: CWD, resolveModelPolicy };

// A vocabulary of its own, so everything these tests see of names comes from the profile and from nowhere else.
const PROFILE = {
  residualIdentity: (name, input) => ({ groupKey: `group:${name}`, kind: 'stub', detail: input.detail ?? '' }),
  isLoadHandoffTool: name => name === 'handoff',
  nonFileResource: ({ name, input }) => (name === 'note' && input.id ? { resourceKey: `note:${input.id}` } : null),
};

const NONE = { input: 0, output: 0 };

// The matcher's answer: the groups of matched lines, the fingerprints of the files they were read from, and the
// characters of each side no line explains.
function answer({ matches = [], files = {}, unmatched = NONE } = {}) {
  return { matches, files, unmatched, stats: { failed: false } };
}

const group = (resourceKey, side, ...rows) => ({
  resourceKey,
  side,
  lines: rows.map(([line, text]) => ({ line, text, tier: 'aligned' })),
});

// One call as the Projection hands it over: the tool use, then its result.
function callOf({ name = 'tool', input = {}, content = '', isError = false, model = MODEL, cwd = null } = {}) {
  return {
    use: { type: 'tool-use', toolUseId: 'call-1', messageId: 'step-1', model, cwd, name, input },
    result: { type: 'tool-result', toolUseId: 'call-1', content, isError },
  };
}

function interpreterOver(reply, { profile = PROFILE } = {}) {
  const attributeCalls = [];
  const attribution = {
    attribute(args) {
      attributeCalls.push(args);
      return typeof reply === 'function' ? reply(args) : reply;
    },
  };
  return { ...createToolEvidenceInterpreter({ attribution, profile, limits: LIMITS }), attributeCalls };
}

// One call interpreted through to its completion.
function partitionOf(reply, spec = {}, options = {}) {
  const { frameCtx, profile } = options;
  const interpreter = interpreterOver(reply, { profile });
  const { use, result } = callOf(spec);
  // An option given as `undefined` is absent, which a default parameter would not let a test say.
  const context = { ...CONTEXT, sessionCwd: 'sessionCwd' in options ? options.sessionCwd : CWD };
  const { pending } = interpreter.interpretToolUse(use, context, {});
  const done = interpreter.completeToolResult(pending, result, context, { frameCtx });
  return { ...done, pending, attributeCalls: interpreter.attributeCalls };
}

describe('partition into effects', () => {
  test('output-side matches give a read effect and input-side matches a write effect, one impact per resource', () => {
    const done = partitionOf(answer({
      matches: [
        group(A, 'input', [1, 'one']),
        group(B, 'input', [4, 'four']),
        group(A, 'output', [2, 'two']),
        group(B, 'output', [5, 'five']),
      ],
      files: { [A]: [11, 12, 13], [B]: [21, 22, 23, 24, 25] },
    }));
    const shape = done.effects.map(effect => [effect.access, effect.impacts.map(impact => impact.resourceKey)]);
    assert.deepEqual(shape, [['write', [A, B]], ['read', [A, B]]]);
  });

  test('a side covering every line of the file replaces its fragments and any other side merges', () => {
    const done = partitionOf(answer({
      files: { [A]: [11, 12, 13], [B]: [21, 22, 23] },
      matches: [
        group(A, 'input', [1, 'x'], [2, 'y'], [3, 'z']),
        group(B, 'input', [1, 'x'], [3, 'z']),
        group(A, 'output', [2, 'y']),
        group(B, 'output', [3, 'z'], [1, 'x'], [2, 'y'], [2, 'y']),
      ],
    }));
    const kinds = done.effects.map(effect => effect.impacts.map(impact => impact.mutation.kind));
    assert.deepEqual(kinds, [
      ['replace-fragments', 'merge-fragments'],
      ['merge-fragments', 'replace-fragments'],
    ]);
  });

  test('a side whose lines are not exactly the lines of the file merges', () => {
    const done = partitionOf(answer({
      files: { [A]: [11, 12, 13] },
      matches: [group(A, 'output', [1, 'x'], [2, 'y'], [3, 'z'], [4, 'w'])],
    }));
    assert.equal(done.effects[0].impacts[0].mutation.kind, 'merge-fragments');
  });

  test('a resource the matcher gave no fingerprints for cannot be shown whole, so its fragments merge', () => {
    const done = partitionOf(answer({ matches: [group(A, 'output', [1, 'x'], [2, 'y'], [3, 'z'])] }));
    assert.equal(done.effects[0].impacts[0].mutation.kind, 'merge-fragments');
  });

  test('a fragment is priced from the counts of its line under the policy of the model that issued the call', () => {
    // 'abcd' is 4 characters; '// 你好' is 5 of which 2 are CJK; the empty line has none.
    const reply = answer({
      matches: [
        group(A, 'input', [1, 'abcd'], [2, '// 你好']),
        group(B, 'input', [3, 'abcd']),
        group(A, 'output', [1, ''], [3, 'abcd']),
      ],
      files: { [A]: [11, 12, 13], [B]: [21, 22, 23] },
    });
    const effectsOf = tokens => [
      {
        access: 'write',
        overheadTokens: 0,
        spentTokens: tokens.abcd + tokens.mixed + tokens.abcd,
        impacts: [
          { resourceKey: A, mutation: { kind: 'merge-fragments', fragments: [{ key: 1, tokens: tokens.abcd }, { key: 2, tokens: tokens.mixed }] } },
          { resourceKey: B, mutation: { kind: 'merge-fragments', fragments: [{ key: 3, tokens: tokens.abcd }] } },
        ],
      },
      {
        access: 'read',
        overheadTokens: 0,
        spentTokens: tokens.abcd,
        impacts: [
          { resourceKey: A, mutation: { kind: 'merge-fragments', fragments: [{ key: 1, tokens: 0 }, { key: 3, tokens: tokens.abcd }] } },
        ],
      },
    ];
    // 4 / 4 and (5 - 2) / 4 + 2 / 2 under the first policy; 4 / 2 and (5 - 2) / 2 + 2 / 0.5 under the second.
    assert.deepEqual(partitionOf(reply, { model: MODEL }).effects, effectsOf({ abcd: 1, mixed: 1.75 }));
    assert.deepEqual(partitionOf(reply, { model: OTHER_MODEL }).effects, effectsOf({ abcd: 2, mixed: 5.5 }));
  });

  test('a file line named twice is one fragment, the later row winning', () => {
    const done = partitionOf(answer({
      matches: [group(A, 'output', [1, 'one'], [3, 'three'], [2, 'two'], [3, 'three again'])],
      files: { [A]: [11, 12, 13, 14] },
    }));
    const [effect] = done.effects;
    // 'one' and 'two' are 3 characters, 'three again' 11; the key keeps its first place and takes the later row.
    assert.deepEqual(effect.impacts[0].mutation.fragments, [
      { key: 1, tokens: 0.75 }, { key: 3, tokens: 2.75 }, { key: 2, tokens: 0.75 },
    ]);
    assert.equal(effect.spentTokens, 4.25);
  });

  test('a fresh completion asks the matcher once with the row base, the call input and the result content', () => {
    const input = { command: 'cat a' };
    const content = [{ type: 'text', text: 'one' }, { type: 'image', source: {} }];
    const done = partitionOf(answer(), { input, content, cwd: '/work' });
    assert.equal(done.attributeCalls.length, 1);
    const [call] = done.attributeCalls;
    assert.equal(call.base, '/work');
    assert.equal(call.input, input);
    assert.equal(call.output, content);
  });

  test('a call that matched nothing yields no effect', () => {
    assert.deepEqual(partitionOf(answer()).effects, []);
  });
});

describe('residual and path events', () => {
  test('the residual weighs the unmatched characters of both sides and is absent when there are none', () => {
    const cases = [[{ input: 7, output: 5 }, 12], [{ input: 0, output: 5 }, 5], [{ input: 3, output: 0 }, 3]];
    for (const [unmatched, weight] of cases) {
      const { residuals } = partitionOf(answer({ unmatched }), { name: 'shell' });
      assert.deepEqual(
        residuals,
        [{ groupKey: 'group:shell', weight, hadError: false, meta: { kind: 'stub', detail: '' } }],
        JSON.stringify(unmatched),
      );
    }
    assert.deepEqual(partitionOf(answer({ unmatched: NONE })).residuals, []);
  });

  test('the residual is named by the profile from the input the call carried', () => {
    const { residuals } = partitionOf(
      answer({ unmatched: { input: 4, output: 4 } }),
      { name: 'shell', input: { detail: 'ls -l' } },
    );
    assert.deepEqual(residuals.map(residual => [residual.groupKey, residual.meta]), [
      ['group:shell', { kind: 'stub', detail: 'ls -l' }],
    ]);
  });

  test('hadError rides on the residual and an errored call is partitioned like any other', () => {
    const reply = answer({
      matches: [group(A, 'output', [1, 'one'])],
      files: { [A]: [11, 12] },
      unmatched: { input: 2, output: 3 },
    });
    const succeeded = partitionOf(reply, { isError: false });
    const failed = partitionOf(reply, { isError: true });
    assert.equal(succeeded.effects.length, 1);
    assert.deepEqual(failed.effects, succeeded.effects);
    assert.deepEqual(failed.residuals, [{ ...succeeded.residuals[0], hadError: true }]);
    assert.equal(succeeded.residuals[0].hadError, false);
    // A harness that reports no `is_error` leaves the field absent, which is not a failure.
    assert.equal(partitionOf(reply, { isError: undefined }).residuals[0].hadError, false);
  });

  test('both-sided hits on one file give a write event with isFullRead null, then a read event, in effect order', () => {
    const files = { [A]: [11, 12, 13] };
    const wholeFile = [[1, 'a'], [2, 'b'], [3, 'c']];
    const whole = partitionOf(
      answer({ files, matches: [group(A, 'input', ...wholeFile), group(A, 'output', ...wholeFile)] }),
      { name: 'shell' },
    );
    assert.deepEqual(whole.telemetry.pathEvents, [
      { path: A, rawPath: A, toolType: 'shell', isFullRead: null },
      { path: A, rawPath: A, toolType: 'shell', isFullRead: 1 },
    ]);
    const partial = partitionOf(
      answer({ files, matches: [group(A, 'input', [2, 'b']), group(A, 'output', [1, 'a'])] }),
      { name: 'shell' },
    );
    assert.deepEqual(partial.telemetry.pathEvents.map(event => event.isFullRead), [null, 0]);
  });

  test('every impact of every effect has one event, in effect order and named by the tool', () => {
    const done = partitionOf(answer({
      files: { [A]: [11, 12], [B]: [21, 22] },
      matches: [
        group(A, 'input', [1, 'a']),
        group(B, 'input', [1, 'x'], [2, 'y']),
        group(B, 'output', [2, 'y']),
        group(A, 'output', [1, 'a'], [2, 'b']),
      ],
    }), { name: 'patch' });
    assert.deepEqual(done.telemetry.pathEvents, [
      { path: A, rawPath: A, toolType: 'patch', isFullRead: null },
      { path: B, rawPath: B, toolType: 'patch', isFullRead: null },
      { path: B, rawPath: B, toolType: 'patch', isFullRead: 0 },
      { path: A, rawPath: A, toolType: 'patch', isFullRead: 1 },
    ]);
    assert.deepEqual(partitionOf(answer()).telemetry.pathEvents, []);
  });
});

describe('a resource that is not a file', () => {
  // `note:<id>` is the profile's: the result's text is that resource's content and nothing in it is matched.
  const note = { name: 'note', input: { id: 'n1' }, content: 'abcdefgh' };

  test('is priced from its result text, never reaches the matcher, and neither recalls nor keeps a record', () => {
    const touched = [];
    const frameCtx = {
      recall: toolUseId => { touched.push(['recall', toolUseId]); return null; },
      remember: (toolUseId, record) => touched.push(['remember', toolUseId, record]),
    };
    const done = partitionOf(answer(), note, { frameCtx });
    // 8 characters under the first policy's divisor of 4.
    assert.deepEqual(done.effects, [{
      access: 'read',
      overheadTokens: SKILL_FRAMING_TOKENS,
      spentTokens: 2 + SKILL_FRAMING_TOKENS,
      impacts: [{ resourceKey: 'note:n1', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 2 }] } }],
    }]);
    assert.deepEqual(done.residuals, []);
    assert.deepEqual(done.telemetry.pathEvents, [{ path: 'note:n1', rawPath: 'note:n1', toolType: 'note', isFullRead: 1 }]);
    assert.deepEqual(done.attributeCalls, []);
    assert.deepEqual(touched, []);
  });

  test('is priced under the policy of the model that issued the call', () => {
    const done = partitionOf(answer(), { ...note, model: OTHER_MODEL });
    assert.equal(done.effects[0].impacts[0].mutation.fragments[0].tokens, 4);
    assert.equal(done.effects[0].spentTokens, 4 + SKILL_FRAMING_TOKENS);
  });

  test('an errored call produces no effect, residual or continuation', () => {
    const profile = { ...PROFILE, interpretSkillPayload: () => ({ effects: [], residuals: [], telemetry: null }) };
    const done = partitionOf(answer(), { ...note, isError: true }, { profile });
    assert.deepEqual([done.effects, done.residuals, done.skillContinuation], [[], [], null]);
    assert.deepEqual(done.telemetry.pathEvents, []);
    assert.deepEqual(done.attributeCalls, []);
  });

  test('arms a continuation only for a profile that reads the payload, naming the policy the use resolved', () => {
    const resolved = [];
    const context = {
      sessionCwd: CWD,
      resolveModelPolicy: (modelId) => {
        const policy = { ...resolveModelPolicy(modelId) };
        resolved.push(policy);
        return policy;
      },
    };
    const interpreter = interpreterOver(answer(), { profile: { ...PROFILE, interpretSkillPayload: () => null } });
    const { use, result } = callOf(note);
    const { pending } = interpreter.interpretToolUse(use, context, {});
    const done = interpreter.completeToolResult(pending, result, context, {});
    assert.equal(resolved.length, 1, 'the policy is resolved at the use and not again at the result');
    assert.deepEqual(done.skillContinuation, { resourceKey: 'note:n1', issuingPolicy: resolved[0] });
    assert.equal(done.skillContinuation.issuingPolicy, resolved[0]);

    assert.equal(partitionOf(answer(), note).skillContinuation, null);
    assert.equal(partitionOf(answer(), { name: 'tool' }, { profile: { ...PROFILE, interpretSkillPayload: () => null } }).skillContinuation, null);
  });

  test('a result given as content blocks is priced like the string of the same text', () => {
    const blocks = [{ type: 'text', text: 'abcd' }, { type: 'image', source: { data: 'x'.repeat(40) } }, { type: 'text', text: 'efgh' }];
    const fromBlocks = partitionOf(answer(), { ...note, content: blocks });
    const fromString = partitionOf(answer(), { ...note, content: 'abcd\nefgh' });
    assert.deepEqual(fromBlocks.effects, fromString.effects);
    assert.equal(fromString.effects[0].impacts[0].mutation.fragments[0].tokens, 2.25);
  });
});

describe('load handoff', () => {
  const loadOf = (input, content, name = 'handoff') => {
    const interpreter = interpreterOver(answer());
    const { use, result } = callOf({ name, input, content });
    const used = interpreter.interpretToolUse(use, CONTEXT, {});
    const done = interpreter.completeToolResult(used.pending, result, CONTEXT, {});
    return { atUse: used.telemetry.loadToken, atResult: done.telemetry.loadToken };
  };

  test('an explicit load_token is registered at the use and none is read from the result', () => {
    const named = loadOf({ load_token: 'lt-named' }, JSON.stringify({ load_token: 'lt-other' }));
    assert.deepEqual(named, { atUse: 'lt-named', atResult: null });
  });

  test('an auto-matched load resolves its token from a JSON result and leaves any other result unresolved', () => {
    assert.deepEqual(loadOf({}, JSON.stringify({ load_token: 'lt-matched', paths: [] })), { atUse: null, atResult: 'lt-matched' });
    for (const content of ['Handoff loaded.', '{"load_token": ', '{"paths":[]}', '{"load_token": 7}', 'null', '']) {
      assert.deepEqual(loadOf({}, content), { atUse: null, atResult: null }, content);
    }
  });

  test('a result given as content blocks resolves the token of the string form of the same text', () => {
    const blocks = [
      { type: 'text', text: '{"load_token":"lt-block",' },
      { type: 'image', source: { data: 'x'.repeat(40) } },
      { type: 'text', text: '"paths":[]}' },
    ];
    const fromString = loadOf({}, '{"load_token":"lt-block",\n"paths":[]}');
    assert.deepEqual(fromString, { atUse: null, atResult: 'lt-block' });
    assert.deepEqual(loadOf({}, blocks), fromString);
  });

  test('a call of any other tool resolves no token', () => {
    assert.deepEqual(loadOf({}, JSON.stringify({ load_token: 'lt-matched' }), 'tool'), { atUse: null, atResult: null });
    assert.deepEqual(loadOf({ load_token: 'lt-named' }, '', 'tool'), { atUse: null, atResult: null });
  });
});

describe('the record', () => {
  // A write and a read of one file, a read of a second, and a remainder on both sides. '// 你好' is 5
  // characters of which 2 are CJK. The line 'beta' is on both sides of the first file, and the ledger holds one entry
  // for it: the weight is the remainder, 15, and the 4 characters of the second copy.
  const REPLY = answer({
    matches: [
      group(A, 'input', [2, 'beta']),
      group(A, 'output', [1, 'alpha'], [2, 'beta'], [3, '// 你好']),
      group(B, 'output', [1, 'abcd']),
    ],
    files: { [A]: [101, 102, 103], [B]: [201, 202] },
    unmatched: { input: 6, output: 9 },
  });
  const RECORD = {
    v: 1,
    effects: [
      {
        access: 'write',
        impacts: [{ resourceKey: A, kind: 'merge-fragments', entries: [{ key: 2, chars: 4, cjk: 0, fp: 102 }] }],
      },
      {
        access: 'read',
        impacts: [
          {
            resourceKey: A,
            kind: 'replace-fragments',
            entries: [
              { key: 1, chars: 5, cjk: 0, fp: 101 },
              { key: 2, chars: 4, cjk: 0, fp: 102 },
              { key: 3, chars: 5, cjk: 2, fp: 103 },
            ],
          },
          { resourceKey: B, kind: 'merge-fragments', entries: [{ key: 1, chars: 4, cjk: 0, fp: 201 }] },
        ],
      },
    ],
    residual: { groupKey: 'group:tool', kind: 'stub', detail: '', weight: 19 },
  };

  // The frame context of a store: it answers `recalled` and takes what is offered to keep.
  function storeOf(recalled = null) {
    const asked = [];
    const offered = [];
    return {
      asked,
      offered,
      frameCtx: {
        recall: (toolUseId) => { asked.push(toolUseId); return recalled; },
        remember: (toolUseId, record) => offered.push([toolUseId, record]),
      },
    };
  }

  const outcomeOf = done => ({ effects: done.effects, residuals: done.residuals, pathEvents: done.telemetry.pathEvents });

  test('a fresh partition asks the store for its record, then offers the record it emitted', () => {
    const store = storeOf();
    const done = partitionOf(REPLY, {}, { frameCtx: store.frameCtx });
    assert.deepEqual(store.asked, ['call-1']);
    assert.deepEqual(store.offered, [['call-1', RECORD]]);
    assert.equal(done.attributeCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(store.offered[0][1])), RECORD, 'the record is JSON through and through');
  });

  test('a fingerprint the matcher did not give is absent from its entry', () => {
    const store = storeOf();
    partitionOf(answer({ ...REPLY, files: { [A]: [101, 102] } }), {}, { frameCtx: store.frameCtx });
    const [, record] = store.offered[0];
    const entries = record.effects.flatMap(effect => effect.impacts.flatMap(impact => impact.entries));
    assert.deepEqual(entries.map(entry => 'fp' in entry), [true, true, true, false, false]);
    assert.equal(entries[3].key, 3, 'the line past the fingerprints is the third of the first file');
  });

  test('remember runs only when the frame context carries it', () => {
    for (const frameCtx of [undefined, null, {}, { recall: () => null }]) {
      const done = partitionOf(REPLY, {}, { frameCtx });
      assert.equal(done.attributeCalls.length, 1);
      assert.equal(done.effects.length, 2);
    }
    const kept = [];
    partitionOf(REPLY, {}, { frameCtx: { remember: (toolUseId, record) => kept.push([toolUseId, record]) } });
    assert.deepEqual(kept, [['call-1', RECORD]]);
  });

  test('a call that matched nothing and left nothing is kept as an empty record', () => {
    const store = storeOf();
    partitionOf(answer(), {}, { frameCtx: store.frameCtx });
    assert.deepEqual(store.offered, [['call-1', { v: 1, effects: [], residual: null }]]);
    const replayed = storeOf({ v: 1, effects: [], residual: null });
    const done = partitionOf(answer(), {}, { frameCtx: replayed.frameCtx });
    assert.deepEqual([done.effects, done.residuals, done.attributeCalls], [[], [], []]);
  });

  test('an answer that marks an internal failure is kept like any other: the whole text is residual', () => {
    const failed = {
      matches: [], files: {}, unmatched: { input: 10, output: 20 }, stats: { failed: true, failure: 'adapter fault' },
    };
    const store = storeOf();
    const done = partitionOf(failed, {}, { frameCtx: store.frameCtx });
    assert.deepEqual(done.effects, []);
    assert.deepEqual(done.residuals.map(residual => residual.weight), [30]);
    assert.deepEqual(store.offered, [[
      'call-1',
      { v: 1, effects: [], residual: { groupKey: 'group:tool', kind: 'stub', detail: '', weight: 30 } },
    ]]);
  });

  test('a recall hit never reaches the matcher or offers a record, and yields what the fresh partition yielded', () => {
    const fresh = partitionOf(REPLY);
    const store = storeOf(structuredClone(RECORD));
    const replayed = partitionOf(REPLY, {}, { frameCtx: store.frameCtx });
    assert.deepEqual(replayed.attributeCalls, []);
    assert.deepEqual(store.offered, []);
    assert.deepEqual(outcomeOf(replayed), outcomeOf(fresh));
    assert.equal(replayed.residuals[0].weight, 19);
    assert.deepEqual(replayed.telemetry.pathEvents.map(event => [event.path, event.isFullRead]), [[A, null], [A, 1], [B, 0]]);
  });

  test('a recall hit reprices every entry under the policy now in force and keeps the residual weight', () => {
    const store = storeOf(structuredClone(RECORD));
    const replayed = partitionOf(answer(), { model: OTHER_MODEL }, { frameCtx: store.frameCtx });
    assert.deepEqual(outcomeOf(replayed), outcomeOf(partitionOf(REPLY, { model: OTHER_MODEL })));
    assert.notDeepEqual(replayed.effects, partitionOf(REPLY, { model: MODEL }).effects);
    assert.equal(replayed.residuals[0].weight, 19);
  });

  test('a recall hit takes hadError from the result it is completing, never from the record', () => {
    const store = storeOf(structuredClone(RECORD));
    assert.equal('hadError' in RECORD.residual, false);
    assert.equal(partitionOf(answer(), { isError: true }, { frameCtx: store.frameCtx }).residuals[0].hadError, true);
    assert.equal(partitionOf(answer(), { isError: false }, { frameCtx: store.frameCtx }).residuals[0].hadError, false);
  });

  // Every row yields a record this version cannot read. Each is a miss: the call is partitioned afresh, and the
  // store is offered the fresh record as for any miss.
  const edit = (change) => { const record = structuredClone(RECORD); change(record); return record; };
  const entryOf = record => record.effects[1].impacts[0].entries[0];
  const MALFORMED = [
    ['an unknown version', edit((r) => { r.v = 2; })],
    ['no version', edit((r) => { delete r.v; })],
    ['a version spelled as text', edit((r) => { r.v = '1'; })],
    ['effects that are not a list', edit((r) => { r.effects = {}; })],
    ['no effects', edit((r) => { delete r.effects; })],
    ['an effect that is not an object', edit((r) => { r.effects[0] = null; })],
    ['an access that is neither read nor write', edit((r) => { r.effects[0].access = 'copy'; })],
    ['an effect without impacts', edit((r) => { r.effects[0].impacts = []; })],
    ['impacts that are not a list', edit((r) => { r.effects[0].impacts = {}; })],
    ['an impact without a resource key', edit((r) => { r.effects[0].impacts[0].resourceKey = ''; })],
    ['a resource key that is not text', edit((r) => { r.effects[0].impacts[0].resourceKey = 7; })],
    ['a mutation kind that is neither replace nor merge', edit((r) => { r.effects[0].impacts[0].kind = 'append'; })],
    ['an impact without entries', edit((r) => { r.effects[0].impacts[0].entries = []; })],
    ['entries that are not a list', edit((r) => { r.effects[0].impacts[0].entries = 'x'; })],
    ['an entry that is not an object', edit((r) => { r.effects[1].impacts[0].entries[1] = 4; })],
    ['a negative key', edit((r) => { entryOf(r).key = -1; })],
    ['a key that is not finite', edit((r) => { entryOf(r).key = Infinity; })],
    ['a key that is not a number', edit((r) => { entryOf(r).key = '1'; })],
    ['a negative character count', edit((r) => { entryOf(r).chars = -1; })],
    ['a character count that is NaN', edit((r) => { entryOf(r).chars = NaN; })],
    ['a character count that is not finite', edit((r) => { entryOf(r).chars = Infinity; })],
    ['a character count that is not a number', edit((r) => { entryOf(r).chars = '5'; })],
    ['no character count', edit((r) => { delete entryOf(r).chars; })],
    ['a negative CJK count', edit((r) => { entryOf(r).cjk = -1; })],
    ['a CJK count that is NaN', edit((r) => { entryOf(r).cjk = NaN; })],
    ['a CJK count above the character count', edit((r) => { entryOf(r).cjk = 6; })],
    ['no CJK count', edit((r) => { delete entryOf(r).cjk; })],
    ['one key twice in an impact', edit((r) => { r.effects[1].impacts[0].entries[1].key = 1; })],
    ['no residual field', edit((r) => { delete r.residual; })],
    ['a residual that is not an object', edit((r) => { r.residual = 15; })],
    ['a negative residual weight', edit((r) => { r.residual.weight = -1; })],
    ['a residual weight that is NaN', edit((r) => { r.residual.weight = NaN; })],
    ['a residual weight that is not finite', edit((r) => { r.residual.weight = Infinity; })],
    ['a residual weight that is not a number', edit((r) => { r.residual.weight = '15'; })],
    ['a residual without a group', edit((r) => { r.residual.groupKey = ''; })],
    ['a residual kind that is not text', edit((r) => { r.residual.kind = null; })],
    ['a residual detail that is not text', edit((r) => { delete r.residual.detail; })],
    ['text where an object was stored', 'not a record'],
    ['a list where an object was stored', []],
  ];

  test('a record this version cannot read is a miss: the call is partitioned afresh', () => {
    const fresh = partitionOf(REPLY);
    for (const [label, recalled] of MALFORMED) {
      const store = storeOf(recalled);
      const done = partitionOf(REPLY, {}, { frameCtx: store.frameCtx });
      assert.equal(done.attributeCalls.length, 1, label);
      assert.deepEqual(outcomeOf(done), outcomeOf(fresh), label);
      assert.deepEqual(store.offered, [['call-1', RECORD]], label);
    }
  });

  test('a record that is a plain miss for the store is partitioned afresh too', () => {
    for (const recalled of [null, undefined]) {
      const done = partitionOf(REPLY, {}, { frameCtx: storeOf(recalled).frameCtx });
      assert.equal(done.attributeCalls.length, 1);
    }
  });

  test('a record whose fingerprints are missing or unrecognizable still replays its effects and residual', () => {
    const replayed = outcomeOf(partitionOf(REPLY, {}, { frameCtx: storeOf(structuredClone(RECORD)).frameCtx }));
    const withFingerprint = (fp) => edit((r) => {
      for (const effect of r.effects) for (const impact of effect.impacts) for (const entry of impact.entries) entry.fp = fp;
    });
    const without = edit((r) => {
      for (const effect of r.effects) for (const impact of effect.impacts) for (const entry of impact.entries) delete entry.fp;
    });
    const UNRECOGNIZABLE = [['missing', without], ['text', withFingerprint('abc')], ['negative', withFingerprint(-1)],
      ['past 32 bits', withFingerprint(2 ** 32)], ['fractional', withFingerprint(1.5)], ['null', withFingerprint(null)],
      ['NaN', withFingerprint(NaN)]];
    for (const [label, recalled] of UNRECOGNIZABLE) {
      const store = storeOf(recalled);
      const done = partitionOf(answer(), {}, { frameCtx: store.frameCtx });
      assert.deepEqual(done.attributeCalls, [], label);
      assert.deepEqual(store.offered, [], label);
      assert.deepEqual(outcomeOf(done), replayed, label);
    }
  });
});

describe('resourceKeysOf', () => {
  // A pair as Dialogue folds a call: the use and its result side by side.
  const pairOf = (spec = {}) => ({
    toolUseId: 'call-1', name: 'tool', input: {}, cwd: null, result: 'out', isError: false, ...spec,
  });
  const recordOf = (...keys) => ({
    v: 1,
    effects: [{
      access: 'read',
      impacts: keys.map(resourceKey => ({
        resourceKey, kind: 'merge-fragments', entries: [{ key: 1, chars: 3, cjk: 0 }],
      })),
    }],
    residual: null,
  });
  const MATCHES = answer({
    matches: [group(A, 'input', [1, 'x']), group(A, 'output', [1, 'x']), group(B, 'output', [2, 'y'])],
    files: { [A]: [1], [B]: [1, 2] },
  });

  // The keys of one pair, with the record `recalled` in the store and the matcher answering `reply`.
  function keysOf(pair, options = {}) {
    const { reply = MATCHES, recalled = null, profile, withoutStore = false } = options;
    const sessionCwd = 'sessionCwd' in options ? options.sessionCwd : CWD;
    const interpreter = interpreterOver(reply, { profile });
    const asked = [];
    const kept = [];
    const context = withoutStore ? { sessionCwd } : {
      sessionCwd,
      recall: (toolUseId) => { asked.push(toolUseId); return recalled; },
      remember: (toolUseId, record) => kept.push([toolUseId, record]),
    };
    return { keys: interpreter.resourceKeysOf(pair, context), attributeCalls: interpreter.attributeCalls, asked, kept };
  }

  test('answers the keys of the record the store holds, each once, without asking the matcher', () => {
    const result = keysOf(pairOf(), { recalled: recordOf(A, B, A) });
    assert.deepEqual(result.keys, [A, B]);
    assert.deepEqual(result.attributeCalls, []);
    assert.deepEqual(result.asked, ['call-1']);
  });

  test('asks the matcher only when the store holds no record, and keeps nothing', () => {
    const input = { command: 'cat a' };
    const result = keysOf(pairOf({ input, result: 'text' }), { recalled: null });
    assert.deepEqual(result.keys, [A, B]);
    assert.equal(result.attributeCalls.length, 1);
    assert.equal(result.attributeCalls[0].input, input);
    assert.equal(result.attributeCalls[0].output, 'text');
    assert.deepEqual(result.kept, []);
    assert.deepEqual(keysOf(pairOf(), { withoutStore: true }).keys, [A, B]);
  });

  test('a record this version cannot read is a miss here too', () => {
    const result = keysOf(pairOf(), { recalled: { ...recordOf(B), v: 2 } });
    assert.deepEqual(result.keys, [A, B]);
    assert.equal(result.attributeCalls.length, 1);
  });

  test('a call that matched nothing has no keys', () => {
    assert.deepEqual(keysOf(pairOf(), { reply: answer() }).keys, []);
    assert.deepEqual(keysOf(pairOf(), { recalled: { v: 1, effects: [], residual: null } }).keys, []);
  });

  test('a pair of the profile\'s non-file resource answers its key, in a session with records and in one with none', () => {
    const note = pairOf({ name: 'note', input: { id: 'n1' }, result: 'a note' });
    for (const recalled of [null, recordOf(A)]) {
      const withRecords = keysOf(note, { recalled });
      assert.deepEqual(withRecords.keys, ['note:n1']);
      assert.deepEqual(withRecords.attributeCalls, []);
    }
    const withoutStore = keysOf(note, { withoutStore: true });
    assert.deepEqual(withoutStore.keys, ['note:n1']);
    assert.deepEqual(withoutStore.attributeCalls, []);
    assert.deepEqual(keysOf({ ...note, isError: true, result: null }).keys, ['note:n1']);
  });

  // The rows of one table: the same row hands the matcher the same base whether its call is being completed or
  // its keys are being read at capture.
  const BASES = [
    ['a row directory', { cwd: '/work' }, '/repo', '/work'],
    ['a row directory and no session directory', { cwd: '/work' }, null, '/work'],
    ['no row directory', { cwd: null }, '/repo', '/repo'],
    ['an empty row directory', { cwd: '' }, '/repo', '/repo'],
    ['a row directory that is not text', { cwd: 7 }, '/repo', '/repo'],
    ['an absent row directory', {}, '/repo', '/repo'],
    ['neither directory', { cwd: null }, null, null],
    ['an empty session directory', { cwd: '' }, '', null],
    ['an absent session directory', { cwd: null }, undefined, null],
  ];

  test('hands the matcher the base completeToolResult hands it for the same row', () => {
    for (const [label, row, sessionCwd, expected] of BASES) {
      const completed = partitionOf(answer(), { ...row }, { sessionCwd });
      assert.equal(completed.attributeCalls.length, 1, label);
      assert.equal(completed.attributeCalls[0].base, expected, `completing: ${label}`);
      const captured = keysOf(pairOf(row), { reply: answer(), sessionCwd });
      assert.equal(captured.attributeCalls.length, 1, label);
      assert.equal(captured.attributeCalls[0].base, expected, `capturing: ${label}`);
    }
  });

  test('never throws and always answers a list', () => {
    const throwing = () => { throw new Error('refused'); };
    const brokenProfile = { ...PROFILE, nonFileResource: throwing };
    const cases = [
      ['no pair', undefined, {}],
      ['a null pair', null, {}],
      ['a matcher that throws', pairOf(), { reply: throwing }],
      ['a store that throws', pairOf(), { recalled: null, throwingStore: true }],
      ['a profile that throws', pairOf(), { profile: brokenProfile }],
    ];
    for (const [label, pair, options] of cases) {
      const interpreter = interpreterOver(options.reply ?? MATCHES, { profile: options.profile });
      const context = options.throwingStore ? { recall: throwing } : {};
      const keys = interpreter.resourceKeysOf(pair, context);
      assert.deepEqual(keys, [], label);
    }
    const interpreter = interpreterOver(MATCHES);
    assert.deepEqual(interpreter.resourceKeysOf(pairOf()), [A, B], 'a second argument is optional');
    assert.deepEqual(interpreter.resourceKeysOf(pairOf(), null), [A, B], 'and may be null');
  });
});

describe('construction', () => {
  const build = overrides => createToolEvidenceInterpreter({
    attribution: { attribute: () => answer() }, profile: PROFILE, limits: LIMITS, ...overrides,
  });

  test('throws when the limits lack the alignment-cell cap or the evidence floor', () => {
    for (const name of ['alignCells', 'evidenceFloor']) {
      const limits = { ...LIMITS };
      delete limits[name];
      assert.throws(() => build({ limits }), new RegExp(`limit ${name} must be a finite positive number`), name);
    }
    assert.throws(() => build({ limits: undefined }), /limit alignCells/);
    assert.throws(() => build({ limits: null }), /limit alignCells/);
  });

  test('throws when either is not a finite positive number', () => {
    for (const name of ['alignCells', 'evidenceFloor']) {
      for (const value of [0, -1, NaN, Infinity, -Infinity, '5', null, undefined, true, [5]]) {
        assert.throws(() => build({ limits: { ...LIMITS, [name]: value } }), new RegExp(name), `${name}: ${String(value)}`);
      }
    }
  });

  test('reads only those two, so the limits the matcher is built with are accepted whole', () => {
    assert.doesNotThrow(() => build({ limits: { alignCells: 1, evidenceFloor: 1 } }));
    assert.doesNotThrow(() => build({ limits: LIMITS }));
  });

  test('throws when the matcher or the profile lacks what the interpreter calls', () => {
    assert.throws(() => build({ attribution: undefined }), /attribution must provide attribute/);
    assert.throws(() => build({ attribution: {} }), /attribution must provide attribute/);
    assert.throws(() => build({ profile: undefined }), /profile must provide residualIdentity/);
    for (const method of ['residualIdentity', 'isLoadHandoffTool', 'nonFileResource']) {
      const profile = { ...PROFILE };
      delete profile[method];
      assert.throws(() => build({ profile }), new RegExp(`profile must provide ${method}`), method);
    }
    assert.throws(() => createToolEvidenceInterpreter(), /attribution must provide attribute/);
  });
});

describe('an input that is null', () => {
  // DSH hands a tool the value its arguments parse to, and `null` is one; Claude Code's may be absent.
  const withInput = (input) => {
    const call = callOf({ input: input === undefined ? {} : input, content: 'out' });
    if (input === undefined) delete call.use.input;
    return call;
  };

  test('gets a pending from interpretToolUse and its tool name\'s residual label from completeToolResult', () => {
    for (const input of [null, undefined]) {
      for (const name of ['shell', 'handoff', 'note']) {
        const interpreter = interpreterOver(answer({ unmatched: { input: 2, output: 3 } }));
        const { use, result } = withInput(input);
        use.name = name;
        const used = interpreter.interpretToolUse(use, CONTEXT, {});
        assert.notEqual(used.pending, null, `${name}: ${String(input)}`);
        const done = interpreter.completeToolResult(used.pending, result, CONTEXT, {});
        assert.deepEqual(done.residuals.map(residual => [residual.groupKey, residual.weight]), [[`group:${name}`, 5]], name);
        assert.deepEqual(interpreter.attributeCalls.map(call => call.input), [{}], 'the matcher reads it as an empty input');
      }
    }
  });

  test('is read by resourceKeysOf as an empty input', () => {
    for (const input of [null, undefined]) {
      const interpreter = interpreterOver(answer({ matches: [group(A, 'output', [1, 'x'])] }));
      const pair = { toolUseId: 'call-1', name: 'note', input, cwd: null, result: 'out' };
      assert.deepEqual(interpreter.resourceKeysOf(pair, { sessionCwd: CWD }), [A], String(input));
      assert.deepEqual(interpreter.attributeCalls.map(call => call.input), [{}]);
    }
  });
});

describe('interpretToolUse', () => {
  test('returns a non-null pending for every call, a non-file resource and an unknown tool included', () => {
    const specs = [
      { name: 'tool' },
      { name: 'unheard-of', input: { anything: 1 } },
      { name: 'note', input: { id: 'n1' } },
      { name: 'note', input: {} },
      { name: 'handoff', input: { load_token: 'lt-1' } },
      { name: 'handoff', input: {} },
      { name: 'tool', input: 'raw argument text' },
      { name: 'tool', input: [1, 2] },
      { name: 'tool', input: 7 },
      { name: 'tool', input: null },
    ];
    for (const spec of specs) {
      const interpreter = interpreterOver(answer());
      const used = interpreter.interpretToolUse(callOf(spec).use, CONTEXT, {});
      assert.equal(typeof used.pending, 'object', JSON.stringify(spec));
      assert.notEqual(used.pending, null, JSON.stringify(spec));
      assert.deepEqual([used.effects, used.residuals], [[], []], JSON.stringify(spec));
      assert.deepEqual(used.telemetry.pathEvents, []);
      assert.deepEqual(interpreter.attributeCalls, [], 'interpretToolUse never reads the tree');
    }
  });

  test('resolves the policy of the issuing step\'s model, and a step with no model resolves the null policy', () => {
    const resolved = [];
    const context = { sessionCwd: CWD, resolveModelPolicy: (modelId) => { resolved.push(modelId); return resolveModelPolicy(modelId); } };
    const interpreter = interpreterOver(answer());
    interpreter.interpretToolUse(callOf({ model: OTHER_MODEL }).use, context, {});
    const modelless = callOf().use;
    delete modelless.model;
    interpreter.interpretToolUse(modelless, context, {});
    assert.deepEqual(resolved, [OTHER_MODEL, null]);
  });

  test('carries the issuing step in the telemetry it returns, null for a use that names none', () => {
    const interpreter = interpreterOver(answer());
    assert.equal(interpreter.interpretToolUse(callOf().use, CONTEXT, {}).telemetry.issuingStepId, 'step-1');
    const stepless = callOf().use;
    delete stepless.messageId;
    const used = interpreter.interpretToolUse(stepless, CONTEXT, {});
    assert.equal(used.telemetry.issuingStepId, null);
    assert.equal(interpreter.completeToolResult(used.pending, callOf().result, CONTEXT, {}).telemetry.issuingStepId, null);
  });
});

describe('the counts a real Engine keeps from the effects (BC#17)', () => {
  const F = '/repo/notes.txt';
  const LINES = [[1, 'alpha'], [2, 'beta'], [3, 'gamma'], [4, 'delta']];
  const files = { [F]: [1, 2, 3, 4] };
  const readOf = (...rows) => answer({ files, matches: [group(F, 'output', ...rows)] });
  const writeOf = (...rows) => answer({ files, matches: [group(F, 'input', ...rows)] });
  const WHOLE_READ = readOf(...LINES);
  const PART_READ = readOf([2, 'beta']);
  const PART_WRITE = writeOf([2, 'beta']);
  const WHOLE_BOTH = answer({ files, matches: [group(F, 'input', ...LINES), group(F, 'output', ...LINES)] });
  const BOTH_PARTS = answer({ files, matches: [group(F, 'input', [3, 'gamma']), group(F, 'output', [2, 'beta'])] });

  // The calls, one after another, through the real Projection into a real Engine: the counts the Engine keeps
  // for the file after each of them. A step follows each call, so the Engine settles what the call put in.
  function countsAfter(...answers) {
    const queue = [...answers];
    const rig = dshRig({ attribute: () => queue.shift() });
    const engine = makeEngine();
    engine.ingest([stepOf('m1', 100_000)]);
    return answers.map((_, index) => {
      const { use, result } = dshObservations({ name: 'tool', callId: `call_${index}`, text: 'out' });
      engine.ingest([use, result].flatMap(observation => rig.projection.project(observation, {}).records));
      engine.ingest([stepOf(`m${index + 2}`, 100_000 + 1_000 * (index + 1))]);
      const { readCount, editCount, pureRereads } = rowOf(engine, F);
      return { readCount, editCount, pureRereads };
    });
  }

  test('a call whose input and output both hit one file counts one read and one edit', () => {
    assert.deepEqual(countsAfter(WHOLE_BOTH), [{ readCount: 1, editCount: 1, pureRereads: 0 }]);
    // On top of what the file already has, each count rises by one.
    assert.deepEqual(countsAfter(PART_READ, BOTH_PARTS), [
      { readCount: 1, editCount: 0, pureRereads: 0 },
      { readCount: 2, editCount: 1, pureRereads: 0 },
    ]);
  });

  test('a whole-file read counts a pure re-read only for a second with no write between', () => {
    const counts = countsAfter(WHOLE_READ, WHOLE_READ, PART_WRITE, WHOLE_READ, WHOLE_READ);
    assert.deepEqual(counts.map(count => count.pureRereads), [0, 1, 1, 1, 2]);
    assert.deepEqual(counts.map(count => count.editCount), [0, 0, 1, 1, 1]);
    assert.deepEqual(counts.map(count => count.readCount), [1, 2, 2, 3, 4]);
  });

  test('a partial read is no pure re-read, and does not take away the standing of a whole one', () => {
    const counts = countsAfter(PART_READ, PART_READ, WHOLE_READ, PART_READ, WHOLE_READ);
    assert.deepEqual(counts.map(count => count.pureRereads), [0, 0, 0, 0, 1]);
  });

  test('the write of a call comes before its read, so the read leaves the next whole read a pure re-read', () => {
    const counts = countsAfter(WHOLE_BOTH, WHOLE_READ);
    assert.deepEqual(counts.map(count => count.pureRereads), [0, 1]);
  });
});
