import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal } from '../lib/store.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-gate-'));
  initStore(join(dir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

test('gate-store round-trips via SQLite', async () => {
  const { loadGateState, saveGateState } = await import('../lib/gate-store.js');
  const st = { segment: 1, turnSeq: 3, maxTierFired: 1, pendingCount: 0 };
  saveGateState('sessA', st);
  assert.deepEqual(loadGateState('sessA'), st);
  assert.equal(loadGateState('missing'), null);
});
