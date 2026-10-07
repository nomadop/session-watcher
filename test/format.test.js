// The shared formatters the dock reads: br as a floor percent, u to one decimal, a token count whole with its unit, Δ under renderDelta's availability rule, and the wallet clock's phase as renderMeterV3's clamped floor percent, each a placeholder when its value is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBr, formatU, formatDelta, formatPhase, phasePercent, formatTokens } from '../public/lib/format.js';

const PLACEHOLDER = '—';

test('formatBr answers the placeholder unless br is finite and non-negative, else its floor percent', () => {
  for (const br of [null, undefined, NaN, Infinity, -0.01]) assert.equal(formatBr(br), PLACEHOLDER, String(br));
  assert.equal(formatBr(0), '0%');
  assert.equal(formatBr(0.129), '12%');
  assert.equal(formatBr(1.5), '150%');
});

test('formatU answers the placeholder unless u is finite, else u to one decimal', () => {
  for (const u of [null, undefined, NaN, -Infinity]) assert.equal(formatU(u), PLACEHOLDER, String(u));
  assert.equal(formatU(0), '0.0');
  assert.equal(formatU(1.26), '1.3');
});

test('formatTokens answers the placeholder unless the count is finite, else the count rounded whole and grouped by thousands with the tok unit', () => {
  for (const n of [null, undefined, NaN, Infinity]) assert.equal(formatTokens(n), PLACEHOLDER, String(n));
  assert.equal(formatTokens(0), '0 tok');
  assert.equal(formatTokens(450.4), '450 tok');
  assert.equal(formatTokens(999), '999 tok');
  assert.equal(formatTokens(12345), '12,345 tok');
  assert.equal(formatTokens(1234567), '1,234,567 tok');
});

test('formatDelta answers the placeholder unless gEma is finite and at least one, else its token count', () => {
  for (const gEma of [null, undefined, NaN, Infinity, 0, 0.99]) assert.equal(formatDelta(gEma), PLACEHOLDER, String(gEma));
  assert.equal(formatDelta(1), formatTokens(1));
  assert.equal(formatDelta(450.4), '450 tok');
  assert.equal(formatDelta(12345), '12,345 tok');
});

test('formatPhase answers the placeholder unless the phase is finite, else the floor percent of the phase clamped below one', () => {
  for (const phase of [null, undefined, NaN, Infinity]) assert.equal(formatPhase(phase), PLACEHOLDER, String(phase));
  assert.equal(formatPhase(-0.2), '0%');
  assert.equal(formatPhase(0.379), '37%');
  assert.equal(formatPhase(1), '99%');
  assert.equal(formatPhase(3), '99%');
});

test('phasePercent is the floor percent of the phase clamped below one, the number formatPhase prints', () => {
  assert.equal(phasePercent(-0.2), 0);
  assert.equal(phasePercent(0.379), 37);
  assert.equal(phasePercent(1), 99);
  assert.equal(phasePercent(3), 99);
  assert.ok(Number.isNaN(phasePercent(NaN)));
});
