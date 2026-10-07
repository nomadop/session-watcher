// dsh/src/client/session-store.js — the DSH client's per-session stores: each pulls its session's readings when signalled, through a trailing-edge throttle, and folds them into one result.
import { buildCapabilities } from '../../../public/lib/featureDetect.js';
import { createBucketStateTracker } from '../../../public/lib/bucketState.js';

/** The least time from one pull's completion to the start of the next. */
export const MIN_GAP_MS = 1000;
/** The time a pull waits for its calls before it aborts them and ends unreachable. */
export const PULL_TIMEOUT_MS = 5000;

const ENDPOINTS = ['status', 'history', 'buckets'];
const messageOf = error => String(error?.message ?? error);

/**
 * The result of one pull from its three settlements, in `ENDPOINTS` order:
 * the first that rejected or answered `ok: false` gives `{ kind: 'unreachable', message }`;
 * else the first whose state is not `live` gives `{ kind: 'state', state, diagnostic }`;
 * else `{ kind: 'live', snapshot }`, `snapshot` the dashboard's `{ status, history, capabilities, bucketData }` from the three payloads.
 */
function fold(settled) {
  for (const outcome of settled) {
    if (outcome.status === 'rejected') return { kind: 'unreachable', message: messageOf(outcome.reason) };
    if (outcome.value.ok !== true) return { kind: 'unreachable', message: outcome.value.error.message };
  }
  for (const { value: { value } } of settled) {
    if (value.state !== 'live') return { kind: 'state', state: value.state, diagnostic: value.diagnostic };
  }
  const [status, history, bucketData] = settled.map(outcome => outcome.value.value.payload);
  return { kind: 'live', snapshot: { status, history, capabilities: buildCapabilities(status), bucketData } };
}

const answeredLive = outcome => outcome.status === 'fulfilled' && outcome.value.ok === true && outcome.value.value.state === 'live';

/**
 * One store per session over `call(endpoint, payload, signal)`, the channel-bound RPC call.
 *
 * A store's `signal()` is ignored without a subscriber and only marks the store dirty while a pull is in flight; otherwise it pulls at once when no pull has completed or `minGap` has passed since the last completion, and else arms one timer for the last completion plus `minGap`, a signal while that timer is armed doing nothing.
 * A pull calls each of `ENDPOINTS` with `{ sessionId }` and one `AbortSignal`, a synchronous throw counting as a rejection, and completes when every call settles or, at `pullTimeout`, by aborting the signal and ending as a rejection without waiting for them.
 * Every completion records its time as the last completion, sets `result` to the fold, when dirty clears the mark and with a subscriber left arms the timer for `minGap`, closes the bucket tracker's round with success only when `buckets` answered `live`, and then hands `result` to every subscriber. A failed pull is not retried.
 * `subscribe(listener)` signals and answers the unsubscribe; it never calls `listener` synchronously, so a new subscriber reads `result` first, which is null before the first completion. The last unsubscribe clears the timer; a pull in flight then still completes and updates `result`, arming nothing.
 * `refresh()` is `signal()`; `bucketState` and `onBucketState(cb)` are the store's own bucket tracker's.
 * `sessions.for(id)` creates a store on first use and answers the same one after; stores are never dropped. `sessions.signal(id)` signals an existing store and ignores an unknown id; `sessions.openAll()` signals every store.
 *
 * @param {{ call: (endpoint: string, payload: { sessionId: string }, signal: AbortSignal) => Promise<object>, minGap?: number, pullTimeout?: number,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number }} options
 */
export function createSessionStores({
  call, minGap = MIN_GAP_MS, pullTimeout = PULL_TIMEOUT_MS,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, now = Date.now,
}) {
  const stores = new Map();

  function createStore(sessionId) {
    const listeners = new Set();
    const tracker = createBucketStateTracker();
    let timer = null;
    let inflight = null;
    let dirty = false;
    let lastDone = null;
    let result = null;

    function arm(delay) {
      timer = setTimeout(() => {
        timer = null;
        pull();
      }, delay);
    }

    function attempt(endpoint, signal) {
      try {
        return Promise.resolve(call(endpoint, { sessionId }, signal));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function pull() {
      const controller = new AbortController();
      inflight = controller;
      tracker.begin();
      const calls = Promise.allSettled(ENDPOINTS.map(endpoint => attempt(endpoint, controller.signal)));
      const deadline = setTimeout(() => {
        controller.abort(new Error('the pull timed out'));
        complete(ENDPOINTS.map(() => ({ status: 'rejected', reason: controller.signal.reason })));
      }, pullTimeout);
      calls.then((settled) => {
        if (inflight !== controller) return;
        clearTimeout(deadline);
        complete(settled);
      });
    }

    function complete(settled) {
      inflight = null;
      lastDone = now();
      result = fold(settled);
      // Armed before the listeners run, so a listener that signals finds the timer and arms no second one.
      if (dirty) {
        dirty = false;
        if (listeners.size > 0) arm(minGap);
      }
      tracker.end(answeredLive(settled[ENDPOINTS.indexOf('buckets')]));
      for (const listener of listeners) listener(result);
    }

    function signal() {
      if (listeners.size === 0) return;
      if (inflight) {
        dirty = true;
        return;
      }
      if (timer !== null) return;
      if (lastDone === null || now() - lastDone >= minGap) pull();
      else arm(lastDone + minGap - now());
    }

    return {
      get result() { return result; },
      signal,
      refresh: signal,
      subscribe(listener) {
        listeners.add(listener);
        signal();
        return () => {
          if (!listeners.delete(listener) || listeners.size > 0 || timer === null) return;
          clearTimeout(timer);
          timer = null;
        };
      },
      get bucketState() { return tracker.state; },
      onBucketState: cb => tracker.subscribe(cb),
    };
  }

  return {
    for(sessionId) {
      let store = stores.get(sessionId);
      if (!store) {
        store = createStore(sessionId);
        stores.set(sessionId, store);
      }
      return store;
    },
    signal(sessionId) {
      stores.get(sessionId)?.signal();
    },
    openAll() {
      for (const store of stores.values()) store.signal();
    },
  };
}
