import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryPrecheck } from '../lib/fold.js';

test('C4b-1: compact user line passes', () => {
  assert.equal(boundaryPrecheck('{"type":"user","message":{"content":"hi"}}'), true);
});
test('C4b-1: pretty-printed user line ALSO passes (no false negative)', () => {
  assert.equal(boundaryPrecheck('{"type": "user", "message": {"content": "hi"}}'), true);
});
test('C4b-1: assistant line does not need to pass (false negative is fine only for NON-boundaries)', () => {
  // an assistant/usage line has no "user" type → precheck may return false; that is correct.
  assert.equal(boundaryPrecheck('{"type":"assistant","message":{"usage":{}}}'), false);
});
test('C4b-1: >1MB line with head "type":"user" and a huge tail payload STILL passes (head-first scan)', () => {
  const head = '{"type":"user","message":{"content":[';
  const bigTail = '"' + 'A'.repeat(2 * 1024 * 1024) + '"]}}';
  assert.equal(boundaryPrecheck(head + bigTail), true, 'boundary marker in head → not missed on a giant line');
});
