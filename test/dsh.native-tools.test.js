// DSH native tool interpretation through the shared Measurement Projection it plugs into: each call is the
// DSH `assistant/message` issuing one tool call and the `tool/result` answering it, reduced by the DSH
// reducer, and every effect, residual and path event is read off what the projection emits. The model policy
// resolver is a fake answering a distinct CTP per model, so every token value is priced from the rule a test
// states.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';

import { createMeasurementProjection } from '../lib/measurement-projection.js';
import {
  interpretDshToolUse,
  completeDshToolResult,
  resolveDshToolTarget,
  classifyDshToolPair,
} from '../lib/harness/dsh/native-tools.js';
import { reduceDshEvent } from '../lib/harness/dsh/transcript-observation.js';
import { bashFeature } from '../lib/bash-feature.js';
import { charsToTokens } from '../lib/token-estimate.js';
import { TOOL_OVERHEAD } from '../lib/constants.js';
import { assistantMessage, toolResult } from './helpers/dsh-events.js';

const MODEL = 'deepseek-v4-pro';
const OTHER_MODEL = 'deepseek-v4-flash';
const CTP_BY_MODEL = new Map([
  [MODEL, { ascii: 4, cjk: 1.5 }],
  [OTHER_MODEL, { ascii: 2.5, cjk: 0.75 }],
]);
const FALLBACK_CTP = { ascii: 3, cjk: 1 };
const CTP = CTP_BY_MODEL.get(MODEL);

function resolveModelPolicy(modelId) {
  return { ctp: CTP_BY_MODEL.get(modelId) ?? FALLBACK_CTP };
}

function makeContext() {
  return { path: nodePath, sessionCwd: '/repo', resolveModelPolicy };
}

function makeProjection() {
  const payloadCalls = [];
  const projection = createMeasurementProjection({
    scope: 'dsh-native-tools-test',
    context: makeContext(),
    captureSources: { live: 'dsh-live', replay: 'dsh-replay' },
    interpretToolUse: interpretDshToolUse,
    completeToolResult: completeDshToolResult,
    interpretSkillPayload: (...args) => {
      payloadCalls.push(args);
      return { effects: [], residuals: [], telemetry: null };
    },
  });
  return { projection, payloadCalls };
}

// One call as DSH logs it, projected in order. A string `args` is the raw argument text the model sent.
function projectCall({ name, args = {}, text, isError = false, error, meta, model = MODEL }) {
  const { projection, payloadCalls } = makeProjection();
  const issued = reduceDshEvent(assistantMessage({
    model,
    toolCalls: [{ id: 'call_1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }],
  })).observations;
  const answered = reduceDshEvent(toolResult({ callId: 'call_1', text, isError, error, meta })).observations;
  const records = [...issued, ...answered].flatMap(observation => projection.project(observation).records);
  const use = issued.find(observation => observation.type === 'tool-use');
  return { projection, payloadCalls, use, result: answered[0], records };
}

// The call projected, then its segment closed on the step the issuing message is, which is where the Segment
// Telemetry sidecar joins the call's path events and load token.
function runCall(options) {
  const call = projectCall(options);
  const step = { id: call.use.messageId, foldedSeq: 1, timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const { payload } = call.projection.finishSegment({ segment: 1, steps: [step] }).artifact;
  return {
    ...call,
    effects: call.records.filter(record => record.type === 'effect'),
    residuals: call.records.filter(record => record.type === 'residual'),
    pathEvents: payload.events.map(({ path, rawPath, toolType, isFullRead }) => ({ path, rawPath, toolType, isFullRead })),
    loadToken: payload.steps[0].loadToken,
  };
}

function onlyEffect(call) {
  assert.equal(call.effects.length, 1, 'exactly one effect');
  return call.effects[0];
}

function onlyImpact(call) {
  const { impacts } = onlyEffect(call);
  assert.equal(impacts.length, 1, 'exactly one impact');
  return impacts[0];
}

const fragment = (key, rendered, ctp = CTP) => ({ key, tokens: charsToTokens(rendered, ctp) });
const tokensOf = fragments => fragments.reduce((sum, { tokens }) => sum + tokens, 0);

// `formatReadOutput`'s envelope: the numbered lines, a blank line and the footer, or the footer alone.
function readText(path, lines, footer) {
  const body = lines.length > 0
    ? `${lines.map(([number, text]) => `${number}: ${text}`).join('\n')}\n\n${footer}`
    : footer;
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

const endOfFile = total => `(End of file - total ${total} lines)`;
const writeText = path => `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`;
const editText = path => `The file ${path} has been updated successfully.`;
const SPILL_NOTICE = '(Omitted 4096 bytes. Full formatted result stored at: /tmp/dsh-spill/result-1.txt. '
  + 'Read it with offset and limit to page through it.)';
const SKILL_TEXT = [
  '<skill_content name="tdd">', '<skill_resources>', '</skill_resources>', '',
  '<skill_instructions>', '# Test-Driven Development', 'Red, then green.', '</skill_instructions>', '</skill_content>',
].join('\n');

// `formatGrepOutput`'s text: the found-count header, one section per file — its path, then its `Line N: text`
// rows — and the recovery footer of a capped result, every part separated by a blank line.
const GREP_TEXT = [
  'Found 3 of 7 matches',
  'src/a.js\nLine 3: const a = 1;\nLine 9: a += 1;',
  '/elsewhere/b.js\nLine 1: import a from "../repo/src/a.js";',
  '(Full grep result stored at: /tmp/dsh-spill/grep-1.txt. Read it with offset and limit to page through it.)',
].join('\n\n');

describe('effect tools', () => {
  test('a read yields one fragment per numbered line and a full read only from line one to the end-of-file footer', () => {
    const lines = [[1, 'const a = 1;'], [2, 'export default a;']];
    const full = runCall({ name: 'read', args: { file_path: 'src/a.js' }, text: readText('/repo/src/a.js', lines, endOfFile(2)) });
    const fragments = [fragment(1, '1: const a = 1;'), fragment(2, '2: export default a;')];
    assert.deepEqual(full.effects, [{
      type: 'effect',
      access: 'read',
      overheadTokens: TOOL_OVERHEAD.Read,
      spentTokens: tokensOf(fragments) + TOOL_OVERHEAD.Read,
      impacts: [{ resourceKey: '/repo/src/a.js', mutation: { kind: 'replace-fragments', fragments } }],
    }]);
    assert.deepEqual(full.residuals, []);
    assert.deepEqual(full.pathEvents, [{ path: '/repo/src/a.js', rawPath: 'src/a.js', toolType: 'read', isFullRead: 1 }]);

    const windows = [
      { args: { file_path: 'src/a.js', limit: 2 }, text: readText('/repo/src/a.js', lines, '(Showing lines 1-2 of 5. Use offset=3 to continue.)') },
      { args: { file_path: 'src/a.js' }, text: readText('/repo/src/a.js', lines, '(Output capped. Showing lines 1-2. Use offset=3 to continue.)') },
      { args: { file_path: 'src/a.js', offset: 4 }, text: readText('/repo/src/a.js', [[4, 'a += 1;'], [5, 'a *= 2;']], endOfFile(5)) },
    ];
    for (const { args, text } of windows) {
      const partial = runCall({ name: 'read', args, text });
      assert.equal(onlyImpact(partial).mutation.kind, 'merge-fragments', text);
      assert.deepEqual(partial.pathEvents.map(event => event.isFullRead), [0], text);
    }
    const tail = runCall({ name: 'read', args: { file_path: 'src/a.js', offset: 4 }, text: windows[2].text });
    assert.deepEqual(onlyImpact(tail).mutation.fragments, [fragment(4, '4: a += 1;'), fragment(5, '5: a *= 2;')]);
  });

  test('a read ignores its meta', () => {
    const call = runCall({
      name: 'read',
      args: { file_path: 'src/a.js' },
      text: readText('/repo/src/a.js', [[1, 'const a = 1;']], endOfFile(1)),
      meta: {
        path: '/repo/src/a.js', offset: 1, totalLines: 2,
        lines: [{ number: 1, text: 'x'.repeat(400) }, { number: 2, text: 'const b = 2;' }],
      },
    });
    assert.deepEqual(onlyImpact(call).mutation.fragments, [fragment(1, '1: const a = 1;')]);
  });

  test('a read is priced under the policy of the model that issued it', () => {
    const text = readText('/repo/src/a.js', [[1, '常量 a 等于一']], endOfFile(1));
    const tokensUnder = model => onlyImpact(runCall({ name: 'read', args: { file_path: 'src/a.js' }, text, model }))
      .mutation.fragments[0].tokens;
    assert.equal(tokensUnder(MODEL), charsToTokens('1: 常量 a 等于一', CTP_BY_MODEL.get(MODEL)));
    assert.equal(tokensUnder(OTHER_MODEL), charsToTokens('1: 常量 a 等于一', CTP_BY_MODEL.get(OTHER_MODEL)));
    assert.notEqual(tokensUnder(MODEL), tokensUnder(OTHER_MODEL));
  });

  test('write and edit yield a write effect on the target', () => {
    const write = runCall({
      name: 'write', args: { file_path: 'src/new.js', content: 'const b = 2;\n' }, text: writeText('/repo/src/new.js'),
    });
    assert.equal(onlyEffect(write).access, 'write');
    assert.equal(onlyEffect(write).overheadTokens, TOOL_OVERHEAD.Write);
    assert.equal(onlyImpact(write).resourceKey, '/repo/src/new.js');
    assert.equal(onlyImpact(write).mutation.kind, 'replace-fragments');
    assert.deepEqual(write.pathEvents, [{ path: '/repo/src/new.js', rawPath: 'src/new.js', toolType: 'write', isFullRead: null }]);

    const oldString = 'const a = 1;';
    const newString = 'const a = 2;\nconst c = 3;';
    const editCtp = CTP_BY_MODEL.get(OTHER_MODEL);
    const edit = runCall({
      name: 'edit',
      args: { file_path: 'lib/notes.js', old_string: oldString, new_string: newString },
      text: editText('/repo/lib/notes.js'),
      model: OTHER_MODEL,
    });
    assert.equal(onlyEffect(edit).access, 'write');
    assert.equal(onlyEffect(edit).spentTokens,
      charsToTokens(oldString, editCtp) + charsToTokens(newString, editCtp) + TOOL_OVERHEAD.Edit);
    assert.equal(onlyImpact(edit).resourceKey, '/repo/lib/notes.js');
    assert.equal(onlyImpact(edit).mutation.kind, 'adjust-total');
    // The replacement adds one line, and an added line brings the line-number prefix a read renders.
    assert.equal(onlyImpact(edit).mutation.deltaTokens,
      charsToTokens(newString, editCtp) - charsToTokens(oldString, editCtp) + 1 * (4 / editCtp.ascii));
    assert.deepEqual(edit.pathEvents, [{ path: '/repo/lib/notes.js', rawPath: 'lib/notes.js', toolType: 'edit', isFullRead: null }]);
  });

  test('a write prices the lines a read would render and no phantom line for the trailing newline', () => {
    const write = runCall({
      name: 'write', args: { file_path: 'src/a.js', content: 'const a = 1;\nexport default a;\n' },
      text: writeText('/repo/src/a.js'),
    });
    const read = runCall({
      name: 'read',
      args: { file_path: 'src/a.js' },
      text: readText('/repo/src/a.js', [[1, 'const a = 1;'], [2, 'export default a;']], endOfFile(2)),
    });
    const fragments = [fragment(1, '1: const a = 1;'), fragment(2, '2: export default a;')];
    assert.deepEqual(onlyImpact(write).mutation.fragments, fragments);
    assert.deepEqual(onlyImpact(read).mutation.fragments, fragments);
    assert.equal(onlyEffect(write).spentTokens, tokensOf(fragments) + TOOL_OVERHEAD.Write);

    const unterminated = runCall({ name: 'write', args: { file_path: 'src/b.js', content: 'a\nb' }, text: writeText('/repo/src/b.js') });
    assert.deepEqual(onlyImpact(unterminated).mutation.fragments, [fragment(1, '1: a'), fragment(2, '2: b')]);
  });

  test('grep yields one read effect with one impact per file section', () => {
    const call = runCall({ name: 'grep', args: { pattern: 'a' }, text: GREP_TEXT });
    const a = [fragment(3, '3: const a = 1;'), fragment(9, '9: a += 1;')];
    const b = [fragment(1, '1: import a from "../repo/src/a.js";')];
    assert.deepEqual(call.effects, [{
      type: 'effect',
      access: 'read',
      overheadTokens: TOOL_OVERHEAD.Grep,
      spentTokens: tokensOf(a) + tokensOf(b) + TOOL_OVERHEAD.Grep,
      impacts: [
        { resourceKey: '/repo/src/a.js', mutation: { kind: 'merge-fragments', fragments: a } },
        { resourceKey: '/elsewhere/b.js', mutation: { kind: 'merge-fragments', fragments: b } },
      ],
    }]);
    assert.deepEqual(call.pathEvents, [
      { path: '/repo/src/a.js', rawPath: '/repo/src/a.js', toolType: 'grep', isFullRead: 0 },
      { path: '/elsewhere/b.js', rawPath: '/elsewhere/b.js', toolType: 'grep', isFullRead: 0 },
    ]);
  });

  // The spill policy keeps a head and a tail of the text around a `[...]` gap and appends its notice last.
  test('a spill-truncated grep counts only the sections the model saw', () => {
    const head = 'Found 40 matches\n\nsrc/a.js\nLine 3: const a = 1;';
    const tail = 'Line 30: a += 30;\nLine 31: a -= 1;\n\nlib/b.js\nLine 7: b();';
    const call = runCall({ name: 'grep', args: { pattern: 'a' }, text: `${head}\n\n[...]\n\n${tail}\n\n${SPILL_NOTICE}` });
    assert.deepEqual(onlyEffect(call).impacts, [
      { resourceKey: '/repo/src/a.js', mutation: { kind: 'merge-fragments', fragments: [fragment(3, '3: const a = 1;')] } },
      { resourceKey: '/repo/lib/b.js', mutation: { kind: 'merge-fragments', fragments: [fragment(7, '7: b();')] } },
    ]);
    assert.deepEqual(call.pathEvents.map(event => event.path), ['/repo/src/a.js', '/repo/lib/b.js']);
  });

  test('skill yields its effect from the result and arms no payload continuation', () => {
    const call = projectCall({ name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT });
    const tokens = charsToTokens(SKILL_TEXT, CTP);
    assert.deepEqual(call.records, [{
      type: 'effect',
      access: 'read',
      overheadTokens: TOOL_OVERHEAD.Read,
      spentTokens: tokens + TOOL_OVERHEAD.Read,
      impacts: [{ resourceKey: 'skill:tdd', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
    }]);

    const late = call.projection.project({ type: 'skill-payload', toolUseId: call.use.toolUseId, text: 'late payload' });
    assert.deepEqual(late.records, []);
    assert.equal(call.payloadCalls.length, 0, 'no payload phase awaits the skill');
    const { pending } = interpretDshToolUse(call.use, makeContext());
    assert.equal(completeDshToolResult(pending, call.result, makeContext()).skillContinuation, null);
  });

  test('a file tool result without priceable content yields nothing', () => {
    const cases = [
      { name: 'read', args: { file_path: 'src/empty.js' }, text: readText('/repo/src/empty.js', [], endOfFile(0)) },
      { name: 'grep', args: { pattern: 'nope' }, text: 'No matches found' },
      {
        name: 'read', args: { file_path: 'src/missing.js' }, text: 'Error: cannot read "src/missing.js": not found',
        isError: true, error: { name: 'FsError', code: 'FS_NOT_FOUND' },
      },
      { name: 'grep', args: { pattern: 'a' }, text: SPILL_NOTICE },
      { name: 'write', args: { file_path: 'src/a.js', content: 'x\n' }, text: 'Error: write denied', isError: true },
      {
        name: 'edit', args: { file_path: 'src/a.js', old_string: 'x', new_string: 'y' },
        text: 'Error: old_string not found', isError: true,
      },
      { name: 'skill', args: { name: 'nope' }, text: 'Error: skill "nope" is unknown or no longer available', isError: true },
    ];
    for (const options of cases) {
      const call = runCall(options);
      const label = `${options.name}: ${options.text}`;
      assert.deepEqual(call.effects, [], label);
      assert.deepEqual(call.residuals, [], label);
      assert.deepEqual(call.pathEvents, [], label);
    }
  });
});

describe('residual families', () => {
  const residualOf = (call, args) => {
    assert.deepEqual(call.effects, []);
    assert.deepEqual(call.pathEvents, []);
    assert.equal(call.residuals.length, 1, 'exactly one residual');
    const [residual] = call.residuals;
    assert.equal(residual.weight, JSON.stringify(args).length + call.result.content.length, 'input and result bytes');
    return residual;
  };

  test('glob yields a tool residual', () => {
    const args = { pattern: 'src/**/*.js' };
    const call = runCall({ name: 'glob', args, text: 'src/a.js\nsrc/b.js' });
    const { groupKey, hadError, meta } = residualOf(call, args);
    assert.deepEqual({ groupKey, hadError, meta }, { groupKey: 'glob', hadError: false, meta: { kind: 'tool', detail: '' } });
  });

  test('bash yields a bash residual named by the shared feature extraction', () => {
    const command = 'cd /repo && npm test -- --grep parser';
    const args = { command, description: 'Run the parser tests' };
    const feature = bashFeature(command);
    assert.notEqual(feature.name, '(bash)', 'precondition: the command names a feature');
    const { groupKey, hadError, meta } = residualOf(runCall({ name: 'bash', args, text: 'ok 1 - parser\n' }), args);
    assert.deepEqual({ groupKey, hadError, meta }, { groupKey: feature.name, hadError: false, meta: { kind: 'bash', detail: feature.detail } });
  });

  test('an mcp__ tool yields an mcp residual', () => {
    const args = { query: 'is:open label:bug' };
    const { groupKey, meta } = residualOf(runCall({ name: 'mcp__github__search_issues', args, text: '[]' }), args);
    assert.deepEqual({ groupKey, meta }, { groupKey: 'github__search_issues', meta: { kind: 'mcp', detail: '' } });
  });

  test('subagent, subagent_fork, workflow and send_message yield agent residuals', () => {
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'send_message']) {
      const args = { prompt: 'Survey the parser.' };
      const { groupKey, meta } = residualOf(runCall({ name, args, text: 'The parser has two entry points.' }), args);
      assert.deepEqual({ groupKey, meta }, { groupKey: name, meta: { kind: 'agent', detail: '' } }, name);
    }
  });

  test('every other tool yields a tool residual', () => {
    for (const name of ['ask_user_question', 'web_fetch', 'todo_write', 'str_replace_editor', 'job_output']) {
      const args = { id: 'x' };
      const { groupKey, meta } = residualOf(runCall({ name, args, text: 'done' }), args);
      assert.deepEqual({ groupKey, meta }, { groupKey: name, meta: { kind: 'tool', detail: '' } }, name);
    }
  });

  test('an errored residual-family result keeps its residual and marks hadError', () => {
    const cases = [
      ['bash', { command: 'npm test' }, 'Error: spawn /bin/bash ENOENT', 'bash'],
      ['mcp__github__search_issues', { query: 'x' }, 'Error: rate limited', 'mcp'],
      ['subagent', { prompt: 'x' }, 'Error: the subagent failed', 'agent'],
      ['web_fetch', { url: 'https://example.com' }, 'Error: fetch failed', 'tool'],
    ];
    for (const [name, args, text, kind] of cases) {
      const call = runCall({ name, args, text, isError: true, error: { name: 'ToolError', code: 'FAILED' } });
      const { hadError, meta } = residualOf(call, args);
      assert.deepEqual({ hadError, kind: meta.kind }, { hadError: true, kind }, name);
    }
  });
});

describe('telemetry', () => {
  test('a load_handoff result carries its load token in telemetry', () => {
    const matched = runCall({ name: 'load_handoff', args: {}, text: JSON.stringify({ load_token: 'lt-matched', paths: [] }) });
    assert.equal(matched.loadToken, 'lt-matched');
    const named = runCall({ name: 'load_handoff', args: { load_token: 'lt-named' }, text: 'Handoff loaded.' });
    assert.equal(named.loadToken, 'lt-named');
  });
});

// The reducer hands a tool the value its arguments parse to, which need not be an object, or their raw text.
test('a tool use whose arguments are not an object interprets without throwing', () => {
  const read = runCall({ name: 'read', args: 'null', text: readText('/repo/src/a.js', [[1, 'x']], endOfFile(1)) });
  assert.deepEqual([read.effects, read.residuals], [[], []]);
  for (const args of ['null', '{"command": "npm te']) {
    const bash = runCall({ name: 'bash', args, text: 'ok' });
    assert.deepEqual(bash.residuals.map(residual => residual.meta.kind), ['bash'], args);
  }
  assert.equal(runCall({ name: 'load_handoff', args: 'null', text: 'Handoff loaded.' }).loadToken, null);
  assert.equal(resolveDshToolTarget({ name: 'read', input: null, cwd: null }, makeContext()), null);
  assert.equal(resolveDshToolTarget({ name: 'skill', input: 'tdd', cwd: null }, makeContext()), null);
});

describe('target and classification', () => {
  test('resolveDshToolTarget keeps an absolute path and resolves any other against the session cwd', () => {
    const context = makeContext();
    const target = (name, input, cwd = null) => resolveDshToolTarget({ name, input, cwd }, context);
    assert.equal(target('read', { file_path: 'src/a.js' }), '/repo/src/a.js');
    assert.equal(target('edit', { file_path: './src/../lib/b.js' }), '/repo/lib/b.js');
    assert.equal(target('read', { file_path: '/etc/../etc/hosts' }), '/etc/hosts');
    assert.equal(target('read', { file_path: 'src/a.js' }, '/other'), '/other/src/a.js', 'a row cwd precedes the session cwd');
    assert.equal(target('skill', { name: 'tdd' }), 'skill:tdd');
    for (const [name, input] of [['grep', { pattern: 'a' }], ['glob', { pattern: '*' }], ['bash', { command: 'cat a' }], ['read', {}]]) {
      assert.equal(target(name, input), null, name);
    }
  });

  test('classifyDshToolPair sorts path, skill and residual', () => {
    const read = readText('/repo/src/a.js', [[1, 'const a = 1;']], endOfFile(1));
    const readPair = { name: 'read', input: { file_path: 'src/a.js' }, result: read, resourceKey: '/repo/src/a.js' };
    const cases = [
      [readPair, 'path'],
      [{ ...readPair, isError: true }, 'residual'],
      [{ ...readPair, result: readText('/repo/src/a.js', [], endOfFile(0)) }, 'residual'],
      [{ ...readPair, result: null }, 'residual'],
      [{ ...readPair, resourceKey: null }, 'residual'],
      [{ name: 'grep', input: { pattern: 'a' }, result: GREP_TEXT, resourceKey: null }, 'path'],
      [{ name: 'grep', input: { pattern: 'a' }, result: 'No matches found', resourceKey: null }, 'residual'],
      [{ name: 'write', input: { file_path: 'src/a.js', content: 'x\n' }, result: writeText('/repo/src/a.js'), resourceKey: '/repo/src/a.js' }, 'path'],
      [{
        name: 'edit', input: { file_path: 'src/a.js', old_string: 'x', new_string: 'y' },
        result: editText('/repo/src/a.js'), resourceKey: '/repo/src/a.js',
      }, 'path'],
      [{ name: 'skill', input: { name: 'tdd' }, result: SKILL_TEXT, resourceKey: 'skill:tdd' }, 'skill'],
      [{ name: 'glob', input: { pattern: '*' }, result: 'src/a.js', resourceKey: null }, 'residual'],
      [{ name: 'bash', input: { command: 'cat src/a.js' }, result: 'const a = 1;', resourceKey: null }, 'residual'],
      [{ name: 'mcp__github__search_issues', input: {}, result: '[]', resourceKey: null }, 'residual'],
    ];
    cases.forEach(([pair, expected], index) => {
      assert.equal(classifyDshToolPair(pair, CTP), expected, `case ${index}: ${pair.name}`);
    });
  });
});
