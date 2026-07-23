import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatcher, feedReadFull, feedReadRange, feedAssistantStep, feedLoadHandoffStep,
         feedGrepMultiFile, feedSidechainToolUse, feedSidechainRead, feedRevisionWithLoadToken,
         feedAutoMatchLoadStep, forceSegmentBoundary } from './helpers/fold-feed.js';

test('a full-file Read touch is buffered with isFullRead=1 and tool_type=Read', async () => {
  const w = makeWatcher();
  feedReadFull(w, '/proj/a.js', 'export const x=1;\n'.repeat(20));   // requestedFull + looksComplete
  const evs = w._segmentPathEvents;
  const read = evs.find(e => e.path.endsWith('a.js'));
  assert.ok(read);
  assert.equal(read.toolType, 'Read');
  assert.equal(read.isFullRead, 1);
  assert.equal(typeof read.foldedSeq, 'number');
});

test('a line-subset Read touch is buffered with isFullRead=0 and carries rawPath', async () => {
  const w = makeWatcher();
  feedReadRange(w, '/proj/a.js', { offset: 10, limit: 5 });
  const read = w._segmentPathEvents.find(e => e.path.endsWith('a.js'));
  assert.equal(read.isFullRead, 0);
  assert.equal(read.rawPath, '/proj/a.js', 'the tool\'s original path string is preserved alongside the resolved path');
});

test('each folded API step buffers one step_usage record with all four token classes + tool_calls', async () => {
  const w = makeWatcher();
  feedAssistantStep(w, { input: 100, output: 50, cacheRead: 4000, cacheCreation: 200, toolUses: 2 });
  const steps = w._segmentStepUsage;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].input, 100);
  assert.equal(steps[0].output, 50);
  assert.equal(steps[0].cacheRead, 4000);
  assert.equal(steps[0].cacheCreation, 200);
  assert.equal(steps[0].toolCalls, 2);
});

test('a load_handoff tool_use stamps load_token onto its step; other steps have loadToken=null', async () => {
  const w = makeWatcher();
  feedLoadHandoffStep(w, { loadToken: 'carry-lyric-gear' });
  const withTok = w._segmentStepUsage.find(s => s.loadToken === 'carry-lyric-gear');
  assert.ok(withTok, 'load step tagged with the token');
  feedAssistantStep(w, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolUses: 0 });
  assert.ok(w._segmentStepUsage.some(s => s.loadToken == null), 'non-load steps null');
});

test('a multi-file Grep buffers one path_event PER file with is_full_read=0', async () => {
  // The Grep adapter's extractPath returns null and the files live in update.files, so a single
  // `if(pending.path)` push would capture ZERO grep touches. Must fan out.
  const w = makeWatcher();
  feedGrepMultiFile(w, ['/proj/a.js', '/proj/b.js', '/proj/c.js']);
  const grepEvents = w._segmentPathEvents.filter(e => e.toolType === 'Grep');
  assert.equal(grepEvents.length, 3, 'one event per matched file, not zero');
  assert.ok(grepEvents.every(e => e.isFullRead === 0), 'grep is a partial read');
  const seqs = new Set(grepEvents.map(e => e.foldedSeq));
  assert.equal(seqs.size, 1, 'all fan-out files share the issuing step seq (FK holds)');
});

test('segmentReset clears the telemetry buffers (no watcher-global pending fields exist)', async () => {
  const w = makeWatcher();
  feedAssistantStep(w, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolUses: 0 });
  assert.ok(w._segmentStepUsage.length > 0);
  w.segmentReset();
  assert.equal(w._segmentStepUsage.length, 0);
  assert.equal(w._segmentPathEvents.length, 0);
  // Step metadata is entry-local (processToolEvents returns it), so there are no
  // _pendingLoadToken/_pendingToolUseCount fields to leak or to clear here.
  assert.equal(w._pendingLoadToken, undefined, 'no watcher-global pending token field exists (entry-local design)');
  assert.equal(w._pendingToolUseCount, undefined, 'no watcher-global pending count field exists (entry-local design)');
});

test('a sidechain/synthetic tool_use does NOT leak its count/token into the next real step', async () => {
  // processToolEvents runs on every entry incl. sidechain ones, but foldEntries skips foldCall for them
  // (u.isSidechain). Because step metadata is RETURNED per-entry and only the real entry's stepMeta
  // reaches foldCall, the sidechain's count/token is discarded — it cannot reach a later step
  // regardless of resets.
  const w = makeWatcher();
  feedSidechainToolUse(w, { toolUses: 3, loadToken: 'ghost' });   // sub-agent activity, no main usage row
  feedAssistantStep(w, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolUses: 1 });
  const step = w._segmentStepUsage.at(-1);
  assert.equal(step.toolCalls, 1, 'only THIS step\'s tool_use counted, not the sidechain\'s 3');
  assert.equal(step.loadToken, null, 'sidechain load token did not bleed onto a later step');
});

test('a sidechain Read/Grep tool_result does NOT create a main-segment path_event', async () => {
  // processToolEvents runs on every entry incl. sidechain, and the path-event push lives inside it —
  // so a sub-agent's Read would be recorded as a main-chain touch at the main chain's _foldedCallSeq
  // unless gated. Drive a sidechain Read and assert zero touches.
  const w = makeWatcher();
  feedSidechainRead(w, '/proj/ghost.js', 'export const ghost = 1;\n'.repeat(10));   // sub-agent file read
  assert.equal(w._segmentPathEvents.filter(e => e.path.endsWith('ghost.js')).length, 0,
    'a sidechain file touch is excluded from main-segment telemetry');
  // A subsequent MAIN-chain read is still captured normally.
  feedReadFull(w, '/proj/real.js', 'export const real = 1;\n'.repeat(10));
  assert.ok(w._segmentPathEvents.some(e => e.path.endsWith('real.js')), 'main-chain touch still captured');
});

test('a snapshot-REVISED step updates its buffered token values and captures a late load_token', async () => {
  // The revision branch (fold.js:136-155) returns before the new-call push, so without refreshing the
  // buffered step it keeps pre-revision tokens and loses a load_token that only appears in a revision.
  // Feed a step, then a same-message-id revision with higher output + a load_token.
  const w = makeWatcher();
  feedAssistantStep(w, { input: 100, output: 50, cacheRead: 4000, cacheCreation: 0, toolUses: 0 });
  const seq = w._segmentStepUsage.at(-1).foldedSeq;
  // Re-emit the SAME step (same message id) with grown output + a load_handoff that was absent before.
  feedRevisionWithLoadToken(w, { foldedSeq: seq, input: 100, output: 180, cacheRead: 4000, cacheCreation: 0, loadToken: 'carry-late-token' });
  const rows = w._segmentStepUsage.filter(s => s.foldedSeq === seq);
  assert.equal(rows.length, 1, 'still one buffered row for the revised foldedSeq');
  assert.equal(rows[0].output, 180, 'buffered output tracks the accepted revision, not the pre-revision value');
  assert.equal(rows[0].loadToken, 'carry-late-token', 'a load_token that first appears in a revision is captured, not lost');
});

test('an AUTO-MATCH load (no input.load_token) back-fills the resolved token from the tool_result', async () => {
  // An auto-match/query load_handoff carries no input.load_token, so reading only the input leaves
  // load_token NULL and breaks the handoff→usage linkage. The tool_result returns the resolved token
  // (formatHandoffFull) → fold back-fills it onto the issuing step by tool_use_id.
  const w = makeWatcher();
  feedAutoMatchLoadStep(w, { resolvedToken: 'carry-auto-resolved' });   // tool_use has NO load_token input; result carries it
  const withTok = w._segmentStepUsage.find(s => s.loadToken === 'carry-auto-resolved');
  assert.ok(withTok, 'the resolved token from the tool_result is stamped onto the load step');
});

test('foldedSeq does NOT reset across a segment boundary (step coordinate invariant)', async () => {
  const w = makeWatcher();
  feedAssistantStep(w, { input: 100, output: 10, cacheRead: 4000, cacheCreation: 0, toolUses: 0 });
  const seg0Seqs = w._segmentStepUsage.map(s => s.foldedSeq);
  forceSegmentBoundary(w);   // archive + segmentReset
  feedAssistantStep(w, { input: 20, output: 5, cacheRead: 4200, cacheCreation: 0, toolUses: 0 });
  const seg1Seqs = w._segmentStepUsage.map(s => s.foldedSeq);
  assert.ok(Math.max(...seg1Seqs) > Math.max(...seg0Seqs), 'foldedSeq strictly increases across the boundary');
});
