// The inner compaction monitor's display model, `monitor-model.js`: what a parent row's meta, a content block and a slot's overview say, as plain data with the texts worded.
// Each function is tested on its own, against expected values written out by hand; the translate is the key followed by its parameters, so a wrong key or a wrong parameter shows in the expected literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentMetaParts, handoffMetaParts, handoffTitle, settlementMetaParts, signedText, blockParts, blockListParts, quoteFactsOf, slotFactsOf, jsonText, stringOf } from '../dsh/src/client/monitor-model.js';
import { PRESET_IDS } from '../public/lib/compactionSettings.js';
import { handoffRow } from './helpers/dsh-monitor-wire.js';

const t = (key, params) => (params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);

/** An attempt row in the shape `rowsOf` gives, a committed attempt unless `overrides` say otherwise. */
const attemptRow = (overrides = {}) => ({
  id: 7,
  revision: 9,
  status: 'committed',
  startedAt: 1_000,
  endedAt: 1_900,
  range: { first: 1, last: 4, count: 4 },
  reason: null,
  slots: 2,
  call: {
    state: 'received', endedAt: 1_500, finish: 'stop', thrown: null, input: 'summarize', output: '["a"]', outputDisplay: 'a',
    usage: { input: 120, output: 600, cacheRead: 400, cacheWrite: 20 },
  },
  contextChange: { before: 460, after: 710, delta: 250, miss: 510 },
  stepN: 8,
  trigger: { q: 1.0377949146956498, kappa: 1.1284536821382138 },
  ...overrides,
});

// ── parentMetaParts ───────────────────────────────────────────────────────────

test('a committed attempt\'s meta is its time, step count, estimate outcome, usage, range, context change, cache rebuild and seq in that order, each with the text and the title the row shows', () => {
  assert.deepEqual(parentMetaParts(attemptRow(), 9_999, t), [
    { part: 'time', text: '900 ms', title: 'monitor.meta.time' },
    { part: 'step', text: 'monitor.meta.step(count=8)', title: 'monitor.meta.step.title' },
    { part: 'estimate', text: 'monitor.meta.estimate(q=1.04)', title: 'monitor.meta.estimate.kappa.title(kappa=1.13)' },
    { part: 'usage', text: 'monitor.usage.cell(output=600)', title: 'monitor.usage.title(output=600,cacheRead=400,cacheWrite=20)' },
    { part: 'range', text: 'monitor.meta.range(before=460,after=710)', title: 'monitor.meta.range.title' },
    { part: 'context', text: 'monitor.change.increase(count=250)', title: 'monitor.meta.context.grew', attention: true },
    { part: 'miss', text: 'monitor.meta.miss(count=510)', title: 'monitor.meta.miss.title' },
    { part: 'seq', text: 'monitor.overview.seq(seq=7)' },
  ]);
});

test('what the row has none of reads as a dash, the usage with no title, and the time, step count, estimate outcome and context parts keep theirs', () => {
  const bare = attemptRow({ endedAt: null, contextChange: null, stepN: null, trigger: null, call: { ...attemptRow().call, usage: null } });
  assert.deepEqual(parentMetaParts(bare, 9_999, t), [
    { part: 'time', text: '—', title: 'monitor.meta.time' },
    { part: 'step', text: '—', title: 'monitor.meta.step.title' },
    { part: 'estimate', text: '—', title: 'monitor.meta.estimate.title' },
    { part: 'usage', text: '—' },
    { part: 'range', text: '—', title: 'monitor.meta.range.title' },
    { part: 'context', text: '—', title: 'monitor.meta.context' },
    { part: 'miss', text: '—', title: 'monitor.meta.miss.title' },
    { part: 'seq', text: 'monitor.overview.seq(seq=7)' },
  ]);
  const oldHost = attemptRow({ stepN: undefined, trigger: undefined });
  assert.deepEqual(parentMetaParts(oldHost, 9_999, t).slice(1, 3), parentMetaParts(bare, 9_999, t).slice(1, 3), 'a host that sends neither field reads as one that sent none');
});

test('the step slot is the count alone with the title of its own, whatever the quote recorded, and carries no warning', () => {
  const stepOf = overrides => parentMetaParts(attemptRow(overrides), 9_999, t)[1];
  const count = { part: 'step', text: 'monitor.meta.step(count=24)', title: 'monitor.meta.step.title' };
  assert.deepEqual(stepOf({ stepN: 24 }), count);
  assert.deepEqual(stepOf({ stepN: 24, trigger: { q: null, kappa: 1.1 } }), count, 'a quote with no result');
  assert.deepEqual(stepOf({ stepN: 24, trigger: null }), count, 'no quote');
  assert.deepEqual(stepOf({ stepN: null }), { part: 'step', text: '—', title: 'monitor.meta.step.title' });
});

test('the step slot carries a badge with the count of slots that have warnings where any has, under a title that says it, and its text and title stay as they are', () => {
  const stepOf = overrides => parentMetaParts(attemptRow(overrides), 9_999, t)[1];
  const plain = { part: 'step', text: 'monitor.meta.step(count=8)', title: 'monitor.meta.step.title' };
  const warned = { 40: ['state-check', 'verbatim-recall'], 45: ['state-write'], 50: ['read-block'] };
  assert.deepEqual(stepOf({ slotWarnings: warned }), { ...plain, badge: { text: '3', title: 'monitor.meta.step.badge(count=3,total=8)' } }, 'a slot with several warnings counts once');
  assert.deepEqual(stepOf({ slotWarnings: { 40: ['state-check'] }, stepN: 3 }).badge, { text: '1', title: 'monitor.meta.step.badge(count=1,total=3)' });
  assert.deepEqual(stepOf({ slotWarnings: { 40: ['state-check'] }, stepN: null }), { part: 'step', text: '—', title: 'monitor.meta.step.title', badge: { text: '1', title: 'monitor.meta.step.badge.unrated(count=1)' } }, 'no step count, no total in the title');
  assert.deepEqual(stepOf({ slotWarnings: {} }), plain, 'no warned slot, no badge');
  assert.deepEqual(stepOf({ slotWarnings: undefined }), plain);
  const withBadge = parentMetaParts(attemptRow({ slotWarnings: warned }), 9_999, t);
  assert.deepEqual(withBadge.filter(({ part }) => part !== 'step'), parentMetaParts(attemptRow(), 9_999, t).filter(({ part }) => part !== 'step'), 'no other slot reads it');
});

test('the estimate slot is the quote\'s deviation to two decimals, its title the deviation\'s meaning with the tolerance the quote was compared with to two decimals where it holds one, and a dash where there is no deviation', () => {
  const estimateOf = trigger => parentMetaParts(attemptRow({ trigger }), 9_999, t)[2];
  assert.deepEqual(estimateOf({ q: 1.236, kappa: 1.994 }), { part: 'estimate', text: 'monitor.meta.estimate(q=1.24)', title: 'monitor.meta.estimate.kappa.title(kappa=1.99)' });
  assert.deepEqual(estimateOf({ q: 1.2, kappa: 0.959 }), { part: 'estimate', text: 'monitor.meta.estimate(q=1.20)', title: 'monitor.meta.estimate.kappa.title(kappa=0.96)' }, 'a tolerance under 1 is shown as recorded');
  assert.deepEqual(estimateOf({ q: 1.236, kappa: null }), { part: 'estimate', text: 'monitor.meta.estimate(q=1.24)', title: 'monitor.meta.estimate.title' }, 'no tolerance, the static title');
  assert.deepEqual(estimateOf({ q: null, kappa: 1.1 }), { part: 'estimate', text: '—', title: 'monitor.meta.estimate.kappa.title(kappa=1.10)' }, 'a record with a tolerance and no deviation');
  assert.deepEqual(estimateOf({ q: null, kappa: null }), { part: 'estimate', text: '—', title: 'monitor.meta.estimate.title' });
  assert.deepEqual(estimateOf({ q: '1.2', kappa: NaN }), { part: 'estimate', text: '—', title: 'monitor.meta.estimate.title' }, 'a value that is no finite number reads as none');
  assert.deepEqual(estimateOf(null), { part: 'estimate', text: '—', title: 'monitor.meta.estimate.title' }, 'no quote');
  assert.equal(Object.hasOwn(estimateOf({ q: 9.5, kappa: 1.1 }), 'attention'), false, 'a deviation is no warning');
});

test('an attempt in progress reads its time from the clock it is given, and a context that shrank or stayed says so in words', () => {
  const running = attemptRow({ status: 'generating', endedAt: null, contextChange: { before: 800, after: 770, delta: -30, miss: null } });
  const [time, , , , range, context, miss] = parentMetaParts(running, 4_500, t);
  assert.equal(time.text, '3.5 s');
  assert.equal(range.text, 'monitor.meta.range(before=800,after=770)');
  assert.equal(context.text, 'monitor.change.decrease(count=30)');
  assert.equal(miss.text, '—');

  const same = attemptRow({ contextChange: { before: 500, after: 500, delta: 0, miss: 0 } });
  const [, , , , , unchanged, noMiss] = parentMetaParts(same, 0, t);
  assert.equal(unchanged.text, 'monitor.change.same');
  assert.equal(noMiss.text, 'monitor.meta.miss(count=0)');
});

test('a context that grew is a warning in the context slot with a title of its own, and one that shrank, stayed or is unknown is none', () => {
  const contextOf = contextChange => parentMetaParts(attemptRow({ contextChange }), 9_999, t)[5];
  assert.deepEqual(contextOf({ before: 460, after: 461, delta: 1, miss: 0 }), { part: 'context', text: 'monitor.change.increase(count=1)', title: 'monitor.meta.context.grew', attention: true });
  assert.deepEqual(contextOf({ before: 460, after: 410, delta: -50, miss: 0 }), { part: 'context', text: 'monitor.change.decrease(count=50)', title: 'monitor.meta.context' });
  assert.deepEqual(contextOf({ before: 460, after: 460, delta: 0, miss: 0 }), { part: 'context', text: 'monitor.change.same', title: 'monitor.meta.context' });
  assert.deepEqual(contextOf({ before: null, after: 710, delta: null, miss: 710 }), { part: 'context', text: '—', title: 'monitor.meta.context' });
  assert.deepEqual(contextOf(null), { part: 'context', text: '—', title: 'monitor.meta.context' });
});

test('the cache rebuild slot is a warning with a title of its own where the row is told its rebuild was unexpected, and its text is the same', () => {
  const missOf = (...args) => parentMetaParts(attemptRow(), 9_999, t, ...args)[6];
  assert.deepEqual(missOf(), { part: 'miss', text: 'monitor.meta.miss(count=510)', title: 'monitor.meta.miss.title' });
  assert.deepEqual(missOf(false), { part: 'miss', text: 'monitor.meta.miss(count=510)', title: 'monitor.meta.miss.title' });
  assert.deepEqual(missOf(true), { part: 'miss', text: 'monitor.meta.miss(count=510)', title: 'monitor.meta.miss.unexpected', attention: true });
  const others = parentMetaParts(attemptRow(), 9_999, t, true).filter(({ part }) => part !== 'miss');
  assert.deepEqual(others, parentMetaParts(attemptRow(), 9_999, t).filter(({ part }) => part !== 'miss'), 'no other slot reads it');
});

test('a cold summary call marks the usage slot as a warning and changes neither its text nor its title nor any other slot', () => {
  const cold = attemptRow({ call: { ...attemptRow().call, usage: { input: 120, output: 600, cacheRead: 100, cacheWrite: 20 } } });
  const usageOf = row => parentMetaParts(row, 9_999, t)[3];
  assert.deepEqual(usageOf(cold), { part: 'usage', text: 'monitor.usage.cell(output=600)', title: 'monitor.usage.title(output=600,cacheRead=100,cacheWrite=20)', attention: true });
  assert.deepEqual(usageOf(attemptRow()), { part: 'usage', text: 'monitor.usage.cell(output=600)', title: 'monitor.usage.title(output=600,cacheRead=400,cacheWrite=20)' });
  const others = parts => parts.filter(({ part }) => part !== 'usage');
  assert.deepEqual(others(parentMetaParts(cold, 9_999, t)), others(parentMetaParts(attemptRow(), 9_999, t)));
  const none = attemptRow({ status: 'generating', contextChange: null, call: { ...attemptRow().call, usage: null } });
  assert.deepEqual(usageOf(none), { part: 'usage', text: '—' }, 'a call with no usage is no warning');
});

test('a short summary marks the usage slot as a warning like a cold call does, changing no text or title, and a failed attempt\'s short output is none', () => {
  const withOutput = (output, overrides = {}) => attemptRow({ ...overrides, call: { ...attemptRow().call, usage: { input: 120, output, cacheRead: 400, cacheWrite: 20 } } });
  const usageOf = row => parentMetaParts(row, 9_999, t)[3];
  assert.deepEqual(usageOf(withOutput(499)), { part: 'usage', text: 'monitor.usage.cell(output=499)', title: 'monitor.usage.title(output=499,cacheRead=400,cacheWrite=20)', attention: true });
  assert.deepEqual(usageOf(withOutput(500)), { part: 'usage', text: 'monitor.usage.cell(output=500)', title: 'monitor.usage.title(output=500,cacheRead=400,cacheWrite=20)' });
  assert.equal(usageOf(withOutput(1, { status: 'failed', contextChange: null })).attention, undefined);
  const others = parts => parts.filter(({ part }) => part !== 'usage');
  assert.deepEqual(others(parentMetaParts(withOutput(1), 9_999, t)), others(parentMetaParts(attemptRow(), 9_999, t)));
});

// ── blockParts ────────────────────────────────────────────────────────────────

test('a text block is its text, a reasoning block its text under its label, a tool call its name in the label and its raw arguments as the text', () => {
  assert.deepEqual(blockParts({ type: 'text', text: 'hello **world**' }, t), { kind: 'text', text: 'hello **world**' });
  assert.deepEqual(blockParts({ type: 'reasoning', text: 'thinking' }, t), { kind: 'reasoning', label: 'monitor.block.reasoning', text: 'thinking' });
  assert.deepEqual(
    blockParts({ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path": "a.js"}' }, t),
    { kind: 'tool-call', label: 'monitor.block.toolCall(name=read)', text: '{"file_path": "a.js"}' },
  );
});

test('a text that is not a string is shown as its JSON, as the drawer shows it', () => {
  assert.deepEqual(blockParts({ type: 'text', text: { a: 1 } }, t), { kind: 'text', text: '{\n  "a": 1\n}' });
  assert.deepEqual(blockParts({ type: 'tool-call', name: 'read', arguments: { file_path: 'a.js' } }, t).text, '{\n  "file_path": "a.js"\n}');
  assert.equal(blockParts({ type: 'text' }, t).text, 'undefined');
});

test('a tool result carries its call id in the label and its inner blocks as children, and says so when it is an error', () => {
  assert.deepEqual(
    blockParts({ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'ok' }, { type: 'reasoning', text: 'r' }] }, t),
    {
      kind: 'tool-result',
      label: 'monitor.block.toolResult(id=call-1)',
      children: [{ kind: 'text', text: 'ok' }, { kind: 'reasoning', label: 'monitor.block.reasoning', text: 'r' }],
    },
  );
  assert.deepEqual(
    blockParts({ type: 'tool-result', callId: 'call-2', isError: true, blocks: [{ type: 'text', text: 'boom' }] }, t),
    { kind: 'tool-result', label: 'monitor.block.toolError(id=call-2)', error: true, children: [{ kind: 'text', text: 'boom' }] },
  );
});

test('a tool result with no call id, no blocks or blocks that are no list reads as it does in the drawer', () => {
  assert.deepEqual(blockParts({ type: 'tool-result', isError: false }, t), { kind: 'tool-result', label: 'monitor.block.toolResult(id=)', children: [] });
  assert.deepEqual(blockParts({ type: 'tool-result', callId: 'c', blocks: 'nope' }, t).children, []);
  assert.equal(blockParts({ type: 'tool-result', callId: { n: 1 }, blocks: [] }, t).label, 'monitor.block.toolResult(id={\n  "n": 1\n})');
});

test('an image or a file is its reference as JSON under its label, and any other block is its JSON under the label of another kind', () => {
  assert.deepEqual(
    blockParts({ type: 'image', attachment: { name: 'a.png', size: 3 } }, t),
    { kind: 'image', label: 'monitor.block.image', json: '{\n  "name": "a.png",\n  "size": 3\n}' },
  );
  assert.deepEqual(blockParts({ type: 'file', attachment: { name: 'a.txt' } }, t), { kind: 'file', label: 'monitor.block.file', json: '{\n  "name": "a.txt"\n}' });
  assert.deepEqual(blockParts({ type: 'unknown', raw: { type: 'weird', x: 1 } }, t), { kind: 'unknown', label: 'monitor.block.unknown', json: '{\n  "type": "weird",\n  "x": 1\n}' });
  assert.deepEqual(blockParts({ type: 'novel', x: 1 }, t), { kind: 'unknown', label: 'monitor.block.unknown', json: '{\n  "type": "novel",\n  "x": 1\n}' });
  assert.deepEqual(blockParts(null, t), { kind: 'unknown', label: 'monitor.block.unknown', json: 'null' });
  assert.deepEqual(blockParts(undefined, t), { kind: 'unknown', label: 'monitor.block.unknown', json: 'undefined' });
});

test('the blocks of a message are each block\'s parts in order, none where the blocks are no list', () => {
  assert.deepEqual(blockListParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], t), [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]);
  assert.deepEqual(blockListParts(undefined, t), []);
  assert.deepEqual(blockListParts('nope', t), []);
});

test('a value is shown as its text when it is one and as indented JSON otherwise', () => {
  assert.equal(stringOf('plain'), 'plain');
  assert.equal(stringOf([1, 2]), '[\n  1,\n  2\n]');
  assert.equal(jsonText({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}');
  assert.equal(jsonText(undefined), 'undefined');
});

// ── slotFactsOf ───────────────────────────────────────────────────────────────

/** A slot's detail in the shape the `inner-monitor/slot` endpoint answers. */
const slotDetail = (overrides = {}) => ({
  key: 12,
  number: 2,
  seqs: [12, 13, 14],
  turn: 3,
  step: 2,
  source: { type: 'assistant/message', kind: 'model', category: 'assistant' },
  c: 'a note',
  events: [
    { seq: 12, type: 'assistant/message', visible: true, blocks: [], raw: {} },
    { seq: 13, type: 'tool/result', visible: false, blocks: [], raw: {} },
    { seq: 14, type: 'tool/result', visible: true, blocks: [], raw: {} },
  ],
  ...overrides,
});

test('a slot\'s facts begin with its number, then its seqs, turn, step, the source of its first event, that event\'s type and kind and how many of its events the call saw', () => {
  assert.deepEqual(slotFactsOf(slotDetail(), t), [
    ['monitor.slot.number', 2],
    ['monitor.slot.seqs', '12, 13, 14'],
    ['monitor.slot.turn', 3],
    ['monitor.slot.step', 2],
    ['monitor.slot.source', 'monitor.source.assistant'],
    ['monitor.slot.sourceType', 'assistant/message'],
    ['monitor.slot.sourceKind', 'model'],
    ['monitor.slot.visibleCount', 'monitor.slot.visibleCountValue(visible=2,total=3)'],
  ]);
});

test('a slot that counted no turn or step lists neither, and a source the detail lacks is null, not a text', () => {
  assert.deepEqual(slotFactsOf(slotDetail({ turn: null, step: null, source: null }), t), [
    ['monitor.slot.number', 2],
    ['monitor.slot.seqs', '12, 13, 14'],
    ['monitor.slot.source', 'monitor.source.other'],
    ['monitor.slot.sourceType', null],
    ['monitor.slot.sourceKind', null],
    ['monitor.slot.visibleCount', 'monitor.slot.visibleCountValue(visible=2,total=3)'],
  ]);
  const user = slotFactsOf(slotDetail({ turn: 1, step: null, source: { type: 'user/message', kind: null, category: 'other' } }), t);
  assert.deepEqual(user.filter(([term]) => term === 'monitor.slot.step'), []);
  assert.deepEqual(user.find(([term]) => term === 'monitor.slot.sourceKind'), ['monitor.slot.sourceKind', null]);
  assert.deepEqual(user.find(([term]) => term === 'monitor.slot.source'), ['monitor.slot.source', 'monitor.source.other']);
});

// ── quoteFactsOf ──────────────────────────────────────────────────────────────

const QUOTE = { n: 8, lA: 12400, bEst: 300, cEst: 2400, sEst: 9580, cRatio: 30, fee: 5000, kappa: 1.1, preset: 'E2', nRef: 15, N: 21.96, jRef: 28.87, q: 1.0377949146956498, arm: 'left', trigger: 'quote' };

test('the quote\'s facts list the evidence estimate beside the summary estimate, a whole number as it is, and the preset the quote was priced under before its tolerance, in the order the page shows its inputs, with no trigger row', () => {
  assert.deepEqual(quoteFactsOf(QUOTE, t), [
    ['monitor.quote.n', '8'], ['monitor.quote.lA', '12400'], ['monitor.quote.bEst', '300'], ['monitor.quote.cEst', '2400'], ['monitor.quote.sEst', '9580'],
    ['monitor.quote.cRatio', '30'], ['monitor.quote.fee', '5000'], ['monitor.quote.preset', 'monitor.quote.preset.E2'], ['monitor.quote.kappa', '1.1'],
    ['monitor.quote.q', '1.038'], ['monitor.quote.arm', 'monitor.quote.arm.left'],
  ]);
});

test('a quote that used a summary read cost lists it after the fixed overhead, and one without it lists no row for it', () => {
  const termsOf = quote => quoteFactsOf(quote, t).map(([term]) => term);
  const fee = termsOf(QUOTE).indexOf('monitor.quote.fee');
  assert.deepEqual(quoteFactsOf({ ...QUOTE, summaryReadCost: 4200 }, t)[fee + 1], ['monitor.quote.summaryReadCost', '4200']);
  assert.deepEqual(termsOf({ ...QUOTE, summaryReadCost: 4200 }).filter(term => term !== 'monitor.quote.summaryReadCost'), termsOf(QUOTE));
  assert.equal(termsOf(QUOTE).includes('monitor.quote.summaryReadCost'), false);
});

test('the preset is named by its id when the client knows it, and a quote with none recorded or one the client does not know has none to show', () => {
  const presetOf = quote => quoteFactsOf(quote, t).find(([term]) => term === 'monitor.quote.preset');
  for (const id of PRESET_IDS) assert.deepEqual(presetOf({ ...QUOTE, preset: id }), ['monitor.quote.preset', `monitor.quote.preset.${id}`], id);
  const { preset, ...older } = QUOTE;
  assert.deepEqual(presetOf(older), ['monitor.quote.preset', null], 'a quote with no `preset` field');
  assert.deepEqual(presetOf({ ...QUOTE, preset: null }), ['monitor.quote.preset', null]);
  assert.deepEqual(presetOf({ ...QUOTE, preset: 'Z9' }), ['monitor.quote.preset', null], 'an id the client has no name for');
  for (const preset of ['toString', '__proto__', 7, {}]) assert.deepEqual(presetOf({ ...QUOTE, preset }), ['monitor.quote.preset', null], `${String(preset)} is no id`);
});

test('a record that still holds the todo estimate of an earlier seal lists no row for it: the facts are those of the same quote without it', () => {
  const recorded = { ...QUOTE, todoEst: 120 };
  assert.deepEqual(quoteFactsOf(recorded, t), quoteFactsOf(QUOTE, t));
  assert.equal(quoteFactsOf(recorded, t).some(([term]) => term.toLowerCase().includes('todo')), false);
});

// ── handoffMetaParts ──────────────────────────────────────────────────────────

const handoffPartsOf = row => handoffMetaParts(row, t);
const partNames = parts => parts.map(({ part }) => part);
const textsOf = parts => Object.fromEntries(parts.map(({ part, text }) => [part, text]));
/** A continued handoff whose context moved from 460 to 710 tokens, the cache rebuilding 510 of them. */
const continued = (overrides = {}) => handoffRow(7, { type: 'continue', token: 'tok-xyz', contextChange: { before: 460, after: 710, delta: 250, miss: 510 }, ...overrides });

test('a handoff\'s title names its segment as the epoch count its row records plus one, with no ordinal and no status word', () => {
  assert.equal(handoffTitle(handoffRow(7, { epoch: 0 }), t), 'monitor.object.handoff(epoch=1)');
  assert.equal(handoffTitle(handoffRow(7, { epoch: 3 }), t), 'monitor.object.handoff(epoch=4)');
});

test('a continued handoff\'s meta is its type, token, files, skills, lineage, range, context change and seq in that order', () => {
  const parts = handoffPartsOf(continued());
  assert.deepEqual(partNames(parts), ['type', 'token', 'files', 'skills', 'lineage', 'range', 'context', 'seq']);
  assert.deepEqual(textsOf(parts), {
    type: 'monitor.handoff.type.continue',
    token: 'tok-xyz',
    files: 'monitor.handoff.meta.files(read=3,kept=5)',
    skills: 'monitor.handoff.meta.skills(count=2)',
    lineage: 'monitor.handoff.meta.lineage(count=4)',
    range: 'monitor.handoff.meta.range(before=460,after=710)',
    context: 'monitor.change.increase(count=250)',
    seq: 'monitor.overview.seq(seq=7)',
  });
  assert.deepEqual(Object.fromEntries(parts.map(({ part, title }) => [part, title])), {
    type: 'monitor.handoff.meta.type.title',
    token: 'monitor.handoff.meta.token.title',
    files: 'monitor.handoff.meta.files.title',
    skills: 'monitor.handoff.meta.skills.title',
    lineage: 'monitor.handoff.meta.lineage.title',
    range: 'monitor.handoff.meta.range.title',
    context: 'monitor.meta.context',
    seq: undefined,
  });
});

test('the type and the token are what they are, with no label of their own, and a load row reads its own type', () => {
  const parts = handoffPartsOf(handoffRow(7));
  assert.equal(parts.find(({ part }) => part === 'type').text, 'monitor.handoff.type.load');
  assert.equal(parts.find(({ part }) => part === 'token').text, 'tok-abc');
});

test('the type slot names the handoff\'s type for the row to colour, and no other slot carries one', () => {
  for (const type of ['load', 'continue']) {
    const parts = handoffPartsOf(handoffRow(7, { type }));
    assert.deepEqual(parts.filter(part => Object.hasOwn(part, 'type')).map(part => [part.part, part.type]), [['type', type]]);
  }
});

test('a load row has no change in its context, so its range and context change read as dashes while the slots beside them read their own', () => {
  const texts = textsOf(handoffPartsOf(handoffRow(7)));
  assert.deepEqual([texts.range, texts.context], ['—', '—']);
  assert.equal(texts.files, 'monitor.handoff.meta.files(read=3,kept=5)');
});

test('the files read as read of kept and read dash where either is missing, and a missing lineage reads a dash', () => {
  const textsFor = overrides => textsOf(handoffPartsOf(handoffRow(7, overrides)));
  assert.equal(textsFor({ read: 0, kept: 0 }).files, 'monitor.handoff.meta.files(read=0,kept=0)');
  assert.equal(textsFor({ read: null }).files, '—');
  assert.equal(textsFor({ kept: null }).files, '—');
  assert.equal(textsFor({ lineage: null }).lineage, '—');
  assert.equal(textsFor({ skills: 0 }).skills, 'monitor.handoff.meta.skills(count=0)');
});

test('a continued handoff whose first call after it has not arrived has dashes for its missing ends and for the change it cannot tell', () => {
  const texts = textsOf(handoffPartsOf(continued({ contextChange: { before: 460, after: null, delta: null, miss: null } })));
  assert.deepEqual([texts.range, texts.context], ['monitor.handoff.meta.range(before=460,after=—)', '—']);
  const none = textsOf(handoffPartsOf(continued({ contextChange: null })));
  assert.deepEqual([none.range, none.context], ['—', '—']);
});

// ── settlementMetaParts and the figures it reads ─────────────────────────────

/** The settlement of a segment of two compactions, the second of which has no figures. */
const settlementOf = (overrides = {}) => ({
  epoch: 1,
  count: 2,
  steps: 120,
  saved: 340_212,
  cost: 120_034,
  rows: [{ id: 3, ordinal: 1, saved: 340_212, cost: 120_034 }, { id: 8, ordinal: 2, saved: null, cost: null }],
  ...overrides,
});
const PARTS = ['count', 'steps', 'saved', 'cost', 'net', 'payback'];

test('a settlement\'s meta is the compactions\' count, the steps of the segment, what they saved, what they cost, the difference and the share saved of the cost, each with the text and the title the row shows, the figures as compact counts', () => {
  assert.deepEqual(settlementMetaParts(settlementOf({ count: 3, steps: 87, saved: 1_200_000, cost: 400_000 }), t), [
    { part: 'count', text: 'monitor.settlement.count(count=3)', title: 'monitor.settlement.count.title' },
    { part: 'steps', text: 'monitor.settlement.steps(count=87)', title: 'monitor.settlement.steps.title' },
    { part: 'saved', text: 'monitor.settlement.saved(count=1.2m)', title: 'monitor.settlement.saved.title' },
    { part: 'cost', text: 'monitor.settlement.cost(count=400.0k)', title: 'monitor.settlement.cost.title' },
    { part: 'net', text: 'monitor.settlement.net(count=+800.0k)', title: 'monitor.settlement.net.title' },
    { part: 'payback', text: 'monitor.settlement.payback(percent=300%)', title: 'monitor.settlement.payback.title' },
  ]);
  assert.deepEqual(settlementMetaParts(settlementOf(), t).map(({ part }) => part), PARTS);
});

test('the difference is signed: a plus before a gain, the minus sign before a loss and no sign at none, and the share is rounded down without a ceiling', () => {
  const netOf = (saved, cost) => settlementMetaParts(settlementOf({ saved, cost }), t).find(({ part }) => part === 'net').text;
  const paybackOf = (saved, cost) => settlementMetaParts(settlementOf({ saved, cost }), t).find(({ part }) => part === 'payback').text;
  assert.equal(netOf(1_000, 400), 'monitor.settlement.net(count=+600)');
  assert.equal(netOf(100_000, 400_000), 'monitor.settlement.net(count=\u2212300.0k)', 'U+2212, not a hyphen');
  assert.equal(netOf(500, 500), 'monitor.settlement.net(count=0)');
  assert.equal(paybackOf(100_000, 400_000), 'monitor.settlement.payback(percent=25%)');
  assert.equal(paybackOf(2, 3), 'monitor.settlement.payback(percent=66%)', 'rounded down, as the progress is');
  assert.equal(paybackOf(99.6, 100.4), 'monitor.settlement.payback(percent=99%)', 'on the figures as they are, not as they are shown: 100 of 100 would read paid back');
  assert.equal(paybackOf(500, 500), 'monitor.settlement.payback(percent=100%)');
  assert.equal(paybackOf(0, 500), 'monitor.settlement.payback(percent=0%)');
  assert.equal(paybackOf(5_000, 100), 'monitor.settlement.payback(percent=5000%)');
});

test('the figures are rounded before they are shown and before they are subtracted, so what the row shows adds up, and a figure that rounds up into the next unit reads in that unit', () => {
  const textsOf = overrides => Object.fromEntries(settlementMetaParts(settlementOf(overrides), t).map(({ part, text }) => [part, text]));
  const texts = textsOf({ saved: 1_234.4, cost: 999.6 });
  assert.deepEqual([texts.saved, texts.cost, texts.net], ['monitor.settlement.saved(count=1.2k)', 'monitor.settlement.cost(count=1.0k)', 'monitor.settlement.net(count=+234)']);
  assert.equal(textsOf({ saved: 999.6, cost: 1_000 }).net, 'monitor.settlement.net(count=0)');
});

test('a settlement\'s figures read the whole numbers they round to in the format they are given, the meta\'s own parts carrying them whole where the format is String', () => {
  const figuresOf = (saved, cost) => settlementMetaParts(settlementOf({ saved, cost }), t, String).slice(2).map(({ text }) => text);
  assert.deepEqual(figuresOf(340_212.4, 120_033.6), ['monitor.settlement.saved(count=340212)', 'monitor.settlement.cost(count=120034)', 'monitor.settlement.net(count=+220178)', 'monitor.settlement.payback(percent=283%)']);
  assert.deepEqual(figuresOf(100, 400), ['monitor.settlement.saved(count=100)', 'monitor.settlement.cost(count=400)', 'monitor.settlement.net(count=\u2212300)', 'monitor.settlement.payback(percent=25%)']);
  assert.deepEqual(figuresOf(500, 500), ['monitor.settlement.saved(count=500)', 'monitor.settlement.cost(count=500)', 'monitor.settlement.net(count=0)', 'monitor.settlement.payback(percent=100%)']);
  const parts = settlementMetaParts(settlementOf(), t, String);
  assert.deepEqual(parts.map(({ part }) => part), PARTS);
  assert.deepEqual(parts.map(({ text }) => text).slice(2), ['monitor.settlement.saved(count=340212)', 'monitor.settlement.cost(count=120034)', 'monitor.settlement.net(count=+220178)', 'monitor.settlement.payback(percent=283%)']);
  assert.equal(settlementMetaParts(settlementOf(), t)[2].text, 'monitor.settlement.saved(count=340.2k)', 'the compact count is the default');
});

test('a signed text has a plus before a gain, the minus sign before a loss and no sign at zero, its magnitude written by the format', () => {
  assert.equal(signedText(12, String), '+12');
  assert.equal(signedText(-12, String), '\u221212');
  assert.equal(signedText(0, String), '0');
  assert.equal(signedText(-1_500, count => `${count / 1_000}k`), '\u22121.5k');
});
