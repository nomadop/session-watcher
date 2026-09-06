import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTestServer } from './helpers/server-boot.js';
import { _seedDeliveredHandoff } from './helpers/handoff-seed.js';
import { writeTranscript, userMessage, assistantObservation, ts } from './helpers/transcript-fixtures.js';

describe('turn browse route', () => {
  let ctx, dir, handoffId, transcriptPath;
  const sessionId = 'sid-browse';
  const sourceSessionId = 'session-browse-src';
  const loadToken = 'tok-browse';

  before(async () => {
    ctx = await bootTestServer({ sessionId });
    dir = mkdtempSync(join(tmpdir(), 'sw-browse-'));

    // The transcript exists for the /api/turn/page comparison below; browse never opens it.
    transcriptPath = writeTranscript(dir, [
      userMessage({ uuid: 'u-b-0', text: 'first browse turn', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a-b-0', parentUuid: 'u-b-0', messageId: 'm-b-0',
        timestamp: ts(2), blocks: [{ type: 'text', text: 'browse evidence' }] }),
      userMessage({ uuid: 'u-b-1', parentUuid: 'a-b-0', text: 'second browse turn', timestamp: ts(3) }),
    ]);
    handoffId = _seedDeliveredHandoff(ctx.store, {
      sessionId, sourceSessionId, loadToken, transcriptPath,
    });
    ctx.store.upsertTurnNotes([
      { sourceSessionId, anchorUuid: 'u-b-0', uText: 'first browse turn',
        uOriginalChars: 'first browse turn'.length, note: 'browse evidence',
        searchTerms: 'first browse turn evidence', sourceTimestamp: Date.parse(ts(1)) },
      { sourceSessionId, anchorUuid: 'u-b-1', uText: 'second browse turn',
        uOriginalChars: 400, note: null,
        searchTerms: 'second browse turn', sourceTimestamp: Date.parse(ts(3)) },
    ]);
    await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
  });

  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('返回全量 sections，顶层与逐条字段集都精确', async () => {
    const res = await ctx.requestRaw('/api/turn/browse');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['sections']);
    assert.deepEqual(body.sections.map(s => s.label), ['S1']);
    assert.deepEqual(Object.keys(body.sections[0]).sort(), ['entries', 'headline', 'label']);
    // 根段自己开口：走到第一条带观察的 turn 为止，后面那条无 note 的不入选。
    assert.equal(body.sections[0].headline, 'first browse turn');
    assert.deepEqual(body.sections[0].entries[0], {
      u_text: 'first browse turn', note: 'browse evidence',
    });
    // NULL note ⇒ key absent. No address, no source identity, no truncation metadata:
    // uOriginalChars is 400 against an 18-char u_text and must leave no trace on the wire.
    assert.equal('note' in body.sections[0].entries[1], false);
    assert.deepEqual(body.sections[0].entries[1], { u_text: 'second browse turn' });
  });

  test('提交顺序即展示顺序', async () => {
    const { sections } = await ctx.request('/api/turn/browse', {});
    assert.deepEqual(sections[0].entries.map(e => e.u_text),
      ['first browse turn', 'second browse turn']);
  });

  test('lineage_head 参数被忽略而非接受：伪造的 head 不改变响应', async () => {
    const plain = await ctx.request('/api/turn/browse', {});
    const withHead = await ctx.request('/api/turn/browse?lineage_head=999999', {});
    assert.deepEqual(withHead, plain);
  });

  test('S{k} 标签与 /api/turn/page 对同一 head 逐个一致', async () => {
    const browse = await ctx.request('/api/turn/browse', {});
    const page = await ctx.request(`/api/turn/page?lineage_head=${handoffId}`, {});
    for (const label of browse.sections.map(s => s.label)) {
      assert.ok(page.turn_page.includes(`${label}  ${transcriptPath}`),
        `${label} 未出现在页文本的 session 头里`);
    }
  });

  test('未载入任何 handoff ⇒ 200 空快照，不是 404', async () => {
    const bare = await bootTestServer({ sessionId: 'sid-browse-bare' });
    try {
      const res = await bare.requestRaw('/api/turn/browse');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { sections: [] });
    } finally {
      await bare.teardown();
    }
  });

});
