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
  tailCalls: null,
  nextTask: 'ship the handoff rows',
  ...overrides,
});

/** A failed attempt row, which has no slots and ends with the reason. */
export const failedRow = id => attemptRow(id, { status: 'failed', reason: 'the response has no finish chunk', slots: null, endedAt: 1_800 + id });

/** An attempt row still in `status`, its call generating. */
export const progressRow = (id, status) => attemptRow(id, {
  status, endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null },
});

// A compaction that cut 74000 tokens at a rebuild of 8000 tokens, its summary call having read 48000 tokens from the cache and taken 1000 more (400 uncached and 600 written to it), under a write-to-read price ratio of 12, pays back (12 − 1) × 8000 + 48000 + 12 × 1000 = 148000 read-price tokens, which two later steps of 74000 each cover exactly.
export const CUT = { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 };
export const SUMMARY = { input: 400, output: 2_400, cacheRead: 48_000, cacheWrite: 600 };
export const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const paying = (id, overrides = {}) => attemptRow(id, { contextChange: CUT, cRatio: 12, call: { usage: SUMMARY }, stepN: 8, epoch: 0, ...overrides });

/** A committed compaction whose first call after it saw `after` tokens of context and rebuilt `miss` of them in the cache. */
export const rebuilt = (id, after, miss, overrides = {}) => attemptRow(id, { contextChange: { before: after + 1_000, after, delta: -1_000, miss }, epoch: 0, ...overrides });

/** The continue row of the clear of segment `epoch - 1`, which cut `tailCalls` steps off after the segment's last carrier or checkpoint. */
export const clearing = (id, epoch, tailCalls, overrides = {}) => handoffRow(id, { type: 'continue', epoch, tailCalls, ...overrides });

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
  key, turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model', category: 'assistant' }, input: 'the source events the call saw', output: 'a note for the slot', ...overrides,
});

/** The `inner-monitor/slots` answer's value for `slots`. */
export const slotsValue = slots => ({ slots });

/**
 * The `inner-monitor/slot` answer's value for the slot that starts at `key`.
 * @param {number} key
 * @param {object} [overrides]
 */
export const slotValue = (key, overrides = {}) => ({
  key, number: 1, seqs: [key, key + 1], turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model', category: 'assistant' }, c: 'a note for the slot',
  events: [{ seq: key, type: 'user/message', visible: true, blocks: [{ type: 'text', text: 'the source' }], raw: { seq: key, type: 'user/message' } }],
  ...overrides,
});
