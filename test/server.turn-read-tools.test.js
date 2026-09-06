import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTestServer } from './helpers/server-boot.js';
import { _seedDeliveredHandoff } from './helpers/handoff-seed.js';
import { writeTranscript, userMessage, assistantObservation, ts } from './helpers/transcript-fixtures.js';
import { STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE } from '../lib/turn-tool-recovery.js';

describe('turn read tools', () => {
  let ctx, loadToken, handoffId, dir;
  const sessionId = 'sid-read-tools';
  const sourceSessionId = 'session-read-tools-src';

  const seed = (store, opts) => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: opts.uuid, text: opts.literal, timestamp: ts(1) }),
      assistantObservation({ uuid: `a-${opts.uuid}`, parentUuid: opts.uuid, messageId: `m-${opts.uuid}`,
        timestamp: ts(2), blocks: [{ type: 'text', text: 'read tools evidence' }] }),
    ]);
    const id = _seedDeliveredHandoff(store, {
      sessionId, sourceSessionId: opts.sourceSessionId, loadToken: opts.loadToken,
      transcriptPath: path, ...(opts.projectId ? { projectId: opts.projectId } : {}),
    });
    store.upsertTurnNotes([{
      sourceSessionId: opts.sourceSessionId, anchorUuid: opts.uuid,
      uText: opts.literal, uOriginalChars: opts.literal.length,
      note: 'read tools evidence', searchTerms: `${opts.literal} read tools evidence`,
      sourceTimestamp: Date.parse(ts(1)),
    }]);
    return id;
  };

  before(async () => {
    ctx = await bootTestServer({ sessionId });
    dir = mkdtempSync(join(tmpdir(), 'sw-read-tools-'));
    loadToken = 'tok-read-tools';
    handoffId = seed(ctx.store, { uuid: 'u-rt-0', literal: 'turn9data', sourceSessionId, loadToken });

    // The delivery ROW is what makes the head resolvable without a parameter: findLatestDeliveryInSession
    // joins handoff_load, and only a real load inserts into it. This mirrors production exactly.
    await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
  });

  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('turn_page equals curling the HTTP route with the resolved head', async () => {
    const viaTool = ctx.turnReadService.turnPage({});
    const viaHttp = await ctx.request(`/api/turn/page?lineage_head=${handoffId}`, {});
    assert.deepEqual(viaTool, viaHttp);
  });

  test('turn_search equals the HTTP route plus exactly one recovery field', async () => {
    const viaTool = ctx.turnReadService.turnSearch({ q: 'turn9data' });
    const viaHttp = await ctx.request(`/api/turn/search?lineage_head=${handoffId}&q=turn9data`, {});
    const { recovery, ...rest } = viaTool;
    assert.deepEqual(rest, viaHttp);
    assert.match(recovery, /transcript_path/);
    // Both surfaces resolve their own store, and a group's address is the only part of the wire that
    // comes from it — a store the surface failed to wire throws inside projectSession's listTurnNotes
    // read, so that surface answers 503 and never reaches these two fields at all.
    assert.equal(viaHttp.ranges[0].scope, 'S1:1');
    assert.equal(viaHttp.ranges[0].note, 'read tools evidence');
  });

  test('turn_locate equals the HTTP route plus exactly one recovery field', async () => {
    const viaTool = ctx.turnReadService.turnLocate({ q: 'turn9data' });
    const viaHttp = await ctx.request(`/api/turn/locate?lineage_head=${handoffId}&q=turn9data`, {});
    const { recovery, ...rest } = viaTool;
    assert.deepEqual(rest, viaHttp);
    // Only the found:true sentence hands a scope on to turn_search, so this keeps the deepEqual above
    // comparing two populated responses rather than two misses.
    assert.match(recovery, /turn_search/);
  });

  // Identity, not a phrase: an address the caller supplied is rethrown carrying exactly the sentence the
  // module exports for it, so rewording the sentence moves both sides at once and no phrase is pinned.
  test('a fabricated before cursor throws the stale-cursor sentence, not a retry', () => {
    assert.throws(() => ctx.turnReadService.turnPage({ before: 'S9:999999' }),
      { message: STALE_CURSOR_MESSAGE });
  });

  test('an absent scope throws the scope-absent sentence', () => {
    assert.throws(() => ctx.turnReadService.turnSearch({ q: 'turn9data', scope: 'S9:999999' }),
      { message: SCOPE_ABSENT_MESSAGE });
  });

  // The delivery lookup carries no project predicate, so a cross-project capability token stays
  // readable through the tools. With a project filter this call would answer no_handoff_loaded about a
  // handoff the session had just loaded, and the load response mints no address at all — these tools
  // are the whole read surface for it.
  test('a cross-project handoff loaded into this session is still readable', async () => {
    const crossToken = 'tok-read-tools-x';
    const crossId = seed(ctx.store, { uuid: 'u-rt-x', literal: 'crossreadneedle',
      sourceSessionId: 'session-read-tools-x', loadToken: crossToken, projectId: 'project-X' });
    await ctx.request(`/api/handoff/load?load_token=${crossToken}`, {});

    const viaTool = ctx.turnReadService.turnPage({});
    const viaHttp = await ctx.request(`/api/turn/page?lineage_head=${crossId}`, {});
    assert.deepEqual(viaTool, viaHttp);
    assert.ok(viaTool.turn_page.includes('crossreadneedle'));
  });

  test('a session with no delivered handoff gets no_handoff_loaded from all three', async () => {
    const fresh = await bootTestServer({ sessionId: 'sid-no-delivery' });
    try {
      for (const call of ['turnPage', 'turnSearch', 'turnLocate']) {
        const out = fresh.turnReadService[call]({ q: 'anything' });
        assert.equal(out.error, 'no_handoff_loaded', call);
        assert.match(out.recovery, /load_handoff/, call);
      }
    } finally {
      await fresh.teardown();
    }
  });

  test('a lineage lookup exception maps to each fixed availability shape', () => {
    const hadOwn = Object.hasOwn(ctx.store, 'findLatestDeliveryInSession');
    const original = ctx.store.findLatestDeliveryInSession;
    ctx.store.findLatestDeliveryInSession = () => { throw new Error('store unavailable'); };
    try {
      for (const [call, args, error] of [
        ['turnPage', {}, 'turn_page_unavailable'],
        ['turnSearch', { q: 'anything' }, 'search_unavailable'],
        ['turnLocate', { q: 'anything' }, 'locate_unavailable'],
      ]) {
        const out = ctx.turnReadService[call](args);
        assert.equal(out.error, error, call);
        assert.equal(typeof out.recovery, 'string', call);
      }
    } finally {
      if (hadOwn) ctx.store.findLatestDeliveryInSession = original;
      else delete ctx.store.findLatestDeliveryInSession;
    }
  });

  test('the HTTP search and locate shapes stay free of the recovery field', async () => {
    const s = await ctx.request(`/api/turn/search?lineage_head=${handoffId}&q=turn9data`, {});
    assert.deepEqual(Object.keys(s).sort(), ['found', 'ranges', 'truncated']);
    const l = await ctx.request(`/api/turn/locate?lineage_head=${handoffId}&q=turn9data`, {});
    assert.deepEqual(Object.keys(l).sort(), ['found', 'ranges']);
  });
});
