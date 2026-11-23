// The summary business of the inner seal (`lib/inner-seal/summary.js`), fed hand-written slot facts: the rows and the held list `planSummary` writes into the tail, the verbatim notes of a user's own slots, and the notes `parseNotes` recovers and `mergeNotes` places.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeNotes, parseNotes, planSummary } from '../lib/inner-seal/summary.js';
import { storedUText } from '../lib/turn.js';

const NO_HELD = { paths: new Map(), skills: new Map() };

// The rows block of a tail text: the lines between the slot list's heading and the reply instruction.
const rowLinesOf = (text) => {
  const from = text.indexOf('Slots, oldest first:\n') + 'Slots, oldest first:\n'.length;
  return text.slice(from, text.indexOf('\n\nReply with')).split('\n');
};

// The held block of a tail text: the lines between its heading and the closing instructions.
const heldLinesOf = (text) => {
  const from = text.indexOf('Held, beside the notes:\n') + 'Held, beside the notes:\n'.length;
  return text.slice(from, text.indexOf('\n\nName an identifier')).split('\n');
};

const user = text => ({ own: true, kind: 'other', text });

test('a step row names its text and each call with its outcome and argument cue, a result row the call it answers, any other slot a harness row; a user slot keeps its place unnumbered', () => {
  const facts = [
    user('please  fix\nit'),
    {
      own: false, kind: 'step', text: 'ignored', assistantText: 'reading',
      calls: [
        { id: 'call-1', name: 'read', arguments: '{"path":"a.js","limit":5}', failed: false },
        { id: 'call-2', name: 'bash', arguments: 'not json', failed: true },
        { id: 'call-3', name: 'noop', arguments: '{"n":1}', failed: false },
      ],
    },
    { own: false, kind: 'step', text: '', assistantText: '', calls: [] },
    { own: false, kind: 'result', text: 'late', toolCallId: 'call-outside' },
    { own: false, kind: 'other', text: 'x'.repeat(70) },
  ];
  const { tailText, askedCount } = planSummary(facts, NO_HELD);
  assert.equal(askedCount, 4);
  assert.deepEqual(rowLinesOf(tailText), [
    'user, no note: "please fix it"',
    '[1] assistant step',
    '  text: "reading"',
    '  call call-1 read → ok: "a.js limit 5"',
    '  call call-2 bash → error: "not json"',
    '  call call-3 noop → ok: "n 1"',
    '[2] assistant step',
    '  text: none',
    '[3] tool result of call call-outside',
    `[4] harness: "${'x'.repeat(30)}…${'x'.repeat(30)}"`,
  ]);
  assert.match(tailText, /keys are the slot numbers "1" to "4"/u);
});

test('the held list names each held file then each skill by its key, and reads `none` when nothing is held', () => {
  const held = { paths: new Map([['/repo/a.js', [1, 2]], ['/repo/b.js', [3]]]), skills: new Map([['tdd', 'body']]) };
  assert.deepEqual(heldLinesOf(planSummary([user('hi')], held).tailText), ['- file /repo/a.js', '- file /repo/b.js', '- skill tdd']);
  assert.deepEqual(heldLinesOf(planSummary([user('hi')], NO_HELD).tailText), ['none']);
});

test('a user slot takes `user: ` and its text whole, or cut as a turn note cuts its U with the counted truncation marker; any other slot is asked', () => {
  const long = 'word '.repeat(400);
  const { verbatim } = planSummary([user('short ask'), { own: false, kind: 'other', text: 'note' }, user(long)], NO_HELD);
  assert.deepEqual(verbatim.slice(0, 2), ['user: short ask', null]);
  assert.equal(verbatim[2], `user: ${storedUText(long).uText} [truncated; ${long.length} chars]`);
  assert.ok(storedUText(long).uText.length < long.length);
});

test('the notes are an object keyed "1" to the asked count with a string under each key and no other key', () => {
  const loads = () => assert.fail('legal JSON never reaches loads');
  assert.deepEqual(parseNotes('{"2":"b","1":"a"}', 2, loads), ['a', 'b']);
  assert.equal(parseNotes('{"1":"a"}', 2, loads), undefined);
  assert.equal(parseNotes('{"1":"a","2":"b","3":"c"}', 2, loads), undefined);
  assert.equal(parseNotes('{"1":"a","3":"c"}', 2, loads), undefined);
  assert.equal(parseNotes('{"1":"a","2":2}', 2, loads), undefined);
  assert.equal(parseNotes('["a","b"]', 2, loads), undefined);
  assert.equal(parseNotes('"a"', 1, loads), undefined);
  assert.equal(parseNotes('null', 1, loads), undefined);
  assert.deepEqual(parseNotes('{}', 0, loads), []);
});

test('only text whose JSON syntax fails goes to `loads`, once, and its answer is read by the same rule; a throwing `loads` leaves no notes', () => {
  const seen = [];
  const recovering = (text) => { seen.push(text); return { 1: 'a' }; };
  assert.deepEqual(parseNotes('{"1": "a",}', 1, recovering), ['a']);
  assert.deepEqual(seen, ['{"1": "a",}']);
  assert.equal(parseNotes('{"1": "a",}', 2, recovering), undefined);
  assert.equal(parseNotes('broken', 1, () => ['a']), undefined);
  assert.equal(parseNotes('broken', 1, () => { throw new Error('no'); }), undefined);
});

test('the notes fill the asked slots in order and a user slot keeps its verbatim note', () => {
  assert.deepEqual(mergeNotes(['user: hi', null, 'user: go', null], ['a', 'b'], ['cue a', 'cue b']), ['user: hi', 'a', 'user: go', 'b']);
});

test('an empty note takes the cue of its own slot, whichever slots precede it; a note that is not empty and a user slot are never touched, and an empty cue leaves the note empty', () => {
  assert.deepEqual(mergeNotes(['user: hi', null, null, 'user: go', null, null], ['', 'kept', ' ', ''], ['cue 1', 'cue 2', 'cue 3', '']), ['user: hi', 'cue 1', 'kept', 'user: go', ' ', '']);
});

test('the cues of the asked slots, a user slot having none, in their order are the action of each: each call of a step as its call row names it without the id, joined by `; `, else the step\'s text cue, a tool result as `tool result`, any other slot its text cue', () => {
  const facts = [
    user('please fix it'),
    {
      own: false, kind: 'step', text: 'ignored', assistantText: 'reading',
      calls: [
        { id: 'call-1', name: 'read', arguments: '{"path":"lib/held-view.js"}', failed: false },
        { id: 'call-2', name: 'bash', arguments: 'not json', failed: true },
        { id: 'call-3', name: 'noop', arguments: '{}', failed: false },
      ],
    },
    { own: false, kind: 'step', text: '', assistantText: 'thinking  aloud', calls: [] },
    { own: false, kind: 'step', text: '', assistantText: '', calls: [] },
    { own: false, kind: 'result', text: 'late', toolCallId: 'call-outside' },
    { own: false, kind: 'other', text: 'sub\nagent says' },
    { own: false, kind: 'other', text: '' },
  ];
  const { askedCues } = planSummary(facts, NO_HELD);
  assert.deepEqual(askedCues, [
    'read → ok: "lib/held-view.js"; bash → error: "not json"; noop → ok',
    '"thinking aloud"',
    '',
    'tool result',
    '"sub agent says"',
    '',
  ]);
});
