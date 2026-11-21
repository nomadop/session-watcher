// What DSH messages' blocks say (`lib/harness/dsh/message-blocks.js`): the text they put in the request, read through `requestTextOf`, and the facts of a seal slot's derived messages, read through `slotFactsOf`; the expected values are written out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';

import { requestTextOf, slotFactsOf } from '../lib/harness/dsh/message-blocks.js';

test('a text block is its text, a reasoning block its text, a call its name then its arguments, and the blocks of one message join with nothing between', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'think ' },
      { type: 'text', text: 'ok ' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.js"}' },
    ],
  };
  assert.equal(requestTextOf(message), 'think ok read{"path":"a.js"}');
  assert.equal(requestTextOf({ role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: '中文' }] }), 'abcd中文');
});

test('any other block is its JSON, and a message with no blocks has no text', () => {
  const result = { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'x' }] };
  const image = { type: 'image', attachment: { attachmentId: 'a1', name: 'p.png' } };
  assert.equal(requestTextOf({ role: 'tool', content: [result] }), '{"type":"tool-result","toolCallId":"call-1","content":[{"type":"text","text":"x"}]}');
  assert.equal(requestTextOf({ role: 'user', content: [{ type: 'text', text: 'see ' }, image] }), 'see {"type":"image","attachment":{"attachmentId":"a1","name":"p.png"}}');
  assert.equal(requestTextOf({ role: 'user', content: [] }), '');
});

test("a user slot is the user's own message, its text that of every derived message's text blocks in order", () => {
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix ' }, { type: 'image' }, { type: 'text', text: 'it' }] }, { role: 'user', content: [{ type: 'text', text: '!' }] }];
  assert.deepEqual(slotFactsOf({ seqs: [3, 4] }, messages), { own: true, kind: 'other', text: 'fix it!' });
});

test("a user message the harness wrote, or a user message in a counted step, is not the user's own", () => {
  const injected = [{ role: 'user', source: { kind: 'skill' }, content: [{ type: 'text', text: 'body' }] }];
  assert.deepEqual(slotFactsOf({ seqs: [3] }, injected), { own: false, kind: 'other', text: 'body' });
  const own = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }];
  assert.equal(slotFactsOf({ seqs: [3], step: { turn: 1, step: 1 } }, own).own, false);
  assert.deepEqual(slotFactsOf({ seqs: [3] }, []), { own: false, kind: 'other', text: '' });
});

test('a tool result slot names the call it answers', () => {
  const messages = [{ role: 'tool', toolCallId: 'call-9', content: [{ type: 'text', text: 'late' }] }];
  assert.deepEqual(slotFactsOf({ seqs: [7] }, messages), { own: false, kind: 'result', text: 'late', toolCallId: 'call-9' });
});

test('a step slot carries its assistant text and each call, failed when a tool message of the slot answers it with an error', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'reading' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: 'ls' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] },
  ];
  assert.deepEqual(slotFactsOf({ seqs: [1, 2, 3, 4], step: { turn: 1, step: 1 } }, messages), {
    own: false, kind: 'step', text: 'readingokboom', assistantText: 'reading',
    calls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}', failed: false }, { id: 'c2', name: 'bash', arguments: 'ls', failed: true }],
  });
});
