// Shared fold-feed harness for the carry-staleness telemetry tests (Task 0).
//
// WHY THIS EXISTS: every later task's test (Tasks 4,5,6,8,9,10,11) needs to drive the REAL fold
// pipeline incrementally — one assistant step, one Read, one segment boundary at a time — and inspect
// the resulting watcher state. The existing suite only has a whole-file `tmpJsonl([...]) + poll()`
// pattern; `foldEntries`/`extractUsage` are NOT exported. Re-deriving fold-ordering / is_full_read
// semantics inside six new test files would drift on the most error-prone surface. This factors it once.
//
// DESIGN: the feeder is strictly "append JSONL line(s) to a temp file, then `poll()`" — the ONLY
// supported entry point (SessionWatcher#poll → lib/fold.js poll). It never re-implements foldEntries and
// never imports the private extractUsage/foldEntries. Every helper therefore exercises the exact fold
// order, segmentation, and adapter B-update path production uses. See test/helpers/README-less note:
// the golden JSONL shapes are copied verbatim from real fixtures (verified against test/fold.*.test.js).

import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../../lib/watcher.js';
import { archiveCurrentSegment } from '../../lib/fold.js';

// ── Internal: per-watcher append target ─────────────────────────────────────
// Each makeWatcher() gets a fresh temp JSONL file; we stash its path + a monotonic id counter on the
// watcher via a side WeakMap so feed* helpers can append + poll without threading extra args.
const _feedState = new WeakMap();

function _state(w) {
  const s = _feedState.get(w);
  if (!s) throw new Error('fold-feed: watcher was not created via makeWatcher()');
  return s;
}

// Append one JSONL entry (object) or many (array) to the watcher's temp file, then poll() once so the
// real fold pipeline consumes them together (mirrors production: CC appends lines, the poll tick reads
// the new bytes). Returns the poll() result ({ newCalls, changed }).
function _appendAndPoll(w, entries) {
  const s = _state(w);
  const arr = Array.isArray(entries) ? entries : [entries];
  appendFileSync(s.path, arr.map(e => JSON.stringify(e)).join('\n') + '\n');
  return w.poll();
}

// Monotonic per-watcher ids for uuid / message.id / tool_use id so distinct steps never collide and the
// fold pipeline sees a linear, single-branch transcript (parentUuid chained → no spurious replay/fork).
function _nextIds(w) {
  const s = _state(w);
  const n = s.seq++;
  const uuid = `a${n}`;
  const parent = s.lastUuid;
  s.lastUuid = uuid;
  return { n, uuid, parent };
}

// ── makeWatcher ─────────────────────────────────────────────────────────────
// A SessionWatcher over a fresh temp JSONL file, poll()-ready. sessionId is LEFT UNSET by default so the
// archival guard in handleSegmentBoundary (`if (w._sessionId …)`) is a no-op during pure fold-capture
// tests — those don't wire a store, and archival with no store would throw (swallowed, but pointless).
// Tests that need archival pass a sessionId (or use feedSegment*/setupStore) and wire a store.
export function makeWatcher({ sessionId, projectId, cwd } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-feed-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, ''); // create empty file so readNewText opens it (marks _transcriptSeen)
  const opts = {};
  if (sessionId != null) opts.sessionId = sessionId;
  if (projectId != null) opts.projectId = projectId;
  if (cwd != null) opts.cwd = cwd;
  const w = new SessionWatcher(path, null, opts);
  _feedState.set(w, { path, dir, seq: 0, lastUuid: null });
  return w;
}

// ── Assistant step (usage row) ──────────────────────────────────────────────
// Append one assistant entry carrying a `usage` row (all four token classes) + `toolUses` empty tool_use
// blocks, then poll(). `toolUses` defaults to 0. Token classes map to the real usage field names
// (extract.js): input→input_tokens, output→output_tokens, cacheRead→cache_read_input_tokens,
// cacheCreation→cache_creation_input_tokens.
export function feedAssistantStep(w, { input = 0, output = 0, cacheRead = 0, cacheCreation = 0, toolUses = 0, model = 'claude-opus-4-8' } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  const content = [];
  // Use a non-adapter, non-Bash, non-mcp__ tool name: processToolEvents just `continue`s past it (no
  // _pendingResidual bookkeeping), so the step carries `toolUses` countable tool_use blocks without any
  // residual side-effect that would pollute a later bucket assertion.
  for (let i = 0; i < toolUses; i++) {
    content.push({ type: 'tool_use', id: `tu${n}_${i}`, name: 'TodoWrite', input: {} });
  }
  return _appendAndPoll(w, {
    type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
    timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
    message: {
      id: `m${n}`, model,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation },
      content,
    },
  });
}

// ── Read (full) ─────────────────────────────────────────────────────────────
// Append an assistant Read tool_use (NO offset/limit) + the matching tool_result user entry whose text is
// real Read output ("N\tcontent" tab-numbered lines) with NO 'truncated'/'use offset'/'too large' — so
// measure.js's Read adapter marks is_full_read (fullSet). Then poll(). The tool_use carries a usage row so
// it folds AND the following tool_result applies the B update (processToolEvents runs per-entry).
export function feedReadFull(w, absPath, content, { cacheRead = 10000, output = 5 } = {}) {
  const numbered = _numberLines(content);
  return _feedReadCommon(w, absPath, {}, numbered, { cacheRead, output });
}

// ── Read (range) ────────────────────────────────────────────────────────────
// Same as feedReadFull but with offset/limit on the tool_use input → the adapter yields a lineUpdate
// (is_full_read=0) even when the result is untruncated. Synthesizes numbered result lines for the range.
export function feedReadRange(w, absPath, { offset = 0, limit = 5 } = {}, { cacheRead = 10000, output = 5 } = {}) {
  const lines = [];
  for (let i = 0; i < limit; i++) lines.push(`${offset + i + 1}\tconst line_${offset + i} = ${i};`);
  const numbered = lines.join('\n') + '\n';
  return _feedReadCommon(w, absPath, { offset, limit }, numbered, { cacheRead, output });
}

// Shared Read feeder: assistant(tool_use Read) → user(tool_result) → both folded in one poll().
// The tool_use assistant entry carries a usage row so the step folds; processToolEvents processes the
// tool_result within the same batch and applies the adapter B update.
function _feedReadCommon(w, absPath, extraInput, resultText, { cacheRead, output }) {
  const { n, uuid, parent } = _nextIds(w);
  const tuId = `tu${n}`;
  const s = _state(w);
  const userUuid = `u${n}`;
  s.lastUuid = userUuid; // chain the tool_result user entry as the next parent
  return _appendAndPoll(w, [
    { type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
      timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
      message: { id: `m${n}`, model: 'claude-opus-4-8',
        usage: { cache_read_input_tokens: cacheRead, output_tokens: output },
        content: [{ type: 'tool_use', id: tuId, name: 'Read', input: { file_path: absPath, ...extraInput } }] } },
    { type: 'user', uuid: userUuid, parentUuid: uuid, isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: tuId, content: resultText }] } },
  ]);
}

// ── load_handoff steps ──────────────────────────────────────────────────────
// Assistant entry whose tool_use is mcp__…__load_handoff with input.load_token = loadToken.
export function feedLoadHandoffStep(w, { loadToken, cacheRead = 10000, output = 5 } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  return _appendAndPoll(w, {
    type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
    timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
    message: { id: `m${n}`, model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: cacheRead, output_tokens: output },
      content: [{ type: 'tool_use', id: `tu${n}`, name: 'mcp__session-watcher__load_handoff', input: { load_token: loadToken } }] },
  });
}

// Auto-match / query load: tool_use has NO input.load_token; the matching tool_result user entry carries
// the JSON formatHandoffFull returns (found:true, load_token: resolvedToken, …) — exercises the
// tool_result token back-fill. Both entries folded in one poll().
export function feedAutoMatchLoadStep(w, { resolvedToken, cacheRead = 10000, output = 5 } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  const tuId = `tu${n}`;
  const s = _state(w);
  const userUuid = `u${n}`;
  s.lastUuid = userUuid;
  const resultPayload = JSON.stringify({ found: true, load_token: resolvedToken, handoff_id: n, created_at: Date.now(), summary: 'auto-match', next_task: null, paths_to_keep: [] });
  return _appendAndPoll(w, [
    { type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
      timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
      message: { id: `m${n}`, model: 'claude-opus-4-8',
        usage: { cache_read_input_tokens: cacheRead, output_tokens: output },
        content: [{ type: 'tool_use', id: tuId, name: 'mcp__session-watcher__load_handoff', input: {} }] } },
    { type: 'user', uuid: userUuid, parentUuid: uuid, isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: tuId, content: resultPayload }] } },
  ]);
}

// ── Grep (multi-file) ───────────────────────────────────────────────────────
// Assistant Grep tool_use + a tool_result whose payload is `path:lineNum:content` lines across multiple
// files, so the Grep adapter's computeUpdate yields update.type==='grepMultiFile' with update.files keyed
// by each absPath. Both entries folded in one poll().
export function feedGrepMultiFile(w, absPaths, { cacheRead = 10000, output = 5 } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  const tuId = `tu${n}`;
  const s = _state(w);
  const userUuid = `u${n}`;
  s.lastUuid = userUuid;
  const lines = [];
  for (const p of absPaths) {
    lines.push(`${p}:1:const first = require('x');`);
    lines.push(`${p}:2:module.exports = first;`);
  }
  const resultText = lines.join('\n') + '\n';
  return _appendAndPoll(w, [
    { type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
      timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
      message: { id: `m${n}`, model: 'claude-opus-4-8',
        usage: { cache_read_input_tokens: cacheRead, output_tokens: output },
        content: [{ type: 'tool_use', id: tuId, name: 'Grep', input: { pattern: 'require' } }] } },
    { type: 'user', uuid: userUuid, parentUuid: uuid, isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: tuId, content: resultText }] } },
  ]);
}

// ── Sidechain fixtures ──────────────────────────────────────────────────────
// A sidechain assistant entry (isSidechain: true) carrying toolUses tool_use blocks (+ optional
// load_handoff). processToolEvents still runs on it, but foldCall is skipped (foldEntries drops
// isSidechain usage). The sidechain-leak fixture. Then poll().
export function feedSidechainToolUse(w, { toolUses = 1, loadToken = null, cacheRead = 8000, output = 5 } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  const content = [];
  for (let i = 0; i < toolUses; i++) {
    content.push({ type: 'tool_use', id: `sc${n}_${i}`, name: 'mcp__noop__probe', input: {} });
  }
  if (loadToken != null) {
    content.push({ type: 'tool_use', id: `sc${n}_load`, name: 'mcp__session-watcher__load_handoff', input: { load_token: loadToken } });
  }
  return _appendAndPoll(w, {
    type: 'assistant', uuid, parentUuid: parent, isSidechain: true,
    timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
    message: { id: `m${n}`, model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: cacheRead, output_tokens: output }, content },
  });
}

// A sidechain assistant Read (full) + the matching sidechain tool_result. processToolEvents processes the
// sidechain file tool_result; the touch must NOT be recorded (sidechain excluded from fold). Then poll().
export function feedSidechainRead(w, absPath, content, { cacheRead = 8000, output = 5 } = {}) {
  const { n, uuid, parent } = _nextIds(w);
  const tuId = `sc${n}`;
  const s = _state(w);
  const userUuid = `su${n}`;
  s.lastUuid = userUuid;
  const numbered = _numberLines(content);
  return _appendAndPoll(w, [
    { type: 'assistant', uuid, parentUuid: parent, isSidechain: true,
      timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
      message: { id: `m${n}`, model: 'claude-opus-4-8',
        usage: { cache_read_input_tokens: cacheRead, output_tokens: output },
        content: [{ type: 'tool_use', id: tuId, name: 'Read', input: { file_path: absPath } }] } },
    { type: 'user', uuid: userUuid, parentUuid: uuid, isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: tuId, content: numbered }] } },
  ]);
}

// ── Revision-with-load-token ────────────────────────────────────────────────
// Append an assistant entry re-using the SAME message.id as the step currently at `foldedSeq`, with grown
// token totals so foldCall's _byId snapshot-revision branch is taken AND accepted (totalTok >= _total),
// plus a load_handoff tool_use carrying loadToken. Exercises the revision-path buffered-step update.
// `foldedSeq` is the 1-based _foldedCallSeq of the target call; we look up its messageId in w._calls.
export function feedRevisionWithLoadToken(w, { foldedSeq, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, loadToken = null }) {
  const target = w._calls.find(c => c.foldedSeq === foldedSeq);
  if (!target) throw new Error(`fold-feed: no folded call at foldedSeq=${foldedSeq} to revise`);
  const revisionTotal = (input || 0) + (output || 0) + (cacheRead || 0) + (cacheCreation || 0);
  if (revisionTotal <= 0) throw new Error(`fold-feed: feedRevisionWithLoadToken called with total tokens=0 — revision will be silently rejected (pass grown token values)`);
  const messageId = target.messageId;
  if (messageId == null) throw new Error(`fold-feed: call at foldedSeq=${foldedSeq} has no messageId — cannot drive the revision branch`);
  const s = _state(w);
  const { uuid, parent } = _nextIds(w);
  const content = [];
  if (loadToken != null) {
    content.push({ type: 'tool_use', id: `rev${s.seq}_load`, name: 'mcp__session-watcher__load_handoff', input: { load_token: loadToken } });
  }
  // Reuse messageId so foldKey matches; grow the total so the revision is accepted.
  return _appendAndPoll(w, {
    type: 'assistant', uuid, parentUuid: parent, isSidechain: false,
    timestamp: new Date(1_800_000_000_000 + s.seq * 1000).toISOString(),
    message: { id: messageId, model: 'claude-opus-4-8',
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation },
      content },
  });
}

// ── Segment builders (end-to-end capture) ───────────────────────────────────
// Set w._sessionId=sessionId (so archival is armed), assume the store is already wired by the caller
// (setupStore/bootTestServer), then feed one assistant step plus a Read per touch. touches[i] =
// { path, full } → feedReadFull / feedReadRange.
export function feedSegmentWithTouches(w, sessionId, touches = []) {
  w._sessionId = sessionId;
  feedAssistantStep(w, { input: 500, output: 20, cacheRead: 20000, cacheCreation: 0, toolUses: 0 });
  for (const t of touches) {
    if (t.full === false) feedReadRange(w, t.path, { offset: t.offset ?? 0, limit: t.limit ?? 5 });
    else feedReadFull(w, t.path, t.content ?? 'export const y = 2;\n'.repeat(10));
  }
  return w;
}

// Steps only, no reads — the complete_empty case.
export function feedSegmentNoTouches(w, sessionId) {
  w._sessionId = sessionId;
  feedAssistantStep(w, { input: 500, output: 20, cacheRead: 20000, cacheCreation: 0, toolUses: 0 });
  return w;
}

// One assistant step carrying EXACT token values so a reconciliation test can assert real equality.
// providerTotal is accepted for the caller's convenience (Task 8 reconciles against it) but is NOT
// injected into the usage row — the four token classes are what the provider reports.
export function feedSegmentWithKnownUsage(w, sessionId, { input = 0, cacheRead = 0, cacheCreation = 0, output = 0, providerTotal } = {}) {
  w._sessionId = sessionId;
  feedAssistantStep(w, { input, output, cacheRead, cacheCreation, toolUses: 0 });
  return w;
}

// ── Segment boundary ────────────────────────────────────────────────────────
// Drive the existing boundary path: archiveCurrentSegment(w) archives the dying segment (idempotency-
// guarded; a no-op archival when _sessionId is unset) THEN segmentReset() bumps _segment. Always advances
// the segment. foldedSeq (_foldedCallSeq) is NOT reset by segmentReset → cross-segment monotonicity holds.
export function forceSegmentBoundary(w) {
  archiveCurrentSegment(w);
  return w;
}

// ── Golden transcript builders ──────────────────────────────────────────────
// Emit a valid minimal JSONL STRING containing a cold-start step + a full Read of absPath (for replay
// tests that read a whole file rather than feed incrementally).
export function buildFixtureTranscriptWithFullRead(absPath, { content = 'export const z = 3;\n'.repeat(15) } = {}) {
  const numbered = _numberLines(content);
  const lines = [
    { type: 'assistant', uuid: 'g0', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'gm0', model: 'claude-opus-4-8', usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'gtu0', name: 'Read', input: { file_path: absPath } }] } },
    { type: 'user', uuid: 'gu0', parentUuid: 'g0', isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: 'gtu0', content: numbered }] } },
    { type: 'assistant', uuid: 'g1', parentUuid: 'gu0', isSidechain: false, timestamp: '2026-07-01T00:00:01Z',
      message: { id: 'gm1', model: 'claude-opus-4-8', usage: { cache_read_input_tokens: 15000, output_tokens: 5 }, content: [] } },
  ];
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

// Write buildFixtureTranscriptWithFullRead to a fresh temp file and return its path.
export function writeFixtureTranscriptWithFullRead(sessionId, absPath, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-golden-'));
  const p = join(dir, `${sessionId || 'session'}.jsonl`);
  writeFileSync(p, buildFixtureTranscriptWithFullRead(absPath, opts));
  return p;
}

// A two-session golden transcript for the acceptance test: a producer session that reads keptPath and
// prepares a handoff, and a consumer session that loads it. Returns { producer, consumer } JSONL strings.
export function buildEndToEndFixture({ producerSid, consumerSid, loadToken, keptPath } = {}) {
  const producer = buildFixtureTranscriptWithFullRead(keptPath);
  const consumerLines = [
    { type: 'assistant', uuid: 'c0', isSidechain: false, timestamp: '2026-07-01T01:00:00Z',
      message: { id: 'cm0', model: 'claude-opus-4-8', usage: { cache_read_input_tokens: 9000, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'ctu0', name: 'mcp__session-watcher__load_handoff', input: { load_token: loadToken } }] } },
    { type: 'user', uuid: 'cu0', parentUuid: 'c0', isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: 'ctu0',
        content: JSON.stringify({ found: true, load_token: loadToken, summary: 'carry over', paths_to_keep: [keptPath] }) }] } },
  ];
  const consumer = consumerLines.map(l => JSON.stringify(l)).join('\n') + '\n';
  return { producer, consumer, producerSid, consumerSid };
}

// ── Internal helpers ────────────────────────────────────────────────────────
// Turn raw file content into Read-style tab-numbered output ("N\tcontent") with NO truncation markers,
// so the Read adapter's looksComplete check passes. Guarantees the result is long enough (>=100 chars or
// multiline) that the adapter's "wasted call" short-circuit does not fire.
function _numberLines(content) {
  const raw = String(content ?? '');
  const lines = raw.split('\n');
  // Drop a single trailing empty element from a terminal '\n' so we don't emit a bogus blank numbered line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n';
}
