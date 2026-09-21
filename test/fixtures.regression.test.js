// One real vendor transcript, read end to end through the shipped composition. Every other measurement test
// builds its rows, so this is the only place a transcript this project did not author decides the outcome:
// the fixture is DeepSeek, whose usage rows carry no cache_creation at all, and the assertions are the two
// facts a provider change could silently break — that snapshot rows of one logical message collapse into one
// measured call, and that a session with real traffic reports positive stock and a positive belief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import { createWatcherComposition } from '../server.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';

const DS = 'fixtures/host/.claude/projects/C--Users-nomad-freshtrack/aa8e3739-3264-48d6-a2a0-75346d583c03.jsonl';

// The shipped composition over the real Source: one advance reads the whole file, and the frame it produces
// is applied the way the host's poll tick applies it.
function measureFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-fixture-'));
  const store = openStore(join(dir, 'store.sqlite'));
  try {
    const watcher = createWatcherComposition({
      sessionId: 'fixture-deepseek', sourceLocator: DS, projectId: '/repo', projectRoot: '/repo',
      stateDir: join(dir, 'state'), store, isIgnored: null,
    });
    const driver = createClaudeCodeSourceDriver({ sourceLocator: DS });
    const frame = driver.advance();
    assert.ok(frame, 'the fixture Source produces a frame');
    watcher.applyHarnessFrame(frame);
    return { status: watcher.getStatus(), history: watcher.getHistory() };
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a real DeepSeek transcript folds its snapshot rows into one call each', { skip: !existsSync(DS) }, () => {
  const rows = readFileSync(DS, 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(entry => entry && entry.type === 'assistant' && entry.message?.usage);
  const distinctIds = new Set(rows.map(entry => entry.message.id).filter(Boolean));
  assert.ok(rows.length > distinctIds.size, 'the fixture must actually contain snapshot revisions');

  const { history } = measureFixture();
  assert.ok(history.length <= distinctIds.size + 1,
    `measured calls (${history.length}) track distinct message ids (${distinctIds.size}), not raw rows (${rows.length})`);
});

test('a real DeepSeek transcript reports positive stock and belief', { skip: !existsSync(DS) }, () => {
  const { status, history } = measureFixture();
  assert.ok(history.length > 5, `the fixture carries real traffic, got ${history.length} calls`);
  assert.ok(status.L > 0, 'the observed context stock is positive');
  assert.ok(status.B > 0, 'the rebuildable belief is positive');
});
