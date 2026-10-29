// test/turn-read-service.test.js — the turn read service both hosts hand their read tools: lineage from the newest delivery into the session, the page through the injected builder, the headlines of chosen lineage positions, and the recovery each failure answers with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnReadService } from '../lib/turn-read-service.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import {
  NO_HANDOFF_LOADED, STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE, UNUSABLE_POSITIONS_MESSAGE,
  withPageRecovery, withSearchRecovery, withLocateRecovery, withHeadlinesRecovery,
} from '../lib/turn-tool-recovery.js';
import { estimateWireTokens } from '../lib/turn-history-budget.js';
import { DEFAULT_CTP, HANDOFF_MAX_NEXT_TASK_CHARS, LINEAGE_HEADLINE_TOKEN_BUDGET } from '../lib/constants.js';
import { assistantToolUse, chain, observationsOf, toolResult, ts, userMessage } from './helpers/transcript-fixtures.js';

const RECOVERY = { notice: 'notice', searchHit: 'search hit', locateHit: 'locate hit' };
const NO_SOURCE = { read: async () => ({ status: 'unavailable', observations: [] }) };

// One delivered handoff heading a one-session lineage: the reads the lineage walk makes, and nothing else.
// It is prepared after the fixture Sources' last row, so its window holds every turn of a Source.
function deliveredStore() {
  return {
    findLatestDeliveryInSession: () => ({ handoffId: 7 }),
    getHandoff: (id) => (id === 7
      ? { handoffId: 7, projectId: 'p', sessionId: 's-a', transcriptPath: '/t/a.jsonl',
        createdAt: Date.parse('2026-07-02T00:00:00Z') }
      : null),
    findParentDelivery: () => null,
  };
}

// A delivered handoff heading a three-session lineage, s-a then s-b then s-c, labelled S1 to S3. Only the
// reads the lineage walk and the headline projection make: a member's headline is the next task of the
// handoff its predecessor produced and the root's is its own opening, so the head handoff's task is nobody's.
// Two next tasks of the cap's length cost more than the headline budget, so an answer that holds both whole
// is not the bounded list a load carries.
const longTask = (tag) => tag + '字'.repeat(HANDOFF_MAX_NEXT_TASK_CHARS - tag.length);
const handoffRow = (handoffId, sessionId, day, nextTask) => ({
  handoffId, projectId: 'p', sessionId, transcriptPath: `/t/${sessionId}.jsonl`,
  createdAt: Date.parse(`2026-07-0${day}T00:00:00Z`), nextTask,
});
const HANDOFFS = {
  5: handoffRow(5, 's-a', 1, longTask('二')),
  6: handoffRow(6, 's-b', 2, longTask('三')),
  7: handoffRow(7, 's-c', 3, 'task of the session after the lineage'),
};
const noteRow = (turnNoteId, uText) => ({ turnNoteId, uText, note: 'noted', sourceTimestamp: 1 });
const ROWS = { 's-a': [noteRow(1, 'first ask')], 's-b': [noteRow(2, 'second ask')], 's-c': [noteRow(3, 'third ask')] };

function lineageStore({ rows = ROWS, ...over } = {}) {
  return {
    findLatestDeliveryInSession: () => ({ handoffId: 7 }),
    getHandoff: (id) => HANDOFFS[id] ?? null,
    findParentDelivery: (_project, sessionId) => ({ 's-c': HANDOFFS[6], 's-b': HANDOFFS[5] })[sessionId] ?? null,
    listTurnNotes: (sessionId) => rows[sessionId] ?? [],
    ...over,
  };
}

function service(over = {}) {
  return createTurnReadService({
    store: () => deliveredStore(),
    sessionId: () => 'sid',
    dialogueSource: NO_SOURCE,
    dialogueProjection: {},
    recovery: RECOVERY,
    turnPageBuilder: async () => { throw new Error('builder not expected'); },
    ...over,
  });
}

test('an empty lineage answers no_handoff_loaded on every read', async () => {
  const asked = [];
  const reads = service({
    store: () => ({ findLatestDeliveryInSession: (sid) => { asked.push(sid); return null; } }),
  });
  assert.deepEqual(await reads.turnPage({}), NO_HANDOFF_LOADED);
  assert.deepEqual(await reads.turnSearch({ q: 'x' }), NO_HANDOFF_LOADED);
  assert.deepEqual(await reads.turnLocate({ q: 'x' }), NO_HANDOFF_LOADED);
  assert.deepEqual(await reads.lineageHeadlines({ k: '1' }), NO_HANDOFF_LOADED);
  assert.deepEqual(asked, ['sid', 'sid', 'sid', 'sid'], 'each read resolves the lineage of the session the thunk names');
});

test('turnPage rethrows a stale cursor with its recovery message', async () => {
  const reads = service({
    turnPageBuilder: async () => { throw Object.assign(new Error('not_found'), { code: 'not_found' }); },
  });
  await assert.rejects(() => reads.turnPage({ before: 'S1:99' }), { message: STALE_CURSOR_MESSAGE });
});

test('turnSearch rethrows an absent scope with its recovery message', async () => {
  await assert.rejects(() => service().turnSearch({ q: 'x', scope: 'S9:1' }), { message: SCOPE_ABSENT_MESSAGE });
});

test('turnSearch matches the result of any tool pair', async () => {
  // One Source holding one tool pair.
  const observations = observationsOf(chain([
    userMessage({ uuid: 'u-1', text: 'ask', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a-1', messageId: 'm-1', toolUseId: 'tu-1', name: 'Bash',
      input: { command: 'ls' }, timestamp: ts(2) }),
    toolResult({ uuid: 'r-1', toolUseId: 'tu-1', content: 'bash-output-literal' }),
  ]));
  const found = await service({
    store: () => ({ ...deliveredStore(), listTurnNotes: () => [] }),
    dialogueSource: { read: async () => ({ status: 'ok', observations }) },
    dialogueProjection: createClaudeCodeDialogueProjection(),
  }).turnSearch({ q: 'bash-output-literal' });
  assert.equal(found.found, true);
});

test('a failing store answers the retryable recovery results', async () => {
  const reads = service({ store: () => ({ findLatestDeliveryInSession: () => { throw new Error('database is locked'); } }) });
  assert.deepEqual(await reads.turnPage({}), withPageRecovery({ error: 'turn_page_unavailable', retryable: true }));
  assert.deepEqual(await reads.turnSearch({ q: 'x' }), withSearchRecovery({ error: 'search_unavailable' }));
  assert.deepEqual(await reads.turnLocate({ q: 'x' }), withLocateRecovery({ error: 'locate_unavailable' }));
  assert.deepEqual(await reads.lineageHeadlines({ k: '1' }),
    withHeadlinesRecovery({ error: 'lineage_headlines_unavailable', retryable: true }));
});

// ── lineageHeadlines ───────────────────────────────────────────────────────────

const headlines = (over) => service({ store: () => lineageStore(over) });

test('lineageHeadlines answers no_handoff_loaded whatever k is, even an undefined one', async () => {
  const reads = service({ store: () => ({ findLatestDeliveryInSession: () => null }) });
  for (const k of ['1', '1,3', '2-5', 'S3', '', '1,,2', undefined]) {
    assert.deepEqual(await reads.lineageHeadlines({ k }), NO_HANDOFF_LOADED, String(k));
  }
  assert.deepEqual(await reads.lineageHeadlines(), NO_HANDOFF_LOADED);
});

test('lineageHeadlines answers the complete headlines of the positions it is given, with no recovery', async () => {
  assert.deepEqual(await headlines().lineageHeadlines({ k: '1,3' }), {
    lineage: [
      { label: 'S1', headline: 'first ask' },
      { label: 'S3', headline: HANDOFFS[6].nextTask },
    ],
  });
});

test('lineageHeadlines is not bounded: it answers the entries a load would have collapsed', async () => {
  const answer = await headlines().lineageHeadlines({ k: '1-3' });
  assert.deepEqual(answer.lineage.map(({ label }) => label), ['S1', 'S2', 'S3']);
  assert.deepEqual(answer.lineage.map(({ headline }) => headline),
    ['first ask', HANDOFFS[5].nextTask, HANDOFFS[6].nextTask]);
  assert.ok(estimateWireTokens(answer, DEFAULT_CTP) > LINEAGE_HEADLINE_TOKEN_BUDGET);
});

test('lineageHeadlines throws the one positions sentence for a position the lineage lacks', async () => {
  const reads = headlines();
  for (const k of ['4', '3-4', '1,9', '1-99999999999999']) {
    await assert.rejects(() => reads.lineageHeadlines({ k }), { message: UNUSABLE_POSITIONS_MESSAGE }, k);
  }
  // A session whose window holds no rows keeps its label but has no entry, so its position is a gap.
  const gapped = headlines({ rows: { ...ROWS, 's-b': [] } });
  assert.deepEqual((await gapped.lineageHeadlines({ k: '1,3' })).lineage.map(({ label }) => label), ['S1', 'S3']);
  for (const k of ['2', '1-3', '2-3']) {
    await assert.rejects(() => gapped.lineageHeadlines({ k }), { message: UNUSABLE_POSITIONS_MESSAGE }, k);
  }
});

test('lineageHeadlines throws the same sentence for a k that breaks the grammar, before it reads any turn note', async () => {
  const reads = headlines({ listTurnNotes: () => { throw new Error('turn notes are not read for a malformed k'); } });
  for (const k of ['', 'S1', '0', '03', '3-2', '1,,2', '1 - 2', undefined, 3]) {
    await assert.rejects(() => reads.lineageHeadlines({ k }), { message: UNUSABLE_POSITIONS_MESSAGE }, String(k));
  }
  await assert.rejects(() => reads.lineageHeadlines(), { message: UNUSABLE_POSITIONS_MESSAGE });
});

test('lineageHeadlines answers a retryable unavailable result when the store fails', async () => {
  const expected = withHeadlinesRecovery({ error: 'lineage_headlines_unavailable', retryable: true });
  assert.equal(expected.retryable, true);
  assert.equal(typeof expected.recovery, 'string');
  assert.ok(expected.recovery.length > 0);
  const thrown = (message) => () => { throw new Error(message); };
  // The delivery lookup fails before the lineage resolves; the turn-note read fails only after it has.
  for (const over of [
    { findLatestDeliveryInSession: thrown('database is locked') },
    { listTurnNotes: thrown('database is locked') },
  ]) {
    assert.deepEqual(await headlines(over).lineageHeadlines({ k: '1' }), expected, Object.keys(over)[0]);
  }
});
