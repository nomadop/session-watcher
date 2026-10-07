// test/dsh.playback.test.js — the DSH Playback index and driver: one index entry per usage-bearing assistant message,
// and a driver whose frames, cut at any limits, concatenate to the batches the DSH source driver installs for the
// same events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshPlaybackDriver, indexDshLog } from '../lib/harness/dsh/playback.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { hasDshFixture, readDshFixture } from './helpers/dsh-fixtures.js';
import * as E from './helpers/dsh-events.js';

const SESSION_ID = 'session-playback';
const FIXTURES = ['compaction-prune', 'plain-ask', 'subagent'];
const SEQUENCES = {
  compactionFailure: E.compactionFailure,
  retryWithUsage: E.retryWithUsage,
  reusedCallIdAcrossSteps: E.reusedCallIdAcrossSteps,
  toolError: E.toolError,
  askAborted: E.askAborted,
  askEmptyAnswer: E.askEmptyAnswer,
};

const installBatches = events => createDshSourceDriver({ sessionId: SESSION_ID, onDiagnostics: () => {} })
  .install(events).batches.flat();

const USAGE = { inputTokens: 3, outputTokens: 20, totalTokens: 9623, cacheWriteTokens: 9600 };

test('the index holds one limit and ts per assistant message that carries usage, in log order', () => {
  const events = E.sessionLog([
    E.turnStart(),
    E.userMessage({ text: 'Go.' }),
    E.stepStart({ step: 1 }),
    E.attempt({ step: 1, usageChunk: USAGE, finish: { kind: 'error', failure: { message: 'cut', code: 'X' } } }),
    E.assistantMessage({ step: 1, text: 'first', usage: USAGE }),
    E.stepEnd({ step: 1 }),
    E.stepStart({ step: 2 }),
    E.assistantMessage({ step: 2, text: 'no usage' }),
    E.assistantMessage({ step: 2, text: 'malformed usage', usage: { inputTokens: 'many' } }),
    E.assistantMessage({ step: 2, text: 'last', usage: USAGE }),
    E.stepEnd({ step: 2 }),
    E.turnEnd(),
  ]);

  assert.deepEqual(indexDshLog(events), [
    { limit: 4, ts: events[4].time },
    { limit: 8, ts: events[8].time },
    { limit: 9, ts: events[9].time },
  ]);
});

test('the first returned frame replaces and every later one appends, under the captureMode given', () => {
  const events = E.toolError();
  const driver = createDshPlaybackDriver({ sessionId: SESSION_ID, events });

  assert.deepEqual(driver.advance({ limit: 3 }), {
    transition: 'replace', sourceLocator: SESSION_ID, batches: reduceDshSnapshot(events.slice(0, 4)).batches,
    sourceObserved: true, captureMode: 'replay',
  });
  assert.deepEqual(driver.advance({ captureMode: 'live', limit: 5 }), {
    transition: 'append', batches: reduceDshSnapshot(events.slice(4, 6)).batches, sourceObserved: true,
    captureMode: 'live',
  });
  assert.deepEqual(driver.advance({ captureMode: 'replay', limit: 9 }), {
    transition: 'append', batches: reduceDshSnapshot(events.slice(6, 10)).batches, sourceObserved: true,
    captureMode: 'replay',
  });
});

test('an advance whose events yield no Observation returns null and the next frame still replaces', () => {
  const events = E.toolError();
  const driver = createDshPlaybackDriver({ sessionId: SESSION_ID, events });

  // turn/start alone yields no Observation, and the repeated limit takes no further event.
  assert.equal(driver.advance({ limit: 0 }), null);
  assert.equal(driver.advance({ limit: 0 }), null);
  const frame = driver.advance({ limit: 3 });
  assert.equal(frame.transition, 'replace');
  assert.deepEqual(frame.batches, reduceDshSnapshot(events.slice(1, 4)).batches);
});

test('Infinity takes every event left and a later advance returns null', () => {
  const events = E.reusedCallIdAcrossSteps();
  const driver = createDshPlaybackDriver({ sessionId: SESSION_ID, events });

  driver.advance({ limit: 4 });
  const rest = driver.advance({ limit: Infinity });
  assert.equal(rest.transition, 'append');
  assert.deepEqual(rest.batches, reduceDshSnapshot(events.slice(5)).batches);
  assert.equal(driver.advance({}), null);
  assert.equal(driver.advance({ limit: Infinity }), null);
});

test('after each advance over any split of the log, the frames so far flatten to the install frame\'s batches of the events up to that limit', () => {
  for (const [name, sequence] of Object.entries(SEQUENCES)) {
    const events = sequence();
    const splits = [
      ...events.map(event => [event.seq, Infinity]),
      [...indexDshLog(events).map(entry => entry.limit), Infinity],
      [Infinity],
    ];
    for (const limits of splits) {
      const driver = createDshPlaybackDriver({ sessionId: SESSION_ID, events });
      const played = [];
      for (const limit of limits) {
        const frame = driver.advance({ limit });
        if (frame !== null) played.push(...frame.batches);
        assert.deepEqual(played.flat(), installBatches(events.filter(event => event.seq <= limit)),
          `${name} split at ${limits.join(', ')}, after limit ${limit}`);
      }
    }
  }
});

test('each fixture log played through its index limits and a final unbounded advance yields the install frame\'s batches', async t => {
  for (const name of FIXTURES) {
    await t.test(name, { skip: !hasDshFixture(name) }, () => {
      const { events } = readDshFixture(name);
      const driver = createDshPlaybackDriver({ sessionId: SESSION_ID, events });
      const played = [];
      for (const limit of [...indexDshLog(events).map(entry => entry.limit), Infinity]) {
        const frame = driver.advance({ limit });
        if (frame !== null) played.push(...frame.batches);
      }
      assert.deepEqual(played.flat(), installBatches(events));
    });
  }
});
