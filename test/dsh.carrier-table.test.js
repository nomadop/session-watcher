// The DSH wording table of the carrier and the source kinds whose sources carry evidence.
import test from 'node:test';
import assert from 'node:assert/strict';

import { carriesEvidence } from '../lib/harness/dsh/carrier-table.js';
import { INNER_SEAL_KIND } from '../lib/inner-seal/carrier.js';
import { LOAD_MESSAGE_KIND } from '../lib/harness/dsh/load-message.js';

test('carriesEvidence holds for an inner-seal carrier\'s source and for a load\'s read message that states its lines in `paths`, and for no other source', () => {
  assert.equal(carriesEvidence({ kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [] }), true);
  assert.equal(carriesEvidence({ kind: LOAD_MESSAGE_KIND, paths: [] }), true);
  const others = [
    ['a load\'s message with no paths', { kind: LOAD_MESSAGE_KIND }],
    ['a load\'s message whose paths are no list', { kind: LOAD_MESSAGE_KIND, paths: {} }],
    ['a user message', { kind: 'user' }],
    ['a checkpoint', { kind: 'compact-checkpoint', paths: [] }],
    ['no source', undefined],
    ['a null source', null],
  ];
  for (const [why, source] of others) assert.equal(carriesEvidence(source), false, why);
});
