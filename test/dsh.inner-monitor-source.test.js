// The structured reading of a slot's source events (`lib/harness/dsh/inner-monitor-source.js`) over the events `test/helpers/dsh-events.js` builds: pure functions, no DSH package.
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventPreviewText, sourceEventView } from '../lib/harness/dsh/inner-monitor-source.js';
import { assistantMessage, prunedResult, toolResult, userMessage } from './helpers/dsh-events.js';

// The same event with its message's content replaced: a surface message keeps it under `data.message`, a user message in `data` itself.
function withContent(event, content) {
  const copy = structuredClone(event);
  (copy.data.message ?? copy.data).content = content;
  return copy;
}

test('an event reads as its seq, type, the visibility it is handed, its content blocks in order and itself as raw: text, reasoning and a tool call kept apart', () => {
  const reply = withContent(
    assistantMessage({ text: 'unused' }),
    [
      { type: 'reasoning', text: 'think first' },
      { type: 'text', text: 'the reply' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' },
    ],
  );

  for (const visible of [true, false]) {
    assert.deepEqual(sourceEventView(reply, { visible }), {
      seq: reply.seq,
      type: 'assistant/message',
      visible,
      blocks: [
        { type: 'reasoning', text: 'think first' },
        { type: 'text', text: 'the reply' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' },
      ],
      raw: reply,
    });
  }
  const ask = userMessage({ text: 'please work' });
  assert.deepEqual(sourceEventView(ask, { visible: true }).blocks, [{ type: 'text', text: 'please work' }], 'a user message holds its content in data itself');
  assert.equal(sourceEventView(ask, { visible: true }).raw, ask, 'raw is the event as it is, not a copy');
});

test('a tool result reads as one tool-result block naming the call it answers, whether it failed and its own content blocks, so a call and its result pair by id', () => {
  const reply = assistantMessage({ text: 'reading', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' }] });
  const answered = toolResult({ callId: 'call-1', text: '1: export const a = 1;' });
  const failed = toolResult({ callId: 'call-2', text: 'Error: not found', isError: true });

  const call = sourceEventView(reply, { visible: true }).blocks.find(block => block.type === 'tool-call');
  const result = sourceEventView(answered, { visible: false });

  assert.deepEqual(result.blocks, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: '1: export const a = 1;' }] }]);
  assert.equal(result.blocks[0].callId, call.id);
  assert.deepEqual(sourceEventView(failed, { visible: true }).blocks, [
    { type: 'tool-result', callId: 'call-2', isError: true, blocks: [{ type: 'text', text: 'Error: not found' }] },
  ]);
});

test('an image or file block reads as a placeholder keeping its attachment reference, any other block as unknown with the block itself, and a message with no content blocks to read as an empty list', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a-1', mediaType: 'image/png', bytes: 2048, width: 4, height: 3, name: 'shot.png' } };
  const file = { type: 'file', attachment: { attachmentId: 'a-2', name: 'notes.md', bytes: 12 } };
  const addition = { type: 'tool-addition', toolName: 'grep' };
  const mixed = withContent(userMessage({ text: 'unused' }), [{ type: 'text', text: 'see' }, image, file, addition, null]);

  assert.deepEqual(sourceEventView(mixed, { visible: true }).blocks, [
    { type: 'text', text: 'see' },
    { type: 'image', attachment: image.attachment },
    { type: 'file', attachment: file.attachment },
    { type: 'unknown', raw: addition },
    { type: 'unknown', raw: null },
  ]);

  const empty = userMessage();
  assert.deepEqual(sourceEventView(empty, { visible: true }), { seq: empty.seq, type: 'user/message', visible: true, blocks: [], raw: empty });
  const noContent = { ...empty, data: { role: 'user' } };
  const noData = { type: 'step/start', seq: 9, time: 1 };
  assert.deepEqual(sourceEventView(noContent, { visible: true }).blocks, []);
  assert.deepEqual(sourceEventView(noData, { visible: true }).blocks, []);
  assert.deepEqual(sourceEventView(withContent(assistantMessage(), 'a text'), { visible: true }).blocks, [], 'a content that is no list');
});

test('the preview text of an event is its text blocks, each tool call as its name and arguments, a tool result as its own text and a bracketed placeholder for an image or file, reasoning left out and blocks apart by a line break', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a-1', mediaType: 'image/png', bytes: 2048, width: 4, height: 3, name: 'shot.png' } };
  const file = { type: 'file', attachment: { attachmentId: 'a-2', name: 'notes.md', bytes: 12 } };
  const reply = withContent(assistantMessage(), [
    { type: 'reasoning', text: 'think first' },
    { type: 'text', text: 'reading the file' },
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' },
    { type: 'tool-call', id: 'call-2', name: 'status', arguments: '' },
  ]);
  const shown = withContent(userMessage(), [{ type: 'text', text: 'see' }, image, file, { type: 'tool-addition', toolName: 'grep' }]);
  const withImage = withContent(toolResult({ callId: 'call-3' }), [{ type: 'text', text: 'a screenshot' }, { ...image, attachment: { ...image.attachment, name: undefined } }]);

  assert.equal(eventPreviewText(reply), 'reading the file\nread {"file_path":"a.js"}\nstatus');
  assert.equal(eventPreviewText(toolResult({ callId: 'call-1', text: '1: export const a = 1;' })), '1: export const a = 1;');
  assert.equal(eventPreviewText(shown), 'see\n[image shot.png]\n[file notes.md]');
  assert.equal(eventPreviewText(withImage), 'a screenshot\n[image]');
});

test('an event with nothing to preview, an empty content node, a reasoning-only reply or no message at all, previews as the empty text', () => {
  assert.equal(eventPreviewText(userMessage()), '');
  assert.equal(eventPreviewText(withContent(assistantMessage(), [{ type: 'reasoning', text: 'only thoughts' }])), '');
  assert.equal(eventPreviewText({ type: 'step/start', seq: 9, time: 1 }), '');
});

test('a pruner replacement reads as its own content: neither its blocks nor its preview take in the result it cites, the one it replaced twice over included, while the call id stays the one of the original', () => {
  const original = toolResult({ callId: 'call-1', text: 'the whole file body' });
  const once = prunedResult(original, { text: 'pruned once' });
  const twice = prunedResult(once, { text: 'pruned twice' });

  const first = sourceEventView(original, { visible: false });
  const last = sourceEventView(twice, { visible: true });

  assert.deepEqual([first.visible, last.visible], [false, true]);
  assert.deepEqual(last.blocks, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'pruned twice' }] }]);
  assert.equal(first.blocks[0].callId, last.blocks[0].callId, 'the call, the original and the replacement pair by one id');
  assert.deepEqual(last.raw.sourceEventSeqs, [once.seq], 'the citation stays in the raw event and brings nothing into the reading');
  assert.equal(eventPreviewText(twice), 'pruned twice');
  assert.equal(eventPreviewText(original), 'the whole file body');
});
