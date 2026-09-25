// test/bucketPanel.preview.test.js — the preview publisher's async lifecycle, driven through the
// module-level factory `mount` builds its dispatcher from. No DOM: the event sink, the selection
// predicate and the override payload all arrive as callbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewPublisher } from '../public/elements/bucketPanel.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A turn of the macrotask queue drains every microtask the lifecycle is waiting on.
const flush = () => new Promise(r => setTimeout(r, 0));

// The lifecycle carries the scenario opaquely, so the fake's job is to carry `readScenario`'s shape
// rather than a placeholder a consumer could not read. The trajectory's seq tells one case's scenario
// from another's, and each is published by reference, so a case can assert on identity.
const scenarioAt = (seq) => ({ reliable: true, trajectory: [{ seq, x: 2, u: 1, pp: 0.5 }] });

// Each stub request carries two independent deferreds — one for the fetch promise, one for the body —
// so a case can supersede a request at either of the lifecycle's two suspension points.
function makePublisher() {
  const events = [];
  const requests = [];
  let selection = false;
  let overrides = {};
  const dispatchPreview = createPreviewPublisher({
    fetchImpl: (url, init) => {
      const res = deferred();
      const body = deferred();
      const req = {
        url,
        init,
        eventsBefore: events.length,
        bodyRead: false,
        body,
        // The response shape is what the lifecycle reads: an `ok` flag and a `json()` returning a promise.
        ok() { res.resolve({ ok: true, json: () => { req.bodyRead = true; return body.promise; } }); },
        notOk() { res.resolve({ ok: false, json: () => { req.bodyRead = true; return body.promise; } }); },
        fail(err) { res.reject(err); },
      };
      requests.push(req);
      return res.promise;
    },
    emit: (detail) => events.push(detail),
    hasSelection: () => selection,
    overridesOf: () => overrides,
  });
  return {
    events,
    requests,
    dispatchPreview,
    select(next) { selection = true; overrides = next; },
    // What the panel's own garbage collection does to the map, rather than a user action: a resource whose
    // tokens fall to zero leaves the bucket data, so its label leaves the tree and its override with it.
    clearSelection() { selection = false; overrides = {}; },
  };
}

// Silences the lifecycle's own diagnostic for the rejected-request cases.
async function withoutErrorLog(fn) {
  const orig = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = orig; }
}

test('the clear path burns the gate token and publishes not-dirty before the call returns', async () => {
  const h = makePublisher();
  const ghost = scenarioAt(1);
  h.select({ 'a.js': 'exclude' });
  const inFlight = h.dispatchPreview();
  assert.equal(h.requests.length, 1);

  h.dispatchPreview(true);
  assert.deepEqual(h.events.at(-1), { dirty: false }, 'the clear publishes without awaiting anything');

  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: ghost });
  await inFlight;
  await flush();
  assert.deepEqual(h.events, [{ dirty: true, scenario: null }, { dirty: false }],
    'the withdrawn ghost is not resurrected by the response still in flight');
});

test('after a clear, the same override map withdraws again', async () => {
  const h = makePublisher();
  const folded = scenarioAt(1);
  const refolded = scenarioAt(2);
  h.select({ 'a.js': 'exclude' });
  const first = h.dispatchPreview();
  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: folded });
  await first;
  assert.deepEqual(h.events, [{ dirty: true, scenario: null }, { dirty: true, scenario: folded }]);

  await h.dispatchPreview(true);
  const second = h.dispatchPreview();
  assert.deepEqual(h.events.at(-1), { dirty: true, scenario: null },
    'the clear left no content key, so the same map is a change again');
  assert.equal(h.events.length, 4);

  h.requests[1].ok();
  h.requests[1].body.resolve({ scenario: refolded });
  await second;
  assert.equal(h.events.at(-1).scenario, refolded);
});

// The snapshot path dispatches on every tick, so the withdrawal has to reach the listeners when the
// map empties without a user touching anything, and has to stay quiet on every tick after that.
test('a withdrawal reaches the listeners once, and a dispatch with nothing standing publishes nothing', async () => {
  const h = makePublisher();
  const folded = scenarioAt(1);

  await h.dispatchPreview();
  assert.deepEqual(h.events, [], 'nothing is published, so there is nothing to withdraw');
  await h.dispatchPreview(true);
  assert.deepEqual(h.events, [], 'a forced clear with nothing standing is silent too');

  h.select({ 'a.js': 'exclude' });
  const first = h.dispatchPreview();
  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: folded });
  await first;
  assert.deepEqual(h.events, [{ dirty: true, scenario: null }, { dirty: true, scenario: folded }]);

  h.clearSelection();
  await h.dispatchPreview();
  assert.deepEqual(h.events.at(-1), { dirty: false }, 'the emptied map withdraws the published ghost');
  assert.equal(h.events.length, 3);

  await h.dispatchPreview();
  await h.dispatchPreview();
  assert.equal(h.events.length, 3, 'the ghost is withdrawn once, not once per snapshot');
});

test('a changed override map withdraws the picture before the request goes out', async () => {
  const h = makePublisher();
  const forA = scenarioAt(1);
  const forB = scenarioAt(2);
  h.select({ 'a.js': 'exclude' });
  const first = h.dispatchPreview();
  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: forA });
  await first;

  h.select({ 'b.js': 'exclude' });
  const second = h.dispatchPreview();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].eventsBefore, 3, 'the withdraw is published before the request is issued');
  assert.deepEqual(h.events[2], { dirty: true, scenario: null });
  assert.equal(h.requests[1].url, '/api/preview');
  assert.deepEqual(JSON.parse(h.requests[1].init.body), { overrides: { 'b.js': 'exclude' } });

  h.requests[1].ok();
  h.requests[1].body.resolve({ scenario: forB });
  await second;
  assert.equal(h.events.at(-1).scenario, forB);
});

test('an unchanged override map keeps the picture until the response lands', async () => {
  const h = makePublisher();
  const shown = scenarioAt(1);
  const refreshed = scenarioAt(2);
  h.select({ 'a.js': 'exclude' });
  const first = h.dispatchPreview();
  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: shown });
  await first;

  const repost = h.dispatchPreview();
  assert.equal(h.requests[1].eventsBefore, 2, 'the re-post issues its request without publishing first');
  assert.equal(h.events.length, 2, 'the scenario stays up while the re-post is in flight');
  assert.equal(h.events.at(-1).scenario, shown, 'and it is still the scenario the earlier response folded');

  h.requests[1].ok();
  h.requests[1].body.resolve({ scenario: refreshed });
  await repost;
  assert.equal(h.events.at(-1).scenario, refreshed);
  assert.equal(h.events.length, 3);
});

test('a response superseded before the ok-check parses no body and publishes nothing', async () => {
  const h = makePublisher();
  const staleScenario = scenarioAt(9);
  const freshScenario = scenarioAt(2);
  h.select({ 'a.js': 'exclude' });
  const stale = h.dispatchPreview();
  h.select({ 'b.js': 'exclude' });
  const latest = h.dispatchPreview();
  assert.equal(h.events.length, 2, 'one withdraw per map');

  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: staleScenario });
  await stale;
  await flush();
  assert.equal(h.requests[0].bodyRead, false, 'the superseded response is dropped before its body is read');
  assert.equal(h.events.length, 2);

  h.requests[1].ok();
  h.requests[1].body.resolve({ scenario: freshScenario });
  await latest;
  assert.equal(h.events.at(-1).scenario, freshScenario);
});

test('a response superseded while its body parses publishes no scenario', async () => {
  const h = makePublisher();
  const staleScenario = scenarioAt(9);
  const freshScenario = scenarioAt(2);
  h.select({ 'a.js': 'exclude' });
  const stale = h.dispatchPreview();
  h.requests[0].ok();
  await flush();
  assert.equal(h.requests[0].bodyRead, true, 'the response is past the ok-check and parsing');

  h.select({ 'b.js': 'exclude' });
  const latest = h.dispatchPreview();
  h.requests[0].body.resolve({ scenario: staleScenario });
  await stale;
  await flush();
  assert.equal(h.events.length, 2, 'the parsed stale body publishes nothing');
  assert.ok(!h.events.some(e => e.scenario === staleScenario));

  h.requests[1].ok();
  h.requests[1].body.resolve({ scenario: freshScenario });
  await latest;
  assert.equal(h.events.at(-1).scenario, freshScenario);
});

test('a non-ok response withdraws the picture and keeps the dirty flag', async () => {
  const h = makePublisher();
  const shown = scenarioAt(1);
  h.select({ 'a.js': 'exclude' });
  const first = h.dispatchPreview();
  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: shown });
  await first;

  const refused = h.dispatchPreview();
  assert.equal(h.events.length, 2, 'the re-post of the same map published nothing on its way out');
  h.requests[1].notOk();
  await refused;
  assert.deepEqual(h.events.at(-1), { dirty: true, scenario: null },
    'the refusal is the sole author of this publication');
  assert.equal(h.events.length, 3);
  assert.equal(h.requests[1].bodyRead, false);
});

test('a thrown request withdraws the picture while it is still latest', async () => {
  await withoutErrorLog(async () => {
    const h = makePublisher();
    const shown = scenarioAt(1);
    h.select({ 'a.js': 'exclude' });
    const first = h.dispatchPreview();
    h.requests[0].ok();
    h.requests[0].body.resolve({ scenario: shown });
    await first;

    const thrown = h.dispatchPreview();
    assert.equal(h.events.length, 2);
    h.requests[1].fail(new Error('offline'));
    await thrown;
    assert.deepEqual(h.events.at(-1), { dirty: true, scenario: null },
      'the failed request withdraws the picture it could not refresh');
    assert.equal(h.events.length, 3);
  });
});

test('a thrown request that has been superseded publishes nothing', async () => {
  await withoutErrorLog(async () => {
    const h = makePublisher();
    const freshScenario = scenarioAt(2);
    h.select({ 'a.js': 'exclude' });
    const stale = h.dispatchPreview();
    h.select({ 'b.js': 'exclude' });
    const latest = h.dispatchPreview();
    assert.equal(h.events.length, 2);

    h.requests[0].fail(new Error('offline'));
    await stale;
    await flush();
    assert.equal(h.events.length, 2, 'the superseded failure leaves the newest withdraw standing');

    h.requests[1].ok();
    h.requests[1].body.resolve({ scenario: freshScenario });
    await latest;
    assert.equal(h.events.at(-1).scenario, freshScenario);
  });
});

test('a selection whose payload folds to an empty map still takes the request path', async () => {
  const h = makePublisher();
  const folded = scenarioAt(1);
  h.select({});
  const only = h.dispatchPreview();
  assert.equal(h.requests.length, 1, 'the empty payload is a scenario to fold, not a clear');
  assert.deepEqual(h.events.at(-1), { dirty: true, scenario: null });
  assert.deepEqual(JSON.parse(h.requests[0].init.body), { overrides: {} });

  h.requests[0].ok();
  h.requests[0].body.resolve({ scenario: folded });
  await only;
  assert.equal(h.events.at(-1).scenario, folded);
});
