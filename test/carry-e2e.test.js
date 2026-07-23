import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer } from './helpers/server-boot.js';

// ── Task 11 Step 0: END-TO-END LINKAGE ACCEPTANCE GATE ───────────────────────
// The feature's whole point is the producer→consumer→usage linkage. Per-unit tests prove each hop;
// this file proves the CHAIN with a single SQL join, for BOTH the explicit-token load path AND the
// auto-match load path (Task 6's tool_result back-fill).
//
// WIRING (the crux — see task-11-report.md): fold-driven archival goes through the watcher's store.
// bootSecondConsumer's watcher must archive to the SAME DB the producer reads. The consumer harness
// methods (foldLoadHandoffThenArchive / foldAutoMatchLoadThenArchive) call w.setStore(consumer.store)
// — the consumer's OWN openStore connection on the shared db file — and set w._sessionId, so
// handleSegmentBoundary resolves `w._store` (fold.js:129) and the archived profile_step_usage rows
// land in the queried DB. Without setStore the boundary would resolve the GLOBAL getStore() singleton
// (uninitialized here → swallowed no-op) and the join would return zero rows — a false negative.
//
// NON-VACUITY: `assert.ok(joined)` FAILS on undefined, so a zero-row join FAILS (does not pass
// vacuously). Each test ALSO asserts a concrete profile_step_usage row with a NON-NULL load_token
// exists BEFORE the join, so the join is provably over real data, not an empty set.
//
// NOTE vs the brief snippet: hp is non-null only when the kept path is a bucket CANDIDATE (in
// bd.paths), which requires a folded Read — so the producer uses touchBucketPaths (writes the real
// file under cwd AND folds a Read of it), exactly as the Task 5 prepare-telemetry tests do. A bare
// writeFileSync leaves the path write-only → match_status='unmatched' → hp=null.

test('E2E linkage: prepare → load(primary) → fold captures load_token → archive → SQL join holds', async () => {
  const producer = await bootTestServer({ disableTelemetrySweep: true });
  try {
    // 1. Producer prepares a handoff keeping one real, bucket-candidate file.
    producer.touchBucketPaths(['k.js'], { content: 'export const k = 1;\n' });
    const token = await producer.prepareHandoff({ paths_to_keep: [{ path: 'k.js' }], summary: 'carry me' });

    // handoff row has hp (content_hash_prepare on the matched candidate) + bucket_snapshot server-side.
    const stored0 = JSON.parse(producer.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
    const hp = (Array.isArray(stored0) ? stored0 : stored0.paths)[0].hp;
    assert.match(hp, /^[0-9a-f]{64}$/, 'prepare stamped hp on the matched kept path');
    assert.ok(producer.store._db.prepare("SELECT bucket_snapshot FROM handoff WHERE load_token=?").get(token).bucket_snapshot,
      'prepare froze bucket_snapshot server-side');

    // 2. A consumer session loads the handoff (primary claim) → delivered_session_id + handoff_load + hl.
    const consumer = await producer.bootSecondConsumer();
    const loaded = await consumer.get(`/api/handoff/load?load_token=${token}`);
    assert.equal(loaded.found, true);
    const hrow = producer.store._db.prepare("SELECT delivered_session_id FROM handoff WHERE load_token=?").get(token);
    assert.equal(hrow.delivered_session_id, consumer.sessionId, 'load bound the consumer as the delivered session');
    assert.equal(
      producer.store._db.prepare("SELECT claim_result FROM handoff_load WHERE session_id=?").get(consumer.sessionId).claim_result,
      'primary', 'the first load is the primary claim');

    // 3. The consumer's transcript folds a load_handoff carrying the SAME token, then its segment archives
    //    (through the consumer's own watcher+store → the shared db file).
    consumer.foldLoadHandoffThenArchive(token);

    // NON-VACUITY precheck: a real profile_step_usage row with the token was written to the queried DB.
    const suRow = producer.store._db.prepare("SELECT load_token, session_id, segment FROM profile_step_usage WHERE load_token=?").get(token);
    assert.ok(suRow, 'the folded load step archived a profile_step_usage row carrying the token (non-null load_token)');
    assert.equal(suRow.load_token, token, 'the captured load_token is the prepared token, not NULL');
    assert.equal(suRow.session_id, consumer.sessionId, 'the usage row belongs to the consumer session');

    // 4. The linkage SQL the offline analysis will rely on must hold end-to-end.
    const joined = producer.store._db.prepare(`
      SELECT h.load_token, h.delivered_session_id, su.session_id, hl.claim_result
      FROM handoff h
      JOIN profile_step_usage su ON su.load_token = h.load_token
      JOIN handoff_load hl ON hl.handoff_id = h.handoff_id AND hl.session_id = h.delivered_session_id
      WHERE h.load_token = ?`).get(token);
    assert.ok(joined, 'the producer→consumer→usage chain joins on load_token + delivered_session_id');
    assert.equal(joined.session_id, consumer.sessionId, 'the usage row belongs to the delivered consumer');
    assert.equal(joined.claim_result, 'primary');

    // The consumer_segment recorded on handoff_load (server-provisional, read from getSegmentIndex at
    // load time) must line up with the segment the load step actually folded into.
    const hlSeg = producer.store._db.prepare("SELECT consumer_segment FROM handoff_load WHERE session_id=?").get(consumer.sessionId).consumer_segment;
    const suSeg = producer.store._db.prepare("SELECT segment FROM profile_step_usage WHERE load_token=? AND session_id=?").get(token, consumer.sessionId).segment;
    assert.equal(hlSeg, suSeg, 'handoff_load.consumer_segment == profile_step_usage.segment (server-provisional segment matches the folded step)');

    await consumer.teardown();
  } finally { await producer.teardown(); }
});

test('E2E linkage holds for an AUTO-MATCH load too — load_token back-filled from the tool_result', async () => {
  // An auto-match load has no input.load_token, so without the tool_result back-fill (Task 6)
  // profile_step_usage.load_token would be NULL and the join below would return nothing. This is the
  // acceptance guard for the auto-match linkage.
  const producer = await bootTestServer({ disableTelemetrySweep: true });
  try {
    producer.touchBucketPaths(['k.js'], { content: 'export const k = 1;\n' });
    const token = await producer.prepareHandoff({ paths_to_keep: [{ path: 'k.js' }], summary: 'carry me' });
    const consumer = await producer.bootSecondConsumer();
    // Auto-match load: NO load_token param — the server resolves it (project-scoped, most-recent
    // auto-match, excluding the producer's own session) and returns the resolved token in the response,
    // which lands in the tool_result the consumer folds.
    const loaded = await consumer.get(`/api/handoff/load`);   // auto-match branch
    assert.equal(loaded.found, true);
    assert.equal(loaded.load_token, token, 'auto-match resolved to the prepared token (returned to the agent)');
    // The consumer folds the auto-match load_handoff (NO input token) whose tool_result carries the resolved token.
    consumer.foldAutoMatchLoadThenArchive(loaded.load_token);
    const su = producer.store._db.prepare("SELECT load_token, session_id FROM profile_step_usage WHERE load_token=?").get(token);
    assert.ok(su, 'the auto-match load step captured the resolved token (not NULL) — linkage holds');
    assert.equal(su.load_token, token, 'back-filled load_token equals the resolved token');
    assert.equal(su.session_id, consumer.sessionId);

    // And the full linkage join holds for the auto-match path as well.
    const joined = producer.store._db.prepare(`
      SELECT h.load_token, su.session_id, hl.claim_result
      FROM handoff h
      JOIN profile_step_usage su ON su.load_token = h.load_token
      JOIN handoff_load hl ON hl.handoff_id = h.handoff_id AND hl.session_id = h.delivered_session_id
      WHERE h.load_token = ?`).get(token);
    assert.ok(joined, 'auto-match producer→consumer→usage chain joins on the back-filled load_token');
    assert.equal(joined.session_id, consumer.sessionId);
    assert.equal(joined.claim_result, 'primary');

    await consumer.teardown();
  } finally { await producer.teardown(); }
});
