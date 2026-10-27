// DSH's profile of the Tool Evidence Interpreter: how a call that attributes to no file is named, which tool
// loads a handoff, and which tool's resource is not a file. The real matcher meets the interpreter in the last
// group.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { dshToolEvidenceProfile } from '../lib/harness/dsh/tool-evidence-profile.js';
import { bashFeature } from '../lib/bash-feature.js';
import { createResourceAttribution } from '../lib/resource-attribution.js';
import { fingerprintOf, normalizeLine } from '../lib/line-align.js';
import {
  CWD, LIMITS, OTHER_MODEL, resolveModelPolicy, dshRig, dshObservations, treeOf, makeEngine, stepOf, rowOf,
} from './helpers/attribution-fixtures.js';

// The same call through the interpreter over a tree that holds nothing, so no line is matched.
function currentOf({ use, result }, rigOptions) {
  const { interpreter, context } = dshRig(rigOptions);
  const used = interpreter.interpretToolUse(use, context, {});
  return { used, done: interpreter.completeToolResult(used.pending, result, context, {}) };
}

const SKILL_TEXT = [
  '<skill_content name="tdd">', '<skill_resources>', '</skill_resources>', '',
  '<skill_instructions>', '# Test-Driven Development', 'Red, then green.', '</skill_instructions>', '</skill_content>',
].join('\n');

describe('the skill call', () => {
  // SKILL_TEXT is 167 characters: 41.75 tokens at a divisor of 4, 83.5 at a divisor of 2, with the 40 framing tokens
  // charged beside them. The spend is the tokens of the result and the framing.
  const SKILL_EFFECT = (tokens, spentTokens) => [{
    access: 'read',
    overheadTokens: 40,
    spentTokens,
    impacts: [{ resourceKey: 'skill:tdd', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
  }];

  test('is priced from its result text with the framing overhead, gets its path event and arms no continuation', () => {
    const call = dshObservations({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT });
    const current = currentOf(call);
    assert.equal(current.done.effects[0].impacts[0].resourceKey, 'skill:tdd');
    assert.deepEqual(current.done.effects, SKILL_EFFECT(41.75, 81.75));
    assert.deepEqual(current.done.residuals, []);
    assert.deepEqual(current.done.telemetry, {
      toolUseId: call.use.toolUseId,
      issuingStepId: call.use.messageId,
      loadToken: null,
      pathEvents: [{ path: 'skill:tdd', rawPath: 'skill:tdd', toolType: 'skill', isFullRead: 1 }],
    });
    assert.deepEqual(current.used.telemetry, {
      toolUseId: call.use.toolUseId, issuingStepId: call.use.messageId, loadToken: null, pathEvents: [],
    });
    assert.equal(current.done.skillContinuation, null);
  });

  test('is priced under the policy of the model that issued it', () => {
    const call = dshObservations({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT, model: OTHER_MODEL });
    assert.deepEqual(currentOf(call).done.effects, SKILL_EFFECT(83.5, 123.5));
  });

  test('an errored skill call produces no effect, residual or continuation', () => {
    const call = dshObservations({
      name: 'skill', args: { name: 'nope' }, text: 'Error: skill "nope" is unknown or no longer available', isError: true,
    });
    const nothing = { effects: [], residuals: [], skillContinuation: null };
    const { done } = currentOf(call);
    assert.deepEqual({ effects: done.effects, residuals: done.residuals, skillContinuation: done.skillContinuation }, nothing);
    assert.deepEqual(done.telemetry.pathEvents, []);
  });

  test('never reaches the matcher and neither recalls nor writes a record', () => {
    const asked = [];
    const { interpreter, context } = dshRig({ attribute: (args) => { asked.push(args); throw new Error('the matcher was asked'); } });
    const touched = [];
    const frameCtx = {
      recall: (toolUseId) => { touched.push(['recall', toolUseId]); return null; },
      remember: (toolUseId) => touched.push(['remember', toolUseId]),
    };
    const { use, result } = dshObservations({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT });
    const { pending } = interpreter.interpretToolUse(use, context, { frameCtx });
    interpreter.completeToolResult(pending, result, context, { frameCtx });
    assert.deepEqual([asked, touched], [[], []]);
  });

  test('is the record the Projection emits for the call, one effect', () => {
    const call = dshObservations({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT });
    const projection = dshRig().projection;
    assert.deepEqual(
      [call.use, call.result].flatMap(observation => projection.project(observation, {}).records),
      SKILL_EFFECT(41.75, 81.75).map(effect => ({ type: 'effect', ...effect })),
    );
  });

  test('a profile that reads the payload gets a continuation from a successful call and none from an errored one', () => {
    const profile = { ...dshToolEvidenceProfile, interpretSkillPayload: () => null };
    const { interpreter, context } = dshRig({ profile });
    const run = (call) => {
      const { pending } = interpreter.interpretToolUse(call.use, context, {});
      return interpreter.completeToolResult(pending, call.result, context, {});
    };
    const ok = run(dshObservations({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT }));
    assert.deepEqual(Object.keys(ok.skillContinuation).sort(), ['issuingPolicy', 'resourceKey']);
    assert.equal(ok.skillContinuation.resourceKey, 'skill:tdd');
    assert.deepEqual(ok.skillContinuation.issuingPolicy, resolveModelPolicy('model-a'));
    assert.equal(run(dshObservations({ name: 'skill', args: { name: 'tdd' }, text: 'Error: gone', isError: true })).skillContinuation, null);
    assert.equal(run(dshObservations({ name: 'bash', args: { command: 'ls' }, text: 'a' })).skillContinuation, null);
  });

  test('a result given as content blocks is priced like the string of the same text', () => {
    const call = dshObservations({ name: 'skill', args: { name: 'tdd' }, text: 'first half\n\nsecond half' });
    const blocks = [
      { type: 'text', text: 'first half\n' },
      { type: 'image', source: { data: 'x'.repeat(64) } },
      { type: 'text', text: 'second half' },
    ];
    const fromBlocks = currentOf({ use: call.use, result: { ...call.result, content: blocks } });
    assert.deepEqual(fromBlocks.done.effects, currentOf(call).done.effects);
  });

  test('a skill call that names no skill has no resource, so its text is residual like any other tool\'s', () => {
    const { done } = currentOf(dshObservations({ name: 'skill', args: {}, text: 'no such skill' }));
    assert.deepEqual(done.effects, []);
    assert.deepEqual(done.residuals, [{
      groupKey: 'skill', weight: '{}'.length + 'no such skill'.length, hadError: false, meta: { kind: 'tool', detail: '' },
    }]);
  });
});

describe('the skill key at capture', () => {
  test('a skill pair answers its skill key, with the matcher never asked', () => {
    const pair = { toolUseId: '1:1:call_1', name: 'skill', input: { name: 'tdd' }, cwd: null, result: SKILL_TEXT, isError: false };
    const stored = { v: 1, effects: [], residual: null };
    for (const recall of [undefined, () => null, () => stored]) {
      const asked = [];
      const { interpreter } = dshRig({ attribute: (args) => { asked.push(args); throw new Error('the matcher was asked'); } });
      assert.deepEqual(interpreter.resourceKeysOf(pair, { recall, sessionCwd: CWD }), ['skill:tdd']);
      assert.deepEqual(asked, []);
    }
  });
});

describe('residual naming', () => {
  const COMMAND = 'cd /repo && npm test -- --grep parser';
  // A residual weighs the serialized input and the result text.
  const residual = (groupKey, weight, kind, detail = '', hadError = false) => ({ groupKey, weight, hadError, meta: { kind, detail } });
  const CALLS = [
    { name: 'bash', args: { command: COMMAND, description: 'Run the parser tests' }, text: 'ok 1 - parser\n', expected: residual('npm test', 102, 'bash', 'parser') },
    { name: 'bash', args: { command: 'git status --short' }, text: ' M src/a.js\n', expected: residual('git status', 44, 'bash') },
    { name: 'mcp__github__search_issues', args: { query: 'is:open label:bug' }, text: '[]', expected: residual('github__search_issues', 31, 'mcp') },
    { name: 'subagent', args: { prompt: 'Survey the parser.' }, text: 'The parser has two entry points.', expected: residual('subagent', 63, 'agent') },
    { name: 'subagent_fork', args: { prompt: 'Survey the lexer.' }, text: 'done', expected: residual('subagent_fork', 34, 'agent') },
    { name: 'workflow', args: { script: 'return 1' }, text: '1', expected: residual('workflow', 22, 'agent') },
    { name: 'send_message', args: { message: 'hello' }, text: 'sent', expected: residual('send_message', 23, 'agent') },
    { name: 'glob', args: { pattern: 'src/**/*.js' }, text: 'src/a.js\nsrc/b.js', expected: residual('glob', 42, 'tool') },
    { name: 'ask_user_question', args: { id: 'x' }, text: 'done', expected: residual('ask_user_question', 14, 'tool') },
    { name: 'web_fetch', args: { url: 'https://example.com' }, text: 'Error: fetch failed', isError: true, expected: residual('web_fetch', 48, 'tool', '', true) },
    { name: 'load_handoff', args: {}, text: 'Handoff loaded.', expected: residual('load_handoff', 17, 'tool') },
    // The reducer hands a tool the value its arguments parse to, and `null` is one.
    { name: 'bash', args: 'null', text: 'ok', expected: residual('(bash)', 4, 'bash') },
    { name: 'glob', args: 'null', text: 'src/a.js', expected: residual('glob', 10, 'tool') },
    { name: 'load_handoff', args: 'null', text: 'Handoff loaded.', expected: residual('load_handoff', 17, 'tool') },
  ];

  test('names the group, kind and detail of bash, mcp__, agent and other tools, and weighs them', () => {
    for (const { expected, ...call } of CALLS) {
      const observations = dshObservations(call);
      const current = currentOf(observations);
      const label = `${call.name}: ${JSON.stringify(call.args)}`;
      assert.deepEqual(current.done.residuals, [expected], label);
      assert.deepEqual(current.done.effects, [], label);
      const { toolUseId, messageId } = observations.use;
      const telemetry = { toolUseId, issuingStepId: messageId, loadToken: null, pathEvents: [] };
      assert.deepEqual(current.done.telemetry, telemetry, label);
      assert.deepEqual(current.used.telemetry, telemetry, label);
      // The interpreter, not the profile, reads an input that is null as an empty one.
      assert.deepEqual(
        dshToolEvidenceProfile.residualIdentity(call.name, observations.use.input ?? {}),
        { groupKey: expected.groupKey, kind: expected.meta.kind, detail: expected.meta.detail },
        label,
      );
    }
  });

  test('gives each family its group, kind and detail', () => {
    const identity = (name, input = {}) => dshToolEvidenceProfile.residualIdentity(name, input);
    const feature = bashFeature(COMMAND);
    assert.notEqual(feature.name, '(bash)', 'precondition: the command names a feature');
    assert.deepEqual(identity('bash', { command: COMMAND }), { groupKey: feature.name, kind: 'bash', detail: feature.detail });
    assert.deepEqual(identity('mcp__github__search_issues'), { groupKey: 'github__search_issues', kind: 'mcp', detail: '' });
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'send_message']) {
      assert.deepEqual(identity(name), { groupKey: name, kind: 'agent', detail: '' }, name);
    }
    for (const name of ['glob', 'ask_user_question', 'web_fetch', 'read', 'load_handoff']) {
      assert.deepEqual(identity(name), { groupKey: name, kind: 'tool', detail: '' }, name);
    }
  });

  test('arguments that are raw text are named from the tool alone and weigh as the text they are', () => {
    const raw = '{"command": "npm te';
    const { done } = currentOf(dshObservations({ name: 'bash', args: raw, text: 'ok' }));
    assert.deepEqual(done.residuals, [{
      groupKey: '(bash)', weight: raw.length + 'ok'.length, hadError: false, meta: { kind: 'bash', detail: '' },
    }]);
  });

  test('an errored call keeps its residual and marks hadError', () => {
    const call = dshObservations({ name: 'bash', args: { command: 'npm test' }, text: 'Error: spawn /bin/bash ENOENT', isError: true });
    const [residual] = currentOf(call).done.residuals;
    assert.equal(residual.hadError, true);
    assert.deepEqual(currentOf(call).done.residuals, [{
      groupKey: 'npm test', weight: 51, hadError: true, meta: { kind: 'bash', detail: '' },
    }]);
  });
});

describe('load handoff', () => {
  const LOADS = [
    [{ name: 'load_handoff', args: { load_token: 'lt-named' }, text: 'Handoff loaded.' }, { atUse: 'lt-named', atResult: null }],
    [{ name: 'load_handoff', args: {}, text: JSON.stringify({ load_token: 'lt-matched', paths: [] }) }, { atUse: null, atResult: 'lt-matched' }],
    [{ name: 'load_handoff', args: {}, text: 'Handoff loaded.' }, { atUse: null, atResult: null }],
    [{ name: 'load_handoff', args: {}, text: '{"load_token": ' }, { atUse: null, atResult: null }],
    [{ name: 'mcp__session-watcher__load_handoff', args: {}, text: JSON.stringify({ load_token: 'lt-namespaced' }) }, { atUse: null, atResult: 'lt-namespaced' }],
    [{ name: 'bash', args: { command: 'ls' }, text: JSON.stringify({ load_token: 'lt-bash' }) }, { atUse: null, atResult: null }],
  ];

  test('registers an explicit load_token at use, resolves an auto-matched one from a JSON result and leaves a non-JSON result unresolved', () => {
    for (const [call, expected] of LOADS) {
      const observations = dshObservations(call);
      const current = currentOf(observations);
      const label = `${call.name}: ${call.text}`;
      assert.deepEqual({ atUse: current.used.telemetry.loadToken, atResult: current.done.telemetry.loadToken }, expected, label);
    }
  });

  test('a result given as content blocks resolves the token of the string form of the same text', () => {
    const call = dshObservations({ name: 'load_handoff', args: {}, text: '{"load_token":"lt-block",\n"paths":[]}' });
    const blocks = [
      { type: 'text', text: '{"load_token":"lt-block",' },
      { type: 'image', source: { data: 'x'.repeat(64) } },
      { type: 'text', text: '"paths":[]}' },
    ];
    assert.equal(currentOf(call).done.telemetry.loadToken, 'lt-block');
    assert.equal(currentOf({ use: call.use, result: { ...call.result, content: blocks } }).done.telemetry.loadToken, 'lt-block');
  });

  test('isLoadHandoffTool takes the bare tool and a namespaced one', () => {
    const { isLoadHandoffTool } = dshToolEvidenceProfile;
    assert.equal(isLoadHandoffTool('load_handoff'), true);
    assert.equal(isLoadHandoffTool('mcp__session-watcher__load_handoff'), true);
    assert.equal(isLoadHandoffTool('load_handoff_all'), false);
    assert.equal(isLoadHandoffTool('read'), false);
  });
});

describe('the non-file resource', () => {
  test('is the skill a skill call names, in the skill namespace, and nothing for any other call', () => {
    const { nonFileResource } = dshToolEvidenceProfile;
    assert.deepEqual(nonFileResource({ name: 'skill', input: { name: 'tdd' } }), { resourceKey: 'skill:tdd' });
    assert.equal(nonFileResource({ name: 'skill', input: {} }), null);
    assert.equal(nonFileResource({ name: 'skill', input: { name: '' } }), null);
    assert.equal(nonFileResource({ name: 'read', input: { name: 'tdd', file_path: 'a.js' } }), null);
    assert.equal(nonFileResource({ name: 'bash', input: { command: 'skill tdd' } }), null);
  });
});

describe('over the real matcher', () => {
  const A_JS = '/repo/src/a.js';
  const FILE = 'const a = 1;\nexport default a;\n';
  // `formatReadOutput`'s envelope around two numbered lines and the end-of-file footer.
  const READ_TEXT = '<path>/repo/src/a.js</path>\n<type>file</type>\n<content>\n1: const a = 1;\n2: export default a;\n\n'
    + '(End of file - total 2 lines)\n</content>';
  const READ_ARGS = { file_path: 'src/a.js' };

  // The read call run once against `rig`, offering what it records to `kept`.
  function readOnce(rig, kept = [], recalled = null) {
    const frameCtx = { recall: () => recalled, remember: (toolUseId, record) => kept.push([toolUseId, record]) };
    const { use, result } = dshObservations({ name: 'read', args: READ_ARGS, text: READ_TEXT });
    const { pending } = rig.interpreter.interpretToolUse(use, rig.context, { frameCtx });
    return rig.interpreter.completeToolResult(pending, result, rig.context, { frameCtx });
  }

  test('a read result attributes to the lines of the file it names, the envelope and the input staying residual', () => {
    const kept = [];
    const done = readOnce(dshRig({ files: { [A_JS]: FILE } }), kept);
    // '1: const a = 1;' is 15 characters and '2: export default a;' is 20, at a divisor of 4.
    assert.deepEqual(done.effects, [{
      access: 'read',
      overheadTokens: 0,
      spentTokens: 8.75,
      impacts: [{ resourceKey: A_JS, mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 3.75 }, { key: 2, tokens: 5 }] } }],
    }]);
    assert.deepEqual(done.residuals, [{
      groupKey: 'read',
      weight: JSON.stringify(READ_ARGS).length + READ_TEXT.length - 15 - 20,
      hadError: false,
      meta: { kind: 'tool', detail: '' },
    }]);
    assert.deepEqual(done.telemetry.pathEvents, [{ path: A_JS, rawPath: A_JS, toolType: 'read', isFullRead: 1 }]);
    const [fpOne, fpTwo] = ['const a = 1;', 'export default a;'].map(line => fingerprintOf(normalizeLine(line)));
    assert.deepEqual(kept[0][1].effects, [{
      access: 'read',
      impacts: [{
        resourceKey: A_JS,
        kind: 'replace-fragments',
        entries: [{ key: 1, chars: 15, cjk: 0, fp: fpOne }, { key: 2, chars: 20, cjk: 0, fp: fpTwo }],
      }],
    }]);
  });

  test('a record replays after the tree has lost the file, as the live partition emitted it and reading nothing', () => {
    const kept = [];
    const live = readOnce(dshRig({ files: { [A_JS]: FILE } }), kept);
    assert.equal(live.effects.length, 1, 'precondition: the live partition attributed the read');

    const reads = [];
    const emptied = treeOf({});
    const watched = {
      resolve: (...args) => { reads.push('resolve'); return emptied.resolve(...args); },
      stat: (...args) => { reads.push('stat'); return emptied.stat(...args); },
      readText: (...args) => { reads.push('readText'); return emptied.readText(...args); },
    };
    const attribution = createResourceAttribution({ workingTree: watched, limits: LIMITS });
    const rebuilt = dshRig({ attribute: attribution.attribute });

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
    readOnce(dshRig({ files: { [A_JS]: FILE } }), kept);
    const pair = {
      toolUseId: '1:1:call_1', name: 'read', input: READ_ARGS, cwd: null, result: READ_TEXT, isError: false,
    };

    const reads = [];
    const tree = treeOf({ [A_JS]: FILE });
    const watched = {
      resolve: (...args) => { reads.push('resolve'); return tree.resolve(...args); },
      stat: (...args) => { reads.push('stat'); return tree.stat(...args); },
      readText: (...args) => { reads.push('readText'); return tree.readText(...args); },
    };
    const { interpreter } = dshRig({ attribute: createResourceAttribution({ workingTree: watched, limits: LIMITS }).attribute });

    assert.deepEqual(interpreter.resourceKeysOf(pair, { recall: () => kept[0][1], sessionCwd: CWD }), [A_JS]);
    assert.deepEqual(reads, [], 'a record answers without a read');
    assert.deepEqual(interpreter.resourceKeysOf(pair, { recall: () => null, sessionCwd: CWD }), [A_JS]);
    assert.notDeepEqual(reads, [], 'a miss reads the tree');
    // A relative path needs a base: a pair that names its file only so has the file when the session has a
    // directory and none when it has not.
    const cat = { toolUseId: '1:1:call_2', name: 'bash', input: { command: 'cat src/a.js' }, cwd: null, result: FILE };
    assert.deepEqual(interpreter.resourceKeysOf(cat, { recall: () => null, sessionCwd: CWD }), [A_JS]);
    assert.deepEqual(interpreter.resourceKeysOf(cat, { recall: () => null, sessionCwd: null }), []);
  });

  test('a heredoc that writes a file and the cat that shows it count one edit and one read', () => {
    const NOTES = 'alpha\nbeta\ngamma\ndelta\n';
    const rig = dshRig({ files: { '/repo/notes.txt': NOTES } });
    const engine = makeEngine();
    engine.ingest([stepOf('m1', 100_000)]);
    const command = `cat > notes.txt <<'EOF'\n${NOTES}EOF\ncat notes.txt`;
    const { use, result } = dshObservations({ name: 'bash', args: { command }, text: NOTES });
    engine.ingest([use, result].flatMap(observation => rig.projection.project(observation, {}).records));
    const row = rowOf(engine, '/repo/notes.txt');
    assert.deepEqual(
      [row.readCount, row.editCount, row.pureRereads, row.lineNumbers],
      [1, 1, 0, [1, 2, 3, 4]],
    );
  });
});
