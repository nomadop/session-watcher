import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { lineFragments, effectFor, pathEventsFor } from '../lib/tool-effects.js';

describe('lineFragments', () => {
  test('keeps the last tokens of a repeated line', () => {
    assert.deepEqual(
      lineFragments([[1, 10], [2, 20], [1, 99]]),
      [{ key: 1, tokens: 99 }, { key: 2, tokens: 20 }],
    );
  });
});

describe('effectFor', () => {
  test('grepMultiFile maps to one merge-fragments impact per file', () => {
    const update = { type: 'grepMultiFile', files: { a: [[1, 5]], b: [[2, 7]] }, overhead: 3, spent: 15 };
    const effect = effectFor(update, null);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 3);
    assert.equal(effect.spentTokens, 15);
    assert.deepEqual(effect.impacts, [
      { resourceKey: 'a', mutation: { kind: 'merge-fragments', fragments: [{ key: 1, tokens: 5 }] } },
      { resourceKey: 'b', mutation: { kind: 'merge-fragments', fragments: [{ key: 2, tokens: 7 }] } },
    ]);
  });

  test('fullSet maps to replace-fragments', () => {
    const update = { type: 'fullSet', lines: [[1, 10]], overhead: 2, spent: 12 };
    const effect = effectFor(update, '/repo/a.md');
    assert.equal(effect.access, 'read');
    assert.deepEqual(effect.impacts, [
      { resourceKey: '/repo/a.md', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 10 }] } },
    ]);
  });

  test('write maps to replace-fragments with access write', () => {
    const update = { type: 'write', lines: [[1, 4]], overhead: 1, spent: 5 };
    const effect = effectFor(update, '/repo/a.md');
    assert.equal(effect.access, 'write');
    assert.deepEqual(effect.impacts, [
      { resourceKey: '/repo/a.md', mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 4 }] } },
    ]);
  });

  test('lineUpdate maps to merge-fragments', () => {
    const update = { type: 'lineUpdate', lines: [[3, 6]], overhead: 1, spent: 7 };
    const effect = effectFor(update, '/repo/a.md');
    assert.equal(effect.access, 'read');
    assert.deepEqual(effect.impacts, [
      { resourceKey: '/repo/a.md', mutation: { kind: 'merge-fragments', fragments: [{ key: 3, tokens: 6 }] } },
    ]);
  });

  test('anything else maps to adjust-total with no overhead', () => {
    const update = { type: 'editDelta', value: 42, spent: 5 };
    const effect = effectFor(update, '/repo/a.md');
    assert.equal(effect.access, 'write');
    assert.equal(effect.overheadTokens, 0);
    assert.deepEqual(effect.impacts, [
      { resourceKey: '/repo/a.md', mutation: { kind: 'adjust-total', deltaTokens: 42 } },
    ]);
  });
});

describe('pathEventsFor', () => {
  test('fans a multi-file read out per file', () => {
    const update = { type: 'grepMultiFile', files: { '/a': [[1, 1]], '/b': [[2, 2]] } };
    assert.deepEqual(pathEventsFor(update, null, null, 'Grep'), [
      { path: '/a', rawPath: '/a', toolType: 'Grep', isFullRead: 0 },
      { path: '/b', rawPath: '/b', toolType: 'Grep', isFullRead: 0 },
    ]);
  });

  test('marks a full read', () => {
    const update = { type: 'fullSet', lines: [[1, 1]] };
    assert.deepEqual(pathEventsFor(update, '/a', '/raw/a', 'Bash'), [
      { path: '/a', rawPath: '/raw/a', toolType: 'Bash', isFullRead: 1 },
    ]);
  });
});
