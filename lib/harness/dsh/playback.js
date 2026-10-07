// lib/harness/dsh/playback.js — DSH Transcript Playback: the index of a decoded session log's measured steps, and
// the driver that paces its events into HarnessFrames up to each step.

import { reduceDshSnapshot } from './transcript-observation.js';

/**
 * One `{ limit, ts }` per `assistant/message` event carrying `data.usage`, in log order: `limit` is the event's
 * `seq` and `ts` its `time`. That is the event on which the reducer adds a usage Observation; one whose usage the
 * reducer rejects still indexes, and its step folds no call.
 * @param {object[]} events DSH v4 session events in log order
 * @returns {{ limit: number, ts: number }[]}
 */
export function indexDshLog(events) {
  return events
    .filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined)
    .map(event => ({ limit: event.seq, ts: event.time }));
}

/**
 * A cursor over `events` in log order. `advance({ captureMode = 'replay', limit = Infinity })` takes the events
 * from the cursor while `event.seq <= limit`, moves past them and reduces them through `reduceDshSnapshot`. No
 * batch answers null, the taken events staying taken; otherwise the first frame the driver returns is
 * `{ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode }` and every later
 * one `{ transition: 'append', batches, sourceObserved: true, captureMode }`. Reducer diagnostics are dropped.
 * @param {{ sessionId: string, events: object[] }} options
 * @returns {{ advance: (options: { captureMode?: string, limit?: number }) => object|null }}
 */
export function createDshPlaybackDriver({ sessionId, events }) {
  let cursor = 0;
  let replaced = false;

  function advance({ captureMode = 'replay', limit = Infinity } = {}) {
    const start = cursor;
    while (cursor < events.length && events[cursor].seq <= limit) cursor += 1;
    const { batches } = reduceDshSnapshot(events.slice(start, cursor));
    if (batches.length === 0) return null;
    if (replaced) return { transition: 'append', batches, sourceObserved: true, captureMode };
    replaced = true;
    return { transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode };
  }

  return { advance };
}
