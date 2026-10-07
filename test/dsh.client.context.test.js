// The DSH tab's element ctx: `request` over the session-bound RPC call, answered in the Response shape the elements read, and the per-instance bus, chart registry and overlay root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabContext } from '../dsh/src/client/context.js';

const live = payload => ({ ok: true, value: { state: 'live', payload } });
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });

function fakeCall(answer = () => Promise.resolve(live({}))) {
  const calls = [];
  const call = (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return answer(endpoint, payload);
  };
  return { call, calls };
}

const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('request maps each dashboard path and method to its endpoint and hands the parsed body as the payload', async () => {
  const { call, calls } = fakeCall();
  const { request } = createTabContext({ call, root: {} });
  await request('/api/pricing');
  await request('/api/pricing', json({ readPrice: 1, writePrice: 2, presetId: 'p' }));
  await request('/api/pricing', { method: 'DELETE' });
  await request('/api/user-overrides', json({ overrides: { 'a.js': 'exclude' } }));
  await request('/api/preview', json({ overrides: {} }));
  await request('/api/turn/browse');
  assert.deepEqual(calls, [
    { endpoint: 'pricing', payload: {} },
    { endpoint: 'pricing/save', payload: { readPrice: 1, writePrice: 2, presetId: 'p' } },
    { endpoint: 'pricing/delete', payload: {} },
    { endpoint: 'user-overrides', payload: { overrides: { 'a.js': 'exclude' } } },
    { endpoint: 'preview', payload: { overrides: {} } },
    { endpoint: 'turn/browse', payload: {} },
  ]);
});

test('a live value answers ok with the payload as json', async () => {
  const payload = { model: 'm', source: 'saved' };
  const { call } = fakeCall(() => Promise.resolve(live(payload)));
  const res = await createTabContext({ call, root: {} }).request('/api/pricing');
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload);
});

test('an ok false envelope answers the route\'s status and body', async () => {
  for (const [code, status] of [['invalid_body', 400], ['invalid_input', 400], ['no_model', 409], ['unknown_endpoint', 404]]) {
    const { call } = fakeCall(() => Promise.resolve(failure(code, `${code} text`)));
    const res = await createTabContext({ call, root: {} }).request('/api/user-overrides', json({ overrides: 1 }));
    assert.equal(res.ok, false, code);
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: code, message: `${code} text` }, code);
  }
});

test('a non-live state answers 503 with the state as error', async () => {
  const diagnostic = { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' };
  for (const [value, body] of [
    [{ state: 'unobserved' }, { error: 'unobserved', message: 'unobserved' }],
    [{ state: 'bootstrapping' }, { error: 'bootstrapping', message: 'bootstrapping' }],
    [{ state: 'failed', diagnostic }, { error: 'failed', message: 'read refused' }],
  ]) {
    const { call } = fakeCall(() => Promise.resolve({ ok: true, value }));
    const res = await createTabContext({ call, root: {} }).request('/api/turn/browse');
    assert.equal(res.ok, false, value.state);
    assert.equal(res.status, 503, value.state);
    assert.deepEqual(await res.json(), body, value.state);
  }
});

test('a rejection propagates', async () => {
  const error = new Error('socket closed');
  const { call } = fakeCall(() => Promise.reject(error));
  await assert.rejects(createTabContext({ call, root: {} }).request('/api/pricing'), error);
});

test('two contexts share no bus, no chart registry and no overlay root', () => {
  const rootA = { name: 'a' };
  const rootB = { name: 'b' };
  const a = createTabContext({ call: fakeCall().call, root: rootA });
  const b = createTabContext({ call: fakeCall().call, root: rootB });
  let heardOnB = 0;
  let heardOnA = 0;
  b.bus.addEventListener('sw-bucket-preview', () => { heardOnB++; });
  a.bus.addEventListener('sw-bucket-preview', () => { heardOnA++; });
  a.bus.dispatchEvent(new CustomEvent('sw-bucket-preview', { detail: { scenario: null } }));
  assert.equal(heardOnA, 1);
  assert.equal(heardOnB, 0);
  assert.notEqual(a.charts, b.charts);
  assert.deepEqual(a.charts, { hero: null, history: null });
  assert.equal(a.overlayRoot, rootA);
  assert.equal(b.overlayRoot, rootB);
});
