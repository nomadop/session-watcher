// test/dsh.fixtures.reducer.test.js — the DSH reducer over the local fixture corpus: each log reduces to the
// Observation counts, epoch seqs and tool results `scripts/dsh-fixture-expect.mjs` derived from its events
// alone, with no diagnostic. The corpus is never committed, so a case skips wherever its fixture is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { hasDshFixture, readDshFixture, expectationsOf } from './helpers/dsh-fixtures.js';

const FIXTURES = ['compaction-prune', 'plain-ask', 'subagent'];

for (const name of FIXTURES) {
  test(`the ${name} fixture reduces to the observations its events predict`, { skip: !hasDshFixture(name) }, () => {
    const { reducer } = expectationsOf(name);
    const { observations, diagnostics } = reduceDshSnapshot(readDshFixture(name).events);

    // Counted from every type the expectation names at zero, so a type it does not name fails the comparison.
    const counts = Object.fromEntries(Object.keys(reducer.observationTypes).map(type => [type, 0]));
    for (const { type } of observations) counts[type] = (counts[type] ?? 0) + 1;
    assert.deepEqual(counts, reducer.observationTypes);
    const epochs = observations.filter(observation => observation.type === 'epoch-boundary');
    assert.deepEqual(epochs.map(observation => observation.sourceOrdinal), reducer.epochSeqs);
    assert.equal(counts['tool-result'], reducer.toolResults);
    assert.equal(diagnostics.length, reducer.diagnostics, diagnostics.map(diagnostic => diagnostic.message).join('\n'));
  });
}
