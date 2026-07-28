// test/line-calibrator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineCalibrator } from '../lib/line-calibrator.js';

test('LineCalibrator: starts with default offsets', () => {
  const cal = new LineCalibrator();
  assert.equal(cal.getOffset('serena_find_symbol'), 1);
  assert.equal(cal.getOffset('bash_grep_n'), 0);
  assert.equal(cal.getOffset('unknown_tool'), 0);
});

test('LineCalibrator: locks after 3 confirming pairs', () => {
  const cal = new LineCalibrator();
  // Simulate 3 pairs where offset=+1 is correct
  // Ground truth: lines {10: 'a', 11: 'b', 12: 'c'}
  const truth = new Map([[10, 'a'], [11, 'b'], [12, 'c']]);
  // Tool reports start_line=9 (0-based), body lines ['a', 'b', 'c']
  // At offset +1: tool_line 9+1=10 → truth 'a' ✓, 10+1=11 → 'b' ✓, etc.
  for (let i = 0; i < 3; i++) {
    cal.observePair('serena_find_symbol', [
      { num: 9, content: 'a' },
      { num: 10, content: 'b' },
      { num: 11, content: 'c' },
    ], truth);
  }
  assert.equal(cal.isLocked('serena_find_symbol'), true);
  assert.equal(cal.getOffset('serena_find_symbol'), 1);
});

test('LineCalibrator: does not lock on ambiguous data', () => {
  const cal = new LineCalibrator();
  // No truth overlap → uninformative
  const truth = new Map([[100, 'x'], [101, 'y']]);
  cal.observePair('serena_find_symbol', [
    { num: 5, content: 'unrelated' },
    { num: 6, content: 'stuff' },
  ], truth);
  assert.equal(cal.isLocked('serena_find_symbol'), false);
});

test('LineCalibrator: detects offset=0 for grep', () => {
  const cal = new LineCalibrator();
  const truth = new Map([[5, 'hello'], [6, 'world'], [7, 'foo']]);
  for (let i = 0; i < 3; i++) {
    cal.observePair('bash_grep_n', [
      { num: 5, content: 'hello' },
      { num: 6, content: 'world' },
      { num: 7, content: 'foo' },
    ], truth);
  }
  assert.equal(cal.isLocked('bash_grep_n'), true);
  assert.equal(cal.getOffset('bash_grep_n'), 0);
});

test('LineCalibrator: emits debug warning on mismatch after lock', () => {
  const cal = new LineCalibrator();
  const truth = new Map([[10, 'a'], [11, 'b'], [12, 'c']]);
  // Lock with offset=+1
  for (let i = 0; i < 3; i++) {
    cal.observePair('serena_find_symbol', [
      { num: 9, content: 'a' }, { num: 10, content: 'b' }, { num: 11, content: 'c' },
    ], truth);
  }
  assert.equal(cal.isLocked('serena_find_symbol'), true);
  // Now feed contradicting data — should increment mismatch counter
  cal.observePair('serena_find_symbol', [
    { num: 10, content: 'a' }, { num: 11, content: 'b' }, { num: 12, content: 'c' },
  ], truth);
  assert.equal(cal.getMismatchCount('serena_find_symbol'), 1);
});
