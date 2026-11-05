// The Store's read-only handoff catalog of one project: every retained handoff the project holds, undelivered
// before delivered, newest first. The expectations are literals the fixture below fixes, not a recomputation of
// the ordering; delivery facts the catalog must leave alone are read back through `getHandoffByToken` and the
// `handoff_load` table.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore, closeStore } from '../lib/store.js';

let store;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-hc-'));
  store = openStore(join(dir, 't.sqlite'));
});

afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

function seed({ loadToken, createdAt, nextTask, projectId, sessionId = 'producer' }) {
  const { handoffId } = store.insertHandoff({
    sessionId, segment: 0, loadToken, createdAt, pathsToKeep: '[]', summary: 'sum', summaryTokens: 3, nextTask, projectId,
  });
  return handoffId;
}

// Insertion order fixes the identities: `zeta-tie-fox` is older than `alpha-tie-owl`, so an order by token
// reads the pair the other way round from an order by identity. Creation times 1000 and 500 lie outside the
// auto-match window, and the project holds more rows than the auto-match listing keeps.
function seedProject() {
  seed({ loadToken: 'old-lamp-crow', createdAt: 1000, nextTask: null, projectId: 'proj-a' });
  seed({ loadToken: 'zeta-tie-fox', createdAt: 4000, nextTask: 'zeta task', projectId: 'proj-a' });
  seed({ loadToken: 'alpha-tie-owl', createdAt: 4000, nextTask: 'alpha task', projectId: 'proj-a' });
  seed({ loadToken: 'new-river-moth', createdAt: 5000, nextTask: 'ship the picker', projectId: 'proj-a' });
  seed({ loadToken: 'done-new-pine', createdAt: 6000, nextTask: 'delivered later task', projectId: 'proj-a' });
  const legacyId = seed({ loadToken: 'done-old-cove', createdAt: 500, nextTask: null, projectId: 'proj-a' });
  // A delivery from before consumers were bound: `delivered_at` alone marks it delivered.
  store._db.prepare('UPDATE handoff SET delivered_at = 7777 WHERE handoff_id = ?').run(legacyId);
  store.deliverHandoffByToken('done-new-pine', { sessionId: 'consumer', loaderVersion: 'test', consumerSegment: 0 });
}

test('列出当前项目全部 handoff：未交付在前、已交付在后，各组创建时间降序、同时间按身份降序', () => {
  seedProject();
  const deliveredAt = store.getHandoffByToken('done-new-pine').deliveredAt;
  assert.ok(deliveredAt > 0, 'the delivery stamped its time');

  assert.deepEqual(store.listHandoffCandidatesByProject('proj-a'), [
    { loadToken: 'new-river-moth', createdAt: 5000, nextTask: 'ship the picker', deliveredAt: null },
    { loadToken: 'alpha-tie-owl', createdAt: 4000, nextTask: 'alpha task', deliveredAt: null },
    { loadToken: 'zeta-tie-fox', createdAt: 4000, nextTask: 'zeta task', deliveredAt: null },
    { loadToken: 'old-lamp-crow', createdAt: 1000, nextTask: null, deliveredAt: null },
    { loadToken: 'done-new-pine', createdAt: 6000, nextTask: 'delivered later task', deliveredAt },
    { loadToken: 'done-old-cove', createdAt: 500, nextTask: null, deliveredAt: 7777 },
  ]);
});

test('目录只含所问项目：其他项目留在自己的目录，NULL、空字符串与未知项目得空目录', () => {
  seedProject();
  seed({ loadToken: 'other-project-x', createdAt: 9000, nextTask: 'elsewhere', projectId: 'proj-b' });
  seed({ loadToken: 'no-project-y', createdAt: 9100, nextTask: 'nowhere', projectId: null });
  seed({ loadToken: 'blank-project-z', createdAt: 9200, nextTask: 'blank', projectId: '' });

  assert.deepEqual(store.listHandoffCandidatesByProject('proj-b'), [
    { loadToken: 'other-project-x', createdAt: 9000, nextTask: 'elsewhere', deliveredAt: null },
  ]);
  assert.ok(!store.listHandoffCandidatesByProject('proj-a').some(row => ['other-project-x', 'no-project-y', 'blank-project-z'].includes(row.loadToken)));
  for (const projectId of [null, '', 'proj-unknown']) {
    assert.deepEqual(store.listHandoffCandidatesByProject(projectId), [], `${JSON.stringify(projectId)}`);
  }
});

test('读目录不写交付：交付绑定与 handoff_load 在读前后一致', () => {
  seedProject();
  const tokens = ['old-lamp-crow', 'zeta-tie-fox', 'alpha-tie-owl', 'new-river-moth', 'done-new-pine', 'done-old-cove'];
  const bindings = () => tokens.map(token => store.getHandoffByToken(token));
  const loads = () => store._db.prepare('SELECT * FROM handoff_load ORDER BY handoff_id, session_id, loaded_at').all().map(row => ({ ...row }));
  const before = { bindings: bindings(), loads: loads() };
  assert.equal(before.loads.length, 1, 'the fixture delivered one handoff');

  store.listHandoffCandidatesByProject('proj-a');
  store.listHandoffCandidatesByProject('proj-a');

  assert.deepEqual({ bindings: bindings(), loads: loads() }, before);
});
