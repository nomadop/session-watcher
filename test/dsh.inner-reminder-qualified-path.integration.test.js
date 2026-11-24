// The reminder budget of an inner-mode DSH session end to end: authored events fed through the watcher table over the production composition, the DSH source driver and the Rate Lamp manager, to the ledger the reminder reads and the store it lands in.
// The log is the static grid of `test/helpers/dsh-inner-reminder-log.js`, whose qualified path has a closed form that reads nothing from the product; the same stocks with no seal are the plain path that closed form is checked against.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWatcherTable } from '../dsh/src/watcher-table.js';
import { composeWatcher } from '../dsh/src/composition.js';
import { closeStoreGlobal, getStore, initStore } from '../lib/store.js';
import { flushPendingPersistsSync, getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { freshLedger, loadRateLampState, saveRateLampState, stateKeyForStatus } from '../lib/rate-lamp-store.js';
import { assistantMessage } from './helpers/dsh-events.js';
import {
  authoredLog, BUDGET_AT_POST, HEAD_STOCK, KEPT_STEP, MODEL, SEAL_EVERY,
} from './helpers/dsh-inner-reminder-log.js';
import { afterPostLog, recallLog, zeroStockPostLog } from './helpers/dsh-inner-recall-log.js';

const SESSION = 's-inner-reminder';
// The first segment's ledger key.
const KEY = stateKeyForStatus({ segment: 0 });

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-inner-reminder-'));
  initStore(join(dir, 'store.sqlite'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const bill = ledger => ledger.billCycleCount + ledger.billProgress;
const wallet = ledger => ledger.walletLapCount + ledger.walletPhase;
const assertClose = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
const assertBudget = (ledger, { bill: expectedBill, wallet: expectedWallet }, message) => {
  assertClose(bill(ledger), expectedBill, `${message} bill`);
  assertClose(wallet(ledger), expectedWallet, `${message} wallet`);
};

// ── The rig ──────────────────────────────────────────────────────────────────

const settled = () => new Promise(resolve => setImmediate(resolve));

// A table over the production composition, the mode answered by `innerModeOn`, with the snapshot its session reads at bootstrap.
async function openTable({ innerModeOn, snapshot = [] }) {
  const readSession = async () => ({ session: {}, inheritedEventCount: 0, events: snapshot });
  const table = createWatcherTable({
    readSession,
    innerModeOn,
    compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
      sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot: join(dir, 'turn-notes'), readSession, isIgnored: null,
    }),
  });
  table.ensure({ id: SESSION, header: { cwd: '/repo' } });
  await settled();
  return table;
}

// What the position the lamp reads says after each event, which the budget never moves.
const lampOf = (table) => {
  const { u, pp, br, mf, bDefault } = table.get(SESSION).watcher.readRateLampFrame(0).status;
  return { u, pp, br, mf, bDefault };
};

/** The log fed live after an empty snapshot: each entry with the ledger and the lamp after it. */
async function runLive({ entries, innerModeOn }) {
  const table = await openTable({ innerModeOn });
  const rows = [];
  for (const entry of entries) {
    table.feed(SESSION, entry.event);
    rows.push({ ...entry, ledger: structuredClone(getLiveLedger(SESSION)), lamp: lampOf(table) });
  }
  return { table, rows };
}

const on = () => true;
const off = () => false;

// ── Ordinary sessions ────────────────────────────────────────────────────────

describe('a session whose mode is not on', () => {
  test('keeps the reminder the whole path gives: the first lap at the twenty-fifth call of the authored log', async () => {
    const { rows } = await runLive({ entries: authoredLog(), innerModeOn: off });
    const first = rows.findIndex(row => row.ledger.lastStopEvent !== null);
    assert.equal(rows.slice(0, first + 1).filter(row => row.kind === 'call').length, 25);
    assert.equal(rows[first].ledger.lastStopEvent.billCount, 1);
    assert.ok(rows[first].lamp.u < 1, 'the position the reminder fired at is still on the left arm');
    const last = rows.at(-1).ledger;
    assert.deepEqual(
      [last.billCycleCount, last.walletLapCount, last.lastAppliedFoldedCallSeq],
      [44, 22, 20],
    );
    assertClose(last.billProgress, 0.29199999999999915, 'final billProgress');
    assertClose(last.walletPhase, 0.3815113938257437, 'final walletPhase');
  });

  test('is the same session when the table is handed no mode at all', async () => {
    const entries = authoredLog();
    const explicit = await runLive({ entries, innerModeOn: off });
    _resetRateLampManagerForTest();
    closeStoreGlobal();
    initStore(join(dir, 'store-default.sqlite'));
    const implicit = await runLive({ entries, innerModeOn: undefined });
    assert.deepEqual(implicit.rows.map(row => row.ledger), explicit.rows.map(row => row.ledger));
  });

  test('unsealed ordinary session: the closed form of the static grid is the ledger of the plain path whose metered calls lie as many main calls apart', async () => {
    // The head and the posts as plain calls, the stock the sealed grid's qualified path has, each behind the calls that reported no usage between them.
    const quiet = () => ({ event: assistantMessage({ text: 'work', model: MODEL }), kind: 'call', post: null });
    const plain = Array.from({ length: 6 }, (_, post) => [
      ...(post === 0 ? [] : Array.from({ length: SEAL_EVERY - 1 }, quiet)),
      {
        event: assistantMessage({
          text: 'work', model: MODEL,
          usage: { inputTokens: 0, outputTokens: 100, cacheReadTokens: HEAD_STOCK + post * KEPT_STEP * SEAL_EVERY, cacheWriteTokens: 0 },
        }),
        kind: 'call', post,
      },
    ]).flat();
    const { rows } = await runLive({ entries: plain, innerModeOn: off });
    for (const post of [1, 2, 3, 4, 5]) assertBudget(rows.find(row => row.post === post).ledger, BUDGET_AT_POST[post], `post ${post}`);
  });

  test('keeps the integral a persisted ledger holds across a restart: only the cursor moves', async () => {
    const entries = authoredLog();
    const snapshot = entries.slice(0, 40).map(entry => entry.event);
    saveRateLampState(SESSION, { ...freshLedger(KEY), billProgress: 0.25, billCycleCount: 99, walletPhase: 0.5, walletLapCount: 40 });
    await openTable({ innerModeOn: off, snapshot });
    const ledger = getLiveLedger(SESSION);
    assert.deepEqual([ledger.billCycleCount, ledger.billProgress, ledger.walletLapCount, ledger.walletPhase], [99, 0.25, 40, 0.5]);
    assert.equal(ledger.lastStopEvent, null);
  });
});

// ── An inner-mode session ────────────────────────────────────────────────────

describe('a session whose inner mode is on', () => {
  test('moves no clock while the calls before the first carrier stay pending', async () => {
    const { rows } = await runLive({ entries: authoredLog(), innerModeOn: on });
    for (const row of rows.slice(0, SEAL_EVERY)) {
      assert.equal(bill(row.ledger), 0, `bill after call ${row.event.seq}`);
      assert.equal(wallet(row.ledger), 0, `wallet after call ${row.event.seq}`);
      assert.equal(row.ledger.lastStopEvent, null);
    }
  });

  test('prices the head and the posts as the closed form does, and holds that budget through the pending calls and the next carrier', async () => {
    const { rows } = await runLive({ entries: authoredLog(), innerModeOn: on });
    for (const post of [1, 2, 3, 4]) {
      const at = rows.findIndex(row => row.post === post);
      assertBudget(rows[at].ledger, BUDGET_AT_POST[post], `the post behind carrier ${post}`);
      const next = rows.findIndex(row => row.post === post + 1);
      for (const row of rows.slice(at + 1, next)) {
        const held = row.kind === 'carrier' ? `the carrier after post ${post}` : `a pending call after post ${post}`;
        assertBudget(row.ledger, BUDGET_AT_POST[post], held);
      }
    }
  });

  test('raises the first reminder at the post whose path reaches a lap, not before and not once more', async () => {
    const { rows } = await runLive({ entries: authoredLog(), innerModeOn: on });
    const at = rows.findIndex(row => row.post === 5);
    const next = rows.findIndex(row => row.post === 6);
    assertBudget(rows[at - 1].ledger, BUDGET_AT_POST[4], 'the call before it');
    assert.equal(rows.slice(0, at).filter(row => row.ledger.lastStopEvent !== null).length, 0);
    assert.deepEqual(rows[at].ledger.recentStopEvents.map(event => event.billCount), [1]);
    assert.equal(rows[at].ledger.lastStopEvent.billCount, 1);
    assertBudget(rows[at].ledger, BUDGET_AT_POST[5], 'the reminding post');
    assert.equal(rows[at].ledger.walletLapCount, 1);
    assert.deepEqual(rows.slice(at + 1, next).filter(row => row.ledger.recentStopEvents.length !== 1), [], 'the pending calls and the next carrier raise none');
  });

  test('leaves the position the lamp reads exactly where the whole path puts it', async () => {
    const entries = authoredLog();
    const withMode = await runLive({ entries, innerModeOn: on });
    _resetRateLampManagerForTest();
    closeStoreGlobal();
    initStore(join(dir, 'store-ordinary.sqlite'));
    const without = await runLive({ entries, innerModeOn: off });
    assert.deepEqual(withMode.rows.map(row => row.lamp), without.rows.map(row => row.lamp));
  });
});

// ── A Source read again ──────────────────────────────────────────────────────

describe('a session whose inner mode is on, rebuilt from its Source after a restart', () => {
  const cut = authoredLog().findIndex(entry => entry.post === 2) + 3;

  test('reads the same budget as the live path left, and the next qualified lap still raises its reminder', async () => {
    const entries = authoredLog();
    const live = await runLive({ entries: entries.slice(0, cut), innerModeOn: on });
    const liveLedger = live.rows.at(-1).ledger;
    flushPendingPersistsSync();
    _resetRateLampManagerForTest();
    assertBudget(loadRateLampState(SESSION), { bill: bill(liveLedger), wallet: wallet(liveLedger) }, 'the ledger the manager stored');
    const table = await openTable({ innerModeOn: on, snapshot: entries.slice(0, cut).map(entry => entry.event) });
    const rebuilt = getLiveLedger(SESSION);
    assertBudget(rebuilt, { bill: bill(liveLedger), wallet: wallet(liveLedger) }, 'the rebuilt ledger');
    assert.equal(rebuilt.lastStopEvent, null);
    const raisedAt = [];
    for (const entry of entries.slice(cut)) {
      table.feed(SESSION, entry.event);
      if (getLiveLedger(SESSION).lastStopEvent !== null) raisedAt.push(entry.post);
    }
    assert.equal(raisedAt[0], 5, 'the post whose path reaches the lap reminds after the rebuild');
    const final = getLiveLedger(SESSION);
    // One reminder per post that crosses a lap, stamped with the lap it reached: the call that crosses two laps is announced once.
    assert.deepEqual(final.recentStopEvents.map(event => event.billCount), [1, 2, 3, 4, 5, 6, 7, 9, 10]);
    assertBudget(final, BUDGET_AT_POST[13], 'the thirteenth post');
  });
});

// ── Requests that only read events back ──────────────────────────────────────
// The log of `test/helpers/dsh-inner-recall-log.js`: a head, two seals and, behind each, a post that reads an event back; between them a withdrawn call that does as well. Its closed form comes from an independent model of the interval (see the helper), not from the product.

// Every figure a row of the recall log is read against: the budget the clocks hold and what the lamp and the samples read after it.
const economyOf = table => {
  const { watcher } = table.get(SESSION);
  const frame = watcher.readRateLampFrame(0);
  const { u, pp, br, mf, bDefault } = frame.status;
  return { u, pp, br, mf, bDefault, gBar: watcher.readScenario({}).gBar, samples: frame.samples.map(sample => [sample.deltaW, sample.mf]) };
};

async function runRecall({ entries, innerModeOn }) {
  const table = await openTable({ innerModeOn });
  const rows = [];
  for (const entry of entries) {
    table.feed(SESSION, entry.event);
    rows.push({ ...entry, ledger: structuredClone(getLiveLedger(SESSION)), economy: economyOf(table) });
  }
  return { table, rows };
}

const rowOf = (rows, tag) => rows.find(row => row.tag === tag);

// The same log read cold at the cut after the row `tag`: a fresh store and manager, and the snapshot a restart reads.
async function coldAt(entries, tag, innerModeOn) {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  initStore(join(dir, `store-cold-${tag}.sqlite`));
  const cut = entries.findIndex(entry => entry.tag === tag) + 1;
  const table = await openTable({ innerModeOn, snapshot: entries.slice(0, cut).map(entry => entry.event) });
  return { ledger: structuredClone(getLiveLedger(SESSION)), economy: economyOf(table) };
}

describe('a session whose inner mode is on, with requests that only read events back', () => {
  test('prices the post as an ordinary call until the dispatch proves it, then in place on the interval it closes, with no sample added and no reminder', async () => {
    const { rows } = await runRecall({ entries: recallLog(), innerModeOn: on });
    const unproven = rowOf(rows, 'P');
    const proven = rowOf(rows, 'P-proof');
    // Eight calls span the interval, the head and the 7 a carrier withdrew included: 8 ordinary slots at rents 0 and 6500 over K = 12.5·3000 cost 8·3250/37500; proven, 7 slots and the request's net 10000.
    assertBudget(unproven.ledger, { bill: 0.6933333333333334, wallet: 0 }, 'the post as an ordinary call');
    assertBudget(proven.ledger, { bill: 0.8733333333333333, wallet: 0 }, 'the post as the recall it is');
    assert.equal(unproven.economy.samples.length, 2);
    assert.deepEqual(proven.economy.samples.map(([deltaW]) => deltaW).map(value => value && Math.round(value * 1e9)), [null, 873333333]);
    assert.equal(proven.economy.samples.length, unproven.economy.samples.length, 'the proof completes the original interval and appends nothing');
    assert.equal(proven.ledger.lastStopEvent, null);
    assert.deepEqual(proven.ledger.recentStopEvents, []);
  });

  test('keeps a withdrawn call\'s recall out of the budget until its post stands: the pending proof moves no clock, the confirmed post settles it with the span it kept', async () => {
    const { rows } = await runRecall({ entries: recallLog(), innerModeOn: on });
    const before = rowOf(rows, 'd3');
    const proof = rowOf(rows, 'd3-proof');
    assertBudget(before.ledger, { bill: 0.8733333333333333, wallet: 0 }, 'the pending request');
    assert.deepEqual(proof.ledger, before.ledger, 'the proof of a pending request replaces nothing in the budget');
    // The interval after the first post spans 8 main calls, the 7 the second carrier withdrew among them, and holds one priced request: 7 slots and the net 10300 of the withdrawn call. It is priced at the rate the first post left, 7000 of resident growth over 8 calls: no call before that post is classified, so no expected recall stock stands yet.
    const post = rowOf(rows, 'P2');
    assertBudget(post.ledger, { bill: 3.014666666666667, wallet: 1.0691206577542585 }, 'the second post, still unproven');
    assert.deepEqual(post.ledger.recentStopEvents.map(event => event.billCount), [1], 'the lap it reaches is announced once');
  });

  test('replaces the budget in silence when a late proof reaches a confirmed call: no second reminder, none made up, and the clocks the cold read of the same cut holds', async () => {
    const entries = recallLog();
    const { rows, table } = await runRecall({ entries, innerModeOn: on });
    const unproven = rowOf(rows, 'P2');
    const proven = rowOf(rows, 'P2-proof');
    assertBudget(proven.ledger, { bill: 3.2013333333333334, wallet: 1.2325982914065057 }, 'the second post as the recall it is');
    assert.deepEqual(proven.ledger.recentStopEvents, unproven.ledger.recentStopEvents);
    assert.equal(proven.ledger.lastStopEvent, null);
    // The interval the post closes spans 8 calls at the rate the first post left, 875: 8·√(875 / (2·12.5·3000)).
    assertClose(proven.economy.u, 0.8640987597877147, 'the position reads the proven interval too');
    // The Position Scenario of the default selection is the fold the lamp reads: 7000 of resident growth over each 8 calls. The second post is the first measured call with an estimate, so its expected recall stock is a base and adds nothing.
    const scenario = table.get(SESSION).watcher.readScenario({});
    assertClose(scenario.u, proven.economy.u, 'the scenario\'s position');
    assert.equal(scenario.gPhys, 875);
    assert.equal(scenario.gBar, 875, 'the scenario\'s rate, the resident one');
    for (const tag of ['P', 'P-proof', 'd3-proof', 'P2', 'P2-proof']) {
      const cold = await coldAt(entries, tag, on);
      const live = rowOf(rows, tag);
      assertBudget(cold.ledger, { bill: bill(live.ledger), wallet: wallet(live.ledger) }, `the cold read after ${tag}`);
      assert.deepEqual(cold.economy, live.economy, `the economy after ${tag}`);
    }
  });
});

describe('a session whose mode is not on, with a request that may yet prove a recall behind a priced interval', () => {
  // The first post's interval spans 8 calls and grew 7000 over them; X adds one call that grew 100.
  // X's request is as the log then shows it: unknown, a recall of 10100, which costs the whole of it, or none. Its bill is paid on the sample alone. The rate is the resident one in all three: X reads the share the first post leaves, the only estimate on the path, so its expected recall stock is a base.
  const rateAt = async (how, tag) => {
    const entries = afterPostLog(how);
    const { rows, table } = await runRecall({ entries, innerModeOn: off });
    const scenario = table.get(SESSION).watcher.readScenario({});
    return { entries, row: rowOf(rows, tag), gBar: scenario.gBar, gPhys: scenario.gPhys };
  };

  test('is an ordinary slot until its dispatch proves it, and the rate is the resident one', async () => {
    const open = await rateAt('open', 'X');
    assertClose(open.gBar, 7100 / 9, 'the rate with the request left open');
    assertClose(open.gPhys, 7100 / 9, 'the physical rate is the resident growth alone');
    // The slot is still an ordinary one: the rents at 9500 and 10100 over the baseline 3000, in units of K = 37500.
    assertClose(open.row.economy.samples.at(-1)[0], 6800 / 37500, 'the slot priced as an ordinary one');
    const cold = await coldAt(open.entries, 'X', off);
    assert.deepEqual(cold.economy, open.row.economy, 'the cold read of the same cut holds the unknown too');
  });

  test('prices the interval whole once its dispatch proves it, and as an ordinary slot once an answer with no dispatch frees it, the rate the resident one throughout', async () => {
    const proven = await rateAt('proven', 'X-proof');
    assertClose(proven.gBar, 7100 / 9, 'the rate with the recall of 10100 paid on the sample');
    assertClose(proven.row.economy.samples.at(-1)[0], 10_100 / 37_500, 'the request pays its own bill and no slot');
    const freed = await rateAt('cancelled', 'X-proof');
    assertClose(freed.gBar, 7100 / 9, 'the rate with the request freed');
    assertClose(freed.row.economy.samples.at(-1)[0], 6800 / 37_500, 'the slot priced as an ordinary one');
    assert.equal(freed.row.economy.samples.length, proven.row.economy.samples.length, 'neither resolution adds a sample');
  });
});

describe('a session whose mode is not on, with a post that reports no tokens between two measured points', () => {
  // The decay of one classified main call, from the half-life of 32.
  const ALPHA = 1 - 2 ** (-1 / 32);

  test('keeps the stretch the post interrupts: the post is no measured point, so the next one closes the whole stretch, the withdrawn request\'s bill in it', async () => {
    const entries = zeroStockPostLog();
    const { rows } = await runRecall({ entries, innerModeOn: off });
    const after = rowOf(rows, 'P3').economy;
    // Nine calls stand between the first post, at rent 6500 over the baseline 3000, and P3, at 7800: 8 ordinary slots at their mean 7150 and the withdrawn request's net 10300, over K = 37500.
    assertClose(after.samples.at(-1)[0], (8 * 7150 + 10_300) / 37_500, 'the stretch with the recall of the withdrawn call');
    // 7000 of growth over the head's 8 calls and 800 over the 9 that follow; P3 is the first measured call with an estimate, so its expected recall stock is a base.
    assertClose(after.gBar, (7000 + 800) / 17, 'the rate at the first estimate');
    assert.deepEqual(after, (await coldAt(entries, 'P3', off)).economy, 'the cold read of the same cut');
    // The next stretch is one ordinary call between the rents 7800 and 7900: what the held recall was spent on does not come back.
    const next = rowOf(rows, 'P4').economy;
    assertClose(next.samples.at(-1)[0], 7850 / 37_500, 'the stretch after it');
    // From the first post the calls are classified in order: the post and the withdrawn request d3 are pure, the six others and the post Z that reported no tokens are other. P3 reads the share with Z counted and P4 with P3 too, so the share falls by one factor of 1 − α while both stand at stock 10800 and 10900, beyond B = 3000: 3000·(share at P4 − share at P3) is a signed difference of the expected recall stock, taken with the 100 of growth over 18 calls.
    const atP3 = ALPHA * (1 - ALPHA) ** 8 + ALPHA * (1 - ALPHA) ** 5;
    assertClose(next.gBar, (7000 + 800 + 100 + 3000 * ((1 - ALPHA) * atP3 - atP3)) / 18, 'the rate with the share falling');
    assert.deepEqual(next, (await coldAt(entries, 'P4', off)).economy, 'the cold read of the same cut');
  });
});

describe('a session whose inner mode is off, with the first call behind a seal that reported no usage', () => {
  test('leaves the rebuild the seal paid with that call and prices the recall request after it whole: the identity is the Source\'s, not the next call the report would mark', async () => {
    const { rows } = await runRecall({ entries: recallLog({ usageFirstBehind: false }), innerModeOn: off });
    const [deltaW] = rowOf(rows, 'P-proof').economy.samples.at(-1);
    // 9 calls span the interval; 8 ordinary slots at rents 0 and 6500 over K = 37500, and the request's bill 9500 + 12.5·500 = 15750 with no rebuild taken off: 8·3250/37500 + 15750/37500.
    assertClose(deltaW, 1.1133333333333333, 'the recall request after the call with no usage');
  });
});
