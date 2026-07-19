// test/historyChart.crosshair.test.js — Unit tests for crosshair pure helper functions
// Tests computeCrosshairLabel and computeLabelOffset extracted from the crosshair logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeCrosshairLabel, computeLabelOffset } from '../public/lib/crosshairHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- computeCrosshairLabel ---

test('label within data range: shows actual L value', () => {
  const points = [
    { L: 50000, g: 1000 },
    { L: 75000, g: 1500 },
    { L: 100000, g: 2000 },
  ];
  const label = computeCrosshairLabel(2, points, null);
  assert.equal(label, 'turn 2 · L=75k');
});

test('label at turn 1 (first point)', () => {
  const points = [{ L: 30000, g: 500 }];
  const label = computeCrosshairLabel(1, points, null);
  assert.equal(label, 'turn 1 · L=30k');
});

test('label at last data turn', () => {
  const points = [
    { L: 50000, g: 1000 },
    { L: 80000, g: 2000 },
  ];
  const label = computeCrosshairLabel(2, points, null);
  assert.equal(label, 'turn 2 · L=80k');
});

test('label rounds L to nearest k', () => {
  const points = [{ L: 74600, g: 1000 }];
  const label = computeCrosshairLabel(1, points, null);
  assert.equal(label, 'turn 1 · L=75k');
});

test('projection region: uses lastGEma slope when positive', () => {
  const points = [{ L: 100000, g: 1000 }];
  // lastDataTurn = 1; snappedTurn = 3; slope = lastGEma = 5000
  // projL = 100000 + 5000 * (3 - 1) = 110000
  const label = computeCrosshairLabel(3, points, 5000);
  assert.equal(label, 'projected L=110k');
});

test('projection region: falls back to g when lastGEma is not positive', () => {
  const points = [{ L: 100000, g: 3000 }];
  // slope = g = 3000; projL = 100000 + 3000 * (2 - 1) = 103000
  const label = computeCrosshairLabel(2, points, 0);
  assert.equal(label, 'projected L=103k');
});

test('projection region: falls back to g when lastGEma is null', () => {
  const points = [{ L: 50000, g: 2000 }];
  // slope = g = 2000; projL = 50000 + 2000 * (4 - 1) = 56000
  const label = computeCrosshairLabel(4, points, null);
  assert.equal(label, 'projected L=56k');
});

test('projection region: returns null when no slope and no data', () => {
  // No points = no projection
  const label = computeCrosshairLabel(5, [], null);
  assert.equal(label, null);
});

test('projection region: returns null when slope is zero and lastDataTurn is zero', () => {
  const label = computeCrosshairLabel(2, [], 0);
  assert.equal(label, null);
});

test('projection region: returns null when slope is zero even with data', () => {
  const points = [{ L: 50000, g: 0 }];
  // slope=0 (lastGEma=0, g=0) → cannot project
  const label = computeCrosshairLabel(2, points, 0);
  assert.equal(label, null);
});

// --- computeLabelOffset ---

test('label offset: near left side returns positive offset (label to right)', () => {
  // pixelX=100, ca.right=800 → fromRight=700 >= 80 → offset = +6
  const offset = computeLabelOffset(100, 800, 60);
  assert.equal(offset, 6);
});

test('label offset: near right side flips label to left', () => {
  // pixelX=750, ca.right=800 → fromRight=50 < 80 → offset = -(labelWidth + 6)
  const offset = computeLabelOffset(750, 800, 60);
  assert.equal(offset, -66); // -(60 + 6) = -66
});

test('label offset: exactly at threshold (fromRight=80) uses positive', () => {
  // fromRight = ca.right - pixelX = 800 - 720 = 80 → NOT less than 80 → +6
  const offset = computeLabelOffset(720, 800, 60);
  assert.equal(offset, 6);
});

test('label offset: fromRight=79 triggers flip', () => {
  // 800 - 721 = 79 < 80 → flip
  const offset = computeLabelOffset(721, 800, 60);
  assert.equal(offset, -66);
});

// --- v3: historyChart builds no Lstar/projection series ---

test('v3: historyChart imports and uses buildProjectionData for gEma projection line', () => {
  const src = readFileSync(path.join(__dirname, '../public/elements/historyChart.js'), 'utf8');

  assert.ok(
    src.includes('buildProjectionData'),
    'historyChart.js must import/use buildProjectionData for the projection line',
  );
  assert.ok(
    src.includes("id: 'projection'"),
    "historyChart.js must define a dataset with id: 'projection'",
  );
});
