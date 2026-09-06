import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_HANDOFF_LOADED,
  withPageRecovery, withSearchRecovery, withLocateRecovery, withLoadRecovery,
} from '../lib/turn-tool-recovery.js';

test('no_handoff_loaded names load_handoff as the precondition', () => {
  assert.equal(NO_HANDOFF_LOADED.error, 'no_handoff_loaded');
  assert.match(NO_HANDOFF_LOADED.recovery, /load_handoff/);
});

test('a successful page is returned untouched — its routing is the presence of next_before', () => {
  const page = { turn_page: 'S1:0 | U: hi', next_before: 'S1:0' };
  assert.deepEqual(withPageRecovery(page), page);
  assert.deepEqual(withPageRecovery({ turn_page: '' }), { turn_page: '' });
});

test('an unavailable page keeps retryable and gains a recovery sentence', () => {
  const out = withPageRecovery({ error: 'turn_page_unavailable', retryable: true });
  assert.equal(out.error, 'turn_page_unavailable');
  assert.equal(out.retryable, true);
  assert.match(out.recovery, /turn_page/);
});

// The two address failures are thrown rather than returned, so nothing here augments them and there is
// no returned value to assert on: their only legal source is a value this tool handed out, so they get no
// wire name and the message IS the recovery, which the SDK puts in content[0]. That the service throws
// each one for its own address fault is behaviour, and it is driven where the service is —
// test/server.turn-read-tools.test.js `throws the stale-cursor sentence`.

test('search found:false routes to locate and bounds its claim to the searchable surface', () => {
  const out = withSearchRecovery({ found: false });
  assert.equal(out.found, false);
  assert.match(out.recovery, /turn_locate/);
  assert.match(out.recovery, /searchable entit/i);
});

test('search truncated routes to a scope', () => {
  const out = withSearchRecovery({ found: true, ranges: [{}], truncated: true });
  assert.match(out.recovery, /scope/);
  assert.match(out.recovery, /turn_locate/);
  // Only the routing identifiers are pinned here. That the oldest entry can be short is a property of
  // searchTranscripts, asserted on its return value in test/turn-query.test.js
  // `单个 turn 的命中就超预算` — pinning the sentence instead would make the wording unrewritable while
  // saying nothing about the behaviour.
});

test('search hits state the file address the response carries, and what an entry scope is for', () => {
  const out = withSearchRecovery({ found: true, ranges: [{}], truncated: false });
  assert.match(out.recovery, /transcript_path/);
  assert.match(out.recovery, /\bline\b/);
  // An entry's scope is optional, so the sentence has to route both its presence and its absence. Only the
  // routing identifiers are pinned; which causes the sentence enumerates is wording, and pinning wording
  // makes it unrewritable without saying anything about behaviour.
  assert.match(out.recovery, /turn_page/);
  assert.match(out.recovery, /without one/);
});

test('search_unavailable routes to the page without naming an unproved cause', () => {
  const out = withSearchRecovery({ error: 'search_unavailable' });
  assert.match(out.recovery, /turn_page/);
  assert.doesNotMatch(out.recovery, /index|became unavailable/i);
});

test('locate_unavailable routes to the page without naming an unproved cause', () => {
  const out = withLocateRecovery({ error: 'locate_unavailable' });
  assert.match(out.recovery, /turn_page/);
  assert.doesNotMatch(out.recovery, /FTS|became unavailable/i);
});

test('locate found:false states the corpus limit rather than inviting new words', () => {
  const out = withLocateRecovery({ found: false });
  assert.match(out.recovery, /captured at handoff time/);
  assert.match(out.recovery, /turn_page/);
});

// The candidate's own address is not a `before` that shows it: a page ends STRICTLY before its
// boundary record (lib/turn-page.js filters t < boundary.t), so it would exclude the located turn.
test('located ranges hand their scope to turn_search and claim nothing about before', () => {
  const out = withLocateRecovery({ found: true,
    ranges: [{ scope: 'S1:0', u: 'x', hit: true }, { scope: 'S1:1', u: 'y' }] });
  assert.match(out.recovery, /turn_search/);
  assert.ok(!/read around/.test(out.recovery));
});

test('a delivery failure says the response carries no content', () => {
  const out = withLoadRecovery({ error: 'handoff_delivery_unavailable', retryable: true });
  assert.match(out.recovery, /no content/i);
});

test('a load carrying turn_page_error gains the page-tool recovery and keeps its core', () => {
  const out = withLoadRecovery({ found: true, summary: 's', turn_page_error: 'turn_page_unavailable' });
  assert.equal(out.summary, 's');
  assert.match(out.recovery, /turn_page/);
});

test('a clean load is returned untouched', () => {
  const core = { found: true, summary: 's', turn_page: 'p' };
  assert.deepEqual(withLoadRecovery(core), core);
});
