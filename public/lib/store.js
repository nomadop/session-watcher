// public/lib/store.js — single snapshot + subscriber notify
export function createStore() {
  let snapshot = { status: null, history: [], capabilities: null };
  const subscribers = new Set();
  return {
    getSnapshot() { return snapshot; },
    update(status, history, capabilities) {
      snapshot = { status, history, capabilities };
      for (const cb of subscribers) cb(snapshot);
    },
    subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
  };
}
