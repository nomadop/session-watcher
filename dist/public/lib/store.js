// public/lib/store.js — single snapshot + subscriber notify
export function createStore() {
  let snapshot = { status: null, history: [], capabilities: null, bucketData: null };
  const subscribers = new Set();
  return {
    getSnapshot() { return snapshot; },
    update(status, history, capabilities, bucketData = null) {
      snapshot = { status, history, capabilities, bucketData };
      for (const cb of subscribers) cb(snapshot);
    },
    subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
  };
}
