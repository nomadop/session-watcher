// test/dsh.turn-recovery.test.js — the DSH turn-recovery sentences, which name `session_event_read` as the way to read an address this harness's rows carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshTurnRecovery } from '../lib/harness/dsh/turn-recovery.js';

test('the three sentences name session_event_read', () => {
  const { notice, searchHit, locateHit } = createDshTurnRecovery();

  for (const sentence of [notice, searchHit, locateHit]) assert.match(sentence, /session_event_read/);
  assert.match(notice, /\bseq\b/);
  assert.match(searchHit, /\bspan\b/);
  assert.match(locateHit, /session_id/);
});

test('the hit sentences name the fields a hit carries, transcript_path and line', () => {
  const { searchHit, locateHit } = createDshTurnRecovery();

  assert.match(searchHit, /transcript_path as session_id and line as seq/);
  assert.match(locateHit, /transcript_path as session_id and T as seq/);
});

test('scope and before stay the next step', () => {
  const { searchHit, locateHit } = createDshTurnRecovery();

  for (const sentence of [searchHit, locateHit]) {
    assert.match(sentence, /\bscope\b/);
    assert.match(sentence, /\bbefore\b/);
  }
});
