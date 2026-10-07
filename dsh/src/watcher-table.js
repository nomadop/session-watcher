// dsh/src/watcher-table.js — one `SessionWatcher` per DSH session, from its bootstrap snapshot through its live feed to failure or disposal.
// It knows no Cordis: the host hands it each session, event and disposal, and reads its entries.
// Its diagnostics leave through one stderr line, `writeDiagnostic`, which the host's own catches share.
import { createDshSourceDriver } from '../../lib/harness/dsh/source-driver.js';
import { advanceRateLampToCurrent, releaseSession } from '../../lib/rate-lamp-manager.js';

const HOST_SCOPE = 'dsh-host';

/** One stderr line for one diagnostic, behind the session id when there is one. */
export function writeDiagnostic(sessionId, { scope, code, message }) {
  const line = `[${scope}] ${code}: ${message}`;
  console.error(sessionId == null ? line : `${sessionId} ${line}`);
}

// A rejection or throw may carry any value, and the line that reports it must still be written.
const messageOf = error => (error instanceof Error ? error.message : String(error));

const hostDiagnostic = (code, error) => ({ scope: HOST_SCOPE, code, message: messageOf(error) });

/** The diagnostic of any throw outside the frame path: a handler body, a disposer, a bootstrap continuation, the Rate Lamp advance after an applied frame. */
export function handlerFailed(error) {
  return hostDiagnostic('handler_failed', error);
}

const missingEntry = sessionId => new Error(`session ${sessionId} has no watcher`);

const aborted = (sessionId, signal) => new Error(`session ${sessionId}: the wait for its watcher was aborted`,
  { cause: signal.reason });

const PASS_THROUGH_NAMES = {
  warm: () => Promise.resolve([]),
  pairsOf: () => [],
  mapEvent: event => event,
};

/**
 * The watcher table.
 * An entry is `bootstrapping` from `ensure` until its snapshot installs, then `live`; a rejected snapshot or a throw on the frame path makes it `failed`, its terminal state, holding the one diagnostic that failed it.
 * `ensure` throws once `disposeAll` has run, the table's terminal transition, and plants no entry.
 * `dispose` archives a `live` entry and removes it, marks a `bootstrapping` one so its snapshot installs, archives and removes it, and removes a `failed` one, each archive under the mode the watcher's own live mark decides; every removal and every failure releases the session from the Rate Lamp manager.
 * `cacheTtlFor(route)` maps the route of an `assistant/message` to the cache lifetime its entry's model policy prices under.
 * `modelNames` is a `createModelNames` result, a pass-through when absent: each `request/header` fed warms its pair without the feed awaiting it; a snapshot installs once every pair named by its events and by the events fed before it arrived has settled once; and every `assistant/message` reaches the driver through `mapEvent`.
 * The events fed while bootstrapping wait in the entry, in order, and reach the driver after the snapshot's install, ahead of its drain.
 * `onChange(listener)` adds a listener the table calls with the session id once each when an entry turns `live`, when a fed event applies a frame, when an entry fails and when it is removed; the frames the snapshot install drains are covered by the `live` call, and a listener's throw is a `handler_failed` line.
 *
 * @param {{ compose: (options: { sessionId: string, cwd: string|null, cacheTtl: () => string|null }) =>
 *   { watcher: object, dialogueSource: object, dialogueProjection: object },
 *   readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   cacheTtlFor?: (route: string|undefined) => string|null,
 *   modelNames?: { warm: (pairs: object[]) => Promise<unknown>, pairsOf: (events: object[]) => object[],
 *     mapEvent: (event: object) => object } }} options
 */
export function createWatcherTable({ compose, readSession, cacheTtlFor = () => null, modelNames = PASS_THROUGH_NAMES }) {
  const entries = new Map();
  const listeners = new Set();
  let closed = false;

  function notify(sessionId) {
    for (const listener of listeners) {
      try { listener(sessionId); } catch (error) { writeDiagnostic(sessionId, handlerFailed(error)); }
    }
  }

  function writeAll(sessionId, diagnostics) {
    for (const diagnostic of diagnostics) writeDiagnostic(sessionId, diagnostic);
  }

  // A malformed `assistant/message` is the reducer's to report, so reading its route never throws.
  function noteRoute(entry, event) {
    if (event.type === 'assistant/message') entry.cacheTtl = cacheTtlFor(event.data?.message?.source?.provider);
  }

  function liveView(entry) {
    const { watcher, dialogueSource, dialogueProjection, cacheTtl } = entry;
    return { state: 'live', watcher, dialogueSource, dialogueProjection, cacheTtl };
  }

  function settleWaiters(entry, settle) {
    for (const waiter of entry.waiters) {
      waiter.release();
      settle(waiter);
    }
    entry.waiters.clear();
  }

  function fail(entry, diagnostic) {
    entry.state = 'failed';
    entry.diagnostic = diagnostic;
    writeDiagnostic(entry.sessionId, diagnostic);
    releaseSession(entry.sessionId);
    settleWaiters(entry, waiter => waiter.reject(new Error(diagnostic.message)));
    notify(entry.sessionId);
  }

  // A disposal during bootstrap reaches this twice, and only the call that removed the entry notifies.
  function remove(entry) {
    const removed = entries.delete(entry.sessionId);
    releaseSession(entry.sessionId);
    settleWaiters(entry, waiter => waiter.reject(missingEntry(entry.sessionId)));
    if (removed) notify(entry.sessionId);
  }

  function apply(entry, frame) {
    writeAll(entry.sessionId, entry.watcher.applyHarnessFrame(frame).diagnostics);
    try {
      advanceRateLampToCurrent(entry.watcher, entry.sessionId, { forcePoll: false });
    } catch (error) {
      writeDiagnostic(entry.sessionId, handlerFailed(error));
    }
  }

  // The driver cannot be reused after a reducer, sink or application throw, so the entry fails instead of retrying.
  function onFramePath(entry, run) {
    try {
      run();
      return true;
    } catch (error) {
      fail(entry, hostDiagnostic('frame_application_failed', error));
      return false;
    }
  }

  const mapped = event => modelNames.mapEvent(event);

  // The driver answers null to an event fed before its drain, so the pending events' frames are the drain's alone.
  function install(entry, events) {
    const lastCall = events.findLast(event => event.type === 'assistant/message');
    if (lastCall !== undefined) noteRoute(entry, lastCall);
    apply(entry, entry.driver.install(events.map(mapped)));
    for (const event of entry.pending) entry.driver.feed(mapped(event));
    entry.pending = [];
    for (const frame of entry.driver.drain()) apply(entry, frame);
  }

  // Never rejects: an unhandled rejection exits the DSH host.
  async function bootstrap(entry, reading) {
    try {
      let snapshot;
      try {
        snapshot = await reading;
      } catch (error) {
        fail(entry, hostDiagnostic('read_session_rejected', error));
        return;
      }
      await modelNames.warm(modelNames.pairsOf([...snapshot.events, ...entry.pending]));
      if (entry.state !== 'bootstrapping') return;
      if (!onFramePath(entry, () => install(entry, snapshot.events))) return;
      if (entry.disposed) {
        try {
          writeAll(entry.sessionId, entry.watcher.closeCurrentSegment().diagnostics);
        } finally {
          remove(entry);
        }
        return;
      }
      entry.state = 'live';
      const view = liveView(entry);
      settleWaiters(entry, waiter => waiter.resolve(view));
      notify(entry.sessionId);
    } catch (error) {
      fail(entry, handlerFailed(error));
    } finally {
      if (entry.disposed) remove(entry);
    }
  }

  function ensure(session) {
    if (closed) throw new Error('the watcher table is closed');
    const sessionId = session.id;
    if (entries.has(sessionId)) return;
    const entry = {
      sessionId, state: 'bootstrapping', disposed: false, cacheTtl: null, diagnostic: null, waiters: new Set(),
      pending: [],
    };
    const { watcher, dialogueSource, dialogueProjection } = compose({
      sessionId, cwd: session.header.cwd, cacheTtl: () => entry.cacheTtl,
    });
    Object.assign(entry, { watcher, dialogueSource, dialogueProjection });
    entry.driver = createDshSourceDriver({ sessionId, onDiagnostics: diagnostics => writeAll(sessionId, diagnostics) });
    const reading = readSession(sessionId);
    entries.set(sessionId, entry);
    void bootstrap(entry, reading);
  }

  function feed(sessionId, event) {
    const entry = entries.get(sessionId);
    if (entry === undefined || (entry.state !== 'bootstrapping' && entry.state !== 'live')) return;
    // `warm` settles through `allSettled`, so the promise left unawaited never rejects (test/dsh.host.watcher-table.test.js `a rejected warm-up never fails the entry`).
    if (event.type === 'request/header') void modelNames.warm(modelNames.pairsOf([event]));
    let frame = null;
    const applied = onFramePath(entry, () => {
      noteRoute(entry, event);
      if (entry.state === 'bootstrapping') {
        entry.pending.push(event);
        return;
      }
      frame = entry.driver.feed(mapped(event));
      if (frame !== null) apply(entry, frame);
    });
    if (applied && frame !== null) notify(sessionId);
  }

  function dispose(sessionId) {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.state === 'bootstrapping') {
      entry.disposed = true;
      return;
    }
    if (entry.state === 'failed') {
      remove(entry);
      return;
    }
    // Removed even when the archival throws, so no closed session keeps a ledger the write-behind timer retries.
    try {
      writeAll(sessionId, entry.watcher.closeCurrentSegment().diagnostics);
    } finally {
      remove(entry);
    }
  }

  function disposeAll() {
    closed = true;
    for (const sessionId of [...entries.keys()]) {
      try { dispose(sessionId); } catch (error) { writeDiagnostic(sessionId, handlerFailed(error)); }
    }
  }

  function get(sessionId) {
    const entry = entries.get(sessionId);
    if (entry === undefined) return { state: 'unobserved' };
    if (entry.state === 'live') return liveView(entry);
    if (entry.state === 'failed') return { state: 'failed', diagnostic: entry.diagnostic };
    return { state: 'bootstrapping' };
  }

  // A promise exists only for a caller, so a watcher that fails or goes with nobody waiting rejects nothing.
  function waitLive(sessionId, signal) {
    const entry = entries.get(sessionId);
    if (entry === undefined) return Promise.reject(missingEntry(sessionId));
    if (entry.state === 'live') return Promise.resolve(liveView(entry));
    if (entry.state === 'failed') return Promise.reject(new Error(entry.diagnostic.message));
    if (signal.aborted) return Promise.reject(aborted(sessionId, signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted(sessionId, signal));
      const waiter = { resolve, reject, release: () => signal.removeEventListener('abort', onAbort) };
      entry.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function live() {
    return [...entries.values()]
      .filter(entry => entry.state === 'live')
      .map(({ sessionId, watcher }) => ({ sessionId, watcher }));
  }

  function onChange(listener) {
    listeners.add(listener);
  }

  return { ensure, feed, dispose, disposeAll, get, waitLive, live, onChange };
}
