// The inner monitor (`dsh/src/inner-monitor.js`): the real monitor over a recording appender and a recording publish, either of which a case makes refuse. The sessions are stand-ins that state their id alone: what a real session logs is the seal's cases (`test/dsh.inner-seal.test.js`).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInnerMonitor } from '../dsh/src/inner-monitor.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE } from '../dsh/src/inner-seal.js';

const TAIL = { role: 'user', content: [{ type: 'text', text: 'Write concise continuity notes.' }] };
const TOOLS = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
const RANGE = [5, 6, 7];
const session = id => ({ id });

// What `dispatch` is handed for a request of `sessionId`; `options` and `input` stand for what `summarizeSlots` builds.
const requestOf = (sessionId = 'session-a', overrides = {}) => ({
  options: {
    provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', purpose: 'inner-compaction', sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'an earlier ask' }] }, TAIL], tools: TOOLS, toolHistory: { tools: TOOLS, updates: [] },
    ...overrides,
  },
  input: { throughSeq: 4, headerSeq: 2, tail: TAIL },
  stream: () => ['the stream as it stands'],
});

// The display `requestOf` makes, written out.
const displayOf = (sessionId = 'session-a') => ({
  options: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', purpose: 'inner-compaction', sessionId },
  messages: { count: 1, tail: TAIL },
  throughSeq: 4,
  headerSeq: 2,
  tools: { count: 1 },
  toolHistory: { updates: [] },
});

// A monitor over an appender that numbers the records it takes from `first`, keeps each as `{ session, type, data }` and refuses the types `refuse` names with the error given, and a publish that keeps the session id it was called with and the phases that were live then; `publishFails` makes it throw.
function rig({ first = 10, refuse = {}, publishFails = false } = {}) {
  const records = [];
  const attempts = [];
  const published = [];
  let next = first;
  let monitor;
  const appendPluginRecord = (target, type, data) => {
    attempts.push(type);
    if (Object.hasOwn(refuse, type)) throw refuse[type];
    records.push({ session: target.id, type, data: structuredClone(data) });
    return next++;
  };
  const publish = (sessionId) => {
    published.push({ sessionId, live: monitor.live(sessionId).map(entry => entry.phase) });
    if (publishFails) throw new Error('the hub is closed');
  };
  monitor = createInnerMonitor({ appendPluginRecord, publish });
  return { monitor, records, attempts, published };
}

// The stderr lines written while `body` runs.
async function stderrOf(t, body) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.map(String).join(' ')); });
  await body();
  t.mock.restoreAll();
  return lines;
}

// The code of each diagnostic line: `<session> [<scope>] <code>: <message>`.
const codesOf = lines => lines.map(line => /\] (\w+): /u.exec(line)?.[1]);

test('making a monitor, beginning an attempt and reading the registry only allocate: no record, no publish, nothing live', () => {
  const { monitor, records, attempts, published } = rig();

  const attempt = monitor.begin(session('session-a'), { range: RANGE });

  assert.equal(attempt.startSeq, null);
  assert.deepEqual(monitor.live('session-a'), []);
  assert.deepEqual([records, attempts, published], [[], [], []]);
});

// A quote as the seal hands it to `begin`, the snapshot `innerQuote` answers.
const QUOTE = Object.freeze({
  n: 8, lA: 40000, bEst: 120, cEst: 2400, sEst: 37480, cRatio: 30, fee: 5000, kappa: 1.1, nRef: 4.1, N: 6, jRef: 13, q: 1.1, arm: 'right', trigger: 'quote',
});

test('dispatch appends the attempt record of the range, the request\'s display and the quote the seal triggered on, takes the record\'s seq as the attempt\'s, registers the generating entry and publishes it', () => {
  const { monitor, records, published } = rig();
  const attempt = monitor.begin(session('session-a'), { range: RANGE, quote: QUOTE });
  const request = requestOf();

  attempt.dispatch(request);

  assert.deepEqual(records, [{
    session: 'session-a', type: INNER_ATTEMPT_RECORD_TYPE,
    data: { v: 1, range: { first: 5, last: 7, count: 3 }, request: displayOf(), quote: QUOTE },
  }]);
  assert.equal(attempt.startSeq, 10);
  const [entry] = monitor.live('session-a');
  assert.deepEqual(Object.keys(entry).sort(), ['attempt', 'endedAt', 'phase', 'request', 'stream', 'tools']);
  assert.equal(entry.attempt, 10);
  assert.equal(entry.phase, 'generating');
  assert.equal(entry.endedAt, null);
  assert.deepEqual(entry.request, displayOf());
  assert.equal(entry.tools, request.options.tools, 'the tools are the request\'s own array, kept in memory only');
  assert.deepEqual(entry.stream(), ['the stream as it stands']);
  assert.deepEqual(published, [{ sessionId: 'session-a', live: ['generating'] }]);
});

test('each chunk publishes, the response makes the entry validating with the call\'s end time, and the commit takes the entry before it publishes, writing no end record', () => {
  const { monitor, records, published } = rig();
  const attempt = monitor.begin(session('session-a'), { range: RANGE });
  attempt.dispatch(requestOf());
  const [generating] = monitor.live('session-a');

  attempt.chunk();
  attempt.chunk();
  attempt.responded({ endedAt: 1234 });
  const [validating] = monitor.live('session-a');
  attempt.committed();

  assert.equal(generating.phase, 'generating', 'an entry read earlier is a snapshot');
  assert.equal(validating.phase, 'validating');
  assert.equal(validating.endedAt, 1234);
  assert.equal(validating.attempt, generating.attempt);
  assert.deepEqual(monitor.live('session-a'), []);
  assert.deepEqual(published.map(each => each.live), [['generating'], ['generating'], ['generating'], ['validating'], []], 'the commit publishes with the entry already gone');
  assert.deepEqual(records.map(record => record.type), [INNER_ATTEMPT_RECORD_TYPE], 'no end record for a commit');
});

test('failed appends the end record, takes the entry and then publishes, and states the outcome and reason: an error\'s message, any other thrown value as text, a cancel cause by its kind and a hook\'s reason', () => {
  const user = { kind: 'user' };
  const hook = { kind: 'hook', reason: 'a hook ended the turn' };
  const stopped = new Error('the user cancelled');
  const cases = [
    ['an error', new Error('the summary text is not a JSON array'), { cancelled: false, cancelReason: undefined }, 'failed', 'the summary text is not a JSON array'],
    ['a thrown string', 'plain text', { cancelled: false, cancelReason: undefined }, 'failed', 'plain text'],
    ['a user cancel', user, { cancelled: true, cancelReason: user }, 'cancelled', 'user'],
    ['a parent cancel', { kind: 'parent' }, { cancelled: true, cancelReason: { kind: 'parent' } }, 'cancelled', 'parent'],
    ['a hook cancel', hook, { cancelled: true, cancelReason: hook }, 'cancelled', 'hook: a hook ended the turn'],
    ['a disposed agent', { kind: 'disposed' }, { cancelled: true, cancelReason: { kind: 'disposed' } }, 'cancelled', 'disposed'],
    ['a cancel whose cause is an error', stopped, { cancelled: true, cancelReason: stopped }, 'cancelled', 'the user cancelled'],
    ['a cancel whose cause is text', 'stop now', { cancelled: true, cancelReason: 'stop now' }, 'cancelled', 'stop now'],
    ['a failure raised while a cancel cause stands', new Error('fetch failed'), { cancelled: true, cancelReason: user }, 'cancelled', 'user'],
    ['a cancel cause that is not one of the loop\'s', new Error('fetch failed'), { cancelled: true, cancelReason: { kind: 'odd' } }, 'cancelled', 'fetch failed'],
  ];
  for (const [why, error, circumstances, outcome, reason] of cases) {
    const { monitor, records, published } = rig();
    const attempt = monitor.begin(session('session-a'), { range: RANGE });
    attempt.dispatch(requestOf());

    attempt.failed(error, circumstances);

    assert.deepEqual(records.at(-1), { session: 'session-a', type: INNER_END_RECORD_TYPE, data: { v: 1, attempt: 10, outcome, reason } }, why);
    assert.deepEqual(monitor.live('session-a'), [], why);
    assert.deepEqual(published.at(-1), { sessionId: 'session-a', live: [] }, `${why}: the entry is gone when the change is published`);
  }
});

test('an attempt that was never dispatched writes no terminal fact and publishes nothing: the failure came before the request was sent', () => {
  const { monitor, records, attempts, published } = rig();
  const attempt = monitor.begin(session('session-a'), { range: RANGE });

  attempt.failed(new Error('the log could not be read'), { cancelled: false, cancelReason: undefined });
  attempt.responded({ endedAt: 1 });
  attempt.chunk();
  attempt.committed();

  assert.deepEqual([records, attempts, published], [[], [], []]);
  assert.deepEqual(monitor.live('session-a'), []);
});

test('an attempt record that cannot be appended costs one line, once, and leaves the attempt without a seq, an entry or a terminal fact, whatever follows', async (t) => {
  const { monitor, records, attempts, published } = rig({ refuse: { [INNER_ATTEMPT_RECORD_TYPE]: new Error('the log refused the attempt') } });
  const attempt = monitor.begin(session('session-a'), { range: RANGE });
  let thrown = null;

  const lines = await stderrOf(t, async () => {
    try {
      attempt.dispatch(requestOf());
      attempt.chunk();
      attempt.responded({ endedAt: 1 });
      attempt.failed(new Error('later'), { cancelled: false, cancelReason: undefined });
      attempt.committed();
    } catch (error) {
      thrown = error;
    }
  });

  assert.equal(thrown, null, 'no method throws');
  assert.deepEqual(codesOf(lines), ['inner_monitor_start_failed']);
  assert.ok(lines[0].startsWith('session-a '), lines[0]);
  assert.match(lines[0], /the log refused the attempt/);
  assert.equal(attempt.startSeq, null);
  assert.deepEqual(attempts, [INNER_ATTEMPT_RECORD_TYPE], 'the append is not retried, and no end is attempted');
  assert.deepEqual([records, published], [[], []]);
  assert.deepEqual(monitor.live('session-a'), []);
});

test('a request whose display cannot be made costs one line and appends nothing, and no method throws', async (t) => {
  const { monitor, attempts, published } = rig();
  const attempt = monitor.begin(session('session-a'), { range: RANGE });
  const malformed = { ...requestOf(), options: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
  let thrown = null;

  const lines = await stderrOf(t, async () => {
    try {
      attempt.dispatch(malformed);
      attempt.failed(new Error('later'), { cancelled: false, cancelReason: undefined });
    } catch (error) {
      thrown = error;
    }
  });

  assert.equal(thrown, null);
  assert.deepEqual(codesOf(lines), ['inner_monitor_start_failed']);
  assert.equal(attempt.startSeq, null);
  assert.deepEqual([attempts, published], [[], []]);
  assert.deepEqual(monitor.live('session-a'), []);
});

test('an end record that cannot be appended costs one line, once, and the entry is taken and the change published all the same', async (t) => {
  const { monitor, records, attempts, published } = rig({ refuse: { [INNER_END_RECORD_TYPE]: new Error('the log refused the end') } });
  const attempt = monitor.begin(session('session-a'), { range: RANGE });
  attempt.dispatch(requestOf());
  let thrown = null;

  const lines = await stderrOf(t, async () => {
    try {
      attempt.failed(new Error('the summary failed'), { cancelled: false, cancelReason: undefined });
    } catch (error) {
      thrown = error;
    }
  });

  assert.equal(thrown, null);
  assert.deepEqual(codesOf(lines), ['inner_monitor_end_failed']);
  assert.match(lines[0], /the log refused the end/);
  assert.deepEqual(attempts, [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE], 'the end is appended once');
  assert.deepEqual(records.map(record => record.type), [INNER_ATTEMPT_RECORD_TYPE]);
  assert.deepEqual(monitor.live('session-a'), []);
  assert.deepEqual(published.at(-1), { sessionId: 'session-a', live: [] });
});

test('a publish that throws costs one line for each publish and changes nothing else: the record is appended, the entry follows the attempt and is gone after a commit and after a failure', async (t) => {
  for (const [why, end] of [
    ['a commit', attempt => attempt.committed()],
    ['a failure', attempt => attempt.failed(new Error('the summary failed'), { cancelled: false, cancelReason: undefined })],
  ]) {
    const { monitor, records, published } = rig({ publishFails: true });
    const attempt = monitor.begin(session('session-a'), { range: RANGE });
    let thrown = null;
    let phases;

    const lines = await stderrOf(t, async () => {
      try {
        attempt.dispatch(requestOf());
        attempt.chunk();
        attempt.responded({ endedAt: 1 });
        phases = monitor.live('session-a').map(entry => entry.phase);
        end(attempt);
      } catch (error) {
        thrown = error;
      }
    });

    assert.equal(thrown, null, why);
    assert.deepEqual(codesOf(lines), Array(4).fill('inner_monitor_publish_failed'), `${why}: a line for each of the dispatch, the chunk, the response and the end`);
    assert.equal(published.length, 4, why);
    assert.deepEqual(phases, ['validating'], why);
    assert.deepEqual(records.map(record => record.type), why === 'a commit' ? [INNER_ATTEMPT_RECORD_TYPE] : [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE], why);
    assert.deepEqual(monitor.live('session-a'), [], why);
  }
});

test('the registry belongs to its monitor and is read by session: another monitor shares nothing, another session\'s entries are not listed, and an entry read is a copy', () => {
  const first = rig();
  const second = rig();
  const a = first.monitor.begin(session('session-a'), { range: RANGE });
  const b = first.monitor.begin(session('session-b'), { range: [8, 9] });
  a.dispatch(requestOf('session-a'));
  b.dispatch(requestOf('session-b'));

  assert.deepEqual(first.monitor.live('session-a').map(entry => entry.request.options.sessionId), ['session-a']);
  assert.deepEqual(first.monitor.live('session-b').map(entry => entry.request.options.sessionId), ['session-b']);
  assert.deepEqual(second.monitor.live('session-a'), []);
  const [copy] = first.monitor.live('session-a');
  copy.phase = 'tampered';
  assert.equal(first.monitor.live('session-a')[0].phase, 'generating');

  a.committed();
  assert.deepEqual(first.monitor.live('session-a'), []);
  assert.equal(first.monitor.live('session-b').length, 1, 'the other attempt is still live');
});
