import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCompleteJsonlEventsFromBuffer } from '../lib/fold.js';

test('reader: maxBytes is a hard bound and nextOffset commits only complete lines', () => {
  const first = Buffer.from('{"text":"你"}\n', 'utf8');
  const second = Buffer.from('{"n":2}\n', 'utf8');
  const chunk = Buffer.concat([first, second]);
  const baseOffset = 37;

  const result = readCompleteJsonlEventsFromBuffer(chunk, {
    baseOffset,
    maxBytes: first.length + second.length - 1,
  });

  assert.deepEqual(result.events, [{ text: '你' }]);
  assert.equal(result.nextOffset, baseOffset + first.length);
  assert.equal(result.caughtUp, false);
});

test('reader: CRLF and malformed complete lines both advance the committed offset', () => {
  const chunk = Buffer.from('{"a":1}\r\n{"b":2}\nnot-json\n', 'utf8');

  const result = readCompleteJsonlEventsFromBuffer(chunk, { baseOffset: 11 });

  assert.deepEqual(result.events, [{ a: 1 }, { b: 2 }]);
  assert.equal(result.nextOffset, 11 + chunk.length);
  assert.equal(result.caughtUp, true);
});

test('reader: a newline-less tail is committed only for a sealed replay', () => {
  const chunk = Buffer.from('{"tail":"complete"}', 'utf8');

  const live = readCompleteJsonlEventsFromBuffer(chunk, { baseOffset: 5, atEof: false });
  assert.deepEqual(live.events, []);
  assert.equal(live.nextOffset, 5);
  assert.equal(live.caughtUp, false);

  const sealed = readCompleteJsonlEventsFromBuffer(chunk, { baseOffset: 5, atEof: true });
  assert.deepEqual(sealed.events, [{ tail: 'complete' }]);
  assert.equal(sealed.nextOffset, 5 + chunk.length);
  assert.equal(sealed.caughtUp, true);
});

test('reader: a budget ending inside UTF-8 commits no partial line', () => {
  const chunk = Buffer.from('{"text":"你好"}\n', 'utf8');
  const firstChar = chunk.indexOf(Buffer.from('你', 'utf8'));

  const result = readCompleteJsonlEventsFromBuffer(chunk, {
    baseOffset: 101,
    maxBytes: firstChar + 2,
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.nextOffset, 101);
  assert.equal(result.caughtUp, false);
});
