// test/watcher.fold.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }
function asst(id, uuid, cacheRead, output, extra = {}) {
  return { type: 'assistant', uuid, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8', usage: {
      input_tokens: 2, output_tokens: output,
      cache_creation_input_tokens: 2446, cache_read_input_tokens: cacheRead } }, ...extra };
}

function tmpJsonl(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);
  return p;
}

// A real human turn boundary: a `type:'user'` line with a STRING content (no tool_result block),
// non-sidechain — exactly what isUserTurnBoundary (lib/extract.js) treats as a new turn. Used by the
// v2.1 sample-builder test to prove two real turns in one poll yield two distinct per-record turnSeqs.
function user(text) {
  return { type: 'user', uuid: 'u_' + text, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { role: 'user', content: text } };
}

// Id-less assistant row: message.id OMITTED (→ extractUsage messageId === null), carrying a
// top-level `requestId` (sibling to type/message, per lib/extract.js:58). Models a provider that
// streams snapshots of one call without a message.id — the H4 defensive path.
function asstNoId(uuid, cacheRead, output, requestId, extra = {}) {
  const row = { type: 'assistant', uuid, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { model: 'claude-opus-4-8', usage: {
      input_tokens: 2, output_tokens: output,
      cache_creation_input_tokens: 2446, cache_read_input_tokens: cacheRead } }, ...extra };
  if (requestId != null) row.requestId = requestId;
  return row;
}

test('snapshot folding: same message.id, different uuid, growing output → 1 call, max output', () => {
  const p = tmpJsonl(
    line(asst('msg_1', 'uuidA', 137000, 1)) +
    line(asst('msg_1', 'uuidB', 137000, 110)) // later snapshot, bigger output
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'folded to a single API-call');
  assert.equal(w._calls[0].output, 110, 'kept the max-token snapshot');
});

test('folding by uuid would double-count — guard asserts message.id semantics', () => {
  const p = tmpJsonl(line(asst('msg_1', 'uuidA', 137000, 1)) + line(asst('msg_1', 'uuidB', 137000, 110)));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  // If someone regresses to uuid dedup, this becomes 2 and the test fails loudly.
  assert.notEqual(w._calls.length, 2);
});

test('sidechains are skipped', () => {
  const p = tmpJsonl(
    line(asst('msg_1', 'u1', 100000, 50)) +
    line(asst('msg_2', 'u2', 101000, 50, { isSidechain: true }))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1);
});

test('L-drop starts a new segment', () => {
  const p = tmpJsonl(
    line(asst('m1', 'u1', 100000, 10)) +
    line(asst('m2', 'u2', 150000, 10)) +
    line(asst('m3', 'u3', 30000, 10))   // /clear → drop below segmentMaxL
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  const segs = new Set(w._calls.map(c => c.segment));
  assert.equal(segs.size, 2, 'two segments after one L-drop');
  assert.equal(w._calls[2].segment, w._calls[0].segment + 1);
});

test('a late snapshot of an existing message.id does NOT trigger a false L-drop segment', () => {
  // m1@100k, m2@200k, then a late m1 snapshot (lower cacheRead) with grown output.
  // Snapshot folding must happen BEFORE L-drop check → still one segment, m1.output updated.
  const p = tmpJsonl(
    line(asst('m1', 'u1a', 100000, 5)) +
    line(asst('m2', 'u2', 200000, 5)) +
    line(asst('m1', 'u1b', 100000, 90))   // late snapshot of m1, output grew 5→90
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'no false segment from a late snapshot');
  assert.equal(w._calls.length, 2, 'still two unique calls');
  assert.equal(w._calls[0].output, 90, 'm1 snapshot updated to max-token');
});

test('incremental read: appended lines are picked up, no re-count', () => {
  const p = tmpJsonl(line(asst('m1', 'u1', 100000, 10)));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1);
  appendFileSync(p, line(asst('m2', 'u2', 101000, 10)));
  const { newCalls } = w.poll();
  assert.equal(newCalls, 1);
  assert.equal(w._calls.length, 2);
});

test('partial trailing line (no newline) is not parsed until completed', () => {
  const p = tmpJsonl(line(asst('m1', 'u1', 100000, 10)) + '{"type":"assistant","mess');
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'partial line held back');
  writeFileSync(p, line(asst('m1', 'u1', 100000, 10)) + line(asst('m2', 'u2', 101000, 10)));
  w.poll();
  assert.equal(w._calls.length, 2);
});

test('partial trailing line is completed by APPENDING the remainder (true incremental path)', () => {
  // Unlike the rewrite-based test above (which completes the partial via a whole-file writeFileSync
  // that only stays valid because the discarded prefix and the buffered partial are equal-length),
  // this test exercises the REAL append-only path: the buffered `_partial` fragment is never
  // re-written — only the bytes that complete it are appended. This locks the _offset/_partial
  // hold-back math (poll prepends _partial to newly-appended bytes on the next read).
  const full = line(asst('m2', 'u2', 101000, 55)); // the line that will be split across two polls
  const cut = 73;                                  // mid-line byte cut: not a '\n', and != first line's length (250)
  const head = full.slice(0, cut);                 // genuine partial fragment, no trailing newline
  const tail = full.slice(cut);                    // remaining bytes; `full` already ends in '\n', so tail carries it
  assert.ok(!head.includes('\n'), 'split is genuinely mid-line (no newline in head)');

  // Initial state: one COMPLETE line + a partial fragment (setup only).
  const p = tmpJsonl(line(asst('m1', 'u1', 100000, 10)) + head);

  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'only the complete line folded; partial held back in _partial, NOT parsed');

  // Append ONLY the remainder that completes the previously-buffered fragment (true incremental path).
  appendFileSync(p, tail);
  w.poll();
  assert.equal(w._calls.length, 2, 'buffered _partial prepended to appended bytes → the second line now parses');

  // Value assertions (not just count): prove _partial was correctly stitched to the appended bytes
  // and parsed into the RIGHT record — the exact fields encoded in the split line.
  const completed = w._calls[1];
  assert.equal(completed.messageId, 'm2', 'completed call has the messageId from the split line');
  assert.equal(completed.cacheRead, 101000, 'completed call has the cacheRead from the split line');
  assert.equal(completed.output, 55, 'completed call has the output from the split line');
});

// ── H4: id-less streaming snapshots fold by requestId fallback ─────────────────────────────────
test('H4: two id-less snapshots sharing one requestId, growing output → 1 call, max output', () => {
  // No message.id on either row (messageId null); both carry the SAME requestId. Mirrors the
  // "snapshot folding" test but on the id-less defensive path — must fold by requestId fallback.
  const p = tmpJsonl(
    line(asstNoId('uuidA', 137000, 1, 'req_1')) +
    line(asstNoId('uuidB', 137000, 110, 'req_1')) // later snapshot, bigger output
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'id-less snapshots folded by requestId to a single API-call');
  assert.equal(w._calls[0].output, 110, 'kept the max-token snapshot');
  assert.equal(w._calls[0].messageId, null, 'stored messageId field stays raw (null), only dedup key changed');
});

test('H4: two id-less rows with DIFFERENT requestIds → stay 2 separate calls', () => {
  // Distinct requestIds must NOT fold — the fallback dedups within a request, not across requests.
  const p = tmpJsonl(
    line(asstNoId('uuidA', 137000, 5, 'req_1')) +
    line(asstNoId('uuidB', 138000, 5, 'req_2'))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 2, 'different requestIds do not over-fold');
});

test('H4: messageId still wins when a row has BOTH message.id and requestId', () => {
  // Both snapshots carry the same message.id AND the same requestId. foldKey must resolve to
  // message.id (preferred), preserving existing behavior → still folds to 1.
  const p = tmpJsonl(
    line(asst('msg_1', 'uuidA', 137000, 1, { requestId: 'req_1' })) +
    line(asst('msg_1', 'uuidB', 137000, 110, { requestId: 'req_1' }))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'message.id-keyed folding still collapses to one call');
  assert.equal(w._calls[0].output, 110, 'kept the max-token snapshot');
  assert.equal(w._calls[0].messageId, 'msg_1', 'stored messageId is the raw message.id');
});

test('H4: fully id-less AND requestId-less rows (both null) never fold → 2 calls', () => {
  // foldKey === null for both rows; the null-key guard must prevent them collapsing into one.
  const p = tmpJsonl(
    line(asstNoId('uuidA', 137000, 5, null)) +
    line(asstNoId('uuidB', 138000, 5, null))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 2, 'null foldKey rows stay separate (no null-key collapse)');
  assert.equal(w._calls[0].messageId, null);
  assert.equal(w._calls[1].messageId, null);
});

// ── v2.1 (RV-C7): sample builder threads each call's REAL per-record turnSeq (A3) ──────────────────
test('round-6 RV-C7: sample builder carries each call\'s REAL turnSeq (two turns in one poll → two turnSeqs)', () => {
  // user#1 → asst(call A) ; user#2 → asst(call B), all written before ONE poll. Task 2.7 stamps callA
  // turnSeq=1, callB turnSeq=2. The sample builder must reflect that (NOT collapse both to one turn).
  const p = tmpJsonl(
    line(user('first task')) + line(asst('msg_1', 'uuidA', 60000, 10)) +
    line(user('second task')) + line(asst('msg_2', 'uuidB', 90000, 10))
  );
  const w = new SessionWatcher(p, 42000); w.poll();
  const samples = w.rateLampSamplesSince(0, { B_post: 55000, B_rebuild: 55000, cRatio: 10, reliable: true });
  const turns = new Set(samples.map(s => s.turnSeq));
  assert.equal(turns.size, 2, 'two real turns in one poll produce two distinct sample turnSeqs (not collapsed)');
});
