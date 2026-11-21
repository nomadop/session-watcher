// `touchedOf` (`lib/inner-seal/touched.js`): the held files and skills a set of replaced seqs touched, read off a held
// view's per-effect attribution. The held views here are written by hand; `test/held-view.test.js` holds how a view
// attributes its effects.
import test from 'node:test';
import assert from 'node:assert/strict';

import { touchedOf } from '../lib/inner-seal/touched.js';

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';
const C = '/repo/src/c.js';

// Held: three files and two skills. Seqs 10 to 13 are results, 20 the call message of the result at 21, 30 a pruner
// replacement standing for the original result at 11.
const held = {
  paths: new Map([[A, [2, 3, 4]], [B, [1, 2, 3]], [C, [1, 2]]]),
  skills: new Map([['tdd', 'TDD again'], ['grill', 'Grill body']]),
  effects: [
    { seq: 10, kind: 'path', key: A },
    { seq: 11, kind: 'path', key: B },
    { seq: 12, kind: 'path', key: C },
    { seq: 13, kind: 'path', key: A },
    { seq: 14, kind: 'skill', key: 'tdd' },
    { seq: 15, kind: 'skill', key: 'grill' },
    { seq: 16, kind: 'skill', key: 'tdd' },
  ],
};

test('a file is touched by a read or a write of it among the seqs, an unchanged re-read included, and keeps the lines it is held over', () => {
  assert.deepEqual(touchedOf(held, [11, 12]), { paths: new Map([[B, [1, 2, 3]], [C, [1, 2]]]), skills: new Map() });
  assert.deepEqual(touchedOf(held, [13]), { paths: new Map([[A, [2, 3, 4]]]), skills: new Map() });
});

test('no seqs touch nothing', () => {
  assert.deepEqual(touchedOf(held, []), { paths: new Map(), skills: new Map() });
});

test('a seq that holds no effect touches nothing: a call message alone, or a pruner replacement alone while its original touches', () => {
  assert.deepEqual(touchedOf(held, [20]), { paths: new Map(), skills: new Map() });
  assert.deepEqual(touchedOf(held, [30]), { paths: new Map(), skills: new Map() });
  assert.deepEqual(touchedOf(held, [30, 11]), { paths: new Map([[B, [1, 2, 3]]]), skills: new Map() });
});

test('a skill is touched by its load among the seqs, a repeated load included, and keeps its held text', () => {
  assert.deepEqual(touchedOf(held, [15, 16]), { paths: new Map(), skills: new Map([['tdd', 'TDD again'], ['grill', 'Grill body']]) });
  assert.deepEqual(touchedOf(held, [15]), { paths: new Map(), skills: new Map([['grill', 'Grill body']]) });
  assert.deepEqual(touchedOf(held, [14, 20]), { paths: new Map(), skills: new Map([['tdd', 'TDD again']]) });
});

test('a file and a skill of one name are two keys: a skill\'s effect touches no file of its name', () => {
  const named = {
    paths: new Map([['tdd', [1]]]),
    skills: new Map([['tdd', 'TDD body']]),
    effects: [{ seq: 1, kind: 'skill', key: 'tdd' }],
  };
  assert.deepEqual(touchedOf(named, [1]), { paths: new Map(), skills: new Map([['tdd', 'TDD body']]) });
});

test('a key no longer held is no result, and one touched by several effects is one entry, in the held order', () => {
  const later = {
    paths: new Map([[B, [1, 2, 3]], [A, [2, 3, 4]]]),
    skills: new Map([['grill', 'Grill body']]),
    effects: [
      { seq: 10, kind: 'path', key: A },
      { seq: 11, kind: 'path', key: C },
      { seq: 12, kind: 'path', key: B },
      { seq: 13, kind: 'path', key: A },
      { seq: 14, kind: 'skill', key: 'tdd' },
      { seq: 15, kind: 'skill', key: 'grill' },
      { seq: 16, kind: 'skill', key: 'grill' },
    ],
  };
  const touched = touchedOf(later, [10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual([...touched.paths], [[B, [1, 2, 3]], [A, [2, 3, 4]]]);
  assert.deepEqual([...touched.skills], [['grill', 'Grill body']]);
});
