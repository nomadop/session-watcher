// #1: the pure CLI-arg parser must validate numeric args + fall back, never NaN-poison metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../server.js';

test('parseArgs: --ratio abc → null (not NaN)', () => {
  assert.equal(parseArgs(['--ratio', 'abc']).ratioOverride, null);
});

test('parseArgs: --ratio 0 → null (cRatio must be > 0)', () => {
  assert.equal(parseArgs(['--ratio', '0']).ratioOverride, null);
});

test('parseArgs: --ratio -3 → null (negative is invalid)', () => {
  assert.equal(parseArgs(['--ratio', '-3']).ratioOverride, null);
});

test('parseArgs: --ratio 12.5 → 12.5 (valid float kept)', () => {
  assert.equal(parseArgs(['--ratio', '12.5']).ratioOverride, 12.5);
});

test('parseArgs: --lbase abc → null (not NaN)', () => {
  assert.equal(parseArgs(['--lbase', 'abc']).lbase, null);
});

test('parseArgs: --lbase 55000 → 55000 (valid int kept)', () => {
  assert.equal(parseArgs(['--lbase', '55000']).lbase, 55000);
});

test('parseArgs: --lbase -5 → null (negative dead → baseline.total<=0 → permanent calibrating)', () => {
  assert.equal(parseArgs(['--lbase', '-5']).lbase, null);
});

test('parseArgs: --lbase 0 → 0 (zero is a valid injected dead)', () => {
  assert.equal(parseArgs(['--lbase', '0']).lbase, 0);
});

test('parseArgs: --port abc → 0 (ephemeral, never NaN)', () => {
  assert.equal(parseArgs(['--port', 'abc']).wantPort, 0);
});

test('parseArgs: --port -1 → 0 (out of range)', () => {
  assert.equal(parseArgs(['--port', '-1']).wantPort, 0);
});

test('parseArgs: --port 70000 → 0 (above 65535)', () => {
  assert.equal(parseArgs(['--port', '70000']).wantPort, 0);
});

test('parseArgs: --port 8080 → 8080 (valid port kept)', () => {
  assert.equal(parseArgs(['--port', '8080']).wantPort, 8080);
});

// M3: the removed `Number.isInteger(n)` guard was dead (parseInt yields int-or-NaN, and NaN is
// already excluded by Number.isFinite), so a fractional port was always truncated by parseInt.
// This locks in the documented, now-honest parseInt truncation semantics: --port 80.5 → 80.
test('parseArgs: --port 80.5 accepted as 80 (documented parseInt truncation, M3)', () => {
  const { wantPort } = parseArgs(['--port', '80.5']);
  assert.equal(wantPort, 80);
});

test('parseArgs: defaults when flags absent (lbase null, ratio null, port 0)', () => {
  const a = parseArgs([]);
  assert.equal(a.lbase, null);
  assert.equal(a.ratioOverride, null);
  assert.equal(a.wantPort, 0);
});

test('parseArgs: no numeric result is ever NaN', () => {
  const a = parseArgs(['--ratio', 'abc', '--lbase', 'xyz', '--port', 'nope']);
  assert.ok(!Number.isNaN(a.ratioOverride));
  assert.ok(!Number.isNaN(a.lbase));
  assert.ok(!Number.isNaN(a.wantPort));
});

test('parseArgs: passes through raw string args (transcript/project/session/open)', () => {
  const a = parseArgs(['--transcript', '/t/x.jsonl', '--project', '/p', '--session', 'sid', '--open']);
  assert.equal(a.transcript, '/t/x.jsonl');
  assert.equal(a.project, '/p');
  assert.equal(a.session, 'sid');
  assert.equal(a.open, true);
});

test('parseArgs: emits a stderr-bound warning when dropping a bad value', () => {
  const a = parseArgs(['--ratio', 'abc']);
  assert.ok(Array.isArray(a.warnings) && a.warnings.some(w => /ratio/i.test(w)));
});
