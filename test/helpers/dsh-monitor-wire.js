// test/helpers/dsh-monitor-wire.js — the answers of the host's `inner-monitor*` endpoints as the client reads them, over the channel's `{ ok, value | error }` envelope.
// Shared by the tests of the monitor's client stores and pure state, and by those of the views built on them.

/** A successful answer of the channel's call. */
export const ok = value => ({ ok: true, value });

/** A failure envelope as the host's RPC handler shapes it. */
export const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/** What every monitor endpoint answers while the host holds no access or no instance of the session. */
export const UNAVAILABLE_REPLY = fail('inner_monitor_unavailable', 'The inner compaction monitor is not available in this host.');

const TAIL = { role: 'user', content: [{ type: 'text', text: 'summarize the history' }] };

/**
 * One attempt row as `rowsOf` shapes it, a committed attempt recorded without a quote unless `overrides` say otherwise; a `call` override is merged into the default call.
 * @param {number} id
 * @param {object} [overrides]
 */
export function attemptRow(id, overrides = {}) {
  const { call, ...rest } = overrides;
  return {
    id,
    revision: id + 2,
    status: 'committed',
    legacy: false,
    startedAt: 1_000 + id,
    endedAt: 1_900 + id,
    range: { first: 1, last: 4, count: 4 },
    reason: null,
    slots: 2,
    call: {
      state: 'received', endedAt: 1_500 + id, finish: 'stop', thrown: null, input: 'summarize the history', output: '["note one","note two"]',
      usage: { input: 120, output: 40, cacheRead: 100, cacheWrite: 20 },
      ...call,
    },
    contextChange: { before: 460, after: 710, delta: 250, miss: 510 },
    trigger: null,
    stepN: null,
    cRatio: null,
    epoch: 0,
    ...rest,
  };
}

/** The `inner-monitor` answer's value for `attempts` and `handoffs`. */
export const rowsValue = (attempts, handoffs = []) => ({ attempts, handoffs });

/** The moment a handoff row is delivered at; its default `createdAt` lies three hours before it. */
export const HANDOFF_TIME = 100_000_000;

/**
 * One handoff row as `handoffRowOf` shapes it, a loaded handoff unless `overrides` say otherwise.
 * @param {number} id
 * @param {object} [overrides]
 */
export const handoffRow = (id, overrides = {}) => ({
  id,
  revision: id + 2,
  type: 'load',
  token: 'tok-abc',
  time: HANDOFF_TIME,
  createdAt: HANDOFF_TIME - 3 * 3_600_000,
  epoch: 1,
  kept: 5,
  read: 3,
  skills: 2,
  lineage: 4,
  contextChange: null,
  tailSteps: null,
  nextTask: 'ship the handoff rows',
  ...overrides,
});

/**
 * The `inner-monitor/handoff` answer's value for `row`.
 * @param {object} row
 * @param {object} [overrides]
 */
export const handoffPayload = (row, overrides = {}) => ({
  row,
  summary: 'the handoff summary',
  paths: [],
  skills: [],
  files: [{ path: '/work/a.js', total: 12, runs: [{ offset: 3, lines: [{ number: 3, text: 'const a = 1;' }] }] }],
  lineage: [{ label: 'S1', headline: 'first session' }, { label: 'S2-S3', omitted: true }],
  turnPage: 'S1:1 U: first\nS1:1 A: note',
  turns: [{ address: 'S1:1', user: 'first\nline', note: 'a note' }, { address: null, user: 'second', note: null }],
  followUp: 'Handoff "tok-abc" is loaded.',
  ...overrides,
});

/**
 * The `inner-monitor/call` answer's value for `row`: the row as it stands, the seqs of its facts, the request display with the tool count and, beside it, the definitions of those tools, the response, the usage, the timing, the carrier's B text and the quote, the last two none unless given.
 * @param {object} row
 * @param {object} [overrides]
 */
export function callPayload(row, overrides = {}) {
  return {
    row,
    ids: { start: row.id, call: row.id + 1, end: null, carrier: row.id + 2 },
    request: {
      options: { provider: 'p', model: 'm', purpose: 'compaction', sessionId: 's1' },
      messages: { count: 6, tail: TAIL },
      throughSeq: 9,
      headerSeq: 1,
      tools: { count: 1, definitions: [{ name: 'read', description: 'reads a file', parameters: {} }] },
    },
    response: { live: false, blocks: row.call.output === null ? [] : [{ type: 'text', text: row.call.output }], error: null, stream: [], finish: null, firstAt: null },
    usage: { folded: row.call.usage, raw: null },
    timing: { attempt: { startedAt: row.startedAt, endedAt: row.endedAt }, call: { startedAt: row.startedAt, endedAt: row.call.endedAt } },
    carried: null,
    quote: null,
    ...overrides,
  };
}

/**
 * One slot's row as the `inner-monitor/slots` answer lists it.
 * @param {number} key - the slot's first seq
 * @param {object} [overrides]
 */
export const slotRow = (key, overrides = {}) => ({
  key, turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model' }, input: 'the source events the call saw', output: 'a note for the slot', ...overrides,
});

/** The `inner-monitor/slots` answer's value for `slots`. */
export const slotsValue = slots => ({ slots });

/**
 * The `inner-monitor/slot` answer's value for the slot that starts at `key`.
 * @param {number} key
 * @param {object} [overrides]
 */
export const slotValue = (key, overrides = {}) => ({
  key, number: 1, seqs: [key, key + 1], turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model' }, c: 'a note for the slot',
  events: [{ seq: key, type: 'user/message', visible: true, blocks: [{ type: 'text', text: 'the source' }], raw: { seq: key, type: 'user/message' } }],
  ...overrides,
});
