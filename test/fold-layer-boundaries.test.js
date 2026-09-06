/**
 * Fold-layer dependency direction: the Measurement route must not reach into Dialogue Projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as canonicalFold from '../lib/canonical-fold.js';
import * as fold from '../lib/fold.js';

test('canonical-fold.js no longer re-exports the Dialogue Projection API', () => {
  for (const symbol of ['readCanonicalTranscript', 'findCanonicalMessage']) {
    assert.ok(!(symbol in canonicalFold), `canonical-fold.js must not export ${symbol}`);
  }
});

test('fold.js exports the archive wrapper callers reach segment archiving through', () => {
  assert.equal(typeof fold.archiveCurrentSegment, 'function');
});
