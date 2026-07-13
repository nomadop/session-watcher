import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { isUserTurnBoundary } from '../lib/extract.js';

const line = (obj) => JSON.stringify(obj) + '\n';
const asst = (id, uuid, cacheRead, output) => line({ type: 'assistant', uuid, isSidechain: false,
  timestamp: '2026-07-01T00:00:00Z', message: { id, model: 'claude-opus-4-8',
    usage: { input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 2446, cache_read_input_tokens: cacheRead } } });
// a real human user turn boundary line (string content — NOT a tool_result, NOT sidechain).
const user = (text) => line({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
// a tool_result "user" line (assistant turn continuing) — must NOT bump turnSeq.
const toolResult = () => line({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
// a sidechain user line — must NOT bump turnSeq (round-7 GPT#5).
const sidechainUser = (text) => line({ type: 'user', isSidechain: true, message: { role: 'user', content: text } });
const tmpJsonl = (content) => { const p = join(mkdtempSync(join(tmpdir(), 'sw-turnseq-')), 's.jsonl'); writeFileSync(p, content); return p; };

test('RV-C7: a single poll ingesting TWO real turns stamps two distinct turnSeq values', () => {
  // user#1 → two distinct assistant calls (turn 1) → user#2 → one assistant call (turn 2), ONE poll.
  const p = tmpJsonl(
    user('first task') + asst('m1', 'u1', 60000, 10) + asst('m2', 'u2', 61000, 10) +
    user('second task') + asst('m3', 'u3', 62000, 10));
  const w = new SessionWatcher(p, 42000); w.poll();
  const calls = w._currentSegmentCalls();
  assert.equal(calls[0].turnSeq, calls[1].turnSeq, 'two calls of the same user turn share a turnSeq');
  assert.notEqual(calls[2].turnSeq, calls[1].turnSeq, 'the call after the 2nd user message is a NEW turn');
  assert.equal(w._turnSeq, calls[2].turnSeq, 'watcher._turnSeq tracks the latest real turn');
});

test('RV-C7: two calls of ONE assistant turn (no intervening user msg) share a turnSeq', () => {
  const p = tmpJsonl(user('go') + asst('m1', 'u1', 60000, 10) + asst('m2', 'u2', 61000, 10));
  const w = new SessionWatcher(p, 42000); w.poll();
  const c = w._currentSegmentCalls();
  assert.equal(c[0].turnSeq, c[1].turnSeq);
});

test('RV-C7: a tool_result user line does NOT start a new turn (assistant turn continuing)', () => {
  const p = tmpJsonl(user('go') + asst('m1', 'u1', 60000, 10) + toolResult() + asst('m2', 'u2', 61000, 10));
  const w = new SessionWatcher(p, 42000); w.poll();
  const c = w._currentSegmentCalls();
  assert.equal(c[0].turnSeq, c[1].turnSeq, 'tool_result did not split the turn');
});

test('RV-C7 (round-7 GPT#5): a sidechain user line does NOT start a new turn', () => {
  const p = tmpJsonl(user('go') + asst('m1', 'u1', 60000, 10) + sidechainUser('sub-agent') + asst('m2', 'u2', 61000, 10));
  const w = new SessionWatcher(p, 42000); w.poll();
  const c = w._currentSegmentCalls();
  assert.equal(c[0].turnSeq, c[1].turnSeq, 'sidechain user line did not split the real turn');
});

test('RV-C7: turnSeq is monotonic and stable across a poll that adds no new calls', () => {
  const p = tmpJsonl(user('go') + asst('m1', 'u1', 60000, 10));
  const w = new SessionWatcher(p, 42000); w.poll(); const t = w._turnSeq; w.poll();
  assert.equal(w._turnSeq, t, 'a no-new-calls poll does not bump turnSeq (not per-poll)');
});

test('RV-C7: _foldedCallSeq increments once per genuinely new call, not per snapshot fold', () => {
  // same message.id, growing output = an output-only snapshot re-fold → NOT a new call.
  const p = tmpJsonl(user('go') + asst('m1', 'u1', 60000, 10));
  const w = new SessionWatcher(p, 42000); w.poll(); const seqAfterNew = w._foldedCallSeq;
  writeFileSync(p, user('go') + asst('m1', 'u1', 60000, 99)); // re-fold m1 with bigger output
  w.poll();
  assert.equal(w._foldedCallSeq, seqAfterNew, 'snapshot fold does not advance the folded-call seq');
});

test('round-8 GPT#1: an eligible-empty turn advances _turnSeq (the boundary rule for the R6-A1/R7-1 TTL fix)', () => {
  // The R6-A1/R7-1 lifecycle fix requires that a real new turn advances the observed turnSeq even when it
  // produces NO integrable rate-lamp sample. Because a Stop boundary ALWAYS follows ≥1 assistant call, the
  // "empty" case in practice is "the assistant call bumped _turnSeq but its sample was gated out (unreliable
  // / pre-latch)" — NOT "a user line with zero following assistant calls." This fixture pins the rule the
  // manager relies on: user#2's assistant call bumps _turnSeq to a NEW value distinct from user#1's turn,
  // so syncLedgerTurn(ledger, w._turnSeq) has a moved cursor to sync (expiring the prior turn's pulse TTL).
  const p = tmpJsonl(user('t1') + asst('m1', 'u1', 60000, 10) + user('t2') + asst('m2', 'u2', 61000, 10));
  const w = new SessionWatcher(p, 42000); w.poll();
  const c = w._currentSegmentCalls();
  assert.equal(w._turnSeq, c[1].turnSeq, '_turnSeq reflects the latest real turn');
  assert.ok(c[1].turnSeq > c[0].turnSeq, 'the second real turn is a strictly higher turnSeq — a cursor the manager can advance to');
  // NOTE (round-8 GPT#1 rule): a boundary with NO following assistant call defers its bump (_pendingTurnBump
  // stays set) — but such a turn has no Stop-relevant work and no folded call to mis-attribute, so the ledger
  // simply doesn't advance for it. The Stop route only fires AFTER an assistant call, at which point the bump
  // has committed. This is the intended semantics, not the R6-A1 gap (which was about eligible-sample-empty turns).
});

// isUserTurnBoundary predicate unit tests (pure — no watcher needed)
test('RV-C7: a tool_result user line is NOT a turn boundary (assistant turn continuing)', () => {
  assert.equal(isUserTurnBoundary({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }), false);
  assert.equal(isUserTurnBoundary({ type: 'user', message: { content: 'do the next thing' } }), true, 'real human text IS a boundary');
});
test('RV-C7 (round-7 GPT#5): a sidechain user line is NOT a turn boundary', () => {
  assert.equal(isUserTurnBoundary({ type: 'user', isSidechain: true, message: { content: 'sub-agent prompt' } }), false,
    'sidechain user line must not bump turnSeq — consistent with extractUsage skipping sidechain');
});
