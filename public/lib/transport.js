// public/lib/transport.js — SSE + poll fallback + connection state + explicit start
export function createTransport({ statusUrl = '/api/status', historyUrl = '/api/history', streamUrl = '/api/stream', pollMs = 2000 } = {}) {
  let state = 'connecting';
  const listeners = new Set();
  const stateListeners = new Set();
  let pollTimer = null;
  let es = null;
  let destroyed = false;
  // Fix #5: inflight guard prevents stale-data overwrite from concurrent fetchData calls.
  // SSE onmessage fires synchronously, so rapid scan events would queue multiple parallel fetches.
  // The guard ensures only one fetch runs at a time; a new event while inflight is silently dropped
  // (the in-flight fetch will get the latest data anyway).
  let inflight = null;

  function notify(status, history) { for (const cb of listeners) cb(status, history); }
  function notifyState() { for (const cb of stateListeners) cb(state); }
  function setState(s) { if (state !== s) { state = s; notifyState(); } }

  async function fetchData() {
    try {
      const [sRes, hRes] = await Promise.all([fetch(statusUrl), fetch(historyUrl)]);
      if (!sRes.ok || !hRes.ok) { setState('disconnected'); return; }
      const status = await sRes.json();
      const history = await hRes.json();
      if (pollTimer) setState('polling');
      notify(status, history);
    } catch { setState('disconnected'); }
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
          if (JSON.parse(e.data).type === 'scan') {
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
    onStateChange(cb) { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    get connectionState() { return state; },
    // Fix #5: refresh() also uses the inflight guard to prevent double-fetches
    refresh() { if (!inflight) { inflight = fetchData().finally(() => { inflight = null; }); } return inflight; },
    start() { fetchData(); connect(); },
    destroy() {
      destroyed = true;
      if (es) { es.close(); es = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      listeners.clear(); stateListeners.clear();
    }
  };
}
