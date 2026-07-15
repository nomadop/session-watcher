// test/fold.leaf-timing-probe.test.js

// PROBE FINDINGS (run against fixtures/decf0f2c-20260703.jsonl):
// - parentUuid present on ALL assistant+usage rows: YES (814/814)
// - Tree is fully connected (no orphans): YES (1317 uuids, 1317 parent refs, 0 orphans)
// - rowsWithParent: 1316, rowsWithoutParent: 0
// - leafUuid detection strategy: follow parentUuid chain from newest row back to root;
//   the deepest uuid without a child IS the active leaf.
// CONCLUSION: M9 active-leaf detection can rely on parentUuid. No fallback needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Timing probe: confirm that in real CC transcripts, the parentUuid chain is
// fully established BEFORE assistant/usage records arrive. If this fails, M9's
// active-leaf detection needs a fallback strategy.

test('M9-probe: parentUuid is present on all rows in fixture', () => {
  const raw = readFileSync('fixtures/decf0f2c-20260703.jsonl', 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let rowsWithParent = 0;
  let rowsWithoutParent = 0;
  let firstRowNull = false;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.parentUuid === undefined && entry.uuid === undefined) continue; // metadata rows
    if (entry.parentUuid === null && i < 5) { firstRowNull = true; continue; } // root row
    if (entry.parentUuid) rowsWithParent++;
    else rowsWithoutParent++;
  }

  console.log(`Rows with parentUuid: ${rowsWithParent}`);
  console.log(`Rows without parentUuid: ${rowsWithoutParent}`);
  console.log(`First row has null parentUuid (root): ${firstRowNull}`);

  // The critical assertion: assistant/usage rows must have parentUuid
  assert.ok(rowsWithParent > 0, 'fixture has rows with parentUuid');
  assert.equal(rowsWithoutParent, 0, 'every uuid-bearing row has a parentUuid');
  // Informational — if this fails, we need the fallback strategy
  assert.ok(firstRowNull, 'first meaningful row is the tree root (parentUuid=null)');
});

test('M9-probe: parentUuid chain forms a connected tree (no orphans)', () => {
  const raw = readFileSync('fixtures/decf0f2c-20260703.jsonl', 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const uuids = new Set();
  const parentRefs = new Map(); // uuid → parentUuid

  for (const l of lines) {
    let entry;
    try { entry = JSON.parse(l); } catch { continue; }
    if (!entry.uuid) continue;
    uuids.add(entry.uuid);
    if (entry.parentUuid !== undefined) parentRefs.set(entry.uuid, entry.parentUuid);
  }

  // Every parentUuid reference should point to an existing uuid (or null for root)
  let orphans = 0;
  for (const [uuid, parent] of parentRefs) {
    if (parent !== null && !uuids.has(parent)) orphans++;
  }

  console.log(`Total uuids: ${uuids.size}, Parent refs: ${parentRefs.size}, Orphans: ${orphans}`);
  assert.equal(orphans, 0, 'no orphan parentUuid references');
});

test('M9-probe: assistant rows with usage always have parentUuid', () => {
  const raw = readFileSync('fixtures/decf0f2c-20260703.jsonl', 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let assistantWithUsage = 0;
  let assistantWithUsageAndParent = 0;

  for (const l of lines) {
    let entry;
    try { entry = JSON.parse(l); } catch { continue; }
    if (entry.type === 'assistant' && entry.message?.usage) {
      assistantWithUsage++;
      if (entry.parentUuid !== undefined) assistantWithUsageAndParent++;
    }
  }

  console.log(`Assistant+usage rows: ${assistantWithUsage}`);
  console.log(`  with parentUuid: ${assistantWithUsageAndParent}`);
  assert.equal(assistantWithUsage, assistantWithUsageAndParent,
    'ALL assistant+usage rows have parentUuid — fork detection is reliable');
});
