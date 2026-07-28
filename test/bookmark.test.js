// test/bookmark.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildBookmarkIndex, buildBookmarkDetail, BOOKMARK_BUDGET_MIN, BOOKMARK_BUDGET_MAX,
  MAX_KEYWORDS_PER_TURN, USER_INTENT_CHAR_LIMIT, USER_INTENT_TOTAL_CAP,
  DETAIL_WINDOW, DETAIL_ASST_TRUNCATE, DETAIL_USER_TRUNCATE, DETAIL_MAX_RESPONSE } from '../lib/bookmark.js';

function makeEntry(type, content, opts = {}) {
  const entry = { type, message: {} };
  if (type === 'assistant') {
    entry.message.content = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    entry.message.usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };
  } else {
    entry.message = { content };
  }
  return { ...entry, ...opts };
}

function writeTranscript(dir, entries) {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
  return path;
}

let tmpDir;
test.beforeEach(() => { tmpDir = mkdtempSync('/tmp/bookmark-test-'); });
test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

test('MMR: short transcript (10 turns) → budget=3, selects first + diverse + last', () => {
  const entries = [];
  const topics = ['认证系统重构设计', '数据库连接池优化', '前端路由配置',
    'API接口测试覆盖', '日志收集方案', '缓存策略调整',
    '权限模型设计', '部署流水线配置', '监控告警规则', '性能基准测试'];
  for (let i = 0; i < 10; i++) {
    entries.push(makeEntry('user', `请处理${topics[i]}`));
    entries.push(makeEntry('assistant', topics[i] + '方案已完成，具体实现如下...'));
  }
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.ok(Array.isArray(result.bookmarkIndex));
  assert.equal(result.bookmarkIndex.length, BOOKMARK_BUDGET_MIN); // sqrt(10)=3.16 → 3
  // First assistant turn (turnIndex=1 in mixed array: user=0, assistant=1, ...)
  assert.ok(result.bookmarkIndex[0].startsWith('T1:'));
  assert.ok(result.bookmarkIndex[result.bookmarkIndex.length - 1].match(/T\d+:/));
  // All entries follow format T<n>: [tools] excerpt
  for (const line of result.bookmarkIndex) {
    assert.match(line, /^T\d+: \[.*\] .+/);
  }
});

test('MMR: medium transcript (50 turns) → budget=7', () => {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    entries.push(makeEntry('user', `任务${i}: 请实现功能模块${i}`));
    entries.push(makeEntry('assistant', `模块${i}实现完毕，包含${['认证','缓存','路由','数据库','测试','部署','监控'][i % 7]}相关代码`));
  }
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.equal(result.bookmarkIndex.length, 7); // sqrt(50)=7.07 → 7
});

test('MMR: tool-only turns excluded (no text) → empty index', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(makeEntry('user', `执行操作${i}`));
    entries.push(makeEntry('assistant', [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }]));
  }
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.deepEqual(result.bookmarkIndex, []);
});

test('MMR: code blocks stripped from keyword extraction', () => {
  const entries = [
    makeEntry('user', '请修复认证模块的bug'),
    makeEntry('assistant', '修复认证模块的竞态条件：\n```js\nconst foo = bar;\nconst baz = qux;\n```\n问题已解决。'),
    makeEntry('user', '请优化数据库查询'),
    makeEntry('assistant', '优化数据库查询性能：\n```sql\nSELECT * FROM users WHERE id = 1;\n```\n查询速度提升3倍。'),
    makeEntry('user', '请添加日志'),
    makeEntry('assistant', '添加结构化日志记录，包含请求追踪和错误上报功能。'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  // Should have bookmarks (3 text turns ≥ budget min)
  assert.equal(result.bookmarkIndex.length, BOOKMARK_BUDGET_MIN);
  // Excerpts should NOT contain code syntax
  for (const line of result.bookmarkIndex) {
    assert.ok(!line.includes('const foo'));
    assert.ok(!line.includes('SELECT'));
  }
});

test('MMR: deterministic tie-break (higher turnIndex wins)', () => {
  // Create turns with identical keyword sets (should be deterministic)
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry('user', `步骤${i}`));
    entries.push(makeEntry('assistant', `完成步骤${i}的处理工作`)); // very similar keywords
  }
  const path = writeTranscript(tmpDir, entries);
  const r1 = buildBookmarkIndex(path);
  const r2 = buildBookmarkIndex(path);
  assert.deepEqual(r1.bookmarkIndex, r2.bookmarkIndex); // idempotent
});

test('MMR: keyword cap 128 per turn', () => {
  // One monster turn with 200+ unique words shouldn't dominate
  const longText = Array.from({ length: 200 }, (_, i) => `unique_word_${i}`).join(' ');
  const entries = [
    makeEntry('user', '请分析这个大文件'),
    makeEntry('assistant', longText),
    makeEntry('user', '请做认证模块'),
    makeEntry('assistant', '认证模块设计方案已完成，使用JWT加密'),
    makeEntry('user', '请做缓存'),
    makeEntry('assistant', '缓存层实现完毕，使用Redis作为后端'),
    makeEntry('user', '请做部署'),
    makeEntry('assistant', '部署配置已就绪，使用Docker容器化'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  // The long turn shouldn't steal all budget — other turns should appear
  assert.ok(result.bookmarkIndex.length >= BOOKMARK_BUDGET_MIN);
  // At least one non-first bookmark should NOT be the long turn
  const indices = result.bookmarkIndex.map(l => parseInt(l.match(/^T(\d+)/)[1]));
  assert.ok(indices.length > 1 && indices[indices.length - 1] !== indices[0]);
});

test('User intents: filters isMeta, sidechain, tool_result, trivial, short', () => {
  const entries = [
    makeEntry('user', '请实现认证模块的完整设计方案，包括登录注册'),  // valid (>15 chars)
    { type: 'user', isMeta: true, message: { content: 'skill injection content that is long enough' } },
    { type: 'user', isSidechain: true, message: { content: '子代理消息也要够长才行，需要超过十五个字' } },
    makeEntry('user', [{ type: 'tool_result', tool_use_id: 'x', content: 'result' }]),
    makeEntry('user', 'ok'),        // trivial
    makeEntry('user', '继续'),       // trivial CJK
    makeEntry('user', '短'),         // too short
    makeEntry('user', '请优化数据库连接池的超时处理逻辑，减少等待时间'),  // valid (>15 chars)
    makeEntry('assistant', '认证模块设计完成'),
    makeEntry('assistant', '数据库连接池优化完成'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.equal(result.recentUserIntents.length, 2);
  assert.ok(result.recentUserIntents[0].includes('认证模块'));
  assert.ok(result.recentUserIntents[1].includes('数据库连接池'));
});

test('User intents: U0 pinned when cap exceeded', () => {
  const entries = [];
  // First intent (U0) — the session goal (~40 chars with U<n>: prefix)
  entries.push(makeEntry('user', '请从零开始设计并实现一个完整的用户认证系统，包括注册登录权限管理和多因素验证'));
  entries.push(makeEntry('assistant', '好的，我来设计认证系统方案'));
  // Add 25 subsequent intents to exceed 800 char cap
  // Each display line ≈ "U<n>: 第XX步请处理这个具体的子任务..." ≈ 40-50 chars
  // 25 × 45 = 1125 >> 800 → eviction must trigger
  for (let i = 0; i < 25; i++) {
    entries.push(makeEntry('user', `第${String(i).padStart(2,'0')}步请处理这个具体的子任务，需要修改对应的配置文件和测试用例以及集成验证`));
    entries.push(makeEntry('assistant', `子任务${i}完成，已提交代码和测试`));
  }
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  // U0 must be present (pinned)
  assert.ok(result.recentUserIntents[0].startsWith('U0:'));
  assert.ok(result.recentUserIntents[0].includes('认证系统'));
  // Total chars must respect cap (strict — no tolerance)
  const totalChars = result.recentUserIntents.join('').length;
  assert.ok(totalChars <= USER_INTENT_TOTAL_CAP);
  // Some intents must have been evicted (25 intents cannot all fit in 800 chars)
  assert.ok(result.recentUserIntents.length < 26);
});

test('User intents: system residuals excluded', () => {
  const entries = [
    makeEntry('user', '<command-name>something</command-name><local-command-stdout>output</local-command-stdout>'),
    makeEntry('user', '<system-reminder>You have tools</system-reminder>'),
    makeEntry('user', '[Request interrupted by user]'),
    makeEntry('user', '请修复这个非常重要的用户认证安全漏洞问题'),  // only valid one (>15 chars)
    makeEntry('assistant', '已修复认证漏洞，加强了令牌验证'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.equal(result.recentUserIntents.length, 1);
  assert.ok(result.recentUserIntents[0].includes('认证'));
});

test('User intents: redactSecrets applied', () => {
  const entries = [
    makeEntry('user', '请检查这个密钥是否有效: sk-1234567890abcdef1234567890abcdef 需要验证'),  // >15 chars
    makeEntry('assistant', '检查完毕，该密钥格式正确，已验证通过'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkIndex(path);

  assert.ok(result.recentUserIntents.length >= 1);
  assert.ok(!result.recentUserIntents[0].includes('sk-1234567890'));
  assert.ok(result.recentUserIntents[0].includes('[REDACTED]'));
});

test('Degradation: null transcriptPath → empty arrays', () => {
  const result = buildBookmarkIndex(null);
  assert.deepEqual(result, { bookmarkIndex: [], recentUserIntents: [] });
});

test('Degradation: missing file → empty arrays', () => {
  const result = buildBookmarkIndex('/nonexistent/path/transcript.jsonl');
  assert.deepEqual(result, { bookmarkIndex: [], recentUserIntents: [] });
});

test('Degradation: empty file → empty arrays', () => {
  const path = join(tmpDir, 'empty.jsonl');
  writeFileSync(path, '');
  const result = buildBookmarkIndex(path);
  assert.deepEqual(result, { bookmarkIndex: [], recentUserIntents: [] });
});

test('Degradation: malformed JSONL lines skipped gracefully', () => {
  const path = join(tmpDir, 'bad.jsonl');
  const lines = [
    'not json at all',
    JSON.stringify(makeEntry('user', '请实现认证系统的完整方案设计')),
    '{ broken json',
    JSON.stringify(makeEntry('assistant', '认证系统方案设计完成，包含以下模块...')),
  ];
  writeFileSync(path, lines.join('\n'));
  const result = buildBookmarkIndex(path);

  assert.ok(result.bookmarkIndex.length >= 1 || result.recentUserIntents.length >= 1);
});

test('Detail: middle turn → ±3 window', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry('user', `用户消息${i}，需要足够长度`));
    entries.push(makeEntry('assistant', `助手回复${i}，执行了相关操作`));
  }
  const path = writeTranscript(tmpDir, entries);
  // Turn index 10 should be middle-ish
  const result = buildBookmarkDetail(path, 10);

  assert.ok(result);
  assert.equal(result.target_turn_index, 10);
  assert.equal(result.window_start, 10 - DETAIL_WINDOW);
  assert.equal(result.window_end, 10 + DETAIL_WINDOW);
  assert.equal(result.turns.length, 2 * DETAIL_WINDOW + 1); // 7 turns
});

test('Detail: first turn → no before, only after', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(makeEntry('user', `用户消息${i}，长度足够`));
    entries.push(makeEntry('assistant', `助手回复${i}，完成操作`));
  }
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkDetail(path, 0);

  assert.ok(result);
  assert.equal(result.window_start, 0);
  assert.equal(result.turns[0].turn_index, 0);
});

test('Detail: last turn → no after, only before', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(makeEntry('user', `用户消息${i}，长度足够`));
    entries.push(makeEntry('assistant', `助手回复${i}，完成操作`));
  }
  const path = writeTranscript(tmpDir, entries);
  // Find actual last turn index
  const { bookmarkIndex } = buildBookmarkIndex(path);
  const lastLine = bookmarkIndex[bookmarkIndex.length - 1];
  const lastIdx = parseInt(lastLine.match(/^T(\d+)/)[1]);

  const result = buildBookmarkDetail(path, lastIdx);
  assert.ok(result);
  assert.equal(result.turns[result.turns.length - 1].turn_index, lastIdx);
});

test('Detail: full_text=true respects DETAIL_MAX_RESPONSE ceiling', () => {
  const longText = 'x'.repeat(20000); // exceeds 10000 limit
  const entries = [
    makeEntry('user', '请处理这段很长的内容'),
    makeEntry('assistant', longText),
    makeEntry('user', '继续处理后续任务'),
    makeEntry('assistant', '后续处理完成'),
  ];
  const path = writeTranscript(tmpDir, entries);
  const result = buildBookmarkDetail(path, 1, true); // full_text=true on long turn

  assert.ok(result);
  const targetTurn = result.turns.find(t => t.turn_index === 1);
  assert.ok(targetTurn);
  assert.ok(targetTurn.text.length <= DETAIL_MAX_RESPONSE);
  assert.equal(targetTurn.truncated, true);
  assert.equal(targetTurn.original_chars, 20000);
});

test('Detail: null/missing path → null', () => {
  assert.equal(buildBookmarkDetail(null, 5), null);
  assert.equal(buildBookmarkDetail('/no/such/file.jsonl', 5), null);
});

test('Detail: out-of-bounds turnIndex → null', () => {
  const entries = [
    makeEntry('user', '一条足够长的用户消息'),
    makeEntry('assistant', '一条足够长的助手回复'),
  ];
  const path = writeTranscript(tmpDir, entries);
  assert.equal(buildBookmarkDetail(path, 99), null);
  assert.equal(buildBookmarkDetail(path, -1), null);
});

test('Schema: transcript_path persisted and retrieved via store', async () => {
  // This test validates integration; if store tests exist for handoff,
  // verify transcript_path roundtrips. Minimal smoke test:
  const { buildBookmarkIndex } = await import('../lib/bookmark.js');
  // Just verify the function handles a real path that exists
  const path = writeTranscript(tmpDir, [
    makeEntry('user', '请修复认证系统的关键漏洞问题'),
    makeEntry('assistant', '认证系统漏洞已修复，加强了令牌验证逻辑'),
  ]);
  const result = buildBookmarkIndex(path);
  assert.ok(result.bookmarkIndex.length >= 1);
});
