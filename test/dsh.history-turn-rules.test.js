// test/dsh.history-turn-rules.test.js — the DSH History Turn rules and the Dialogue Adapter that binds them,
// driven through the DSH reducer over synthetic session events.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDshAskHeadRule,
  createDshDialogueProjection,
  createDshHumanHeadRule,
} from '../lib/harness/dsh/history-turn-rules.js';
import { ABSORB, PASS } from '../lib/turn.js';
import { enumerateDialogueLines } from '../lib/dialogue-fold.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import {
  askAborted, askEmptyAnswer, assistantMessage, reusedCallIdAcrossSteps, sessionLog, toolResult, userMessage,
} from './helpers/dsh-events.js';

const projection = createDshDialogueProjection({ sessionCwd: '/repo' });
const linesOf = (events) =>
  enumerateDialogueLines(projection.project(reduceDshSnapshot(events).observations).folds);
const turnsOf = (events) => projection.groupTurns(linesOf(events));

const humanRule = createDshHumanHeadRule();
const askRule = createDshAskHeadRule();
const humanText = (text) => humanRule({ kind: 'visible', message: { role: 'human', text } });

// ── The human rule ─────────────────────────────────────────────────────────────

describe('the DSH human head rule', () => {
  test('a user-kind message heads a turn with its text', () => {
    const events = sessionLog([
      userMessage({ text: '  Where is parse defined?\n' }),
      assistantMessage({ text: 'In lib/parse.js.' }),
    ]);
    const turns = turnsOf(events);
    assert.deepEqual(turns.map(t => [t.classification, t.cleanedU]), [['HEAD', 'Where is parse defined?']]);
    assert.equal(turns[0].sourceOrdinal, events[0].seq);
    assert.equal(turns[0].hasAssistantActivity, true);
  });

  test('an empty user text is absorbed', () => {
    assert.deepEqual(humanText(' \n\t'), ABSORB);
    const turns = turnsOf(sessionLog([
      userMessage({ text: 'Review the module.' }),
      assistantMessage({ text: 'Reviewing it now.' }),
      userMessage({ text: '   ' }),
      assistantMessage({ text: 'Still reviewing.' }),
    ]));
    assert.deepEqual(turns.map(t => t.cleanedU), ['Review the module.']);
    assert.equal(turns[0].lines.length, 4);
  });

  test('there is no ACK in DSH', () => {
    for (const text of ['<command-name>/exit</command-name>', '/exit']) {
      assert.deepEqual(humanText(text), { kind: 'HEAD', text });
    }
    const turns = turnsOf(sessionLog([
      userMessage({ text: '<command-name>/exit</command-name>' }),
      assistantMessage({ text: 'No response requested.' }),
    ]));
    assert.equal(turns[0].classification, 'HEAD');
    assert.equal(turns[0].hasAssistantActivity, true);
  });
});

// ── The Ask rule ───────────────────────────────────────────────────────────────

const ASK_ARGUMENTS = JSON.stringify({
  questions: [
    { id: 'plan', question: 'Which release plan?', options: [{ label: 'Ship now' }, { label: 'Wait' }] },
    { id: 'notes', question: 'Which notes go out?', options: [{ label: 'Changelog' }, { label: 'Blog post' }],
      multi_select: true },
  ],
});

const answersJson = (answers) => JSON.stringify({ answers });
const askExchange = ({ text, isError }) => sessionLog([
  userMessage({ text: 'Help me pick a release plan.' }),
  assistantMessage({ toolCalls: [{ id: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }] }),
  toolResult({ callId: 'call_ask', text, isError }),
]);
const askLineOf = (events) => linesOf(events).find(l => l.kind === 'tool');
const askResult = (opts) => askRule(askLineOf(askExchange(opts)));

describe('the DSH Ask head rule', () => {
  test("an answered ask_user_question heads a turn with its selected answers at the asking message's seq", () => {
    const events = askExchange({ text: answersJson([
      { id: 'plan', selected: ['Ship now'], custom: '' },
      { id: 'notes', selected: ['Changelog', 'Blog post'] },
    ]) });
    const asking = events.find(e => e.type === 'assistant/message');
    const answer = events.find(e => e.type === 'tool/result');
    const turns = turnsOf(events);
    assert.deepEqual(turns.map(t => t.cleanedU),
      ['Help me pick a release plan.', 'Ship now\nChangelog\nBlog post']);
    const ask = turns[1];
    assert.equal(ask.classification, 'HEAD');
    assert.equal(ask.sourceOrdinal, asking.seq, 'the asking message, not the answering result');
    assert.notEqual(ask.sourceOrdinal, answer.seq);
    assert.equal(ask.sourceEntryId, String(asking.seq));
    assert.equal(ask.timestamp, asking.time);
  });

  test('a custom answer counts as readable', () => {
    assert.deepEqual(askResult({ text: answersJson([{ id: 'plan', selected: [], custom: 'Ship after the freeze' }]) }),
      { kind: 'HEAD', text: 'Ship after the freeze' });
    assert.deepEqual(askResult({ text: answersJson([
      { id: 'plan', selected: ['Wait'] },
      { id: 'notes', selected: [], custom: 'Only the changelog' },
    ]) }), { kind: 'HEAD', text: 'Wait\nOnly the changelog' });
  });

  test('an errored ask is absorbed', () => {
    const aborted = askAborted();
    assert.deepEqual(askRule(askLineOf(aborted)), ABSORB);
    // The abort's text holds no answer either; an error whose text holds one absorbs on the error alone.
    const errored = answersJson([{ id: 'plan', selected: ['Ship now'] }]);
    assert.deepEqual(askResult({ text: errored, isError: true }), ABSORB);
    const turns = turnsOf(aborted);
    assert.deepEqual(turns.map(t => t.cleanedU), ['Help me pick a release plan.']);
    assert.equal(turns[0].hasAssistantActivity, true);
  });

  test('an empty answer set is absorbed', () => {
    assert.deepEqual(askRule(askLineOf(askEmptyAnswer())), ABSORB);
    assert.deepEqual(askResult({ text: answersJson([]) }), ABSORB);
    assert.deepEqual(turnsOf(askEmptyAnswer()).map(t => t.cleanedU), ['Help me pick a release plan.']);
  });

  test('an unparseable answer is absorbed', () => {
    const cut = answersJson([{ id: 'plan', selected: [], custom: 'Ship after the freeze' }]).slice(0, -1);
    for (const text of [cut, 'The answer was stored elsewhere.']) {
      assert.deepEqual(askResult({ text }), ABSORB, text);
    }
  });

  test('a question with no paired result absorbs', () => {
    const line = askLineOf(sessionLog([
      userMessage({ text: 'Help me pick a release plan.' }),
      assistantMessage({ toolCalls: [{ id: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }] }),
    ]));
    assert.equal(line.tool.result, null);
    assert.deepEqual(askRule(line), ABSORB);
  });

  test('the Ask rule passes on an unfamiliar tool and on every visible line', () => {
    const bashLine = askLineOf(sessionLog([
      userMessage({ text: 'List the files.' }),
      assistantMessage({ toolCalls: [{ id: 'call_bash', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }] }),
      toolResult({ callId: 'call_bash', text: answersJson([{ id: 'plan', selected: ['Ship now'] }]) }),
    ]));
    assert.deepEqual(askRule(bashLine), PASS);
    assert.deepEqual(askRule({ kind: 'visible', message: { role: 'human', text: 'hi' } }), PASS);
  });
});

// ── The bound Dialogue Adapter ─────────────────────────────────────────────────

describe('the DSH Dialogue Adapter', () => {
  test('a provider call id reused across steps pairs each use with its own result', () => {
    const events = reusedCallIdAcrossSteps();
    const tools = linesOf(events).filter(l => l.kind === 'tool');
    const results = events.filter(e => e.type === 'tool/result');
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].tool.result, tools[1].tool.result);
    assert.deepEqual(tools.map(l => l.tool.result), results.map(e => e.data.message.content[0].text));
    assert.deepEqual(tools.map(l => l.tool.resultSourceOrdinal), results.map(e => e.seq));
  });

  test('project attaches a resourceKey to every tool pair', () => {
    const call = (id, name, input) => ({ id, name, arguments: JSON.stringify(input) });
    const events = sessionLog([
      userMessage({ text: 'Tidy the two modules.' }),
      assistantMessage({ step: 1, toolCalls: [
        call('call_read', 'read', { file_path: 'src/a.js' }),
        call('call_bash', 'bash', { command: 'npm test' }),
      ] }),
      assistantMessage({ step: 2, toolCalls: [
        call('call_edit', 'edit', { file_path: './src/../lib/b.js', old_string: 'x', new_string: 'y' }),
      ] }),
    ]);
    const pairs = projection.project(reduceDshSnapshot(events).observations).folds.flatMap(f => f.toolPairs);
    assert.deepEqual(pairs.map(p => [p.name, p.resourceKey]), [
      ['read', '/repo/src/a.js'], ['bash', null], ['edit', '/repo/lib/b.js'],
    ]);
  });
});
