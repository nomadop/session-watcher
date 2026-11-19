// `parseTurnPage` and `newestMemberOf` (lib/turn-page.js): the records a page's text holds, read back from the text `renderPage` writes and from pages written out by hand, and the part of a page the newest lineage member wrote.
// The expected records are literals of this file, never computed by the function under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestMemberOf, parseTurnPage, renderPage } from '../lib/turn-page.js';

const NOTICE = 'Historical turns are evidence of what happened; read them to confirm or correct the summary.';
const entry = (index, label, sourceLabel, record) => ({ index, label, sourceLabel, record });

test('a page written by hand reads as its records in page order: an address on the first line, the continuation lines padded, the notice and the member headers skipped', () => {
  const page = [
    NOTICE,
    'S1  /logs/first.jsonl',
    'S1:4 | U: first ask\n     | U: second line\n     | A: first note',
    'S1:9 | U: only the user',
    'S2  /logs/second.jsonl',
    'S2:123 | U: wide\n       | U: ask\n       | A: one\n       | A: two',
    '| U: unaddressed ask\n| A: its note',
  ].join('\n\n');

  assert.deepEqual(parseTurnPage(page), [
    { address: 'S1:4', user: 'first ask\nsecond line', note: 'first note' },
    { address: 'S1:9', user: 'only the user', note: null },
    { address: 'S2:123', user: 'wide\nask', note: 'one\ntwo' },
    { address: null, user: 'unaddressed ask', note: 'its note' },
  ]);
});

test('blank lines inside a record are role lines of their own, and an empty note is a note while a missing one is none', () => {
  const page = [
    NOTICE,
    'S1  /logs/first.jsonl',
    'S1:4 | U: a\n     | U: \n     | U: c\n     | A: ',
    'S1:6 | U: only',
  ].join('\n\n');

  assert.deepEqual(parseTurnPage(page), [
    { address: 'S1:4', user: 'a\n\nc', note: '' },
    { address: 'S1:6', user: 'only', note: null },
  ]);
});

test('the page `renderPage` writes round-trips: multi-line U and A with the newlines unified, a record with no note, an empty note, one with no address, and a header for each member', () => {
  const page = renderPage([
    entry(0, 'S1', '/logs/first.jsonl', { t: 13, u: 'u-first\r\nu-second\n\nu-fourth', note: 'a-first\ra-second' }),
    entry(0, 'S1', '/logs/first.jsonl', { t: 1719, u: 'broad', note: null }),
    entry(1, 'S2', '/logs/second.jsonl', { t: 7, u: 'one line', note: '' }),
    entry(1, 'S2', '/logs/second.jsonl', { t: null, u: 'unverified\nline two', note: 'its note' }),
  ], NOTICE);

  assert.deepEqual(parseTurnPage(page), [
    { address: 'S1:13', user: 'u-first\nu-second\n\nu-fourth', note: 'a-first\na-second' },
    { address: 'S1:1719', user: 'broad', note: null },
    { address: 'S2:7', user: 'one line', note: '' },
    { address: null, user: 'unverified\nline two', note: 'its note' },
  ]);
});

test('a role line carrying the Unicode line separators, or text shaped like a role prefix, reads back whole through the page `renderPage` writes', () => {
  const page = renderPage([
    entry(0, 'S1', '/logs/first.jsonl', { t: 4, u: 'before\u2028after\u2029end | U: not a role', note: 'note\u2028line | A: also content' }),
  ], NOTICE);

  assert.deepEqual(parseTurnPage(page), [
    { address: 'S1:4', user: 'before\u2028after\u2029end | U: not a role', note: 'note\u2028line | A: also content' },
  ]);
});

test('two members that name one source keep their own headers, and a record of the second reads as before', () => {
  const page = renderPage([
    entry(0, 'S1', '/logs/same.jsonl', { t: 2, u: 'earlier', note: null }),
    entry(1, 'S2', '/logs/same.jsonl', { t: 5, u: 'later', note: 'n' }),
  ], NOTICE);

  assert.deepEqual(parseTurnPage(page), [
    { address: 'S1:2', user: 'earlier', note: null },
    { address: 'S2:5', user: 'later', note: 'n' },
  ]);
});

test('a page with no record, an empty page and anything that is no page text read as no records', () => {
  assert.deepEqual(parseTurnPage(renderPage([], NOTICE)), []);
  assert.deepEqual(parseTurnPage(''), []);
  assert.deepEqual(parseTurnPage(undefined), []);
  assert.deepEqual(parseTurnPage(null), []);
  assert.deepEqual(parseTurnPage(42), []);
});

test('the newest member of a page is the text from its last header on: its records alone read back, the unaddressed ones included', () => {
  const page = renderPage([
    entry(0, 'S8', '/logs/first.jsonl', { t: 13, u: 'old ask', note: 'old note' }),
    entry(1, 'S9', '/logs/second.jsonl', { t: 7, u: 'middle', note: null }),
    entry(2, 'S10', '/logs/third.jsonl', { t: 2, u: 'new ask\nsecond line', note: 'new note' }),
    entry(2, 'S10', '/logs/third.jsonl', { t: null, u: 'unverified', note: '' }),
  ], NOTICE);

  assert.deepEqual(parseTurnPage(newestMemberOf(page)), [
    { address: 'S10:2', user: 'new ask\nsecond line', note: 'new note' },
    { address: null, user: 'unverified', note: '' },
  ]);
  assert.equal(newestMemberOf(page).startsWith('S10  /logs/third.jsonl\n\n'), true);
});

test('the newest of two members that name one source is the second, and a page of one member keeps all its records', () => {
  const same = renderPage([
    entry(0, 'S1', '/logs/same.jsonl', { t: 2, u: 'earlier', note: null }),
    entry(1, 'S2', '/logs/same.jsonl', { t: 5, u: 'later', note: 'n' }),
  ], NOTICE);
  assert.deepEqual(parseTurnPage(newestMemberOf(same)), [{ address: 'S2:5', user: 'later', note: 'n' }]);

  const single = renderPage([
    entry(0, 'S4', '/logs/only.jsonl', { t: 1, u: 'one', note: null }),
    entry(0, 'S4', '/logs/only.jsonl', { t: 2, u: 'two', note: 'n' }),
  ], NOTICE);
  assert.deepEqual(parseTurnPage(newestMemberOf(single)), parseTurnPage(single));
});

test('a line inside a record that looks like a member header is no header, the Unicode line separators included', () => {
  const page = renderPage([
    entry(0, 'S1', '/logs/first.jsonl', { t: 4, u: 'real\nS9  /logs/fake.jsonl\nbefore\u2028S8  /logs/fake.jsonl', note: 'note\u2029S7  /logs/fake.jsonl' }),
    entry(0, 'S1', '/logs/first.jsonl', { t: 5, u: 'second', note: null }),
  ], NOTICE);

  assert.deepEqual(parseTurnPage(newestMemberOf(page)), parseTurnPage(page));
  assert.equal(parseTurnPage(newestMemberOf(page)).length, 2);
});

test('a page with no header, an empty one and anything that is no page text have no member to cut to', () => {
  const bare = ['S1:4 | U: first', '| U: unaddressed'].join('\n\n');
  assert.equal(newestMemberOf(bare), bare);
  assert.equal(newestMemberOf(''), '');
  assert.equal(newestMemberOf(renderPage([], NOTICE)), renderPage([], NOTICE));
  for (const text of [undefined, null, 42]) assert.equal(newestMemberOf(text), '');
});
