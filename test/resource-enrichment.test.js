// Resource Enrichment: the only place that reads a resource's local file, loads a grammar, captures symbol
// ranges, or resolves them. Every case injects the file read and the grammar warmer, so nothing here
// depends on a wasm grammar being present — Markdown takes the regex path, which is the same code path the
// enrichment reads through for every other extension.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createResourceEnrichment } from '../lib/resource-enrichment.js';

const MARKDOWN = [
  '# Alpha',
  '',
  'alpha body line',
  '',
  '# Beta',
  '',
  'beta body line',
  '',
  '# Gamma',
  '',
  'gamma body line',
  '',
].join('\n');

function build(over = {}) {
  const warmed = [];
  const reads = [];
  const enrichment = createResourceEnrichment({
    readFile: over.readFile ?? ((absPath) => { reads.push(absPath); return MARKDOWN; }),
    warmer: over.warmer ?? ((ext) => { warmed.push(ext); }),
    loadGrammar: over.loadGrammar ?? (async () => {}),
    ...over.extra,
  });
  return { enrichment, warmed, reads };
}

describe('warm', () => {
  test('warm() passes the lowercased extension of every key to the warmer once', () => {
    const { enrichment, warmed } = build();
    assert.equal(enrichment.warm(['/repo/a.PY', '/repo/b.js', 'skill:brainstorming']), undefined);
    assert.deepEqual(warmed, ['.py', '.js', '']);
  });

  test('warm() returns synchronously and swallows warmer rejection', () => {
    // Inject a rejecting warmer; assert return === undefined and no unhandled rejection.
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { enrichment } = build({ warmer: () => Promise.reject(new Error('grammar unavailable')) });
      assert.equal(enrichment.warm(['/repo/a.py']), undefined);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(rejections, []);
  });

  test('warm() survives a warmer that throws synchronously and still reaches every later key', () => {
    const warmed = [];
    const { enrichment } = build({
      warmer: (ext) => { warmed.push(ext); if (ext === '.py') throw new Error('boom'); },
    });
    assert.equal(enrichment.warm(['/repo/a.py', '/repo/b.md']), undefined);
    assert.deepEqual(warmed, ['.py', '.md']);
  });

  test('warm() performs no resource filtering', () => {
    const { enrichment, warmed } = build();
    enrichment.warm(['/repo/vendor/x.bin', '/outside/y.py']);
    assert.deepEqual(warmed, ['.bin', '.py']);
  });
});

describe('activeSymbols', () => {
  test('line coverage selects the symbols a bucket row is actually resident in', () => {
    const { enrichment, reads } = build();
    const symbols = enrichment.activeSymbols({ path: '/repo/doc.md', lineNumbers: [6, 7], fullSnapshot: false });
    assert.deepEqual(reads, ['/repo/doc.md']);
    assert.ok(Array.isArray(symbols) && symbols.length > 0);
    assert.ok(symbols.includes('Beta'), `Beta is the resident symbol, got ${JSON.stringify(symbols)}`);
  });

  test('a full snapshot needs no bucket line numbers', () => {
    const { enrichment } = build();
    const symbols = enrichment.activeSymbols({ path: '/repo/doc.md', lineNumbers: [], fullSnapshot: true });
    assert.ok(Array.isArray(symbols) && symbols.length > 0);
  });

  test('an unreadable file yields no symbols rather than throwing', () => {
    const { enrichment } = build({ readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    assert.equal(enrichment.activeSymbols({ path: '/repo/gone.md', lineNumbers: [1], fullSnapshot: false }), null);
  });

  test('an unparseable extension is never read', () => {
    const { enrichment, reads } = build();
    assert.equal(enrichment.activeSymbols({ path: '/repo/data.bin', lineNumbers: [1], fullSnapshot: false }), null);
    assert.deepEqual(reads, [], 'a file whose grammar cannot extract is not opened');
  });
});

describe('symbolRanges', () => {
  test('range capture returns each named symbol\'s resident line ranges', () => {
    const { enrichment } = build();
    const ranges = enrichment.symbolRanges({ path: '/repo/doc.md', symbols: ['Alpha', 'Beta'], lineNumbers: [1, 2, 3, 6, 7] });
    assert.deepEqual(Object.keys(ranges).sort(), ['Alpha', 'Beta']);
    assert.ok(Array.isArray(ranges.Alpha[0]));
  });

  test('symbolRanges is synchronous', () => {
    const { enrichment } = build();
    const ranges = enrichment.symbolRanges({ path: '/repo/doc.md', symbols: ['Alpha'], lineNumbers: [1, 2] });
    assert.equal(typeof ranges.then, 'undefined');
  });

  test('the coverage it is given is the coverage it uses, and an empty one captures nothing', () => {
    // There is ONE route: the ranges are computed against the lines the caller's resource was read with. A
    // resource holding the whole file passes every line, and one holding a slice passes that slice — the file's
    // own length never stands in for either, so a file that grew after the read cannot pull in a symbol the
    // read never covered.
    const { enrichment } = build();
    const whole = enrichment.symbolRanges({
      path: '/repo/doc.md', symbols: ['Alpha', 'Beta', 'Gamma'],
      lineNumbers: MARKDOWN.split('\n').map((unused, index) => index + 1),
    });
    assert.deepEqual(Object.keys(whole).sort(), ['Alpha', 'Beta', 'Gamma']);
    const none = enrichment.symbolRanges({ path: '/repo/doc.md', symbols: ['Alpha', 'Beta', 'Gamma'], lineNumbers: [] });
    assert.deepEqual(none, null, 'an empty coverage captures no range');
  });

  test('a missing file captures no range', () => {
    const { enrichment } = build({ readFile: () => { throw new Error('gone'); } });
    assert.equal(enrichment.symbolRanges({ path: '/repo/doc.md', symbols: ['Alpha'], lineNumbers: [1] }), null);
  });

  test('an unnamed symbol set captures no range and reads no file', () => {
    const { enrichment, reads } = build();
    assert.equal(enrichment.symbolRanges({ path: '/repo/doc.md', symbols: [], lineNumbers: [1] }), null);
    assert.deepEqual(reads, []);
  });
});

describe('resolveSymbols', () => {
  test('resolution reports each stored symbol as resolved or stale', async () => {
    const { enrichment } = build();
    const facts = await enrichment.resolveSymbols({
      path: 'doc.md',
      symbolRanges: { Alpha: [[1, 3]], Vanished: [[40, 44]] },
      projectDir: '/repo',
    });
    assert.equal(facts.parsed, true);
    assert.equal(facts.readable, true);
    assert.deepEqual(facts.resolved.map(entry => entry.name), ['Alpha']);
    assert.deepEqual(facts.stale.map(entry => entry.name), ['Vanished']);
    assert.deepEqual(facts.stale[0].storedRanges, [[40, 44]]);
  });

  test('resolution awaits grammar loading before it parses', async () => {
    const order = [];
    const { enrichment } = build({
      loadGrammar: async (ext) => { order.push(`grammar:${ext}`); },
      readFile: (absPath) => { order.push(`read:${absPath}`); return MARKDOWN; },
    });
    await enrichment.resolveSymbols({ path: 'doc.md', symbolRanges: { Alpha: [[1, 3]] }, projectDir: '/repo' });
    assert.deepEqual(order, ['grammar:.md', 'read:/repo/doc.md']);
  });

  test('grammar failure leaves every stored symbol stale and unparsed', async () => {
    const { enrichment } = build({
      loadGrammar: async () => { throw new Error('wasm missing'); },
      extra: { canExtract: () => false },
    });
    const facts = await enrichment.resolveSymbols({ path: 'doc.zz', symbolRanges: { Alpha: [[1, 3]] }, projectDir: '/repo' });
    assert.equal(facts.parsed, false);
    assert.deepEqual(facts.resolved, []);
    assert.deepEqual(facts.stale.map(entry => entry.name), ['Alpha']);
  });

  test('a removed file reports unreadable with every symbol stale', async () => {
    const { enrichment } = build({ readFile: () => { throw new Error('gone'); } });
    const facts = await enrichment.resolveSymbols({ path: 'doc.md', symbolRanges: { Alpha: [[1, 3]] }, projectDir: '/repo' });
    assert.equal(facts.parsed, true);
    assert.equal(facts.readable, false);
    assert.deepEqual(facts.stale.map(entry => entry.name), ['Alpha']);
  });

  test('an absolute stored path is read as it stands', async () => {
    const { enrichment, reads } = build();
    await enrichment.resolveSymbols({ path: '/elsewhere/doc.md', symbolRanges: { Alpha: [[1, 3]] }, projectDir: '/repo' });
    assert.deepEqual(reads, ['/elsewhere/doc.md']);
  });
});
