import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGateState, saveGateState } from '../lib/gate-store.js';

test('67: gate-store round-trips via atomic write', () => {
  process.env.CLAUDE_PLUGIN_DATA = join(tmpdir(), `gs-${process.pid}`);
  const st = { segment: 1, turnSeq: 3, maxTierFired: 1, pendingCount: 0 };
  saveGateState('sessA', st);
  assert.deepEqual(loadGateState('sessA'), st);
  assert.equal(loadGateState('missing'), null);
  rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
