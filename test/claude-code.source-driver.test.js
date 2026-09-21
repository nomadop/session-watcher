// test/claude-code.source-driver.test.js — incremental Claude Code Source acquisition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import { ts, userMessage, assistantObservation } from './helpers/transcript-fixtures.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sw-cc-source-'));
}

function usageRow({ uuid, parentUuid = null, messageId, timestamp, text = 'ok', cacheRead = 100 }) {
  const entry = assistantObservation({
    uuid, parentUuid, messageId, timestamp, blocks: [{ type: 'text', text }],
  });
  entry.message.usage = {
    input_tokens: 2, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
  };
  return entry;
}

function line(entry) {
  return JSON.stringify(entry) + '\n';
}

function newSource(entries = []) {
  const path = join(tmpDir(), 'session.jsonl');
  writeFileSync(path, entries.map(line).join(''));
  return path;
}

function typesOf(batches) {
  return batches.map(batch => batch.map(o => o.type));
}

const ORIGIN = userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) });
const FIRST_CALL = usageRow({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2) });

// --- First readable advance ---

test('a default driver first readable advance is replace and carries the locator', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });

  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.sourceLocator, path);
  assert.equal(frame.sourceObserved, true);
  assert.equal(frame.captureMode, 'live');
  assert.equal(driver.sourceLocator, path);
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text'], ['text', 'usage']]);
});

test('a first successful read emits the configured transition even with no complete valid row', () => {
  const cases = [
    ['empty', ''],
    ['incomplete only', JSON.stringify(ORIGIN)],
    ['all malformed', 'not-json\nalso-not-json\n'],
  ];
  for (const [label, content] of cases) {
    const path = join(tmpDir(), 'session.jsonl');
    writeFileSync(path, content);
    const driver = createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'append' });

    const frame = driver.advance();

    assert.equal(frame.transition, 'append', label);
    assert.equal(frame.sourceObserved, true, label);
    assert.deepEqual(frame.batches, [], label);
    assert.ok(!Object.hasOwn(frame, 'sourceLocator'), `${label}: an append frame carries no locator`);
  }
});

// The driver validates no capture mode: it passes the caller's mode through, and the only mode it
// originates is the replay a rewind owes. This test asserts the pass-through, which is all the code
// guarantees on its own.
test('a frame carries the caller live or replay capture mode unchanged', () => {
  const path = newSource([ORIGIN]);
  const byDefault = createClaudeCodeSourceDriver({ sourceLocator: path }).advance();
  const live = createClaudeCodeSourceDriver({ sourceLocator: path }).advance({ captureMode: 'live' });
  const replay = createClaudeCodeSourceDriver({ sourceLocator: path }).advance({ captureMode: 'replay' });

  assert.equal(byDefault.captureMode, 'live');
  assert.equal(live.captureMode, 'live');
  assert.equal(replay.captureMode, 'replay');
});

// --- Incremental appends ---

test('later linear bytes produce append and preserve reducer batch boundaries', () => {
  const path = newSource([ORIGIN]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  assert.equal(driver.advance().transition, 'replace');

  appendFileSync(path, line(FIRST_CALL) + line(usageRow({
    uuid: 'a2', parentUuid: 'a1', messageId: 'msg_2', timestamp: ts(3), text: 'more',
  })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'append');
  assert.equal(frame.sourceObserved, true);
  assert.deepEqual(typesOf(frame.batches), [['text', 'usage'], ['text', 'usage']]);
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [2, 3]);
});

test('after initialization no complete new row produces no frame', () => {
  const path = newSource([ORIGIN]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  driver.advance();

  assert.equal(driver.advance(), null);

  appendFileSync(path, JSON.stringify(FIRST_CALL)); // no LF yet
  assert.equal(driver.advance(), null, 'an incomplete final row stays pending');
});

test('an incomplete first row is parsed after its LF arrives', () => {
  const path = join(tmpDir(), 'session.jsonl');
  writeFileSync(path, JSON.stringify(ORIGIN));
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });

  assert.deepEqual(driver.advance().batches, []);
  appendFileSync(path, '\n');
  const frame = driver.advance();

  assert.equal(frame.transition, 'append');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text']]);
  assert.equal(frame.batches[0][0].sourceOrdinal, 1);
});

test('a multi-byte code point split across advances is emitted intact', () => {
  const path = join(tmpDir(), 'session.jsonl');
  const bytes = Buffer.from(line(userMessage({ uuid: 'u1', text: '你好世界', timestamp: ts(1) })), 'utf8');
  const cutInsideCodePoint = bytes.indexOf(Buffer.from('你', 'utf8')) + 2;
  writeFileSync(path, bytes.subarray(0, cutInsideCodePoint));
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });

  assert.deepEqual(driver.advance().batches, []);
  appendFileSync(path, bytes.subarray(cutInsideCodePoint));
  const frame = driver.advance();

  const text = frame.batches[0].find(o => o.type === 'text').text;
  assert.equal(text, '你好世界');
  assert.ok(!text.includes('�'), 'no replacement character');
});

test('malformed complete rows advance the cursor and ordinal and later valid rows are emitted', () => {
  const path = join(tmpDir(), 'session.jsonl');
  writeFileSync(path, 'not-json\n');
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  assert.deepEqual(driver.advance().batches, []);

  appendFileSync(path, 'still-not-json\n' + line(ORIGIN));
  const frame = driver.advance();

  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text']]);
  assert.equal(frame.batches[0][0].sourceOrdinal, 3, 'ordinals count every physical row');
});

test('an absolute byteLimit ending at the first row LF commits only that row', () => {
  const first = line(ORIGIN);
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });

  const bounded = driver.advance({ byteLimit: first.length });
  assert.deepEqual(typesOf(bounded.batches), [['turn-boundary', 'text']]);

  const rest = driver.advance();
  assert.deepEqual(typesOf(rest.batches), [['text', 'usage']]);
  assert.equal(rest.batches[0][0].sourceOrdinal, 2);
});

// --- Replacement transitions ---

test('a canonical compact root appends an epoch-boundary rather than a stale-branch replace', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  driver.advance();

  appendFileSync(path, line(userMessage({ uuid: 'u2', text: 'after compact', timestamp: ts(3) })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'append');
  assert.equal(frame.captureMode, 'live');
  assert.deepEqual(typesOf(frame.batches), [['epoch-boundary', 'turn-boundary', 'text']]);
});

test('a stale branch rewind produces replace with a fresh canonical snapshot in replay mode', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  driver.advance();

  // A sibling of the first call, written later: the branch the driver last saw is no longer canonical.
  appendFileSync(path, line(usageRow({
    uuid: 'a2', parentUuid: 'u1', messageId: 'msg_2', timestamp: ts(3), text: 'redone', cacheRead: 120,
  })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.sourceLocator, path);
  assert.equal(frame.captureMode, 'replay', 'a rewind reconstructs already-written facts');
  assert.equal(frame.sourceObserved, true);
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text'], ['text', 'usage']]);
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [1, 3],
    'the abandoned sibling is absent from the fresh snapshot');
  assert.equal(frame.batches.flat().filter(o => o.type === 'epoch-boundary').length, 0);
});

// One advance can both fork an existing root and open a compact root. The compact explains the new
// root, it does not explain the fork: the sibling written after `a1` leaves `a1` off every canonical
// branch, so the batch the consumer already holds has to be withdrawn.
test('an advance that both forks and compacts withdraws the branch the consumer holds', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  assert.deepEqual(typesOf(driver.advance().batches), [['turn-boundary', 'text'], ['text', 'usage']]);

  appendFileSync(path, line(usageRow({
    uuid: 'a2', parentUuid: 'u1', messageId: 'msg_2', timestamp: ts(3), text: 'redone', cacheRead: 120,
  })) + line(userMessage({ uuid: 'c1', text: 'after compact', timestamp: ts(4) })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.captureMode, 'replay', 'a withdrawal reconstructs already-written facts');
  // `activePath` lands correctly even when the withdrawal is skipped, so the evidence is the frame
  // itself: a replaying frame carries the whole canonical Source, as a from-scratch read does.
  const fresh = createClaudeCodeSourceDriver({ sourceLocator: path }).advance();
  assert.deepEqual(frame.batches, fresh.batches);
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [1, 3, 4],
    'the abandoned sibling is absent and the surviving origin is back');
});

test('a rewind snapshot re-emits every canonical epoch of the Source', () => {
  const secondOrigin = userMessage({ uuid: 'u2', text: 'after compact', timestamp: ts(3) });
  const path = newSource([ORIGIN, FIRST_CALL, secondOrigin, usageRow({
    uuid: 'b1', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(4), text: 'kept',
  })]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  assert.equal(driver.advance().batches.flat().filter(o => o.type === 'epoch-boundary').length, 1);

  appendFileSync(path, line(usageRow({
    uuid: 'b2', parentUuid: 'u2', messageId: 'msg_3', timestamp: ts(5), text: 'redone',
  })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  const epochs = frame.batches.flat().filter(o => o.type === 'epoch-boundary');
  assert.deepEqual(epochs.map(o => o.sourceEntryId), ['u2'], 'the fresh snapshot carries its epoch again');
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [1, 2, 3, 5]);
});

test('inode replacement rebuilds, produces replace, retains the capture mode, and emits no epoch', () => {
  const dir = tmpDir();
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, [ORIGIN, FIRST_CALL].map(line).join(''));
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  driver.advance();

  const replacement = join(dir, 'replacement.jsonl');
  const freshOrigin = userMessage({ uuid: 'v1', text: 'new session', timestamp: ts(5) });
  writeFileSync(replacement, [freshOrigin, usageRow({
    uuid: 'b1', parentUuid: 'v1', messageId: 'msg_9', timestamp: ts(6),
  })].map(line).join(''));
  renameSync(replacement, path);

  const frame = driver.advance({ captureMode: 'live' });

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.captureMode, 'live', 'the triggering capture mode is retained');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text'], ['text', 'usage']]);
  assert.equal(frame.batches.flat().filter(o => o.type === 'epoch-boundary').length, 0);
  assert.equal(frame.batches[0][0].sourceEntryId, 'v1');
});

test('truncation rebuilds, produces replace, retains the capture mode, and emits no epoch', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path });
  driver.advance();

  writeFileSync(path, line(userMessage({ uuid: 'w1', text: 'shorter', timestamp: ts(7) })));
  const frame = driver.advance({ captureMode: 'replay' });

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.captureMode, 'replay');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text']]);
  assert.equal(frame.batches[0][0].sourceEntryId, 'w1');
  assert.equal(frame.batches.flat().filter(o => o.type === 'epoch-boundary').length, 0);
});

test('an inode replacement after an initial append still produces replace', () => {
  const dir = tmpDir();
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, line(ORIGIN));
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'append' });
  assert.equal(driver.advance().transition, 'append');

  const replacement = join(dir, 'replacement.jsonl');
  writeFileSync(replacement, line(userMessage({ uuid: 'v1', text: 'new session', timestamp: ts(5) })));
  renameSync(replacement, path);

  assert.equal(driver.advance().transition, 'replace');
});

test('a truncation after an initial append still produces replace', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'append' });
  assert.equal(driver.advance().transition, 'append');

  writeFileSync(path, line(userMessage({ uuid: 'w1', text: 'shorter', timestamp: ts(7) })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.batches[0][0].sourceEntryId, 'w1');
});

test('a rewind after an initial append still produces replace', () => {
  const path = newSource([ORIGIN, FIRST_CALL]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'append' });
  assert.equal(driver.advance().transition, 'append');

  appendFileSync(path, line(usageRow({
    uuid: 'a2', parentUuid: 'u1', messageId: 'msg_2', timestamp: ts(3), text: 'redone', cacheRead: 120,
  })));
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.equal(frame.captureMode, 'replay');
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [1, 3]);
});

// --- Independence ---

test('two drivers read independent locators without mutating each other', () => {
  const current = newSource([ORIGIN, FIRST_CALL]);
  const candidate = newSource([userMessage({ uuid: 'z1', text: 'candidate', timestamp: ts(1) })]);
  const installed = createClaudeCodeSourceDriver({ sourceLocator: current });
  const next = createClaudeCodeSourceDriver({ sourceLocator: candidate, firstReadableTransition: 'append' });

  installed.advance();
  const candidateFrame = next.advance();
  appendFileSync(current, line(usageRow({
    uuid: 'a2', parentUuid: 'a1', messageId: 'msg_2', timestamp: ts(3), text: 'more',
  })));
  const installedFrame = installed.advance();

  assert.equal(candidateFrame.transition, 'append');
  assert.equal(next.sourceLocator, candidate);
  assert.equal(installed.sourceLocator, current);
  assert.equal(installedFrame.transition, 'append');
  assert.deepEqual(typesOf(installedFrame.batches), [['text', 'usage']]);
  assert.equal(installedFrame.batches[0][0].sourceOrdinal, 3);
});

// --- Acquisition failures ---

// One scripted Source: `content` and `ino` are mutable so a test can truncate or replace the file, and
// `failReadsAt` names the read call numbers that throw, which is how a rebuild trigger and its failing
// read land inside one advance.
function scriptedSource({ content = '', ino = 1 } = {}) {
  const state = { content, ino, statError: null, closeError: null, failReadsAt: new Set() };
  const calls = { read: 0, close: 0 };
  return {
    state,
    calls,
    fs: {
      open: () => 7,
      stat: () => {
        if (state.statError) throw state.statError;
        return { size: Buffer.byteLength(state.content), ino: state.ino };
      },
      read: (fd, buffer, offset, length, position) => {
        calls.read++;
        if (state.failReadsAt.has(calls.read)) throw new Error('EIO');
        return Buffer.from(state.content, 'utf8').copy(buffer, offset, position, position + length);
      },
      close: () => { calls.close++; if (state.closeError) throw state.closeError; },
    },
  };
}

test('open failure produces no frame, advances no state, and does not consume the transition', () => {
  const path = newSource([ORIGIN]);
  let openError = new Error('ENOENT');
  const driver = createClaudeCodeSourceDriver({
    sourceLocator: path,
    open: (...args) => { if (openError) throw openError; return openSync(...args); },
  });

  assert.equal(driver.advance(), null);
  openError = null;
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace', 'the first readable transition was not consumed');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text']]);
});

test('stat failure produces no frame, closes once, and advances no driver state', () => {
  const { state, calls, fs } = scriptedSource({ content: line(ORIGIN) + line(FIRST_CALL) });
  state.statError = new Error('EIO');
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });

  assert.equal(driver.advance(), null);
  assert.equal(calls.close, 1);
  assert.equal(calls.read, 0);

  state.statError = null;
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace', 'the first readable transition was not consumed');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text'], ['text', 'usage']],
    'the cursor never moved, so the whole Source is still ahead of it');
});

test('read failure produces no frame and closes the descriptor exactly once', () => {
  const { state, calls, fs } = scriptedSource({ content: line(ORIGIN) });
  state.failReadsAt = new Set([1]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });

  assert.equal(driver.advance(), null);
  assert.equal(calls.close, 1);
});

test('a read failure leaves the cursor and first transition intact for the next advance', () => {
  const { state, fs } = scriptedSource({ content: line(ORIGIN) + line(FIRST_CALL) });
  state.failReadsAt = new Set([1]);
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });

  assert.equal(driver.advance(), null);
  const frame = driver.advance();

  assert.equal(frame.transition, 'replace');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text'], ['text', 'usage']]);
});

test('a truncation whose read fails owes a replace that still takes the caller capture mode', () => {
  const { state, fs } = scriptedSource({ content: line(ORIGIN) + line(FIRST_CALL) });
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });
  assert.equal(driver.advance().transition, 'replace');

  // The truncation fires on the advance whose read then fails, so neither trigger can fire again: the
  // cursor is already back at the start and the inode never changed. The two advances pass different
  // modes, so the frame's mode names which one an identity-change rebuild retains.
  state.content = line(userMessage({ uuid: 'w1', text: 'shorter', timestamp: ts(7) }));
  state.failReadsAt = new Set([2]);
  assert.equal(driver.advance({ captureMode: 'replay' }), null);

  const frame = driver.advance({ captureMode: 'live' });

  assert.equal(frame.transition, 'replace', 'the owed rebuild survives the failed advance');
  assert.equal(frame.captureMode, 'live', 'an identity-change rebuild owes no mode of its own');
  assert.equal(frame.sourceLocator, '/fake');
  assert.deepEqual(typesOf(frame.batches), [['turn-boundary', 'text']]);
  assert.equal(frame.batches[0][0].sourceEntryId, 'w1');
});

test('a rewind whose whole-Source read fails owes a replace that still reconstructs in replay mode', () => {
  const { state, fs } = scriptedSource({ content: line(ORIGIN) + line(FIRST_CALL) });
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });
  assert.equal(driver.advance().transition, 'replace');

  // Read two is the increment that reveals the stale branch; read three is the reconstruction it needs.
  state.content += line(usageRow({
    uuid: 'a2', parentUuid: 'u1', messageId: 'msg_2', timestamp: ts(3), text: 'redone', cacheRead: 120,
  }));
  state.failReadsAt = new Set([3]);
  assert.throws(() => driver.advance(), /EIO/);

  state.failReadsAt = new Set();
  const frame = driver.advance({ captureMode: 'live' });

  assert.equal(frame.transition, 'replace', 'the owed rebuild survives the failed reconstruction');
  assert.equal(frame.captureMode, 'replay',
    'the frame that finally carries already-written rows is not labelled live capture');
  assert.deepEqual(frame.batches.map(batch => batch[0].sourceOrdinal), [1, 3]);
});

test('close failure throws and prevents later Source reads', () => {
  const { state, calls, fs } = scriptedSource({ content: line(ORIGIN) });
  state.closeError = new Error('EBADF');
  const driver = createClaudeCodeSourceDriver({ sourceLocator: '/fake', ...fs });

  assert.throws(() => driver.advance(), /EBADF/);
  const readsAfterFailure = calls.read;

  assert.throws(() => driver.advance(), /EBADF/);
  assert.equal(calls.read, readsAfterFailure, 'no Source read follows a close failure');
});
