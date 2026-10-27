// test/lineage.split.test.js — a continued session is one lineage member per handoff: over the real Store,
// the walk's windows split the session's stored notes between its members, and Turn Browse and the lineage
// headlines read each member's own rows and the task the member before it handed over.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../lib/store.js';
import { forLoadedHandoff } from '../lib/lineage.js';
import { buildTurnBrowse, lineageHeadlines } from '../lib/turn-browse.js';

let dir, store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-lineage-split-'));
  store = openStore(join(dir, 'split.sqlite'));
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

const handoff = ({ sessionId, createdAt, nextTask }) => store.insertHandoff({
  sessionId, segment: 0, loadToken: `${sessionId}-${createdAt}`, createdAt, nextTask,
  pathsToKeep: '[]', summary: 'test', summaryTokens: 10, projectId: 'project-1', transcriptPath: null,
}).handoffId;
const deliver = (handoffId, sessionId, loadedAt) => store.insertHandoffLoad({
  handoffId, sessionId, loadedAt, loaderVersion: 'test', claimResult: 'primary',
  primarySessionId: sessionId, consumerSegment: 0,
});
const note = (sessionId, anchorUuid, sourceTimestamp) => ({
  sourceSessionId: sessionId, anchorUuid, uText: `u ${anchorUuid}`, uOriginalChars: `u ${anchorUuid}`.length,
  note: `note ${anchorUuid}`, searchTerms: '', sourceTimestamp,
});

// Y's handoff is delivered into X; X then prepares and loads its own handoff three times.
function seedContinuedSession({ emptyMiddle = false } = {}) {
  const hY = handoff({ sessionId: 'sess-Y', createdAt: 1000, nextTask: 'task from Y' });
  deliver(hY, 'sess-X', 1100);
  const own = [2000, 3000, 4000].map((createdAt, i) => {
    const id = handoff({ sessionId: 'sess-X', createdAt, nextTask: `task from c${i + 1}` });
    deliver(id, 'sess-X', createdAt + 100);
    return id;
  });
  store.upsertTurnNotes([
    note('sess-Y', 'y1', 900),
    note('sess-X', 'x-c1', 1500),
    ...(emptyMiddle ? [] : [note('sess-X', 'x-c2', 2500)]),
    note('sess-X', 'x-c3', 3500),
    note('sess-X', 'x-after-head', 4500),      // after the head's `through`: no member holds it
  ]);
  return { hY, own };
}

test('续行 session 的每个 handoff 是一个成员：各 section 只含自己窗口里的行，第二个起的 X 的 headline 是前一成员 handoff 的 nextTask', () => {
  seedContinuedSession();
  const lineage = forLoadedHandoff({ store, sessionId: 'sess-X' });
  const { sections } = buildTurnBrowse({ store, lineage });
  assert.deepEqual(sections.map(s => [s.label, s.entries.map(e => e.u_text)]), [
    ['S1', ['u y1']], ['S2', ['u x-c1']], ['S3', ['u x-c2']], ['S4', ['u x-c3']],
  ]);
  assert.deepEqual(sections.map(s => s.headline), ['u y1', 'task from Y', 'task from c1', 'task from c2']);
  assert.deepEqual(lineageHeadlines({ store, lineage }),
    sections.map(({ label, headline }) => ({ label, headline })));
});

test('窗口里没有行的成员不出 section，其后成员的 label 与 headline 仍按链位置', () => {
  seedContinuedSession({ emptyMiddle: true });
  const lineage = forLoadedHandoff({ store, sessionId: 'sess-X' });
  assert.deepEqual(lineageHeadlines({ store, lineage }), [
    { label: 'S1', headline: 'u y1' },
    { label: 'S2', headline: 'task from Y' },
    { label: 'S4', headline: 'task from c2' },
  ]);
});
