// test/pricing-store.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal } from '../lib/store.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-pricing-'));
  initStore(join(dir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

test('loadPricingOverride returns null when nothing saved', async () => {
  const { loadPricingOverride } = await import('../lib/pricing-store.js');
  assert.equal(loadPricingOverride('claude-sonnet-4'), null);
});

test('savePricingOverride + loadPricingOverride roundtrip', async () => {
  const { savePricingOverride, loadPricingOverride } = await import('../lib/pricing-store.js');
  const result = savePricingOverride('claude-sonnet-4', { readPrice: 3, writePrice: 15 });
  assert.equal(result.ratio, 5);
  assert.equal(result.readPrice, 3);
  const loaded = loadPricingOverride('claude-sonnet-4');
  assert.equal(loaded.ratio, 5);
  assert.ok(loaded.savedAt);
});

test('savePricingOverride rejects invalid input', async () => {
  const { savePricingOverride } = await import('../lib/pricing-store.js');
  assert.throws(() => savePricingOverride('m', { readPrice: 0, writePrice: 3 }), /> 0/);
  assert.throws(() => savePricingOverride('m', { readPrice: 3, writePrice: -1 }), /> 0/);
  assert.throws(() => savePricingOverride('m', { readPrice: Infinity, writePrice: 3 }), /finite/);
  assert.throws(() => savePricingOverride('m', { readPrice: 3, writePrice: 0.3 }), />= 1/);
});

test('deletePricingOverride removes saved config', async () => {
  const { savePricingOverride, deletePricingOverride, loadPricingOverride } = await import('../lib/pricing-store.js');
  savePricingOverride('opus', { readPrice: 15, writePrice: 75 });
  deletePricingOverride('opus');
  assert.equal(loadPricingOverride('opus'), null);
});

test('savePricingOverride stores presetId', async () => {
  const { savePricingOverride, loadPricingOverride } = await import('../lib/pricing-store.js');
  savePricingOverride('opus', { readPrice: 15, writePrice: 75, presetId: 'opus-4' });
  assert.equal(loadPricingOverride('opus').presetId, 'opus-4');
});
