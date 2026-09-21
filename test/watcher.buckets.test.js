// The bucket read as the shared SessionWatcher composes it: Engine rows split into Skills and files,
// residual groups mapped onto their display families, and the totals the panel reads. The selection
// predicate itself is asserted in test/resource-policy.test.js; what is asserted here is the SHAPE the
// composition hands a consumer, driven through the real Engine and the real Claude Code Projection.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createResourcePolicy } from '../lib/resource-policy.js';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { createClaudeCodeMeasurementProjection } from '../lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse, completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload, interpretClaudeCodeTaskNotification,
} from '../lib/harness/claude-code/native-tools.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import {
  ts, chain, usage, userMessage, assistantObservation, toolResult, skillPayloadRow,
} from './helpers/transcript-fixtures.js';

const NO_ENRICHMENT = {
  warm: () => {}, activeSymbols: () => null, symbolRanges: () => null,
  resolveSymbols: async () => ({ parsed: false, readable: false, resolved: [], stale: [] }),
};

const INERT_STORE = {
  archiveSegmentProfile: () => ({ status: 'archived' }),
  archiveSegmentTelemetry: () => ({ status: 'complete' }),
  findPendingHandoffsByProject: () => ({ status: 'none' }),
  deliverHandoffByToken: () => null,
  listTurnNotes: () => [],
  upsertTurnNotes: () => {},
};

function compose({ projectRoot = null, isIgnored = null } = {}) {
  return new SessionWatcher({
    sessionId: 'sid-buckets',
    sourceLocator: '/t/session.jsonl',
    projectId: projectRoot,
    projectRoot,
    turnNotesRoot: '/state/turn-notes',
    resourcePolicy: createResourcePolicy({ projectRoot, isIgnored }),
    resourceEnrichment: NO_ENRICHMENT,
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store: INERT_STORE,
    dialogueSource: { read: () => ({ status: 'unavailable', observations: [] }) },
    dialogueProjection: {},
    createEngine: createMeasurementEngine,
    createMeasurementProjection: (locator, resolveModelPolicy) => createClaudeCodeMeasurementProjection({
      cwd: projectRoot, projectRoot, sourceLocator: locator, resolveModelPolicy,
      interpretToolUse: interpretClaudeCodeToolUse,
      completeToolResult: completeClaudeCodeToolResult,
      interpretSkillPayload: interpretClaudeCodeSkillPayload,
      interpretTaskNotification: interpretClaudeCodeTaskNotification,
    }),
    modelPolicyFor,
    now: () => 1000,
  });
}

function apply(watcher, entries) {
  const buffer = Buffer.from(chain(entries).map(entry => JSON.stringify(entry) + '\n').join(''));
  const observations = reduceClaudeCodeSnapshot(readClaudeCodeRows(buffer, { atEof: true }).rows).observations;
  return watcher.applyHarnessFrame({ transition: 'append', batches: [observations], sourceObserved: true, captureMode: 'live' });
}

const SKILL_BODY = 'Base directory for this skill: /path\n\n# Brainstorming\n\n' + 'content '.repeat(100);
const numbered = (count, prefix) => Array.from({ length: count }, (unused, i) => `${i + 1}\t${prefix}`).join('\n');

const step = (uuid, messageId, tokens, blocks = []) => assistantObservation({
  uuid, messageId, blocks, timestamp: ts(1), model: 'claude-opus-4-8', usage: usage(tokens),
});

describe('getBucketData', () => {
  test('splits skills from paths and uses the lastTurn field', () => {
    const watcher = compose();
    apply(watcher, [
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      step('a1', 'm1', { input: 10000, output: 5 }, [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a.js' } },
        { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'brainstorming' } },
      ]),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: numbered(2, 'const a = 1;'), timestamp: ts(2) }),
      toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't2', content: 'Launching skill: brainstorming', timestamp: ts(2) }),
      skillPayloadRow({ uuid: 'r3', parentUuid: 'r2', sourceToolUseID: 't2', text: SKILL_BODY, timestamp: ts(2) }),
      step('a2', 'm2', { cacheRead: 20000, output: 5 }),
    ]);
    const bd = watcher.getBucketData();
    assert.ok(Array.isArray(bd.skills) && bd.skills.length === 1, 'one skill');
    assert.equal(bd.skills[0].name, 'brainstorming', 'the namespace prefix is stripped');
    assert.ok(bd.skills[0].tokens > 100, `skill tokens reflect real content, got ${bd.skills[0].tokens}`);
    assert.ok('lastTurn' in bd.skills[0], 'skills use lastTurn');
    assert.equal(bd.skills[0].defaultSelected, true, 'a Skill is always selected');
    assert.equal(bd.skills[0].defaultDiscardReason, null);
    // A skill row carries the same selection members a path row does, so the panel reads one shape for
    // both and an override on a `skill:` key has somewhere to surface.
    assert.equal(bd.skills[0].userOverride, null, 'no override yet, and the member is present');
    assert.equal(bd.paths[0].userOverride, null);
    assert.ok(bd.paths.every(p => !p.path.startsWith('skill:')), 'paths exclude the Skill namespace');
    assert.ok(bd.paths.some(p => p.path === '/p/a.js'), 'the file path is present');
    assert.ok('lastTurn' in bd.paths[0], 'paths use lastTurn');
    assert.equal(bd.paths[0].lastActiveTurn, undefined, 'lastActiveTurn is not a bucket field');
  });

  test('residual arrays carry name/detail and tool fields, never a raw command', () => {
    const watcher = compose();
    apply(watcher, [
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      step('a1', 'm1', { input: 10000, output: 5 }, [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ]),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: 'FAIL '.repeat(200), timestamp: ts(2) }),
      step('a2', 'm2', { cacheRead: 25000, output: 5 }),
    ]);
    const bd = watcher.getBucketData();
    assert.ok(Array.isArray(bd.residual.bash) && Array.isArray(bd.residual.mcp) && Array.isArray(bd.residual.agent));
    assert.ok(bd.residual.bash.some(b => b.name === 'npm test'), `bash uses the extracted feature name, got ${JSON.stringify(bd.residual.bash)}`);
    assert.ok(bd.residual.bash.every(b => b.cmd === undefined), 'no raw command crosses the wire');
    assert.ok(bd.residual.bash[0].tokens > 0);
    assert.ok('lastTurn' in bd.residual.bash[0] && 'detail' in bd.residual.bash[0]);
  });

  test('exposes segment, currentTurnSeq and the totals', () => {
    const watcher = compose();
    apply(watcher, [
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      step('a1', 'm1', { input: 20000, output: 5 }),
      step('a2', 'm2', { cacheRead: 40000, cacheWrite: 3000, output: 5 }),
    ]);
    const bd = watcher.getBucketData();
    assert.equal(typeof bd.segment, 'number', 'segment is exposed for override GC');
    assert.equal(typeof bd.currentTurnSeq, 'number');
    assert.equal(bd.totalResidualRaw, 40000 + 3000 - bd.totalB,
      'raw is the signed stock − B, the channel residual candidates are drawn from');
    assert.equal(bd.totalResidual, Math.max(0, bd.totalResidualRaw), 'the display value is clamped');
    assert.equal(typeof bd.dead, 'number');
  });

  test('defaultSelected annotates each file row and bDefault excludes the unselected ones', () => {
    const watcher = compose({ projectRoot: '/project', isIgnored: (rel) => rel.startsWith('node_modules/') });
    apply(watcher, [
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      step('a1', 'm1', { input: 10000, output: 5 }, [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/project/src/app.js' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/project/node_modules/pkg/index.js' } },
        { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'brainstorming' } },
      ]),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: numbered(50, 'const app = 1;'), timestamp: ts(2) }),
      toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't2', content: numbered(200, 'module.exports = {};'), timestamp: ts(2) }),
      toolResult({ uuid: 'r3', parentUuid: 'r2', toolUseId: 't3', content: 'Launching skill: brainstorming', timestamp: ts(2) }),
      skillPayloadRow({ uuid: 'r4', parentUuid: 'r3', sourceToolUseID: 't3', text: SKILL_BODY, timestamp: ts(2) }),
      step('a2', 'm2', { cacheRead: 30000, output: 5 }),
    ]);
    const bd = watcher.getBucketData();
    assert.ok(bd.skills.length >= 1, 'at least one skill');
    assert.equal(bd.skills[0].defaultSelected, true);

    const app = bd.paths.find(p => p.path === '/project/src/app.js');
    assert.ok(app, 'the in-project path is present');
    assert.equal(app.defaultSelected, true);
    assert.equal(app.defaultDiscardReason, null);

    const vendored = bd.paths.find(p => p.path === '/project/node_modules/pkg/index.js');
    assert.ok(vendored, 'the ignored path is present');
    assert.equal(vendored.defaultSelected, false);
    assert.equal(vendored.defaultDiscardReason, 'gitignore');

    assert.equal(typeof bd.bDefault, 'number', 'bDefault is exposed');
    assert.ok(bd.bDefault > 0, 'bDefault is positive');
    assert.ok(vendored.tokens > 0, 'the ignored path carries tokens the basis can exclude');
    assert.ok(bd.bDefault < bd.dead + bd.paths.reduce((sum, p) => sum + p.tokens, 0)
      + bd.skills.reduce((sum, s) => sum + s.tokens, 0),
    'bDefault is below the uncapped resident total once an ignored path holds tokens');
  });
});
