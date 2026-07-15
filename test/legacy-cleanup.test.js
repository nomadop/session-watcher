import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('cleanupLegacyJson removes old JSON directories', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sw-legacy-'));
  const rateLamp = join(base, 'rate-lamp');
  const gate = join(base, 'gate');
  const pricing = join(base, 'pricing');
  mkdirSync(rateLamp);
  mkdirSync(gate);
  mkdirSync(pricing);
  writeFileSync(join(rateLamp, 'sess1.json'), '{}');
  writeFileSync(join(gate, 'sess1.json'), '{}');
  writeFileSync(join(pricing, 'sess1.json'), '{}');

  const { cleanupLegacyJson } = await import('../lib/legacy-cleanup.js');
  cleanupLegacyJson(base);

  assert.ok(!existsSync(rateLamp));
  assert.ok(!existsSync(gate));
  assert.ok(!existsSync(pricing));
  rmSync(base, { recursive: true, force: true });
});

test('cleanupLegacyJson is no-op if dirs do not exist', async () => {
  const { cleanupLegacyJson } = await import('../lib/legacy-cleanup.js');
  assert.doesNotThrow(() => cleanupLegacyJson('/nonexistent-path-xyz'));
});

test('cleanupLegacyJson skips non-.json files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sw-legacy-'));
  const rateLamp = join(base, 'rate-lamp');
  mkdirSync(rateLamp);
  writeFileSync(join(rateLamp, 'important.txt'), 'keep me');
  writeFileSync(join(rateLamp, 'sess.json'), '{}');

  const { cleanupLegacyJson } = await import('../lib/legacy-cleanup.js');
  cleanupLegacyJson(base);

  // Dir still exists because non-json file remained
  assert.ok(existsSync(join(rateLamp, 'important.txt')));
  assert.ok(!existsSync(join(rateLamp, 'sess.json')));
  rmSync(base, { recursive: true, force: true });
});
