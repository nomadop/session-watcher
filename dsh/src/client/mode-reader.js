// dsh/src/client/mode-reader.js — the DSH client's per-session mode readers: each holds what the host's `inner-mode` endpoint last answered for its session and reads it again when signalled.

const MODES = ['off', 'on', 'invalid'];
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' });

// A successful answer that names a mode and a lock is `ready`; a failure envelope, an answer of any other shape and a rejection are all `unavailable`, which no entry renders.
function fold(reply) {
  if (reply.ok !== true) return UNAVAILABLE;
  const { mode, locked } = reply.value ?? {};
  return MODES.includes(mode) && typeof locked === 'boolean' ? { kind: 'ready', mode, locked } : UNAVAILABLE;
}

/**
 * One reader per session over `call(endpoint, payload)`, the channel-bound RPC call, which carries the session.
 *
 * `reader.result` is null before the first read completes, then `{ kind: 'ready', mode, locked }` or `{ kind: 'unavailable' }` as the last read answered; only a read changes it, so a selection's reply never does.
 * A reader's `signal()` is ignored without a subscriber; otherwise it reads at once, or, with a read in flight, marks the reader to read once more after that read completes, so signals that arrive meanwhile cost one read and the last answer is the latest.
 * `subscribe(listener)` reads and answers the unsubscribe; it never calls `listener` synchronously, so a new subscriber reads `result` first. The listener hears each completed read.
 * `readers.for(id)` creates a reader on first use and answers the same one after; `readers.signal(id)` signals an existing reader and ignores an unknown id; `readers.openAll()` signals every reader.
 *
 * @param {{ call: (endpoint: string, payload: { sessionId: string }) => Promise<object> }} options
 */
export function createModeReaders({ call }) {
  const readers = new Map();

  function createReader(sessionId) {
    const listeners = new Set();
    let result = null;
    let inflight = false;
    let dirty = false;

    async function read() {
      inflight = true;
      try {
        do {
          dirty = false;
          try {
            result = fold(await call('inner-mode', { sessionId }));
          } catch {
            result = UNAVAILABLE;
          }
          for (const listener of [...listeners]) listener(result);
        } while (dirty && listeners.size > 0);
      } finally {
        inflight = false;
      }
    }

    function signal() {
      if (listeners.size === 0) return;
      if (inflight) {
        dirty = true;
        return;
      }
      void read();
    }

    return {
      get result() { return result; },
      signal,
      subscribe(listener) {
        listeners.add(listener);
        signal();
        return () => { listeners.delete(listener); };
      },
    };
  }

  return {
    for(sessionId) {
      let reader = readers.get(sessionId);
      if (!reader) {
        reader = createReader(sessionId);
        readers.set(sessionId, reader);
      }
      return reader;
    },
    signal(sessionId) {
      readers.get(sessionId)?.signal();
    },
    openAll() {
      for (const reader of readers.values()) reader.signal();
    },
  };
}
