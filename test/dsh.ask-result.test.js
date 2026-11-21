import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askAnswersOf } from '../lib/harness/dsh/ask-result.js';

const textOf = answers => JSON.stringify({ answers });

test('askAnswersOf reads each answer as id, selected and, where present, custom', () => {
  assert.deepEqual(askAnswersOf(textOf([
    { id: 'plan', selected: ['Ship now', 'Split'], custom: 'After the freeze' },
    { id: 'owner', selected: ['Platform'] },
    { id: 'empty', selected: [], custom: '' },
  ])), [
    { id: 'plan', selected: ['Ship now', 'Split'], custom: 'After the freeze' },
    { id: 'owner', selected: ['Platform'] },
    { id: 'empty', selected: [], custom: '' },
  ]);
});

test('askAnswersOf carries the id as given and validates nothing of it', () => {
  assert.deepEqual(askAnswersOf(textOf([{ id: 7, selected: ['A'] }, { selected: ['B'] }])),
    [{ id: 7, selected: ['A'] }, { id: undefined, selected: ['B'] }]);
});

test('askAnswersOf reads a result that is no answers value as no answers', () => {
  assert.deepEqual(askAnswersOf(textOf([])), []);
  for (const text of ['', 'The user is away.', textOf([{ id: 'a', selected: ['A'] }]).slice(0, -1), 'null', '[]',
    '{}', '{"answers":"yes"}', '{"answers":{"id":"a","selected":["A"]}}']) {
    assert.deepEqual(askAnswersOf(text), [], text);
  }
});

test('askAnswersOf reads the whole result as no answers when any one answer is malformed', () => {
  const good = { id: 'good', selected: ['Yes'], custom: 'Fine' };
  for (const bad of [
    { id: 'a', selected: 'Yes' },
    { id: 'a', selected: ['Yes', 1] },
    { id: 'a' },
    { id: 'a', selected: ['Yes'], custom: 3 },
    { id: 'a', selected: ['Yes'], custom: null },
    null,
    'Yes',
  ]) {
    assert.deepEqual(askAnswersOf(textOf([good, bad])), [], JSON.stringify(bad));
    assert.deepEqual(askAnswersOf(textOf([bad, good])), [], JSON.stringify(bad));
  }
});
