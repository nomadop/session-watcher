// test/claude-code.history-turn-rules.test.js — the Claude Code History Turn rules and the Dialogue
// Adapter that binds them. The two rules are the only place a native command echo, a native tool name or
// a native answer structure is read; shared grouping sees a classification and a text and nothing else.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClaudeCodeAskHeadRule,
  createClaudeCodeDialogueProjection,
  createClaudeCodeHumanHeadRule,
} from '../lib/harness/claude-code/history-turn-rules.js';
import { ABSORB, PASS, applyHeadRules } from '../lib/turn.js';
import { enumerateDialogueLines } from '../lib/dialogue-fold.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, ts, userMessage,
} from './helpers/transcript-fixtures.js';

const projection = createClaudeCodeDialogueProjection({ sessionCwd: '/project' });
const linesOf = (entries) => enumerateDialogueLines(projection.project(observationsOf(entries)).folds);
const turnsOf = (entries) => projection.groupTurns(linesOf(entries));

const humanRule = createClaudeCodeHumanHeadRule();
const askRule = createClaudeCodeAskHeadRule();
// The rule's whole Interface is one line, so a human-text case is stated as the line it judges.
const humanText = (text) => humanRule({ kind: 'visible', message: { role: 'human', text } });

// ── The human rule ─────────────────────────────────────────────────────────────

describe('the Claude Code human head rule', () => {
  test('human prose quoting a command tag is a HEAD and keeps its whole text', () => {
    const r = humanText('我们要不要把 <command-name>/clear</command-name> 也算成 head U？');
    assert.equal(r.kind, 'HEAD');
    assert.ok(r.text.includes('我们要不要把'));
    assert.ok(r.text.includes('也算成 head U？'));
  });

  test('a bare command is stripped to its name', () => {
    assert.deepEqual(humanText('<command-name>/clear</command-name>'), { kind: 'HEAD', text: '/clear' });
  });

  test('a command and its args join as `name args`', () => {
    assert.equal(humanText('<command-name>/model</command-name><command-args>opus</command-args>').text,
      '/model opus');
  });

  test('several command names are all retained in order', () => {
    assert.equal(humanText('<command-name>/a</command-name><command-name>/b</command-name>').text,
      '/a — /b');
  });

  test('a bash-input segment keeps its `!` marker', () => {
    assert.equal(humanText('<bash-input>ls -la</bash-input>').text, '!ls -la');
  });

  test('the three absorbed classes carry no text at all', () => {
    for (const raw of [
      '[Request interrupted by user]',
      '<local-command-stdout>ok</local-command-stdout>',
      '<system-reminder>x</system-reminder>',
    ]) {
      assert.deepEqual(humanText(raw), ABSORB);
      assert.equal('text' in humanText(raw), false);
    }
  });

  test('absorption is judged on the residue, not on the presence of a tag', () => {
    const r = humanText('看 <local-command-stdout>ok</local-command-stdout> 这段输出说明什么');
    assert.equal(r.kind, 'HEAD');
    assert.ok(r.text.includes('这段输出说明什么'));
  });

  test('a bare `Caveat:` line is prose: neither stripped nor absorbed', () => {
    const r = humanText('第一行\nCaveat: 注意这个\n第三行');
    assert.equal(r.kind, 'HEAD');
    assert.ok(r.text.includes('Caveat: 注意这个'));
    assert.equal(humanText('Caveat: 别用 rm -rf').kind, 'HEAD');
  });

  test('an empty projection absorbs: an empty command name and a lone args block both open nothing', () => {
    assert.deepEqual(humanText('<command-name></command-name>'), ABSORB);
    assert.deepEqual(humanText('<command-args>opus</command-args>'), ABSORB);
  });

  test('the human rule passes on every line it does not own', () => {
    assert.deepEqual(humanRule({ kind: 'visible', message: { role: 'assistant', text: 'answer' } }), PASS);
    assert.deepEqual(humanRule({ kind: 'tool', message: null, tool: { name: 'Bash' } }), PASS);
  });
});

// ── The `/exit` echo ───────────────────────────────────────────────────────────

describe('the session-ending command echo', () => {
  test("the harness's own `/exit` echo is an ACK", () => {
    const r = humanText('<command-name>/exit</command-name>\n<command-message>exit</command-message>'
      + '\n<command-args></command-args>');
    assert.deepEqual(r, { kind: 'ACK', text: '/exit' });
  });

  test('human prose quoting the echo tag stays a HEAD', () => {
    // One half of the conjunction: prose that quotes the tag keeps residue, so its projection is not
    // bare `/exit`.
    const r = humanText('要不要把 <command-name>/exit</command-name> 也算成无槽的？');
    assert.equal(r.kind, 'HEAD');
  });

  test('a human message whose whole body is literally `/exit` stays a HEAD', () => {
    // The other half: the projection does read `/exit`, and the raw text carries no command tag.
    assert.deepEqual(humanText('/exit'), { kind: 'HEAD', text: '/exit' });
  });

  test('an ACK opens a Turn that keeps its lines and accumulates no assistant activity', () => {
    // The real trio (caveat / command echo / stdout) is written into the transcript the session is about
    // to abandon; a `claude -c` resume back into the same file appends an assistant reply parented to the
    // stdout row, so that reply lands inside the `/exit` Turn.
    const turns = turnsOf(chain([
      userMessage({ uuid: 'xe-u1', text: 'deploy 完了，重启一下', timestamp: ts(1) }),
      assistantObservation({ uuid: 'xe-a1', messageId: 'xe-m1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'deployed' }] }),
      userMessage({ uuid: 'xe-cav', timestamp: ts(3),
        text: '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>' }),
      userMessage({ uuid: 'xe-cmd', timestamp: ts(4),
        text: '<command-name>/exit</command-name>\n<command-message>exit</command-message>'
          + '\n<command-args></command-args>' }),
      userMessage({ uuid: 'xe-out', timestamp: ts(5),
        text: '<local-command-stdout>Catch you later!</local-command-stdout>' }),
      assistantObservation({ uuid: 'xe-a2', messageId: 'xe-m2', timestamp: ts(6),
        blocks: [{ type: 'text', text: 'No response requested.' }] }),
      userMessage({ uuid: 'xe-u2', text: 'resume 之后接着干', timestamp: ts(7) }),
      assistantObservation({ uuid: 'xe-a3', messageId: 'xe-m3', timestamp: ts(8),
        blocks: [{ type: 'text', text: 'ok' }] }),
    ]));
    assert.deepEqual(turns.map(t => t.cleanedU),
      ['deploy 完了，重启一下', '/exit', 'resume 之后接着干']);
    assert.deepEqual(turns.map(t => t.classification), ['HEAD', 'ACK', 'HEAD']);
    assert.deepEqual(turns.map(t => t.hasAssistantActivity), [true, false, true]);
    // Every line of the echo Turn is retained, the appended assistant reply included.
    assert.deepEqual(turns[1].lines.map(l => l.sourceEntryId), ['xe-cmd', 'xe-out', 'xe-a2']);
    assert.equal(turns.reduce((n, t) => n + t.lines.length, 0), 8);
  });

  test('an ask head whose projection happens to read `/exit` still accumulates activity', () => {
    // A degraded ask head's projection can be any envelope text, this one included. It is a ratified
    // human intent, so the classification test may not key on the string.
    const turn = turnsOf(chain([
      userMessage({ uuid: 'xa-u', text: '开始', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'xa-ask', messageId: 'xa-m', toolUseId: 'xa-tu',
        name: 'AskUserQuestion', input: { questions: [] }, timestamp: ts(2) }),
      toolResult({ uuid: 'xa-ans', toolUseId: 'xa-tu', content: '/exit', timestamp: ts(3) }),
      assistantObservation({ uuid: 'xa-a', messageId: 'xa-m2', timestamp: ts(4),
        blocks: [{ type: 'text', text: '照办' }] }),
    ])).find(t => t.cleanedU === '/exit');
    assert.equal(turn.classification, 'HEAD');
    assert.equal(turn.lines[0].message, null, 'the ask head is a tool line and has no message to read');
    assert.equal(turn.hasAssistantActivity, true);
  });
});

// ── The Ask rule ───────────────────────────────────────────────────────────────

const ONE_Q = {
  questions: [{ question: '开场保留多少铺垫？', header: '开场形态', options: [], multiSelect: false }],
  answers: { '开场保留多少铺垫？': '压缩钩子 1–2 页' },
  annotations: {},
};

const askExchange = ({ toolUseId = 'tu1', envelope, toolUseResult, isError, answerTs = ts(9) }) => chain([
  userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
  assistantToolUse({ uuid: 'ask1', messageId: 'm1', toolUseId, name: 'AskUserQuestion',
    input: { questions: [] }, timestamp: ts(2) }),
  toolResult({ uuid: 'ans1', toolUseId, content: envelope, isError, timestamp: answerTs, toolUseResult }),
]);
const askLineOf = (opts) => linesOf(askExchange(opts)).find(l => l.kind === 'tool');
const askResult = (opts) => askRule(askLineOf(opts));

describe('the Claude Code Ask head rule', () => {
  test('a single answered question projects as `header → answer`', () => {
    const r = askResult({ envelope: 'Your questions have been answered: "开场保留多少铺垫？"='
      + '"压缩钩子 1–2 页". You can now continue with these answers in mind.', toolUseResult: ONE_Q });
    assert.deepEqual(r, { kind: 'HEAD', text: '开场形态 → 压缩钩子 1–2 页' });
  });

  test('several answers join with " — " in the answers key order', () => {
    const r = askResult({ envelope: 'envelope', toolUseResult: {
      questions: [{ question: 'Q1', header: '开场形态' }, { question: 'Q2', header: 'Demo 形式' }],
      answers: { Q1: 'A1', Q2: 'A2' },
    } });
    assert.equal(r.text, '开场形态 → A1 — Demo 形式 → A2');
  });

  test('typed notes follow the answer, and the placeholder is neither parsed nor stripped', () => {
    const r = askResult({ envelope: 'envelope', toolUseResult: {
      questions: [{ question: 'Q1', header: '术语对齐' }],
      answers: { Q1: '(notes only)' },
      annotations: { Q1: { notes: 'B不是有效上下文，L-B才是' } },
    } });
    assert.equal(r.text, '术语对齐 → (notes only) · B不是有效上下文，L-B才是');
  });

  test('an unavailable header falls back to the question text rather than dropping the pair', () => {
    const r = askResult({ envelope: 'envelope', toolUseResult: {
      questions: [], answers: { '这个问题没有对应的 header': '答案' },
    } });
    assert.equal(r.text, '这个问题没有对应的 header → 答案');
  });

  test('a native error absorbs: an ESC dismissal and a validation failure are not ratifications', () => {
    for (const envelope of [
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      '<tool_use_error>InputValidationError: AskUserQuestion failed</tool_use_error>',
    ]) {
      assert.deepEqual(askResult({ envelope, isError: true }), ABSORB);
    }
  });

  test('an unreadable structure degrades to the bounded raw envelope, parsing nothing', () => {
    const envelope = 'Your questions have been answered: "Q"="A". You can now continue.';
    assert.deepEqual(askResult({ envelope }), { kind: 'HEAD', text: envelope });
    assert.deepEqual(askResult({ envelope, toolUseResult: { answers: ['A'] } }),
      { kind: 'HEAD', text: envelope });
  });

  test('the raw fallback is bounded at both ends with one marker between them', () => {
    const envelope = 'H'.repeat(300) + 'MIDDLE' + 'T'.repeat(300);
    const r = askResult({ envelope });
    assert.equal(r.kind, 'HEAD');
    assert.equal(r.text.length, 401);
    assert.ok(r.text.startsWith('H'.repeat(200)));
    assert.ok(r.text.endsWith('T'.repeat(200)));
    assert.ok(!r.text.includes('MIDDLE'));
    assert.equal(r.text.split('…').length, 2);
  });

  test('a readable structure that projects to nothing absorbs rather than resurrecting the envelope', () => {
    assert.deepEqual(askResult({ envelope: '这段信封原文不该出现在 u_text 里',
      toolUseResult: { answers: {} } }), ABSORB);
  });

  test('a question with no paired result row absorbs and reads nothing', () => {
    // A transcript that stops at the question: `resultMeta` is null, which is distinct from a result row
    // that carried no annotation.
    const line = linesOf(askExchange({ envelope: 'envelope', toolUseResult: ONE_Q }).slice(0, -1))
      .find(l => l.kind === 'tool');
    assert.equal(line.tool.resultMeta, null);
    assert.deepEqual(askRule(line), ABSORB);
  });

  test('the Ask rule passes on an unfamiliar tool and on every visible line', () => {
    const bashLine = linesOf(chain([
      userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 'tu1', name: 'Bash',
        input: { command: 'ls' }, timestamp: ts(2) }),
      toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'out' }),
    ])).find(l => l.kind === 'tool');
    assert.deepEqual(askRule(bashLine), PASS);
    assert.deepEqual(askRule({ kind: 'visible', message: { role: 'human', text: 'hi' } }), PASS);
  });

  test('the Ask rule runs after pairing: it reads the paired result, not a bare tool use', () => {
    const line = askLineOf({ envelope: 'envelope', toolUseResult: ONE_Q });
    assert.equal(line.tool.result, 'envelope');
    assert.deepEqual(line.tool.resultMeta.annotation, ONE_Q);
    assert.equal(askRule(line).kind, 'HEAD');
  });

  test('[delta] Ask head uses question tool-use position, identity, and timestamp', () => {
    // One assistant message writes its text block and its tool_use block as separate rows, and the
    // answer arrives on a third. All three source facts of the Turn Head come from the question's own
    // tool-use row: the answering row supplies ratification and text only.
    const turns = turnsOf(chain([
      userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
      assistantObservation({ uuid: 'body-row', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: '先确认一件事' }] }),
      assistantToolUse({ uuid: 'question-row', messageId: 'm1', toolUseId: 'tu1',
        name: 'AskUserQuestion', input: { questions: [] }, timestamp: ts(3) }),
      toolResult({ uuid: 'answer-row', toolUseId: 'tu1', content: 'envelope', timestamp: ts(9),
        toolUseResult: ONE_Q }),
    ]));
    const ask = turns[1];
    assert.equal(ask.cleanedU, '开场形态 → 压缩钩子 1–2 页');
    assert.equal(ask.sourceOrdinal, 3, 'the question row, not the fold body row 2');
    assert.equal(ask.sourceEntryId, 'question-row', 'the question row, not the fold body row');
    assert.equal(ask.timestamp, Date.parse(ts(3)), 'the question row, not the answering row');
    assert.notEqual(ask.timestamp, Date.parse(ts(9)));
  });

  test('a run of ratified questions yields one Turn each, none with assistant activity', () => {
    const turns = turnsOf(chain([
      userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'ask1', messageId: 'm1', toolUseId: 'tu1', name: 'AskUserQuestion',
        input: {}, timestamp: ts(2) }),
      toolResult({ uuid: 'ans1', toolUseId: 'tu1', content: 'e1', timestamp: ts(3),
        toolUseResult: { questions: [{ question: 'Q1', header: 'H1' }], answers: { Q1: 'A1' } } }),
      assistantToolUse({ uuid: 'ask2', messageId: 'm2', toolUseId: 'tu2', name: 'AskUserQuestion',
        input: {}, timestamp: ts(4) }),
      toolResult({ uuid: 'ans2', toolUseId: 'tu2', content: 'e2', timestamp: ts(5),
        toolUseResult: { questions: [{ question: 'Q2', header: 'H2' }], answers: { Q2: 'A2' } } }),
    ]));
    assert.deepEqual(turns.map(t => t.cleanedU), ['开始', 'H1 → A1', 'H2 → A2']);
    // The first question is itself a head, so it is not the opening Turn's activity either.
    assert.deepEqual(turns.map(t => t.hasAssistantActivity), [false, false, false]);
  });

  test('a dismissed question opens no Turn but still counts as the open Turn’s activity', () => {
    const turns = turnsOf(askExchange({ envelope: 'rejected', isError: true }));
    assert.equal(turns.length, 1);
    assert.equal(turns[0].cleanedU, '开始');
    assert.equal(turns[0].hasAssistantActivity, true);
    assert.equal(turns[0].lines.length, 2);
  });
});

// ── Rule ordering ──────────────────────────────────────────────────────────────

describe('ordered rule application', () => {
  test('the first non-PASS result wins and no later rule runs', () => {
    const calls = [];
    const rules = [
      (line) => { calls.push('first'); return line.kind === 'visible' ? { kind: 'HEAD', text: 'from first' } : PASS; },
      (line) => { calls.push('second'); return { kind: 'HEAD', text: 'from second' }; },
    ];
    assert.deepEqual(applyHeadRules({ kind: 'visible' }, rules), { kind: 'HEAD', text: 'from first' });
    assert.deepEqual(calls, ['first']);
    calls.length = 0;
    assert.deepEqual(applyHeadRules({ kind: 'tool' }, rules), { kind: 'HEAD', text: 'from second' });
    assert.deepEqual(calls, ['first', 'second']);
  });

  test('every rule passing leaves the line unclassified', () => {
    assert.deepEqual(applyHeadRules({ kind: 'tool' }, [() => PASS, () => PASS]), PASS);
    assert.deepEqual(applyHeadRules({ kind: 'tool' }, []), PASS);
  });

  test('an ABSORB from an earlier rule stops a later HEAD', () => {
    const rules = [() => ABSORB, () => ({ kind: 'HEAD', text: 'never' })];
    assert.deepEqual(applyHeadRules({ kind: 'visible' }, rules), ABSORB);
  });
});

// ── The bound Adapter ──────────────────────────────────────────────────────────

describe('the Claude Code Dialogue Adapter', () => {
  test('project and groupTurns need no rule argument from a consumer', () => {
    const turns = projection.groupTurns(enumerateDialogueLines(
      projection.project(observationsOf(chain([
        userMessage({ uuid: 'u1', text: '问题', timestamp: ts(1) }),
        assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
          blocks: [{ type: 'text', text: '答' }] }),
      ]))).folds));
    assert.deepEqual(turns.map(t => t.cleanedU), ['问题']);
    assert.equal(turns[0].hasAssistantActivity, true);
  });

  test('the Adapter attaches a resolved resourceKey to each paired tool line', () => {
    const folds = projection.project(observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read the store', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 'tu1', name: 'Read',
        input: { file_path: 'lib/store.js' }, timestamp: ts(2) }),
      toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'export const x = 1;' }),
      assistantToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 'tu2', name: 'Bash',
        input: { command: 'npm test' }, timestamp: ts(3) }),
      toolResult({ uuid: 'r2', toolUseId: 'tu2', content: 'ok' }),
    ]))).folds;
    const pairs = folds.flatMap(f => f.toolPairs);
    assert.equal(pairs[0].resourceKey, '/project/lib/store.js');
    // A shell command locates no file, so its pair carries no resource key at all.
    assert.equal(pairs[1].resourceKey, null);
  });

  test("a row's own working directory takes precedence over the session directory", () => {
    const folds = projection.project(observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read', timestamp: ts(1) }),
      { ...assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 'tu1', name: 'Read',
        input: { file_path: 'store.js' }, timestamp: ts(2) }), cwd: '/project/lib' },
      toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'x' }),
    ]))).folds;
    assert.equal(folds.flatMap(f => f.toolPairs)[0].resourceKey, '/project/lib/store.js');
  });

  test('an unfamiliar tool resolves to no resource key without throwing', () => {
    const folds = projection.project(observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 'tu1', name: 'mcp__unknown__thing',
        input: { whatever: 1 }, timestamp: ts(2) }),
      toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'x' }),
    ]))).folds;
    assert.equal(folds.flatMap(f => f.toolPairs)[0].resourceKey, null);
  });
});
