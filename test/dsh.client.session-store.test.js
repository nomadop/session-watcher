// The DSH client's session stores: the per-session trailing-edge throttle over minGap measured from the last completion, the pull raced against pullTimeout, the fold of the three endpoints into one result, and the bucket state the buckets answer drives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStores } from '../dsh/src/client/session-store.js';
import { buildCapabilities } from '../public/lib/featureDetect.js';

const MIN_GAP = 100;
const PULL_TIMEOUT = 1000;
const live = payload => ({ ok: true, value: { state: 'live', payload } });
const state = (name, diagnostic) => ({ ok: true, value: { state: name, diagnostic } });
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const STATUS = { model: 'm', rateLamp: { reliable: true, billProgress: 0.5, xSweet: 2 } };
const HISTORY = [{ t: 1 }];
const BUCKETS = { buckets: [] };
const PAYLOADS = { status: STATUS, history: HISTORY, buckets: BUCKETS };
const answerLive = endpoint => Promise.resolve(live(PAYLOADS[endpoint]));

// A macrotask hop through setImmediate drains every pending promise continuation.
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake clock whose `setTimeout` and `clearTimeout` record each arm and clear; `advance` fires every due arm in time order. */
function fakeClock() {
  let time = 0;
  const arms = [];
  const setTimeout = (fn, delay) => {
    const arm = { fn, delay, armedAt: time, at: time + delay, cleared: false, fired: false };
    arms.push(arm);
    return arm;
  };
  const clearTimeout = (arm) => { if (arm) arm.cleared = true; };
  async function advance(ms) {
    const target = time + ms;
    for (;;) {
      const due = arms.filter(a => !a.cleared && !a.fired && a.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      time = due.at;
      due.fired = true;
      due.fn();
      await flush();
    }
    time = target;
    await flush();
  }
  // Every throttle arm waits at most minGap, every deadline exactly pullTimeout.
  const throttleArms = () => arms.filter(a => a.delay !== PULL_TIMEOUT);
  return { now: () => time, setTimeout, clearTimeout, arms, advance, throttleArms };
}

/**
 * A fake channel-bound `call` that records `(endpoint, payload, signal)` with the clock's time and answers through `answer(endpoint, index)`.
 * `hold()` makes every later call wait until the returned `release()` runs.
 */
function fakeCall(clock, answer = answerLive) {
  const calls = [];
  let gate = null;
  const call = (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal, at: clock.now() });
    const index = calls.length - 1;
    if (!gate) return answer(endpoint, index);
    return gate.promise.then(() => answer(endpoint, index));
  };
  const hold = () => {
    const current = deferred();
    gate = current;
    return () => { if (gate === current) gate = null; current.resolve(); };
  };
  const pullStarts = () => calls.filter(c => c.endpoint === 'status').map(c => c.at);
  return { call, calls, hold, pullStarts };
}

function setup(answer) {
  const clock = fakeClock();
  const fake = fakeCall(clock, answer);
  const sessions = createSessionStores({
    call: fake.call, minGap: MIN_GAP, pullTimeout: PULL_TIMEOUT, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
  });
  return { clock, sessions, ...fake };
}

/** A subscriber recording each result with the clock's time. */
function recorder(clock) {
  const results = [];
  const listener = result => results.push({ result, at: clock.now() });
  return { listener, results };
}

test('a single signal when idle past minGap pulls at once', async () => {
  const { clock, sessions, pullStarts } = setup();
  const store = sessions.for('s1');
  store.subscribe(() => {});
  assert.deepEqual(pullStarts(), [0], 'the first signal pulls at once');
  await flush();
  await clock.advance(MIN_GAP);
  store.signal();
  assert.deepEqual(pullStarts(), [0, MIN_GAP], 'a signal minGap after the last completion pulls at once');
  assert.deepEqual(clock.throttleArms(), [], 'neither arms a timer');
});

test('signals within one minGap pull twice, at the leading edge and at the last completion plus minGap', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const release = hold();
  store.subscribe(() => {});
  await clock.advance(30);
  release();
  await flush();
  for (const at of [40, 60, 90]) {
    await clock.advance(at - clock.now());
    store.signal();
  }
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, 30 + MIN_GAP]);
});

test('signals during a pull only mark it dirty, arm no timer, and pull once at completion plus minGap', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const release = hold();
  store.subscribe(() => {});
  for (const at of [10, 20, 40]) {
    await clock.advance(at - clock.now());
    store.signal();
  }
  assert.deepEqual(clock.throttleArms(), [], 'no timer while in flight');
  await clock.advance(10);
  release();
  await flush();
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, 50 + MIN_GAP]);
});

test('a signal while the timer is armed arms no other timer', async () => {
  const { clock, sessions, pullStarts } = setup();
  const store = sessions.for('s1');
  store.subscribe(() => {});
  await flush();
  await clock.advance(10);
  store.signal();
  await clock.advance(10);
  store.signal();
  store.signal();
  assert.equal(clock.throttleArms().length, 1);
  assert.equal(clock.throttleArms()[0].delay, MIN_GAP - 10);
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, MIN_GAP]);
});

test('a rejected pull answers unreachable, the next signal schedules as usual, and a later success answers live', async () => {
  const { clock, sessions, pullStarts } = setup((endpoint, index) => (endpoint === 'status' && index < 3
    ? Promise.reject(new Error('socket closed')) : answerLive(endpoint)));
  const store = sessions.for('s1');
  const { listener, results } = recorder(clock);
  store.subscribe(listener);
  await flush();
  assert.deepEqual(results.map(r => r.result), [{ kind: 'unreachable', message: 'socket closed' }]);
  assert.ok(clock.arms.every(a => a.cleared || a.fired), 'a failure arms no retry');
  await clock.advance(10);
  store.signal();
  assert.deepEqual(clock.throttleArms().map(a => a.delay), [MIN_GAP - 10], 'the failed completion is the last completion');
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, MIN_GAP]);
  assert.equal(results[1].result.kind, 'live');
});

test('a pull held to pullTimeout aborts the signal each call received, ends unreachable without waiting for them, completes at the abort, and pulls again at the abort plus minGap after a signal during it', async () => {
  const { clock, sessions, calls, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const { listener, results } = recorder(clock);
  const release = hold();
  store.subscribe(listener);
  await clock.advance(10);
  store.signal();
  await clock.advance(PULL_TIMEOUT - 10 - 1);
  assert.ok(calls.every(c => !c.signal.aborted), 'nothing aborts before pullTimeout');
  assert.deepEqual(results, []);
  await clock.advance(1);
  assert.ok(calls.slice(0, 3).every(c => c.signal.aborted), 'every call of the pull sees its signal aborted');
  assert.deepEqual(results, [{ result: { kind: 'unreachable', message: 'the pull timed out' }, at: PULL_TIMEOUT }]);
  release();
  await flush();
  assert.equal(results.length, 1, 'the calls settling late change nothing');
  assert.equal(store.result.kind, 'unreachable');
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, PULL_TIMEOUT + MIN_GAP]);
  assert.equal(results[1].result.kind, 'live');
});

test('openAll signals every store with a subscriber through its throttle and none without', async () => {
  const { clock, sessions, calls } = setup();
  const a = sessions.for('a');
  const b = sessions.for('b');
  sessions.for('c');
  a.subscribe(() => {});
  await flush();
  await clock.advance(150);
  b.subscribe(() => {});
  await flush();
  await clock.advance(50);
  const before = calls.length;
  sessions.openAll();
  const started = calls.slice(before);
  assert.deepEqual(started.map(c => c.payload.sessionId), ['a', 'a', 'a'], 'a, idle past minGap, pulls at once');
  assert.deepEqual(clock.throttleArms().map(arm => ({ armedAt: arm.armedAt, delay: arm.delay })), [{ armedAt: 200, delay: 150 + MIN_GAP - 200 }], 'b arms its timer');
  await clock.advance(MIN_GAP * 5);
  const sessionsSeen = new Set(calls.map(c => c.payload.sessionId));
  assert.ok(!sessionsSeen.has('c'), 'a store without a subscriber pulls nothing');
});

test('the last unsubscribe clears the timer and ignores later signals, a pull in flight still updates result, and the next subscriber signals once', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const first = recorder(clock);
  const unsubscribeFirst = store.subscribe(first.listener);
  await flush();
  await clock.advance(10);
  store.signal();
  const [armed] = clock.throttleArms();
  unsubscribeFirst();
  assert.equal(armed.cleared, true, 'the last unsubscribe clears the timer');
  await clock.advance(MIN_GAP * 5);
  store.signal();
  assert.deepEqual(pullStarts(), [0], 'later signals are ignored');

  const second = recorder(clock);
  const unsubscribeSecond = store.subscribe(second.listener);
  await flush();
  const release = hold();
  await clock.advance(MIN_GAP * 5);
  store.signal();
  const held = pullStarts().length;
  store.signal();
  unsubscribeSecond();
  const before = store.result;
  release();
  await flush();
  assert.notEqual(store.result, before, 'the pull in flight still updates result');
  assert.equal(store.result.kind, 'live');
  assert.equal(second.results.length, 1, 'only the subscribe pull reached the departed subscriber');
  await clock.advance(MIN_GAP * 5);
  assert.equal(pullStarts().length, held, 'the dirty mark left with the last subscriber');

  const third = recorder(clock);
  store.subscribe(third.listener);
  assert.equal(third.results.length, 0, 'subscribing never calls the listener synchronously');
  assert.equal(pullStarts().length, held + 1, 'the next subscriber signals once');
});

test('a signal with two subscribers starts one pull whose result both receive, and a second subscribe during a pull only marks it dirty', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const a = recorder(clock);
  const b = recorder(clock);
  const release = hold();
  store.subscribe(a.listener);
  await clock.advance(10);
  store.subscribe(b.listener);
  assert.deepEqual(pullStarts(), [0], 'the second subscribe starts no pull');
  release();
  await flush();
  assert.equal(a.results[0].result, b.results[0].result, 'both receive the same result');
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, 10 + MIN_GAP], 'the dirty mark pulls once at completion plus minGap');
  await clock.advance(MIN_GAP * 5);
  store.signal();
  await flush();
  assert.equal(pullStarts().length, 3, 'one signal starts one pull');
  assert.equal(a.results.at(-1).result, b.results.at(-1).result);
  assert.equal(a.results.length, 3);
  assert.equal(b.results.length, 3);
});

test('a signal for another session leaves this throttle alone and one for a session with no store is ignored', async () => {
  const { clock, sessions, calls } = setup();
  sessions.for('a').subscribe(() => {});
  sessions.for('b').subscribe(() => {});
  await flush();
  await clock.advance(10);
  const before = calls.length;
  sessions.signal('b');
  assert.equal(clock.throttleArms().length, 1, 'only b arms a timer');
  sessions.signal('unknown');
  assert.equal(calls.length, before, 'nothing pulls at once');
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(calls.slice(before).map(c => c.payload.sessionId), ['b', 'b', 'b']);
});

test('a bootstrapping answer folds to the bootstrapping state and the install signal\'s pull folds to live', async () => {
  const { clock, sessions } = setup((endpoint, index) => (index < 3 ? Promise.resolve(state('bootstrapping')) : answerLive(endpoint)));
  const store = sessions.for('s1');
  const { listener, results } = recorder(clock);
  store.subscribe(listener);
  await flush();
  assert.deepEqual(results.map(r => r.result), [{ kind: 'state', state: 'bootstrapping', diagnostic: undefined }]);
  await clock.advance(MIN_GAP);
  sessions.signal('s1');
  await flush();
  assert.equal(results[1].result.kind, 'live');
});

test('a live store\'s removal signal folds the bootstrapping state and the install signal folds live', async () => {
  // Each pull makes three calls: the first pull answers live, the removal's pull bootstrapping, the install's live again.
  const { clock, sessions } = setup((endpoint, index) => (index >= 3 && index < 6
    ? Promise.resolve(state('bootstrapping')) : answerLive(endpoint)));
  const store = sessions.for('s1');
  const { listener, results } = recorder(clock);
  store.subscribe(listener);
  await flush();
  assert.equal(results[0].result.kind, 'live');
  await clock.advance(MIN_GAP);
  sessions.signal('s1');
  await flush();
  assert.deepEqual(results[1].result, { kind: 'state', state: 'bootstrapping', diagnostic: undefined });
  await clock.advance(MIN_GAP);
  sessions.signal('s1');
  await flush();
  assert.equal(results[2].result.kind, 'live');
});

test('a listener that signals inside a dirty completion leaves one timer and one pull', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const release = hold();
  let completions = 0;
  store.subscribe(() => {
    completions += 1;
    if (completions === 1) store.signal();
  });
  await clock.advance(10);
  store.signal();
  await clock.advance(10);
  release();
  await flush();
  assert.equal(clock.throttleArms().filter(a => !a.cleared && !a.fired).length, 1, 'one timer armed');
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, 20 + MIN_GAP], 'one pull after the dirty completion');
});

test('openAll during a pull only marks it dirty and pulls once after completion', async () => {
  const { clock, sessions, hold, pullStarts } = setup();
  const store = sessions.for('s1');
  const release = hold();
  store.subscribe(() => {});
  await clock.advance(10);
  sessions.openAll();
  assert.deepEqual(clock.throttleArms(), []);
  await clock.advance(20);
  release();
  await flush();
  await clock.advance(MIN_GAP * 5);
  assert.deepEqual(pullStarts(), [0, 30 + MIN_GAP]);
});

test('a call that throws synchronously ends the pull unreachable with no unhandled rejection', async (t) => {
  const unhandled = [];
  const probe = reason => unhandled.push(reason);
  process.on('unhandledRejection', probe);
  t.after(() => process.off('unhandledRejection', probe));
  const { clock, sessions, pullStarts } = setup(() => { throw new Error('the context is inactive'); });
  const store = sessions.for('s1');
  const { listener, results } = recorder(clock);
  store.subscribe(listener);
  await flush();
  await flush();
  assert.deepEqual(results.map(r => r.result), [{ kind: 'unreachable', message: 'the context is inactive' }]);
  assert.ok(clock.arms.filter(a => a.delay === PULL_TIMEOUT).every(a => a.cleared), 'the deadline is cleared');
  await clock.advance(MIN_GAP);
  store.signal();
  await flush();
  assert.deepEqual(pullStarts(), [0, MIN_GAP], 'the throttle carries on');
  assert.deepEqual(unhandled, []);
});

test('the first rejection or ok false answers unreachable with its message', async () => {
  const cases = [
    [{ history: () => Promise.reject(new Error('socket closed')) }, 'socket closed'],
    [{ status: () => Promise.resolve(failure('invalid_body', 'bad body')), buckets: () => Promise.reject(new Error('later')) }, 'bad body'],
    [{ status: () => Promise.resolve(state('bootstrapping')), buckets: () => Promise.resolve(failure('unknown_endpoint', 'unknown endpoint buckets')) }, 'unknown endpoint buckets'],
  ];
  for (const [answers, message] of cases) {
    const { sessions } = setup(endpoint => (answers[endpoint] ?? answerLive.bind(null, endpoint))());
    const store = sessions.for('s1');
    store.subscribe(() => {});
    await flush();
    assert.deepEqual(store.result, { kind: 'unreachable', message }, message);
  }
});

test('the first non-live state answers that state with its diagnostic', async () => {
  const diagnostic = { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' };
  const answers = { history: state('failed', diagnostic), buckets: state('bootstrapping') };
  const { sessions } = setup(endpoint => Promise.resolve(answers[endpoint] ?? live(PAYLOADS[endpoint])));
  const store = sessions.for('s1');
  store.subscribe(() => {});
  await flush();
  assert.deepEqual(store.result, { kind: 'state', state: 'failed', diagnostic });
});

test('a live pull\'s snapshot carries status, history, capabilities and bucketData, none undefined', async () => {
  const { sessions } = setup();
  const store = sessions.for('s1');
  assert.equal(store.result, null, 'no result before the first completion');
  store.subscribe(() => {});
  await flush();
  const expected = { status: STATUS, history: HISTORY, capabilities: buildCapabilities(STATUS), bucketData: BUCKETS };
  assert.deepEqual(store.result, { kind: 'live', snapshot: expected });
  for (const key of Object.keys(expected)) assert.notEqual(store.result.snapshot[key], undefined, key);
});

test('the bucket tracker records success only when buckets answers live', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  const bucketAnswers = [
    [() => live(BUCKETS)],
    [() => state('bootstrapping')],
    [() => failure('unknown_endpoint', 'unknown endpoint buckets')],
    [() => { throw new Error('socket closed'); }],
    [() => live(BUCKETS), () => Promise.reject(new Error('status refused'))],
  ];
  const { clock, sessions } = setup((endpoint, index) => {
    const [buckets, status] = bucketAnswers[Math.floor(index / 3)];
    if (endpoint === 'buckets') return Promise.resolve().then(buckets);
    if (endpoint === 'status' && status) return status();
    return answerLive(endpoint);
  });
  const store = sessions.for('s1');
  const seen = [];
  store.onBucketState(snapshot => seen.push({ ...snapshot }));
  store.subscribe(() => {});
  await flush();
  assert.deepEqual(store.bucketState, { isFetching: false, consecutiveFailures: 0, lastSuccessAt: 5000 });
  for (let pull = 1; pull < bucketAnswers.length; pull++) {
    t.mock.timers.tick(MIN_GAP);
    await clock.advance(MIN_GAP);
    store.signal();
    await flush();
  }
  assert.deepEqual(seen.map(s => s.consecutiveFailures), [0, 1, 2, 3, 0]);
  assert.equal(store.bucketState.lastSuccessAt, 5000 + MIN_GAP * 4, 'a live buckets answer records success whatever status answers');
});

test('every call carries the session id and the pull\'s abort signal', async () => {
  const { clock, sessions, calls } = setup();
  const store = sessions.for('s1');
  store.subscribe(() => {});
  await flush();
  await clock.advance(MIN_GAP);
  store.signal();
  await flush();
  assert.deepEqual(calls.map(c => c.endpoint), ['status', 'history', 'buckets', 'status', 'history', 'buckets']);
  assert.ok(calls.every(c => c.payload.sessionId === 's1' && Object.keys(c.payload).length === 1));
  assert.ok(calls.every(c => c.signal instanceof AbortSignal && !c.signal.aborted));
  assert.ok(calls[0].signal === calls[1].signal && calls[1].signal === calls[2].signal, 'one signal per pull');
  assert.notEqual(calls[0].signal, calls[3].signal, 'each pull its own');
});

test('for answers one store per session id', () => {
  const { sessions } = setup();
  assert.equal(sessions.for('a'), sessions.for('a'));
  assert.notEqual(sessions.for('a'), sessions.for('b'));
});
