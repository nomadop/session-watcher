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
