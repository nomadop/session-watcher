// lib/harness/dsh/source-driver.js — DSH Source acquisition.
// Holds one session's bootstrap queue, its measurement source fold, its snapshot tail and its diagnostics sink, and produces the
// HarnessFrames of the session's snapshot and live events. Source mutation is one-way: the host calls in
// and applies the frames that come back. Reducer diagnostics reach the host through the sink alone; no
// frame carries them.

import { createSourceFold } from '../../measurement/source-fold.js';
import { createFoldInputs } from './recall-facts.js';

function invariant(ok, message) {
  if (!ok) throw new Error(`dsh source driver invariant: ${message}`);
}

/**
 * The HarnessFrames of one DSH session: the events of its snapshot, then its live events, fed in `seq` order,
 * every event pushed, as `createFoldInputs` gives it, through one measurement source fold (`lib/measurement/source-fold.js`).
 *
 * - `install(snapshotEvents)`, once: every snapshot event pushed, and one frame of the folded batches
 *   `{ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true,
 *   captureMode: 'replay' }`.
 * - `feed(event)`: until `drain`, queues the event behind every event fed before it and returns null.
 *   After `drain`, returns the event's frame: when its push rewinds, the install frame's shape over the folded
 *   batches as they now stand; otherwise its live frame
 *   `{ transition: 'append', batches: [batch], sourceObserved: true, captureMode: 'live' }`, or null
 *   when the event yields no Observation.
 * - `drain()`, after `install`: drops each queued event whose `seq` is at most the snapshot's last `seq`,
 *   none after an empty snapshot, and returns the frame of every other queued event that has one, in `seq`
 *   order.
 *
 * With `qualifyCalls` answering true when a frame is made, the frame also carries `qualifiedCalls`, how many of the open epoch's calls the Source qualifies for a budget at its cut (`createSourceFold`'s `qualifiedCalls`). The driver decides nothing of whether a session wants that: the caller does, by what `qualifyCalls` answers.
 *
 * `onDiagnostics` is handed every non-empty diagnostics array the reducer yields, before the call that
 * reduced it returns: the snapshot's once at `install`, and each reduced event's at `drain` or `feed`. An
 * event `drain` drops is not reduced, so it reports nothing. `sessionId` is the replace frame's
 * `sourceLocator`, as given.
 *
 * @param {{ sessionId: string, onDiagnostics: (diagnostics: object[]) => void, qualifyCalls?: () => boolean }} options
 * @returns {{ install: (snapshotEvents: object[]) => object, feed: (event: object) => object|null,
 *   drain: () => object[] }}
 */
export function createDshSourceDriver({ sessionId, onDiagnostics, qualifyCalls = () => false } = {}) {
  invariant(typeof onDiagnostics === 'function', 'onDiagnostics must be a function');
  const queue = [];
  const fold = createSourceFold();
  const inputOf = createFoldInputs({ sessionId, fold });
  let installed = false;
  let drained = false;
  let snapshotTail;

  function report(diagnostics) {
    if (diagnostics.length > 0) onDiagnostics(diagnostics);
  }

  const qualified = frame => (qualifyCalls() ? { ...frame, qualifiedCalls: fold.qualifiedCalls() } : frame);

  const replayFrame = () => qualified({
    transition: 'replace', sourceLocator: sessionId, batches: fold.batches(), sourceObserved: true,
    captureMode: 'replay',
  });

  // A rewind is a Source Reconstruction within the open epoch (`CONTEXT.md` Source Reconstruction), so its frame is
  // the install frame's.
  function liveFrame(event) {
    const { batch, rewound, diagnostics } = fold.push(inputOf(event));
    report(diagnostics);
    if (rewound) return replayFrame();
    if (batch === null) return null;
    return qualified({ transition: 'append', batches: [batch], sourceObserved: true, captureMode: 'live' });
  }

  function install(snapshotEvents) {
    invariant(!installed, 'install runs once');
    const diagnostics = snapshotEvents.flatMap(event => fold.push(inputOf(event)).diagnostics);
    installed = true;
    // DSH numbers a session's events from zero, so the tail of an empty snapshot sits below every seq
    // (test/dsh.source-driver.test.js `drain keeps a queued seq 0 event`).
    snapshotTail = snapshotEvents.length === 0 ? -1 : snapshotEvents.at(-1).seq;
    report(diagnostics);
    return replayFrame();
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
