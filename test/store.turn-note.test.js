import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import { buildFtsMatch } from '../lib/handoff.js';
import { buildSearchTerms } from '../lib/turn.js';
import { GC_HANDOFF_MAX_AGE_DAYS } from '../lib/constants.js';

const DAY_MS = 24 * 3600 * 1000;
const maxAgeMs = 7 * DAY_MS;          // session sweep window (no session rows are seeded here)
const now = Date.now();

let dir, dbPath, store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-turn-note-'));
  dbPath = join(dir, 't.sqlite');
  store = openStore(dbPath);
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

const row = (o = {}) => ({
  sourceSessionId: 'sess-A', anchorUuid: 'a1', uText: 'u', uOriginalChars: 1,
  note: 'n', searchTerms: '', sourceTimestamp: 1000, ...o,
});

const handoff = (o = {}) => ({
  sessionId: 'sess-A', segment: 0, loadToken: 'tok-alpha', createdAt: now,
  pathsToKeep: '[]', summary: 'sum', summaryTokens: 1, projectId: 'proj-1', ...o,
});

test('upsert 幂等：同 (session, anchor) 后写覆盖前写，created_at 保留', () => {
  store.upsertTurnNotes([row({ note: 'first' })]);
  const first = store.listTurnNotes('sess-A')[0];
  store.upsertTurnNotes([row({ note: 'second' })]);
  const second = store.listTurnNotes('sess-A')[0];
  assert.equal(second.note, 'second');
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(store.listTurnNotes('sess-A').length, 1);
});

test('created_at 只在插入时写：先把存量值改早，再次 upsert 不得覆盖它', () => {
  // Two back-to-back upserts can share one Date.now() millisecond, so an insert-only created_at
  // has to be pinned against a stored value that clearly predates the second write.
  store.upsertTurnNotes([row({ note: 'first' })]);
  store._db.prepare("UPDATE turn_note SET created_at = 1 WHERE source_session_id='sess-A' AND anchor_uuid='a1'").run();
  store.upsertTurnNotes([row({ note: 'second' })]);
  const r = store.listTurnNotes('sess-A')[0];
  assert.equal(r.createdAt, 1);
  assert.equal(r.note, 'second');
});

test('note-less 行写 NULL 且仍可读', () => {
  store.upsertTurnNotes([row({ note: null })]);
  assert.equal(store.listTurnNotes('sess-A')[0].note, null);
});

test('整组原子：任一行违反 NOT NULL 时零写入', () => {
  assert.throws(() => store.upsertTurnNotes([row({}), row({ anchorUuid: 'a2', sourceTimestamp: null })]));
  assert.equal(store.listTurnNotes('sess-A').length, 0);
  assert.equal(store.locateTurnNotes(['sess-A'], '"n"').length, 0, 'FTS rolled back with the table');
});

test('FTS UPDATE 触发器：重做 handoff 后旧词消失、新词命中', () => {
  store.upsertTurnNotes([row({ note: 'alpha 决策' })]);
  store.upsertTurnNotes([row({ note: 'beta 决策' })]);
  assert.equal(store.locateTurnNotes(['sess-A'], '"alpha"').length, 0);
  assert.equal(store.locateTurnNotes(['sess-A'], '"beta"').length, 1);
});

test('CJK：search_terms 与 buildFtsMatch 双向使用同一 cjkBigrams', () => {
  store.upsertTurnNotes([row({ note: '连续中文可命中', searchTerms: buildSearchTerms({ uText: '', note: '连续中文可命中', turn: { lines: [] }, cwd: '/project' }) })]);
  assert.equal(store.locateTurnNotes(['sess-A'], buildFtsMatch('连续中文', 'plain')).length, 1);
});

test('search_terms：相对工具路径以会话 cwd 为根；只收路径、不收工具名；重复路径只收一次', () => {
  const read = () => ({ kind: 'tool', tool: { name: 'Read', input: { file_path: 'lib/store.js' } } });
  const turn = { lines: [read(), read()] };          // the same file read twice in one turn
  const terms = buildSearchTerms({ uText: '', note: null, turn, cwd: '/project' });
  const parts = terms.split(' ');
  assert.ok(parts.includes('/project/lib/store.js'));
  assert.ok(!parts.includes('/lib/store.js'));
  assert.ok(!parts.includes('Read'), '工具名不是检索词');
  assert.deepEqual(parts, ['/project/lib/store.js'], '重复路径去重，且没有第二类词进来');
});

test('locateTurnNotes 只返回给定 session 集合内的行', () => {
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-A', note: 'shared 词' })]);
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-Z', anchorUuid: 'z1', note: 'shared 词' })]);
  const rows = store.locateTurnNotes(['sess-A'], '"shared"');
  assert.deepEqual(rows.map(r => r.sourceSessionId), ['sess-A']);
});

test('locateTurnNotes 的 session 集合为空时返回空数组', () => {
  assert.deepEqual(store.locateTurnNotes([], '"shared"'), []);
});

test('locateTurnNotes 排序：bm25 优先且最佳在前，其后 source_timestamp DESC、session、anchor', () => {
  // The first four rows carry identical text ⇒ identical bm25, so only the tiebreakers can order
  // them; they are inserted in an order the expected sequence contradicts, so plain rowid order (an
  // ORDER BY that went missing) cannot pass. The padded row matches the same term but is a longer
  // document ⇒ worse bm25, and carries the NEWEST timestamp, so it sorts last only if bm25 is the
  // primary key and ASC — best match first.
  const t = (o) => row({ uText: 'topic', note: 'n', ...o });
  store.upsertTurnNotes([
    t({ sourceSessionId: 'sess-A', anchorUuid: 'a2', sourceTimestamp: 1000 }),
    t({ sourceSessionId: 'sess-B', anchorUuid: 'b2', sourceTimestamp: 1000 }),
    t({ sourceSessionId: 'sess-A', anchorUuid: 'a1', sourceTimestamp: 2000 }),
    t({ sourceSessionId: 'sess-B', anchorUuid: 'b1', sourceTimestamp: 2000 }),
    t({ sourceSessionId: 'sess-A', anchorUuid: 'pad', sourceTimestamp: 3000,
        uText: `topic ${'filler '.repeat(60)}` }),
  ]);
  const seq = store.locateTurnNotes(['sess-A', 'sess-B'], '"topic"')
    .map(r => `${r.sourceSessionId}/${r.anchorUuid}`);
  assert.deepEqual(seq, ['sess-A/a1', 'sess-B/b1', 'sess-A/a2', 'sess-B/b2', 'sess-A/pad']);
});

test('locateTurnNotes 不带 LIMIT —— 超过常见分页阈值的行全部返回', () => {
  // Seed 110 rows — more than any common default LIMIT (100). If a LIMIT existed, fewer rows
  // would come back and the count assertion would catch it.
  const N = 110;
  const rows = Array.from({ length: N }, (_, i) =>
    row({ anchorUuid: `vol-${i}`, sourceTimestamp: i + 1, note: 'volume keyword' }),
  );
  store.upsertTurnNotes(rows);
  const results = store.locateTurnNotes(['sess-A'], '"volume"');
  assert.equal(results.length, N, `expected all ${N} rows; a LIMIT would cap this`);
});

test('GC：同事务先删过期 handoff，再删无存活来源 handoff 的 turn_note', () => {
  const expiredAt = now - (GC_HANDOFF_MAX_AGE_DAYS + 1) * DAY_MS;   // strictly older than the cutoff
  const survivingAt = now - DAY_MS;                                 // well inside the retention window
  // sess-A: one expired + one surviving handoff ⇒ its turn_note must be kept.
  store.insertHandoff(handoff({ sessionId: 'sess-A', loadToken: 'tok-a-expired', createdAt: expiredAt }));
  store.insertHandoff(handoff({ sessionId: 'sess-A', segment: 1, loadToken: 'tok-a-alive', createdAt: survivingAt }));
  // sess-B: only an expired handoff ⇒ its turn_note must go, FTS included.
  store.insertHandoff(handoff({ sessionId: 'sess-B', loadToken: 'tok-b-expired', createdAt: expiredAt }));
  store.upsertTurnNotes([
    row({ sourceSessionId: 'sess-A', anchorUuid: 'a1', note: 'kept 词' }),
    row({ sourceSessionId: 'sess-B', anchorUuid: 'b1', note: 'gone 词' }),
  ]);
  assert.equal(store.locateTurnNotes(['sess-B'], '"gone"').length, 1, 'searchable before the sweep');

  store.sweep(maxAgeMs, { now });

  assert.equal(store._db.prepare("SELECT COUNT(*) AS c FROM handoff WHERE session_id='sess-A'").get().c, 1);
  assert.equal(store._db.prepare("SELECT COUNT(*) AS c FROM handoff WHERE session_id='sess-B'").get().c, 0);
  assert.equal(store.listTurnNotes('sess-A').length, 1);
  assert.equal(store.listTurnNotes('sess-B').length, 0);
  assert.equal(store.locateTurnNotes(['sess-B'], '"gone"').length, 0);
});

test('GC 同事务：turn_note 清理失败时，过期 handoff 的删除随之回滚', () => {
  const expiredAt = now - (GC_HANDOFF_MAX_AGE_DAYS + 1) * DAY_MS;
  store.insertHandoff(handoff({ sessionId: 'sess-B', loadToken: 'tok-b-expired', createdAt: expiredAt }));
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-B', anchorUuid: 'b1', note: 'gone 词' })]);
  const orig = store._stmts.deleteTurnNotesIfNoHandoff;
  // The stub stands in for a prepared statement deleteSession runs too, so it is not scoped to the
  // sweep's retirement seam. This case is safe only because no sessions row is seeded here, so the
  // sweep's expired-session loop never reaches _cascadeDelete; a case that seeds an expired session
  // would break this one over a path it does not test.
  store._stmts.deleteTurnNotesIfNoHandoff = { run() { throw new Error('injected turn_note GC failure'); } };
  try {
    store.sweep(maxAgeMs, { now });     // swallowed by sweep's own guard — GC never aborts a sweep
  } finally {
    store._stmts.deleteTurnNotesIfNoHandoff = orig;
  }
  assert.equal(store.listTurnNotes('sess-B').length, 1, '退休失败即整体回滚，note 与 handoff 一起留下');
  assert.equal(store._db.prepare("SELECT COUNT(*) AS c FROM handoff WHERE load_token='tok-b-expired'").get().c, 1,
    '两条删除同处一个事务：后者失败则前者的过期 handoff 删除也回滚');
});

test('GC：本次删除没有拿走任何 handoff 的会话，其 turn_note 不被 sweep 收走', () => {
  // submit_turn_notes writes the queue before prepare_handoff creates the row that will keep it, so a
  // sweep landing inside that window must not see a handoff-less session as a retirement candidate.
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-P', anchorUuid: 'p1', note: 'pending 词' })]);
  store.sweep(maxAgeMs, { now });
  assert.equal(store.listTurnNotes('sess-P').length, 1);
  assert.equal(store.locateTurnNotes(['sess-P'], '"pending"').length, 1);
});

test('deleteSession：会话无任何 handoff 时连带清掉它的 turn_note，FTS 一并退出', () => {
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-D', anchorUuid: 'd1', note: 'dropped 词' })]);
  assert.equal(store.locateTurnNotes(['sess-D'], '"dropped"').length, 1, 'searchable before the delete');
  store.deleteSession('sess-D');
  assert.equal(store.listTurnNotes('sess-D').length, 0);
  assert.equal(store.locateTurnNotes(['sess-D'], '"dropped"').length, 0);
});

test('deleteSession：仍有存活 handoff 引用该会话时保留 turn_note', () => {
  // Session scanning and handoff retention age on different windows, so the session row can reach
  // deleteSession while a handoff that still loads these notes is well inside its own window.
  store.insertHandoff(handoff({ sessionId: 'sess-K', loadToken: 'tok-k-alive', createdAt: now }));
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-K', anchorUuid: 'k1', note: 'loadable 词' })]);
  store.deleteSession('sess-K');
  assert.equal(store.listTurnNotes('sess-K').length, 1);
  assert.equal(store.locateTurnNotes(['sess-K'], '"loadable"').length, 1);
});

test('GC 空项目：project_id 为 NULL 的 handoff 仍按 source_session_id 承载存活性', () => {
  const { handoffId } = store.insertHandoff({ sessionId: 'sess-N', segment: 0, loadToken: 'tN', createdAt: now,
    pathsToKeep: '[]', summary: 's', summaryTokens: 1, projectId: null, transcriptPath: null });
  // A real delivery exists, so the lineage assertion below is about the NULL project and not about
  // an empty handoff_load table.
  store.insertHandoffLoad({ handoffId, sessionId: 'sess-N', loadedAt: now - 1000, claimResult: 'primary' });
  store.upsertTurnNotes([row({ sourceSessionId: 'sess-N', anchorUuid: 'n1' })]);
  store.sweep(maxAgeMs, { now });
  assert.equal(store.listTurnNotes('sess-N').length, 1);
  assert.equal(store.findParentDelivery(null, 'sess-N', now), null);   // 两个 NULL project 不串链
});

test('存储形状：无 project_id、无 u_truncated 列', () => {
  const cols = store._db.prepare('PRAGMA table_info(turn_note)').all().map(c => c.name);
  assert.ok(cols.includes('source_session_id'), 'the table exists (PRAGMA is empty for a missing one)');
  assert.ok(!cols.includes('project_id'));
  assert.ok(!cols.includes('u_truncated'));
});

test('meta 已为 5 但 turn_note 缺失时，reopen 仍 presence-heal', (t) => {
  const p = join(dir, 'heal-v5.sqlite');
  let s = openStore(p);
  s._db.exec('DROP TABLE turn_note');
  closeStore(s);
  s = openStore(p);
  t.after(() => closeStore(s));
  assert.ok(s._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_note'").get());
  assert.equal(s._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5');
});

test('索引完好的库 reopen：两个 FTS 的既有行仍可检索，改写掉的旧词也不复活', (t) => {
  const p = join(dir, 'fts-reopen.sqlite');
  let s = openStore(p);
  s.insertHandoff(handoff({ sessionId: 'sess-R', loadToken: 'tok-r', summary: 'reopenable 摘要' }));
  s.upsertTurnNotes([row({ sourceSessionId: 'sess-R', anchorUuid: 'r1', note: 'alpha 词' })]);
  s.upsertTurnNotes([row({ sourceSessionId: 'sess-R', anchorUuid: 'r1', note: 'beta 词' })]);
  closeStore(s);
  s = openStore(p);
  t.after(() => closeStore(s));
  assert.equal(s.locateTurnNotes(['sess-R'], '"beta"').length, 1);
  assert.equal(s.locateTurnNotes(['sess-R'], '"alpha"').length, 0, 'reopen 不把被改写掉的旧词带回来');
  assert.equal(s.searchHandoff('reopenable').length, 1);
});

test('turn_note_fts 触发器在库外被删：期间的写入在 reopen 后重新可检索', (t) => {
  const p = join(dir, 'fts-heal-turn.sqlite');
  let s = openStore(p);
  s._db.exec('DROP TRIGGER turn_note_fts_insert');
  s.upsertTurnNotes([row({ sourceSessionId: 'sess-H', anchorUuid: 'h1', note: 'healed 词' })]);
  assert.equal(s.locateTurnNotes(['sess-H'], '"healed"').length, 0, '触发器缺席时无人把它写进索引');
  closeStore(s);
  s = openStore(p);
  t.after(() => closeStore(s));
  assert.equal(s.locateTurnNotes(['sess-H'], '"healed"').length, 1);
});

test('handoff_fts 触发器在库外被删：期间的写入在 reopen 后重新可检索', (t) => {
  const p = join(dir, 'fts-heal-handoff.sqlite');
  let s = openStore(p);
  s._db.exec('DROP TRIGGER handoff_fts_insert');
  s.insertHandoff(handoff({ sessionId: 'sess-H', loadToken: 'tok-h', summary: 'healable 摘要' }));
  assert.equal(s.searchHandoff('healable').length, 0, '触发器缺席时无人把它写进索引');
  closeStore(s);
  s = openStore(p);
  t.after(() => closeStore(s));
  assert.equal(s.searchHandoff('healable').length, 1);
});

test('turn_note_fts 完好库 reopen：base 表推不出的 posting 不被重建冲掉', () => {
  store.upsertTurnNotes([row({ note: 'kept 词' })]);
  const { turn_note_id: id } = store._db.prepare(
    "SELECT turn_note_id FROM turn_note WHERE source_session_id='sess-A' AND anchor_uuid='a1'").get();
  // A posting no row can yield, so only a rebuild — which re-derives from the base table — removes it.
  store._db.prepare('INSERT INTO turn_note_fts(rowid, u_text, note, search_terms) VALUES (?, ?, NULL, NULL)')
    .run(id, 'plantedsentinel');
  assert.equal(store.locateTurnNotes(['sess-A'], '"plantedsentinel"').length, 1, '植入后可检索');
  closeStore(store);

  store = openStore(dbPath);
  assert.equal(store.locateTurnNotes(['sess-A'], '"plantedsentinel"').length, 1,
    '对象集完整的 reopen 不重建索引');
  assert.equal(store.locateTurnNotes(['sess-A'], '"kept"').length, 1, '真实内容照旧可检索');
});

test('turn-FTS 可用性是独立标志，不复用 handoff-FTS 的', () => {
  assert.equal(store.turnFtsAvailable(), true);
  store._turnFtsAvailable = false;    // the state an FTS5-less open leaves behind
  assert.equal(store.turnFtsAvailable(), false);
  assert.equal(store.ftsAvailable, true, 'handoff FTS keeps its own flag');
});

test('单字 CJK 查询：buildFtsMatch 产出合法表达式，FTS 不抛出且返回空结果', () => {
  // A CJK term too short to form a bigram must still yield a token, because an empty FTS5 MATCH
  // expression is a syntax error rather than an empty result. buildFtsMatch emits the quoted
  // text as a fallback so a short-term query returns nothing rather than throwing.
  const expr = buildFtsMatch('你', 'plain');
  assert.equal(expr, '"你"');
  // Route through a real store — only a live search can distinguish "no results" from "error".
  const results = store.locateTurnNotes(['sess-A'], expr);
  assert.deepEqual(results, []);
});

test('buildFtsMatch 混合脚本查询：拉丁字半是生效的 FTS 约束', () => {
  // Doc A has both the Latin word in note and the CJK bigram in search_terms → must match.
  // Doc B has only the Latin word → must not match (CJK bigram absent).
  // Doc C has only the CJK bigram → must not match (Latin word absent).
  // Before the fix, buildFtsMatch dropped the Latin half, so Doc C was a false positive.
  store.upsertTurnNotes([
    row({ sourceSessionId: 'sess-M', anchorUuid: 'both',
      note: 'hello',
      searchTerms: buildSearchTerms({ uText: '你好', note: '', turn: { lines: [] }, cwd: '/p' }) }),
    row({ sourceSessionId: 'sess-M', anchorUuid: 'latin-only',
      note: 'hello', searchTerms: '' }),
    row({ sourceSessionId: 'sess-M', anchorUuid: 'cjk-only',
      note: 'unrelated',
      searchTerms: buildSearchTerms({ uText: '你好', note: '', turn: { lines: [] }, cwd: '/p' }) }),
  ]);
  const expr = buildFtsMatch('hello你好', 'plain');
  const matches = store.locateTurnNotes(['sess-M'], expr);
  assert.equal(matches.length, 1, '只有同时具备两半的文档命中');
  assert.equal(matches[0].anchorUuid, 'both');
});
