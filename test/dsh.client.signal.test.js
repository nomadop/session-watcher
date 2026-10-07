// The DSH client's signal stream: one EventSource whose message frames name a session, whose open runs the catch-up, and whose CLOSED errors reopen it after the bounded REOPEN_DELAYS_MS backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSignalStream, REOPEN_DELAYS_MS } from '../dsh/src/client/signal.js';

const URL = 'api/session-watcher.events';

/** A fake `EventSource` class whose instances record `url`, listeners, `readyState` and `close()` calls. */
function fakeEventSourceClass() {
  const instances = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = {};
      this.closeCalls = 0;
      instances.push(this);
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    close() { this.closeCalls += 1; this.readyState = FakeEventSource.CLOSED; }
    emit(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
  }
  return { FakeEventSource, instances };
}

/** Fake timers recording each arm and clear. */
function fakeTimers() {
  const arms = [];
  const setTimeout = (fn, delay) => { const arm = { fn, delay, cleared: false }; arms.push(arm); return arm; };
  const clearTimeout = (arm) => { if (arm) arm.cleared = true; };
  return { arms, setTimeout, clearTimeout };
}

function setup() {
  const { FakeEventSource, instances } = fakeEventSourceClass();
  const timers = fakeTimers();
  const frames = [];
  const states = [];
  let opens = 0;
  const stream = openSignalStream({
    url: URL, EventSource: FakeEventSource, onFrame: id => frames.push(id), onOpen: () => { opens += 1; }, onState: state => states.push(state),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return { FakeEventSource, instances, timers, frames, states, opens: () => opens, stream };
}

test('each message frame hands its sessionId to onFrame and each open calls onOpen', () => {
  const { instances, frames, opens } = setup();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, URL);
  const [source] = instances;
  source.emit('open');
  assert.equal(opens(), 1);
  source.emit('message', { data: JSON.stringify({ sessionId: 'a' }) });
  source.emit('message', { data: JSON.stringify({ sessionId: 'b' }) });
  source.emit('message', { data: JSON.stringify({ sessionId: 'a' }) });
  assert.deepEqual(frames, ['a', 'b', 'a']);
  source.emit('open');
  assert.equal(opens(), 2);
});

test('a malformed frame writes console.error and reaches no onFrame', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const { instances, frames } = setup();
  const malformed = ['not json', 'null', '{}', JSON.stringify({ sessionId: 7 })];
  for (const data of malformed) instances[0].emit('message', { data });
  assert.deepEqual(frames, []);
  assert.deepEqual(error.mock.calls.map(call => call.arguments), malformed.map(data => ['[sw] malformed signal frame', data]));
});

test('an error in the CLOSED state reopens after each delay of the sequence in turn, the last repeating, and an open resets it', () => {
  const { FakeEventSource, instances, timers, opens } = setup();
  const expected = [...REOPEN_DELAYS_MS, REOPEN_DELAYS_MS.at(-1), REOPEN_DELAYS_MS.at(-1)];
  for (const [index, delay] of expected.entries()) {
    const current = instances.at(-1);
    current.readyState = FakeEventSource.CLOSED;
    current.emit('error');
    assert.equal(timers.arms.length, index + 1, 'one reopen per error');
    assert.equal(timers.arms.at(-1).delay, delay);
    assert.equal(instances.length, index + 1, 'nothing reopens before its delay');
    timers.arms.at(-1).fn();
    assert.equal(instances.length, index + 2);
    assert.equal(instances.at(-1).url, URL);
  }
  instances.at(-1).emit('open');
  assert.equal(opens(), 1);
  instances.at(-1).readyState = FakeEventSource.CLOSED;
  instances.at(-1).emit('error');
  assert.equal(timers.arms.at(-1).delay, REOPEN_DELAYS_MS[0], 'an open resets the sequence');
});

test('an error while connecting reopens nothing', () => {
  const { FakeEventSource, instances, timers } = setup();
  instances[0].readyState = FakeEventSource.CONNECTING;
  instances[0].emit('error');
  assert.deepEqual(timers.arms, []);
  assert.equal(instances.length, 1);
});

test('close cancels a pending reopen and closes the current source', () => {
  const { FakeEventSource, instances, timers, stream } = setup();
  instances[0].readyState = FakeEventSource.CLOSED;
  instances[0].emit('error');
  timers.arms[0].fn();
  instances[1].emit('open');
  stream.close();
  assert.equal(instances[1].closeCalls, 1, 'an open source closes');

  const pending = setup();
  pending.instances[0].readyState = pending.FakeEventSource.CLOSED;
  pending.instances[0].emit('error');
  const [arm] = pending.timers.arms;
  pending.stream.close();
  assert.equal(arm.cleared, true, 'the pending reopen is cancelled');
  assert.equal(pending.instances.length, 1, 'no source opens after close');
  assert.equal(pending.instances[0].closeCalls, 1);
});

test('onState reports connecting for each new source, live on open, connecting while the browser retries and disconnected while the backoff waits', () => {
  const { instances, timers, states } = setup();
  assert.deepEqual(states, ['connecting']);
  const [first] = instances;
  first.emit('open');
  assert.deepEqual(states, ['connecting', 'live']);
  first.emit('error');
  assert.deepEqual(states, ['connecting', 'live', 'connecting'], 'an error the browser retries on its own is not a disconnect');
  first.emit('open');
  first.readyState = 2;
  first.emit('error');
  assert.equal(states.at(-1), 'disconnected');
  timers.arms[0].fn();
  assert.equal(states.at(-1), 'connecting', 'the reopen is a new connecting source');
  instances[1].emit('open');
  assert.equal(states.at(-1), 'live');
});
