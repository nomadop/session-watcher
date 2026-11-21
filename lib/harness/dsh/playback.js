// lib/harness/dsh/playback.js — DSH Transcript Playback: the index of a decoded session log's measured steps, and
// the driver that paces its events into HarnessFrames up to each step.

import { createSourceFold } from '../../measurement/source-fold.js';
import { foldInputOf } from './transcript-observation.js';

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
 * A cursor over `events` in log order, each taken event pushed, as `foldInputOf` gives it, through one measurement source fold (`lib/measurement/source-fold.js`).
 * `advance({ captureMode = 'replay', limit = Infinity })` takes the events from the cursor while
 * `event.seq <= limit` and moves past them. When a push among them rewinds, the frame is
 * `{ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode: 'replay' }` over
 * the folded batches as they then stand, as the DSH source driver frames a rewind. Otherwise no batch answers null,
 * the taken events staying taken; the first frame the driver returns is
 * `{ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode }` and every later
 * one `{ transition: 'append', batches, sourceObserved: true, captureMode }`, `batches` the taken events'.
 * Reducer diagnostics are dropped.
 * @param {{ sessionId: string, events: object[] }} options
 * @returns {{ advance: (options: { captureMode?: string, limit?: number }) => object|null }}
 */
export function createDshPlaybackDriver({ sessionId, events }) {
  const fold = createSourceFold();
  let cursor = 0;
  let replaced = false;

  function advance({ captureMode = 'replay', limit = Infinity } = {}) {
    const batches = [];
    let rewound = false;
    for (; cursor < events.length && events[cursor].seq <= limit; cursor += 1) {
      const pushed = fold.push(foldInputOf(events[cursor]));
      rewound = rewound || pushed.rewound;
      if (pushed.batch !== null) batches.push(pushed.batch);
    }
    if (rewound) {
      replaced = true;
      return {
        transition: 'replace', sourceLocator: sessionId, batches: fold.batches(), sourceObserved: true,
        captureMode: 'replay',
      };
    }
    if (batches.length === 0) return null;
    if (replaced) return { transition: 'append', batches, sourceObserved: true, captureMode };
    replaced = true;
    return { transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode };
  }

  return { advance };
}
