// test/dialogue-fold.projection.test.js — the shared Dialogue Projection over normalized observations.
// Every case drives projectDialogue with an in-memory observation array read through the Claude Code
// DialogueSource: no path, no file handle and no anchor reaches the projection, and the same array read
// twice — sealed and incrementally — has to produce the same folds.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateDialogueLines, projectDialogue } from '../lib/dialogue-fold.js';
import {
  createClaudeCodeObservationReducer,
  readClaudeCodeRows,
} from '../lib/harness/claude-code/transcript-observation.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, transcriptBytes,
  ts, userMessage,
} from './helpers/transcript-fixtures.js';

const foldsOf = (entries) => projectDialogue(observationsOf(entries)).folds;
const textsOf = (folds) => folds.filter(f => f.message).map(f => f.message.text);

describe('logical message revisions', () => {
  test('one messageId is one fold: the last text-bearing row supplies the text', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'provisional text' }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'final text' }] }),
      assistantObservation({ uuid: 'a3', messageId: 'm1', timestamp: ts(3),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'partial' } }] }),
      assistantObservation({ uuid: 'a4', messageId: 'm1', timestamp: ts(4),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.js' } }] }),
    ]));
    assert.equal(folds.length, 1);
    assert.equal(folds[0].message.text, 'final text');
    assert.equal(folds[0].toolPairs.length, 1);
    assert.equal(folds[0].toolPairs[0].input.file_path, '/repo/a.js');
  });

  test('the fold keeps the coordinates of its first text-bearing row', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'early text' }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'late text' }] }),
    ]));
    assert.equal(folds[0].message.text, 'late text');
    assert.equal(folds[0].sourceOrdinal, 1);
    assert.equal(folds[0].sourceEntryId, 'a1');
    assert.equal(folds[0].timestamp, Date.parse(ts(1)));
  });

  test('a tool-only first row hands its coordinates to the row that first bears text', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'now visible' }] }),
    ]));
    assert.equal(folds[0].sourceEntryId, 'a2');
    assert.equal(folds[0].sourceOrdinal, 2);
  });

  test('a promoting row with no identity keeps the identity its group already had', () => {
    // The body arrives on a row the Source could give no identity. The group already holds one from the row
    // that created it, and that is the identity the fold answers with — Turn Note capture requires a head
    // identity, so a fold reached through an identified row stays persistable.
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }),
      assistantObservation({ uuid: null, messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'now visible' }] }),
    ]));
    assert.equal(folds[0].sourceEntryId, 'a1');
    // Position still moves to the row that bears the body; only the identity falls back.
    assert.equal(folds[0].sourceOrdinal, 2);
    assert.equal(folds[0].timestamp, Date.parse(ts(2)));
  });

  test('an identity the Source reports as empty is no identity at all', () => {
    // Empty is not a usable key — capture rejects a head that carries one — so it neither survives on a
    // fold nor displaces an identity the group already holds.
    const promoted = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }),
      assistantObservation({ uuid: '', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'now visible' }] }),
    ]));
    assert.equal(promoted[0].sourceEntryId, 'a1');
    const alone = foldsOf([
      assistantObservation({ uuid: '', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'only row' }] }),
    ]);
    assert.equal(alone[0].sourceEntryId, null);
  });

  test('an assistant row whose whole body is an empty string is still a visible body', () => {
    // A row that spoke nothing still spoke: its body is empty, not absent. The block form is the one an
    // empty text says nothing in, and the Source declines that one before Dialogue sees it.
    const folds = foldsOf(chain([
      { type: 'assistant', uuid: 'a1', parentUuid: null, isSidechain: false, timestamp: ts(1),
        message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: '' } },
    ]));
    assert.equal(folds.length, 1);
    assert.notEqual(folds[0].message, null);
    assert.deepEqual(folds[0].message, { role: 'assistant', text: '' });
    assert.equal(folds[0].sourceEntryId, 'a1');
  });

  test('a later empty-string body supersedes the text an earlier row supplied', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'said something' }] }),
      { type: 'assistant', uuid: 'a2', parentUuid: null, isSidechain: false, timestamp: ts(2),
        message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: '' } },
    ]));
    assert.deepEqual(textsOf(folds), ['']);
    // The coordinates stay on the first body row: only a group with no body yet promotes them.
    assert.equal(folds[0].sourceEntryId, 'a1');
  });

  test('a later tool-only revision does not erase retained text', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'kept text' }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }] }),
    ]));
    assert.equal(folds.length, 1);
    assert.equal(folds[0].message.text, 'kept text');
    assert.equal(folds[0].toolPairs.length, 1);
  });

  test('two messageIds are two folds even when their rows interleave', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'one' }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'two' }] }),
      assistantObservation({ uuid: 'a3', messageId: 'm1', timestamp: ts(3),
        blocks: [{ type: 'text', text: 'one revised' }] }),
    ]));
    assert.deepEqual(textsOf(folds), ['one revised', 'two']);
  });

  test('a human row is its own fold and is never grouped with another row', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'first ask', timestamp: ts(1) }),
      userMessage({ uuid: 'u2', text: 'second ask', timestamp: ts(2) }),
    ]));
    assert.deepEqual(textsOf(folds), ['first ask', 'second ask']);
    assert.deepEqual(folds.map(f => f.sourceEntryId), ['u1', 'u2']);
  });

  test('a human row whose text blocks are all empty produces no fold', () => {
    // Nothing was said, so there is no body to project and no line for a rule to judge. The row keeps its
    // ordinal and its turn boundary; it simply contributes no Dialogue.
    const folds = foldsOf(chain([
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: ts(1),
        message: { role: 'user', content: [{ type: 'text', text: '' }] } },
      userMessage({ uuid: 'u2', text: 'a real ask', timestamp: ts(2) }),
    ]));
    assert.deepEqual(textsOf(folds), ['a real ask']);
    assert.deepEqual(folds.map(f => f.sourceEntryId), ['u2']);
  });

  test("a human row's text blocks concatenate into one body", () => {
    const folds = foldsOf(chain([
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: ts(1),
        message: { role: 'user', content: [
          { type: 'text', text: 'block one' },
          { type: 'text', text: ' block two' },
        ] } },
    ]));
    assert.deepEqual(textsOf(folds), ['block one block two']);
  });
});

describe('native order', () => {
  test('visible text and tool uses keep native observation order within one fold', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2), blocks: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/a.js' } },
      ] }),
      toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'out' }),
      toolResult({ uuid: 'r2', toolUseId: 'tu2', content: 'src' }),
    ]));
    const lines = enumerateDialogueLines(folds);
    assert.deepEqual(lines.map(l => l.kind), ['visible', 'visible', 'tool', 'tool']);
    assert.deepEqual(lines.slice(2).map(l => l.tool.name), ['Bash', 'Read']);
  });

  test('folds are ordered by the row that created each logical message', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'first' }] }),
      userMessage({ uuid: 'u2', text: 'again', timestamp: ts(3) }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'second' }] }),
    ]));
    assert.deepEqual(folds.map(f => f.ordinal), [0, 1, 2, 3]);
    assert.deepEqual(textsOf(folds), ['go', 'first', 'again', 'second']);
  });
});

describe('tool pairing', () => {
  test('an empty tool use id admits no pair, and the observation still reaches Measurement', () => {
    // An empty id names nothing, so there is no call for Dialogue to show and nothing a result could pair
    // with. The judgement is Dialogue's alone: Measurement counts every tool use its step issued and
    // correlates by the id it was given, so the observation itself has to survive.
    const entries = chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2), blocks: [
        { type: 'tool_use', id: '', name: 'Read', input: { file_path: '/nameless.js' } },
        { type: 'tool_use', id: 'tu-real', name: 'Bash', input: { command: 'ls' } },
      ] }),
      toolResult({ uuid: 'r1', toolUseId: '', content: 'nameless output' }),
      toolResult({ uuid: 'r2', toolUseId: 'tu-real', content: 'real output' }),
    ]);
    const observations = observationsOf(entries);
    // The Source reports both, unchanged: the empty id is a fact about the row, not a Dialogue decision.
    assert.deepEqual(observations.filter(o => o.type === 'tool-use').map(o => o.toolUseId), ['', 'tu-real']);
    assert.deepEqual(observations.filter(o => o.type === 'tool-result').map(o => o.toolUseId),
      ['', 'tu-real']);

    const folds = projectDialogue(observations).folds;
    const pairs = folds.flatMap(f => f.toolPairs);
    assert.deepEqual(pairs.map(p => p.toolUseId), ['tu-real'], 'only the named call becomes a pair');
    assert.equal(pairs[0].result, 'real output');
    // No tool line either, so nothing counts it, indexes it or fingerprints it.
    assert.deepEqual(enumerateDialogueLines(folds).filter(l => l.kind === 'tool').map(l => l.tool.toolUseId),
      ['tu-real']);
  });

  test('a repeated result for one tool use id is last-result-wins', () => {
    const folds = foldsOf(chain([
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Read',
        input: { file_path: '/a.js' }, timestamp: ts(1) }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'first-content' }),
      toolResult({ uuid: 'r2', toolUseId: 't1', content: 'last-content' }),
    ]));
    assert.equal(folds[0].toolPairs[0].result, 'last-content');
  });

  test('distinct ids pair correctly whatever order their results arrive in', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1), blocks: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
      ] }),
      toolResult({ uuid: 'r1', toolUseId: 't2', content: 'edit-result' }),
      toolResult({ uuid: 'r2', toolUseId: 't1', content: 'read-result' }),
    ]));
    assert.deepEqual(folds[0].toolPairs.map(p => [p.toolUseId, p.result]),
      [['t1', 'read-result'], ['t2', 'edit-result']]);
  });

  test('an unpaired tool use keeps a null result and no result coordinates', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1), blocks: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
      ] }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'file contents' }),
    ]));
    assert.equal(folds[0].toolPairs[0].result, 'file contents');
    const unpaired = folds[0].toolPairs[1];
    assert.equal(unpaired.result, null);
    assert.equal(unpaired.resultSourceOrdinal, null);
    assert.equal(unpaired.resultMeta, null);
    assert.equal(unpaired.isError, undefined);
  });

  test('a consumed result does not carry to a later reuse of its id', () => {
    const folds = foldsOf(chain([
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Read',
        input: { file_path: '/a.js' }, timestamp: ts(1) }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'only-result' }),
      assistantToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 't1', name: 'Read',
        input: { file_path: '/b.js' }, timestamp: ts(2) }),
    ]));
    assert.equal(folds[0].toolPairs[0].result, 'only-result');
    assert.equal(folds[1].toolPairs[0].result, null);
  });

  test('a duplicate tool use id keeps first-seen order and the surviving payload', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1), blocks: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/old.js' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
      ] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: ts(2), blocks: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/new.js' } },
      ] }),
    ]));
    assert.deepEqual(folds[0].toolPairs.map(p => p.toolUseId), ['t1', 't2']);
    assert.equal(folds[0].toolPairs[0].input.file_path, '/new.js');
    // The row travels with the payload that survived: a reader sent to this line has to find /new.js.
    assert.equal(folds[0].toolPairs[0].sourceOrdinal, 2);
    assert.equal(folds[0].toolPairs[1].sourceOrdinal, 1);
  });

  test('raw input, result and native error flag stay on the pair whatever the outcome was', () => {
    const folds = foldsOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1), blocks: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/missing.js' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/exists.js' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
      ] }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'Error: file not found', isError: true }),
      toolResult({ uuid: 'r2', toolUseId: 't2', content: '1\tconst x = 1;\n' }),
      toolResult({ uuid: 'r3', toolUseId: 't3', content: 'Tests passed' }),
    ]));
    assert.deepEqual(folds[0].toolPairs.map(p => [p.name, p.result, p.isError]), [
      ['Read', 'Error: file not found', true],
      ['Read', '1\tconst x = 1;\n', undefined],
      ['Bash', 'Tests passed', undefined],
    ]);
    assert.deepEqual(folds[0].toolPairs[2].input, { command: 'npm test' });
  });

  test('a result row carries its own annotation through uninterpreted', () => {
    const answers = { answers: { 'Which?': 'this one' } };
    const folds = foldsOf(chain([
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'AskUserQuestion',
        input: { questions: [] }, timestamp: ts(1) }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'Q="A"', timestamp: ts(2),
        toolUseResult: answers }),
    ]));
    assert.deepEqual(folds[0].toolPairs[0].resultMeta.annotation, answers);
  });
});

describe('anchor-free folds', () => {
  test('no fold, message or pair carries an anchor', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'ls' }, timestamp: ts(2) }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'out', timestamp: ts(3) }),
    ]));
    for (const fold of folds) {
      assert.ok(!('anchorUuid' in fold) && !('anchorTimestamp' in fold) && !('sourceRef' in fold));
      if (fold.message) {
        assert.deepEqual(Object.keys(fold.message).sort(), ['role', 'text']);
      }
      for (const pair of fold.toolPairs) {
        assert.ok(!('anchor' in pair) && !('useLineOrdinal' in pair));
      }
    }
    for (const line of enumerateDialogueLines(folds)) assert.ok(!('anchor' in line));
  });

  test('a row with no native identity still projects, with a null sourceEntryId', () => {
    const folds = foldsOf([
      assistantObservation({ uuid: null, messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'no uuid' }] }),
    ]);
    assert.deepEqual(textsOf(folds), ['no uuid']);
    assert.equal(folds[0].sourceEntryId, null);
  });

  test('two rows sharing one native identity stay two folds in canonical order', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'dup', text: 'first ask', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'answer' }] }),
      userMessage({ uuid: 'dup', parentUuid: 'a1', text: 'second ask', timestamp: ts(3) }),
    ]));
    assert.deepEqual(textsOf(folds), ['first ask', 'answer', 'second ask']);
  });
});

describe('per-line source coordinates', () => {
  test('a tool line takes the tool-use row while its fold keeps the body row', () => {
    // One assistant message writes each content block as its own row, so the body row and the tool-use
    // row of one logical message are different lines.
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'let me look' }] }),
      assistantToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'echo hi' }, timestamp: ts(3) }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'output', timestamp: ts(4) }),
    ]));
    const fold = folds.find(f => f.toolPairs.length > 0);
    assert.equal(fold.sourceOrdinal, 2);
    const [body, tool] = enumerateDialogueLines([fold]);
    assert.deepEqual([body.sourceOrdinal, body.sourceEntryId, body.timestamp],
      [2, 'a1', Date.parse(ts(2))]);
    assert.deepEqual([tool.sourceOrdinal, tool.sourceEntryId, tool.timestamp],
      [3, 'a2', Date.parse(ts(3))]);
    assert.deepEqual([tool.tool.resultSourceOrdinal, tool.tool.resultSourceEntryId,
      tool.tool.resultTimestamp], [4, 'r1', Date.parse(ts(4))]);
  });

  test('every line carries its own fold ordinal', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'ls' }, timestamp: ts(2) }),
    ]));
    assert.deepEqual(enumerateDialogueLines(folds).map(l => l.foldOrdinal), [0, 1]);
  });

  test('enumerateDialogueLines answers [] for a degenerate projection', () => {
    for (const bad of [null, undefined, {}, 'folds']) {
      assert.deepEqual(enumerateDialogueLines(bad), []);
    }
    assert.deepEqual(enumerateDialogueLines([]), []);
  });
});

describe('human text without a turn boundary', () => {
  test('a human text observation whose row opened no turn is not dialogue', () => {
    // A harness row feeding a result back into the model's own turn may carry a text block beside it. Its
    // row emits no `turn-boundary`, and that shared fact — not a native field — is what keeps it out.
    const observations = observationsOf(chain([
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Read',
        input: { file_path: '/a.js' }, timestamp: ts(1) }),
      { type: 'user', uuid: 'r1', parentUuid: 'a1', isSidechain: false, timestamp: ts(2),
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file body' },
          { type: 'text', text: '<system-reminder>injected</system-reminder>' },
        ] } },
    ]));
    assert.ok(observations.some(o => o.type === 'text' && o.role === 'human'),
      'the Source does emit the text observation; the projection is what declines it');
    assert.ok(!observations.some(o => o.type === 'turn-boundary' && o.sourceOrdinal === 2));
    const folds = projectDialogue(observations).folds;
    assert.deepEqual(textsOf(folds), []);
    assert.equal(folds[0].toolPairs[0].result, 'file body');
  });
});

describe('sealed and incremental reads agree', () => {
  const entries = chain([
    userMessage({ uuid: 'u1', text: 'read a file', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'on it' }] }),
    assistantToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't1', name: 'Read',
      input: { file_path: '/a.js' }, timestamp: ts(3) }),
    toolResult({ uuid: 'r1', toolUseId: 't1', content: 'body', timestamp: ts(4) }),
    assistantObservation({ uuid: 'a3', messageId: 'm2', timestamp: ts(5),
      blocks: [{ type: 'text', text: 'done' }] }),
  ]);

  // Row-at-a-time through one incremental reducer: the same reducer implementation the Source uses,
  // driven with separate mutable state and a cursor that advances one row at a time.
  function incrementalObservations() {
    const buffer = transcriptBytes(entries);
    const reducer = createClaudeCodeObservationReducer();
    const observations = [];
    let offset = 0;
    let ordinal = 1;
    while (offset < buffer.length) {
      const end = buffer.indexOf(0x0a, offset) + 1;
      const { rows, nextSourceOrdinal } = readClaudeCodeRows(buffer.subarray(offset, end), {
        baseOffset: offset, sourceOrdinal: ordinal,
      });
      for (const batch of reducer.append(rows).batches) observations.push(...batch);
      ordinal = nextSourceOrdinal;
      offset = end;
    }
    return observations;
  }

  test('an incremental observation set projects to the same folds as a sealed read', () => {
    assert.deepEqual(
      projectDialogue(incrementalObservations()).folds,
      projectDialogue(observationsOf(entries)).folds,
    );
  });

  test('projecting one observation array twice returns equal folds', () => {
    const observations = observationsOf(entries);
    assert.deepEqual(projectDialogue(observations).folds, projectDialogue(observations).folds);
  });
});

describe('the projection reaches nothing outside its argument', () => {
  // Observed rather than read: a symbol either lands in the live namespace or it does not. The retired
  // reader took a path and opened it; every consumer now hands in an observation array instead.
  test('the file-reading and anchor-resolving Interfaces are gone from the module namespace', async () => {
    const ns = await import('../lib/dialogue-fold.js');
    for (const symbol of ['readCanonicalTranscript', 'findFoldByAnchor', 'findCanonicalMessage',
      'visibleMessages', 'foldAnchor', 'foldLines', 'enumerateLines']) {
      assert.ok(!(symbol in ns), `dialogue-fold.js still exports ${symbol}`);
    }
    assert.deepEqual(Object.keys(ns).sort(),
      ['dialogueFoldLines', 'enumerateDialogueLines', 'projectDialogue']);
  });
});
