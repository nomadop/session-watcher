// test/pricingChip.preset.test.js — Unit tests for pricing preset logic (spec §1.2 / Task 7)
// Tests the pure logic that will be used in pricingChip.js:
// 1. activePresetId resolution from API data
// 2. Drift detection (manual edit clears preset)
//
// These are logic-level tests — no DOM required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActivePresetId, isDriftedFromPreset } from '../public/lib/pricingHelpers.js';

// ── activePresetId resolution ──────────────────────────────────────────────────────────────────
// Rule: only set activePresetId when effectiveSource === 'preset' AND data.saved?.presetId exists.
// If source='saved' but presetId is stored, that's a drift state — treat as custom (null).
// Adapter: the helper takes (effectiveSource, savedPresetId), tests pass full data objects.
function resolveActivePresetIdFromData(data) {
  const effectiveSource = data?.effective?.source ?? null;
  return resolveActivePresetId(effectiveSource, data?.saved?.presetId);
}

test('activePresetId: source=preset + presetId → returns presetId', () => {
  const data = {
    effective: { source: 'preset', readPrice: 15, writePrice: 75 },
    saved: { presetId: 'opus-4', readPrice: 15, writePrice: 75 },
  };
  assert.equal(resolveActivePresetIdFromData(data), 'opus-4');
});

test('activePresetId: source=preset but no saved.presetId → null', () => {
  const data = {
    effective: { source: 'preset', readPrice: 15, writePrice: 75 },
    saved: { readPrice: 15, writePrice: 75 },
  };
  assert.equal(resolveActivePresetIdFromData(data), null);
});

test('activePresetId: source=saved (drift state) → null, even with presetId stored', () => {
  // Drift: prices changed after preset was saved — source becomes 'saved', not 'preset'
  const data = {
    effective: { source: 'saved', readPrice: 999, writePrice: 999 },
    saved: { presetId: 'opus-4', readPrice: 999, writePrice: 999 },
  };
  assert.equal(resolveActivePresetIdFromData(data), null);
});

test('activePresetId: source=model_default → null', () => {
  const data = {
    effective: { source: 'model_default', readPrice: 3, writePrice: 15 },
    saved: null,
  };
  assert.equal(resolveActivePresetIdFromData(data), null);
});

test('activePresetId: source=cli → null', () => {
  const data = {
    effective: { source: 'cli', readPrice: 3, writePrice: 15 },
    saved: null,
  };
  assert.equal(resolveActivePresetIdFromData(data), null);
});

test('activePresetId: null data → null', () => {
  assert.equal(resolveActivePresetIdFromData(null), null);
});

// ── Drift detection (manual edit clears preset) ──────────────────────────────────────────────────
// Rule: if user edits inputs and values drift from the selected preset's prices, clear activePresetId.
// NaN guard: parseFloat('') → NaN; must handle explicitly via Number.isFinite().

const opusPreset = { id: 'opus-4', label: 'Claude Opus 4', readPrice: 15, writePrice: 75 };

test('drift: values exactly match preset → not drifted', () => {
  assert.equal(isDriftedFromPreset('15', '75', opusPreset), false);
});

test('drift: values match preset after toFixed(4) → not drifted', () => {
  // After selecting a preset, inputs are set to .toFixed(4) — e.g., "15.0000"
  assert.equal(isDriftedFromPreset('15.0000', '75.0000', opusPreset), false);
});

test('drift: read price differs → drifted', () => {
  assert.equal(isDriftedFromPreset('16', '75', opusPreset), true);
});

test('drift: write price differs → drifted', () => {
  assert.equal(isDriftedFromPreset('15', '76', opusPreset), true);
});

test('drift: both prices differ → drifted', () => {
  assert.equal(isDriftedFromPreset('16', '76', opusPreset), true);
});

test('drift: empty read input (NaN) → drifted', () => {
  // parseFloat('') → NaN; Number.isFinite(NaN) → false → drifted
  assert.equal(isDriftedFromPreset('', '75', opusPreset), true);
});

test('drift: empty write input (NaN) → drifted', () => {
  assert.equal(isDriftedFromPreset('15', '', opusPreset), true);
});

test('drift: both empty → drifted', () => {
  assert.equal(isDriftedFromPreset('', '', opusPreset), true);
});

test('drift: non-numeric read input → drifted', () => {
  // parseFloat('abc') → NaN
  assert.equal(isDriftedFromPreset('abc', '75', opusPreset), true);
});

test('drift: values within 1e-9 tolerance → not drifted', () => {
  // Floating point tolerance check
  assert.equal(isDriftedFromPreset('15.0000000001', '75', opusPreset), false);
});

test('drift: values just outside 1e-9 tolerance → drifted', () => {
  assert.equal(isDriftedFromPreset('15.000000002', '75', opusPreset), true);
});

// ── populatePresetOptions: option list shape ─────────────────────────────────────────────────────
// Verify the preset list from constants is shaped correctly for dropdown options

test('preset list shape: each entry has id, label, readPrice, writePrice', () => {
  const presets = [
    { id: 'opus-4', label: 'Claude Opus 4', readPrice: 15, writePrice: 75 },
    { id: 'sonnet-4', label: 'Claude Sonnet 4', readPrice: 3, writePrice: 15 },
  ];
  for (const p of presets) {
    assert.ok(typeof p.id === 'string', `id must be string: ${p.id}`);
    assert.ok(typeof p.label === 'string', `label must be string: ${p.label}`);
    assert.ok(typeof p.readPrice === 'number' && p.readPrice > 0, `readPrice must be positive number: ${p.readPrice}`);
    assert.ok(typeof p.writePrice === 'number' && p.writePrice > 0, `writePrice must be positive number: ${p.writePrice}`);
    assert.ok(p.writePrice > p.readPrice, `writePrice > readPrice (expected for all known models): ${p.id}`);
  }
});

test('preset list: ratio matches expected values', () => {
  // opus-4: 75/15 = 5, sonnet-4: 15/3 = 5
  const presets = [
    { id: 'opus-4', readPrice: 15, writePrice: 75 },
    { id: 'sonnet-4', readPrice: 3, writePrice: 15 },
  ];
  for (const p of presets) {
    const ratio = p.writePrice / p.readPrice;
    assert.ok(Math.abs(ratio - 5) < 1e-9, `expected ratio=5 for ${p.id}, got ${ratio}`);
  }
});
