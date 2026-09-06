import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let store, dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-hl-')); });
afterEach(async () => {
  if (store) { const { closeStore } = await import('../lib/store.js'); closeStore(store); store = null; }
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff({ sessionId: 'producer', segment: 0, loadToken: 'carry-lyric-gear',
    createdAt: 100, pathsToKeep: '[]', summary: 'sum', summaryTokens: 3 });
  const h = store._db.prepare("SELECT handoff_id FROM handoff WHERE load_token='carry-lyric-gear'").get();
  return h.handoff_id;
}

test('first load stamps delivered_session_id + loader_version and writes a primary handoff_load row', async () => {
  const id = await seed();
  const h = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  assert.equal(h.claimResult, 'primary');
  const row = store._db.prepare("SELECT delivered_session_id, loader_version, delivered_at FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(row.delivered_session_id, 'consumerA');
  assert.equal(row.loader_version, '0.5.0');
  assert.ok(row.delivered_at > 0);
  const loads = store._db.prepare("SELECT * FROM handoff_load WHERE handoff_id=?").all(id);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].session_id, 'consumerA');
  assert.equal(loads[0].claim_result, 'primary');
  assert.equal(loads[0].primary_session_id, null);
  assert.equal(loads[0].loader_version, '0.5.0');
});

test('second load from a DIFFERENT session does not overwrite the binding, returns content, records a duplicate', async () => {
  const id = await seed();
  store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  const h2 = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerB', loaderVersion: '0.5.0' });
  assert.ok(h2, 'still returns the handoff content (fail-open)');
  assert.equal(h2.claimResult, 'duplicate');
  const row = store._db.prepare("SELECT delivered_session_id FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(row.delivered_session_id, 'consumerA', 'primary binding unchanged');
  const dup = store._db.prepare("SELECT * FROM handoff_load WHERE handoff_id=? AND session_id='consumerB'").get(id);
  assert.equal(dup.claim_result, 'duplicate');
  assert.equal(dup.primary_session_id, 'consumerA');
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM handoff_load WHERE handoff_id=?").get(id).c, 2);
});

test('second load from the SAME session is an idempotent retry (primary, no new binding)', async () => {
  const id = await seed();
  store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  const again = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  assert.equal(again.claimResult, 'primary');
  const row = store._db.prepare("SELECT delivered_session_id FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(row.delivered_session_id, 'consumerA');
});

test('load with no opts (legacy caller) still returns content and does not throw', async () => {
  await seed();
  const h = store.loadHandoffByToken('carry-lyric-gear');
  assert.ok(h);
  assert.equal(h.loadToken, 'carry-lyric-gear');
});

test('a null-session load does NOT stamp the binding, so a later real session can still bind', async () => {
  // A null-session load must be a pure read (no stamp): stamping delivered_at with
  // delivered_session_id=NULL would permanently block any later real consumer from binding (the
  // delivered_at IS NULL guard never fires again) AND make every later different session mislabel
  // as claim_result='primary'.
  const id = await seed();
  const legacy = store.loadHandoffByToken('carry-lyric-gear');   // no sessionId
  assert.ok(legacy, 'still returns content (fail-open)');
  const after = store._db.prepare("SELECT delivered_at, delivered_session_id FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(after.delivered_at, null, 'no binding stamped by a session-less load');
  assert.equal(after.delivered_session_id, null);
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM handoff_load WHERE handoff_id=?").get(id).c, 0, 'no attempt row for a session-less load');
  // A real session now binds cleanly as primary.
  const real = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  assert.equal(real.claimResult, 'primary');
  assert.equal(store._db.prepare("SELECT delivered_session_id FROM handoff WHERE handoff_id=?").get(id).delivered_session_id, 'consumerA');
});

test('claimedNow separates a first claim from a same-session retry', async () => {
  await seed();
  const first = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  assert.equal(first.claimedNow, true, 'the CAS actually stamped on this call');
  const retry = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  assert.equal(retry.claimResult, 'primary');
  assert.equal(retry.claimedNow, false, 'a same-session retry did not re-claim');
});

test('CAS-stamp and the handoff_load attempt row are atomic — happy path', async () => {
  const id = await seed();
  store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  const bound = store._db.prepare("SELECT delivered_session_id FROM handoff WHERE handoff_id=?").get(id).delivered_session_id;
  const rows = store._db.prepare("SELECT COUNT(*) c FROM handoff_load WHERE handoff_id=? AND session_id='consumerA'").get(id).c;
  assert.equal(bound, 'consumerA');
  assert.equal(rows, 1, 'binding and attempt row are both present (atomic)');
});

test('delivery 记录失败时 fail-closed：无任何内容字段', async () => {
  await seed();
  const token = 'carry-lyric-gear';
  const failingStore = store;
  const origRun = failingStore._stmts.insertHandoffLoad.run;
  failingStore._stmts.insertHandoffLoad = { run() { throw new Error('injected delivery failure'); } };
  try {
    const res = failingStore.loadHandoffByToken(token, { sessionId: 'sess-consumer' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'handoff_delivery_unavailable');
    assert.equal(res.retryable, true);
    for (const k of ['summary', 'pathsToKeep', 'nextTask', 'handoffId', 'transcriptPath']) {
      assert.equal(res[k], undefined, `${k} 不得出现在失败响应里`);
    }
    assert.equal(failingStore._db.prepare('SELECT COUNT(*) c FROM handoff_load').get().c, 0);
  } finally {
    failingStore._stmts.insertHandoffLoad = { run: origRun };
  }
});

test('重试幂等：同 payload 第二次仍交付内容，且父边可解析', async () => {
  const id = await seed();
  const token = 'carry-lyric-gear';
  const projectId = 'proj-retry-idempotent';
  store._db.prepare('UPDATE handoff SET project_id = ? WHERE handoff_id = ?').run(projectId, id);
  // 成功形状不变（22 个 camelized handoff 列 + claimResult + claimedNow），没有 ok 字段 ——
  // ok:false 只是新增的失败判别式，不要拿 ok===true 断言成功。
  const first = store.loadHandoffByToken(token, { sessionId: 'sess-consumer' });
  const again = store.loadHandoffByToken(token, { sessionId: 'sess-consumer' });
  assert.equal(typeof first.summary, 'string');
  assert.equal(typeof again.summary, 'string');
  assert.equal(again.ok, undefined);
  // handoff_load 的 PK 含 loaded_at（lib/store.js:141-150），且 loaded_at = Date.now()，
  // 所以 INSERT OR IGNORE 只在同一毫秒内去重 —— 多行是合法的（§5「同一 session 可以有多条」）。
  // 该断言的对象是父边可解析，不是行数。
  assert.ok(store._db.prepare('SELECT COUNT(*) c FROM handoff_load').get().c >= 1);
  assert.ok(store.findLatestDeliveryHandoff(projectId, 'sess-consumer'));
});

test('a v2 legacy delivery (delivered_at set, delivered_session_id NULL) binds as legacy_unattributed, not primary', async () => {
  // After migration a v2 row can be delivered_at!=NULL with delivered_session_id=NULL. A logic that
  // claims only when delivered_at IS NULL, and treats as duplicate only when delivered_session_id is a
  // DIFFERENT non-null, would call EVERY later load 'primary' and never bind a real consumer.
  const id = await seed();
  // Simulate a migrated v2 delivery: a delivery timestamp exists, but the consumer was never recorded.
  store._db.prepare("UPDATE handoff SET delivered_at=50, delivered_session_id=NULL WHERE handoff_id=?").run(id);
  const first = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0', consumerSegment: 2 });
  assert.equal(first.claimResult, 'legacy_unattributed', 'a migrated delivery with unknown consumer is not a fresh primary');
  const row = store._db.prepare("SELECT delivered_at, delivered_session_id FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(row.delivered_at, 50, 'historical delivery time preserved, not overwritten');
  assert.equal(row.delivered_session_id, 'consumerA', 'first v3 consumer now bound');
  const hl = store._db.prepare("SELECT claim_result, consumer_segment FROM handoff_load WHERE handoff_id=? AND session_id='consumerA'").get(id);
  assert.equal(hl.claim_result, 'legacy_unattributed');
  assert.equal(hl.consumer_segment, 2, 'consumer segment recorded');
  // A later different session is a duplicate off the now-bound consumer.
  const second = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerB', loaderVersion: '0.5.0' });
  assert.equal(second.claimResult, 'duplicate');
});

test('delivery failure for a secondary consumer: fail-closed, primary binding unaffected', async () => {
  // consumerA holds the primary binding. When consumerB's delivery write fails, the response
  // carries no content — no falsely-reported claim metadata, no leaked handoff fields.
  const id = await seed();
  store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerA', loaderVersion: '0.5.0' });
  // Force the CAS/insert txn to throw for consumerB by breaking the attempt-insert statement.
  const origRun = store._stmts.insertHandoffLoad.run;
  store._stmts.insertHandoffLoad = { run() { throw new Error('injected txn failure'); } };
  const h = store.loadHandoffByToken('carry-lyric-gear', { sessionId: 'consumerB', loaderVersion: '0.5.0' });
  store._stmts.insertHandoffLoad = { run: origRun };
  // Fail-closed: no content returned, no claim metadata fields present.
  assert.equal(h.ok, false, 'fail-closed: no content on delivery failure');
  assert.equal(h.error, 'handoff_delivery_unavailable');
  assert.equal(h.claimResult, undefined, 'no claim metadata in failure response');
  // consumerA's primary binding is unaffected by the rollback.
  const row = store._db.prepare("SELECT delivered_session_id FROM handoff WHERE handoff_id=?").get(id);
  assert.equal(row.delivered_session_id, 'consumerA', 'primary binding unchanged');
});
