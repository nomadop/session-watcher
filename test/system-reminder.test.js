// The reminder frame (`lib/system-reminder.js`) the inner-seal carrier is written in: DSH's `<system-reminder>` frame around the blocks of a message, and the escape of the closing tag in the text it holds.
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeReminder, frameReminder } from '../lib/system-reminder.js';

const text = body => ({ type: 'text', text: body });
const file = { type: 'file', attachment: { attachmentId: 'att-1', name: 'notes.txt' } };
// The text a route that sends the message as one string joins the blocks into, a file block here the one word `FILE`.
const joined = blocks => blocks.map(block => (block.type === 'text' ? block.text : 'FILE')).join('');

test('the blocks are framed as DSH frames a reminder, `<system-reminder>`, a line break, the body, a line break and the closing tag, across however many text blocks the body is in', () => {
  assert.equal(joined(frameReminder([text('one')])), '<system-reminder>\none\n</system-reminder>');
  assert.equal(joined(frameReminder([text('one\n'), text('\ntwo')])), '<system-reminder>\none\n\ntwo\n</system-reminder>');
  assert.deepEqual(frameReminder([text('a'), text('b'), text('c')]).map(block => block.text), ['<system-reminder>\na', 'b', 'c\n</system-reminder>'], 'only the first and the last block change');
});

test('the closing tag opens on a line of its own as DSH writes it, whether or not the last block ends with a line break', () => {
  assert.equal(joined(frameReminder([text('one\n')])), '<system-reminder>\none\n\n</system-reminder>');
  assert.equal(joined(frameReminder([text('one\n\n')])), '<system-reminder>\none\n\n\n</system-reminder>');
});

test('a file block last has a text block placed after it that closes the frame, the file block itself untouched', () => {
  const last = frameReminder([text('before\n'), file]);
  assert.deepEqual(last, [text('<system-reminder>\nbefore\n'), file, text('\n</system-reminder>')]);
  assert.equal(last[1], file);
  assert.equal(joined(frameReminder([text('a'), file])), '<system-reminder>\naFILE\n</system-reminder>');
});

test('the closing tag in any text block is escaped as DSH escapes it, the one that closes the frame the only one left', () => {
  const blocks = frameReminder([text('a </system-reminder> b'), file, text('</system-reminder></system-reminder>')]);
  assert.equal(joined(blocks), '<system-reminder>\na <\\/system-reminder> bFILE<\\/system-reminder><\\/system-reminder>\n</system-reminder>');
  assert.equal(joined(blocks).split('</system-reminder>').length - 1, 1);
  assert.equal(escapeReminder('x </system-reminder> y </system-reminder>'), 'x <\\/system-reminder> y <\\/system-reminder>');
  assert.equal(escapeReminder('no tag, and <system-reminder> opens nothing'), 'no tag, and <system-reminder> opens nothing', 'only the closing tag is escaped');
});

test('the blocks handed in are left as they were', () => {
  const blocks = [text('a </system-reminder>'), file, text('b')];
  const copy = structuredClone(blocks);
  frameReminder(blocks);
  assert.deepEqual(blocks, copy);
});
