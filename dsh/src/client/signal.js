// dsh/src/client/signal.js — the DSH client's signal stream: one EventSource on the host's events route, reopened after a bounded backoff.

/** The waits before each successive reopen of a closed stream; every reopen past the last waits the last. */
export const REOPEN_DELAYS_MS = [1000, 2000, 5000, 10000];

/**
 * Opens one `EventSource` on `url`.
 * Each `message` whose data parses to an object with a string `sessionId` calls `onFrame(sessionId)`; any other writes `console.error` and reaches nothing.
 * Each `open` calls `onOpen()` and returns the backoff to the start of `REOPEN_DELAYS_MS`.
 * An `error` that leaves the source `CLOSED` schedules one reopen after the backoff's current delay and advances it; an `error` while the browser reconnects on its own schedules nothing.
 * `onState(state)` hears the stream's connection: `connecting` for each new source and for a browser-side retry, `live` on open, `disconnected` while a reopen waits out its backoff.
 * `close()` cancels a pending reopen and closes the current source; nothing reopens after it.
 *
 * @param {{ url: string, EventSource: typeof EventSource, onFrame: (sessionId: string) => void, onOpen: () => void, onState: (state: 'connecting' | 'live' | 'disconnected') => void,
 *   setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} options
 * @returns {{ close: () => void }}
 */
export function openSignalStream({ url, EventSource, onFrame, onOpen, onState, setTimeout, clearTimeout }) {
  let source = null;
  let reopenTimer = null;
  let attempt = 0;

  function connect() {
    const current = new EventSource(url);
    source = current;
    onState('connecting');
    current.addEventListener('message', (event) => {
      let sessionId;
      try { ({ sessionId } = JSON.parse(event.data)); } catch { sessionId = undefined; }
      if (typeof sessionId !== 'string') {
        console.error('[sw] malformed signal frame', event.data);
        return;
      }
      onFrame(sessionId);
    });
    current.addEventListener('open', () => {
      attempt = 0;
      onState('live');
      onOpen();
    });
    current.addEventListener('error', () => {
      if (current.readyState !== EventSource.CLOSED) {
        onState('connecting');
        return;
      }
      onState('disconnected');
      const delay = REOPEN_DELAYS_MS[Math.min(attempt, REOPEN_DELAYS_MS.length - 1)];
      attempt += 1;
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        connect();
      }, delay);
    });
  }

  connect();
  return {
    close() {
      if (reopenTimer !== null) {
        clearTimeout(reopenTimer);
        reopenTimer = null;
      }
      source.close();
    },
  };
}
