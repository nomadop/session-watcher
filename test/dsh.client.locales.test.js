// The DSH client's locale dictionaries and the result-to-state mapping the tab's badge and the dock's short word share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en, zh, resultSignalState } from '../dsh/src/client/locales.js';
import { KAPPA_PRESETS } from '../lib/inner-seal/quote.js';
import { SOURCE_FAILURES } from '../dsh/src/pi-ai-integration.js';
import { SKIP_REASONS } from '../lib/llm-adapter/carrier-results.js';

test('resultSignalState names the signal state a result without a reading reads as: no result and bootstrapping are reading, an unreachable result unreachable, the rest their own state', () => {
  assert.equal(resultSignalState(null), 'reading');
  assert.equal(resultSignalState({ kind: 'state', state: 'bootstrapping' }), 'reading');
  assert.equal(resultSignalState({ kind: 'state', state: 'unobserved' }), 'unobserved');
  assert.equal(resultSignalState({ kind: 'state', state: 'failed', diagnostic: { message: 'read refused' } }), 'failed');
  assert.equal(resultSignalState({ kind: 'unreachable', message: 'HTTP 405' }), 'unreachable');
});

test('every state resultSignalState answers has a signal text in both locales', () => {
  const results = [null, { kind: 'state', state: 'bootstrapping' }, { kind: 'state', state: 'unobserved' }, { kind: 'state', state: 'failed' }, { kind: 'unreachable', message: 'x' }];
  for (const result of results) {
    const key = `signal.${resultSignalState(result)}`;
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
  }
});

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('the English and Chinese dock texts carry the same keys and the same placeholders', () => {
  const dockKeys = dictionary => Object.keys(dictionary).filter(key => key.startsWith('dock.')).sort();
  assert.deepEqual(dockKeys(zh), dockKeys(en));
  assert.ok(dockKeys(en).length > 0);
  for (const key of dockKeys(en)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
});

test('the English and Chinese monitor texts carry the same keys and the same placeholders', () => {
  const monitorKeys = dictionary => Object.keys(dictionary).filter(key => key.startsWith('monitor.')).sort();
  assert.deepEqual(monitorKeys(zh), monitorKeys(en));
  assert.ok(monitorKeys(en).length > 0);
  for (const key of monitorKeys(en)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
});

test('the old-attribution slot warning the monitor folds has its text in both locales, the Chinese one as agreed', () => {
  assert.equal(zh['monitor.warning.old-attribution'], '文件读取的旧归因占比高');
  assert.equal(typeof en['monitor.warning.old-attribution'], 'string');
});

test('the tools page words each direct-read kind as the attempt its dispatch was, in both locales, and the slot row keeps the wording it had', () => {
  const attempts = {
    'handoff-recall': ['尝试直读交接载荷', 'Attempted a direct read of the handoff payload'],
    'carrier-recall': ['尝试直读压缩载体', 'Attempted a direct read of the compaction carrier'],
    'verbatim-recall': ['尝试回读：目标含封存已携带的原文', 'Attempted a read-back: the target includes verbatim text carried by compaction'],
  };
  const rows = {
    'handoff-recall': ['直读交接载荷', 'Direct handoff payload read'],
    'carrier-recall': ['直读压缩载体', 'Direct compaction carrier read'],
    'verbatim-recall': ['回读目标含封存已携带的原文', 'Read target includes verbatim text carried by compaction'],
  };
  for (const [kind, [attemptZh, attemptEn]] of Object.entries(attempts)) {
    assert.deepEqual([zh[`monitor.tool.attempt.${kind}`], en[`monitor.tool.attempt.${kind}`]], [attemptZh, attemptEn], kind);
    assert.deepEqual([zh[`monitor.warning.${kind}`], en[`monitor.warning.${kind}`]], rows[kind], `${kind}: the row's wording`);
  }
});

test('every preset the host prices a quote under has a name in both locales', () => {
  for (const id of Object.keys(KAPPA_PRESETS)) {
    const key = `monitor.quote.preset.${id}`;
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
  }
});

test('every reason a path can be unreadable for that the file list words has a text in both locales', () => {
  for (const reason of ['missing', 'not-file', 'too-large', 'binary', 'unreadable']) {
    const key = `monitor.files.reason.${reason}`;
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
  }
});

test('every cause the pi-ai entry reports has a cause text in both locales, beside the integration failure\'s title, consequence and recovery, with the same keys and placeholders in each', () => {
  const integrationKeys = dictionary => Object.keys(dictionary).filter(key => key.startsWith('settings.integration.')).sort();
  assert.deepEqual(integrationKeys(zh), integrationKeys(en));
  for (const key of [...SOURCE_FAILURES.map(cause => `settings.integration.cause.${cause}`), 'settings.integration.title', 'settings.integration.consequence', 'settings.integration.recovery']) {
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
  }
});

test('every reason a checked carrier request got no point of its own has a text in both locales', () => {
  assert.ok(SKIP_REASONS.length > 0);
  for (const reason of SKIP_REASONS) {
    const key = `monitor.carrierCache.reason.${reason}`;
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
  }
});

test('every text the first install of the carrier cache bundle adds to the Settings page is in both locales with the same placeholders', () => {
  const keys = [
    'settings.carrier.notInstalled', 'settings.carrier.install.confirm', 'settings.carrier.install.accept', 'settings.carrier.install.cancel', 'settings.carrier.install.running', 'settings.carrier.installedNote',
    'settings.carrier.unavailable.conflict', 'settings.carrier.unavailable.damaged', 'settings.carrier.unavailable.unreadable',
    'settings.carrier.outcome.installed-enabled', 'settings.carrier.outcome.install-confirmation-required', 'settings.carrier.outcome.install-failed',
    'settings.carrier.outcome.install-unconfirmed',
  ];
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
  }
  assert.deepEqual(placeholders(en['settings.carrier.notInstalled']), ['name', 'version']);
  assert.deepEqual(placeholders(en['settings.carrier.install.confirm']), ['name', 'version']);
  const carrierKeys = dictionary => Object.keys(dictionary).filter(key => key.startsWith('settings.carrier.')).sort();
  assert.deepEqual(carrierKeys(zh), carrierKeys(en));
});
