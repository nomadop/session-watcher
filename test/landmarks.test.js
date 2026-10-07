import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nucleus } from '../lib/landmarks.js';

const R = 10, G = 940, B = 55000;

test('nucleus guards non-positive inputs → 0', () => {
  assert.equal(nucleus(0, G, B), 0);
  assert.equal(nucleus(R, 0, B), 0);
  assert.equal(nucleus(R, G, 0), 0);
});
