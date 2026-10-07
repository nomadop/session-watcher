// lib/harness/dsh/source-driver.js — DSH Source acquisition.
// Holds one session's bootstrap queue, its snapshot tail and its diagnostics sink, and produces the
// HarnessFrames of the session's snapshot and live events. Source mutation is one-way: the host calls in
// and applies the frames that come back. Reducer diagnostics reach the host through the sink alone; no
// frame carries them.

import { reduceDshEvent, reduceDshSnapshot } from './transcript-observation.js';

function invariant(ok, message) {
  if (!ok) throw new Error(`dsh source driver invariant: ${message}`);
}

/**
 * The HarnessFrames of one DSH session: the events of its snapshot, then its live events, fed in `seq` order.
 *
 * - `install(snapshotEvents)`, once: the snapshot's events reduced batch by batch into one frame
 *   `{ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true,
 *   captureMode: 'replay' }`.
 * - `feed(event)`: until `drain`, queues the event behind every event fed before it and returns null.
 *   After `drain`, returns the event's live frame
 *   `{ transition: 'append', batches: [batch], sourceObserved: true, captureMode: 'live' }`, or null
 *   when the event yields no Observation.
 * - `drain()`, after `install`: drops each queued event whose `seq` is at most the snapshot's last `seq`,
 *   none after an empty snapshot, and returns the live frame of every other queued event that yields
 *   Observations, in `seq` order.
 *
 * `onDiagnostics` is handed every non-empty diagnostics array the reducer yields, before the call that
 * reduced it returns: the snapshot's once at `install`, and each reduced event's at `drain` or `feed`. An
 * event `drain` drops is not reduced, so it reports nothing. `sessionId` is the replace frame's
 * `sourceLocator`, as given.
 *
 * @param {{ sessionId: string, onDiagnostics: (diagnostics: object[]) => void }} options
 * @returns {{ install: (snapshotEvents: object[]) => object, feed: (event: object) => object|null,
 *   drain: () => object[] }}
 */
export function createDshSourceDriver({ sessionId, onDiagnostics } = {}) {
  invariant(typeof onDiagnostics === 'function', 'onDiagnostics must be a function');
  const queue = [];
  let installed = false;
  let drained = false;
  let snapshotTail;

  function report(diagnostics) {
    if (diagnostics.length > 0) onDiagnostics(diagnostics);
  }

  function liveFrame(event) {
    const { observations, diagnostics } = reduceDshEvent(event);
    report(diagnostics);
    if (observations.length === 0) return null;
    return { transition: 'append', batches: [observations], sourceObserved: true, captureMode: 'live' };
  }

  function install(snapshotEvents) {
    invariant(!installed, 'install runs once');
    const { batches, diagnostics } = reduceDshSnapshot(snapshotEvents);
    installed = true;
    // DSH numbers a session's events from zero, so the tail of an empty snapshot sits below every seq
    // (test/dsh.source-driver.test.js `drain keeps a queued seq 0 event`).
    snapshotTail = snapshotEvents.length === 0 ? -1 : snapshotEvents.at(-1).seq;
    report(diagnostics);
    return {
      transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode: 'replay',
    };
  }

  function feed(event) {
    if (drained) return liveFrame(event);
    queue.push(event);
    return null;
  }

  function drain() {
    invariant(installed, 'drain follows install');
    drained = true;
    const frames = [];
    for (const event of queue.splice(0)) {
      if (event.seq <= snapshotTail) continue;
      const frame = liveFrame(event);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  return { install, feed, drain };
}
