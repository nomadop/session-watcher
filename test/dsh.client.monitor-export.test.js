// The inner compaction monitor's Markdown export, `monitor-export.js`: the session's attempts as a list and one attempt as a document of its slots, read through a reader that resolves the monitor endpoints' payloads.
// The reader here is a stub over payloads written out in the shapes the endpoints answer (`inner-monitor`, `inner-monitor/slots`, `inner-monitor/slot`), and the translate is the key followed by its parameters, so the expected documents are written out whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportSession, exportAttempt } from '../dsh/src/client/monitor-export.js';
import { handoffRow } from './helpers/dsh-monitor-wire.js';

const t = (key, params) => (params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);
const NOW = 9_999;
const FENCE = '```';
const LONGER_FENCE = '````';
const lines = parts => `${parts.join('\n')}\n`;

/** An attempt row in the shape `rowsOf` gives, a committed attempt unless `overrides` say otherwise. */
const attemptRow = (id, overrides = {}) => ({
  id,
  revision: id + 2,
  status: 'committed',
  startedAt: 1_000,
  endedAt: 1_900,
  range: { first: 1, last: 4, count: 4 },
  reason: null,
  slots: 3,
  call: {
    state: 'received', endedAt: 1_500, finish: 'stop', thrown: null, input: 'summarize', output: '["a"]', outputDisplay: 'a',
    usage: { input: 120, output: 40, cacheRead: 100, cacheWrite: 20 },
  },
  contextChange: { before: 460, after: 710, delta: 250, miss: 510 },
  stepN: 8,
  epoch: 0,
  trigger: { q: 1.0377949146956498, kappa: 1.1284536821382138 },
  ...overrides,
});
const FAILED = attemptRow(6, {
  status: 'failed', reason: 'no finish chunk', slots: null, endedAt: 1_802, contextChange: null, stepN: null, trigger: null,
  call: { ...attemptRow(6).call, usage: null },
});
const COMMITTED = attemptRow(7);
const COMMITTED_LINE = 'monitor.status.committed · 900 ms · monitor.meta.step(count=8) · monitor.meta.estimate(q=1.04) · monitor.usage.cell(output=40) · monitor.meta.range(before=460,after=710) · monitor.change.increase(count=250) · monitor.meta.miss(count=510) · monitor.overview.seq(seq=7)';
const FAILED_LINE = 'monitor.status.failed · 802 ms · — · — · — · — · — · — · monitor.overview.seq(seq=6)';

/** A slot's row as `inner-monitor/slots` lists it; the export reads only its `key` from the list. */
const slotRow = key => ({ key, turn: null, step: null, source: { type: 'user/message', kind: 'user', category: 'user' }, input: 'listed', inputDisplay: 'listed', output: 'listed' });

/** A slot's detail in the shape `inner-monitor/slot` answers: `number` is the slot's 1-based place in the carrier. */
const slotDetail = (key, number, overrides = {}) => ({
  key, number, seqs: [key], turn: null, step: null, source: { type: 'user/message', kind: 'user', category: 'user' }, c: 'a note', events: [], ...overrides,
});
const eventOf = (seq, type, visible, blocks, raw = { RAW: `raw-marker-${seq}` }) => ({ seq, type, visible, blocks, raw });

// Three slots: the user's ask; an assistant step with an earlier original that the call did not see, a reasoning block and a block of another kind; and an attachment under an empty C string.
const ASK = slotDetail(10, 1, {
  c: 'asked for work',
  events: [eventOf(10, 'user/message', true, [{ type: 'text', text: 'please work' }])],
});
const STEP = slotDetail(11, 2, {
  seqs: [11, 12, 13], turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model', category: 'assistant' }, c: 'read the file',
  events: [
    eventOf(11, 'assistant/message', true, [
      { type: 'reasoning', text: 'HIDDEN-REASONING' },
      { type: 'text', text: 'reading' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' },
      { type: 'unknown', raw: { weird: 'UNKNOWN-RAW' } },
    ]),
    eventOf(12, 'tool/result', false, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'INVISIBLE-ORIGINAL' }] }]),
    eventOf(13, 'tool/result', true, [{
      type: 'tool-result', callId: 'call-1', isError: false,
      blocks: [{ type: 'text', text: 'file pruned' }, { type: 'reasoning', text: 'HIDDEN-NESTED' }, { type: 'unknown', raw: { weird: 'NESTED-UNKNOWN' } }],
    }]),
  ],
});
const SHOT = slotDetail(14, 3, {
  turn: 1, step: 2, source: { type: 'user/message', kind: null, category: 'other' }, c: '',
  events: [eventOf(14, 'user/message', true, [{ type: 'image', attachment: { name: 'shot.png' } }])],
});

/** A stub reader over `rows`, and the `slots` list and `details` by attempt id: the calls it answers are recorded into `calls`. */
function readerOf({ rows, handoffs, slots = {}, details = {} }, calls = []) {
  return {
    rows: async () => { calls.push(['rows']); return handoffs === undefined ? { attempts: rows } : { attempts: rows, handoffs }; },
    slots: async (attempt) => { calls.push(['slots', attempt]); return { slots: slots[attempt].map(({ key }) => slotRow(key)) }; },
    slot: async (attempt, key) => { calls.push(['slot', attempt, key]); return details[attempt].find(detail => detail.key === key); },
  };
}
const committedReader = (calls) => readerOf({ rows: [FAILED, COMMITTED], slots: { 7: [ASK, STEP, SHOT] }, details: { 7: [ASK, STEP, SHOT] } }, calls);

// ── The session ───────────────────────────────────────────────────────────────

test('a session with no attempts exports the monitor\'s own empty text', async () => {
  const reader = readerOf({ rows: [] });
  assert.equal(await exportSession({ reader, t, now: NOW }), 'monitor.rows.empty\n');
});

test('the session is a list with a line per attempt in the monitor\'s order: its ordinal by position, its status and its meta joined, the seq in the meta being its id', async () => {
  const reader = readerOf({ rows: [FAILED, COMMITTED] });
  assert.equal(await exportSession({ reader, t, now: NOW }), lines([
    `- monitor.object.attempt(epoch=1,ordinal=1) · ${FAILED_LINE}`,
    `- monitor.object.attempt(epoch=1,ordinal=2) · ${COMMITTED_LINE}`,
  ]));
});

const LOAD_LINE = 'monitor.handoff.type.load · tok-abc · monitor.handoff.meta.files(read=3,kept=5) · monitor.handoff.meta.skills(count=2) · monitor.handoff.meta.lineage(count=4) · — · — · monitor.overview.seq(seq=';

test('a handoff is a line among the attempts\' in the order of their ids, its title and the meta the list shows, and takes no ordinal from the compactions', async () => {
  const calls = [];
  const reader = readerOf({ rows: [FAILED, COMMITTED], handoffs: [handoffRow(9, { epoch: 2 }), handoffRow(3)] }, calls);
  assert.equal(await exportSession({ reader, t, now: NOW }), lines([
    `- monitor.object.handoff(epoch=2) · ${LOAD_LINE}3)`,
    `- monitor.object.attempt(epoch=1,ordinal=1) · ${FAILED_LINE}`,
    `- monitor.object.attempt(epoch=1,ordinal=2) · ${COMMITTED_LINE}`,
    `- monitor.object.handoff(epoch=3) · ${LOAD_LINE}9)`,
  ]));
  assert.deepEqual(calls, [['rows']], 'the list reads the rows alone');
});

test('a continue line carries the context it changed, and a session with only handoffs is listed and not reported empty', async () => {
  const change = { before: 460, after: 710, delta: 250, miss: 510 };
  const reader = readerOf({ rows: [], handoffs: [handoffRow(4, { type: 'continue', contextChange: change })] });
  assert.equal(await exportSession({ reader, t, now: NOW }), lines([
    '- monitor.object.handoff(epoch=2) · monitor.handoff.type.continue · tok-abc · monitor.handoff.meta.files(read=3,kept=5) · monitor.handoff.meta.skills(count=2) · monitor.handoff.meta.lineage(count=4) · monitor.handoff.meta.range(before=460,after=710) · monitor.change.increase(count=250) · monitor.overview.seq(seq=4)',
  ]));
  assert.equal(await exportSession({ reader: readerOf({ rows: [], handoffs: [] }), t, now: NOW }), 'monitor.rows.empty\n');
});

test('the lines name the segment each attempt began in and its place in that segment, which restarts with each segment; the document of one attempt carries the same title', async () => {
  const rows = [attemptRow(5, { epoch: 0 }), attemptRow(6, { epoch: 0 }), attemptRow(9, { epoch: 2 })];
  const reader = readerOf({ rows, slots: { 9: [] } });
  assert.deepEqual((await exportSession({ reader, t, now: NOW })).trimEnd().split('\n').map(line => line.split(' · ')[0]), [
    '- monitor.object.attempt(epoch=1,ordinal=1)', '- monitor.object.attempt(epoch=1,ordinal=2)', '- monitor.object.attempt(epoch=3,ordinal=1)',
  ]);
  assert.match(await exportAttempt({ reader, attemptId: 9, t, now: NOW }), /^# monitor\.object\.attempt\(epoch=3,ordinal=1\) · monitor\.status\.committed\n/);
});

test('a compaction that paid back is exported as paid, in the session\'s list and in the title of its own document, the others keeping their status', async () => {
  const cut = { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 };
  const rows = [attemptRow(5, { contextChange: cut, cRatio: 12 }), attemptRow(6, { stepN: 2, contextChange: cut, cRatio: 12 })];
  const reader = readerOf({ rows, slots: { 5: [], 6: [] } });
  assert.deepEqual((await exportSession({ reader, t, now: NOW })).trimEnd().split('\n').map(line => line.split(' · ').slice(0, 2).join(' · ')), [
    '- monitor.object.attempt(epoch=1,ordinal=1) · monitor.status.paid', '- monitor.object.attempt(epoch=1,ordinal=2) · monitor.status.committed',
  ]);
  assert.match(await exportAttempt({ reader, attemptId: 5, t, now: NOW }), /^# monitor\.object\.attempt\(epoch=1,ordinal=1\) · monitor\.status\.paid\n/);
  assert.match(await exportAttempt({ reader, attemptId: 6, t, now: NOW }), /^# monitor\.object\.attempt\(epoch=1,ordinal=2\) · monitor\.status\.committed\n/);
});

const CUT = { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 };
const SETTLING_ROWS = () => [attemptRow(1, { contextChange: CUT, cRatio: 12 }), attemptRow(2, { stepN: 1, contextChange: CUT, cRatio: 12 })];
const SETTLEMENT_LINE = '- monitor.object.settlement(epoch=1) · monitor.settlement.count(count=2) · monitor.settlement.steps(count=11) · monitor.settlement.saved(count=370.0k) · monitor.settlement.cost(count=179.6k) · monitor.settlement.net(count=+190.4k) · monitor.settlement.payback(percent=206%)';

test('the settlement of the segment a continue cleared is a line of its own in front of that continue, among the lines in the order of their ids, and the compactions\' statuses read the steps the clear cut off', async () => {
  const continued = handoffRow(5, { type: 'continue', epoch: 1, tailCalls: 2 });
  const reader = readerOf({ rows: [...SETTLING_ROWS(), attemptRow(9, { epoch: 1 })], handoffs: [continued, handoffRow(7, { epoch: 1 })] });
  const exported = (await exportSession({ reader, t, now: NOW })).trimEnd().split('\n');
  assert.deepEqual(exported.map(line => line.split(' · ').slice(0, 2).join(' · ')), [
    '- monitor.object.attempt(epoch=1,ordinal=1) · monitor.status.paid',
    '- monitor.object.attempt(epoch=1,ordinal=2) · monitor.status.paid',
    '- monitor.object.settlement(epoch=1) · monitor.settlement.count(count=2)',
    '- monitor.object.handoff(epoch=2) · monitor.handoff.type.continue',
    '- monitor.object.handoff(epoch=2) · monitor.handoff.type.load',
    '- monitor.object.attempt(epoch=2,ordinal=1) · monitor.status.committed',
  ]);
  assert.equal(exported[2], SETTLEMENT_LINE);
});

test('a load and a segment with no figures export no settlement line, and the document of one attempt reads the steps its segment\'s clear cut off in its title', async () => {
  const rows = SETTLING_ROWS();
  assert.equal((await exportSession({ reader: readerOf({ rows, handoffs: [handoffRow(5, { epoch: 1, tailCalls: 2 })] }), t, now: NOW })).includes('monitor.object.settlement'), false);
  assert.equal((await exportSession({ reader: readerOf({ rows: [attemptRow(1, { contextChange: CUT, cRatio: null })], handoffs: [handoffRow(5, { type: 'continue', epoch: 1, tailCalls: 2 })] }), t, now: NOW })).includes('monitor.object.settlement'), false);
  const reader = readerOf({ rows, handoffs: [handoffRow(5, { type: 'continue', epoch: 1, tailCalls: 2 })], slots: { 2: [] } });
  assert.match(await exportAttempt({ reader, attemptId: 2, t, now: NOW }), /^# monitor\.object\.attempt\(epoch=1,ordinal=2\) · monitor\.status\.paid\n/);
  assert.match(await exportAttempt({ reader: readerOf({ rows, slots: { 2: [] } }), attemptId: 2, t, now: NOW }), /^# monitor\.object\.attempt\(epoch=1,ordinal=2\) · monitor\.status\.committed\n/, 'without the clear the last compaction has no step after it');
});

test('an attempt in progress reads its time from the clock the export is given', async () => {
  const running = attemptRow(8, { status: 'generating', endedAt: null, contextChange: null, stepN: null, trigger: null, call: { ...attemptRow(8).call, usage: null } });
  const reader = readerOf({ rows: [running] });
  const exported = await exportSession({ reader, t, now: 4_500 });
  assert.equal(exported, lines(['- monitor.object.attempt(epoch=1,ordinal=1) · monitor.status.generating · 3.5 s · — · — · — · — · — · — · monitor.overview.seq(seq=8)']));
});

// ── One attempt ───────────────────────────────────────────────────────────────

test('an attempt is a title and the meta line, then a section per slot in the carrier\'s order, each with its facts, its whole C string and its source events as the call saw them', async () => {
  const exported = await exportAttempt({ reader: committedReader(), attemptId: 7, t, now: NOW });

  assert.equal(exported, lines([
    '# monitor.object.attempt(epoch=1,ordinal=2) · monitor.status.committed',
    '',
    COMMITTED_LINE.replace('monitor.status.committed · ', ''),
    '',
    '## #1 · monitor.source.user',
    '',
    '- monitor.slot.number: 1',
    '- monitor.slot.seqs: 10',
    '- monitor.slot.source: monitor.source.user',
    '- monitor.slot.sourceType: user/message',
    '- monitor.slot.sourceKind: user',
    '- monitor.slot.visibleCount: monitor.slot.visibleCountValue(visible=1,total=1)',
    '',
    '### Summary',
    '',
    FENCE,
    'asked for work',
    FENCE,
    '',
    '### Sources',
    '',
    '#### seq 10 · user/message',
    '',
    FENCE,
    'please work',
    FENCE,
    '',
    '## #2 · monitor.object.turn(turn=1) · monitor.object.step(step=1)',
    '',
    '- monitor.slot.number: 2',
    '- monitor.slot.seqs: 11, 12, 13',
    '- monitor.slot.turn: 1',
    '- monitor.slot.step: 1',
    '- monitor.slot.source: monitor.source.assistant',
    '- monitor.slot.sourceType: assistant/message',
    '- monitor.slot.sourceKind: model',
    '- monitor.slot.visibleCount: monitor.slot.visibleCountValue(visible=2,total=3)',
    '',
    '### Summary',
    '',
    FENCE,
    'read the file',
    FENCE,
    '',
    '### Sources',
    '',
    '#### seq 11 · assistant/message',
    '',
    FENCE,
    'reading',
    FENCE,
    '',
    'monitor.block.toolCall(name=read)',
    '',
    FENCE,
    '{"file_path":"a.js"}',
    FENCE,
    '',
    '#### seq 13 · tool/result',
    '',
    'monitor.block.toolResult(id=call-1)',
    '',
    FENCE,
    'file pruned',
    FENCE,
    '',
    '## #3 · monitor.object.turn(turn=1) · monitor.object.step(step=2)',
    '',
    '- monitor.slot.number: 3',
    '- monitor.slot.seqs: 14',
    '- monitor.slot.turn: 1',
    '- monitor.slot.step: 2',
    '- monitor.slot.source: monitor.source.other',
    '- monitor.slot.sourceType: user/message',
    '- monitor.slot.sourceKind: monitor.notRecorded',
    '- monitor.slot.visibleCount: monitor.slot.visibleCountValue(visible=1,total=1)',
    '',
    '### Summary',
    '',
    'monitor.slot.empty',
    '',
    '### Sources',
    '',
    '#### seq 14 · user/message',
    '',
    'monitor.block.image',
    '',
    FENCE,
    '{',
    '  "name": "shot.png"',
    '}',
    FENCE,
  ]));
});

test('the reader is asked for the rows once, then the slots of the attempt, then each slot by its key in the list\'s order', async () => {
  const calls = [];
  await exportAttempt({ reader: committedReader(calls), attemptId: 7, t, now: NOW });
  assert.deepEqual(calls, [['rows'], ['slots', 7], ['slot', 7, 10], ['slot', 7, 11], ['slot', 7, 14]]);
});

test('an attempt with no slots is its title and meta line alone', async () => {
  const reader = readerOf({ rows: [COMMITTED], slots: { 7: [] } });
  assert.equal(await exportAttempt({ reader, attemptId: 7, t, now: NOW }), lines([
    '# monitor.object.attempt(epoch=1,ordinal=1) · monitor.status.committed',
    '',
    COMMITTED_LINE.replace('monitor.status.committed · ', ''),
  ]));
});

test('an event the call did not see, a reasoning block, a block of another kind and an event\'s raw JSON are left out, the seq of the unseen event staying in the slot\'s facts', async () => {
  const exported = await exportAttempt({ reader: committedReader(), attemptId: 7, t, now: NOW });

  for (const left of ['INVISIBLE-ORIGINAL', 'seq 12 ·', 'HIDDEN-REASONING', 'HIDDEN-NESTED', 'UNKNOWN-RAW', 'NESTED-UNKNOWN', 'monitor.block.reasoning', 'monitor.block.unknown', 'raw-marker', 'RAW']) {
    assert.equal(exported.includes(left), false, left);
  }
  assert.ok(exported.includes('- monitor.slot.seqs: 11, 12, 13'));
});

test('an error tool result is named an error, and its blocks follow it', async () => {
  const failing = slotDetail(20, 1, {
    events: [eventOf(20, 'tool/result', true, [{ type: 'tool-result', callId: 'call-9', isError: true, blocks: [{ type: 'text', text: 'ENOENT' }] }])],
  });
  const reader = readerOf({ rows: [COMMITTED], slots: { 7: [failing] }, details: { 7: [failing] } });
  const exported = await exportAttempt({ reader, attemptId: 7, t, now: NOW });
  assert.ok(exported.includes(['#### seq 20 · tool/result', '', 'monitor.block.toolError(id=call-9)', '', FENCE, 'ENOENT', FENCE].join('\n')), exported);
});

// ── Fences and whole texts ────────────────────────────────────────────────────

/** How many times the lines of `body` stand in `document` between two lines that are exactly `fence`: a longer fence line is no match. */
function fencedCount(document, fence, body) {
  const lines = document.split('\n');
  const wanted = [fence, ...body.split('\n'), fence];
  let count = 0;
  for (let at = 0; at + wanted.length <= lines.length; at += 1) {
    if (wanted.every((line, offset) => lines[at + offset] === line)) count += 1;
  }
  return count;
}

test('a text is fenced by exactly one backtick more than the longest run of backticks in it, three at least, wherever in the text the run is', async () => {
  const bodies = {
    plain: ['no backticks', FENCE],
    two: ['an `inline` and ``double`` span', FENCE],
    three: [`closes early ${FENCE} here`, LONGER_FENCE],
    mid: [`a\n${FENCE}js\ncode\n${FENCE}\nb`, LONGER_FENCE],
    five: [`x ${'`'.repeat(5)} y`, '`'.repeat(6)],
    lone: ['`', FENCE],
  };
  for (const [name, [body, fence]] of Object.entries(bodies)) {
    const detail = slotDetail(30, 1, { c: body, events: [eventOf(30, 'user/message', true, [{ type: 'text', text: body }, { type: 'tool-call', name: 'run', arguments: body }])] });
    const reader = readerOf({ rows: [COMMITTED], slots: { 7: [detail] }, details: { 7: [detail] } });
    const exported = await exportAttempt({ reader, attemptId: 7, t, now: NOW });
    assert.equal(fencedCount(exported, fence, body), 3, `${name}: the summary, the text block and the tool call arguments are each fenced by ${fence.length}`);
  }
  const image = slotDetail(31, 1, { events: [eventOf(31, 'user/message', true, [{ type: 'image', attachment: { name: `a${FENCE}b` } }])] });
  const exported = await exportAttempt({ reader: readerOf({ rows: [COMMITTED], slots: { 7: [image] }, details: { 7: [image] } }), attemptId: 7, t, now: NOW });
  assert.equal(fencedCount(exported, LONGER_FENCE, `{\n  "name": "a${FENCE}b"\n}`), 1, exported);
});

test('a text of any length is written whole, a C string and a source text alike', async () => {
  const long = Array.from({ length: 40_000 }, (_, at) => `line ${at} of a long text`).join('\n');
  const summary = `${long}\nthe end of the summary`;
  const detail = slotDetail(40, 1, { c: summary, events: [eventOf(40, 'user/message', true, [{ type: 'text', text: long }])] });
  const reader = readerOf({ rows: [COMMITTED], slots: { 7: [detail] }, details: { 7: [detail] } });
  const exported = await exportAttempt({ reader, attemptId: 7, t, now: NOW });
  assert.ok(long.length > 500_000);
  assert.ok(exported.includes(`${FENCE}\n${summary}\n${FENCE}`));
  assert.ok(exported.includes(`${FENCE}\n${long}\n${FENCE}`));
});

// ── Reads that fail ───────────────────────────────────────────────────────────

test('a read that rejects rejects the whole export with that error, whichever read it is, the session\'s too', async () => {
  const boom = new Error('the read failed');
  const base = { rows: [FAILED, COMMITTED], slots: { 7: [ASK, STEP, SHOT] }, details: { 7: [ASK, STEP, SHOT] } };
  const failing = {
    rows: { ...readerOf(base), rows: async () => { throw boom; } },
    slots: { ...readerOf(base), slots: async () => { throw boom; } },
    'the first slot': { ...readerOf(base), slot: async () => { throw boom; } },
    'a later slot': { ...readerOf(base), slot: async (attempt, key) => { if (key === 14) throw boom; return base.details[attempt].find(detail => detail.key === key); } },
  };
  for (const [name, reader] of Object.entries(failing)) {
    await assert.rejects(exportAttempt({ reader, attemptId: 7, t, now: NOW }), error => error === boom, name);
  }
  await assert.rejects(exportSession({ reader: failing.rows, t, now: NOW }), error => error === boom, 'the session');
});

test('an attempt the monitor\'s rows do not list rejects the export, and nothing more is read', async () => {
  const calls = [];
  await assert.rejects(exportAttempt({ reader: committedReader(calls), attemptId: 99, t, now: NOW }), { message: 'the inner monitor holds no attempt 99' });
  assert.deepEqual(calls, [['rows']]);
});

// ── One slot at a time ────────────────────────────────────────────────────────

/** Lets the pending promise callbacks and timers that are already due run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a slot is read after the read of the one before has settled, not alongside it', async () => {
  const events = [];
  const gates = new Map();
  const details = [ASK, STEP, SHOT];
  const reader = {
    ...readerOf({ rows: [COMMITTED], slots: { 7: details } }),
    slot: (attempt, key) => {
      events.push(`start ${key}`);
      return new Promise((resolve) => {
        gates.set(key, () => { events.push(`settle ${key}`); resolve(details.find(detail => detail.key === key)); });
      });
    },
  };

  const exported = exportAttempt({ reader, attemptId: 7, t, now: NOW });
  await settle();
  assert.deepEqual(events, ['start 10'], 'the second slot is not asked for while the first is pending');
  gates.get(10)();
  await settle();
  assert.deepEqual(events, ['start 10', 'settle 10', 'start 11']);
  gates.get(11)();
  await settle();
  assert.deepEqual(events, ['start 10', 'settle 10', 'start 11', 'settle 11', 'start 14']);
  gates.get(14)();
  assert.ok((await exported).includes('## #3 ·'));
});
