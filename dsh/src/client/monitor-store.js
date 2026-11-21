// dsh/src/client/monitor-store.js — per-session access to the monitor's live rows, detail resources and on-demand settlement.
import { paybackCurveOf, settlementForSegment, settlementWithRecall } from '../../../public/lib/compactionEconomics.js';

/** The statuses of an attempt still in progress, whose detail moves with its stream. */
export const ACTIVE_STATUSES = ['generating', 'validating'];

const ROWS_ENDPOINT = 'inner-monitor';
const UNAVAILABLE_CODE = 'inner_monitor_unavailable';
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' });
const messageOf = error => String(error?.message ?? error);
// What a detail rests on is the status and revision of its attempt's or handoff's row; a handoff row has no status.
const sameFacts = (a, b) => a === b || (a !== null && b !== null && a.status === b.status && a.revision === b.revision);

// A success is `ready`; the failure envelope naming `inner_monitor_unavailable` is `unavailable`; any other failure envelope is `unreachable` with the host's message.
function fold(reply, ready) {
  if (reply.ok === true) return ready(reply.value);
  return reply.error?.code === UNAVAILABLE_CODE ? UNAVAILABLE : { kind: 'unreachable', message: messageOf(reply.error) };
}

// The rows' success names the attempts; an answer of any other shape is unreachable like a rejection. A host that answers no handoffs holds none.
function foldRows(reply) {
  return fold(reply, (value) => {
    if (!Array.isArray(value?.attempts)) throw new Error('the inner monitor answered no attempts');
    return { kind: 'ready', attempts: value.attempts, handoffs: value.handoffs ?? [] };
  });
}

const foldResource = reply => fold(reply, value => ({ kind: 'ready', value }));

function foldCurrentSettlement(reply) {
  return fold(reply, (value) => {
    const { epoch, tailCalls, attempts, calls, recall } = value ?? {};
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(tailCalls) || tailCalls < 0 || !Array.isArray(attempts) || !Array.isArray(calls)) {
      throw new Error('the inner monitor answered an incomplete settlement snapshot');
    }
    const base = settlementForSegment(attempts, { epoch, tailCalls });
    const report = base.rows.some(row => row.saved !== null) ? settlementWithRecall(base, recall) : null;
    const curve = report === null ? null : paybackCurveOf(report);
    return { kind: 'ready', value: { snapshot: { kind: 'ready', value: { calls } }, base, report, curve } };
  });
}

// One read as a result: whatever `send` throws or rejects with, and whatever `foldReply` refuses, is `unreachable`.
async function settle(send, foldReply) {
  try {
    return foldReply(await send());
  } catch (error) {
    return { kind: 'unreachable', message: messageOf(error) };
  }
}

// One serialized read loop: a request while a read is in flight marks one more read after it, which runs while `repeat()` holds.
// `reset()` abandons the read in flight: its answer, whenever it comes, applies nothing.
function createReadLoop({ pull, apply, repeat }) {
  let epoch = 0;
  let inflight = false;
  let dirty = false;

  async function run() {
    const mine = epoch;
    inflight = true;
    try {
      do {
        dirty = false;
        const result = await pull();
        if (mine !== epoch) return;
        apply(result);
      } while (dirty && repeat());
    } finally {
      if (mine === epoch) inflight = false;
    }
  }

  return {
    get inflight() { return inflight; },
    request() {
      if (inflight) dirty = true;
      else void run();
    },
    reset() {
      epoch += 1;
      inflight = false;
      dirty = false;
    },
  };
}

/**
 * One store per session over `call(endpoint, payload)`, the channel-bound RPC call: it carries the session in `payload`, answers the channel's `{ ok: true, value }` or `{ ok: false, error }` and rejects on a transport failure.
 * `stores.for(id)` creates a session's store on first use and answers its `{ rows, resource, readCurrentSettlement }` after; stores are never dropped. `stores.signal(id)` signals an existing store and ignores an unknown id; `stores.openAll()` signals every store. No timer runs.
 *
 * `readCurrentSettlement()` returns the prepared settlement snapshot or a read failure without retaining it in the store or subscribing to updates.
 * `rows.result` is null before the first read, then as the last read of `inner-monitor` answered: `{ kind: 'ready', attempts, handoffs }`, `{ kind: 'unavailable' }` for `inner_monitor_unavailable`, or `{ kind: 'unreachable', message }` for any other failure, a rejection or an answer without an attempts list; only a read sets it.
 * A store's signal is ignored without a listener on its session, rows or resource; otherwise it reads the rows at once or, with a read in flight, marks one more read after it, so signals that arrive meanwhile cost one read. `subscribe(listener)` signals and answers the unsubscribe; it never calls `listener` synchronously, so a new subscriber reads `result` first. The listener hears each completed read.
 *
 * `resource({ endpoint, attempt, handoff, slot })` is one detail of an attempt, read from `inner-monitor/call`, `inner-monitor/slots` or `inner-monitor/slot` (which alone names a `slot`, the first seq of one of the attempt's slots), or of a handoff, read from `inner-monitor/handoff` or `inner-monitor/settlement`, which alone name a `handoff` instead of an attempt; one identity has one handle for the page's lifetime. Its `result` is null, `{ kind: 'ready', value }` with the endpoint's whole payload, `{ kind: 'unavailable' }` or `{ kind: 'unreachable', message }`, folded as the rows are.
 * A detail rests on the status and revision of its attempt or handoff in the latest ready rows (an attempt's id and a handoff's id are seqs of different events, so no id names both), kept for every resource, subscribed or not; a failed rows read leaves them. A subscribed resource reads the rows first while none were ready, and reads nothing for an attempt the rows do not name.
 * An attempt in progress is read again at every signal, open and subscription, signals during the read costing one more, and its last ready stays the result until the new answer completes. A settled attempt is read until a read succeeds, whatever fields the payload lacks; that snapshot is kept for its facts. A failure or a rejection leaves the facts unobtained and is the result until a later read completes; a re-subscription, a signal or an open reads them again while no read is in flight, and nothing else does.
 * When a rows read moves an attempt's facts, each resource of that attempt takes the new facts, a null result and no read in flight, all before any listener runs; then the rows listeners hear the rows, the resource's listeners hear null, and the new facts are read. The abandoned read's answer applies nothing.
 *
 * @param {{ call: (endpoint: string, payload: object) => Promise<object> }} options
 */
export function createMonitorStores({ call }) {
  const stores = new Map();

  function createStore(sessionId) {
    const rowListeners = new Set();
    const resources = new Map();
    let rowsResult = null;
    // The facts of the latest ready rows by attempt or handoff id; null while none were ready.
    let baseline = null;

    const subscribed = () => rowListeners.size > 0 || [...resources.values()].some(entry => entry.listeners.size > 0);
    const isActive = entry => ACTIVE_STATUSES.includes(entry.facts.status);
    const wanted = entry => entry.listeners.size > 0 && entry.facts !== null && (isActive(entry) || !entry.obtained);
    const refresh = (entry) => { if (wanted(entry)) entry.reader.request(); };

    function applyRows(result) {
      rowsResult = result;
      const cleared = [];
      if (result.kind === 'ready') {
        baseline = new Map([...result.attempts, ...result.handoffs].map(row => [row.id, { status: row.status, revision: row.revision }]));
        for (const entry of resources.values()) {
          const facts = baseline.get(entry.owner) ?? null;
          if (sameFacts(facts, entry.facts)) continue;
          entry.facts = facts;
          entry.obtained = false;
          entry.reader.reset();
          if (entry.result === null) continue;
          entry.result = null;
          cleared.push(entry);
        }
      }
      for (const listener of [...rowListeners]) listener(result);
      for (const entry of cleared) for (const listener of [...entry.listeners]) listener(null);
      for (const entry of resources.values()) refresh(entry);
    }

    const rowsReader = createReadLoop({
      pull: () => settle(() => call(ROWS_ENDPOINT, { sessionId }), foldRows),
      apply: applyRows,
      repeat: subscribed,
    });

    function signal() {
      if (!subscribed()) return;
      rowsReader.request();
    }

    function createEntry({ endpoint, attempt, handoff, slot }) {
      const owner = attempt ?? handoff;
      const payload = handoff !== undefined ? { sessionId, handoff } : slot === undefined ? { sessionId, attempt } : { sessionId, attempt, slot };
      const entry = { owner, facts: baseline?.get(owner) ?? null, result: null, obtained: false, listeners: new Set() };
      entry.reader = createReadLoop({
        pull: () => settle(() => call(endpoint, payload), foldResource),
        apply(result) {
          entry.result = result;
          if (result.kind === 'ready') entry.obtained = true;
          for (const listener of [...entry.listeners]) listener(result);
        },
        repeat: () => wanted(entry) && isActive(entry),
      });
      entry.handle = {
        get result() { return entry.result; },
        subscribe(listener) {
          entry.listeners.add(listener);
          // Without ready rows no status is known, and none is guessed: the rows are read first, and a rows read in flight is that read.
          if (baseline === null) {
            if (!rowsReader.inflight) rowsReader.request();
          } else {
            refresh(entry);
          }
          return () => { entry.listeners.delete(listener); };
        },
      };
      return entry;
    }

    return {
      signal,
      handles: {
        rows: {
          get result() { return rowsResult; },
          subscribe(listener) {
            rowListeners.add(listener);
            signal();
            return () => { rowListeners.delete(listener); };
          },
        },
        readCurrentSettlement() {
          return settle(() => call('inner-monitor/settlement/current', { sessionId }), foldCurrentSettlement);
        },
        resource({ endpoint, attempt, handoff, slot }) {
          const identity = JSON.stringify([endpoint, attempt ?? handoff, slot ?? null]);
          let entry = resources.get(identity);
          if (!entry) {
            entry = createEntry({ endpoint, attempt, handoff, slot });
            resources.set(identity, entry);
          }
          return entry.handle;
        },
      },
    };
  }

  return {
    for(sessionId) {
      let store = stores.get(sessionId);
      if (!store) {
        store = createStore(sessionId);
        stores.set(sessionId, store);
      }
      return store.handles;
    },
    signal(sessionId) {
      stores.get(sessionId)?.signal();
    },
    openAll() {
      for (const store of stores.values()) store.signal();
    },
  };
}
