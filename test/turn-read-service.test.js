// test/turn-read-service.test.js — the turn read service both hosts hand their read tools: lineage from the newest delivery into the session, the page through the injected builder, and the recovery each failure answers with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnReadService } from '../lib/turn-read-service.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import {
  NO_HANDOFF_LOADED, STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE,
  withPageRecovery, withSearchRecovery, withLocateRecovery,
} from '../lib/turn-tool-recovery.js';
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

test('an empty lineage answers no_handoff_loaded on all three reads', async () => {
  const asked = [];
  const reads = service({
    store: () => ({ findLatestDeliveryInSession: (sid) => { asked.push(sid); return null; } }),
  });
  assert.deepEqual(await reads.turnPage({}), NO_HANDOFF_LOADED);
  assert.deepEqual(await reads.turnSearch({ q: 'x' }), NO_HANDOFF_LOADED);
  assert.deepEqual(await reads.turnLocate({ q: 'x' }), NO_HANDOFF_LOADED);
  assert.deepEqual(asked, ['sid', 'sid', 'sid'], 'each read resolves the lineage of the session the thunk names');
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
});
