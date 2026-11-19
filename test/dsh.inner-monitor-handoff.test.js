// The handoff rows of the inner monitor (`dsh/src/inner-monitor-read.js`): the projection folded over the load messages, the `/sw-continue` checkpoints and the main calls `test/helpers/dsh-events.js` builds, the rows the access answers beside the attempts, and the `handoff` detail read from the log at the seqs the folded facts name.
// The folds of a handoff read no plugin record, so a kit with no record reader stands in for DSH's values and nothing here needs the checkout.
import test from 'node:test';
import assert from 'node:assert/strict';

import { innerMonitorProjection, isMonitorInput, createMonitorAccess, PREVIEW_SOURCE_CHARS } from '../dsh/src/inner-monitor-read.js';
import {
  assistantMessage, compactCheckpoint, continueCheckpoint, innerSealCarrier, loadFollowUp, loadMessage, loadPayload, loadReads, sessionLog, userMessage,
} from './helpers/dsh-events.js';

const kit = { pluginRecordOf: () => undefined };
const projection = innerMonitorProjection(kit);
const fold = events => events.reduce((state, event) => projection.apply(state, event), projection.init());

// DSH's token usage as an `assistant/message` carries it.
const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

const SESSION = 's-handoff';
const NEXT_TASKS = { 7: 'Carry the work on from the second step.', 8: 'The next handoff\'s task.' };

// The access over one session's events, held by the host (its state read from the projection, its log read whole) or stored (state and log from one snapshot); `asked` keeps each handoff id the next-task lookup was given.
function accessOver(events, { held = true, nextTasks = NEXT_TASKS } = {}) {
  const asked = [];
  const nextTaskOf = (handoffId) => { asked.push(handoffId); return nextTasks[handoffId] ?? null; };
  const access = createMonitorAccess({
    sessionOf: id => (held && id === SESSION ? {} : undefined),
    readMonitor: () => fold(events),
    live: () => [],
    kit,
    readSession: async () => ({ events }),
    readStored: async id => (!held && id === SESSION ? { state: fold(events), events } : undefined),
    nextTaskOf,
  });
  return { access, asked };
}
const handoffsOf = async (events, options) => (await accessOver(events, options).access.rows(SESSION)).handoffs;

// A load as `/sw-load` leaves it: the payload, the read message of two files and the follow-up.
const LINEAGE = [{ label: 'S1', headline: 'first work' }, { label: 'S2-S4', omitted: true }, { label: 'S5', headline: 'fifth work' }];
function loaded({ token = 'amber-falcon', payload = {}, reads = true, followUp = true } = {}) {
  const parts = {
    payload: loadPayload({ token, paths: ['/repo/src/a.js', '/repo/src/b.js', '/repo/src/c.js'], skills: ['sw-handoff'], lineage: LINEAGE, ...payload }),
    reads: reads ? loadReads({
      files: [
        { path: '/repo/src/a.js', ranges: [{ offset: 1, limit: 2 }, { offset: 9, limit: 1 }], text: '/repo/src/a.js (total lines: 12)\n1: a\n2: b\n--\n9: i\n' },
        { path: '/repo/src/b.js', ranges: [{ offset: 1, limit: 40 }], text: '/repo/src/b.js (total lines: 1)\n1: x\n' },
      ],
    }) : null,
    followUp: followUp ? loadFollowUp({ token }) : null,
  };
  return { ...parts, events: [parts.payload, parts.reads, parts.followUp].filter(event => event !== null) };
}

test('a load folds to one row whose id is the payload message\'s seq: the type, token, times, epoch, kept, read and skill counts, lineage number, next task and revision, with no context change', async () => {
  const ask = userMessage({ text: 'please work' });
  const call = assistantMessage({ text: 'reply', usage: tokens(100, 20, 300, 40) });
  const load = loaded();
  const log = sessionLog([ask, call, ...load.events]);
  const [payload, , followUp] = log.slice(2);

  assert.deepEqual(await handoffsOf(log), [{
    id: payload.seq,
    revision: followUp.seq,
    type: 'load',
    token: 'amber-falcon',
    time: payload.time,
    createdAt: JSON.parse(payload.data.content[0].text).created_at,
    epoch: 0,
    kept: 3,
    read: 2,
    skills: 1,
    lineage: 6,
    contextChange: null,
    tailSteps: null,
    nextTask: NEXT_TASKS[7],
  }]);
});

test('a load that kept no skills and read no file reads zero skills, a missing read count and no read message, and the next task of a payload with no handoff id is not looked up', async () => {
  const load = loaded({ reads: false, followUp: false, payload: { skills: undefined, handoffId: null, lineage: undefined } });
  const log = sessionLog(load.events);
  const { access, asked } = accessOver(log);

  const { handoffs } = await access.rows(SESSION);

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].skills, 0);
  assert.equal(handoffs[0].read, null);
  assert.equal(handoffs[0].lineage, null);
  assert.equal(handoffs[0].nextTask, null);
  assert.equal(handoffs[0].revision, handoffs[0].id);
  assert.deepEqual(asked, []);
});

test('a load that carries no file list reads a missing kept count, which is no zero', async () => {
  const log = sessionLog([loadPayload({ text: JSON.stringify({ found: true, load_token: 'amber-falcon', summary: 'only the summary' }) })]);

  const [row] = await handoffsOf(log);

  assert.equal(row.kept, null);
  assert.equal(row.skills, 0);
});

test('the next task is looked up by the payload\'s handoff id at the read: a handoff the store lacks shows none, and the text a store returns is cut to the preview limit', async () => {
  const log = sessionLog(loaded({ payload: { handoffId: 99 } }).events);
  assert.equal((await handoffsOf(log))[0].nextTask, null, 'a handoff the store has no row of');

  const long = `${'next task '.repeat(PREVIEW_SOURCE_CHARS)}END`;
  const [row] = await handoffsOf(log, { nextTasks: { 99: long } });
  assert.equal(row.nextTask, long.slice(0, PREVIEW_SOURCE_CHARS));

  const { access, asked } = accessOver(log);
  await access.rows(SESSION);
  await access.rows(SESSION);
  assert.deepEqual(asked, [99, 99], 'each read asks the store afresh');
});

test('a continue is a load behind a checkpoint of /sw-continue that names the payload\'s token: its row holds the context before and after, the epoch the clear opened, and a revision that follows the first main call after it', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'reply', usage: tokens(1000, 200, 5000) });
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: before.seq });
  const load = loaded();
  const first = assistantMessage({ text: 'resumed', usage: tokens(300, 50, 9000, 400) });
  const later = assistantMessage({ text: 'later', usage: tokens(1, 1) });
  const log = sessionLog([ask, before, checkpoint, ...load.events, first, later]);
  const payload = log[3];

  const [row] = await handoffsOf(log);

  assert.equal(row.type, 'continue');
  assert.equal(row.id, payload.seq);
  assert.equal(row.epoch, 1, 'the checkpoint opened the epoch the payload lands in');
  assert.deepEqual(row.contextChange, { before: 6200, after: 9700, delta: 3500, miss: 700 }, 'the last main call\'s stock and output; the first main call\'s stock and uncached tokens');
  assert.equal(row.revision, log[6].seq, 'the first main call after the payload moves the revision, a later one does not');
  assert.equal((await handoffsOf(log.slice(0, 6)))[0].revision, log[5].seq, 'without that call the follow-up\'s seq stands');
});

test('a continue with no main call after it has the context before and nothing after, and a call after it that reports no usage is the call all the same, a later one with usage not filling it', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'reply', usage: tokens(100, 20, 300, 40) });
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: before.seq });
  const load = loaded();
  const silent = assistantMessage({ text: 'no usage' });
  const reporting = assistantMessage({ text: 'next', usage: tokens(500, 1) });
  const log = sessionLog([ask, before, checkpoint, ...load.events, silent, reporting]);

  const waiting = (await handoffsOf(log.slice(0, 6)))[0];
  assert.deepEqual(waiting.contextChange, { before: 460, after: null, delta: null, miss: null });

  const [fixed] = await handoffsOf(log);
  assert.deepEqual(fixed.contextChange, { before: 460, after: null, delta: null, miss: null });
  assert.equal(fixed.revision, log[6].seq);
  assert.equal(fixed.id, log[3].seq);
});

test('a continue with no main call before its payload has no context before, and its change is missing whole', async () => {
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: 0, endSeq: 0 });
  const load = loaded();
  const first = assistantMessage({ text: 'resumed', usage: tokens(300, 50, 9000, 400) });

  const [row] = await handoffsOf(sessionLog([checkpoint, ...load.events, first]));

  assert.equal(row.type, 'continue');
  assert.deepEqual(row.contextChange, { before: null, after: 9700, delta: null, miss: 700 });
});

test('a load records no context before or after, whatever main calls surround it', async () => {
  const before = assistantMessage({ text: 'reply', usage: tokens(100, 20, 300, 40) });
  const load = loaded();
  const after = assistantMessage({ text: 'next', usage: tokens(500, 1) });

  const log = sessionLog([before, ...load.events, after]);

  const [row] = await handoffsOf(log);

  assert.equal(row.type, 'load');
  assert.equal(row.contextChange, null);
  assert.equal(row.revision, log[3].seq, 'a main call after a load moves nothing: the follow-up\'s seq stands');
  const [handoff] = fold(log).handoffs;
  assert.deepEqual([handoff.before, handoff.after], [null, null]);
});

// ── The steps a continue clears ──────────────────────────────────────────────

// A step as the fold counts it: a non-empty main call.
const stepOf = (turn, step) => assistantMessage({ text: `step ${turn}.${step}`, turn, step });

test('a continue row reads the steps after the last carrier that the clear cut off: each non-empty main call, one that only calls a tool included, and neither an empty one nor the steps before the carrier, and later calls move nothing', async () => {
  const ask = userMessage({ text: 'please work' });
  const early = [stepOf(1, 1), stepOf(1, 2)];
  const carrier = innerSealCarrier({ sourceEventSeqs: early.map(event => event.seq), slots: [] });
  const counted = [
    stepOf(1, 3),
    assistantMessage({ toolCalls: [{ id: 'call-1', name: 'read' }], turn: 1, step: 4 }),
    assistantMessage({ usage: tokens(10, 1), turn: 2, step: 1 }),
    stepOf(2, 2),
  ];
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: counted.at(-1).seq });
  const load = loaded();
  const resumed = [stepOf(3, 1), stepOf(3, 2)];
  const log = sessionLog([ask, ...early, carrier, ...counted, checkpoint, ...load.events, ...resumed]);

  const [row] = await handoffsOf(log);

  assert.equal(row.type, 'continue');
  assert.equal(row.tailSteps, 3, 'the text step, the tool call and the last step; the empty call is none and the two steps before the carrier are none');
  assert.equal((await handoffsOf(log.slice(0, log.length - 2)))[0].tailSteps, 3, 'the steps the resumed session takes are no part of it');
});

test('without a carrier the steps are counted from the start of the log, a stock checkpoint starts the count again, and a clear right after one has none', async () => {
  const ask = userMessage({ text: 'please work' });
  const load = loaded();

  const whole = [stepOf(1, 1), stepOf(1, 2)];
  const bare = sessionLog([ask, ...whole, continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: whole.at(-1).seq }), ...load.events]);
  assert.equal((await handoffsOf(bare))[0].tailSteps, 2);

  const before = [stepOf(1, 1), stepOf(1, 2)];
  const stock = compactCheckpoint({ startSeq: ask.seq, endSeq: before.at(-1).seq, text: 'a summary of the work' });
  const after = [stepOf(2, 1)];
  const cleared = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: after.at(-1).seq });
  assert.equal((await handoffsOf(sessionLog([ask, ...before, stock, ...after, cleared, ...load.events])))[0].tailSteps, 1, 'the steps before the stock checkpoint are not the continue\'s');

  const idle = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: ask.seq });
  assert.equal((await handoffsOf(sessionLog([ask, idle, ...load.events])))[0].tailSteps, 0, 'a clear that cut off no step');
});

test('a carrier the monitor reads as no attempt\'s, one with no slots, ends the steps all the same', async () => {
  const ask = userMessage({ text: 'please work' });
  const early = [stepOf(1, 1), stepOf(1, 2)];
  const unreadable = innerSealCarrier({ sourceEventSeqs: early.map(event => event.seq) });
  const after = [stepOf(1, 3)];
  const log = sessionLog([ask, ...early, unreadable, ...after, continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: after[0].seq }), ...loaded().events]);

  assert.equal(unreadable.data.source.slots, undefined, 'the fixture is the unreadable shape');
  assert.equal((await handoffsOf(log))[0].tailSteps, 1);
});

test('each continue reads its own steps: those between the clear before it and the clear of its own, never added up', async () => {
  const ask = userMessage({ text: 'please work' });
  const first = loaded({ token: 'amber-falcon' });
  const second = loaded({ token: 'copper-heron', payload: { handoffId: 8 } });
  const firstTail = [stepOf(1, 1), stepOf(1, 2)];
  const secondTail = [stepOf(2, 1), stepOf(2, 2), stepOf(2, 3)];
  const log = sessionLog([
    ask, ...firstTail, continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: firstTail.at(-1).seq }), ...first.events,
    ...secondTail, continueCheckpoint({ token: 'copper-heron', startSeq: ask.seq, endSeq: secondTail.at(-1).seq }), ...second.events,
  ]);

  const rows = await handoffsOf(log);

  assert.deepEqual(rows.map(row => [row.type, row.tailSteps]), [['continue', 2], ['continue', 3]]);
});

test('a clear whose load failed leaves only its checkpoint, which is no row, and a later load of another token is a load', async () => {
  const ask = userMessage({ text: 'please work' });
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: ask.seq });
  assert.deepEqual(await handoffsOf(sessionLog([ask, checkpoint])), []);

  const other = loaded({ token: 'copper-heron', payload: { handoffId: 8 } });
  const [row] = await handoffsOf(sessionLog([ask, checkpoint, ...other.events]));
  assert.equal(row.type, 'load', 'a checkpoint that names another token makes no continue');
  assert.equal(row.contextChange, null);
  assert.equal(row.tailSteps, null);
  assert.equal(row.nextTask, NEXT_TASKS[8]);
});

test('a checkpoint of a stock compaction after the one of /sw-continue is the nearest checkpoint, so a load of the same token behind it is no continue', async () => {
  const ask = userMessage({ text: 'please work' });
  const cleared = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: ask.seq });
  const stock = compactCheckpoint({ startSeq: ask.seq, endSeq: ask.seq, text: 'a summary of the work' });
  const load = loaded();

  const [row] = await handoffsOf(sessionLog([ask, cleared, stock, ...load.events]));

  assert.equal(row.type, 'load');
  assert.equal(row.contextChange, null);
});

test('a checkpoint of a stock compaction, whose text names no handoff, makes no continue', async () => {
  const ask = userMessage({ text: 'please work' });
  const stock = compactCheckpoint({ startSeq: ask.seq, endSeq: ask.seq, text: 'Handoff token: amber-falcon' });
  const load = loaded();

  const [row] = await handoffsOf(sessionLog([ask, stock, ...load.events]));

  assert.equal(row.type, 'load');
  assert.equal(row.epoch, 1, 'it opened an epoch all the same');
});

test('a payload that is not JSON, not an object or without a token makes no row', async () => {
  const stray = [
    loadPayload({ text: '{"found":true,' }),
    loadPayload({ text: '"found"' }),
    loadPayload({ text: JSON.stringify({ found: true, summary: 'no token' }) }),
  ];

  const rows = await handoffsOf(sessionLog([...loaded().events, ...stray]));

  assert.equal(rows.length, 1);
});

test('the read message and the follow-up attach to the nearest row, the one before the next payload: each of two loads keeps its own read count and revision', async () => {
  const first = loaded({ token: 'amber-falcon' });
  const second = loaded({
    token: 'copper-heron', payload: { handoffId: 8 },
  });
  second.events[1] = loadReads({ files: [{ path: '/repo/src/c.js', ranges: [{ offset: 1, limit: 1 }], text: '/repo/src/c.js (total lines: 1)\n1: c\n' }] });
  const log = sessionLog([...first.events, ...second.events]);

  const rows = await handoffsOf(log);

  assert.deepEqual(rows.map(row => [row.token, row.read, row.revision, row.nextTask]), [
    ['amber-falcon', 2, log[2].seq, NEXT_TASKS[7]],
    ['copper-heron', 1, log[5].seq, NEXT_TASKS[8]],
  ]);
});

test('a read message after the follow-up, a second read message and a follow-up that names another token attach to nothing', async () => {
  const load = loaded({ reads: false });
  const wrongToken = loadFollowUp({ token: 'copper-heron' });
  const late = loadReads();
  const second = loadReads({ files: [{ path: '/repo/src/q.js', ranges: [{ offset: 1, limit: 1 }], text: '/repo/src/q.js (total lines: 1)\n1: q\n' }] });
  const log = sessionLog([load.payload, load.followUp, wrongToken, late, second]);

  const [row] = await handoffsOf(log);

  assert.equal(row.read, null, 'a read message behind the follow-up is no part of the load');
  assert.equal(row.revision, log[1].seq, 'only the follow-up of this token moved the revision');
});

test('a later follow-up that names the same token replaces the earlier one', async () => {
  const load = loaded({ reads: false });
  const again = loadFollowUp({ token: 'amber-falcon', rest: 'Once more.' });
  const log = sessionLog([load.payload, load.followUp, again]);

  const [row] = await handoffsOf(log);

  assert.equal(row.revision, log[2].seq);
});

test('a second read message after the first is not counted, and the read count is the read calls of the message', async () => {
  const load = loaded();
  const again = loadReads();
  const log = sessionLog([load.payload, load.reads, again, load.followUp]);

  const [row] = await handoffsOf(log);

  assert.equal(row.read, 2);
});

test('the lineage number is the greatest position the payload\'s labels name, an omitted run counted by its last, plus one, and none for a lineage with no label', async () => {
  const numberOf = async lineage => (await handoffsOf(sessionLog(loaded({ payload: { lineage } }).events)))[0].lineage;

  assert.equal(await numberOf([{ label: 'S1', headline: 'one' }, { label: 'S3', headline: 'three' }]), 4);
  assert.equal(await numberOf([{ label: 'S2-S5', omitted: true }]), 6, 'a run takes its last position');
  assert.equal(await numberOf([{ label: 'S4', omitted: true }, { label: 'S5', headline: 'five' }]), 6);
  assert.equal(await numberOf([{ label: 'S1-S3', omitted: true }, { label: 'S4', headline: 'four' }, { label: 'S5', headline: 'five' }]), 6);
  assert.equal(await numberOf([{ label: 'S12', headline: 'twelve' }, { label: 'S9', headline: 'nine' }]), 13, 'the greatest, not the last or the count');
  assert.equal(await numberOf([]), null);
  assert.equal(await numberOf(undefined), null);
  assert.equal(await numberOf([{ headline: 'no label' }, { label: 'later' }]), null);
});

test('the state keeps the bounded facts of a handoff: neither its summary, its turn page, its excerpts nor its follow-up text is in it', () => {
  const summary = 'SUMMARY-MARKER '.repeat(200);
  const turnPage = 'PAGE-MARKER notice\n\nS1  locator\n\nS1:4 | U: ask\n     | A: note';
  const load = loaded({ payload: { summary, turnPage } });
  const state = fold(sessionLog([...load.events]));

  const kept = JSON.stringify(state);

  for (const marker of ['SUMMARY-MARKER', 'PAGE-MARKER', 'sw-handoff', 'fifth work', '1: a', 'The harness placed']) assert.equal(kept.includes(marker), false, marker);
  assert.deepEqual(Object.keys(state.handoffs[0]).sort(), [
    'after', 'before', 'createdAt', 'epoch', 'followSeq', 'handoffId', 'id', 'kept', 'lineage', 'read', 'readSeq', 'skills', 'tailSteps', 'time', 'token', 'type',
  ]);
});

test('the state a fold reaches is the state the schema reads back, and a handoff of another shape is refused', () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'reply', usage: tokens(100, 20, 300, 40) });
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: before.seq });
  const load = loaded();
  const first = assistantMessage({ text: 'resumed', usage: tokens(500, 1) });
  const state = fold(sessionLog([ask, before, checkpoint, ...load.events, first]));

  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  assert.equal(state.lastCheckpointToken, 'amber-falcon');
  assert.throws(() => projection.stateSchema.parse({ ...state, handoffs: [{ ...state.handoffs[0], type: 'resume' }] }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, handoffs: [{ ...state.handoffs[0], after: { seq: -1, stock: 1, miss: 1 } }] }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, handoffs: 'none' }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, lastCheckpointToken: 3 }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, handoffs: [{ ...state.handoffs[0], tailSteps: -1 }] }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, lastCheckpointSteps: 'many' }), /inner monitor state/);
  assert.throws(() => projection.stateSchema.parse({ ...state, openSteps: 'many' }), /inner monitor state/);
  const { handoffs, ...without } = state;
  assert.throws(() => projection.stateSchema.parse(without), /inner monitor state/, 'a state persisted before the handoffs is refused');
  const { openSteps, ...uncounted } = state;
  assert.throws(() => projection.stateSchema.parse(uncounted), /inner monitor state/, 'a state without the step count is refused');
});

test('the payload, the read message and the follow-up of a load are signal inputs, while a checkpoint, an ordinary message, a malformed load message and a main call are not', () => {
  const load = loaded();
  for (const event of load.events) assert.equal(isMonitorInput(event), true, event.type);
  for (const event of [
    continueCheckpoint({ token: 'amber-falcon' }), userMessage({ text: 'Handoff is loaded.' }), userMessage({ text: 'ask' }), userMessage({ kind: 'session-watcher-load' }),
    assistantMessage({ text: 'reply' }),
  ]) assert.equal(isMonitorInput(event), false, `${event.type}: ${JSON.stringify(event.data.source ?? null)}`);
});

// ── The handoff detail ───────────────────────────────────────────────────────

const TURN_PAGE = [
  'Historical turns are evidence of what happened.',
  'S1  /logs/first.jsonl',
  'S1:4 | U: first ask\n     | U: second line\n     | A: first note',
  'S1:9 | U: only the user',
  'S2  /logs/second.jsonl',
  'S2:3 | U: newest ask\n     | A: newest note',
  '| U: unaddressed ask\n| A: its note',
].join('\n\n');

function detailLog() {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'reply', usage: tokens(1000, 200, 5000) });
  const checkpoint = continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: before.seq });
  const load = loaded({ payload: { summary: 'The whole summary.\nIn two lines.', turnPage: TURN_PAGE } });
  const first = assistantMessage({ text: 'resumed', usage: tokens(300, 50, 9000, 400) });
  return sessionLog([ask, before, checkpoint, ...load.events, first]);
}

for (const held of [true, false]) {
  test(`the handoff detail of a ${held ? 'held' : 'stored'} session carries its row, the summary whole, the files read with their total lines and the lines each block shows as runs, the lineage as sent, the turn page raw and the turns of its newest lineage member parsed, and the follow-up`, async () => {
    const log = detailLog();
    const { access } = accessOver(log, { held });
    const payloadSeq = log[3].seq;

    const detail = await access.handoff(SESSION, payloadSeq);

    assert.deepEqual(detail, {
      row: (await access.rows(SESSION)).handoffs[0],
      summary: 'The whole summary.\nIn two lines.',
      files: [
        {
          path: '/repo/src/a.js',
          total: 12,
          runs: [{ offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] }, { offset: 9, lines: [{ number: 9, text: 'i' }] }],
        },
        { path: '/repo/src/b.js', total: 1, runs: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] },
      ],
      lineage: LINEAGE,
      turnPage: TURN_PAGE,
      turns: [
        { address: 'S2:3', user: 'newest ask', note: 'newest note' },
        { address: null, user: 'unaddressed ask', note: 'its note' },
      ],
      followUp: 'Handoff "amber-falcon" is loaded. The harness placed two messages before this one.',
    });
    assert.equal(detail.row.type, 'continue');
  });
}

test('the handoff detail of a load with no read message, no turn page, no lineage and no follow-up has no files or turns and nothing to follow', async () => {
  const log = sessionLog(loaded({ reads: false, followUp: false, payload: { lineage: undefined, skills: undefined } }).events);

  const detail = await accessOver(log).access.handoff(SESSION, log[0].seq);

  assert.deepEqual([detail.files, detail.lineage, detail.turnPage, detail.turns, detail.followUp], [[], null, null, [], null]);
});

test('a handoff the monitor holds none of, and a session that is neither held nor stored, answer a rejection and undefined, and a read that cannot be restored from the log rejects', async () => {
  const log = detailLog();
  const payloadSeq = log[3].seq;
  const { access } = accessOver(log);

  await assert.rejects(access.handoff(SESSION, 9999), /holds no handoff 9999/);
  await assert.rejects(access.handoff(SESSION, log[0].seq), /holds no handoff/, 'an address that is no payload');
  assert.equal(await access.handoff('s-nowhere', payloadSeq), undefined);

  // The state the facts name, over a log that lacks what they name.
  const over = events => createMonitorAccess({
    sessionOf: () => ({}), readMonitor: () => fold(log), live: () => [], kit, readSession: async () => ({ events }), readStored: async () => undefined, nextTaskOf: () => null,
  });
  const without = seq => log.filter(event => event.seq !== seq);
  await assert.rejects(over(without(payloadSeq)).handoff(SESSION, payloadSeq), /holds no event at seq/, 'a log without the payload');
  await assert.rejects(over(without(log[4].seq)).handoff(SESSION, payloadSeq), /holds no event at seq/, 'a log without the read message');
  await assert.rejects(over(without(log[5].seq)).handoff(SESSION, payloadSeq), /holds no event at seq/, 'a log without the follow-up');
  const replaced = log.map(event => (event.seq === payloadSeq ? { ...userMessage({ text: 'not a payload' }), seq: payloadSeq } : event));
  await assert.rejects(over(replaced).handoff(SESSION, payloadSeq), /load payload/, 'an event that is no payload at the seq');
});

test('a read call whose arguments do not parse or name no file makes the detail reject, not a degraded one', async () => {
  const load = loaded({ reads: false });
  for (const args of ['{"ranges":[{"offset":1,"limit":1}]}', '{"file_path":5}', '{"file_path":null}', '[]']) {
    const noFile = loadMessage({ calls: [{ id: 'sw-load-0000aaaa-1', name: 'read', arguments: args, text: '/repo/src/a.js (total lines: 1)\n1: a\n' }] });
    const log = sessionLog([load.payload, noFile, load.followUp]);

    await assert.rejects(accessOver(log).access.handoff(SESSION, log[0].seq), /names no file/, args);
  }

  const garbled = loadMessage({ calls: [{ id: 'sw-load-0000aaaa-1', name: 'read', arguments: '{"file_path":', text: 'a\n' }] });
  const garbledLog = sessionLog([load.payload, garbled, load.followUp]);
  await assert.rejects(accessOver(garbledLog).access.handoff(SESSION, garbledLog[0].seq));
});

// Read blocks that are no rendering of a file: the read tool's own envelope under the arguments `{ file_path, offset, limit }`, a header followed by `@@` section marks, and a text with no header.
const OLD_ENVELOPE = { args: { file_path: '/repo/src/old.js', offset: 1, limit: 2 }, text: '<path>/repo/src/old.js</path>\n<type>file</type>\n<content>\n1: a\n2: b\n\n(End of file - total 2 lines)\n</content>\n' };
const SECTION_MARKS = { args: { file_path: '/repo/src/old.js', ranges: [{ offset: 1, limit: 2 }] }, text: '/repo/src/old.js (total lines: 2)\n@@ 1-2 @@\n1: a\n2: b\n' };
const NO_HEADER = { args: { file_path: '/repo/src/old.js', ranges: [{ offset: 1, limit: 2 }] }, text: '/repo/src/old.js\n1: a\n' };

test('a read call whose text is no rendering of a file is a file with no line count and no lines, in the entry every file has, and the files beside it are unaffected: the read tool\'s envelope with its own arguments, section marks, no header', async () => {
  for (const [why, { args, text }] of Object.entries({ OLD_ENVELOPE, SECTION_MARKS, NO_HEADER })) {
    const bad = { id: 'sw-load-0000aaaa-1', name: 'read', arguments: JSON.stringify(args), text };
    const good = { id: 'sw-load-0000aaaa-2', name: 'read', arguments: JSON.stringify({ file_path: '/repo/src/b.js', ranges: [{ offset: 1, limit: 1 }] }), text: '/repo/src/b.js (total lines: 1)\n1: x\n' };
    const load = loaded({ reads: false });
    const log = sessionLog([load.payload, loadMessage({ calls: [bad, good] }), load.followUp]);

    const { files } = await accessOver(log).access.handoff(SESSION, log[0].seq);

    assert.deepEqual(files, [
      { path: '/repo/src/old.js', total: null, runs: [] },
      { path: '/repo/src/b.js', total: 1, runs: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] },
    ], why);
  }
});
