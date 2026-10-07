// The DSH client's locale dictionaries and the result-to-state mapping the tab's badge and the dock's short word share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en, zh, resultSignalState } from '../dsh/src/client/locales.js';

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

test('the English and Chinese dock texts carry the same keys and the same placeholders', () => {
  const dockKeys = dictionary => Object.keys(dictionary).filter(key => key.startsWith('dock.')).sort();
  assert.deepEqual(dockKeys(zh), dockKeys(en));
  assert.ok(dockKeys(en).length > 0);
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of dockKeys(en)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
});
