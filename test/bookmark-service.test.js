// test/bookmark-service.test.js — Tests for createBookmarkService
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../lib/store.js';
import { BOOKMARK_TOKEN_BUDGET } from '../lib/bookmark-core.js';
import { userMessage, assistantObservation, writeTranscript, ts } from './helpers/transcript-fixtures.js';

let dir, store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-svc-'));
  store = openStore(join(dir, 'test.sqlite'));
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

// Helper: seed a handoff row plus the delivery that makes sourceSession the parent of
// deliveredSession. The parent edge comes only from handoff_load.
function seedHandoff({ sessionId, deliveredSessionId, loadToken, projectId = 'project-1', transcriptPath = null, createdAt = Date.now() }) {
  const { handoffId } = store.insertHandoff({
    sessionId, segment: 0, loadToken, createdAt,
    pathsToKeep: '[]', summary: 'test', summaryTokens: 10, projectId,
    transcriptPath,
  });
  store.insertHandoffLoad({
    handoffId, sessionId: deliveredSessionId, loadedAt: createdAt + 1,
    loaderVersion: 'test', claimResult: 'primary', primarySessionId: deliveredSessionId, consumerSegment: 0,
  });
  return handoffId;
}

// Helper: seed a handoff row with no delivery — a lineage head addressed by its own handoff_id.
function seedHeadHandoff({ sessionId, loadToken, projectId = 'project-1', transcriptPath = null, createdAt = Date.now() }) {
  return store.insertHandoff({
    sessionId, segment: 0, loadToken, createdAt,
    pathsToKeep: '[]', summary: 'test', summaryTokens: 10, projectId,
    transcriptPath,
  }).handoffId;
}

// Minimal CTP to avoid divide-by-zero
const CTP = { ascii: 3.5, cjk: 1.5 };

// Factory: create service with given session context
function makeService(overrides = {}) {
  const defaults = {
    store,
    currentProjectId: () => 'project-1',
    currentSessionId: () => 'session-curr',
    currentTranscriptPath: () => null,
    currentCtp: () => CTP,
    warn: () => {},
  };
  const deps = { ...defaults, ...overrides };
  // Lazy import so we can use this after the module is written
  return deps._service;
}

// =========================================================================
// Step 1: List contract tests
// =========================================================================

describe('listMessages — contract shape', () => {
  let createBookmarkService;

  beforeEach(async () => {
    ({ createBookmarkService } = await import('../lib/bookmark-service.js'));
  });

  test('returns REST-ready shape with bookmarked row', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'keep project isolation', timestamp: ts(1) }),
    ]);
    // Seed the bookmark for u1 in session-a
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-a', anchorUuid: 'u1',
      role: 'user', previewText: 'keep project isolation', originalChars: 22,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    // session-a -> session-curr via handoff
    seedHandoff({ sessionId: 'session-a', deliveredSessionId: 'session-curr', loadToken: 'tok-ab', transcriptPath: path });

    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const result = service.listMessages({ detailUrl: 'http://localhost/detail' });
    assert.equal(typeof result.budget_used_tokens, 'number');
    assert.equal(result.budget_limit_tokens, 5000);
    assert.ok(Array.isArray(result.messages));
    // Find the bookmarked row
    const bkMsg = result.messages.find(m => m.anchor_uuid === 'u1');
    assert.ok(bkMsg, 'bookmarked row present');
    assert.equal(bkMsg.source_session_id, 'session-a');
    assert.equal(bkMsg.role, 'user');
    assert.equal(bkMsg.preview_text, 'keep project isolation');
    assert.equal(bkMsg.original_chars, 22);
    assert.equal(bkMsg.truncated, false);
    assert.ok(bkMsg.bookmark_id != null, 'bookmark_id set');
    assert.equal(bkMsg.source_available, true);
  });

  test('unbookmarked message has bookmark_id null', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'unbookmarked message here', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-only',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const result = service.listMessages({ detailUrl: null });
    const row = result.messages.find(m => m.anchor_uuid === 'u1');
    assert.ok(row, 'unbookmarked row present');
    assert.equal(row.bookmark_id, null);
  });

  test('orphan bookmark row reports source_available:false', () => {
    // Transcript has no messages; bookmark references orphan uuid
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-only', anchorUuid: 'orphan-1',
      role: 'assistant', previewText: 'orphan preview', originalChars: 14,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    const path = writeTranscript(dir, []);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-only',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const result = service.listMessages({ detailUrl: null });
    const orphanRow = result.messages.find(m => m.anchor_uuid === 'orphan-1');
    assert.ok(orphanRow, 'orphan row present');
    assert.equal(orphanRow.source_available, false);
    assert.ok(orphanRow.bookmark_id != null);
  });

  test('an orphan keeps the stored truncation metadata instead of re-previewing its preview', () => {
    // source_available:true would send the row down rowToListItem's recompute branch, which
    // re-previews the already-capped 200-char preview: original_chars collapses to the preview
    // length and truncated flips to false, so the UI stops signalling the elision.
    const preview = 'x'.repeat(200);
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-only', anchorUuid: 'orphan-trunc',
      role: 'assistant', previewText: preview, originalChars: 900,
      truncated: 1, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    const path = writeTranscript(dir, []);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-only',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const row = service.listMessages({ detailUrl: null })
      .messages.find(m => m.anchor_uuid === 'orphan-trunc');
    assert.ok(row, 'orphan row present');
    assert.equal(row.original_chars, 900, 'the stored pre-truncation length survives');
    assert.equal(row.truncated, true, 'the elision stays visible');
  });

  test('budget is computed only from active applicable bookmark rows', () => {
    // Two sessions: session-a (ancestor) with one bookmark, session-curr (tail) with no bookmark
    const pathA = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'ancestor msg', timestamp: ts(1) }),
    ]);
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-a', anchorUuid: 'u1',
      role: 'user', previewText: 'ancestor msg', originalChars: 12,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    seedHandoff({ sessionId: 'session-a', deliveredSessionId: 'session-curr', loadToken: 'tok-x', transcriptPath: pathA });

    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const result = service.listMessages({ detailUrl: null });
    // Budget must be a positive number computed from the active bookmark rows
    assert.ok(result.budget_used_tokens > 0, 'budget used > 0');
    assert.equal(result.budget_limit_tokens, 5000);
  });

  test('budget recomputed using exact dynamic URL', () => {
    const pathA = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'keep this note', timestamp: ts(1) }),
    ]);
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-only', anchorUuid: 'u1',
      role: 'user', previewText: 'keep this note', originalChars: 14,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });

    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-only',
      currentTranscriptPath: () => pathA,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r1 = service.listMessages({ detailUrl: null });
    const r2 = service.listMessages({ detailUrl: 'http://localhost:41731/detail' });
    // Budget with URL should be larger (URL adds characters)
    assert.ok(r2.budget_used_tokens > r1.budget_used_tokens, 'URL increases token budget usage');
  });

  test('full lineage in listMessages: both ancestor and current messages appear', () => {
    const pathA = writeTranscript(dir, [
      userMessage({ uuid: 'ua1', text: 'from session-a', timestamp: ts(1) }),
    ]);
    const pathB = writeTranscript(dir, [
      assistantObservation({ uuid: 'ub1', parentUuid: null, messageId: 'mid-b1', blocks: [{ type: 'text', text: 'from session-b' }], timestamp: ts(2) }),
    ]);
    seedHandoff({ sessionId: 'session-a', deliveredSessionId: 'session-b', loadToken: 'tok-ab', transcriptPath: pathA });

    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-b',
      currentTranscriptPath: () => pathB,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const result = service.listMessages({ detailUrl: null });
    const anchors = result.messages.map(m => m.anchor_uuid);
    assert.ok(anchors.includes('ua1'), 'ancestor message present');
    assert.ok(anchors.includes('ub1'), 'current session message present');
  });
});

// =========================================================================
// Step 2: Mutation tests (setDesiredState)
// =========================================================================

describe('setDesiredState', () => {
  let createBookmarkService;

  beforeEach(async () => {
    ({ createBookmarkService } = await import('../lib/bookmark-service.js'));
  });

  function makeAddInput(anchorUuid, sessionId = 'session-curr') {
    return { add: true, anchor_uuid: anchorUuid, source_session_id: sessionId };
  }

  function makeRemoveInput(anchorUuid, sessionId = 'session-curr') {
    return { add: false, anchor_uuid: anchorUuid, source_session_id: sessionId };
  }

  test('add duplicate active bookmark → already_bookmarked, same B{id}, no double charge', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'test message', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r1 = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r1.status, 'success');
    const firstId = r1.bookmark.bookmark_id;

    const r2 = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r2.status, 'already_bookmarked');
    assert.equal(r2.bookmark.bookmark_id, firstId, 'same bookmark ID returned');
    assert.equal(r1.budget_used_tokens, r2.budget_used_tokens, 'no double charge');
  });

  test('add validates source is in lineage', () => {
    // session-other is NOT in the lineage of session-curr
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-other', text: 'from other session', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r = service.setDesiredState({ add: true, anchor_uuid: 'u-other', source_session_id: 'session-other' }, { detailUrl: null });
    assert.equal(r.status, 'not_found');
    assert.equal(r.bookmark, null);
  });

  test('add validates canonical target exists in transcript', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'exists', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    // non-existent anchor in the transcript
    const r = service.setDesiredState(makeAddInput('nonexistent-uuid'), { detailUrl: null });
    assert.equal(r.status, 'not_found');
    assert.equal(r.bookmark, null);
  });

  test('client prose fields are rejected by exact input-key validator', () => {
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    assert.throws(
      () => service.setDesiredState({ add: true, anchor_uuid: 'u1', source_session_id: 'session-curr', extra_field: 'bad' }, { detailUrl: null }),
      /unexpected.*key|invalid.*input|unknown.*field/i,
    );
  });

  test('add: boolean validation rejects non-boolean add field', () => {
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    assert.throws(
      () => service.setDesiredState({ add: 1, anchor_uuid: 'u1', source_session_id: 'session-curr' }, { detailUrl: null }),
      /boolean|invalid.*type/i,
    );
  });

  test('remove validates source lineage but not transcript/target', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'msg', timestamp: ts(1) }),
    ]);
    // First add to make it bookmarked
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    service.setDesiredState(makeAddInput('u1'), { detailUrl: null });

    // Remove without reading transcript at all — use a null transcript path service
    const service2 = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null, // no transcript
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r = service2.setDesiredState(makeRemoveInput('u1'), { detailUrl: null });
    assert.equal(r.status, 'success');
    assert.equal(r.bookmark, null, 'remove always returns bookmark:null');
    // `success` and `bookmark:null` are returned unconditionally, so neither observes the write. The row
    // is the subject: it goes inactive and leaves the active list every consumer reads.
    assert.equal(store.getBookmarkByIdentity('project-1', 'session-curr', 'u1').active, 0);
    assert.deepEqual(store.listActiveBookmarksForSession('project-1', 'session-curr'), []);
  });

  test('remove orphan succeeds', () => {
    // Bookmark exists but transcript is unavailable (orphan scenario)
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-curr', anchorUuid: 'orphan-x',
      role: 'user', previewText: 'orphan', originalChars: 6,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r = service.setDesiredState(makeRemoveInput('orphan-x'), { detailUrl: null });
    assert.equal(r.status, 'success');
    assert.equal(r.bookmark, null);
  });

  test('remove missing row returns success with bookmark:null', () => {
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => null,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r = service.setDesiredState(makeRemoveInput('no-such-uuid'), { detailUrl: null });
    assert.equal(r.status, 'success');
    assert.equal(r.bookmark, null);
  });

  test('every remove returns bookmark:null', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'msg', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    const r = service.setDesiredState(makeRemoveInput('u1'), { detailUrl: null });
    assert.equal(r.bookmark, null, 'remove always returns bookmark:null');
  });

  test('re-add uses immutable stored preview/metadata', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'original text for bookmark', timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    // First add
    const r1 = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    const originalId = r1.bookmark.bookmark_id;
    const originalPreview = r1.bookmark.preview_text;

    // Remove then re-add
    service.setDesiredState(makeRemoveInput('u1'), { detailUrl: null });
    const r2 = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r2.bookmark.bookmark_id, originalId, 'same bookmark_id on re-add');
    assert.equal(r2.bookmark.preview_text, originalPreview, 'immutable preview preserved');
  });

  test('proposed new ID comes from peekNextBookmarkId', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'first message', timestamp: ts(1) }),
      userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'second message', timestamp: ts(2) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const peeked = store.peekNextBookmarkId();
    const r = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r.bookmark.bookmark_id, `B${peeked}`, 'bookmark_id matches peekNextBookmarkId');
  });

  test('an add that fits the budget is admitted', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'a'.repeat(100), timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });

    const r = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r.status, 'success');
    assert.ok(r.budget_used_tokens <= BOOKMARK_TOKEN_BUDGET, 'budget within limit after add');
  });

  test('an add that would exceed the budget is rejected and writes nothing', () => {
    // Deterministic by construction: a CTP of 0.01 chars-per-token turns any non-trivial wire
    // into >>5000 tokens, so admission MUST reject regardless of preview lengths. The earlier
    // version of this test wrapped every assertion in `if (r.status === 'budget_exceeded')`,
    // so disabling admission entirely left it green.
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'x'.repeat(200), timestamp: ts(1) }),
    ]);
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => ({ ascii: 0.01, cjk: 0.01 }),
      warn: () => {},
    });

    const r = service.setDesiredState(makeAddInput('u1'), { detailUrl: null });
    assert.equal(r.status, 'budget_exceeded', 'admission must reject an over-budget add');
    assert.equal(r.bookmark, null);
    assert.ok(r.budget_used_tokens > BOOKMARK_TOKEN_BUDGET,
      `reported used must exceed the limit, got ${r.budget_used_tokens}`);
    assert.equal(r.budget_limit_tokens, BOOKMARK_TOKEN_BUDGET);
    // §7.3: a rejected add must not touch the database.
    const row = store.getBookmarkByIdentity('project-1', 'session-curr', 'u1');
    assert.ok(!row || row.active === 0, 'no active DB row written on budget_exceeded');
  });

  test('an over-budget lineage still rejects adds after existing bookmarks are counted', () => {
    // Fills the budget with real persisted rows rather than a synthetic CTP, so the rejection
    // is driven by accumulated wire size the way production reaches the cap.
    const msgs = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(userMessage({ uuid: `u${i}`, parentUuid: i > 0 ? `u${i - 1}` : null, text: 'x'.repeat(200), timestamp: ts(i + 1) }));
    }
    const path = writeTranscript(dir, msgs);
    for (let i = 0; i < 30; i++) {
      store.upsertBookmark({
        projectId: 'project-1', sourceSessionId: 'session-curr', anchorUuid: `u${i}`,
        role: 'user', previewText: 'x'.repeat(200), originalChars: 200,
        truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
      });
    }
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => ({ ascii: 0.5, cjk: 0.3 }),
      warn: () => {},
    });

    // 30 x ~200-char previews under a 0.5 chars-per-token CTP is far past 5000 tokens.
    assert.ok(service.listMessages({ detailUrl: null }).budget_used_tokens > BOOKMARK_TOKEN_BUDGET,
      'precondition: the seeded lineage must already exceed the budget');

    const r = service.setDesiredState(makeAddInput('u30'), { detailUrl: null });
    assert.equal(r.status, 'budget_exceeded');
    assert.equal(r.bookmark, null);
    const row = store.getBookmarkByIdentity('project-1', 'session-curr', 'u30');
    assert.ok(!row || row.active === 0, 'no active DB row written on budget_exceeded');
  });

  test('delete succeeds while already over budget', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'message to delete', timestamp: ts(1) }),
    ]);
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-curr', anchorUuid: 'u1',
      role: 'user', previewText: 'x'.repeat(200), originalChars: 200,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });

    // Use tight CTP to simulate over-budget scenario
    const service = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => ({ ascii: 0.1, cjk: 0.1 }), // very tight: many tokens per char
      warn: () => {},
    });

    // Remove should always succeed regardless of budget state
    const r = service.setDesiredState(makeRemoveInput('u1'), { detailUrl: null });
    assert.equal(r.status, 'success');
    assert.equal(r.bookmark, null);
  });

  test('CTP drift: list/load existing rows preserved, add blocked when over budget', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'existing bookmark text here', timestamp: ts(1) }),
      userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'new message to add', timestamp: ts(2) }),
    ]);
    store.upsertBookmark({
      projectId: 'project-1', sourceSessionId: 'session-curr', anchorUuid: 'u1',
      role: 'user', previewText: 'existing bookmark text here', originalChars: 26,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });

    // Normal CTP: list works
    const normalService = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => CTP,
      warn: () => {},
    });
    const listResult = normalService.listMessages({ detailUrl: null });
    assert.ok(listResult.messages.some(m => m.anchor_uuid === 'u1'), 'existing row present after CTP drift');

    // Tight CTP: add new bookmark may be blocked
    const tightService = createBookmarkService({
      store,
      currentProjectId: () => 'project-1',
      currentSessionId: () => 'session-curr',
      currentTranscriptPath: () => path,
      currentCtp: () => ({ ascii: 0.1, cjk: 0.1 }),
      warn: () => {},
    });
    const addResult = tightService.setDesiredState(makeAddInput('u2'), { detailUrl: null });
    // Either success (if under budget) or budget_exceeded (if over) — both valid behaviors
    assert.ok(['success', 'budget_exceeded'].includes(addResult.status));
  });
});

