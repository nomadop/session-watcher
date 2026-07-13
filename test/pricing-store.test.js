// test/pricing-store.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sw-pricing-'));
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test('loadPricing returns null when no file exists', async () => {
  const { loadPricing } = await import('../lib/pricing-store.js');
  assert.equal(loadPricing('test-session'), null);
});

test('savePricing writes and loadPricing reads back', async () => {
  const { savePricing, loadPricing } = await import('../lib/pricing-store.js');
  const result = savePricing('test-session', { readPrice: 0.30, writePrice: 3.00 });
  assert.equal(result.ratio, 10);
  assert.equal(result.readPrice, 0.30);
  assert.equal(result.writePrice, 3.00);
  assert(result.savedAt);
  const loaded = loadPricing('test-session');
  assert.deepEqual(loaded, result);
});

test('savePricing rejects invalid input', async () => {
  const { savePricing } = await import('../lib/pricing-store.js');
  assert.throws(() => savePricing('s', { readPrice: 0, writePrice: 3 }), /> 0/);
  assert.throws(() => savePricing('s', { readPrice: 0.3, writePrice: -1 }), /> 0/);
  assert.throws(() => savePricing('s', { readPrice: Infinity, writePrice: 3 }), /finite/);
  assert.throws(() => savePricing('s', { readPrice: 3, writePrice: 0.3 }), />= 1/);
});

test('deletePricing removes saved file', async () => {
  const { savePricing, deletePricing, loadPricing } = await import('../lib/pricing-store.js');
  savePricing('test-session', { readPrice: 0.30, writePrice: 3.00 });
  deletePricing('test-session');
  assert.equal(loadPricing('test-session'), null);
});

test('deletePricing is no-op when nothing saved', async () => {
  const { deletePricing } = await import('../lib/pricing-store.js');
  assert.doesNotThrow(() => deletePricing('test-session'));
});

test('savePricing stores presetId when provided', async () => {
  const { savePricing, loadPricing } = await import('../lib/pricing-store.js');
  savePricing('test-preset', { readPrice: 15, writePrice: 75, presetId: 'opus-4' });
  const loaded = loadPricing('test-preset');
  assert.equal(loaded.presetId, 'opus-4');
});
