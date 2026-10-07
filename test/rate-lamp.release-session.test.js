import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';
import { saveRateLampState, loadRateLampState } from '../lib/rate-lamp-store.js';
import {
  advanceRateLampToCurrent, getLiveLedger, isEnospcPaused, releaseSession,
  _resetRateLampManagerForTest, _setRateLampManagerTestHooks,
} from '../lib/rate-lamp-manager.js';

const SID = 'sid-release-test';

let storeDir;
// The coalesced write-behind timer never fires on its own here: each case fires it, or not, through the captured callback, so the only writes a case sees are the ones it asked for.
let flushCoalesced;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'sw-rl-release-'));
  initStore(join(storeDir, 'test.sqlite'));
  _resetRateLampManagerForTest();
  flushCoalesced = null;
  _setRateLampManagerTestHooks({ scheduler: (fn) => { flushCoalesced = fn; return { unref() {} }; } });
});
afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(storeDir, { recursive: true, force: true });
});

const sample = (seq, deltaW) => ({ seq, reliable: true, deltaW, mf: 0.3, L_read: 300000, turnSeq: 1 });

// The manager reads exactly one frame per advance, so the fake exposes `readRateLampFrame` alone with the real method's return shape.
function frameSource({ foldedSeq, samples = [], streamRevision = 1 }) {
  return {
    readRateLampFrame(sinceFoldedSeq) {
      return {
        status: { reliable: true, C_RATIO: 10, B_default: 250000, bDefault: 250000, mf: 0.3, u: 1.2, pp: 0.02, br: 0.006 },
        progress: { segment: 0, measuredCalls: samples.length, sinceFoldedSeq },
        samples,
        turnSeq: 1,
        foldedCallSeq: foldedSeq,
        streamRevision,
      };
    },
  };
}

// A first frame is a discontinuity that only anchors the cursor; the second integrates its sample.
function advanceToProgress(deltaW) {
  advanceRateLampToCurrent(frameSource({ foldedSeq: 1 }), SID);
  return advanceRateLampToCurrent(frameSource({ foldedSeq: 2, samples: [sample(2, deltaW)] }), SID).ledger;
}

function recordingWriter({ throwsWhen = () => false } = {}) {
  const writes = [];
  const writer = (sessionId, ledger) => {
    if (throwsWhen()) { const err = new Error('ENOSPC'); err.code = 'ENOSPC'; throw err; }
    writes.push({ sessionId, ledger: structuredClone(ledger) });
  };
  return { writes, writer };
}

test('release persists the live ledger and forgets the session', () => {
  const { writes, writer } = recordingWriter();
  _setRateLampManagerTestHooks({ writer });
  const live = advanceToProgress(0.2);
  // The coalesced timer already wrote this exact ledger, so only a forced write reaches the writer again.
  flushCoalesced();
  assert.equal(writes.length, 1, 'precondition: the write-behind checkpoint landed');

  releaseSession(SID);
  assert.equal(writes.length, 2, 'the release wrote the live ledger once more');
  assert.deepEqual(writes[1], { sessionId: SID, ledger: live });
  assert.equal(getLiveLedger(SID), null);
});

test('release clears an ENOSPC pause', () => {
  let failing = true;
  const { writes, writer } = recordingWriter({ throwsWhen: () => failing });
  _setRateLampManagerTestHooks({ writer });
  const live = advanceToProgress(0.2);
  flushCoalesced();
  assert.equal(isEnospcPaused(SID), true, 'precondition: the failed write-behind engaged the pause');

  failing = false;
  releaseSession(SID);
  assert.deepEqual(writes, [{ sessionId: SID, ledger: live }]);
  assert.equal(isEnospcPaused(SID), false);
  assert.equal(getLiveLedger(SID), null);
});

test('a later advance hydrates from the store and continues the integral', () => {
  advanceToProgress(0.2);
  releaseSession(SID);
  assert.equal(getLiveLedger(SID), null);
  assert.equal(loadRateLampState(SID).billProgress, 0.2, 'the release reached the store');

  // The next frame is a discontinuity again (the seen revision left with the session): the persisted integral stands and the frame's history is skipped; the sample after it integrates on top.
  const rehydrated = advanceRateLampToCurrent(frameSource({ foldedSeq: 2, samples: [sample(2, 0.2)] }), SID).ledger;
  assert.equal(rehydrated.billProgress, 0.2);
  const next = advanceRateLampToCurrent(frameSource({ foldedSeq: 3, samples: [sample(3, 0.1)] }), SID).ledger;
  assert.ok(Math.abs(next.billProgress - 0.3) < 1e-9, 'the integral continues from the persisted value');
});

test('release of a session never advanced writes nothing', () => {
  const { writes, writer } = recordingWriter();
  _setRateLampManagerTestHooks({ writer });
  releaseSession(SID);
  assert.deepEqual(writes, []);
  assert.equal(getLiveLedger(SID), null);
  assert.equal(isEnospcPaused(SID), false);
});

test('release whose write throws still forgets the session and does not throw', () => {
  let releasing = false;
  // Every write but the release's lands in the real store.
  _setRateLampManagerTestHooks({
    writer: (sessionId, ledger) => {
      if (releasing) throw new Error('ENOSPC');
      saveRateLampState(sessionId, ledger);
    },
  });
  advanceToProgress(0.2);
  flushCoalesced();
  advanceRateLampToCurrent(frameSource({ foldedSeq: 3, samples: [sample(3, 0.1)] }), SID);
  assert.ok(Math.abs(getLiveLedger(SID).billProgress - 0.3) < 1e-9, 'precondition: the live ledger moved past the checkpoint');

  releasing = true;
  assert.doesNotThrow(() => releaseSession(SID));
  assert.equal(getLiveLedger(SID), null);

  releasing = false;
  const rehydrated = advanceRateLampToCurrent(frameSource({ foldedSeq: 3 }), SID).ledger;
  assert.equal(rehydrated.billProgress, 0.2, 'the next advance hydrates the last checkpoint the store held');
});

test('release twice is one release', () => {
  const { writes, writer } = recordingWriter();
  _setRateLampManagerTestHooks({ writer });
  advanceToProgress(0.2);
  releaseSession(SID);
  releaseSession(SID);
  assert.equal(writes.length, 1);
  assert.equal(getLiveLedger(SID), null);
});
