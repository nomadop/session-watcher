// public/lib/bucketState.js — bucket fetch signals for the bucket panel's sync chip, shared by every transport

/** A fetch that ends before this delay never reports `isFetching`, so fast rounds do not flash the syncing state. */
export const BUCKET_FETCH_DEBOUNCE_MS = 300;

/**
 * `begin()` opens a fetch round; `end(ok)` closes it, counting a failure when `ok` is false and resetting the
 * count and stamping `lastSuccessAt` when it is true. `end()` without a verdict closes a round whose
 * buckets result is not read and leaves both counters. Each subscriber sees each change once.
 */
export function createBucketStateTracker() {
  const listeners = new Set();
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let isFetching = false;
  let fetchingTimer = null;

  function snapshot() { return { isFetching, consecutiveFailures, lastSuccessAt }; }
  function notify() { const s = snapshot(); for (const cb of listeners) cb(s); }

  return {
    begin() {
      if (fetchingTimer) return;
      fetchingTimer = setTimeout(() => { isFetching = true; notify(); }, BUCKET_FETCH_DEBOUNCE_MS);
    },
    end(ok) {
      if (fetchingTimer) { clearTimeout(fetchingTimer); fetchingTimer = null; }
      const wasFetching = isFetching;
      isFetching = false;
      if (ok === true) { consecutiveFailures = 0; lastSuccessAt = Date.now(); }
      else if (ok === false) consecutiveFailures++;
      else if (!wasFetching) return;
      notify();
    },
    get state() { return snapshot(); },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
