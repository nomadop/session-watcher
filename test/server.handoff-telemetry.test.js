import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { bootTestServer } from './helpers/server-boot.js';

// Load-side telemetry tests (Task 4). Prepare-side tests are added in Task 5.
// Uses the Task 0 harness: bootTestServer → { get, prepareHandoff, store, sessionId, cwd,
// bootSecondConsumer, teardown }. The consumer session id + cwd are bound so content_hash_load
// resolves against a real file on disk.

let ctx;
beforeEach(async () => { ctx = await bootTestServer(); });
afterEach(async () => { await ctx.teardown(); });

test('load stamps delivered_session_id + loader_version from the live server context', async () => {
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const res = await ctx.get(`/api/handoff/load?load_token=${token}`);
  assert.equal(res.found, true);
  const row = ctx.store._db.prepare("SELECT delivered_session_id, loader_version FROM handoff WHERE load_token=?").get(token);
  assert.equal(row.delivered_session_id, ctx.sessionId);
  assert.match(row.loader_version, /^\d+\.\d+\.\d+/);
});

test('load attaches content_hash_load (hl) to each kept path entry', async () => {
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 1;\n');
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  await ctx.get(`/api/handoff/load?load_token=${token}`);
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.match(entries[0].hl, /^[0-9a-f]{64}$/);
});

test('load degradation: a deleted kept path yields hl=null and does not fail the load', async () => {
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'gone.js' }], summary: 's' });
  const res = await ctx.get(`/api/handoff/load?load_token=${token}`);
  assert.equal(res.found, true, 'load still succeeds');
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].hl, null);
});

test('agent-visible load response carries NO server-only telemetry fields', async () => {
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 1;\n');
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const res = await ctx.get(`/api/handoff/load?load_token=${token}`);
  const entries = Array.isArray(res.paths_to_keep) ? res.paths_to_keep : res.paths_to_keep.paths;
  const e = entries[0];
  assert.equal(e.path, 'a.js', 'the agent still sees the path (+ symbols/lines if any)');
  for (const leaked of ['hp', 'hl', 'bucket_id', 'match_status', 'candidate_bucket_ids', 'total_line_count', 'selected_line_count']) {
    assert.equal(e[leaked], undefined, `server-only telemetry field ${leaked} must be stripped from the agent response`);
  }
  assert.equal(res.bucket_snapshot, undefined, 'bucket_snapshot never in the response');
  // …but the DB row DID persist the telemetry (server-side).
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const s = (Array.isArray(stored) ? stored : stored.paths)[0];
  assert.match(s.hl, /^[0-9a-f]{64}$/, 'hl persisted server-side even though stripped from the response');
});

test('a duplicate/second-session load does NOT overwrite the primary consumer content_hash_load', async () => {
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 1;\n');
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  // Primary consumer (ctx.sessionId) loads → stamps hl.
  await ctx.get(`/api/handoff/load?load_token=${token}`);
  const primaryHl = (() => { const st = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep); return (Array.isArray(st) ? st : st.paths)[0].hl; })();
  // The file changes, then a DIFFERENT session loads (duplicate). It must not clobber the primary hl.
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 2;// changed\n');
  const second = await ctx.bootSecondConsumer();   // a 2nd app instance on the SAME DB + cwd, own sessionId
  const dup = await second.get(`/api/handoff/load?load_token=${token}`);
  assert.equal(dup.found, true, 'duplicate still returns content (fail-open)');
  const afterHl = (() => { const st = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep); return (Array.isArray(st) ? st : st.paths)[0].hl; })();
  assert.equal(afterHl, primaryHl, 'content_hash_load stays the primary consumer\'s value, not the duplicate\'s');
});

test('claim-then-crash: the SAME primary session back-fills hl on retry when it is still missing', async () => {
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 1;\n');
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  // Simulate: the claim txn committed but the process crashed before hl was written. We reproduce that
  // state by claiming the binding directly (no hash stamp), leaving entries with no `hl` key.
  ctx.store.loadHandoffByToken(token, { sessionId: ctx.sessionId, loaderVersion: '0.5.0', consumerSegment: 0 });
  const beforeStored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  assert.ok(!('hl' in (Array.isArray(beforeStored) ? beforeStored : beforeStored.paths)[0]), 'precondition: hl not yet written');
  // The same primary session reloads (claimedNow=false now) → the gate back-fills hl.
  const res = await ctx.get(`/api/handoff/load?load_token=${token}`);
  assert.equal(res.found, true);
  const afterStored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  assert.match((Array.isArray(afterStored) ? afterStored : afterStored.paths)[0].hl, /^[0-9a-f]{64}$/, 'same-primary retry back-filled the missing hl');
});

// Compat fixture (Step 3b): the agent whitelist ['path','symbols','lines'] must drop no legitimate
// public field. Prepare a handoff carrying every public entry field a pre-v3 load response could
// return (path + symbols + lines), load it, and assert all three round-trip — WHILE the telemetry
// keys stay absent. If a future change adds a public entry field, this fails until it is whitelisted.
test('compat: path + symbols + lines round-trip through the projection; telemetry keys stay absent', async () => {
  // Seed _bRebuild line data (no full snapshot) so prepare injects collapsed line ranges — the only
  // way a `lines` field lands on a kept entry (see server.js prepare handler).
  const testPath = 'src/compat.js';
  const be = ctx.watcher._bRebuild._ensure(testPath);
  ctx.watcher._bRebuild._setLine(be, 10, 50);
  ctx.watcher._bRebuild._setLine(be, 11, 40);
  ctx.watcher._bRebuild._setLine(be, 12, 60);
  writeFileSync(join(ctx.cwd, 'compat.js'), 'export const y = 2;\n');
  const token = await ctx.prepareHandoff({ paths_to_keep: [{ path: testPath, symbols: ['doThing'] }], summary: 's' });
  const res = await ctx.get(`/api/handoff/load?load_token=${token}`);
  assert.equal(res.found, true);
  const entries = Array.isArray(res.paths_to_keep) ? res.paths_to_keep : res.paths_to_keep.paths;
  const e = entries[0];
  assert.equal(e.path, testPath, 'path preserved');
  assert.deepEqual(e.symbols, ['doThing'], 'symbols preserved');
  assert.deepEqual(e.lines, [[10, 12]], 'lines preserved (collapsed range)');
  for (const leaked of ['hp', 'hl', 'bucket_id', 'match_status', 'candidate_bucket_ids', 'total_line_count', 'selected_line_count']) {
    assert.equal(e[leaked], undefined, `telemetry field ${leaked} must not be in the agent response`);
  }
});

// ── Prepare-side telemetry tests (Task 5) ────────────────────────────────────

test('prepare stores bucket_snapshot server-side; the agent-visible response never contains it', async () => {
  // touchBucketPaths (not writeFileSync) so a.js is a real bucket CANDIDATE → snap.paths has ≥1 element,
  // making the every() shape assertion below run on a real entry instead of vacuously over zero. Keeping
  // the single touched candidate makes it kept-matched, so its canonical_path is filled (a string).
  await ctx.touchBucketPaths(['a.js']);
  const { token, response } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  assert.equal(response.bucket_snapshot, undefined, 'not in the agent-visible payload');
  const snapRaw = ctx.store._db.prepare("SELECT bucket_snapshot FROM handoff WHERE load_token=?").get(token).bucket_snapshot;
  assert.ok(snapRaw, 'bucket_snapshot persisted');
  const snap = JSON.parse(snapRaw);
  assert.equal(typeof snap.v, 'number');
  assert.ok(Array.isArray(snap.paths));
  assert.ok(snap.paths.every(p => typeof p.id === 'string' && typeof p.canonical_path === 'string' && typeof p.whole_ctp === 'number'));
});

test('prepare binds each kept path to exactly one bucket_id with match_status=exact', async () => {
  // touchBucketPaths (not writeFileSync) so a.js is BOTH on disk AND a bucket candidate. The test's own
  // `bucket_id ∈ snapshot.paths` assertion is unsatisfiable by ANY correct impl unless a.js ∈ bd.paths —
  // the frozen candidate universe is bd.paths (touched files), and a write-only path is never in it.
  await ctx.touchBucketPaths(['a.js'], { content: 'line1\nline2\n' });
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].match_status, 'exact');
  assert.equal(typeof entries[0].bucket_id, 'string');
  const snap = JSON.parse(ctx.store._db.prepare("SELECT bucket_snapshot FROM handoff WHERE load_token=?").get(token).bucket_snapshot);
  assert.ok(snap.paths.some(p => p.id === entries[0].bucket_id), 'bucket_id references a snapshot entry');
});

test('prepare attaches content_hash_prepare (hp) to each kept path', async () => {
  // touchBucketPaths so a.js is a matched bucket candidate — hp is the hash of the MATCHED candidate's
  // physical file, so the kept path must resolve to a candidate (write-only paths are unmatched → hp=null).
  await ctx.touchBucketPaths(['a.js'], { content: 'export const x = 1;\n' });
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.match(entries[0].hp, /^[0-9a-f]{64}$/);
});

test('prepare records match_status=ambiguous AND stores candidate_bucket_ids', async () => {
  // Two bucket paths ending in the same relative path → the kept identity is ambiguous.
  // Arrange two touched files api/src/server.js and admin/src/server.js in the bucket, keep src/server.js.
  await ctx.touchBucketPaths(['api/src/server.js', 'admin/src/server.js']);   // helper: fold reads of both
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'src/server.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].match_status, 'ambiguous', 'ambiguity recorded, not silently resolved for identity');
  assert.equal(entries[0].bucket_id, null);
  assert.ok(Array.isArray(entries[0].candidate_bucket_ids) && entries[0].candidate_bucket_ids.length === 2,
    'the ambiguous candidate ids are persisted so offline analysis never re-runs suffix matching');
  assert.equal(entries[0].hp, null, 'ambiguous → hp is null, never a hash of a guessed non-authoritative file');
});

test('an exact match is NOT downgraded to ambiguous by a coexisting suffix match', async () => {
  // A kept path that exactly matches one candidate AND suffix-matches another must bind to the exact
  // one, not be flagged ambiguous. Arrange cwd/a.js (exact) + nested/dir/a.js (suffix of 'a.js').
  await ctx.touchBucketPaths(['a.js', 'nested/dir/a.js']);   // both touched; keep 'a.js' → exact wins
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].match_status, 'exact', 'exact match takes priority over a coexisting suffix match');
  assert.equal(typeof entries[0].bucket_id, 'string');
  assert.match(entries[0].hp, /^[0-9a-f]{64}$/, 'and hp is the exact file hash');
});

test('a KEPT-matched bucket_snapshot entry carries a non-null whole_bytes basis; un-kept ones stay null', async () => {
  writeFileSync(join(ctx.cwd, 'a.js'), 'export const x = 1;\n');
  await ctx.touchBucketPaths(['a.js', 'other/untouched-by-keep.js']);   // two candidates, keep only a.js
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'a.js' }], summary: 's' });
  const snap = JSON.parse(ctx.store._db.prepare("SELECT bucket_snapshot FROM handoff WHERE load_token=?").get(token).bucket_snapshot);
  const kept = snap.paths.find(p => p.raw_path.endsWith('a.js'));
  assert.equal(typeof kept.whole_bytes, 'number', 'whole_bytes (bytes) filled from an fs stat for the KEPT-matched candidate');
  assert.ok(snap.paths.every(p => p.whole_chars === undefined), 'the misnamed whole_chars key is gone');
  // Un-kept candidates are NOT stat'd (cost bounded to kept paths) — whole_bytes stays null.
  const unkept = snap.paths.find(p => p.raw_path.endsWith('untouched-by-keep.js'));
  assert.equal(unkept.whole_bytes, null, 'an un-kept candidate is never stat\'d, so whole_bytes is null');
  assert.equal(snap.truncated, undefined, 'no truncation flag — every candidate is persisted');
});

test('EVERY candidate is persisted (no truncation) even for a large touched set', async () => {
  // No 2000-path/512KB cap. A large touched set persists in full; cost is bounded because only the
  // (few) kept-matched candidates are stat'd/canonicalized, not the whole list.
  await ctx.touchBucketPaths(Array.from({ length: 2100 }, (_, i) => `pkg/mod${i}/file.js`));
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'mod5/file.js' }], summary: 's' });
  const snap = JSON.parse(ctx.store._db.prepare("SELECT bucket_snapshot FROM handoff WHERE load_token=?").get(token).bucket_snapshot);
  assert.equal(snap.total_candidates, snap.paths.length, 'total_candidates == persisted paths (nothing truncated out)');
  assert.ok(snap.paths.length >= 2100, 'every touched candidate persisted');
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  if (entries[0].match_status === 'exact') assert.ok(snap.paths.some(p => p.id === entries[0].bucket_id), 'kept bucket_id resolves to a persisted entry');
});

test('a unique suffix match hashes the matched candidate file, not cwd/entry.path', async () => {
  // The kept path src/server.js uniquely suffix-matches api/src/server.js (which exists on disk);
  // cwd/src/server.js does NOT exist. hp must be the matched file's hash, not null.
  await ctx.touchBucketPaths(['api/src/server.js']);   // helper writes the real file under cwd/api/src/
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'src/server.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].match_status, 'exact');
  assert.match(entries[0].hp, /^[0-9a-f]{64}$/, 'hp is the matched candidate file hash, not null from a non-existent cwd/src/server.js');
});

test('total_line_count is bounded and never buffers an over-cap file', async () => {
  // A binary/huge file must yield null (over-cap) rather than a full utf8 string + split array — and it
  // must do so via the SIZE GATE, not the unmatched short-circuit. touchBucketPaths makes big.bin a real
  // bucket CANDIDATE, so the kept path binds match_status='exact' + a non-null hashTarget →
  // countFileLinesBounded ACTUALLY RUNS on it. We then grow the physical file past HASH_MAX_BYTES so the
  // statSync gate (st.size > HASH_MAX_BYTES) is what returns null. Asserting match_status==='exact' proves
  // the count came from the size gate, not from hashTarget=null (which would pass even if the gate were
  // deleted). A write-only file would classify as 'unmatched' and never invoke countFileLinesBounded.
  const { HASH_MAX_BYTES } = await import('../lib/handoff.js');
  const [big] = await ctx.touchBucketPaths(['big.bin']);   // real candidate + on-disk file (small content)
  const fd = openSync(big, 'r+'); ftruncateSync(fd, HASH_MAX_BYTES + 1); closeSync(fd);   // now OVER cap
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'big.bin' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  assert.equal(entries[0].match_status, 'exact', 'it matched a candidate → countFileLinesBounded ran (not the unmatched short-circuit)');
  assert.equal(entries[0].total_line_count, null, 'over-cap file → null via the size gate, never buffered/split');
});

test('total_line_count has no trailing-newline off-by-one; empty file → 0', async () => {
  // touchBucketPaths so both files are matched bucket candidates (total_line_count counts the MATCHED
  // candidate's physical file; a write-only path is unmatched → count=null). Content differs per file.
  await ctx.touchBucketPaths(['two.js'], { content: 'line1\nline2\n' });   // 2 logical lines
  await ctx.touchBucketPaths(['empty.js'], { content: '' });
  const { token } = await ctx.prepareHandoffFull({ paths_to_keep: [{ path: 'two.js' }, { path: 'empty.js' }], summary: 's' });
  const stored = JSON.parse(ctx.store._db.prepare("SELECT paths_to_keep FROM handoff WHERE load_token=?").get(token).paths_to_keep);
  const entries = Array.isArray(stored) ? stored : stored.paths;
  const two = entries.find(e => e.path.endsWith('two.js'));
  const empty = entries.find(e => e.path.endsWith('empty.js'));
  assert.equal(two.total_line_count, 2, 'trailing newline does not inflate the count to 3');
  assert.equal(empty.total_line_count, 0, 'empty file is 0 lines, not 1');
});
