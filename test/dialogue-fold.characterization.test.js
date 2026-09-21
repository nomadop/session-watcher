// test/dialogue-fold.characterization.test.js — the fold-shape defects the Dialogue Projection is
// shaped around, restated over normalized observations. Each case names the class of input that used to
// break and asserts what the projection now does with it. Visible bodies are read off folds, which are
// the only authoritative state: a tool-only fold has no visible counterpart at all.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateDialogueLines, projectDialogue } from '../lib/dialogue-fold.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, ts, userMessage,
} from './helpers/transcript-fixtures.js';

const foldsOf = (entries) => projectDialogue(observationsOf(entries)).folds;
const bodies = (folds) => folds.filter(f => f.message).map(f => f.message);

describe('a tool-only fold is not a visible body', () => {
  test('a tool-only assistant message contributes no body and no empty one either', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'I will read a file' }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(3),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }] }),
      toolResult({ uuid: 'tr1', toolUseId: 't1', content: 'file contents' }),
      assistantObservation({ uuid: 'a3', messageId: 'm3', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'Done reading' }] }),
    ]));
    const assistantBodies = bodies(folds).filter(m => m.role === 'assistant');
    assert.deepEqual(assistantBodies.map(m => m.text), ['I will read a file', 'Done reading']);
    for (const message of bodies(folds)) assert.ok(message.text !== null);
  });

  test('the tool-only fold itself survives, carrying its pair', () => {
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'ls' }, timestamp: ts(2) }),
      toolResult({ uuid: 'tr1', toolUseId: 't1', content: 'a.js\nb.js' }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(3),
        blocks: [{ type: 'text', text: 'Listed files' }] }),
    ]));
    const toolOnly = folds.filter(f => f.message === null);
    assert.equal(toolOnly.length, 1);
    assert.equal(toolOnly[0].toolPairs.length, 1);
    assert.equal(toolOnly[0].toolPairs[0].result, 'a.js\nb.js');
    assert.equal(bodies(folds).filter(m => m.role === 'assistant').length, 1);
  });

  test('a tool-only fold on the active path stays out of the bodies and in the folds', () => {
    // A single linear chain, so nothing here depends on sibling-branch selection.
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'start', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'response one' }] }),
      assistantToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 't1', name: 'Bash',
        input: { command: 'echo hi' }, timestamp: ts(3) }),
      toolResult({ uuid: 'tr1', toolUseId: 't1', content: 'hi' }),
      assistantObservation({ uuid: 'a3', messageId: 'm3', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'response two' }] }),
    ]));
    assert.deepEqual(bodies(folds).filter(m => m.role === 'assistant').map(m => m.text),
      ['response one', 'response two']);
    assert.equal(folds.filter(f => f.message === null).length, 1);
  });

  test('the projection returns folds alone: no parallel body array to index against', () => {
    const projection = projectDialogue(observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'ls' }, timestamp: ts(2) }),
    ])));
    // A second array whose cardinality differs from folds is what let index zippers drift.
    assert.deepEqual(Object.keys(projection), ['folds']);
    assert.equal(projection.folds.length, 2);
  });
});

describe('degenerate identity does not drop a fold', () => {
  test('a fold whose row has neither identity nor a readable time still projects', () => {
    const folds = foldsOf([
      assistantObservation({ uuid: null, messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'still here' }] }),
    ]);
    assert.deepEqual(bodies(folds).map(m => m.text), ['still here']);
    assert.equal(folds[0].sourceEntryId, null);
    assert.equal(folds[0].timestamp, null);
  });

  test('the projection reports no warnings at all', () => {
    // The retired reader warned about anchors it could not use. Identity and time are now judged where
    // they are required — Turn Note capture — so the projection has no advisory channel of its own.
    const projection = projectDialogue(observationsOf([
      assistantObservation({ uuid: null, messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'x' }] }),
    ]));
    assert.equal('warnings' in projection, false);
  });
});

describe('the whole Source is projected', () => {
  test('a handoff token embedded in a body does not truncate the projection', () => {
    // The retired cutoff sliced the raw buffer at the token's row. Membership is per session now.
    const folds = foldsOf(chain([
      userMessage({ uuid: 'u1', text: 'context before', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'Handoff prepared. Token: `some-load-token`' }] }),
      userMessage({ uuid: 'u2', text: 'after the handoff', timestamp: ts(3) }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'still in scope' }] }),
    ]));
    assert.deepEqual(bodies(folds).map(m => m.text), [
      'context before',
      'Handoff prepared. Token: `some-load-token`',
      'after the handoff',
      'still in scope',
    ]);
  });

  test('every epoch of a multi-epoch Source is projected in source order', () => {
    // A second null-parent root is a compact boundary. The projection spans both epochs: only Turn Note
    // capture selects a suffix, and it does so from the boundary observation rather than from a fold.
    const folds = foldsOf([
      ...chain([
        userMessage({ uuid: 'r1', text: 'pre-compact ask', timestamp: ts(1) }),
        assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
          blocks: [{ type: 'text', text: 'pre-compact answer' }] }),
      ]),
      ...chain([
        userMessage({ uuid: 'r2', text: 'post-compact ask', timestamp: ts(3) }),
        assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(4),
          blocks: [{ type: 'text', text: 'post-compact answer' }] }),
      ]),
    ]);
    assert.deepEqual(bodies(folds).map(m => m.text),
      ['pre-compact ask', 'pre-compact answer', 'post-compact ask', 'post-compact answer']);
  });

  test('an empty observation set projects to no folds and no lines', () => {
    assert.deepEqual(projectDialogue([]).folds, []);
    assert.deepEqual(enumerateDialogueLines(projectDialogue([]).folds), []);
  });
});
