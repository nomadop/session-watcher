// The host's signal hub: the events route's shape, the stream each request opens, the frame `publish` writes, and every way a stream ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createSignalHub } from '../dsh/src/signal.js';

const URL_OF_EVENTS = 'http://h/api/session-watcher.events';
const decoder = new TextDecoder();

// A stream the hub serves for one request, read a chunk at a time; `read` answers null once the stream is done.
async function open(hub, { signal } = {}) {
  const response = await hub.route().fetch(new Request(URL_OF_EVENTS, signal ? { signal } : {}));
  const reader = response.body.getReader();
  const read = async () => {
    const { value, done } = await reader.read();
    return done ? null : decoder.decode(value);
  };
  return { response, reader, read };
}

const dataFrame = sessionId => `data: ${JSON.stringify({ sessionId })}\n\n`;

test('the route answers GET on the exact events path with a buffered body', () => {
  const route = createSignalHub().route();
  assert.equal(route.path, '/api/session-watcher.events');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
});

test('fetch answers an event stream with no-cache whose first chunk is a comment frame', async () => {
  const hub = createSignalHub();
  const { response, read } = await open(hub);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(await read(), ': open\n\n');
  hub.closeAll();
});

test('publish writes one data frame carrying only the sessionId to every open stream', async () => {
  const hub = createSignalHub();
  const streams = [await open(hub), await open(hub)];
  for (const stream of streams) assert.equal(await stream.read(), ': open\n\n');

  hub.publish('s-one');
  for (const stream of streams) {
    const frame = await stream.read();
    assert.equal(frame, dataFrame('s-one'));
    assert.deepEqual(JSON.parse(frame.slice('data: '.length)), { sessionId: 's-one' });
  }
  hub.closeAll();
});

test('an aborted request signal closes that stream, its reader reads done and publish no longer reaches it', async () => {
  const hub = createSignalHub();
  const request = new AbortController();
  const aborted = await open(hub, { signal: request.signal });
  const other = await open(hub);
  await aborted.read();
  await other.read();

  request.abort();
  assert.equal(await aborted.read(), null, 'the aborted stream is done');
  assert.doesNotThrow(() => hub.publish('s-after'));
  assert.equal(await aborted.read(), null);
  assert.equal(await other.read(), dataFrame('s-after'), 'the other stream still hears');
  hub.closeAll();
});

test('a stream its reader cancels leaves the set, and a later request abort or closeAll raises no uncaught exception', async (t) => {
  const uncaught = [];
  const onUncaught = error => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  const hub = createSignalHub();
  const request = new AbortController();
  const cancelled = await open(hub, { signal: request.signal });
  const closedLater = await open(hub);
  const other = await open(hub);
  for (const stream of [cancelled, closedLater, other]) await stream.read();

  await cancelled.reader.cancel();
  await closedLater.reader.cancel();
  assert.doesNotThrow(() => hub.publish('s-between'), 'the cancelled streams have left the set');
  assert.equal(await other.read(), dataFrame('s-between'));
  request.abort();
  hub.closeAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
  assert.equal(await other.read(), null, 'closeAll still closes the streams left open');
  assert.doesNotThrow(() => hub.publish('s-after'));
});

test('closeAll closes every stream, empties the set, a later publish reaches none and throws nothing, and a stream fetched afterwards is open and receives the next publish', async () => {
  const hub = createSignalHub();
  const streams = [await open(hub), await open(hub)];
  for (const stream of streams) await stream.read();

  hub.closeAll();
  for (const stream of streams) assert.equal(await stream.read(), null);
  assert.doesNotThrow(() => hub.publish('s-none'));

  const later = await open(hub);
  assert.equal(await later.read(), ': open\n\n');
  hub.publish('s-next');
  assert.equal(await later.read(), dataFrame('s-next'));
  hub.closeAll();
  assert.equal(await later.read(), null);
});

test('a client disconnect ends its stream after the request it was fetched with is garbage-collected', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const hub = createSignalHub();
  const request = new AbortController();
  // The bridge keeps only its controller after `fetch` returns, so the Request is held by nothing the test owns.
  const { read } = await open(hub, { signal: request.signal });
  await read();
  gc();
  await new Promise(resolve => setImmediate(resolve));
  gc();

  request.abort();
  const ended = await Promise.race([
    read().then(chunk => chunk === null),
    new Promise(resolve => setTimeout(() => resolve('still open'), 100)),
  ]);
  assert.equal(ended, true);
  hub.closeAll();
});
