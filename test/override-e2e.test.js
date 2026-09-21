// test/override-e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'sw-e2e-override-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';
import { assistantToolUse, toolResult, ts, usage } from './helpers/transcript-fixtures.js';

// Both paths become resident through real Read tool pairs in the Source — a big one and a small one, so an
// override that excludes the big path moves bDefault enough to move x and br with it.
const BIG = '/workspace/src/big.ts';
const SMALL = '/workspace/src/small.ts';

const SIB_A = '/workspace/lib/a.js';
const SIB_B = '/workspace/lib/b.js';
const SIB_C = '/workspace/lib/c.js';
// The leaf the sibling append chains onto: `measuredTranscript`'s last row is the final step's tool result.
const LAST_LEAF = 'sr9';

// One Read tool pair making `path` resident, as its own measured step.
const readOf = (path, tag) => [
  assistantToolUse({
    uuid: `sib-${tag}`, messageId: `sibm-${tag}`, toolUseId: `sibt-${tag}`, name: 'Read',
    input: { file_path: path }, timestamp: ts(5), model: 'deepseek-v4-pro',
    usage: usage({ input: 40, output: 30, cacheRead: 70000 }),
  }),
  toolResult({
    uuid: `sibr-${tag}`, toolUseId: `sibt-${tag}`,
    content: Array.from({ length: 20 }, (unused, i) => `${i + 1}\tconst s${i} = ${i};`).join('\n'),
  }),
];

// Two siblings resident from the start, so the third can be inferred from them.
async function withServerWithSiblings(fn) {
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({
      steps: 10, paths: [SIB_A, SIB_B],
      content: 'export const filler = 1;\n'.repeat(40),
    }),
    sessionId: 'test-e2e-siblings', projectRoot: '/workspace',
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher, composed); } finally { stopTimers(); await composed.teardown(); }
}

async function withServer(fn) {
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({
      steps: 10, paths: [BIG, SMALL],
      content: 'export const filler = 1;\n'.repeat(80),
    }),
    sessionId: 'test-e2e', projectRoot: '/workspace',
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher); } finally { stopTimers(); await composed.teardown(); }
}

test('Apply override changes bDefault which changes x/br in status', async () => {
  await withServer(async (port, w) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const bDefaultBefore = w.getBucketData().bDefault;

    // Exclude the big file
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { [BIG]: 'exclude' } }),
    });
    assert.equal(res.status, 200);

    const bDefaultAfter = w.getBucketData().bDefault;
    assert.ok(bDefaultAfter < bDefaultBefore, `bDefault should decrease: ${bDefaultAfter} < ${bDefaultBefore}`);

    // `x` is read against the SELECTED basis, so the identity has to hold on both sides of the override —
    // a disjunction over "something moved" would stay green if x silently switched to the unfiltered total.
    const after = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(before.bDefault, bDefaultBefore);
    assert.equal(after.bDefault, bDefaultAfter);
    for (const status of [before, after]) {
      assert.ok(Math.abs(status.x - status.L / status.bDefault) < 1e-9,
        `x must be L/bDefault: got ${status.x}, L=${status.L}, bDefault=${status.bDefault}`);
    }
    assert.ok(after.x > before.x, 'excluding a resource shrinks the basis, so x rises');
  });
});

test('Reset (empty overrides) restores original bDefault', async () => {
  await withServer(async (port, w) => {
    const bOriginal = w.getBucketData().bDefault;

    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { [BIG]: 'exclude' } }),
    });
    assert.notEqual(w.getBucketData().bDefault, bOriginal);

    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: {} }),
    });
    assert.equal(w.getBucketData().bDefault, bOriginal);
  });
});

// Sibling inference is driven by the SOURCE now: a resource key the Engine reports as newly created is what
// triggers the resource-policy flush, and the flush takes ONE snapshot of the resident set per Engine epoch.
// So the new sibling has to arrive as a real Read in the Source rather than as an injected map entry — which
// is also the only way the inference under test is the one production runs.
test('a new sibling of excluded siblings is inferred excluded, and an Apply preserves it', async () => {
  await withServerWithSiblings(async (port, w, composed) => {
    const overrideOf = (path) => w.getBucketData().paths.find(row => row.path === path)?.userOverride ?? null;

    // Exclude the two siblings through the route, which is the only way a manual override is established.
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { [SIB_A]: 'exclude', [SIB_B]: 'exclude' } }),
    });
    assert.equal(res.status, 200);
    assert.equal(overrideOf(SIB_A), 'exclude');
    assert.equal(overrideOf(SIB_B), 'exclude');

    // A THIRD file in the same directory arrives in the Source. The flush infers from its siblings.
    composed.appendRows(readOf(SIB_C, 'zz'), { parentUuid: LAST_LEAF });
    assert.equal(overrideOf(SIB_C), 'exclude', 'the new sibling is inferred excluded from its siblings');

    // An Apply that re-sends every non-default entry keeps all three: manual and inferred share one set.
    const applied = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { [SIB_A]: 'exclude', [SIB_B]: 'exclude', [SIB_C]: 'exclude' } }),
    });
    assert.equal(applied.status, 200);
    assert.equal(overrideOf(SIB_C), 'exclude');
  });
});
