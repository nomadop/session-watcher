// `public/elements/fileDrawer.js`'s reading of the answer of `POST /api/bucket/file`: what the drawer shows for each answer, as the rows of the lines it holds or one sentence of notice.
// The drawer itself is a DOM element, which `test/e2e/file-drawer.spec.js` drives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileViewOf } from '../public/elements/fileDrawer.js';

const lines = (...numbers) => numbers.map(number => ({ number, text: `l${number}` }));
const line = number => ({ type: 'line', number, text: `l${number}` });
const notice = text => ({ kind: 'notice', text });

test('an answer with lines is the rows of the file, a gap row for every stretch it holds none of, and how many lines it holds of how many', () => {
  const body = { path: '/repo/a.js', total: 9, runs: [{ offset: 2, lines: lines(2, 3) }, { offset: 6, lines: lines(6) }] };
  assert.deepEqual(fileViewOf(body), {
    kind: 'rows', held: 3, total: 9,
    rows: [{ type: 'gap', first: 1, last: 1 }, line(2), line(3), { type: 'gap', first: 4, last: 5 }, line(6), { type: 'gap', first: 7, last: 9 }],
  });
});

test('an answer whose file has no held line is a notice and no rows, a run of no line at the first line of an empty file included', () => {
  const none = notice('No lines of this file are held in the current context.');
  assert.deepEqual(fileViewOf({ path: '/repo/a.js', total: 9, runs: [] }), none);
  assert.deepEqual(fileViewOf({ path: '/repo/a.js', total: 0, runs: [{ offset: 1, lines: [] }] }), none);
});

test('a file that cannot be read is said so with its reason in words, and a reason the drawer has no word for as it is', () => {
  const words = { missing: 'Missing', 'not-file': 'Not a file', 'too-large': 'Too large', binary: 'Binary', unreadable: 'Cannot be read' };
  for (const [reason, word] of Object.entries(words)) {
    assert.deepEqual(fileViewOf({ path: '/repo/a.js', reason }), notice(`Unreadable: ${word}`), reason);
  }
  assert.deepEqual(fileViewOf({ path: '/repo/a.js', reason: 'new-reason' }), notice('Unreadable: new-reason'));
});

test('a path the host says it no longer holds is its own notice, and any other body, whatever status carried it, is the unavailable one', () => {
  assert.deepEqual(fileViewOf({ error: 'not_held', message: 'x' }), notice('This path is no longer held in the current context.'));
  const unavailable = notice('This file is unavailable right now. Close and reopen the drawer to retry.');
  const bodies = [
    null, {}, { error: 'invalid_body', message: 'x' }, { error: 'unknown_endpoint', message: 'x' }, { error: 'bootstrapping', message: 'x' },
    { path: '/repo/a.js' }, { path: '/repo/a.js', total: 'many', runs: [] }, { path: '/repo/a.js', total: 3, runs: 'none' },
  ];
  for (const body of bodies) assert.deepEqual(fileViewOf(body), unavailable, JSON.stringify(body));
});
