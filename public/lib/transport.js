// public/lib/transport.js — SSE + poll fallback + connection state + explicit start
export function createTransport({ statusUrl = '/api/status', historyUrl = '/api/history', streamUrl = '/api/stream', bucketsUrl = '/api/buckets', pollMs = 2000 } = {}) {
  let state = 'connecting';
  const listeners = new Set();
  const stateListeners = new Set();
  const tickListeners = new Set();
  let pollTimer = null;
  let es = null;
  let destroyed = false;
  // Fix #5: inflight guard prevents stale-data overwrite from concurrent fetchData calls.
  // SSE onmessage fires synchronously, so rapid scan events would queue multiple parallel fetches.
  // The guard ensures only one fetch runs at a time; a new event while inflight is silently dropped
  // (the in-flight fetch will get the latest data anyway).
  let inflight = null;

  // Bucket-state signals for loading UX (States 2a/2b)
  const bucketStateListeners = new Set();
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let isFetching = false;
  let fetchingTimer = null;  // debounce: only report isFetching=true after BUCKET_FETCH_DEBOUNCE_MS

  const BUCKET_FETCH_DEBOUNCE_MS = 300;  // don't flash syncing for fast fetches

  function notifyBucketState() {
    const s = { isFetching, consecutiveFailures, lastSuccessAt };
    for (const cb of bucketStateListeners) cb(s);
  }

  function setBucketFetching(val) {
    if (val) {
      // Start debounce timer — only set isFetching=true after delay
      if (!fetchingTimer) {
        fetchingTimer = setTimeout(() => {
          isFetching = true;
          notifyBucketState();
        }, BUCKET_FETCH_DEBOUNCE_MS);
      }
    } else {
      // Clear: cancel pending timer, set false immediately
      if (fetchingTimer) { clearTimeout(fetchingTimer); fetchingTimer = null; }
      if (isFetching) { isFetching = false; notifyBucketState(); }
    }
  }

  function notify(status, history, capabilities, bucketData) { for (const cb of listeners) cb(status, history, capabilities, bucketData); }
  function notifyTick(uptime) { for (const cb of tickListeners) cb(uptime); }
  function notifyState() { for (const cb of stateListeners) cb(state); }
  function setState(s) { if (state !== s) { state = s; notifyState(); } }

  async function fetchData() {
    setBucketFetching(true);
    try {
      const [sRes, hRes, bRes] = await Promise.all([
        fetch(statusUrl), fetch(historyUrl),
        fetch(bucketsUrl).catch(() => null),  // buckets failure must not sink status/history
      ]);
      if (!sRes.ok || !hRes.ok) { setBucketFetching(false); setState('disconnected'); return; }
      const status = await sRes.json();
      const history = await hRes.json();
      let bucketData = null;
      if (bRes && bRes.ok) {
        try { bucketData = await bRes.json(); } catch { bucketData = null; }
      }
      if (bucketData !== null) {
        consecutiveFailures = 0; lastSuccessAt = Date.now();
      } else {
        consecutiveFailures++;  // covers both HTTP error (bRes.ok=false) and network error (bRes=null)
      }
      setBucketFetching(false);
      notifyBucketState();
      if (pollTimer) setState('polling');
      notify(status, history, null, bucketData);  // capabilities computed downstream in app.js
    } catch { setBucketFetching(false); consecutiveFailures++; notifyBucketState(); setState('disconnected'); }
  }

  function startPolling() {
    if (pollTimer || destroyed) return;
    setState('polling');
    pollTimer = setInterval(fetchData, pollMs);
  }

  function connect() {
    if (destroyed) return;
    try {
      es = new EventSource(streamUrl);
      es.onopen = () => setState('sse-live');
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'tick') {
            // Switch connection state label when replay is active
            if (msg.replay) setState('replay');
            else if (state === 'replay') setState('sse-live');
            notifyTick(msg.uptime);
          } else if (msg.type === 'scan') {
            // Fix #5: skip if a fetch is already in flight — the in-flight fetch will get latest data
            if (!inflight) inflight = fetchData().finally(() => { inflight = null; });
          }
        } catch {}
      };
      es.onerror = () => { es.close(); es = null; startPolling(); };
    } catch { startPolling(); }
  }

  return {
    onData(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onTick(cb) { tickListeners.add(cb); return () => tickListeners.delete(cb); },
    onStateChange(cb) { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    onBucketState(cb) { bucketStateListeners.add(cb); return () => bucketStateListeners.delete(cb); },
    get connectionState() { return state; },
    get bucketState() { return { isFetching, consecutiveFailures, lastSuccessAt }; },
    // Fix #5: refresh() also uses the inflight guard to prevent double-fetches
    refresh() { if (!inflight) { inflight = fetchData().finally(() => { inflight = null; }); } return inflight; },
    start() { fetchData(); connect(); },
    destroy() {
      destroyed = true;
      if (es) { es.close(); es = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (fetchingTimer) { clearTimeout(fetchingTimer); fetchingTimer = null; }
      listeners.clear(); stateListeners.clear(); tickListeners.clear(); bucketStateListeners.clear();
    }
  };
}
