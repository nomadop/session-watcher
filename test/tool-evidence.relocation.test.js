// Key relocation in the Tool Evidence Interpreter: the scratch it keeps of what it has sent the ledger, the entries
// it moves to the lines they are now on when a file's lines have moved, the limits that bound the move, and the
// weight of a residual, which is set by what those entries make of a call's lines. A test owns the scratch it hands
// the interpreter, so every state is read as the interpreter left it. The matcher is a stub except where a test
// says the real one runs; the Engine and the ledger are real wherever a test compares them with the scratch.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createToolEvidenceInterpreter } from '../lib/tool-evidence.js';
import { fingerprintOf, normalizeLine } from '../lib/line-align.js';
import { createResidentLedger } from '../lib/measurement/resident-ledger.js';
import { dshToolEvidenceProfile } from '../lib/harness/dsh/tool-evidence-profile.js';
import {
  MODEL, OTHER_MODEL, LIMITS, resolveModelPolicy, dshRig, dshObservations, editableTree, makeEngine, stepOf, rowOf,
} from './helpers/attribution-fixtures.js';

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';
const F = '/repo/src/run.js';

const CONTEXT = { sessionCwd: '/repo', resolveModelPolicy };
const NONE = { input: 0, output: 0 };

const fp = text => fingerprintOf(normalizeLine(text));
const numbers = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// The matcher's answer for a call that put some lines of one file in context: `file` holds the lines of the file as
// the matcher read it now and `shown` the 1-based numbers of those the call showed, a number twice for a line the
// call carries twice.
function showing(resourceKey, file, shown, { side = 'output', texts = {}, unmatched = NONE } = {}) {
  return {
    matches: [{
      resourceKey,
      side,
      lines: shown.map(line => ({ line, text: texts[line] ?? file[line - 1], tier: 'declared' })),
    }],
    files: { [resourceKey]: file.map(fp) },
    unmatched,
    stats: { failed: false },
  };
}

const wholeOf = (resourceKey, file) => showing(resourceKey, file, numbers(1, file.length));

// What a DSH read tool returns for the lines `shown` of the file `F`, numbered as the file numbers them.
const outputOf = (file, shown) => `<path>${F}</path>\n<type>file</type>\n<content>\n${
  shown.map(line => `${line}: ${file[line - 1]}`).join('\n')}\n</content>`;

// The entry the scratch holds of a line of ascii text sent whole under MODEL, and of a key a relocation emptied.
const entryOf = text => ({ chars: text.length, cjk: 0, tokens: text.length / 4, fp: fp(text) });
const ZERO = { chars: 0, cjk: 0, tokens: 0 };

// Calls one after another over one scratch and one ledger, as the Projection and the Engine take them. The matcher
// answers each fresh call from the reply the test gives; the store keeps what a fresh call offers (the first write
// of an id staying) and answers a `recalled` map of records for the calls it holds. The effects of every call go
// to a real resident ledger, which rejects a key repeated within one impact.
function chainOf({ limits = LIMITS, recalled = new Map() } = {}) {
  const replies = new Map();
  let asked = 0;
  const interpreter = createToolEvidenceInterpreter({
    attribution: { attribute: ({ input }) => { asked += 1; return replies.get(input.call); } },
    profile: dshToolEvidenceProfile,
    limits,
  });
  const scratch = new Map();
  const ledger = createResidentLedger();
  const records = new Map();
  const frameCtx = {
    recall: toolUseId => recalled.get(toolUseId) ?? null,
    remember: (toolUseId, record) => { if (!records.has(toolUseId)) records.set(toolUseId, structuredClone(record)); },
  };
  let count = 0;

  return {
    scratch,
    ledger,
    records,
    asked: () => asked,
    // One call interpreted through to its completion; `reply` is what the matcher answers if it is asked.
    call(reply, { model = MODEL, name = 'read' } = {}) {
      const toolUseId = `c${++count}`;
      replies.set(toolUseId, reply);
      const use = { type: 'tool-use', toolUseId, messageId: `step-${count}`, model, cwd: null, name, input: { call: toolUseId } };
      const result = { type: 'tool-result', toolUseId, content: 'out', isError: false };
      const { pending } = interpreter.interpretToolUse(use, CONTEXT, { scratch, frameCtx });
      const done = interpreter.completeToolResult(pending, result, CONTEXT, { scratch, frameCtx });
      for (const effect of done.effects) ledger.applyEffect(effect, { turn: 1, foldedSeq: count });
      return { ...done, toolUseId };
    },
    // A state the chain starts from, in the scratch and in the ledger alike.
    seed(resourceKey, held) {
      scratch.set(resourceKey, held);
      const fragments = [...held].map(([key, entry]) => ({ key, tokens: entry.tokens }));
      const mutation = { kind: 'replace-fragments', fragments };
      ledger.applyEffect({ access: 'read', overheadTokens: 0, spentTokens: 0, impacts: [{ resourceKey, mutation }] }, { turn: 1, foldedSeq: 0 });
    },
  };
}

// What the scratch holds of one resource: each key's tokens, keys ascending.
function tokensOf(scratch, resourceKey) {
  const held = [...(scratch.get(resourceKey) ?? [])].sort(([a], [b]) => a - b);
  return Object.fromEntries(held.map(([key, entry]) => [key, entry.tokens]));
}

// What the scratch holds of one resource in characters: each key's, keys ascending, and the sum over its keys.
function charsOf(scratch, resourceKey) {
  const held = [...(scratch.get(resourceKey) ?? [])].sort(([a], [b]) => a - b);
  return Object.fromEntries(held.map(([key, entry]) => [key, entry.chars]));
}

const totalCharsOf = (scratch, resourceKey) => Object.values(charsOf(scratch, resourceKey))
  .reduce((total, chars) => total + chars, 0);

// The weight of a call's residual as the Engine receives it, and as the record the store was offered holds it: zero
// where the call has none.
const weightOf = done => done.residuals[0]?.weight ?? 0;
const storedWeightOf = (chain, done) => chain.records.get(done.toolUseId).residual?.weight ?? 0;

// The keys of a resource that carry tokens: what the resource holds in context.
const residencyOf = (scratch, resourceKey) => [...(scratch.get(resourceKey) ?? [])]
  .filter(([, entry]) => entry.tokens > 0)
  .map(([key]) => key)
  .sort((a, b) => a - b);

// The keys of the one impact of a call's one effect of an access.
const impactOf = (done, access = 'read') => done.effects.find(effect => effect.access === access).impacts[0];
const keysOfImpact = impact => impact.mutation.fragments.map(fragment => fragment.key);

// What the ledger holds of one resource: each key's tokens, keys ascending.
function fragmentsOf(ledger, resourceKey) {
  const resource = ledger.snapshot().resources.find(item => item.resourceKey === resourceKey);
  return Object.fromEntries([...(resource?.fragments ?? [])].sort(([a], [b]) => a - b));
}

// The scratch is the ledger's twin: the same keys with the same tokens, for every resource either holds.
function assertTwin(chain) {
  const keys = new Set([...chain.scratch.keys(), ...chain.ledger.snapshot().resources.map(resource => resource.resourceKey)]);
  for (const resourceKey of keys) {
    assert.deepEqual(tokensOf(chain.scratch, resourceKey), fragmentsOf(chain.ledger, resourceKey), resourceKey);
  }
}

describe('the scratch', () => {
  // Authored lines of four, five and six characters; MODEL prices ascii at a divisor of four.
  const FILE = ['abcd', 'efghi', 'jklmno'];

  test('holds each line a call sent as the counts, the tokens it was priced at and the fingerprint', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, [2, 3]));
    assert.deepEqual(chain.scratch, new Map([[A, new Map([
      [2, { chars: 5, cjk: 0, tokens: 1.25, fp: fp('efghi') }],
      [3, { chars: 6, cjk: 0, tokens: 1.5, fp: fp('jklmno') }],
    ])]]));
    assertTwin(chain);
  });

  test('counts the characters of a line that are CJK and prices them at the divisor of CJK', () => {
    const chain = chainOf();
    chain.call(showing(A, ['// 你好'], [1]));
    // 5 characters of which 2 are CJK: (5 - 2) / 4 + 2 / 2.
    assert.deepEqual(chain.scratch.get(A).get(1), { chars: 5, cjk: 2, tokens: 1.75, fp: fp('// 你好') });
  });

  test('merges a line sent later into the entries it holds, per key', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, [1, 2]));
    chain.call(showing(A, FILE, [2, 3], { texts: { 2: 'efghi plus' } }));
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 1, 2: 2.5, 3: 1.5 });
    assert.deepEqual(chain.scratch.get(A).get(2), { chars: 10, cjk: 0, tokens: 2.5, fp: fp('efghi') });
    assertTwin(chain);
  });

  test('keeps each resource apart', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, [1]));
    chain.call(showing(B, FILE, [2]));
    assert.deepEqual([...chain.scratch.keys()], [A, B]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 1 });
    assert.deepEqual(tokensOf(chain.scratch, B), { 2: 1.25 });
    assertTwin(chain);
  });

  test('is left as it was by a call that matched nothing', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, [1]));
    const before = structuredClone(chain.scratch);
    chain.call({ matches: [], files: {}, unmatched: { input: 3, output: 4 }, stats: { failed: false } });
    assert.deepEqual(chain.scratch, before);
    assertTwin(chain);
  });

  test('is replaced for a resource by a read of every line of its file, and for that resource only', () => {
    const chain = chainOf();
    // A stale set from a longer version of the file, one of its entries without a fingerprint, and another file.
    chain.seed(A, new Map([
      [1, { chars: 4, cjk: 0, tokens: 1, fp: fp('old one') }],
      [2, { chars: 4, cjk: 0, tokens: 1, fp: fp('old two') }],
      [3, { chars: 4, cjk: 0, tokens: 1, fp: fp('old three') }],
      [4, { chars: 4, cjk: 0, tokens: 1, fp: fp('old four') }],
      [9, { chars: 40, cjk: 0, tokens: 10 }],
    ]));
    chain.seed(B, new Map([[7, { chars: 8, cjk: 0, tokens: 2, fp: fp('other') }]]));
    const other = chain.scratch.get(B);
    const done = chain.call(wholeOf(A, FILE));
    // The keys are exactly one to the length of the file, the stale ones are gone, and nothing was shifted or zeroed.
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 1, 2: 1.25, 3: 1.5 });
    assert.deepEqual(keysOfImpact(impactOf(done)), [1, 2, 3]);
    assert.equal(impactOf(done).mutation.kind, 'replace-fragments');
    assert.deepEqual(done.telemetry.pathEvents.map(event => event.isFullRead), [1]);
    assert.equal(chain.scratch.get(B), other);
    assert.deepEqual(tokensOf(chain.scratch, B), { 7: 2 });
    assertTwin(chain);
  });

  test('takes a recalled record the way a fresh partition leaves it, priced at the policy now in force', () => {
    const live = chainOf();
    live.call(showing(A, FILE, [1, 3]));
    const replay = chainOf({ recalled: live.records });
    const done = replay.call(undefined, { model: OTHER_MODEL });
    assert.equal(replay.records.size, 0, 'a recall hit is not remembered again');
    // The divisor of ascii under OTHER_MODEL is two.
    assert.deepEqual(tokensOf(replay.scratch, A), { 1: 2, 3: 3 });
    assert.deepEqual(keysOfImpact(impactOf(done)), [1, 3]);
    assert.deepEqual(replay.scratch.get(A).get(3), { chars: 6, cjk: 0, tokens: 3, fp: fp('jklmno') });
    assertTwin(replay);
  });
});

describe('key relocation', () => {
  // Six authored lines of eight characters, each its own: two tokens apiece under MODEL.
  const V1 = ['aaaa-001', 'bbbb-002', 'cccc-003', 'dddd-004', 'eeee-005', 'ffff-006'];

  test('moves the entries of a file whose lines moved down to the lines they are on now', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    const v2 = ['new-0001', 'new-0002', ...V1];
    const done = chain.call(showing(A, v2, [8]));
    // The six lines are on lines three to eight; the keys one and two, which they left, hold nothing.
    assert.deepEqual(chain.scratch.get(A), new Map([
      [1, ZERO], [2, ZERO],
      [3, entryOf('aaaa-001')], [4, entryOf('bbbb-002')], [5, entryOf('cccc-003')],
      [6, entryOf('dddd-004')], [7, entryOf('eeee-005')], [8, entryOf('ffff-006')],
    ]));
    assert.deepEqual(residencyOf(chain.scratch, A), [3, 4, 5, 6, 7, 8]);
    assert.equal(impactOf(done).mutation.kind, 'merge-fragments');
    assert.deepEqual(impactOf(done).mutation.fragments, [
      { key: 1, tokens: 0 }, { key: 2, tokens: 0 },
      { key: 3, tokens: 2 }, { key: 4, tokens: 2 }, { key: 5, tokens: 2 },
      { key: 6, tokens: 2 }, { key: 7, tokens: 2 }, { key: 8, tokens: 2 },
    ]);
    // The record the store is offered holds the same entries: the zero ones with no fingerprint, the others with theirs,
    // and the entries that moved marked as moved. The line of the call, key eight, is the call's own and is not marked.
    const sent = text => ({ chars: text.length, cjk: 0, fp: fp(text) });
    assert.deepEqual(chain.records.get('c2').effects[0].impacts[0].entries, [
      { key: 1, chars: 0, cjk: 0 }, { key: 2, chars: 0, cjk: 0 },
      { key: 3, ...sent('aaaa-001'), moved: true }, { key: 4, ...sent('bbbb-002'), moved: true },
      { key: 5, ...sent('cccc-003'), moved: true }, { key: 6, ...sent('dddd-004'), moved: true },
      { key: 7, ...sent('eeee-005'), moved: true }, { key: 8, ...sent('ffff-006') },
    ]);
    assertTwin(chain);
  });

  test('moves the entries of a file whose lines moved up, and zeroes those whose lines are gone', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    chain.call(showing(A, V1.slice(2), [4]));
    // The first two lines are deleted: the other four are on lines one to four, and the keys five and six are left.
    assert.deepEqual(chain.scratch.get(A), new Map([
      [1, entryOf('cccc-003')], [2, entryOf('dddd-004')], [3, entryOf('eeee-005')], [4, entryOf('ffff-006')],
      [5, ZERO], [6, ZERO],
    ]));
    assertTwin(chain);
  });

  test('zeroes an entry whose line is not in the file any more, and moves the entries around it', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    const v2 = V1.filter(line => line !== 'cccc-003');
    chain.call(showing(A, v2, [1]));
    assert.deepEqual(chain.scratch.get(A), new Map([
      [1, entryOf('aaaa-001')], [2, entryOf('bbbb-002')], [3, entryOf('dddd-004')],
      [4, entryOf('eeee-005')], [5, entryOf('ffff-006')], [6, ZERO],
    ]));
    assertTwin(chain);
  });

  test('prices the entries it moves at the policy of the call that moves them', () => {
    const chain = chainOf();
    // The divisor of ascii under OTHER_MODEL is two: four tokens a line, and two under MODEL.
    chain.call(wholeOf(A, V1), { model: OTHER_MODEL });
    chain.call(showing(A, ['new-0001', ...V1], [1]));
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2 });
    assertTwin(chain);
  });

  test('sends only what moved or is gone: the entries that stay where they are are not sent again', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1), { model: OTHER_MODEL });
    // A middle line is replaced, so that the lines around it stay where they are.
    const v2 = [...V1];
    v2[2] = 'xxxx-003';
    const done = chain.call(showing(A, v2, [1]));
    // What the call sends is the key whose line is gone and its own line. The lines that stayed keep the four tokens
    // they were priced at.
    assert.deepEqual(keysOfImpact(impactOf(done)), [3, 1]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 4, 3: 0, 4: 4, 5: 4, 6: 4 });
    assertTwin(chain);
  });

  test('leaves one entry for a key that a moved entry and this call\'s line both land on, the line of the call winning', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    const v2 = ['new-0001', ...V1];
    // The call shows lines three and four numbered, as a tool shows them, so that each is longer than its entry.
    const done = chain.call(showing(A, v2, [3, 4], { texts: { 3: '3: bbbb-002', 4: '4: cccc-003' } }));
    const keys = keysOfImpact(impactOf(done));
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(chain.scratch.get(A).get(3), { chars: 11, cjk: 0, tokens: 2.75, fp: fp('bbbb-002') });
    assert.deepEqual(chain.scratch.get(A).get(4), { chars: 11, cjk: 0, tokens: 2.75, fp: fp('cccc-003') });
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 0, 2: 2, 3: 2.75, 4: 2.75, 5: 2, 6: 2, 7: 2 });
    // The lines of the call that landed on moved keys are the call's own: they carry no mark, the others do, and the
    // spend is those two lines alone.
    const entries = chain.records.get('c2').effects[0].impacts[0].entries;
    assert.deepEqual(entries.filter(entry => entry.moved === true).map(entry => entry.key), [2, 5, 6, 7]);
    assert.equal('moved' in entries.find(entry => entry.key === 3), false);
    assert.equal('moved' in entries.find(entry => entry.key === 4), false);
    assert.equal(done.effects[0].spentTokens, 5.5);
    assertTwin(chain);
  });

  test('leaves an entry without a fingerprint where it is: not moved, not zeroed, not sent', () => {
    // The first call is replayed from a record whose fingerprint of key nine is no fingerprint.
    const record = {
      v: 1,
      effects: [{
        access: 'read',
        impacts: [{
          resourceKey: A,
          kind: 'merge-fragments',
          entries: [
            { key: 1, chars: 8, cjk: 0, fp: fp('aaaa-001') },
            { key: 2, chars: 8, cjk: 0, fp: fp('bbbb-002') },
            { key: 3, chars: 8, cjk: 0, fp: fp('cccc-003') },
            { key: 9, chars: 8, cjk: 0, fp: 'not a fingerprint' },
          ],
        }],
      }],
      residual: null,
    };
    const chain = chainOf({ recalled: new Map([['c1', record]]) });
    chain.call(undefined);
    assert.equal('fp' in chain.scratch.get(A).get(9), false);
    const done = chain.call(showing(A, ['new-0001', ...V1], [1]));
    assert.deepEqual(chain.scratch.get(A).get(9), { chars: 8, cjk: 0, tokens: 2 });
    assert.equal(keysOfImpact(impactOf(done)).includes(9), false);
    assert.deepEqual(residencyOf(chain.scratch, A), [1, 2, 3, 4, 9]);
    assertTwin(chain);
  });

  // Lines two to four are a block that the file repeats at its end.
  const REPEATING = ['top-0001', 'blk-0002', 'blk-0003', 'blk-0004', 'mid-0005', 'blk-0002', 'blk-0003', 'blk-0004'];

  test('sends this call\'s lines only for a partial read of a file whose recorded fingerprints agree with it', () => {
    // The second row is the one the agreement check decides: without the check the table pairs the block that was seen
    // with its copy at the end of the file.
    const cases = [
      ['a file whose lines are all its own', V1, numbers(1, 6), 4],
      ['a file that repeats at its end the block that was seen', REPEATING, [2, 3, 4], 1],
    ];
    for (const [label, file, seen, shown] of cases) {
      const chain = chainOf();
      chain.call(showing(A, file, seen));
      const before = structuredClone(chain.scratch.get(A));
      const done = chain.call(showing(A, file, [shown]));
      // The call sends its line and nothing else, and the record it offers holds nothing else.
      assert.deepEqual(keysOfImpact(impactOf(done)), [shown], label);
      assert.deepEqual(chain.records.get('c2').effects[0].impacts[0].entries.map(entry => entry.key), [shown], label);
      for (const [key, entry] of before) assert.deepEqual(chain.scratch.get(A).get(key), entry, `${label}: key ${key}`);
      assertTwin(chain);
    }
  });

  test('keeps a partial read a merge when the moved entries and its own lines together cover every line', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1.slice(0, 4)));
    // One line above the four: the entries are on lines two to five, and the call shows line one.
    const done = chain.call(showing(A, ['new-0001', ...V1.slice(0, 4)], [1]));
    assert.deepEqual(keysOfImpact(impactOf(done)), [1, 2, 3, 4, 5]);
    assert.equal(impactOf(done).mutation.kind, 'merge-fragments');
    assert.deepEqual(done.telemetry.pathEvents.map(event => event.isFullRead), [0]);
    assertTwin(chain);
  });

  test('leaves the entries of a resource the call did not touch where the ledger has them', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    // The file of A has changed on disk, but this call shows B.
    chain.call(showing(B, V1, [1]));
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 });
    assertTwin(chain);
  });

  // A call that shows the file on both sides: the lines the write named, then the lines the result showed.
  const bothSides = (file, written, shown) => ({
    matches: [
      { resourceKey: A, side: 'input', lines: written.map(line => ({ line, text: file[line - 1], tier: 'declared' })) },
      { resourceKey: A, side: 'output', lines: shown.map(line => ({ line, text: file[line - 1], tier: 'declared' })) },
    ],
    files: { [A]: file.map(fp) },
    unmatched: NONE,
    stats: { failed: false },
  });

  test('places a resource once for a call that touches it on both sides: the write finds the entries, the read finds them placed', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    const v2 = ['new-0001', ...V1];
    const done = chain.call(bothSides(v2, [3], [5]));
    assert.deepEqual(keysOfImpact(impactOf(done, 'write')), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(keysOfImpact(impactOf(done, 'read')), [5]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 0, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2 });
    assertTwin(chain);
  });

  test('does not bring back the entries a write of the whole file replaced into the read of the same call', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, V1));
    const v2 = ['new-0001', 'new-0002', 'new-0003'];
    const done = chain.call(bothSides(v2, [1, 2, 3], [2]));
    assert.equal(impactOf(done, 'write').mutation.kind, 'replace-fragments');
    assert.deepEqual(keysOfImpact(impactOf(done, 'read')), [2]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2 });
    assertTwin(chain);
  });
});

describe('the limits of a relocation', () => {
  const EIGHT = ['aaaa-001', 'bbbb-002', 'cccc-003', 'dddd-004', 'eeee-005', 'ffff-006', 'gggg-007', 'hhhh-008'];
  // A line inserted above, the fifth line replaced, and the last three as they were: the equal end of three lines
  // leaves five lines against six for the table.
  const EDITED = ['new-0001', 'aaaa-001', 'bbbb-002', 'cccc-003', 'dddd-004', 'new-0002', 'ffff-006', 'gggg-007', 'hhhh-008'];

  test('keeps the keys where they were sent when the table would be over the cap', () => {
    const chain = chainOf({ limits: { ...LIMITS, alignCells: 29 } });
    chain.call(wholeOf(A, EIGHT));
    const done = chain.call(showing(A, EDITED, [1]));
    // Nothing is moved or zeroed: the call sends its own line and the eight entries keep the keys they were sent under.
    assert.deepEqual(keysOfImpact(impactOf(done)), [1]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2 });
    assert.equal(chain.scratch.get(A).get(2).fp, fp('bbbb-002'));
    assertTwin(chain);
  });

  test('moves the same entries under a cap the table fits', () => {
    const chain = chainOf({ limits: { ...LIMITS, alignCells: 30 } });
    chain.call(wholeOf(A, EIGHT));
    chain.call(showing(A, EDITED, [1]));
    // Five lines against six is thirty cells. The first four lines are on lines two to five; the fifth is gone.
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 0, 7: 2, 8: 2, 9: 2 });
    assert.equal(chain.scratch.get(A).get(2).fp, fp('aaaa-001'));
    assertTwin(chain);
  });

  test('shifts a large file with a line inserted at the top under a cap below the product of its two lengths', () => {
    const file = numbers(1, 200).map(line => `row ${String(line).padStart(3, '0')}`);
    const edited = ['inserted', ...file];
    const limits = { ...LIMITS, alignCells: 1_000 };
    assert.ok(limits.alignCells < file.length * edited.length);
    const chain = chainOf({ limits });
    chain.call(wholeOf(A, file));
    chain.call(showing(A, edited, [100, 101]));
    // Every entry moved down a line; the key it left holds nothing.
    assert.deepEqual(residencyOf(chain.scratch, A), numbers(2, 201));
    assert.equal(chain.scratch.get(A).get(1).tokens, 0);
    assert.equal(chain.scratch.get(A).get(2).fp, fp('row 001'));
    assert.equal(chain.scratch.get(A).get(201).fp, fp('row 200'));
    assertTwin(chain);
  });

  // The file, with the block of lines 10 to 12 a copy of the block of lines 1 to 3, and the last line equal to the
  // last line of that block.
  const SPARSE = [
    'hdr-A001', 'hdr-B002', 'hdr-C003', 'body-004', 'body-005', 'body-006', 'body-007', 'body-008', 'body-009',
    'hdr-A001', 'hdr-B002', 'hdr-C003', 'body-013', 'hdr-C003',
  ];

  test('places a sparse set of entries by the lines they were sent for, though other lines above them are alike', () => {
    const above = [['at the top', ['new-0001', ...SPARSE]], ['after line four', [...SPARSE.slice(0, 4), 'new-0005', ...SPARSE.slice(4)]]];
    for (const [label, edited] of above) {
      const chain = chainOf();
      // The lines reach the scratch out of order: twelve, then ten and eleven.
      chain.call(showing(A, SPARSE, [12]));
      chain.call(showing(A, SPARSE, [10, 11]));
      const done = chain.call(showing(A, edited, [13]));
      // What is sent is in key order: the zero entries, then the moved entries, then the call's own line.
      assert.deepEqual(keysOfImpact(impactOf(done)), [10, 11, 12, 13], label);
      // The copy of the block is the one that was seen: lines 11 to 13 of the edited file, whichever line was added.
      assert.equal(chain.scratch.get(A).get(11).fp, fp('hdr-A001'), label);
      assert.equal(chain.scratch.get(A).get(12).fp, fp('hdr-B002'), label);
      assert.equal(chain.scratch.get(A).get(13).fp, fp('hdr-C003'), label);
      assert.deepEqual(chain.scratch.get(A).get(10), ZERO, label);
      assert.deepEqual(residencyOf(chain.scratch, A), [11, 12, 13], label);
      assertTwin(chain);
    }
  });

  test('takes a last line equal to the last line of the file for no sign that the recorded lines end where the file does', () => {
    const chain = chainOf();
    chain.call(showing(A, SPARSE, [10, 11, 12]));
    chain.call(showing(A, ['new-0001', ...SPARSE], [1]));
    // The recorded lines are on lines 11 to 13, not at the end of the file.
    assert.deepEqual(residencyOf(chain.scratch, A), [1, 11, 12, 13]);
    assert.equal(chain.scratch.get(A).get(13).fp, fp('hdr-C003'));
    assert.equal(chain.scratch.get(A).has(15), false);
    assertTwin(chain);
  });

  test('weighs a sparse set by the table it fills, the holes above it included', () => {
    const file = numbers(1, 60).map(line => `row ${String(line).padStart(3, '0')}`);
    const edited = ['inserted', ...file.slice(0, 20), 'changed', ...file.slice(21)];
    // Lines 40 to 42 were seen, and the file changed above them in two places.
    const fits = { ...LIMITS, alignCells: 42 * 61 };
    const chainFit = chainOf({ limits: fits });
    chainFit.call(showing(A, file, [40, 41, 42]));
    chainFit.call(showing(A, edited, [1]));
    assert.deepEqual(residencyOf(chainFit.scratch, A), [1, 41, 42, 43]);
    const over = chainOf({ limits: { ...LIMITS, alignCells: 42 * 61 - 1 } });
    over.call(showing(A, file, [40, 41, 42]));
    over.call(showing(A, edited, [1]));
    assert.deepEqual(residencyOf(over.scratch, A), [1, 40, 41, 42]);
    assertTwin(chainFit);
    assertTwin(over);
  });

  test('lets an entry whose key is not a line the table can hold take no part, and moves the others', () => {
    const entry = (key, text, fingerprint = fp(text)) => ({ key, chars: text.length, cjk: 0, fp: fingerprint });
    const record = {
      v: 1,
      effects: [{
        access: 'read',
        impacts: [{
          resourceKey: A,
          kind: 'merge-fragments',
          entries: [
            entry(1, 'aaaa-001'), entry(2, 'bbbb-002'), entry(3, 'cccc-003'),
            entry(0, 'zero-key'), entry(1.5, 'half-key'), entry(2 ** 40, 'huge-key'),
          ],
        }],
      }],
      residual: null,
    };
    const chain = chainOf({ recalled: new Map([['c1', record]]) });
    chain.call(undefined);
    assert.doesNotThrow(() => chain.call(showing(A, ['new-0001', ...EIGHT], [1])));
    assert.deepEqual(residencyOf(chain.scratch, A), [0, 1, 1.5, 2, 3, 4, 2 ** 40].sort((a, b) => a - b));
    assert.equal(chain.scratch.get(A).get(4).fp, fp('cccc-003'));
    for (const key of [0, 1.5, 2 ** 40]) assert.equal(chain.scratch.get(A).get(key).tokens, 2, String(key));
    assertTwin(chain);
  });
});

describe('the spend of a call that moves entries', () => {
  // Six authored lines of eight characters: two tokens apiece under MODEL.
  const V1 = ['aaaa-001', 'bbbb-002', 'cccc-003', 'dddd-004', 'eeee-005', 'ffff-006'];

  // A chain with a real Engine beside it, which takes the effects of every call.
  function engineChain() {
    const chain = chainOf();
    const engine = makeEngine();
    engine.ingest([stepOf('m0', 100_000)]);
    return {
      chain,
      engine,
      call(reply) {
        const done = chain.call(reply);
        engine.ingest(done.effects.map(effect => ({ type: 'effect', ...effect })));
        return done;
      },
    };
  }

  const rowFigures = (engine) => {
    const { tokens, totalSpent, churn, efficiency } = rowOf(engine, A);
    return { tokens, totalSpent, churn, efficiency };
  };

  test('is the tokens of the call\'s own lines alone, the same live and replayed from the JSON of its record', () => {
    const live = chainOf();
    live.call(wholeOf(A, V1));
    // A line is inserted above and two lines already read are read again: six entries move, two lines are the call's.
    const done = live.call(showing(A, ['new-0001', ...V1], [4, 5]));
    const [effect] = done.effects;
    const fragments = effect.impacts[0].mutation.fragments;
    assert.deepEqual(fragments.map(fragment => fragment.key), [1, 2, 3, 4, 5, 6, 7]);
    // The impact still holds the six moved entries and the two lines of the call, two tokens each, the zero entry none.
    assert.equal(fragments.reduce((total, fragment) => total + fragment.tokens, 0), 12);
    assert.equal(effect.spentTokens, 4);

    const record = JSON.parse(JSON.stringify(live.records.get('c2')));
    const replay = chainOf({ recalled: new Map([['c2', record]]) });
    replay.call(wholeOf(A, V1));
    const replayed = replay.call(undefined);
    assert.equal(replay.asked(), 1, 'only the first call asked the matcher');
    assert.deepEqual(replayed.effects, done.effects);
    assert.deepEqual(replay.scratch, live.scratch);
    assertTwin(replay);
  });

  // A record of one impact whose two entries carry the marks given.
  const recordMarked = marks => ({
    v: 1,
    effects: [{
      access: 'read',
      impacts: [{
        resourceKey: A,
        kind: 'merge-fragments',
        entries: [
          { key: 1, chars: 8, cjk: 0, fp: fp('aaaa-001'), ...marks[0] },
          { key: 2, chars: 8, cjk: 0, fp: fp('bbbb-002'), ...marks[1] },
        ],
      }],
    }],
    residual: null,
  });

  test('keeps the mark of a moved entry that is true and reads any other as absent, the record still replaying', () => {
    const cases = [
      ['true', { moved: true }, 2],
      ['absent', {}, 4],
      ['false', { moved: false }, 4],
      ['text', { moved: 'yes' }, 4],
      ['a number', { moved: 1 }, 4],
      ['null', { moved: null }, 4],
    ];
    for (const [label, mark, spentTokens] of cases) {
      const chain = chainOf({ recalled: new Map([['c1', recordMarked([{}, mark])]]) });
      const done = chain.call(undefined);
      assert.equal(chain.asked(), 0, `${label}: the record is read, not missed`);
      // The impact holds both entries; the spend is the entries not marked moved.
      assert.deepEqual(keysOfImpact(impactOf(done)), [1, 2], label);
      assert.equal(done.effects[0].spentTokens, spentTokens, label);
      // The scratch holds the counts, the tokens and the fingerprint, never the mark.
      assert.deepEqual(chain.scratch.get(A).get(2), { chars: 8, cjk: 0, tokens: 2, fp: fp('bbbb-002') }, label);
      assertTwin(chain);
    }
  });

  test('leaves the spend of the resource in the Engine as an unedited file leaves it after a pure shift', () => {
    const unedited = engineChain();
    unedited.call(wholeOf(A, V1));
    unedited.call(showing(A, V1, [3, 4]));
    const shifted = engineChain();
    shifted.call(wholeOf(A, V1));
    shifted.call(showing(A, ['new-0001', ...V1], [4, 5]));
    // Six lines of two tokens are held. The whole read spent twelve and the two lines read again four; the lines that
    // moved down by one spent nothing.
    assert.deepEqual(rowFigures(unedited.engine), { tokens: 12, totalSpent: 16, churn: 16 / 12, efficiency: 75 });
    assert.deepEqual(rowFigures(shifted.engine), rowFigures(unedited.engine));
  });

  test('keeps the churn of a file at one through a loop of edits that each insert lines above it', () => {
    const rig = engineChain();
    let file = numbers(1, 12).map(line => `row-${String(line).padStart(4, '0')}`);
    rig.call(wholeOf(A, file));
    for (let edit = 1; edit <= 8; edit++) {
      // The edit writes two lines at the top, which the call carries as the text it wrote; the file moves down by two.
      file = [`ins-0${edit}-a`, `ins-0${edit}-b`, ...file];
      rig.call(showing(A, file, [1, 2], { side: 'input' }));
      assert.deepEqual(residencyOf(rig.chain.scratch, A), numbers(1, file.length), `after edit ${edit}`);
      // Every line held was spent once, and no more: two tokens a line.
      const held = 2 * file.length;
      assert.deepEqual(rowFigures(rig.engine), { tokens: held, totalSpent: held, churn: 1, efficiency: 100 }, `after edit ${edit}`);
    }
  });
});

describe('a chain replayed from records', () => {
  const V1 = ['l1-aaaa', 'l2-bbbb', 'l3-cccc', 'l4-dddd', 'l5-eeee', 'l6-ffff'];
  // Two lines inserted above V1, then the first four lines of that file gone: V3 is V1 from its third line.
  const V2 = ['n1-new1', 'n2-new2', ...V1];
  const V3 = V1.slice(2);

  // The calls of the live chain: the matcher's replies in order. The first reads all of V1, the second part of V2, the
  // third part of the shortened file and the fourth all of it.
  const REPLIES = [wholeOf(A, V1), showing(A, V2, [4, 5]), showing(A, V3, [1]), wholeOf(A, V3)];

  // The live chain, with the scratch and the effects of every call as it left them.
  function liveRun() {
    const chain = chainOf();
    const states = [];
    const effects = [];
    for (const reply of REPLIES) {
      effects.push(chain.call(reply).effects);
      states.push(structuredClone(chain.scratch));
    }
    return { chain, states, effects };
  }

  test('builds a scratch equal to the live chain\'s after every call, the first call having no record', () => {
    const { chain: live, states, effects } = liveRun();
    assert.equal(live.records.size, REPLIES.length);
    const recalled = new Map(live.records);
    recalled.delete('c1');
    const replay = chainOf({ recalled });
    REPLIES.forEach((reply, index) => {
      const done = replay.call(reply);
      assert.deepEqual(replay.scratch, states[index], `after call ${index + 1}`);
      assert.deepEqual(done.effects, effects[index], `the effects of call ${index + 1}`);
      assertTwin(replay);
    });
    // The first call was partitioned again and so offered a record; the others were recalled and offered none.
    assert.deepEqual([...replay.records.keys()], ['c1']);
  });

  test('continues over a first call partitioned against a later file, with no key repeated and the same end state', () => {
    const { chain: live, states } = liveRun();
    const recalled = new Map(live.records);
    recalled.delete('c1');
    const replay = chainOf({ recalled });
    // With no record the first call meets the file as it is now: the shortened one, of which it shows three lines.
    assert.doesNotThrow(() => replay.call(showing(A, V3, [1, 2, 3])));
    assertTwin(replay);
    for (const reply of REPLIES.slice(1)) assert.doesNotThrow(() => replay.call(reply));
    assertTwin(replay);
    // The last record replaces all the entries, so whatever the first call left, the chains end alike.
    assert.deepEqual(replay.scratch, states[states.length - 1]);
  });

  test('takes a recalled record as it is: the matcher is not asked and no entry is placed', () => {
    const record = {
      v: 1,
      effects: [{
        access: 'read',
        impacts: [{
          resourceKey: A,
          kind: 'merge-fragments',
          entries: [{ key: 3, chars: 8, cjk: 0, fp: fp('other-line') }],
        }],
      }],
      residual: null,
    };
    const chain = chainOf({ recalled: new Map([['c2', record]]) });
    chain.call(wholeOf(A, V1));
    const askedBefore = chain.asked();
    const done = chain.call(undefined);
    assert.equal(chain.asked(), askedBefore);
    // The entry of key three is the record's alone: none of the others was moved or zeroed.
    assert.deepEqual(keysOfImpact(impactOf(done)), [3]);
    assert.deepEqual(tokensOf(chain.scratch, A), { 1: 1.75, 2: 1.75, 3: 2, 4: 1.75, 5: 1.75, 6: 1.75 });
    assert.deepEqual(chain.scratch.get(A).get(3), { chars: 8, cjk: 0, tokens: 2, fp: fp('other-line') });
    assertTwin(chain);
  });
});

describe('the residual weight', () => {
  // Four authored lines of 3, 6, 12 and 24 characters, so that a sum of them names the lines it counts.
  const FILE = ['end', 'return', 'let count=0;', 'export function load() {'];
  const ALL = numbers(1, 4);

  // One matcher answer for the groups of several: the lines each shows and the fingerprints of each file.
  const together = (...answers) => ({
    matches: answers.flatMap(answer => answer.matches),
    files: Object.assign({}, ...answers.map(answer => answer.files)),
    unmatched: NONE,
    stats: { failed: false },
  });

  test('is the unmatched sum for a first read, whole or in part: nothing of it was held before', () => {
    const unmatched = { input: 7, output: 5 };
    for (const shown of [ALL, [2, 3]]) {
      const chain = chainOf();
      const done = chain.call(showing(A, FILE, shown, { unmatched }));
      assert.equal(weightOf(done), 12, `lines ${shown}`);
      assert.equal(storedWeightOf(chain, done), 12, `lines ${shown}`);
      assertTwin(chain);
    }
  });

  test('adds the characters of lines read again, which the ledger holds already, and leaves the entries as they were', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, ALL));
    const before = structuredClone(chain.scratch);
    // Lines two and four again, with five characters no line explains: the 6 and 24 of the lines and the 5.
    const again = chain.call(showing(A, FILE, [2, 4], { unmatched: { input: 0, output: 5 } }));
    assert.equal(weightOf(again), 35);
    assert.equal(storedWeightOf(chain, again), 35);
    assert.deepEqual(chain.scratch, before);
    // With nothing unmatched the lines are the whole weight, and the call still has a residual.
    const bare = chain.call(showing(A, FILE, [1, 3]));
    assert.deepEqual(bare.residuals.map(residual => residual.weight), [15]);
    assert.deepEqual(chain.scratch, before);
    assertTwin(chain);
  });

  test('sums the resident parts of the resources a call touches, a resource met for the first time adding none', () => {
    const chain = chainOf();
    chain.call(together(showing(A, FILE, [1, 2]), showing(B, FILE, [3, 4])));
    // Line one of the first file again (3), line four of the second again (24), and line two of a third file, new.
    const done = chain.call(together(showing(A, FILE, [1]), showing(B, FILE, [4]), showing(F, FILE, [2])));
    assert.equal(weightOf(done), 27);
    assertTwin(chain);
  });

  test('adds the second copy of a line a call carries twice, which the ledger holds once, and the side length balances', () => {
    const edited = [...FILE.slice(0, 3), 'export function load(path) {'];
    const rows = [
      // The old and new strings of an edit both carry lines two and three (6 + 12), and the new one a line four.
      ['the old and new strings of an edit', null,
        showing(A, edited, [2, 3, 2, 3, 4], { side: 'input', unmatched: { input: 40, output: 0 } }), 18],
      ['a result that shows two lines twice', null,
        showing(B, FILE, [1, 2, 1, 2], { unmatched: { input: 0, output: 9 } }), 9],
      // Held already and carried twice: both copies are text the ledger takes no growth from.
      ['lines held already, carried twice', showing(B, FILE, [1, 2]), showing(B, FILE, [1, 2, 1, 2]), 18],
    ];
    for (const [label, prior, reply, resident] of rows) {
      const chain = chainOf();
      if (prior !== null) chain.call(prior);
      const resourceKey = reply.matches[0].resourceKey;
      const held = totalCharsOf(chain.scratch, resourceKey);
      const done = chain.call(reply);
      const remainder = reply.unmatched.input + reply.unmatched.output;
      assert.equal(weightOf(done), remainder + resident, label);
      // The length of the side is what the weight holds beyond the remainder, plus what the entries gained.
      const sideLength = reply.matches[0].lines.reduce((total, { text }) => total + text.length, 0);
      const gained = totalCharsOf(chain.scratch, resourceKey) - held;
      assert.equal(sideLength, weightOf(done) - remainder + gained, label);
      assertTwin(chain);
    }
  });

  test('adds the characters of the lines a whole read of a shortened file no longer holds: the context still has them', () => {
    const chain = chainOf();
    chain.call(wholeOf(A, FILE));
    assert.equal(totalCharsOf(chain.scratch, A), 45);
    // The file loses its last two lines, and the read of what is left replaces every entry.
    const done = chain.call(wholeOf(A, FILE.slice(0, 2)));
    assert.equal(impactOf(done).mutation.kind, 'replace-fragments');
    assert.equal(totalCharsOf(chain.scratch, A), 9);
    // The ledger lost 36 characters while the call brought 9: the 9 of the lines read again and the 36 of the two it dropped.
    assert.equal(weightOf(done), 45);
    assertTwin(chain);
  });

  test('folds a write and a read of one resource in turn, the read finding the entries the write left', () => {
    const chain = chainOf();
    chain.call(showing(A, FILE, [2]));
    // Line two is rewritten to 13 characters and the result shows it, against the 6 held.
    const rewritten = [FILE[0], 'return value;', ...FILE.slice(2)];
    const done = chain.call({
      matches: ['input', 'output'].map(side => ({
        resourceKey: A, side, lines: [{ line: 2, text: 'return value;', tier: 'declared' }],
      })),
      files: { [A]: rewritten.map(fp) },
      unmatched: NONE,
      stats: { failed: false },
    });
    assert.deepEqual(charsOf(chain.scratch, A), { 2: 13 });
    // 26 characters were carried and the entries gained 7: the write gains them on the 6 held, and the read finds the 13 there.
    assert.equal(weightOf(done), 19);
    assertTwin(chain);
  });

  // Nine unchanged lines above three that were read: a header of 7 characters, a long line of 24 and a closing line of 1.
  const HEAD = numbers(1, 9).map(row => `row ${row}`);
  const [DEF, LONG, CLOSE, COMMENT, SHORTER] = ['def a {', 'something_very_long_line', '}', '# comment', 'something_shorter'];
  const SEEN = [...HEAD, DEF, LONG, CLOSE];
  // A call that never named the file put a comment above those lines, and the long line was then edited to one of 17.
  // The new line is line twelve, the key the closing line held when the lines were read.
  const EDITED = [...HEAD, COMMENT, DEF, SHORTER, CLOSE];

  describe('after a line was inserted above the lines that were read', () => {
    test('sets the new line against the entry the alignment leaves unpaired, not against the entry that held its number', () => {
      const chain = chainOf();
      chain.call(showing(A, SEEN, [10, 11, 12]));
      assert.deepEqual(charsOf(chain.scratch, A), { 10: 7, 11: 24, 12: 1 });
      const done = chain.call(showing(A, EDITED, [12], { side: 'input' }));
      // Placed under the lines they are on: the header on eleven, the closing line on thirteen, and the long line, which
      // has no line any more, gone. The new line takes twelve.
      assert.deepEqual(charsOf(chain.scratch, A), { 10: 0, 11: 7, 12: 17, 13: 1 });
      assert.deepEqual(keysOfImpact(impactOf(done, 'write')), [10, 11, 12, 13]);
      // The call carried 17 characters while the entries fell by 7, from 32 to 25: 24 characters sit in context beyond
      // what the entries grew by, the long line the ledger gave up and the context still holds. Against the closing
      // line that held key twelve before the comment went in, the new line would be a gain of 16 and the weight 1.
      assert.equal(weightOf(done), 24);
      assert.equal(storedWeightOf(chain, done), 24);
      assertTwin(chain);
    });

    test('weighs the same edit alike after an earlier call placed the entries, and a shift alone adds nothing', () => {
      const chain = chainOf();
      chain.call(showing(A, SEEN, [10, 11, 12]));
      // The comment is in and the long line not yet edited; a read of line one places the entries a line down.
      const shifted = chain.call(showing(A, [...HEAD, COMMENT, DEF, LONG, CLOSE], [1]));
      assert.deepEqual(charsOf(chain.scratch, A), { 1: 5, 10: 0, 11: 7, 12: 24, 13: 1 });
      assert.equal(weightOf(shifted), 0);
      assert.deepEqual(shifted.residuals, []);
      // The key the entries left holds nothing and carries no fingerprint, and that does not stop the edit being weighed.
      const done = chain.call(showing(A, EDITED, [12], { side: 'input' }));
      assert.equal(weightOf(done), 24);
      assertTwin(chain);
    });
  });

  describe('where relocation made no judgement', () => {
    const recordOf = entries => ({
      v: 1,
      effects: [{ access: 'read', impacts: [{ resourceKey: A, kind: 'merge-fragments', entries }] }],
      residual: null,
    });
    const entryFor = (key, text, { fingerprint = true } = {}) => ({
      key, chars: text.length, cjk: 0, ...(fingerprint ? { fp: fp(text) } : {}),
    });
    const read = options => [entryFor(10, DEF, options), entryFor(11, LONG, options), entryFor(12, CLOSE, options)];

    // The edit of the lines that were read, with three characters no line explains, over entries a record replays.
    function editOver(entries, limits = {}) {
      const chain = chainOf({ limits: { ...LIMITS, ...limits }, recalled: new Map([['c1', recordOf(entries)]]) });
      chain.call(undefined);
      const done = chain.call(showing(A, EDITED, [12], { side: 'input', unmatched: { input: 3, output: 0 } }));
      assertTwin(chain);
      return { chain, done };
    }

    test('counts the long line the edit replaced when every entry carries its fingerprint and the table fits', () => {
      const { chain, done } = editOver(read());
      assert.equal(weightOf(done), 27);
      assert.equal(storedWeightOf(chain, done), 27);
    });

    const NOT_JUDGED = [
      ['no entry carries a fingerprint', read({ fingerprint: false }), {}],
      ['one entry carries none, though the others do', [...read(), entryFor(30, 'a stray line', { fingerprint: false })], {}],
      ['one entry stands under a key the table cannot reach', [...read(), entryFor(2 ** 40, 'a far-off line')], {}],
      ['the table would be over the cap', read(), { alignCells: 100 }],
    ];
    for (const [label, entries, limits] of NOT_JUDGED) {
      test(`counts nothing of the resource beyond the remainder when ${label}`, () => {
        const { chain, done } = editOver(entries, limits);
        assert.equal(weightOf(done), 3);
        assert.equal(storedWeightOf(chain, done), 3);
      });
    }
  });

  describe('of a recalled record', () => {
    const REPLIES = [
      showing(A, SEEN, [10, 11, 12], { unmatched: { input: 0, output: 2 } }),
      showing(A, SEEN, [11], { unmatched: { input: 0, output: 1 } }),
      showing(A, EDITED, [12], { side: 'input', unmatched: { input: 4, output: 0 } }),
    ];
    // The first call is its remainder, the second adds the long line read again, the third the long line it replaced.
    const WEIGHTS = [2, 25, 28];

    test('is the weight the live chain stored, and the scratch it builds is the live chain\'s after every call', () => {
      const live = chainOf();
      const states = [];
      const lives = REPLIES.map((reply) => {
        const done = live.call(reply);
        states.push(structuredClone(live.scratch));
        return done;
      });
      assert.deepEqual(lives.map(weightOf), WEIGHTS);
      assert.deepEqual(lives.map(done => storedWeightOf(live, done)), WEIGHTS);
      // The store gives back what it was given as JSON.
      const recalled = new Map([...live.records].map(([toolUseId, record]) => [toolUseId, JSON.parse(JSON.stringify(record))]));
      const replay = chainOf({ recalled });
      REPLIES.forEach((_, index) => {
        const done = replay.call(undefined);
        assert.deepEqual(done.residuals, lives[index].residuals, `the residual of call ${index + 1}`);
        assert.deepEqual(replay.scratch, states[index], `after call ${index + 1}`);
        assertTwin(replay);
      });
      assert.equal(replay.asked(), 0);
      assert.equal(replay.records.size, 0);
    });

    test('is emitted as stored, whatever the scratch it meets holds', () => {
      const live = chainOf();
      live.call(REPLIES[0]);
      live.call(REPLIES[1]);
      const stored = structuredClone(live.records.get('c2'));
      assert.equal(stored.residual.weight, 25);
      stored.residual.weight = 99;
      // The record meets a scratch that holds nothing, where the lines it names were not read before.
      const replay = chainOf({ recalled: new Map([['c1', stored]]) });
      const done = replay.call(undefined);
      assert.equal(weightOf(done), 99);
      assert.equal(replay.asked(), 0);
    });
  });

  describe('in the interval of a real Engine', () => {
    test('gives a read of lines held already a larger share than its remainder alone would, beside a call of remainder only', () => {
      const chain = chainOf();
      const engine = makeEngine();
      engine.ingest([stepOf('m0', 100_000)]);
      const ingest = done => engine.ingest([
        ...done.effects.map(effect => ({ type: 'effect', ...effect })),
        ...done.residuals.map(residual => ({ type: 'residual', ...residual })),
      ]);
      const shareOf = groupKey => engine.getBucketData().residual.find(group => group.groupKey === groupKey)?.tokens;

      // The first read has no remainder and so no residual.
      ingest(chain.call(wholeOf(A, FILE)));
      engine.ingest([stepOf('m1', 100_012)]);
      assert.equal(shareOf('read'), undefined);

      // The interval: lines two and four again with ten characters no line explains, and a call that matched nothing,
      // forty characters in all.
      ingest(chain.call(showing(A, FILE, [2, 4], { unmatched: { input: 0, output: 10 } })));
      ingest(chain.call({ matches: [], files: {}, unmatched: { input: 15, output: 25 }, stats: { failed: false } }, { name: 'fetch' }));
      engine.ingest([stepOf('m2', 108_012)]);
      // Nothing resident changed, so all 8000 tokens of the interval's growth are unplaced and are shared by weight: the
      // read's 30 and 10 against the other's 40. The remainder alone, 10 against 40, would have given the read 1600.
      assert.equal(shareOf('read'), 4000);
      assert.equal(shareOf('fetch'), 4000);
      assert.ok(shareOf('read') > 8000 * 10 / 50);
    });
  });
});

describe('fingerprints in a record', () => {
  const V1 = ['aaaa-001', 'bbbb-002', 'cccc-003', 'dddd-004'];
  const recordWith = fingerprintOf => ({
    v: 1,
    effects: [{
      access: 'read',
      impacts: [{
        resourceKey: A,
        kind: 'replace-fragments',
        entries: V1.map((text, index) => {
          const entry = { key: index + 1, chars: text.length, cjk: 0 };
          const value = fingerprintOf(text, index);
          if (value !== undefined) entry.fp = value;
          return entry;
        }),
      }],
    }],
    residual: null,
  });
  const UNRECOGNIZABLE = [
    ['missing', () => undefined],
    ['text', () => 'abc'],
    ['negative', () => -1],
    ['past 32 bits', () => 2 ** 32],
    ['fractional', () => 1.5],
    ['null', () => null],
  ];
  // The file after two lines were inserted above, which is what a record with fingerprints would have followed.
  const EDITED = ['new-0001', 'new-0002', ...V1];

  for (const [label, fingerprintOf] of UNRECOGNIZABLE) {
    test(`replays the facts of a record whose fingerprints are ${label}, and the next touch takes the frozen matching`, () => {
      const chain = chainOf({ recalled: new Map([['c1', recordWith(fingerprintOf)]]) });
      chain.call(undefined);
      assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2 });
      assert.equal([...chain.scratch.get(A).values()].some(entry => 'fp' in entry), false);
      const done = chain.call(showing(A, EDITED, [1]));
      assert.deepEqual(keysOfImpact(impactOf(done)), [1]);
      assert.deepEqual(tokensOf(chain.scratch, A), { 1: 2, 2: 2, 3: 2, 4: 2 });
      assertTwin(chain);
    });
  }

  test('moves the entries of the same record when its fingerprints are those of the lines', () => {
    const chain = chainOf({ recalled: new Map([['c1', recordWith(text => fp(text))]]) });
    chain.call(undefined);
    chain.call(showing(A, EDITED, [1]));
    assert.deepEqual(residencyOf(chain.scratch, A), [1, 3, 4, 5, 6]);
    assertTwin(chain);
  });

  test('records a fingerprint for the entries whose fingerprint is one: an integer from 0 to 2^32 - 1', () => {
    const chain = chainOf();
    const reply = {
      matches: [{
        resourceKey: A,
        side: 'output',
        lines: ['one', 'two', 'three', 'four', 'five'].map((text, index) => ({ line: index + 1, text, tier: 'declared' })),
      }],
      files: { [A]: [0, 4294967295, 4294967296, -1, 1.5] },
      unmatched: NONE,
      stats: { failed: false },
    };
    chain.call(reply);
    const entries = chain.records.get('c1').effects[0].impacts[0].entries;
    assert.deepEqual(entries.map(entry => 'fp' in entry), [true, true, false, false, false]);
    assert.deepEqual(entries.slice(0, 2).map(entry => entry.fp), [0, 4294967295]);
    assert.deepEqual([...chain.scratch.get(A).values()].map(entry => 'fp' in entry), [true, true, false, false, false]);
    assertTwin(chain);
  });
});

describe('against the Engine and the ledger', () => {
  const V1 = [
    'import { load } from "./load.js";',
    'import { show } from "./show.js";',
    '',
    'export function run(input) {',
    '  const rows = load(input);',
    '  if (rows.length === 0) {',
    '    return [];',
    '  }',
    '  return rows.map(show);',
    '}',
  ];
  const BANNER = ['// generated by the build', '// edit the template instead', '// regenerate with make'];
  const INSERTED = [...BANNER, ...V1];
  const TRIMMED = V1.slice(2);

  // The interpreter over the real matcher and an editable tree, a real Engine and a real ledger beside it, and a
  // scratch of the test's own. A call is fed to the Engine and to the ledger alike.
  function sessionOf(files) {
    const tree = editableTree(files);
    const rig = dshRig({ workingTree: tree.workingTree });
    const engine = makeEngine();
    const scratch = new Map();
    let ledger = createResidentLedger();
    let calls = 0;
    engine.ingest([stepOf('m0', 100_000)]);
    return {
      scratch,
      engine,
      get ledger() { return ledger; },
      edit: next => tree.set({ [F]: next.join('\n') + '\n' }),
      // A read of the lines `shown` of the file now on disk.
      read(file, shown) {
        const { use, result } = dshObservations({
          name: 'read', args: { file_path: 'src/run.js' }, text: outputOf(file, shown), callId: `call_${++calls}`,
        });
        const { pending } = rig.interpreter.interpretToolUse(use, rig.context, { scratch });
        const done = rig.interpreter.completeToolResult(pending, result, rig.context, { scratch });
        engine.ingest(done.effects.map(effect => ({ type: 'effect', ...effect })));
        for (const effect of done.effects) ledger.applyEffect(effect, { turn: 1, foldedSeq: calls });
        return done;
      },
      // The epoch boundary the Projection turns into an `epoch` record: the Engine closes its segment and the ledger
      // and the scratch start empty.
      epoch() {
        engine.ingest([{ type: 'epoch' }]);
        scratch.clear();
        ledger = createResidentLedger();
      },
    };
  }

  // The scratch is the ledger's, key by key and token by token; the Engine's row has the scratch's keys and, within
  // rounding, the sum of its tokens.
  function assertAgree(session, label) {
    assert.deepEqual(tokensOf(session.scratch, F), fragmentsOf(session.ledger, F), label);
    const row = rowOf(session.engine, F);
    const keys = [...session.scratch.get(F).keys()].sort((a, b) => a - b);
    const sum = [...session.scratch.get(F).values()].reduce((total, entry) => total + entry.tokens, 0);
    assert.deepEqual(row.lineNumbers, keys, label);
    assert.ok(Math.abs(row.tokens - sum) < 1e-9, `${label}: ${row.tokens} against ${sum}`);
  }

  // The lines of `file` whose text a call has shown, by line number.
  const seenIn = (file, seen) => file.flatMap((text, index) => (seen.has(text) ? [index + 1] : []));

  test('a file read, edited so lines are inserted above, then read in part, holds the lines seen that the file still has', () => {
    const session = sessionOf({ [F]: V1.join('\n') + '\n' });
    const seen = new Set();
    const read = (file, shown) => {
      for (const line of shown) seen.add(file[line - 1]);
      return session.read(file, shown);
    };

    read(V1, numbers(1, V1.length));
    assertAgree(session, 'the whole file');
    assert.deepEqual(residencyOf(session.scratch, F), seenIn(V1, seen));

    // Three lines are inserted above, and two lines of the file are shown, which are the third and fourth of the old.
    session.edit(INSERTED);
    read(INSERTED, [6, 7]);
    assertAgree(session, 'after an insertion above');
    assert.deepEqual(residencyOf(session.scratch, F), seenIn(INSERTED, seen));
    assert.deepEqual(residencyOf(session.scratch, F), numbers(4, 13));

    // The first five lines are deleted: of the lines seen, those of the old file from its third are left.
    session.edit(TRIMMED);
    read(TRIMMED, [1, 2]);
    assertAgree(session, 'after a deletion above');
    assert.deepEqual(residencyOf(session.scratch, F), seenIn(TRIMMED, seen));
    assert.deepEqual(residencyOf(session.scratch, F), numbers(1, 8));

    // A file that is read again as it is moves nothing.
    const again = read(TRIMMED, [5]);
    assert.deepEqual(keysOfImpact(impactOf(again)), [5]);
    assertAgree(session, 'a read of an unchanged file');
  });

  test('a read of lines read before weighs all of its text, in place or after an insertion above moved them', () => {
    const session = sessionOf({ [F]: V1.join('\n') + '\n' });
    const textOf = (file, shown) => JSON.stringify({ file_path: 'src/run.js' }).length + outputOf(file, shown).length;
    const first = session.read(V1, numbers(1, V1.length));
    // The first read grows the entries by every line it shows, so only the envelope and the input are weight.
    assert.ok(first.residuals[0].weight < textOf(V1, numbers(1, V1.length)));
    // Read again, lines four to six are in context and the entries do not grow by them: the whole text is weight.
    assert.equal(session.read(V1, [4, 5, 6]).residuals[0].weight, textOf(V1, [4, 5, 6]));
    // The same three lines are lines seven to nine once three lines are inserted above; moving their entries is not text.
    session.edit(INSERTED);
    assert.equal(session.read(INSERTED, [7, 8, 9]).residuals[0].weight, textOf(INSERTED, [7, 8, 9]));
    assertAgree(session, 'after the reads');
  });

  test('a partial read after the edit sends the moved entries once, with no key twice, and the Engine takes it', () => {
    const session = sessionOf({ [F]: V1.join('\n') + '\n' });
    session.read(V1, numbers(1, V1.length));
    session.edit(INSERTED);
    // Lines 4 to 7 of the new file are lines 1 to 4 of the old: the call's lines land on keys that entries move to.
    const done = session.read(INSERTED, [4, 5, 6, 7]);
    const keys = keysOfImpact(impactOf(done));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(impactOf(done).mutation.kind, 'merge-fragments');
    assert.deepEqual(done.telemetry.pathEvents.map(event => event.isFullRead), [0]);
    assertAgree(session, 'colliding keys');
    const row = rowOf(session.engine, F);
    assert.equal(row.fullSnapshot, true);
    assert.equal(row.readCount, 2);
  });

  test('the Engine and the scratch begin again at an epoch, and an edit does not bring back what an earlier epoch saw', () => {
    const session = sessionOf({ [F]: V1.join('\n') + '\n' });
    session.read(V1, numbers(1, V1.length));
    session.edit(INSERTED);
    session.read(INSERTED, [1]);
    assertAgree(session, 'before the boundary');
    session.epoch();
    assert.equal(rowOf(session.engine, F), undefined);
    session.read(INSERTED, [8, 9]);
    // Only the two lines read since the boundary are held: the scratch did not carry the earlier epoch's entries.
    assert.deepEqual(residencyOf(session.scratch, F), [8, 9]);
    assertAgree(session, 'after the boundary');
    session.edit(TRIMMED);
    session.read(TRIMMED, [1]);
    assert.deepEqual(residencyOf(session.scratch, F), [1, 3, 4]);
    assertAgree(session, 'an edit after the boundary');
  });
});

describe('through the Projection', () => {
  // Eight characters a line, and three more for the number a read puts before it: 2.75 tokens a line under MODEL.
  const V1 = ['one-aaaa', 'two-bbbb', 'three-cc', 'four-ddd', 'five-eee', 'six-ffff'];
  const EDITED = ['new-0001', 'new-0002', ...V1];

  test('the scratch is the epoch\'s: an edit above moves what the Engine holds, and a boundary ends it', () => {
    const tree = editableTree({ [F]: V1.join('\n') + '\n' });
    const rig = dshRig({ workingTree: tree.workingTree });
    const engine = makeEngine();
    engine.ingest([stepOf('m0', 100_000)]);
    let calls = 0;
    const read = (file, shown) => {
      const { use, result } = dshObservations({
        name: 'read', args: { file_path: 'src/run.js' }, text: outputOf(file, shown), callId: `call_${++calls}`,
      });
      engine.ingest([use, result].flatMap(observation => rig.projection.project(observation, {}).records));
    };

    read(V1, numbers(1, 6));
    assert.equal(rowOf(engine, F).tokens, 6 * 2.75);
    tree.set({ [F]: EDITED.join('\n') + '\n' });
    read(EDITED, [7, 8]);
    // The six lines moved down by two: the keys one and two are kept as empty fragments and the six lines are held once.
    assert.deepEqual(rowOf(engine, F).lineNumbers, numbers(1, 8));
    assert.equal(rowOf(engine, F).tokens, 6 * 2.75);

    engine.ingest(rig.projection.project({ type: 'epoch-boundary' }, {}).records);
    assert.equal(rowOf(engine, F), undefined);
    // The file changes again above the lines the old epoch saw, so that any entry left in the scratch would move.
    const again = ['new-0000', ...EDITED];
    tree.set({ [F]: again.join('\n') + '\n' });
    read(again, [9]);
    assert.deepEqual(rowOf(engine, F).lineNumbers, [9]);
    assert.equal(rowOf(engine, F).tokens, 2.75);
  });
});
