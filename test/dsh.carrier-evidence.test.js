// The host's record of what the pi-ai entry's wrapped hook did for one summary request (`dsh/src/carrier-evidence.js`): the service the entry reports to, filed under the scope around the request's stream. The same service over the real pi-ai entry is exercised in `dsh.pi-ai-carrier-cache.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarrierEvidence } from '../dsh/src/carrier-evidence.js';
import { MAX_CARRIER_EVIDENCE } from '../lib/inner-seal/call-record.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('the service records results and answers nothing else: the Responses switch is the settings service\'s', () => {
  const { service } = createCarrierEvidence();
  assert.deepEqual(Object.keys(service), ['record']);
  assert.equal(Object.isFrozen(service), true);
});

test('a result is filed as the closed shape alone, in the order it was reported, under the scope its call runs in', () => {
  const { service, scope: open } = createCarrierEvidence();
  const scope = open();
  assert.equal(scope.evidence(), null);
  scope.run(() => {
    service.record({ result: 'added' });
    service.record({ result: 'skipped', reason: 'no-carrier' });
    service.record({ result: 'native' });
  });
  assert.deepEqual(scope.evidence(), { results: [{ result: 'added' }, { result: 'skipped', reason: 'no-carrier' }, { result: 'native' }], omitted: 0 });
});

test('a result that is no closed result, and one reported outside every scope, is filed nowhere', () => {
  const { service, scope: open } = createCarrierEvidence();
  const scope = open();
  service.record({ result: 'added' });
  scope.run(() => {
    for (const value of [null, 'added', { result: 'unknown' }, { result: 'skipped' }, { result: 'skipped', reason: 'unknown' }, { result: 'added', reason: 'no-carrier' }]) service.record(value);
  });
  assert.equal(scope.evidence(), null);
});

test('a scope keeps a bounded list and counts what it left out', () => {
  const { service, scope: open } = createCarrierEvidence();
  const scope = open();
  scope.run(() => { for (let at = 0; at < MAX_CARRIER_EVIDENCE + 3; at += 1) service.record({ result: 'native' }); });
  const evidence = scope.evidence();
  assert.equal(evidence.results.length, MAX_CARRIER_EVIDENCE);
  assert.equal(evidence.omitted, 3);
});

test('overlapping scopes keep each its own results across awaits, and a report outside both is filed under neither', async () => {
  const { service, scope: open } = createCarrierEvidence();
  const first = open();
  const second = open();
  await Promise.all([
    first.run(async () => { service.record({ result: 'added' }); await tick(); service.record({ result: 'native' }); }),
    second.run(async () => { await tick(); service.record({ result: 'skipped', reason: 'points-full' }); }),
    (async () => { await tick(); service.record({ result: 'skipped', reason: 'unsupported' }); })(),
  ]);
  assert.deepEqual(first.evidence(), { results: [{ result: 'added' }, { result: 'native' }], omitted: 0 });
  assert.deepEqual(second.evidence(), { results: [{ result: 'skipped', reason: 'points-full' }], omitted: 0 });
});
