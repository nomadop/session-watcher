// What a user's resource overrides do across a `replace` frame, through both real compositions: the shared
// SessionWatcher over a real in-memory Store, one Source driver per host, and the Source files the host reads.
// A rebuild installs a fresh Engine, which holds no override; what the user chose is the watcher's to carry into
// the rebuilt segment when that is the segment the choice was made in.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createWatcherComposition } from '../server.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import { closeStore, openStore } from '../lib/store.js';
import {
  assistantMessage, compactCheckpoint, sessionLog, stepEnd, stepStart, toolResult as dshToolResult, turnStart,
  userMessage as dshUserMessage,
} from './helpers/dsh-events.js';
import {
  assistantToolUse, chain, compactSummary, toolResult as ccToolResult, transcriptBytes, ts, usage,
  userMessage as ccUserMessage,
} from './helpers/transcript-fixtures.js';
import {
  CC_HOME, CWD, ccReadResultText, editableTree, linesText, readResultText,
} from './helpers/attribution-fixtures.js';

const A = '/repo/vendor/a.js';
const B = '/repo/vendor/b.js';
const LINES = ['alpha', 'beta', 'gamma', 'delta'].map((name, index) => `const ${name} = ${index + 1};`);
const FILES = { [A]: linesText(LINES), [B]: linesText(LINES) };
// Both files sit under an ignored directory, so each resolves to exclude by default.
const isIgnored = relative => relative.startsWith('vendor/');

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-override-survival-'));
  store = openStore(':memory:');
});

afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

// A Source is a list of segments, each the files its calls read, the compaction between two of them being the
// epoch the host's own marker makes.
function dshEvents(segments) {
  const events = [turnStart(), dshUserMessage({ text: 'Work on the module.' })];
  let step = 0;
  segments.forEach((files, index) => {
    if (index > 0) events.push(compactCheckpoint({ startSeq: events[0].seq, endSeq: events.at(-1).seq }));
    for (const file of files) {
      step += 1;
      const callId = `call_${step}`;
      const stock = 50_000 + step * 2_000;
      events.push(
        stepStart({ step }),
        assistantMessage({
          step,
          toolCalls: [{ id: callId, name: 'read', arguments: JSON.stringify({ file_path: file }) }],
          usage: { inputTokens: 2, outputTokens: 40, cacheReadTokens: stock, cacheWriteTokens: 2_000, totalTokens: stock + 2_042 },
        }),
        dshToolResult({ step, callId, text: readResultText(file, LINES) }),
        stepEnd({ step }),
      );
    }
  });
  return sessionLog(events);
}

function ccEntries(segments) {
  const entries = [ccUserMessage({ uuid: 'u0', text: 'Work on the module.', timestamp: ts(0) })];
  let step = 0;
  segments.forEach((files, index) => {
    if (index > 0) entries.push(compactSummary({ uuid: `c${index}`, timestamp: ts(step) }));
    for (const file of files) {
      step += 1;
      entries.push(
        assistantToolUse({
          uuid: `a${step}`, messageId: `m${step}`, toolUseId: `t${step}`, name: 'Read', input: { file_path: file },
          timestamp: ts(step), usage: usage({ cacheRead: 20_000 + step * 1_000, output: 5 }),
        }),
        ccToolResult({ uuid: `r${step}`, parentUuid: `a${step}`, toolUseId: `t${step}`, content: ccReadResultText(LINES), timestamp: ts(step) }),
      );
    }
  });
  return chain(entries);
}

const HOSTS = {
  'DSH': () => {
    const { watcher } = composeWatcher({
      sessionId: 's-override', cwd: CWD, store, turnNotesRoot: join(dir, 'turn-notes'),
      readSession: async () => ({ events: [] }), isIgnored, cacheTtl: () => null,
      workingTree: editableTree(FILES).workingTree,
    });
    return {
      watcher,
      // A rebuild of the Source: one fresh driver and the replace frame it installs.
      rebuild(segments) {
        const driver = createDshSourceDriver({ sessionId: 's-override', onDiagnostics: () => {} });
        return watcher.applyHarnessFrame(driver.install(dshEvents(segments)));
      },
    };
  },
  'Claude Code': () => {
    const file = join(dir, 's-override.jsonl');
    const watcher = createWatcherComposition({
      sessionId: 's-override', sourceLocator: file, projectId: 'p-override', projectRoot: CWD,
      stateDir: join(dir, 'state'), store, isIgnored, cacheTtl: null,
      workingTree: editableTree(FILES, CC_HOME).workingTree,
    });
    return {
      watcher,
      rebuild(segments) {
        writeFileSync(file, transcriptBytes(ccEntries(segments)));
        const driver = createClaudeCodeSourceDriver({ sourceLocator: file, firstReadableTransition: 'replace' });
        return watcher.applyHarnessFrame(driver.advance({ captureMode: 'live' }));
      },
    };
  },
};

const overrideOf = (watcher, path) => watcher.getBucketData().paths.find(row => row.path === path)?.userOverride ?? null;

for (const [host, open] of Object.entries(HOSTS)) {
  describe(`${host}: a user's overrides across a replace frame`, () => {
    test('a rebuild of the same segment keeps them in force and inference starts from them', () => {
      const { watcher, rebuild } = open();
      rebuild([[A]]);
      watcher.replaceUserOverrides({ [A]: 'include' });
      assert.equal(overrideOf(watcher, A), 'include');

      rebuild([[A, B]]);

      assert.equal(watcher.getStatus().segment, 0);
      assert.equal(overrideOf(watcher, A), 'include', 'the choice made before the rebuild is still in force');
      assert.equal(overrideOf(watcher, B), 'include',
        'the sibling inference that followed the rebuild read the user\'s include, not the ignored default');
    });

    test('a rebuild that lands in another segment drops them', () => {
      const { watcher, rebuild } = open();
      rebuild([[A]]);
      watcher.replaceUserOverrides({ [A]: 'include' });

      rebuild([[A], [A, B]]);

      assert.equal(watcher.getStatus().segment, 1, 'the rebuilt Source ends in its second segment');
      assert.equal(overrideOf(watcher, A), null);
      assert.equal(overrideOf(watcher, B), null);
    });

    test('a watcher no user has applied overrides to rebuilds with the policy\'s own selection', () => {
      const { watcher, rebuild } = open();
      rebuild([[A]]);

      rebuild([[A, B]]);

      assert.equal(overrideOf(watcher, A), null);
      assert.equal(overrideOf(watcher, B), null);
    });

    test('the set the user applied last is the one a rebuild restores', () => {
      const { watcher, rebuild } = open();
      rebuild([[A, B]]);
      watcher.replaceUserOverrides({ [A]: 'include' });
      watcher.replaceUserOverrides({ [B]: 'exclude' });

      rebuild([[A, B]]);

      assert.equal(overrideOf(watcher, A), null, 'the earlier set was replaced whole');
      assert.equal(overrideOf(watcher, B), 'exclude');
    });
  });
}
