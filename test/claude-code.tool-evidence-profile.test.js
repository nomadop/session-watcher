// Claude Code's profile of the Tool Evidence Interpreter: how a call that attributes to no file is named, which tool
// loads a handoff, which tool's resource is not a file, and the two rows only this harness has, the skill payload a
// Skill result promises and a sub-agent's completion notice. The real matcher meets the interpreter in the last
// group.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { claudeCodeToolEvidenceProfile as profile } from '../lib/harness/claude-code/tool-evidence-profile.js';
import { bashFeature } from '../lib/bash-feature.js';
import { SKILL_FRAMING_TOKENS } from '../lib/constants.js';
import { createResourceAttribution } from '../lib/resource-attribution.js';
import { fingerprintOf, normalizeLine } from '../lib/line-align.js';
import {
  CWD, LIMITS, MODEL, OTHER_MODEL, resolveModelPolicy, ccRig, ccObservations, treeOf, makeEngine, stepOf, rowOf,
} from './helpers/attribution-fixtures.js';

// The same call through the interpreter over a tree that holds nothing, so no line is matched.
function currentOf({ use, result }, rigOptions) {
  const { interpreter, context } = ccRig(rigOptions);
  const used = interpreter.interpretToolUse(use, context, {});
  return { used, done: interpreter.completeToolResult(used.pending, result, context, {}) };
}

const recordsOf = (projection, observations) => observations.flatMap(observation => projection.project(observation, {}).records);

const SKILL_LAUNCH = 'Launching skill: tdd';
const SKILL_BLOCKS = [
  { type: 'text', text: 'Launching skill: ' },
  { type: 'image', source: { data: 'x'.repeat(64) } },
  { type: 'text', text: 'tdd' },
];
const SKILL_BODY = ['Base directory for this skill: /skills/tdd', '', '# Test-Driven Development', 'Red, then green.'].join('\n');

describe('the skill call', () => {
  // The launch confirmation is 20 characters, or 21 as the content blocks join: 5 and 5.25 tokens at a divisor of 4,
  // 10 at a divisor of 2. The 40 framing tokens are charged beside them, and the spend is both.
  const LAUNCH_EFFECT = (tokens, spentTokens) => [{
    access: 'read',
    overheadTokens: 40,
    spentTokens,
    impacts: [{ resourceKey: 'skill:tdd', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
  }];

  test('is priced, and gets its path event and its continuation', () => {
    const call = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content: SKILL_LAUNCH });
    const current = currentOf(call);
    assert.equal(current.done.effects[0].impacts[0].resourceKey, 'skill:tdd');
    assert.deepEqual(current.done.effects, LAUNCH_EFFECT(5, 45));
    assert.deepEqual(current.done.residuals, []);
    assert.deepEqual(current.done.telemetry, {
      toolUseId: call.use.toolUseId,
      issuingStepId: call.use.messageId,
      loadToken: null,
      pathEvents: [{ path: 'skill:tdd', rawPath: 'skill:tdd', toolType: 'Skill', isFullRead: 1 }],
    });
    assert.deepEqual(current.used.telemetry, {
      toolUseId: call.use.toolUseId, issuingStepId: call.use.messageId, loadToken: null, pathEvents: [],
    });
    assert.deepEqual(current.done.skillContinuation, { resourceKey: 'skill:tdd', issuingPolicy: { ctp: { ascii: 4, cjk: 2 } } });
    assert.deepEqual(Object.keys(current.done.skillContinuation).sort(), ['issuingPolicy', 'resourceKey']);
    assert.equal(current.done.skillContinuation.resourceKey, 'skill:tdd');
  });

  test('a result given as content blocks is priced as the string of the same text', () => {
    const call = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content: SKILL_BLOCKS });
    const asString = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content: 'Launching skill: \ntdd' });
    const current = currentOf(call);
    assert.deepEqual(current.done.effects, LAUNCH_EFFECT(5.25, 45.25));
    assert.deepEqual(current.done.effects, currentOf(asString).done.effects);
    assert.deepEqual(current.done.skillContinuation, { resourceKey: 'skill:tdd', issuingPolicy: { ctp: { ascii: 4, cjk: 2 } } });
  });

  test('is priced under the policy of the model that issued it', () => {
    const call = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content: SKILL_LAUNCH, model: OTHER_MODEL });
    assert.deepEqual(currentOf(call).done.effects, LAUNCH_EFFECT(10, 50));
    assert.notDeepEqual(currentOf(call).done.effects, currentOf({ ...call, use: { ...call.use, model: MODEL } }).done.effects,
      'the two models price the same text differently');
    assert.deepEqual(currentOf(call).done.skillContinuation.issuingPolicy, resolveModelPolicy(OTHER_MODEL));
  });

  test('an errored skill call produces no effect, residual or continuation', () => {
    const call = ccObservations({
      name: 'Skill', input: { skill: 'nope' }, content: 'Unknown skill: nope', isError: true,
    });
    const nothing = { effects: [], residuals: [], skillContinuation: null };
    const { done } = currentOf(call);
    assert.deepEqual({ effects: done.effects, residuals: done.residuals, skillContinuation: done.skillContinuation }, nothing);
    assert.deepEqual(done.telemetry.pathEvents, []);
  });

  test('never reaches the matcher and neither recalls nor writes a record', () => {
    const asked = [];
    const { interpreter, context } = ccRig({ attribute: (args) => { asked.push(args); throw new Error('the matcher was asked'); } });
    const touched = [];
    const frameCtx = {
      recall: (toolUseId) => { touched.push(['recall', toolUseId]); return null; },
      remember: (toolUseId) => touched.push(['remember', toolUseId]),
    };
    for (const content of [SKILL_LAUNCH, SKILL_BLOCKS]) {
      const { use, result } = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content });
      const { pending } = interpreter.interpretToolUse(use, context, { frameCtx });
      interpreter.completeToolResult(pending, result, context, { frameCtx });
    }
    assert.deepEqual([asked, touched], [[], []]);
  });

  test('the call and its payload row give the call\'s record and then the payload\'s, for a string and a content-block result', () => {
    // The body is 86 characters: 21.5 tokens at a divisor of 4. The launch confirmation carried the spend.
    const effect = (spentTokens, tokens) => ({
      type: 'effect',
      access: 'read',
      overheadTokens: 40,
      spentTokens,
      impacts: [{ resourceKey: 'skill:tdd', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
    });
    for (const [content, launch] of [[SKILL_LAUNCH, effect(45, 5)], [SKILL_BLOCKS, effect(45.25, 5.25)]]) {
      const { use, result, payload } = ccObservations({ name: 'Skill', input: { skill: 'tdd' }, content, payload: SKILL_BODY });
      assert.equal(payload.type, 'skill-payload', 'precondition: the Source reduced the harness row');
      const expected = [launch, effect(0, 21.5)];
      const records = recordsOf(ccRig().projection, [use, result, payload]);
      assert.deepEqual(records, expected);
      assert.equal(JSON.stringify(records), JSON.stringify(expected));
    }
  });

  test('a payload is priced under the policy its continuation carries, with the framing overhead', () => {
    // Priced at the divisors of the two models: the body is 86 characters, the CJK text 100 characters of CJK, and
    // the mixed text 10 characters of ASCII and 3 of CJK. Empty text and none are a payload of nothing.
    const priced = tokens => ({
      effects: [{
        access: 'read',
        overheadTokens: 40,
        spentTokens: 0,
        impacts: [{ resourceKey: 'skill:tdd', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
      }],
      residuals: [],
      telemetry: null,
    });
    const nothing = { effects: [], residuals: [], telemetry: null };
    const EXPECTED = [
      [SKILL_BODY, { [MODEL]: priced(21.5), [OTHER_MODEL]: priced(43) }],
      ['好'.repeat(100), { [MODEL]: priced(50), [OTHER_MODEL]: priced(200) }],
      [`${'é'.repeat(9)} ${'好'.repeat(3)}`, { [MODEL]: priced(4), [OTHER_MODEL]: priced(11) }],
      ['', { [MODEL]: nothing, [OTHER_MODEL]: nothing }],
      [undefined, { [MODEL]: nothing, [OTHER_MODEL]: nothing }],
    ];
    for (const [text, byModel] of EXPECTED) {
      for (const model of [MODEL, OTHER_MODEL]) {
        const continuation = { resourceKey: 'skill:tdd', issuingPolicy: resolveModelPolicy(model) };
        const observation = { type: 'skill-payload', toolUseId: 'toolu_1', text, sourceOrdinal: 3 };
        const label = `${JSON.stringify(text)} under ${model}`;
        assert.deepEqual(profile.interpretSkillPayload(continuation, observation), byModel[model], label);
      }
    }
    const [effect] = profile.interpretSkillPayload(
      { resourceKey: 'skill:tdd', issuingPolicy: resolveModelPolicy(MODEL) }, { type: 'skill-payload', text: SKILL_BODY },
    ).effects;
    assert.equal(effect.overheadTokens, SKILL_FRAMING_TOKENS);
    assert.equal(effect.spentTokens, 0, 'the launch confirmation carried the spend');
    assert.deepEqual(effect.impacts[0].mutation, {
      kind: 'replace-fragments', fragments: [{ key: 1, tokens: SKILL_BODY.length / 4 }],
    });
  });

  test('a skill call that names no skill has no resource, so its text is residual like any other tool\'s', () => {
    const call = ccObservations({ name: 'Skill', input: {}, content: 'Unknown skill' });
    const { done } = currentOf(call);
    assert.deepEqual(done.effects, []);
    assert.deepEqual(done.residuals, [{
      groupKey: 'Skill', weight: '{}'.length + 'Unknown skill'.length, hadError: false, meta: { kind: 'tool', detail: '' },
    }]);
    assert.equal(done.skillContinuation, null);
    assert.equal(profile.nonFileResource({ name: 'Skill', input: { skill: '' } }), null);
  });
});

describe('the skill key at capture', () => {
  test('a Skill pair answers its skill key, with the matcher never asked', () => {
    const pair = {
      toolUseId: 'toolu_1', name: 'Skill', input: { skill: 'tdd' }, cwd: null, result: SKILL_LAUNCH, isError: false,
    };
    const stored = { v: 1, effects: [], residual: null };
    for (const recall of [undefined, () => null, () => stored]) {
      const asked = [];
      const { interpreter } = ccRig({ attribute: (args) => { asked.push(args); throw new Error('the matcher was asked'); } });
      assert.deepEqual(interpreter.resourceKeysOf(pair, { recall, sessionCwd: CWD }), ['skill:tdd']);
      assert.deepEqual(asked, []);
    }
  });
});

describe('residual naming', () => {
  const COMMAND = 'cd /repo && npm test -- --grep parser';
  // The names an MCP tool is shown under, as literals.
  const MCP_NAMES = [
    ['mcp__serena__onboarding', 'serena onboarding'],
    ['mcp__serena__list_memories', 'serena list_memories'],
    ['mcp__serena__initial_instructions', 'serena initial_instructions'],
    ['mcp__plugin_playwright_playwright__browser_evaluate', 'playwright browser_evaluate'],
    ['mcp__plugin_session-watcher_session-watcher__watcher_status', 'session-watcher watcher_status'],
    ['mcp__github__search_issues', 'github search_issues'],
  ];
  // A residual weighs the serialized input and the result text: `{"q":"x"}` is 9 characters, beside 300 of result.
  const residual = (groupKey, weight, kind, detail = '', hadError = false) => ({ groupKey, weight, hadError, meta: { kind, detail } });
  const CALLS = [
    { name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, content: 'ok 1 - parser\n', expected: residual('npm test', 66, 'bash') },
    { name: 'Bash', input: { command: 'git status --short' }, content: ' M src/a.js\n?? notes.txt\n', expected: residual('git status', 57, 'bash') },
    { name: 'Bash', input: { command: 'sudo env PATH=/bin make build' }, content: 'done', expected: residual('make', 47, 'bash', 'build') },
    { name: 'Bash', input: {}, content: 'ok', expected: residual('(bash)', 4, 'bash') },
    { name: 'Bash', input: { command: 'npm test' }, content: 'Error: spawn /bin/bash ENOENT', isError: true, expected: residual('npm test', 51, 'bash', '', true) },
    ...MCP_NAMES.map(([name, groupKey]) => ({ name, input: { q: 'x' }, content: 'y'.repeat(300), expected: residual(groupKey, 309, 'mcp') })),
    { name: 'mcp__serena__onboarding', input: {}, content: 'broke', isError: true, expected: residual('serena onboarding', 7, 'mcp', '', true) },
  ];

  test('names the group, kind, detail and weight of Bash and MCP calls', () => {
    for (const { expected, ...call } of CALLS) {
      const observations = ccObservations(call);
      const current = currentOf(observations);
      const label = `${call.name}: ${JSON.stringify(call.input)}`;
      assert.deepEqual(current.done.residuals, [expected], label);
      assert.deepEqual(current.done.effects, [], label);
      const { toolUseId, messageId } = observations.use;
      const telemetry = { toolUseId, issuingStepId: messageId, loadToken: null, pathEvents: [] };
      assert.deepEqual(current.done.telemetry, telemetry, label);
      assert.deepEqual(current.used.telemetry, telemetry, label);
    }
  });

  test('gives each family its group, kind and detail', () => {
    const identity = (name, input = {}) => profile.residualIdentity(name, input);
    const feature = bashFeature(COMMAND);
    assert.notEqual(feature.name, '(bash)', 'precondition: the command names a feature');
    assert.deepEqual(identity('Bash', { command: COMMAND }), { groupKey: feature.name, kind: 'bash', detail: feature.detail });
    assert.deepEqual(identity('Bash', {}), { groupKey: '(bash)', kind: 'bash', detail: '' });
    for (const [name, groupKey] of MCP_NAMES) {
      assert.deepEqual(identity(name), { groupKey, kind: 'mcp', detail: '' }, name);
    }
    for (const name of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'Task', 'TodoWrite', 'Skill', 'bash']) {
      assert.deepEqual(identity(name), { groupKey: name, kind: 'tool', detail: '' }, name);
    }
  });

  test('a call of any other tool is a residual group named for the tool', () => {
    const fetched = ccObservations({ name: 'WebFetch', input: { url: 'https://example.com' }, content: 'Example Domain' });
    assert.deepEqual(currentOf(fetched).done.residuals, [{
      groupKey: 'WebFetch',
      weight: JSON.stringify({ url: 'https://example.com' }).length + 'Example Domain'.length,
      hadError: false,
      meta: { kind: 'tool', detail: '' },
    }]);

    const failed = ccObservations({ name: 'Read', input: { file_path: 'src/gone.js' }, content: 'File does not exist.', isError: true });
    const [residual] = currentOf(failed).done.residuals;
    assert.deepEqual([residual.groupKey, residual.meta.kind, residual.hadError], ['Read', 'tool', true]);
    assert.deepEqual(currentOf(failed).done.effects, []);
  });
});

describe('task notification', () => {
  const text = [
    '<task-notification>',
    '<task-id>abcdef1234567890</task-id>',
    '<summary>Agent "Explore" finished</summary>',
    '</task-notification>',
  ].join('\n');
  const notice = body => ({ type: 'task-notification', text: body, sourceOrdinal: 4, sourceEntryId: 'u4', timestamp: 4000 });

  test('one generic residual candidate with the agent group key and normalized detail', () => {
    assert.deepEqual(profile.interpretTaskNotification(notice(text)), {
      effects: [],
      residuals: [{ groupKey: 'agent:abcdef12', weight: text.length, hadError: false, meta: { kind: 'agent', detail: 'Explore' } }],
      telemetry: null,
    });
  });

  test('a summary that is not the finished phrase is kept verbatim', () => {
    const other = '<task-notification><task-id>0123456789</task-id><summary>ran the sweep</summary></task-notification>';
    const [residual] = profile.interpretTaskNotification(notice(other)).residuals;
    assert.equal(residual.meta.detail, 'ran the sweep');
    assert.equal(residual.groupKey, 'agent:01234567');
  });

  test('a notification without a summary falls back to the task id prefix as detail', () => {
    const bare = '<task-notification><task-id>fedcba9876543210</task-id></task-notification>';
    const [residual] = profile.interpretTaskNotification(notice(bare)).residuals;
    assert.equal(residual.meta.detail, 'fedcba98');
    assert.equal(residual.groupKey, 'agent:fedcba98');
  });

  test('a notification without a task id still produces one candidate', () => {
    const bare = '<task-notification><summary>done</summary></task-notification>';
    const out = profile.interpretTaskNotification(notice(bare));
    assert.equal(out.residuals.length, 1);
    assert.equal(out.residuals[0].groupKey, 'agent:');
    assert.equal(out.residuals[0].weight, bare.length);
  });

  test('weighs the characters of a notice and nothing for one without text', () => {
    const answer = (groupKey, weight, detail) => ({
      effects: [], residuals: [{ groupKey, weight, hadError: false, meta: { kind: 'agent', detail } }], telemetry: null,
    });
    for (const [body, expected] of [
      [text, answer('agent:abcdef12', 120, 'Explore')],
      ['<task-notification></task-notification>', answer('agent:', 39, '')],
      [undefined, answer('agent:', 0, '')],
    ]) {
      assert.deepEqual(profile.interpretTaskNotification(notice(body)), expected, String(body));
    }
  });

  test('the Projection answers a notice with the profile\'s record before it delegates to the shared Projection', () => {
    const projected = ccRig().projection.project(notice(text), {});
    assert.deepEqual(projected, {
      records: [{ type: 'residual', groupKey: 'agent:abcdef12', weight: text.length, hadError: false, meta: { kind: 'agent', detail: 'Explore' } }],
      diagnostics: [],
    });
  });
});

describe('load handoff', () => {
  const LOAD = 'mcp__plugin_session-watcher_session-watcher__load_handoff';
  const LOADS = [
    [{ name: LOAD, input: { load_token: 'amber-otter' }, content: 'Handoff loaded.' }, { atUse: 'amber-otter', atResult: null }],
    [{ name: LOAD, input: {}, content: JSON.stringify({ load_token: 'amber-otter', summary: 'x' }) }, { atUse: null, atResult: 'amber-otter' }],
    [{ name: LOAD, input: {}, content: 'not json at all' }, { atUse: null, atResult: null }],
    [{ name: LOAD, input: {}, content: '{"load_token": ' }, { atUse: null, atResult: null }],
    [{ name: 'load_handoff', input: {}, content: JSON.stringify({ load_token: 'lt-bare' }) }, { atUse: null, atResult: 'lt-bare' }],
    [{ name: 'Bash', input: { command: 'ls' }, content: JSON.stringify({ load_token: 'lt-bash' }) }, { atUse: null, atResult: null }],
  ];

  test('registers an explicit load_token at use, resolves an auto-matched one from a JSON result and leaves a non-JSON result unresolved', () => {
    for (const [call, expected] of LOADS) {
      const observations = ccObservations(call);
      const current = currentOf(observations);
      const label = `${call.name}: ${call.content}`;
      assert.deepEqual({ atUse: current.used.telemetry.loadToken, atResult: current.done.telemetry.loadToken }, expected, label);
    }
  });

  test('a result given as content blocks resolves the token of the string form of the same text', () => {
    const asString = ccObservations({ name: LOAD, input: {}, content: '{"load_token":"lt-block",\n"paths":[]}' });
    const blocks = ccObservations({
      name: LOAD,
      input: {},
      content: [
        { type: 'text', text: '{"load_token":"lt-block",' },
        { type: 'image', source: { data: 'x'.repeat(64) } },
        { type: 'text', text: '"paths":[]}' },
      ],
    });
    assert.equal(currentOf(asString).done.telemetry.loadToken, 'lt-block');
    assert.equal(currentOf(blocks).done.telemetry.loadToken, 'lt-block');
  });

  test('isLoadHandoffTool takes the bare tool and the namespaced one', () => {
    const { isLoadHandoffTool } = profile;
    assert.equal(isLoadHandoffTool('load_handoff'), true);
    assert.equal(isLoadHandoffTool(LOAD), true);
    assert.equal(isLoadHandoffTool('load_handoff_all'), false);
    assert.equal(isLoadHandoffTool('Read'), false);
  });
});

describe('the non-file resource', () => {
  test('is the skill a Skill call names, in the skill namespace, and nothing for any other call', () => {
    const { nonFileResource } = profile;
    assert.deepEqual(nonFileResource({ name: 'Skill', input: { skill: 'tdd' } }), { resourceKey: 'skill:tdd' });
    assert.equal(nonFileResource({ name: 'Skill', input: {} }), null);
    assert.equal(nonFileResource({ name: 'Skill', input: { skill: '' } }), null);
    assert.equal(nonFileResource({ name: 'Read', input: { skill: 'tdd', file_path: 'a.js' } }), null);
    assert.equal(nonFileResource({ name: 'Bash', input: { command: 'skill tdd' } }), null);
    assert.equal(nonFileResource({ name: 'skill', input: { skill: 'tdd' } }), null, 'the tool is named Skill');
  });
});

describe('over the real matcher', () => {
  const A_JS = '/repo/src/a.js';
  const FILE = 'const a = 1;\nexport default a;\n';
  // `Read`'s result for the two lines of the file, each numbered with a tab.
  const READ_TEXT = '1\tconst a = 1;\n2\texport default a;';
  const READ_INPUT = { file_path: 'src/a.js' };

  // The Read call run once against `rig`, offering what it records to `kept`.
  function readOnce(rig, kept = [], recalled = null) {
    const frameCtx = { recall: () => recalled, remember: (toolUseId, record) => kept.push([toolUseId, record]) };
    const { use, result } = ccObservations({ name: 'Read', input: READ_INPUT, content: READ_TEXT });
    const { pending } = rig.interpreter.interpretToolUse(use, rig.context, { frameCtx });
    return rig.interpreter.completeToolResult(pending, result, rig.context, { frameCtx });
  }

  test('a Read result attributes to the lines of the file it names, the input and the line breaks staying residual', () => {
    const kept = [];
    const done = readOnce(ccRig({ files: { [A_JS]: FILE } }), kept);
    // '1\tconst a = 1;' is 14 characters and '2\texport default a;' is 19, at a divisor of 4.
    assert.deepEqual(done.effects, [{
      access: 'read',
      overheadTokens: 0,
      spentTokens: 8.25,
      impacts: [{ resourceKey: A_JS, mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 3.5 }, { key: 2, tokens: 4.75 }] } }],
    }]);
    assert.deepEqual(done.residuals, [{
      groupKey: 'Read',
      weight: JSON.stringify(READ_INPUT).length + READ_TEXT.length - 14 - 19,
      hadError: false,
      meta: { kind: 'tool', detail: '' },
    }]);
    assert.deepEqual(done.telemetry.pathEvents, [{ path: A_JS, rawPath: A_JS, toolType: 'Read', isFullRead: 1 }]);
    const [fpOne, fpTwo] = ['const a = 1;', 'export default a;'].map(line => fingerprintOf(normalizeLine(line)));
    assert.deepEqual(kept[0][1].effects, [{
      access: 'read',
      impacts: [{
        resourceKey: A_JS,
        kind: 'replace-fragments',
        entries: [{ key: 1, chars: 14, cjk: 0, fp: fpOne }, { key: 2, chars: 19, cjk: 0, fp: fpTwo }],
      }],
    }]);
  });

  test('a record replays after the tree has lost the file, as the live partition emitted it and reading nothing', () => {
    const kept = [];
    const live = readOnce(ccRig({ files: { [A_JS]: FILE } }), kept);
    assert.equal(live.effects.length, 1, 'precondition: the live partition attributed the read');

    const reads = [];
    const emptied = treeOf({});
    const watched = {
      resolve: (...args) => { reads.push('resolve'); return emptied.resolve(...args); },
      stat: (...args) => { reads.push('stat'); return emptied.stat(...args); },
      readText: (...args) => { reads.push('readText'); return emptied.readText(...args); },
    };
    const attribution = createResourceAttribution({ workingTree: watched, limits: LIMITS });
    const rebuilt = ccRig({ attribute: attribution.attribute });

    const replayed = readOnce(rebuilt, [], kept[0][1]);
    assert.deepEqual(reads, []);
    assert.deepEqual(replayed.effects, live.effects);
    assert.deepEqual(replayed.residuals, live.residuals);
    assert.deepEqual(replayed.telemetry.pathEvents, live.telemetry.pathEvents);

    // Without the record the same rig matches against the tree it has, which no longer holds the file.
    const unrecorded = readOnce(rebuilt);
    assert.notDeepEqual(reads, []);
    assert.deepEqual(unrecorded.effects, []);
  });

  test('the keys of a pair at capture come from its record without a read of the tree, and from the tree without one', () => {
    const kept = [];
    readOnce(ccRig({ files: { [A_JS]: FILE } }), kept);
    const pair = {
      toolUseId: 'toolu_1', name: 'Read', input: READ_INPUT, cwd: null, result: READ_TEXT, isError: false,
    };

    const reads = [];
    const tree = treeOf({ [A_JS]: FILE });
    const watched = {
      resolve: (...args) => { reads.push('resolve'); return tree.resolve(...args); },
      stat: (...args) => { reads.push('stat'); return tree.stat(...args); },
      readText: (...args) => { reads.push('readText'); return tree.readText(...args); },
    };
    const { interpreter } = ccRig({ attribute: createResourceAttribution({ workingTree: watched, limits: LIMITS }).attribute });

    assert.deepEqual(interpreter.resourceKeysOf(pair, { recall: () => kept[0][1], sessionCwd: CWD }), [A_JS]);
    assert.deepEqual(reads, [], 'a record answers without a read');
    assert.deepEqual(interpreter.resourceKeysOf(pair, { recall: () => null, sessionCwd: CWD }), [A_JS]);
    assert.notDeepEqual(reads, [], 'a miss reads the tree');
    // A relative path needs a base: a pair that names its file only so has the file when the session has a
    // directory and none when it has not.
    const cat = { toolUseId: 'toolu_2', name: 'Bash', input: { command: 'cat src/a.js' }, cwd: null, result: FILE };
    assert.deepEqual(interpreter.resourceKeysOf(cat, { recall: () => null, sessionCwd: CWD }), [A_JS]);
    assert.deepEqual(interpreter.resourceKeysOf(cat, { recall: () => null, sessionCwd: null }), []);
    assert.deepEqual(interpreter.resourceKeysOf({ ...cat, cwd: '/repo' }, { recall: () => null, sessionCwd: null }), [A_JS],
      'a base the row names is enough');
  });

  test('a heredoc that writes a file and the cat that shows it count one edit and one read', () => {
    const NOTES = 'alpha\nbeta\ngamma\ndelta\n';
    const rig = ccRig({ files: { '/repo/notes.txt': NOTES } });
    const engine = makeEngine();
    engine.ingest([stepOf('m1', 100_000)]);
    const command = `cat > notes.txt <<'EOF'\n${NOTES}EOF\ncat notes.txt`;
    const { use, result } = ccObservations({ name: 'Bash', input: { command }, content: NOTES });
    engine.ingest([use, result].flatMap(observation => rig.projection.project(observation, {}).records));
    const row = rowOf(engine, '/repo/notes.txt');
    assert.deepEqual(
      [row.readCount, row.editCount, row.pureRereads, row.lineNumbers],
      [1, 1, 0, [1, 2, 3, 4]],
    );
  });

  test('an MCP result that wraps file lines in JSON attributes them to the file, the wrapper staying in the MCP call\'s group', () => {
    const BODY = [
      'export function parseHeader(text) {', '  const [name, value] = text.split(":");', '  return { name, value };', '}',
    ];
    const FILE_LINES = ['// parser', ...BODY, '// end of file'];
    const result = JSON.stringify({
      result: JSON.stringify([{ relative_path: 'src/p.js', body_location: { start_line: 1, end_line: 4 }, body: BODY.join('\n') }]),
    });
    const input = { name_path: 'parseHeader', relative_path: 'src/p.js', include_body: true };
    const { use, result: observed } = ccObservations({ name: 'mcp__serena__find_symbol', input, content: result });
    const rig = ccRig({ files: { '/repo/src/p.js': `${FILE_LINES.join('\n')}\n` } });
    const { pending } = rig.interpreter.interpretToolUse(use, rig.context, {});
    const done = rig.interpreter.completeToolResult(pending, observed, rig.context, {});

    assert.deepEqual(
      done.effects.map(effect => [effect.access, effect.impacts.map(impact => [impact.resourceKey, impact.mutation.fragments.map(f => f.key)])]),
      [['read', [['/repo/src/p.js', [2, 3, 4, 5]]]]],
    );
    // The call's text less the four lines is the wrapper, and the input, which names the file but holds no line.
    assert.deepEqual(done.residuals, [{
      groupKey: 'serena find_symbol',
      weight: JSON.stringify(input).length + result.length - BODY.join('').length,
      hadError: false,
      meta: { kind: 'mcp', detail: '' },
    }]);
  });
});
