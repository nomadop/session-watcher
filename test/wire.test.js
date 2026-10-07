// test/wire.test.js — the payload shapers `lib/wire.js` holds so the Claude Code host and the DSH host share one home for each shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusWire, statusWireWithLedger, bucketsPayload, bucketSummaryPayload, overrideWarnings, pricingResponse, turnPageWire, loadedHandoffPayload, isOverrideMap,
} from '../lib/wire.js';
import { stateKeyForStatus } from '../lib/rate-lamp-store.js';
import { lampZone } from '../lib/bill-regret.js';

test('statusWire renames sourceLocator to transcriptPath and attaches no ledger field', () => {
  const status = { L: 10, B: 20, sourceLocator: '/tmp/session.jsonl', rateLamp: { reliable: false } };
  const bare = statusWire(status);
  assert.equal(bare.transcriptPath, '/tmp/session.jsonl');
  assert.equal('sourceLocator' in bare, false, 'the opaque application field does not reach the wire');
  assert.equal(bare.L, 10, 'every other field passes through');
  assert.deepEqual(bare.rateLamp, { reliable: false }, 'no merge step runs; rateLamp passes through untouched');

  const nullLocator = statusWire({ L: 1, sourceLocator: null, rateLamp: { reliable: false } });
  assert.equal(nullLocator.transcriptPath, null);
});

test('statusWire adds lamp, the zone of a reliable rateLamp and null for an unreliable one, and no other key', () => {
  const rateLamp = { reliable: true, br: 0.15, u: 2, mf: 0.3 };
  const reliable = { L: 10, B: 20, sourceLocator: '/tmp/session.jsonl', rateLamp };
  const wired = statusWire(reliable);
  assert.equal(wired.lamp, lampZone(rateLamp.br, { u: rateLamp.u, mf: rateLamp.mf }));
  assert.equal(wired.lamp, 'amber');
  assert.deepEqual(Object.keys(wired).sort(), ['L', 'B', 'transcriptPath', 'rateLamp', 'lamp'].sort());

  const unreliable = statusWire({ L: 10, sourceLocator: null, rateLamp: { reliable: false, br: 0.3, u: 2, mf: 0.3 } });
  assert.equal(unreliable.lamp, null, 'a measuring status has no zone');
  assert.deepEqual(Object.keys(unreliable).sort(), ['L', 'transcriptPath', 'rateLamp', 'lamp'].sort());
});

test('statusWireWithLedger carries the lamp statusWire stamped', () => {
  const stateKey = stateKeyForStatus({ segment: 3 });
  const ledger = { stateKey, billProgress: 0.5, billCycleCount: 2, currentTurnSeq: 7, walletPhase: 0.1, walletLapCount: 0 };
  const status = { L: 5, segment: 3, sourceLocator: '/x.jsonl', rateLamp: { reliable: true, br: 0.3, u: 2, mf: 0.3, billingCycle: {} } };
  const merged = statusWireWithLedger(status, ledger);
  assert.equal(merged.rateLamp.billProgress, 0.5, 'the ledger merged');
  assert.equal(merged.lamp, statusWire(status).lamp);
  assert.equal(merged.lamp, 'red');
});

test('statusWireWithLedger stamps the wallet defaults on a null ledger and merges only a matching-key ledger', () => {
  const nullLedger = statusWireWithLedger({ L: 1, sourceLocator: '/x.jsonl', rateLamp: { reliable: false } }, null);
  assert.ok('rentMeter' in nullLedger.rateLamp, 'the merge step always runs, even with a null ledger');

  const stateKey = stateKeyForStatus({ segment: 3 });
  const ledger = { stateKey, billProgress: 0.5, billCycleCount: 2, currentTurnSeq: 7, walletPhase: 0.1, walletLapCount: 0 };
  const merged = statusWireWithLedger(
    { L: 5, segment: 3, sourceLocator: '/x.jsonl', rateLamp: { reliable: true, billingCycle: {} } },
    ledger,
  );
  assert.equal(merged.rateLamp.billProgress, 0.5, 'a reliable status with a matching-key ledger merges');

  const unmatchedLedger = { ...ledger, stateKey: 'seg:9' };
  const notMerged = statusWireWithLedger(
    { L: 5, segment: 3, sourceLocator: '/x.jsonl', rateLamp: { reliable: true, billingCycle: {} } },
    unmatchedLedger,
  );
  assert.equal('billProgress' in notMerged.rateLamp, false, 'a stateKey mismatch merges nothing');
});

test('bucketsPayload spreads bucket data and derives metrics from status', () => {
  const bucketData = {
    paths: [{ path: '/a.js', lastTurn: 4, tokens: 10 }, { path: '/b.js', lastTurn: 9, tokens: 20 }],
    skills: [], residual: { bash: [], mcp: [], agent: [], tool: [] },
    segment: 2, currentTurnSeq: 11, dead: 0, totalB: 100, totalL: 50, totalResidual: 0,
  };
  const status = { br: 0.1, mf: 0.2, pp: 0.3, g: 0.4, B: 500, cRatio: 12 };
  const payload = bucketsPayload({ bucketData, status, sessionId: 'sess-1', now: 1700000000000 });

  assert.deepEqual(payload.skills, bucketData.skills, 'bucket data spreads through');
  assert.deepEqual(payload.residual, bucketData.residual);
  assert.deepEqual(payload.paths, [
    { path: '/a.js', lastTurn: 4, tokens: 10, last_active_turn: 4 },
    { path: '/b.js', lastTurn: 9, tokens: 20, last_active_turn: 9 },
  ], 'each path row keeps its own fields and gains the snake_case turn field');
  assert.equal(payload.session_id, 'sess-1');
  assert.equal(payload.segment, 2);
  assert.equal(payload.current_turn, 11);
  assert.equal(payload.generated_at, 1700000000000);
  assert.deepEqual(payload.metrics, { br: 0.1, mf: 0.2, pp: 0.3, g: 0.4, b_total: 500, c_ratio: 12 });
});

test('bucketSummaryPayload keeps the fields the handoff decision reads and drops the dashboard timelines', () => {
  const row = {
    path: '/a.js', tokens: 1728.1764705882342, lastTurn: 4, last_active_turn: 4, lastCallSeq: 9, totalSpent: 1789,
    churn: 1.0351952074611124, efficiency: 97, readCount: 2, editCount: 1, touchSeqs: [{ seq: 1, mode: 'r' }],
    pureRereads: 0, defaultSelected: true, defaultDiscardReason: null, userOverride: null, activeSymbols: ['a', 'a > b'],
  };
  const ignored = { ...row, path: '/tmp/brief.md', defaultSelected: false, defaultDiscardReason: 'outside-project', userOverride: 'include' };
  delete ignored.activeSymbols;
  const skill = { ...row, name: 'tdd' };
  delete skill.path; delete skill.activeSymbols;
  const full = bucketsPayload({
    bucketData: {
      paths: [row, ignored], skills: [skill],
      residual: { bash: [{ name: 'ls', tokens: 1473, touchSeqs: [] }], mcp: [], agent: [], tool: [] },
      dead: 20564, totalB: 43711.49, totalL: 47101, bDefault: 33958.49, totalResidualRaw: 8240.5, totalResidual: 8240.5,
      currentTurnSeq: 1, segment: 2,
    },
    status: { br: 0.3759100722706997, mf: 0.3764680165893116, pp: 0.9985179502799024, g: 479.9145209411763, B: 43711.49, cRatio: 10 },
    sessionId: 'sess-1', now: 1700000000000,
  });

  assert.deepEqual(bucketSummaryPayload(full), {
    skills: [{ name: 'tdd', tokens: 1728, readCount: 2, editCount: 1, defaultSelected: true, userOverride: null }],
    paths: [
      { path: '/a.js', tokens: 1728, readCount: 2, editCount: 1, defaultSelected: true, userOverride: null, activeSymbols: ['a', 'a > b'] },
      { path: '/tmp/brief.md', tokens: 1728, readCount: 2, editCount: 1, defaultSelected: false, defaultDiscardReason: 'outside-project', userOverride: 'include' },
    ],
    session_id: 'sess-1', segment: 2,
    metrics: { br: 0.3759100722706997 },
  }, 'an ignored row stays a candidate with its reason; residual, totals, per-touch history and the other metrics are gone');
});

test('overrideWarnings spells unknown_resource and invalid values', () => {
  const warnings = overrideWarnings([
    { code: 'unknown_resource', resourceKey: '/nope.js' },
    { code: 'invalid_value', resourceKey: '/a.js', value: 'sideways' },
  ]);
  assert.deepEqual(warnings, [
    'ignored: path "/nope.js" not in current bRebuild',
    'ignored: invalid value "sideways" for path "/a.js"',
  ]);
});

test('pricingResponse ranks saved over cli over model_default and detects preset drift', () => {
  const policy = {
    cRatio: 8,
    pricing: {
      readPrice: 1, writePrice: 8,
      presets: [{ id: 'opus-4.8', label: 'Opus 4.8', readPrice: 0.5, writePrice: 6.25 }],
    },
  };

  const modelDefaultOnly = pricingResponse({ model: 'm1', saved: null, policy, cliRatio: null });
  assert.equal(modelDefaultOnly.effective.source, 'model_default');
  assert.equal(modelDefaultOnly.effective.ratio, 8);
  assert.equal(modelDefaultOnly.saved, null);
  assert.deepEqual(modelDefaultOnly.modelDefault, { model: 'm1', ratio: 8, readPrice: 1, writePrice: 8 });
  assert.equal(modelDefaultOnly.presets, policy.pricing.presets);

  const cliRanked = pricingResponse({ model: 'm1', saved: null, policy, cliRatio: 15 });
  assert.equal(cliRanked.effective.source, 'cli');
  assert.equal(cliRanked.effective.ratio, 15);

  // A saved presetId whose prices still match the current preset table → source: 'preset'.
  const matchingPreset = pricingResponse({
    model: 'm1', saved: { ratio: 12.5, readPrice: 0.5, writePrice: 6.25, presetId: 'opus-4.8' },
    policy, cliRatio: 15,
  });
  assert.equal(matchingPreset.effective.source, 'preset');
  assert.equal(matchingPreset.effective.ratio, 12.5);

  // A saved presetId whose prices have drifted from the current preset table → source stays 'saved'.
  const driftedPreset = pricingResponse({
    model: 'm1', saved: { ratio: 999, readPrice: 999, writePrice: 999, presetId: 'opus-4.8' },
    policy, cliRatio: 15,
  });
  assert.equal(driftedPreset.effective.source, 'saved');
  assert.equal(driftedPreset.effective.ratio, 999);
  assert.equal(driftedPreset.effective.readPrice, 999);
  assert.equal(driftedPreset.effective.writePrice, 999);
});

test('turnPageWire carries next_before only when the page has a cursor', () => {
  const page = { turns: [] };
  assert.deepEqual(turnPageWire({ turnPage: page, nextBefore: 'S1:3' }), { turn_page: page, next_before: 'S1:3' });
  const last = turnPageWire({ turnPage: page, nextBefore: null });
  assert.deepEqual(last, { turn_page: page });
  assert.equal('next_before' in last, false);
});

test('loadedHandoffPayload attaches lineage headlines and the page, and names turn_page_unavailable when the page cannot be built', async () => {
  // One delivered handoff heading a one-session lineage whose only stored turn is noted.
  const store = {
    getHandoff: (id) => (id === 7
      ? { handoffId: 7, projectId: 'p', sessionId: 's-a', transcriptPath: '/t/a.jsonl', createdAt: 1 }
      : null),
    findParentDelivery: () => null,
    listTurnNotes: (sid) => (sid === 's-a' ? [{ turnNoteId: 1, uText: 'open the work', note: 'done' }] : []),
  };
  const history = { dialogueSource: { read: async () => ({}) }, dialogueProjection: {}, notice: 'notice' };
  const core = { found: true, handoff_id: 7, summary: 's' };
  const page = { turns: ['t'] };
  const built = [];
  const turnPageBuilder = async (args) => { built.push(args); return { turnPage: page, nextBefore: 'S1:1' }; };

  const loaded = await loadedHandoffPayload(core, { store, turnPageBuilder, ...history });
  assert.deepEqual(loaded, {
    ...core,
    lineage: [{ label: 'S1', headline: 'open the work' }],
    turn_page: page,
    next_before: 'S1:1',
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].store, store);
  assert.deepEqual(built[0].lineage.map(entry => entry.sessionId), ['s-a']);
  assert.equal(built[0].dialogueSource, history.dialogueSource);
  assert.equal(built[0].dialogueProjection, history.dialogueProjection);
  assert.equal(built[0].notice, 'notice');

  const failing = async () => { throw new Error('transcript unreadable'); };
  assert.deepEqual(await loadedHandoffPayload(core, { store, turnPageBuilder: failing, ...history }),
    { ...core, turn_page_error: 'turn_page_unavailable' });
});

test('isOverrideMap accepts a plain object and rejects arrays, null and primitives', () => {
  assert.equal(isOverrideMap({}), true);
  assert.equal(isOverrideMap({ '/a.js': 'exclude' }), true);
  for (const value of [[], [['/a.js', 'exclude']], null, undefined, '', 'overrides', 0, 1, true, false]) {
    assert.equal(isOverrideMap(value), false, `rejects ${JSON.stringify(value)}`);
  }
});
