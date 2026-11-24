// The inner compaction monitor's view, `monitor-view.js`, and its drawer contents, `monitor-drawer.js`, rendered to a string with the external-store hooks' server snapshots: the monitor store's states, the list's rows with the slot rows of the expanded attempts, and the call and slot drawers' pages.
// The details the pages show are what `createMonitorAccess` answers over logs the events helper builds, read with the checkout `SW_DSH_CHECKOUT` names; without it those cases skip.
// A server render proves the markup and the locale keys it asks for and which resource handles it reads; the effects, the clicks, the subscriptions' updates, the scroll and the drag glue are not run, so a handle's change of result and the cleanup of a subscription are for source review and the live gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { InnerCompactionView, MonitorSplit, MonitorList, MonitorDrawer, MonitorToolbar } from '../dsh/src/client/monitor-view.js';
import { SettlementDetail, PagedDetail, SETTLEMENT_PAGES, CallDetail, OverviewPage, RequestPage, ResponsePage, SummariesPage, CarriedPage, QuotePage, UsagePage, TimingPage, SlotDetail, SlotOverviewPage, SlotSummaryPage, SlotSourcePage, SlotToolsPage, SlotUsagePage,
  HandoffDetail, HandoffOverviewPage, HandoffSummaryPage, HandoffFilesPage, HandoffTurnsPage, HandoffLineagePage } from '../dsh/src/client/monitor-drawer.js';
import { en, zh } from '../dsh/src/client/locales.js';
import { SKIP_REASONS } from '../lib/llm-adapter/carrier-results.js';
import { createViewState, reduceView, flattenRows, isOpen, LEAVES_LOADING, LEAVES_FAILED, DRAWER_DEFAULT_WIDTH, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH } from '../dsh/src/client/monitor-state.js';
import { settlementsOf } from '../public/lib/compactionEconomics.js';
import { innerMonitorProjection, createMonitorAccess, PREVIEW_SOURCE_CHARS } from '../dsh/src/inner-monitor-read.js';
import { innerQuote } from '../lib/inner-seal/quote.js';
import { sourceEventView } from '../lib/harness/dsh/inner-monitor-source.js';
import { FilesView, CarriedFiles } from '../dsh/src/client/monitor-files.js';
import { carriedFilesOf, readFilesOf, createFilesState, reduceFiles } from '../dsh/src/client/monitor-files-model.js';
import { assistantMessage, compactionPrune, innerAttempt, innerCall, innerEnd, innerSealCarrier, loadMessage, loadPayload, loadReads, prunedResult, requestHeader, sessionLog, toolResult, userMessage } from './helpers/dsh-events.js';
import { attemptRow, warmed, callPayload, slotRow, slotValue, handoffRow, handoffPayload, HANDOFF_TIME } from './helpers/dsh-monitor-wire.js';

/** The translate: the key itself, followed by its parameters where there are any; `listener`, while set, hears each key asked with the names of its parameters. */
let listener = null;
const t = (key, params) => {
  listener?.(key, Object.keys(params ?? {}));
  return params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`;
};

/** A store handle at `result`, as the stores hand it: a retained result and a subscription that never calls back. */
const handleAt = result => ({ result, subscribe: () => () => {} });

/** The session's store as the stores hand it: a retained result and a subscription that never calls back; each read of either is recorded into `touched`. */
const sessionAt = (result, touched = []) => ({
  get result() { touched.push('session.result'); return result; },
  subscribe: () => { touched.push('session.subscribe'); return () => {}; },
});

/** The identity a monitor's resource handle is looked up by, as the store keys it. */
const resourceKey = ({ endpoint, attempt, handoff, slot }) => JSON.stringify([endpoint, attempt ?? handoff, slot ?? null]);

/** A monitor whose rows handle answers `rows` and whose `resources` (results by `resourceKey`) answer the details; each read of either is recorded into `touched`. */
function monitorAt(rows, resources = {}, touched = []) {
  return {
    rows: { get result() { touched.push('rows.result'); return rows; }, subscribe: () => { touched.push('rows.subscribe'); return () => {}; } },
    resource: (identity) => { touched.push(resourceKey(identity)); return handleAt(resources[resourceKey(identity)] ?? null); },
  };
}

const renderView = (monitor = monitorAt(null)) => renderToString(React.createElement(InnerCompactionView, { monitor, t }));

// ── The monitor store's states ────────────────────────────────────────────────

test('a monitor store that has answered nothing, cannot be reached, is unavailable or holds no attempts says so in a text of its own', () => {
  const cases = {
    'rows-loading': [null, 'monitor.rows.loading'],
    'rows-unavailable': [{ kind: 'unavailable' }, 'monitor.rows.unavailable'],
    'rows-unreachable': [{ kind: 'unreachable', message: 'HTTP 502' }, 'monitor.rows.unreachable(message=HTTP 502)'],
    'rows-empty': [{ kind: 'ready', attempts: [], handoffs: [] }, 'monitor.rows.empty'],
  };
  for (const [marker, [rows, text]] of Object.entries(cases)) {
    const html = renderView(monitorAt(rows));
    assert.ok(html.includes(text), `${marker}: ${html}`);
    assert.match(html, new RegExp(`data-sw-monitor-notice="${marker}"`), marker);
    assert.equal(html.includes('<table'), false, marker);
    assert.match(html, /role="toolbar"/);
    assert.match(html, /<button[^>]+>monitor\.toolbar\.currentSettlement<\/button>/);
    assert.equal(html.includes('monitor.filter.category'), false, `${marker}: no filters over rows that are none`);
  }
});

// ── The list ──────────────────────────────────────────────────────────────────

// An attempt committed, one failed with a reason and one still generating, as the host's rows give them.
const committed = attemptRow(1, { stepN: 8, trigger: { q: 1.0377949146956498, kappa: 1.1284536821382138 } });
const failed = attemptRow(2, { status: 'failed', reason: 'the response has no finish chunk', slots: null, endedAt: 1_802 });
const running = attemptRow(3, { status: 'generating', endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null } });
const NOW = 3_503;

const textOf = html => html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The rows of rendered list markup: each row's attributes by name, the text of its parts by `data-part` (absent where the row has no such part) and its preview markup. */
function parseRows(html) {
  return html.split(/(?=<div\b[^>]*class="sw-mon-row")/).slice(1)
    .map((chunk) => {
      const attributes = Object.fromEntries([...(/^<div\b([^>]*)>/.exec(chunk)?.[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      const parts = Object.fromEntries([...chunk.matchAll(/<span\b[^>]*data-part="(\w+)"[^>]*>([^<]*)<\/span>/g)].map(([, part, content]) => [part, textOf(content)]));
      const titles = Object.fromEntries([...chunk.matchAll(/<span\b([^>]*)data-part="(\w+)"([^>]*)>/g)].map(([, before, part, after]) => [part, `${before}${after}`]));
      return { attributes, parts, titles, markup: chunk, preview: /<div\b[^>]*class="sw-mon-preview"[^>]*>.*?<\/div>/s.exec(chunk)?.[0] };
    })
    .filter(row => row.attributes['data-identity'] !== undefined);
}

/** The input and response previews of a row, the response null where the row shows none. */
function previewsOf(row) {
  const side = name => new RegExp(`<span class="sw-mon-${name}[^"]*"[^>]*>(.*?)</span>`).exec(row.preview)?.[1];
  return { input: textOf(side('in') ?? ''), output: side('out') === undefined ? null : textOf(side('out')) };
}

/** A view state with the groups of the attempts `ids` opened, which a group is not by default. */
const opening = (...ids) => ids.reduce((state, attemptId) => reduceView(state, { type: 'toggle', attemptId, open: false }), createViewState());

function renderList(attempts, { slots = {}, state = createViewState(), now = NOW } = {}) {
  return renderToString(React.createElement(MonitorList, {
    rows: flattenRows(attempts, slots, state), selected: state.selected?.identity ?? null, now, dispatch: () => {}, t,
  }));
}

test('the list is a tree of rows with no table, header or column: a parent row per attempt in the host\'s order with its level and expansion, every group closed to begin with, and under an opened attempt its call row, which is no parent', () => {
  const closed = parseRows(renderList([committed, failed, running]));
  assert.deepEqual(closed.map(row => row.attributes['data-identity']), ['attempt:1', 'attempt:2', 'attempt:3'], 'no group is open by default, the latest included');
  assert.deepEqual(closed.map(row => row.attributes['aria-expanded']), ['false', 'false', 'false']);

  const html = renderList([committed, failed, running], { state: reduceView(createViewState(), { type: 'toggle', attemptId: 3, open: false }) });
  const rows = parseRows(html);

  assert.match(html, /^<div\b[^>]*role="tree"/);
  for (const tag of ['<table', '<thead', '<th', '<td', '<tr', 'data-col=']) assert.equal(html.includes(tag), false, tag);
  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['attempt:1', 'attempt:2', 'attempt:3', 'call:3']);
  assert.deepEqual(rows.map(row => row.attributes['data-sw-row']), ['attempt', 'attempt', 'attempt', 'call']);
  assert.deepEqual(rows.map(row => row.attributes.role), ['treeitem', 'treeitem', 'treeitem', 'treeitem']);
  assert.deepEqual(rows.map(row => row.attributes['aria-level']), ['1', '1', '1', '2']);
  assert.deepEqual(rows.map(row => row.attributes['aria-expanded']), ['false', 'false', 'true', undefined]);
  assert.deepEqual([...html.matchAll(/<button\b[^>]*aria-expanded="(\w+)"/g)].map(match => match[1]), ['false', 'false', 'true'], 'each parent row\'s toggle repeats its expansion');
  assert.deepEqual(rows.map(row => row.parts.title), ['monitor.object.attempt(epoch=1,ordinal=1)', 'monitor.object.attempt(epoch=1,ordinal=2)', 'monitor.object.attempt(epoch=1,ordinal=3)', 'monitor.object.call']);
});

test('a parent row is titled by its display ordinal and carries its seq as meta, whatever the seq: the seqs of the attempts are not consecutive and the title never reads one', () => {
  const sparse = [attemptRow(31), attemptRow(207), attemptRow(1_900)];
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 31, open: false });

  const rows = parseRows(renderList(sparse, { state }));

  assert.deepEqual(rows.filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.title), [
    'monitor.object.attempt(epoch=1,ordinal=1)', 'monitor.object.attempt(epoch=1,ordinal=2)', 'monitor.object.attempt(epoch=1,ordinal=3)',
  ]);
  assert.deepEqual(rows.filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.seq), [
    'monitor.overview.seq(seq=31)', 'monitor.overview.seq(seq=207)', 'monitor.overview.seq(seq=1900)',
  ], 'the seq is the parent row\'s own value');
  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['attempt:31', 'call:31', 'attempt:207', 'attempt:1900'], 'the identities keep the seqs');
  const folded = parseRows(renderList(sparse, { state: reduceView(state, { type: 'toggle', attemptId: 31, open: true }) }));
  assert.deepEqual(folded.filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.title), rows.filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.title), 'folding renumbers nothing');
});

test('an opened committed attempt lists its call row and a slot row per loaded slot in source order below its parent, the selected identity alone is marked selected, and a parent row never is', () => {
  const slots = { 1: [slotRow(10), slotRow(20, { turn: null, step: null, source: { type: 'user/message', kind: 'user', category: 'user' } }), slotRow(30, { turn: 2, step: null })] };
  let state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  state = reduceView(state, { type: 'select', kind: 'slot', attemptId: 1, slotKey: 20 });

  const rows = parseRows(renderList([committed, failed, running], { slots, state }));

  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['attempt:1', 'call:1', 'slot:1:10', 'slot:1:20', 'slot:1:30', 'attempt:2', 'attempt:3']);
  assert.deepEqual(rows.map(row => row.attributes['aria-level']), ['1', '2', '2', '2', '2', '1', '1']);
  assert.deepEqual(rows.map(row => row.attributes['aria-selected']), [undefined, 'false', 'false', 'true', 'false', undefined, undefined]);
  assert.deepEqual(rows.map(row => row.attributes['aria-expanded']), ['true', undefined, undefined, undefined, undefined, 'false', 'false']);
  assert.deepEqual(rows.map(row => row.attributes.tabindex), [undefined, '0', '0', '0', '0', undefined, undefined], 'the rows that select can take focus');
  assert.deepEqual(rows.slice(2, 5).map(row => row.parts.title), [
    'monitor.object.turn(turn=1) · monitor.object.step(step=1)', 'monitor.source.user', 'monitor.object.turn(turn=2)',
  ], 'a slot row names its turn and step, and the category of its source where it has neither');
  for (const row of rows.slice(2, 5)) assert.equal(row.markup.includes('monitor.object.slot'), false, 'no slot label, ordinal or seq in the list');
});

test('a parent row carries its status, its own time, its step count, its estimate outcome and the usage of its call, with its seq, as meta beside the title, and a call or slot row carries none of them', () => {
  const slots = { 1: [slotRow(10)] };
  const state = [1, 3].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: false }), createViewState());

  const byIdentity = Object.fromEntries(parseRows(renderList([committed, failed, running], { slots, state, now: NOW })).map(row => [row.attributes['data-identity'], row]));

  assert.deepEqual(
    [byIdentity['attempt:1'].parts.status, byIdentity['attempt:1'].parts.time, byIdentity['attempt:1'].parts.step, byIdentity['attempt:1'].parts.usage, byIdentity['attempt:1'].parts.seq],
    ['monitor.status.committed', '900 ms', 'monitor.meta.step(count=8)', 'monitor.usage.cell(output=600)', 'monitor.overview.seq(seq=1)'],
  );
  assert.match(byIdentity['attempt:1'].titles.step, /title="monitor\.meta\.step\.title"/);
  assert.deepEqual([byIdentity['attempt:2'].parts.step, byIdentity['attempt:3'].parts.step], ['—', '—'], 'a dash where the attempt was recorded without a step count');
  assert.equal(byIdentity['attempt:1'].parts.estimate, 'monitor.meta.estimate(q=1.04)');
  assert.match(byIdentity['attempt:1'].titles.estimate, /title="monitor\.meta\.estimate\.kappa\.title\(kappa=1\.13\)"/);
  assert.deepEqual([byIdentity['attempt:2'].parts.estimate, byIdentity['attempt:3'].parts.estimate], ['—', '—'], 'a dash where the attempt was recorded without a quote');
  assert.match(byIdentity['attempt:1'].markup, /data-status="committed"/);
  assert.match(byIdentity['attempt:1'].titles.usage, /title="monitor\.usage\.title\(output=600,cacheRead=400,cacheWrite=20\)"/, 'the output and the cache usage are on the item as its title, the input is shown nowhere on the row');
  assert.match(byIdentity['attempt:1'].titles.time, /title="monitor\.meta\.time"/);
  assert.equal(byIdentity['attempt:2'].parts.status, 'monitor.status.failed');
  assert.equal(byIdentity['attempt:2'].parts.time, '800 ms');
  assert.deepEqual(
    [byIdentity['attempt:3'].parts.status, byIdentity['attempt:3'].parts.time, byIdentity['attempt:3'].parts.usage],
    ['monitor.status.generating', '2.5 s', '—'],
    'a running attempt reads the clock handed in, and has no usage yet',
  );
  for (const identity of ['call:3', 'slot:1:10']) {
    for (const part of ['status', 'time', 'step', 'estimate', 'usage', 'range', 'miss', 'context', 'seq']) assert.equal(byIdentity[identity].parts[part], undefined, `${identity} repeats no ${part}`);
    assert.equal(byIdentity[identity].markup.includes('sw-mon-status'), false, identity);
  }
});

test('a parent row keeps its step and estimate slots whatever its quote says, neither a warning: the step count, the deviation or a dash, the row is marked for neither, and the status keeps its own mark', () => {
  // A context that shrank and a rebuild within the tolerance of its growth, so that the context and cache rebuild slots warn of nothing and the quote's readings are the only candidates for a mark.
  const shrunk = { contextChange: { before: 460, after: 410, delta: -50, miss: 4 } };
  const rows = [
    attemptRow(1, { ...shrunk, stepN: 8, trigger: { q: 1.0377949146956498, kappa: 1.1284536821382138 } }),
    attemptRow(2, { ...shrunk, stepN: 12, trigger: { q: 2.5, kappa: 1.4 } }),
    attemptRow(3, { ...shrunk, status: 'failed', reason: 'refused', slots: null, stepN: 24, trigger: { q: null, kappa: 1.1 } }),
    attemptRow(4, { ...shrunk, status: 'cancelled', reason: 'user', slots: null, stepN: 24, trigger: { q: 3.2, kappa: null } }),
    attemptRow(5, shrunk),
  ];
  const parents = parseRows(renderList(rows)).filter(row => row.attributes['data-sw-row'] === 'attempt');

  assert.deepEqual(parents.map(row => row.attributes['data-sw-attention']), [undefined, undefined, undefined, undefined, undefined], 'no row is marked');
  assert.deepEqual(parents.map(row => /data-sw-attention/.test(row.titles.step) || /data-sw-attention/.test(row.titles.estimate)), [false, false, false, false, false], 'no slot is');
  assert.deepEqual(parents.map(row => row.parts.step), [
    'monitor.meta.step(count=8)', 'monitor.meta.step(count=12)', 'monitor.meta.step(count=24)', 'monitor.meta.step(count=24)', '—',
  ]);
  assert.deepEqual(parents.map(row => row.parts.estimate), [
    'monitor.meta.estimate(q=1.04)', 'monitor.meta.estimate(q=2.50)', '—', 'monitor.meta.estimate(q=3.20)', '—',
  ], 'a deviation above the tolerance reads as any other');
  assert.match(parents[0].titles.estimate, /title="monitor\.meta\.estimate\.kappa\.title\(kappa=1\.13\)"/);
  assert.match(parents[2].titles.estimate, /title="monitor\.meta\.estimate\.kappa\.title\(kappa=1\.10\)"/, 'a record with a tolerance and no deviation keeps the tolerance in the title');
  assert.match(parents[3].titles.estimate, /title="monitor\.meta\.estimate\.title"/);
  assert.match(parents[4].titles.estimate, /title="monitor\.meta\.estimate\.title"/);
  assert.match(parents[3].titles.step, /title="monitor\.meta\.step\.title"/);
  assert.deepEqual(parents.map(row => row.parts.status), ['monitor.status.committed', 'monitor.status.committed', 'monitor.status.failed', 'monitor.status.cancelled', 'monitor.status.committed']);
  assert.match(parents[2].markup, /data-status="failed"/);
  assert.match(parents[3].markup, /data-status="cancelled"/);
});

test('a parent row says in words what the seal did to the context, and a dash where the host sent none, the seal did not commit or a main call is missing; a decrease, an increase and no change never show a sign', () => {
  const cases = [
    [attemptRow(1, { contextChange: { before: 460, after: 710, delta: 250, miss: 510 } }), 'monitor.change.increase(count=250)'],
    [attemptRow(2, { contextChange: { before: 460, after: 410, delta: -50, miss: 210 } }), 'monitor.change.decrease(count=50)'],
    [attemptRow(3, { contextChange: { before: 460, after: 460, delta: 0, miss: 0 } }), 'monitor.change.same'],
    [attemptRow(4, { contextChange: { before: null, after: 710, delta: null, miss: 710 } }), '—'],
    [attemptRow(5, { status: 'failed', reason: 'x', slots: null, contextChange: null }), '—'],
    [attemptRow(6, { contextChange: undefined }), '—'],
  ];
  const state = [1, 2, 3, 4, 5, 6].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: true }), createViewState());
  const rows = parseRows(renderList(cases.map(([row]) => row), { state }));
  assert.deepEqual(rows.map(row => row.parts.context), cases.map(([, text]) => text));
  assert.match(rows[0].titles.context, /title="monitor\.meta\.context\.grew"/, 'a context that grew says why it is marked');
  assert.match(rows[1].titles.context, /title="monitor\.meta\.context"/);
  assert.deepEqual(rows.map(row => row.parts.range), [
    'monitor.meta.range(before=460,after=710)', 'monitor.meta.range(before=460,after=410)', 'monitor.meta.range(before=460,after=460)',
    'monitor.meta.range(before=—,after=710)', '—', '—',
  ], 'the tokens before and after stand beside the words, a dash for each that is missing and for a row with no change');
  assert.deepEqual(rows.map(row => row.parts.miss), [
    'monitor.meta.miss(count=510)', 'monitor.meta.miss(count=210)', 'monitor.meta.miss(count=0)', 'monitor.meta.miss(count=710)', '—', '—',
  ], 'the tokens the first call after the seal rebuilt in the cache, a dash where the row has none');
  assert.match(rows[0].titles.miss, /title="monitor\.meta\.miss\.title"/);
});

test('a parent row marks a context that grew and a cache rebuild beyond the context\'s growth, each in its own slot and with a title that gives the reason, and marks the row for either', () => {
  const rebuilt = (id, after, miss, overrides = {}) => warmed(attemptRow(id, { contextChange: { before: after + 1_000, after, delta: -1_000, miss }, epoch: 0, ...overrides }));
  const rows = [
    rebuilt(1, 10_000, 0),
    rebuilt(2, 12_000, 9_000),
    rebuilt(3, 13_000, 1_004),
    rebuilt(4, 15_000, 1_000, { contextChange: { before: 13_000, after: 15_000, delta: 2_000, miss: 1_000 } }),
    rebuilt(5, 16_000, 9_000, { contextChange: { before: 14_000, after: 16_000, delta: 2_000, miss: 9_000 } }),
  ];
  const parents = parseRows(renderList(rows)).filter(row => row.attributes['data-sw-row'] === 'attempt');
  const marked = row => ['context', 'miss'].filter(part => /data-sw-attention/.test(row.titles[part]));

  assert.deepEqual(parents.map(marked), [[], ['miss'], [], ['context'], ['context', 'miss']], 'each slot on its own');
  assert.deepEqual(parents.map(row => row.attributes['data-sw-attention']), [undefined, '', undefined, '', ''], 'the row is marked for either');
  assert.match(parents[1].titles.miss, /title="monitor\.meta\.miss\.unexpected"/);
  assert.match(parents[2].titles.miss, /title="monitor\.meta\.miss\.title"/);
  assert.match(parents[3].titles.context, /title="monitor\.meta\.context\.grew"/);
  assert.deepEqual(parents.map(row => row.parts.miss), [
    'monitor.meta.miss(count=0)', 'monitor.meta.miss(count=9000)', 'monitor.meta.miss(count=1004)', 'monitor.meta.miss(count=1000)', 'monitor.meta.miss(count=9000)',
  ], 'the text of a marked slot is the one it has unmarked');
});

test('a cold summary call marks its call row with a tooltip and the parent row by attention alone, changing no text of the parent, and leaves the warnings above it', () => {
  const shrunk = { before: 460, after: 410, delta: -50, miss: 0 };
  const cold = attemptRow(1, { contextChange: shrunk, call: { usage: { input: 120, output: 600, cacheRead: 100, cacheWrite: 20 } } });
  const grown = attemptRow(2, { contextChange: { before: 460, after: 710, delta: 250, miss: 510 }, call: { usage: { input: 120, output: 600, cacheRead: 100, cacheWrite: 20 } } });
  const state = [1, 2, 3].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: false }), createViewState());
  const rows = parseRows(renderList([cold, grown, attemptRow(3, { contextChange: shrunk, epoch: 2 })], { state }));
  const by = Object.fromEntries(rows.map(row => [row.attributes['data-identity'], row]));

  assert.equal(by['attempt:1'].attributes['data-sw-attention'], '', 'the parent carries the signal');
  assert.equal(by['attempt:3'].attributes['data-sw-attention'], undefined);
  assert.equal(by['call:1'].attributes['data-sw-attention'], '');
  assert.equal(by['call:1'].attributes['aria-description'], 'monitor.meta.call.cold');
  assert.equal(by['call:3'].attributes['data-sw-attention'], undefined);
  assert.equal(by['call:2'].attributes['aria-description'], ['monitor.meta.context.grew', 'monitor.meta.miss.unexpected', 'monitor.meta.call.cold'].join(' · '), 'the call row lists the warnings together');
  assert.match(by['attempt:1'].titles.usage, /title="monitor\.usage\.title\(output=600,cacheRead=100,cacheWrite=20\)"/, 'the title of the usage slot is the one it has unwarned');
  assert.equal(by['attempt:1'].parts.usage, 'monitor.usage.cell(output=600)');
});

test('a parent row with warned slots draws the badge inside its step slot, titled and labelled as an image, and a row without them draws none', () => {
  const warned = attemptRow(1, { stepN: 8, slotWarnings: { 40: ['state-check'], 45: ['state-write'] } });
  const rows = parseRows(renderList([warned, attemptRow(2, { stepN: 8 })]));
  const badge = /<span\b[^>]*class="sw-mon-badge"[^>]*>([^<]*)<\/span>/.exec(rows[0].markup);
  assert.equal(badge[1], '2');
  assert.match(badge[0], /title="monitor\.meta\.step\.badge\(count=2,total=8\)"/);
  assert.match(badge[0], /aria-label="monitor\.meta\.step\.badge\(count=2,total=8\)"/);
  assert.match(badge[0], /role="img"/);
  assert.match(rows[0].markup, /<span\b[^>]*data-part="step"[^>]*>monitor\.meta\.step\(count=8\)<span\b[^>]*class="sw-mon-badge"/, 'the badge is the step slot\'s own child');
  assert.equal(rows[1].markup.includes('sw-mon-badge'), false);
});

test('a short summary marks its call row with a tooltip and the parent row by attention alone, changing no text of the parent', () => {
  const usage = output => ({ input: 120, output, cacheRead: 400, cacheWrite: 20 });
  const shrunk = { before: 460, after: 410, delta: -50, miss: 0 };
  const state = [1, 2].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: false }), createViewState());
  const rows = parseRows(renderList([attemptRow(1, { contextChange: shrunk, call: { usage: usage(80) } }), attemptRow(2, { contextChange: shrunk, epoch: 2 })], { state }));
  const by = Object.fromEntries(rows.map(row => [row.attributes['data-identity'], row]));
  assert.equal(by['attempt:1'].attributes['data-sw-attention'], '');
  assert.equal(by['attempt:2'].attributes['data-sw-attention'], undefined);
  assert.equal(by['call:1'].attributes['data-sw-attention'], '');
  assert.equal(by['call:1'].attributes['aria-description'], 'monitor.meta.call.short');
  assert.equal(by['call:2'].attributes['data-sw-attention'], undefined);
  assert.equal(by['attempt:1'].parts.usage, 'monitor.usage.cell(output=80)');
  assert.match(by['attempt:1'].titles.usage, /title="monitor\.usage\.title\(output=80,cacheRead=400,cacheWrite=20\)"/);
});

test('in each locale the change reads as words: decreased by, increased by and unchanged', () => {
  const state = [1, 2, 3].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: true }), createViewState());
  const attempts = [
    attemptRow(1, { contextChange: { before: 460, after: 460, delta: 0 } }),
    attemptRow(2, { contextChange: { before: 460, after: 410, delta: -50 } }),
    attemptRow(3, { contextChange: { before: 460, after: 710, delta: 250 } }),
  ];
  for (const [dictionary, expected, range] of [
    [zh, ['不变', '减少 50', '增加 250'], '压缩前 460 · 压缩后 410'],
    [en, ['Unchanged', 'Decreased by 50', 'Increased by 250'], 'Before 460 · After 410'],
  ]) {
    const html = renderToString(React.createElement(MonitorList, { rows: flattenRows(attempts, {}, state), selected: null, now: NOW, dispatch: () => {}, t: localized(dictionary) }));
    assert.deepEqual(parseRows(html).map(row => row.parts.context), expected);
    assert.equal(parseRows(html)[1].parts.range, range);
  }
});

test('in each locale a parent row words its step count, its estimate\'s deviation and its cache rebuild, with their tooltips', () => {
  const attempts = [
    attemptRow(1, { stepN: 8, trigger: { q: 1.0377949146956498, kappa: 1.1284536821382138 } }),
    attemptRow(2, { stepN: 12, trigger: { q: 2.5, kappa: null }, contextChange: null }),
    attemptRow(3, { stepN: 24, trigger: { q: null, kappa: 1.1 } }),
    attemptRow(4, { stepN: null, trigger: null }),
  ];
  const state = [1, 2, 3, 4].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: true }), createViewState());
  for (const [dictionary, steps, estimates, kappaTitles, miss] of [
    [zh, ['步数 8', '步数 12', '步数 24', '—'], ['偏离度 1.04', '偏离度 2.50', '—', '—'], ['估算相对参考的偏离度；提前触发容差 1.13', '估算相对参考的偏离度；提前触发容差 1.10'], '缓存重建 510'],
    [en, ['Steps 8', 'Steps 12', 'Steps 24', '—'], ['Deviation 1.04', 'Deviation 2.50', '—', '—'], ['Deviation of the estimate from its reference; early-trigger tolerance 1.13', 'Deviation of the estimate from its reference; early-trigger tolerance 1.10'], 'Cache rebuild 510'],
  ]) {
    const html = renderToString(React.createElement(MonitorList, { rows: flattenRows(attempts, {}, state), selected: null, now: NOW, dispatch: () => {}, t: localized(dictionary) }));
    const rows = parseRows(html);
    assert.deepEqual(rows.map(row => row.parts.step), steps);
    assert.deepEqual(rows.map(row => row.parts.estimate), estimates);
    assert.equal(rows[0].parts.miss, miss);
    assert.match(rows[0].titles.step, new RegExp(`title="${dictionary['monitor.meta.step.title']}"`));
    assert.match(rows[0].titles.estimate, new RegExp(`title="${kappaTitles[0]}"`));
    assert.match(rows[2].titles.estimate, new RegExp(`title="${kappaTitles[1]}"`));
    assert.match(rows[1].titles.estimate, new RegExp(`title="${dictionary['monitor.meta.estimate.title']}"`));
    assert.match(rows[0].titles.miss, new RegExp(`title="${dictionary['monitor.meta.miss.title']}"`));
  }
  assert.equal(zh['monitor.meta.estimate.title'], '估算相对参考的偏离度');
  assert.equal(en['monitor.meta.estimate.title'], 'Deviation of the estimate from its reference');
});

test('in each locale the usage page counts carry the literal token once, over labels that name no unit, and an unchanged context shows no number', () => {
  const pageOf = (dictionary, row) => factsOf(sectionOf(renderToString(React.createElement(UsagePage, { detail: callPayload(row, { usage: { folded: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, raw: null } }), now: NOW, t: localized(dictionary) })), 'folded'));
  const contextOf = (dictionary, row) => factsOf(sectionOf(renderToString(React.createElement(UsagePage, { detail: callPayload(row), now: NOW, t: localized(dictionary) })), 'context'));
  const change = delta => attemptRow(1, { contextChange: { before: 460, after: 460 + delta, delta, miss: 7 } });
  assert.deepEqual(pageOf(zh, change(0)), [['输入', '1 token'], ['输出', '2 token'], ['缓存读', '3 token'], ['缓存写', '0 token']]);
  assert.deepEqual(pageOf(en, change(0)), [['Input', '1 token'], ['Output', '2 token'], ['Cache read', '3 token'], ['Cache write', '0 token']]);
  assert.deepEqual(contextOf(zh, change(-50)), [['压缩前', '460 token'], ['压缩后', '410 token'], ['上下文变化', '减少 50 token'], ['缓存重建', '7 token']]);
  assert.deepEqual(contextOf(en, change(250)).at(-2), ['Context change', 'Increased by 250 token']);
  assert.deepEqual(contextOf(en, change(250)).at(-1), ['Cache rebuild', '7 token']);
  assert.deepEqual(contextOf(en, change(0)).at(-2), ['Context change', 'Unchanged']);
  assert.deepEqual(contextOf(en, attemptRow(2, { contextChange: { before: null, after: null, delta: null, miss: null } })).map(([, value]) => value), ['—', '—', '—', '—']);
});

test('a slot row previews its source and its C string with an arrow between, and a failed parent that is folded previews its reason', () => {
  const slots = { 1: [slotRow(10, { input: 'the source', output: 'the note' })] };
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const byIdentity = Object.fromEntries(parseRows(renderList([committed, failed, running], { slots, state })).map(row => [row.attributes['data-identity'], row]));

  assert.deepEqual(previewsOf(byIdentity['slot:1:10']), { input: 'the source', output: 'the note' });
  assert.match(byIdentity['slot:1:10'].preview, /title="the source → the note"/);
  assert.equal(byIdentity['slot:1:10'].preview.includes('sw-mon-arrow'), true);
  assert.deepEqual(previewsOf(byIdentity['attempt:2']), { input: '', output: 'the response has no finish chunk' });
});

test('the list renders the unwrapped response on the folded parent and the call row alone, the source display on a slot row and its C string as it is, and an open parent repeats no preview', () => {
  const unwrapped = attemptRow(1, { call: { output: '["alpha","beta"]', outputDisplay: 'alpha\nbeta' } });
  const slots = { 1: [slotRow(10, { input: 'read {"file_path":"a.js"}', inputDisplay: 'read', output: '["C","text"]' })] };
  const byIdentity = rows => Object.fromEntries(parseRows(rows).map(row => [row.attributes['data-identity'], row]));

  const closed = byIdentity(renderList([unwrapped], { slots, state: createViewState() }));
  const open = byIdentity(renderList([unwrapped], { slots, state: reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false }) }));

  assert.deepEqual(previewsOf(closed['attempt:1']), { input: '', output: 'alpha beta' });
  assert.equal(open['attempt:1'].preview, undefined, 'an open parent shows no preview');
  assert.deepEqual(previewsOf(open['call:1']), { input: '', output: 'alpha beta' });
  assert.deepEqual(previewsOf(open['slot:1:10']), { input: 'read', output: '["C","text"]' });
  assert.match(open['slot:1:10'].preview, /title="read → \[&quot;C&quot;,&quot;text&quot;\]"/);
});

test('a slot whose C string is empty shows the neutral empty marker in its response place, while a C string of whitespace alone, a call response with no text and a missing response show none', () => {
  const slots = { 1: [slotRow(10, { output: '' }), slotRow(20, { output: '   ' }), slotRow(30, { output: 'a note' })] };
  const state = [1, 3].reduce((view, attemptId) => reduceView(view, { type: 'toggle', attemptId, open: false }), createViewState());
  const textless = attemptRow(1, { call: { output: '' } });
  const byIdentity = Object.fromEntries(parseRows(renderList([textless, running], { slots, state })).map(row => [row.attributes['data-identity'], row]));

  assert.deepEqual(previewsOf(byIdentity['slot:1:10']), { input: 'the source events the call saw', output: 'monitor.slot.empty' });
  assert.match(byIdentity['slot:1:10'].preview, /data-sw-empty/);
  assert.deepEqual(previewsOf(byIdentity['slot:1:20']).output, '');
  assert.equal(byIdentity['slot:1:20'].preview.includes('data-sw-empty'), false, 'a whitespace C string is no empty one');
  assert.equal(byIdentity['slot:1:30'].preview.includes('data-sw-empty'), false);
  assert.equal(byIdentity['call:1'].preview, undefined, 'a response with no text is not an empty C string and shows no preview');
  assert.equal(byIdentity['attempt:3'].preview, undefined);
  assert.equal(byIdentity['call:3'].preview, undefined, 'a missing response is shown by no marker');
});

test('a parent row previews its call\'s response only while it is folded, the call row previews the response alone, and neither carries the input in text or in a hover title; no response, no preview line', () => {
  const noResponse = attemptRow(4, { status: 'generating', endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null } });
  const attempts = [committed, failed, noResponse];
  const folded = createViewState();

  const byIdentity = Object.fromEntries(parseRows(renderList(attempts, { state: reduceView(folded, { type: 'toggle', attemptId: 4, open: false }) })).map(row => [row.attributes['data-identity'], row]));
  const opened = Object.fromEntries(parseRows(renderList(attempts, { state: reduceView(folded, { type: 'toggle', attemptId: 1, open: false }) })).map(row => [row.attributes['data-identity'], row]));

  assert.deepEqual(previewsOf(byIdentity['attempt:1']), { input: '', output: '["note one","note two"]' }, 'a folded parent shows the response');
  assert.deepEqual(previewsOf(byIdentity['attempt:2']), { input: '', output: 'the response has no finish chunk' }, 'a folded failed parent shows the reason');
  assert.equal(byIdentity['attempt:4'].preview, undefined, 'an open parent shows no preview, and without a response its call row shows none either');
  assert.equal(byIdentity['call:4'].preview, undefined, 'no response, no preview line');
  assert.equal(opened['attempt:1'].preview, undefined, 'an unfolded parent shows no preview');
  assert.deepEqual(previewsOf(opened['call:1']), { input: '', output: '["note one","note two"]' }, 'its call row carries the response');
  for (const row of [byIdentity['attempt:1'], opened['call:1']]) {
    assert.equal(row.markup.includes('summarize the history'), false, `${row.attributes['data-identity']} shows no input anywhere`);
    assert.equal(row.preview.includes('sw-mon-in'), false);
    assert.equal(row.preview.includes('sw-mon-arrow'), false);
    assert.match(row.preview, /title="\[&quot;note one&quot;,&quot;note two&quot;\]"/, 'the hover title is the response');
  }
});

test('a slot row without a turn and step is named by the category of its recorded source, a turn or step still naming it first, and a source a host does not send or files under other reads as other content', () => {
  const slots = { 1: [
    slotRow(10),
    slotRow(20, { turn: null, step: null, source: { type: 'user/message', kind: 'user', category: 'user' } }),
    slotRow(30, { turn: null, step: null, source: { type: 'user/message', kind: 'runtime-context', category: 'injected' } }),
    slotRow(40, { turn: null, step: null, source: { type: 'system/message', kind: 'system-prompt', category: 'system' } }),
    slotRow(50, { turn: null, step: null, source: { type: 'developer/message', kind: 'user', category: 'developer' } }),
    slotRow(60, { turn: null, step: null, source: { type: 'tool/result', kind: 'tool', category: 'tool' } }),
    slotRow(70, { turn: null, step: null, source: { type: 'user/message', kind: null, category: 'other' } }),
    slotRow(80, { turn: null, step: null, source: undefined }),
    slotRow(90, { turn: 2, step: null, source: { type: 'user/message', kind: 'user', category: 'user' } }),
  ] };
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });

  const rows = parseRows(renderList([committed], { slots, state })).filter(row => row.attributes['data-sw-row'] === 'slot');

  assert.deepEqual(rows.map(row => row.parts.title), [
    'monitor.object.turn(turn=1) · monitor.object.step(step=1)', 'monitor.source.user', 'monitor.source.injected', 'monitor.source.system', 'monitor.source.developer',
    'monitor.source.tool', 'monitor.source.other', 'monitor.source.other', 'monitor.object.turn(turn=2)',
  ]);
  for (const row of rows) assert.equal(row.markup.includes('monitor.object.slot'), false, 'no slot label, ordinal or seq');
});

test('an attempt with no terminal evidence and one whose call was never recorded render without throwing, their missing times and usage shown as a dash', () => {
  const unknown = attemptRow(5, { status: 'unknown', endedAt: null, slots: null, call: { state: 'absent', endedAt: null, finish: null, thrown: null, output: null, usage: null } });
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 5, open: true });

  const byIdentity = Object.fromEntries(parseRows(renderList([unknown], { state })).map(row => [row.attributes['data-identity'], row]));

  assert.deepEqual(Object.keys(byIdentity), ['attempt:5']);
  assert.deepEqual([byIdentity['attempt:5'].parts.status, byIdentity['attempt:5'].parts.time, byIdentity['attempt:5'].parts.usage], ['monitor.status.unknown', '—', '—']);
  assert.equal(byIdentity['attempt:5'].preview, undefined, 'a call that was never recorded has no text to preview');
});

// ── The details the host's producers answer ───────────────────────────────────

// The detail fixtures are what `createMonitorAccess` answers over logs built with the events helper, read with the checkout's own record and stream readers, so they have the shapes the host sends; without the checkout the cases that need them skip.
const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const LIBS = { session: 'packages/core/session/lib/index.js', llm: 'packages/llm/llm/lib/index.js' };
const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : Object.values(LIBS).find(path => !existsSync(join(CHECKOUT, path)))?.replace(/^/, 'SW_DSH_CHECKOUT names no ') ?? false;
const [sessionPackage, llmPackage] = skip ? [] : await Promise.all(Object.values(LIBS).map(path => import(pathToFileURL(join(CHECKOUT, path)).href)));
const kit = skip ? null : {
  pluginRecordOf: sessionPackage.pluginRecordOf, assembleAssistantStream: llmPackage.assembleAssistantStream, lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
};
const projection = skip ? null : innerMonitorProjection(kit);

const SESSION = 's-detail';
const PROMPT = 'Write concise continuity notes for the listed parts of this ongoing task.';
const CALL_SPAN_MS = 2_500;
const STREAM_T0 = 1_700_000_000_000;
const TOOLS = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }];
const OPTIONS = { provider: 'deepseek', model: 'deepseek-v4-pro', purpose: 'inner-compaction', sessionId: SESSION };

// The compact stream the real accumulator keeps of `chunks`, a tick apart.
function streamOf(chunks) {
  const accumulator = new llmPackage.AssistantStreamAccumulator();
  chunks.forEach((chunk, tick) => accumulator.push({ time: STREAM_T0 + tick, chunk }));
  return accumulator.snapshot();
}
const textChunks = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }];
const USAGE_CHUNK = { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 950, cacheReadTokens: 800 } };
const STOP = { type: 'finish', reason: { kind: 'stop' } };
const answer = text => streamOf([...textChunks(text), USAGE_CHUNK, STOP]);

// The wire is JSON: a detail reaches the page as the host's answer parsed from text.
const wire = value => JSON.parse(JSON.stringify(value));
const readyOf = value => ({ kind: 'ready', value: wire(value) });

// A request header that defines `tools`, as the log keeps it ahead of the first request.
function headerOf(tools) {
  const header = requestHeader();
  return { ...header, data: { ...header.data, header: { ...header.data.header, ...(tools === undefined ? {} : { tools }) } } };
}

// A conversation of two counted steps: the header, the ask, a reply that calls `read`, the result and the pruner's replacement of it, and a last reply. The surface the call saw is the ask, the first reply, the replacement and the last reply.
function conversation({ tools = TOOLS } = {}) {
  const header = headerOf(tools);
  const ask = userMessage({ text: 'please work' });
  const first = assistantMessage({ text: 'reading', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' }], step: 1 });
  const original = toolResult({ callId: 'call-1', text: 'the whole file', step: 1 });
  const replacement = prunedResult(original, { text: 'file pruned' });
  const last = assistantMessage({ text: 'done', step: 2 });
  const range = [ask.seq, first.seq, replacement.seq, last.seq];
  const slots = [
    { seqs: [ask.seq], text: 'asked for work' },
    { seqs: [first.seq, original.seq, replacement.seq], text: 'read the file' },
    { seqs: [last.seq], text: '' },
  ];
  return { header, ask, first, original, replacement, last, source: [ask, first, original, replacement, last], range, slots };
}

const requestOf = (conv, overrides = {}) => ({ options: OPTIONS, headerSeq: conv.header.seq, tools: { count: TOOLS.length }, ...overrides });

// The log of an attempt over `conv` and what the producer reads of it. `stream` is the call's compact stream, null for an attempt that never got one, and `end` an end record's `{ outcome, reason }`; with neither and a carrier the attempt committed, its carrier stating `changes` as B when given.
function attemptOver(conv, { stream = answer('["asked","read",""]'), end, request = requestOf(conv), committed = end === undefined && stream !== null, thrown, changes, carrierCache } = {}) {
  const start = innerAttempt({ range: conv.range, tail: PROMPT, request });
  const call = stream === null ? [] : [innerCall({ range: conv.range, tail: PROMPT, stream, endedAt: start.time + CALL_SPAN_MS, attempt: start.seq, thrown, carrierCache })];
  const ending = end === undefined ? [] : [innerEnd({ attempt: start.seq, ...end })];
  const sealed = committed ? [compactionPrune(conv.ask), innerSealCarrier({ sourceEventSeqs: [call[0].seq, ...conv.range, conv.original.seq], slots: conv.slots, changes })] : [];
  const log = [conv.header, ...conv.source, start, ...call, ...ending, ...sealed];
  return { start, log };
}

const fold = events => events.reduce((state, event) => projection.apply(state, event), projection.init());

// The access over the log `events`, with the registry's `live` entries.
function accessOver(events, live = []) {
  return createMonitorAccess({
    sessionOf: id => (id === SESSION ? {} : undefined), readMonitor: () => fold(events), live: () => live, kit,
    readSession: async () => ({ events: structuredClone(events) }), readStored: async () => undefined,
  });
}
const callOf = async (log, attempt, live) => wire(await accessOver(log, live).call(SESSION, attempt));

// ── The drawer ────────────────────────────────────────────────────────────────

const callKey = attempt => resourceKey({ endpoint: 'inner-monitor/call', attempt });

function renderDrawer(state, resources = {}, { now = NOW, ordinals = {}, payback } = {}) {
  return renderToString(React.createElement(MonitorDrawer, { state, monitor: monitorAt(null, resources), ordinals, payback, now, dispatch: () => {}, t }));
}
const selectCall = attemptId => reduceView(createViewState(), { type: 'select', kind: 'call', attemptId });

/** The facts a page lists, as its terms and descriptions in order. */
const factsOf = html => [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, term, description]) => [textOf(term), textOf(description)]);
const factOf = (html, term) => factsOf(html).find(([name]) => name === term)?.[1];
/** The drawer header's subtitle line, its text, or undefined where the markup has none. */
const subtitleOf = html => { const found = /<p class="sw-mon-drawer-sub">(.*?)<\/p>/.exec(html); return found === null ? undefined : textOf(found[1]); };

test('characterization: no selection renders no drawer', () => {
  assert.equal(renderDrawer(createViewState()), '');
});

test('the overview of an attempt that never got a response reads its selection from the request\'s options, the effort only where the caller gave one, and names the records the attempt has', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'the summary request was refused' }, request: requestOf(conv, { options: { ...OPTIONS, reasoningEffort: 'high' } }) });
  const detail = await callOf(log, start.seq);
  assert.equal(detail.response, null, 'the producer answers no response for an attempt with no call');
  assert.equal('selection' in detail.row, false, 'the row carries no selection of its own');

  const html = renderToString(React.createElement(OverviewPage, { detail, t }));

  assert.deepEqual(factsOf(html), [
    ['monitor.overview.status', 'monitor.status.failed'],
    ['monitor.overview.callState', 'monitor.callState.absent'],
    ['monitor.overview.carrierCache', 'monitor.carrierCache.unobserved'],
    ['monitor.overview.recordStart', `monitor.overview.seq(seq=${start.seq})`],
    ['monitor.overview.recordCall', 'monitor.notRecorded'],
    ['monitor.overview.recordEnd', `monitor.overview.seq(seq=${start.seq + 1})`],
    ['monitor.overview.recordCarrier', 'monitor.notRecorded'],
    ['monitor.overview.provider', 'deepseek'],
    ['monitor.overview.model', 'deepseek-v4-pro'],
    ['monitor.overview.effort', 'high'],
    ['monitor.overview.range', `monitor.overview.rangeValue(first=${conv.range[0]},last=${conv.range.at(-1)},count=4)`],
    ['monitor.overview.finish', 'monitor.notRecorded'],
    ['monitor.overview.endReason', 'the summary request was refused'],
  ]);
  const bare = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'x' } });
  const unprovided = renderToString(React.createElement(OverviewPage, { detail: await callOf(bare.log, bare.start.seq), t }));
  assert.equal(factOf(unprovided, 'monitor.overview.effort'), undefined, 'an effort the caller did not give is not filled in');
  assert.equal(factOf(unprovided, 'monitor.overview.provider'), 'deepseek');
});

test('a selected call renders a drawer with its title, a close button, a resize handle at the stored width, the eight pages as tabs, the first selected, and the overview of the detail the call resource answers', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);
  const html = renderDrawer(selectCall(start.seq), { [callKey(start.seq)]: readyOf(await callOf(log, start.seq)) }, { ordinals: { [start.seq]: { epoch: 1, ordinal: 4 } } });

  assert.match(html, /^<aside\b/);
  assert.match(html, /data-sw-monitor-drawer=""/);
  assert.match(html, /data-kind="call"/);
  assert.match(html, /aria-label="monitor\.drawer\.label"/);
  assert.match(html, new RegExp(`style="width:${DRAWER_DEFAULT_WIDTH}px"`));
  assert.match(html, /<h2\b[^>]*>monitor\.drawer\.call\(epoch=1,ordinal=4\)<\/h2>/);
  assert.match(html, /<button\b[^>]*aria-label="monitor\.drawer\.close"/);
  const handle = /<div\b[^>]*role="separator"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(handle, /aria-orientation="vertical"/);
  assert.match(handle, /aria-label="monitor\.drawer\.resize"/);
  assert.match(handle, /tabindex="0"/);
  assert.match(handle, new RegExp(`aria-valuenow="${DRAWER_DEFAULT_WIDTH}"`));
  assert.match(handle, new RegExp(`aria-valuemin="${DRAWER_MIN_WIDTH}"`));
  assert.match(handle, new RegExp(`aria-valuemax="${DRAWER_MAX_WIDTH}"`));
  const tabs = [...html.matchAll(/<button\b[^>]*role="tab"([^>]*)>(.*?)<\/button>/g)].map(([, attributes, label]) => [label, /aria-selected="true"/.test(attributes)]);
  assert.deepEqual(tabs, [
    ['monitor.page.overview', true], ['monitor.page.request', false], ['monitor.page.response', false], ['monitor.page.summaries', false],
    ['monitor.page.carried', false], ['monitor.page.quote', false], ['monitor.page.usage', false], ['monitor.page.timing', false],
  ]);
  assert.match(html, /role="tabpanel"/);
  assert.equal(factOf(html, 'monitor.overview.status'), 'monitor.status.committed');
});

test('a detail not yet answered says so in a text of its own: loading while the resource has no result, unavailable, and unreachable with the host\'s message, none of them a page', () => {
  const state = selectCall(7);
  const cases = {
    'detail-loading': [null, 'monitor.detail.loading'],
    'detail-unavailable': [{ kind: 'unavailable' }, 'monitor.detail.unavailable'],
    'detail-unreachable': [{ kind: 'unreachable', message: 'inner_monitor_read_failed' }, 'monitor.detail.unreachable(message=inner_monitor_read_failed)'],
  };
  for (const [marker, [result, text]] of Object.entries(cases)) {
    const html = renderDrawer(state, { [callKey(7)]: result }, { ordinals: { 7: { epoch: 1, ordinal: 2 } } });
    assert.ok(html.includes(text), `${marker}: ${html}`);
    assert.match(html, new RegExp(`data-sw-monitor-notice="${marker}"`), marker);
    assert.equal(html.includes('role="tab"'), false, `${marker} shows no page`);
    assert.match(html, /<h2\b[^>]*>monitor\.drawer\.call\(epoch=1,ordinal=2\)<\/h2>/, `${marker} keeps the title and the close button`);
    assert.equal(subtitleOf(html), 'monitor.drawer.attemptId(id=7)', `${marker} keeps the raw id`);
    assert.match(html, /aria-label="monitor\.drawer\.close"/);
  }
});

test('the drawer reads the resource of the selected identity, a call\'s from the call endpoint and a slot\'s from the slot endpoint, and not what any visible row or another identity holds', { skip }, async () => {
  const conv = conversation();
  const one = attemptOver(conv, { request: requestOf(conv, { options: { ...OPTIONS, model: 'model-one' } }) });
  const two = attemptOver(conv, { request: requestOf(conv, { options: { ...OPTIONS, model: 'model-two' } }) });
  const resources = {
    [callKey(one.start.seq)]: readyOf(await callOf(one.log, one.start.seq)),
    [callKey(two.start.seq)]: readyOf(await callOf(two.log, two.start.seq)),
  };

  assert.equal(factOf(renderDrawer(selectCall(one.start.seq), resources), 'monitor.overview.model'), 'model-one');
  assert.equal(factOf(renderDrawer(selectCall(two.start.seq), resources), 'monitor.overview.model'), 'model-two');
  assert.ok(renderDrawer(selectCall(999), resources).includes('data-sw-monitor-notice="detail-loading"'), 'an identity no resource answers is not shown another\'s detail');
});

// A translate over a real dictionary of the plugin, with its `{name}` placeholders filled.
const localized = dictionary => (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]));

test('in each locale the two drawers are titled alike, by the compaction\'s segment and its ordinal in that segment as its call or its events, with the raw id beside the title in one header line', () => {
  const ordinals = { 31: { epoch: 1, ordinal: 1 }, 207: { epoch: 2, ordinal: 3 } };
  const slotState = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 207, slotKey: 4_410 });
  const render = (state, dictionary) => renderToString(React.createElement(MonitorDrawer, { state, monitor: monitorAt(null, {}), ordinals, now: NOW, dispatch: () => {}, t: localized(dictionary) }));

  const zhSlot = render(slotState, zh);
  assert.match(zhSlot, /<h2\b[^>]*>分段#2压缩#3的事件<\/h2>/);
  assert.equal(subtitleOf(zhSlot), '首事件ID：4410');
  const enSlot = render(slotState, en);
  assert.match(enSlot, /<h2\b[^>]*>Events of segment #2 compaction #3<\/h2>/);
  assert.equal(subtitleOf(enSlot), 'First event ID: 4410');

  const zhCall = render(selectCall(207), zh);
  assert.match(zhCall, /<h2\b[^>]*>分段#2压缩#3的调用<\/h2>/);
  assert.equal(subtitleOf(zhCall), '压缩ID：207');
  const enCall = render(selectCall(207), en);
  assert.match(enCall, /<h2\b[^>]*>Call of segment #2 compaction #3<\/h2>/);
  assert.equal(subtitleOf(enCall), 'Compaction ID: 207');
  for (const html of [zhSlot, enSlot, zhCall, enCall]) assert.equal(html.includes('<dl'), false, 'no key-value list opens the body');
});

test('a parent row is titled by its segment, which the host counts from the boundaries before the attempt, and by its place in that segment, which restarts in each: in each locale', () => {
  const attempts = [0, 0, 1, 3].map((epoch, at) => attemptRow(10 + at, { epoch }));
  const state = createViewState();
  const parents = html => parseRows(html).filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.title);
  const titles = dictionary => parents(renderToString(React.createElement(MonitorList, { rows: flattenRows(attempts, {}, state), selected: null, now: NOW, dispatch: () => {}, t: localized(dictionary) })));

  assert.deepEqual(titles(zh), ['分段 #1 压缩 #1', '分段 #1 压缩 #2', '分段 #2 压缩 #1', '分段 #4 压缩 #1']);
  assert.deepEqual(titles(en), ['Segment #1 Compaction #1', 'Segment #1 Compaction #2', 'Segment #2 Compaction #1', 'Segment #4 Compaction #1']);
  assert.deepEqual(parents(renderList(attempts, { state })), [
    'monitor.object.attempt(epoch=1,ordinal=1)', 'monitor.object.attempt(epoch=1,ordinal=2)', 'monitor.object.attempt(epoch=2,ordinal=1)', 'monitor.object.attempt(epoch=4,ordinal=1)',
  ]);
});

test('a selection under a collapsed parent keeps its drawer, a resize its width, and a slot selection its own title and kind', () => {
  const ordinals = { 1: { epoch: 1, ordinal: 1 }, 2: { epoch: 1, ordinal: 2 }, 3: { epoch: 1, ordinal: 3 } };
  let state = selectCall(3);
  state = reduceView(state, { type: 'toggle', attemptId: 3, open: false });
  assert.equal(parseRows(renderList([committed, failed, running], { state })).some(row => row.attributes['data-identity'] === 'call:3'), true, 'the selected call row is listed while its group is open');
  state = reduceView(state, { type: 'toggle', attemptId: 3, open: true });
  assert.equal(parseRows(renderList([committed, failed, running], { state })).some(row => row.attributes['data-identity'] === 'call:3'), false, 'the selected call row is no longer listed once the group closes');
  assert.match(renderDrawer(state, {}, { ordinals }), /monitor\.drawer\.call\(epoch=1,ordinal=3\)/);

  state = reduceView(state, { type: 'resize', width: 500, containerWidth: 1_200 });
  const resized = renderDrawer(state, {}, { ordinals });
  assert.match(resized, /style="width:500px"/);
  assert.match(resized, /aria-valuenow="500"/);

  state = reduceView(state, { type: 'select', kind: 'slot', attemptId: 1, slotKey: 20 });
  const html = renderDrawer(state, {}, { ordinals });
  assert.match(html, /data-kind="slot"/);
  assert.match(html, /<h2\b[^>]*>monitor\.drawer\.slot\(epoch=1,ordinal=1\)<\/h2>/);
});

test('a drawer is titled by the display ordinal of its attempt and states the raw id beside the title in its header line: the attempt\'s id for a call, the slot\'s key for a slot, readable without hovering and before the detail is answered', () => {
  const ordinals = { 31: { epoch: 1, ordinal: 1 }, 207: { epoch: 1, ordinal: 2 } };
  const call = renderDrawer(selectCall(207), {}, { ordinals });
  const slot = renderDrawer(reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 207, slotKey: 4_410 }), {}, { ordinals });

  assert.match(call, /<h2\b[^>]*>monitor\.drawer\.call\(epoch=1,ordinal=2\)<\/h2>/);
  assert.match(slot, /<h2\b[^>]*>monitor\.drawer\.slot\(epoch=1,ordinal=2\)<\/h2>/);
  assert.equal(subtitleOf(call), 'monitor.drawer.attemptId(id=207)');
  assert.equal(subtitleOf(slot), 'monitor.drawer.slotKey(id=4410)', 'a slot states its first event alone, not the attempt\'s id');
  for (const html of [call, slot]) {
    assert.match(html, /<div class="sw-mon-drawer-head"><h2\b[^>]*>[^<]*<\/h2><p class="sw-mon-drawer-sub">[^<]*<\/p><button/, 'the title, the id and the close button are the one header line, in that order');
  }
  assert.equal(call.includes('title='), false, 'no value rests on a hover title');
  assert.match(renderDrawer(selectCall(999), {}, { ordinals }), /<h2\b[^>]*>monitor\.drawer\.call\(epoch=—,ordinal=—\)<\/h2>/, 'an attempt the list does not hold gets the neutral marker, not its seq');
});

// ── The call's pages ──────────────────────────────────────────────────────────

const pageHtml = (Page, detail, props = {}) => renderToString(React.createElement(Page, { detail, now: NOW, t, ...props }));

/** The section of rendered markup marked `name`, its markup, or undefined. */
const sectionOf = (html, name) => new RegExp(`<section\\b[^>]*data-sw-section="${name}"[^>]*>(.*?)</section>`, 's').exec(html)?.[1];

test('the request page shows the options the caller gave, the count of earlier messages, the C tail in full and the sequence numbers, with no note on what it is not', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { request: requestOf(conv, { options: { ...OPTIONS, reasoningEffort: 'low' }, messages: { count: 6, tail: { role: 'user', content: [{ type: 'text', text: `${PROMPT}\n<b>two lines & more</b>` }] } } }) });

  const html = pageHtml(RequestPage, await callOf(log, start.seq));

  assert.equal(html.includes('monitor.request.projection'), false);
  assert.deepEqual(factsOf(sectionOf(html, 'options')), [
    ['provider', 'deepseek'], ['model', 'deepseek-v4-pro'], ['purpose', 'inner-compaction'], ['sessionId', SESSION], ['reasoningEffort', 'low'],
  ]);
  const messages = sectionOf(html, 'messages');
  assert.ok(messages.includes('monitor.request.messages(count=6)'));
  assert.equal(messages.includes('monitor.request.historyNote'), false);
  assert.ok(messages.includes('<pre class="sw-mon-pre">'), 'the tail is set in a preformatted block');
  assert.ok(textOf(messages).includes(`${PROMPT}\n<b>two lines & more</b>`), 'the tail is whole, its markup characters shown and not interpreted');
  assert.equal(messages.includes('<b>'), false, 'the tail\'s markup characters are escaped');
  assert.equal(html.includes('please work'), false, 'no body of the history the call summarized is shown here');
  assert.deepEqual(factsOf(sectionOf(html, 'sequence')), [['monitor.request.throughSeq', String(conv.range.at(-1))], ['monitor.request.headerSeq', String(conv.header.seq)]]);
});

test('the request page lists the tool count with the definitions folded, or, where the header lacks them, the count and the reason, and no tool section where the request sent no tools', { skip }, async () => {
  const conv = conversation();
  const withTools = attemptOver(conv);
  const html = pageHtml(RequestPage, await callOf(withTools.log, withTools.start.seq));
  const tools = sectionOf(html, 'tools');
  assert.ok(tools.includes(`monitor.request.tools(count=${TOOLS.length})`));
  assert.match(tools, /<details\b[^>]*>\s*<summary\b[^>]*>monitor\.request\.definitions<\/summary>/);
  assert.ok(textOf(tools).includes('"name": "read"') && textOf(tools).includes('Read a file.'), 'the whole definition is shown');

  const lacking = attemptOver(conv, { request: requestOf(conv, { headerSeq: 9999, tools: { count: 2 } }) });
  const missing = sectionOf(pageHtml(RequestPage, await callOf(lacking.log, lacking.start.seq)), 'tools');
  assert.ok(missing.includes('monitor.request.tools(count=2)'));
  assert.equal(missing.includes('<details'), false, 'no definitions to fold');
  assert.ok(textOf(missing).includes('seq 9999'), 'the producer\'s reason is shown');

  const bare = attemptOver(conv, { request: { options: OPTIONS, headerSeq: conv.header.seq } });
  const none = pageHtml(RequestPage, await callOf(bare.log, bare.start.seq));
  assert.equal(sectionOf(none, 'tools'), undefined, 'a request with no tools key shows no tool section');
});

test('the request page lists the tool history the call updated, a message id with the names it added, and nothing where the request carried none', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { request: requestOf(conv, { toolHistory: { updates: [{ messageId: 'message-4', additions: ['read', 'edit'] }] } }) });

  const history = sectionOf(pageHtml(RequestPage, await callOf(log, start.seq)), 'toolHistory');

  assert.deepEqual(factsOf(history), [['message-4', 'read, edit']]);
  const plain = attemptOver(conv);
  assert.equal(sectionOf(pageHtml(RequestPage, await callOf(plain.log, plain.start.seq)), 'toolHistory'), undefined);
});

test('a payload of the retired legacy and partial shapes reads as any other: no legacy note on the overview, no partial note on the request page, and the selection only from the options the request carries', () => {
  const row = { ...attemptRow(4), legacy: true };
  const { request } = callPayload(row);
  const overview = pageHtml(OverviewPage, callPayload(row));
  assert.equal(overview.includes('monitor.overview.legacy'), false);

  const html = pageHtml(RequestPage, callPayload(row, { request: { ...request, recorded: 'partial', selection: { provider: 'ignored', model: 'ignored' } } }));

  assert.equal(html.includes('monitor.request.partial'), false);
  assert.deepEqual(factsOf(sectionOf(html, 'options')), [['provider', 'p'], ['model', 'm'], ['purpose', 'compaction'], ['sessionId', 's1']]);
  assert.ok(sectionOf(html, 'messages').includes('monitor.request.messages('), 'the count of earlier messages is shown');
});

// A response that ran to a tool call: a text, then a call of `bash`, then the stop and the usage.
const refusedStream = () => streamOf([{ type: 'block-start', index: 0, blockType: 'weird' }]);
const toolCallStream = text => streamOf([
  ...textChunks(text),
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'call-9', name: 'bash', argumentsDelta: '{"cmd":"rm -rf <b>/</b>"}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"cmd":"rm -rf <b>/</b>"}' } },
  USAGE_CHUNK, { type: 'finish', reason: { kind: 'tool-calls' } },
]);

test('the response page of a failed attempt puts the recorded outcome above the assembled blocks and keeps the raw stream folded below them; a truncated array and a tool call stay blocks of text and data, no slot', { skip }, async () => {
  const conv = conversation();
  const reason = 'inner seal of session s failed: the response called a tool';
  const { start, log } = attemptOver(conv, { stream: toolCallStream('["asked","read"'), end: { outcome: 'failed', reason }, committed: false });
  const detail = await callOf(log, start.seq);

  const html = pageHtml(ResponsePage, detail);

  const outcome = sectionOf(html, 'outcome');
  assert.ok(textOf(outcome).includes(reason), 'the whole reason is shown');
  const assembled = sectionOf(html, 'assembled');
  assert.ok(html.indexOf('data-sw-section="outcome"') < html.indexOf('data-sw-section="assembled"'), 'the recorded outcome is above the assembled blocks');
  assert.ok(html.indexOf('data-sw-section="assembled"') < html.indexOf('data-sw-section="raw"'), 'the raw stream is below them');
  assert.ok(assembled.includes('monitor.response.assembled'), 'the blocks are labelled as the validation sees them');
  assert.ok(textOf(assembled).includes('["asked","read"'), 'the truncated array is a text block as it is');
  const call = /<div\b[^>]*data-block="tool-call"[^>]*>(.*?)<\/div>/s.exec(assembled)?.[1] ?? '';
  assert.ok(call.includes('monitor.block.toolCall(name=bash)'));
  assert.equal(call.includes('monitor.block.displayOnly'), false, 'a tool call carries no tag, and is shown and never run');
  assert.equal(call.includes('sw-mon-tag'), false);
  assert.ok(textOf(call).includes('{"cmd":"rm -rf <b>/</b>"}') && !call.includes('<b>'), 'its arguments are the raw string, escaped');
  const raw = sectionOf(html, 'raw');
  assert.match(raw, /<details\b[^>]*>\s*<summary\b[^>]*>monitor\.response\.raw\(count=\d+\)<\/summary>/);
  assert.ok(textOf(raw).includes('"type": "text-chunks"') || textOf(raw).includes('"type": "chunk"'), 'the compact records are shown as recorded');
});

test('the response page of a committed attempt has no outcome section, and shows the error text beside the raw stream where the assembler refuses it, the thrown error of the call too', { skip }, async () => {
  const conv = conversation();
  const done = attemptOver(conv);
  const committedHtml = pageHtml(ResponsePage, await callOf(done.log, done.start.seq));
  assert.equal(sectionOf(committedHtml, 'outcome'), undefined);
  assert.ok(textOf(sectionOf(committedHtml, 'assembled')).includes('["asked","read",""]'));

  const broken = attemptOver(conv, { stream: refusedStream(), end: { outcome: 'failed', reason: 'the response has no finish chunk' }, committed: false, thrown: 'socket hang up' });
  const detail = await callOf(broken.log, broken.start.seq);
  assert.equal(detail.response.blocks, null, 'the assembler refuses a block of a type it cannot close');

  const html = pageHtml(ResponsePage, detail);

  assert.ok(textOf(sectionOf(html, 'outcome')).includes('the response has no finish chunk'));
  assert.ok(textOf(sectionOf(html, 'outcome')).includes('socket hang up'));
  assert.ok(html.indexOf('data-sw-section="outcome"') < html.indexOf('data-sw-section="assembled"'));
  assert.ok(textOf(sectionOf(html, 'assembled')).includes(detail.response.error), 'the assembler\'s error text stands where the blocks would be');
  assert.ok(sectionOf(html, 'raw').includes('<details'), 'the raw stream stays available');
});

// The keys a render asks for, recorded while `render` runs.
function keysAsked(render) {
  const keys = new Set();
  listener = key => keys.add(key);
  try {
    render();
  } finally {
    listener = null;
  }
  return keys;
}

test('the response page of an attempt with no call record says no response was recorded, below the recorded outcome that stays above it', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'the request was refused' } });
  const detail = await callOf(log, start.seq);
  assert.equal(detail.response, null);

  const html = pageHtml(ResponsePage, detail);

  assert.ok(textOf(sectionOf(html, 'outcome')).includes('the request was refused'));
  assert.ok(html.indexOf('data-sw-section="outcome"') < html.indexOf('monitor.response.none'), 'the outcome is above the note that no response was recorded');
  assert.equal(sectionOf(html, 'assembled'), undefined);
  assert.equal(sectionOf(html, 'raw'), undefined);
});

test('a cancelled attempt keeps its recorded cause on the overview and the response page under the same neutral outcome keys a failed one uses, none of which claims the cancellation caused anything', { skip }, async () => {
  const conv = conversation();
  const noCall = attemptOver(conv, { stream: null, end: { outcome: 'cancelled', reason: 'user' } });
  const withCall = attemptOver(conv, { stream: answer('["a"'), end: { outcome: 'cancelled', reason: 'hook: stop it' }, committed: false, thrown: 'aborted' });

  for (const [{ start, log }, cause] of [[noCall, 'user'], [withCall, 'hook: stop it']]) {
    const detail = await callOf(log, start.seq);
    assert.equal(detail.row.status, 'cancelled');
    const keys = keysAsked(() => { pageHtml(OverviewPage, detail); pageHtml(ResponsePage, detail); });
    const overview = pageHtml(OverviewPage, detail);
    const response = pageHtml(ResponsePage, detail);

    assert.equal(factOf(overview, 'monitor.overview.endReason'), cause, 'the recorded cause is kept whole');
    assert.ok(textOf(sectionOf(response, 'outcome')).includes(cause));
    assert.ok(keys.has('monitor.overview.endReason') && keys.has('monitor.response.outcome'));
    assert.deepEqual([...keys].filter(key => /failure|failed|cause|because/i.test(key)), [], 'no key names a failure or a cause');
  }
  assert.equal(factOf(pageHtml(OverviewPage, await callOf(withCall.log, withCall.start.seq)), 'monitor.overview.thrown'), 'aborted', 'the call\'s thrown text is kept apart from the end reason');
});

test('the response page of an attempt in flight shows the blocks the stream holds so far, with no outcome section and no note on the snapshot', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { stream: null, committed: false });
  const entry = { attempt: start.seq, phase: 'generating', endedAt: null, request: start.data.request, tools: TOOLS, stream: () => streamOf([{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: '["asked",' }]) };
  const detail = await callOf(log, start.seq, [entry]);
  assert.equal(detail.response.live, true);

  const html = pageHtml(ResponsePage, detail);

  assert.equal(html.includes('data-sw-snapshot'), false);
  assert.equal(html.includes('monitor.response.snapshot'), false);
  assert.equal(sectionOf(html, 'outcome'), undefined);
  assert.ok(textOf(sectionOf(html, 'assembled')).includes('["asked",'), 'the text so far is a block');
  assert.ok(textOf(sectionOf(html, 'raw')).includes('text-chunks') && textOf(sectionOf(html, 'raw')).includes('asked'), 'the stream so far is shown as recorded');
});

test('an attempt in its validating phase keeps the end of its call and the blocks of its finished stream, none of it worded as a stream still running', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv, { stream: null, committed: false });
  const entry = { attempt: start.seq, phase: 'validating', endedAt: start.time + CALL_SPAN_MS, request: start.data.request, tools: TOOLS, stream: () => answer('["asked","read",""]') };
  const detail = await callOf(log, start.seq, [entry]);
  assert.equal(detail.row.status, 'validating');
  assert.equal(detail.response.live, true, 'the host marks every registry entry live');

  const keys = keysAsked(() => { pageHtml(ResponsePage, detail); pageHtml(TimingPage, detail); });
  const response = pageHtml(ResponsePage, detail);
  const timing = pageHtml(TimingPage, detail, { now: start.time + 60_000 });

  assert.equal(keys.has('monitor.response.snapshot'), false);
  assert.deepEqual([...keys].filter(key => /live|stream(ing)?$/i.test(key)), [], 'no key says the response is live or still streaming');
  assert.ok(textOf(sectionOf(response, 'assembled')).includes('["asked","read",""]'), 'the finished stream reads as its blocks');
  assert.equal(factOf(timing, 'monitor.timing.callEnd'), isoOf(start.time + CALL_SPAN_MS), 'the call\'s end is kept');
  assert.equal(factOf(timing, 'monitor.timing.callElapsed'), '2.5 s', 'the call\'s span stops at its end while the clock moves on');
});

test('the overview names the authoritative count of slots the carrier committed, zero included, and none for an attempt with no carrier', { skip }, async () => {
  const conv = conversation();
  const sealed = attemptOver(conv);
  const none = attemptOver({ ...conv, slots: [] });
  const failed = attemptOver(conv, { end: { outcome: 'failed', reason: 'x' }, committed: false });

  const counts = [];
  for (const { start, log } of [sealed, none, failed]) counts.push(factOf(pageHtml(OverviewPage, await callOf(log, start.seq)), 'monitor.overview.slots'));

  assert.deepEqual(counts, [String(conv.slots.length), '0', undefined], 'the count of the committed carrier, 0 for an empty one, no fact without a carrier');
});

// A response that ended with a finish chunk that carries more than its kind.
const finishedStream = () => streamOf([...textChunks('["a"]'), USAGE_CHUNK, { type: 'finish', reason: { kind: 'stop' }, replayState: { marker: 'resume-7' } }]);

test('the response page shows the finish chunk as recorded, not only its kind, and reads not recorded for a stream that ended with none', { skip }, async () => {
  const conv = conversation();
  const finished = attemptOver(conv, { stream: finishedStream() });
  const withFinish = pageHtml(ResponsePage, await callOf(finished.log, finished.start.seq));
  assert.ok(textOf(sectionOf(withFinish, 'finish')).includes('"kind": "stop"') && textOf(sectionOf(withFinish, 'finish')).includes('"marker": "resume-7"'), 'the whole chunk is shown');
  assert.ok(withFinish.indexOf('data-sw-section="assembled"') < withFinish.indexOf('data-sw-section="finish"') && withFinish.indexOf('data-sw-section="finish"') < withFinish.indexOf('data-sw-section="raw"'));

  const unfinished = attemptOver(conv, { stream: refusedStream(), end: { outcome: 'failed', reason: 'x' }, committed: false });
  const without = pageHtml(ResponsePage, await callOf(unfinished.log, unfinished.start.seq));
  assert.ok(sectionOf(without, 'finish').includes('monitor.notRecorded'));
  assert.equal(sectionOf(without, 'finish').includes('<pre'), false);

  const bare = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'x' } });
  assert.equal(sectionOf(pageHtml(ResponsePage, await callOf(bare.log, bare.start.seq)), 'finish'), undefined, 'no response, no finish section');
});

test('the usage page shows the four numbers the reducer folds and, apart, the usage chunk as streamed; where there is no call or no usage chunk each reads not recorded', { skip }, async () => {
  const conv = conversation();
  const done = attemptOver(conv);
  const html = pageHtml(UsagePage, await callOf(done.log, done.start.seq));

  assert.deepEqual(factsOf(sectionOf(html, 'folded')), [
    ['monitor.usage.input', '120 token'], ['monitor.usage.output', '30 token'], ['monitor.usage.cacheRead', '800 token'], ['monitor.usage.cacheWrite', '0 token'],
  ]);
  assert.ok(textOf(sectionOf(html, 'raw')).includes('"inputTokens": 120') && textOf(sectionOf(html, 'raw')).includes('"cacheReadTokens": 800'), 'the chunk is shown as streamed');

  const silent = attemptOver(conv, { stream: streamOf([...textChunks('["a"]'), STOP]) });
  const noUsage = pageHtml(UsagePage, await callOf(silent.log, silent.start.seq));
  assert.ok(sectionOf(noUsage, 'folded').includes('monitor.notRecorded') && sectionOf(noUsage, 'raw').includes('monitor.notRecorded'));
  assert.equal(sectionOf(noUsage, 'folded').includes('<dl'), false);

  const bare = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'refused' } });
  const detail = await callOf(bare.log, bare.start.seq);
  assert.equal(detail.usage, null);
  const noCall = pageHtml(UsagePage, detail);
  assert.ok(sectionOf(noCall, 'folded').includes('monitor.notRecorded') && sectionOf(noCall, 'raw').includes('monitor.notRecorded'));
});

test('the usage page shows the context before and after the seal and its change in words, a dash for what is missing, and the same dashes from a host that sends no change', () => {
  const contextOf = row => factsOf(sectionOf(pageHtml(UsagePage, callPayload(row)), 'context'));
  assert.deepEqual(contextOf(attemptRow(1, { contextChange: { before: 460, after: 710, delta: 250, miss: 510 } })), [
    ['monitor.context.before', '460 token'], ['monitor.context.after', '710 token'], ['monitor.context.change', 'monitor.change.increase(count=250 token)'], ['monitor.context.miss', '510 token'],
  ]);
  assert.deepEqual(contextOf(attemptRow(2, { contextChange: { before: 460, after: 410, delta: -50, miss: 210 } })).at(-2), ['monitor.context.change', 'monitor.change.decrease(count=50 token)']);
  assert.deepEqual(contextOf(attemptRow(3, { contextChange: { before: 460, after: 460, delta: 0, miss: 0 } })).at(-2), ['monitor.context.change', 'monitor.change.same']);
  const dashes = [['monitor.context.before', '—'], ['monitor.context.after', '—'], ['monitor.context.change', '—'], ['monitor.context.miss', '—']];
  assert.deepEqual(contextOf(attemptRow(4, { contextChange: { before: null, after: null, delta: null, miss: null } })), dashes);
  assert.deepEqual(contextOf(attemptRow(5, { contextChange: { before: null, after: 710, delta: null, miss: 710 } })), [
    ['monitor.context.before', '—'], ['monitor.context.after', '710 token'], ['monitor.context.change', '—'], ['monitor.context.miss', '710 token'],
  ]);
  assert.deepEqual(contextOf(attemptRow(6, { status: 'failed', reason: 'x', slots: null, contextChange: null })), dashes);
  assert.deepEqual(contextOf(attemptRow(7, { contextChange: undefined })), dashes);
  assert.ok(pageHtml(UsagePage, callPayload(attemptRow(8))).indexOf('data-sw-section="folded"') < pageHtml(UsagePage, callPayload(attemptRow(8))).indexOf('data-sw-section="context"'), 'the call\'s own usage stays first');
});

const isoOf = ms => new Date(ms).toISOString();

test('the timing page lists the attempt\'s and the call\'s start, end and span apart, and the first response\'s observed time on its own, with no note', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);
  const carrier = log.at(-1);

  const html = pageHtml(TimingPage, await callOf(log, start.seq));

  assert.deepEqual(factsOf(html), [
    ['monitor.timing.attemptStart', isoOf(start.time)],
    ['monitor.timing.attemptEnd', isoOf(carrier.time)],
    ['monitor.timing.attemptElapsed', `${((carrier.seq - start.seq) * 1000 / 1000).toFixed(1)} s`],
    ['monitor.timing.callStart', isoOf(start.time)],
    ['monitor.timing.callEnd', isoOf(start.time + CALL_SPAN_MS)],
    ['monitor.timing.callElapsed', '2.5 s'],
    ['monitor.timing.firstChunk', isoOf(STREAM_T0)],
  ]);
  assert.equal(html.includes('monitor.timing.firstNote'), false);
  assert.notEqual(isoOf(STREAM_T0), isoOf(start.time), 'the fixture\'s first chunk time differs from the start, so the two are not conflated');
});

test('the timing page of an attempt in flight reads the clock it is given for the spans still running, and shows an end it has none of as not recorded', { skip }, async () => {
  const conv = conversation();
  const live = attemptOver(conv, { stream: null, committed: false });
  const entry = { attempt: live.start.seq, phase: 'generating', endedAt: null, request: live.start.data.request, tools: TOOLS, stream: () => streamOf([{ type: 'block-start', index: 0, blockType: 'text' }]) };
  const running = pageHtml(TimingPage, await callOf(live.log, live.start.seq, [entry]), { now: live.start.time + 3_000 });
  assert.equal(factOf(running, 'monitor.timing.attemptElapsed'), '3.0 s');
  assert.equal(factOf(running, 'monitor.timing.callElapsed'), '3.0 s');
  assert.equal(factOf(running, 'monitor.timing.attemptEnd'), 'monitor.notRecorded');
});

test('the failure reason and the thrown text are shown whole on the overview and the response page, past the length the list previews them at', { skip }, async () => {
  const conv = conversation();
  const reason = `the seal failed: ${'x'.repeat(PREVIEW_SOURCE_CHARS + 300)} END`;
  const { start, log } = attemptOver(conv, { end: { outcome: 'failed', reason }, committed: false, thrown: `${'y'.repeat(PREVIEW_SOURCE_CHARS + 300)} THROWN` });
  const detail = await callOf(log, start.seq);
  assert.ok(detail.row.reason.length > PREVIEW_SOURCE_CHARS, 'the producer answers the whole reason');

  for (const Page of [OverviewPage, ResponsePage]) {
    const text = textOf(pageHtml(Page, detail));
    assert.ok(text.includes(reason), `${Page.name} shows the whole reason`);
    assert.ok(text.includes('THROWN'), `${Page.name} shows the whole thrown text`);
  }
});

// ── The slot's detail ─────────────────────────────────────────────────────────

/** The `inner-monitor/slot` payload the producer answers for the slot of `attempt` that starts at `key`, over `log`. */
const slotOf = async (log, attempt, key) => wire(await accessOver(log).slot(SESSION, attempt, key));

/** The event blocks of a slot's markup: each one's attributes by name and its markup. */
const eventsOf = html => [...html.matchAll(/<details\b([^>]*data-sw-event[^>]*)>(.*?)<\/details>(?=<details\b[^>]*data-sw-event|$)/gs)]
  .map(([, attributes, inner]) => ({ attributes: Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? ''])), inner }));

test('the slot detail shows the whole C above the structured sources; a source the call saw is marked a surface node of the call and opened, the original a pruner replaced is marked an earlier original source and folded, and each event offers its raw JSON, with no note on what it is not', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);
  const detail = await slotOf(log, start.seq, conv.first.seq);

  const html = pageHtml(SlotSourcePage, detail);

  assert.ok(textOf(sectionOf(pageHtml(SlotSummaryPage, detail), 'c')).includes('read the file'));
  const events = eventsOf(sectionOf(html, 'sources'));
  assert.deepEqual(events.map(event => event.attributes['data-seq']), [conv.first, conv.original, conv.replacement].map(event => String(event.seq)));
  assert.deepEqual(events.map(event => event.attributes['data-visible']), ['true', 'false', 'true']);
  assert.deepEqual(events.map(event => 'open' in event.attributes), [true, false, true], 'the surface nodes are opened, the earlier original folded');
  assert.deepEqual(events.map(event => event.inner.includes('monitor.slot.surface')), [true, false, true]);
  assert.deepEqual(events.map(event => event.inner.includes('monitor.slot.earlier')), [false, true, false]);
  assert.ok(events[0].inner.includes('monitor.block.toolCall(name=read)') && !events[0].inner.includes('monitor.block.displayOnly'), 'a tool call among the sources is shown, not run, and carries no tag');
  assert.ok(events[1].inner.includes('data-block="tool-result"') && textOf(events[1].inner).includes('the whole file'), 'the original result is shown whole beside the replacement it was');
  assert.ok(textOf(events[2].inner).includes('file pruned'));
  for (const event of events) {
    assert.match(event.inner, /<details\b[^>]*data-sw-raw[^>]*>\s*<summary\b[^>]*>monitor\.slot\.raw<\/summary>/);
    assert.equal(event.inner.includes('monitor.slot.rawNote'), false);
    assert.ok(textOf(event.inner).includes(`"seq": ${event.attributes['data-seq']}`), 'the raw event is the event itself');
  }
  assert.equal(html.includes('monitor.slot.visibleNote'), false);
});

test('an empty C is a neutral empty marker and not a failure, and a source event with no content blocks says so', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);
  const html = pageHtml(SlotSummaryPage, await slotOf(log, start.seq, conv.last.seq));
  assert.ok(sectionOf(html, 'c').includes('data-sw-empty'));
  assert.ok(sectionOf(html, 'c').includes('monitor.slot.empty'));
  assert.equal(/data-status="failed"|role="alert"|monitor\.response\.failure/.test(html), false, 'an empty C is no failure');

  const blank = userMessage({});
  const mini = { ...conversation(), ask: blank, original: blank, source: [blank], range: [blank.seq], slots: [{ seqs: [blank.seq], text: '' }] };
  const sealed = attemptOver(mini);
  const emptyDetail = await slotOf(sealed.log, sealed.start.seq, blank.seq);
  assert.ok(pageHtml(SlotSourcePage, emptyDetail).includes('monitor.slot.noBlocks'));
  assert.ok(pageHtml(SlotSummaryPage, emptyDetail).includes('data-sw-empty'));
});

test('the slot detail shows the turn and step the slot counted, and nothing for a slot without them', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);

  const counted = factsOf(pageHtml(SlotOverviewPage, await slotOf(log, start.seq, conv.first.seq)));
  const uncounted = factsOf(pageHtml(SlotOverviewPage, await slotOf(log, start.seq, conv.ask.seq)));

  assert.deepEqual(counted.slice(0, 4).map(([term]) => term), ['monitor.slot.number', 'monitor.slot.seqs', 'monitor.slot.turn', 'monitor.slot.step']);
  assert.deepEqual(counted.slice(2, 4).map(([, value]) => value), ['1', '1']);
  assert.deepEqual(uncounted.map(([term]) => term).slice(0, 3), ['monitor.slot.number', 'monitor.slot.seqs', 'monitor.slot.source'], 'a slot without them lists neither');
  assert.deepEqual(factsOf(pageHtml(SlotOverviewPage, await slotOf(log, start.seq, conv.ask.seq))).slice(2, 5), [
    ['monitor.slot.source', 'monitor.source.user'], ['monitor.slot.sourceType', 'user/message'], ['monitor.slot.sourceKind', 'user'],
  ], 'the host\'s own source of the first event, from a real log');
});

test('the slot overview names the slot by its number, the place among the carrier\'s slots counted from one, before every other fact', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);

  const numbers = [];
  for (const slot of conv.slots) numbers.push(factsOf(pageHtml(SlotOverviewPage, await slotOf(log, start.seq, slot.seqs[0])))[0]);

  assert.deepEqual(numbers, [['monitor.slot.number', '1'], ['monitor.slot.number', '2'], ['monitor.slot.number', '3']]);
});

// ── The tools page of a slot ─────────────────────────────────────────────────

const toolEvent = (seq, { text = 'file text', isError = false, blocks } = {}) => ({
  seq, type: 'tool/result', visible: false, raw: { seq },
  blocks: [{ type: 'tool-result', callId: `call-${seq}`, isError, blocks: blocks ?? [{ type: 'text', text }] }],
});
const toolCard = (overrides = {}) => ({ id: '1:1:r1', name: 'read', input: '{"file_path":"a.js"}', result: { seq: 11, error: false, empty: false }, pruned: null, warnings: [], ...overrides });
const toolsSlot = (calls, { warnings = [], events = [toolEvent(11)] } = {}) => slotValue(10, { tools: { warnings, calls }, events });

/** The cards of the tools page's markup: their call identity, the name shown, the states and warnings they show with the I/O collapsed, and their sections. */
function parseCards(html) {
  return html.split(/(?=<article\b)/).filter(chunk => chunk.startsWith('<article')).map(chunk => ({
    id: /data-sw-tool="([^"]*)"/.exec(chunk)?.[1],
    name: textOf(/<span class="sw-mon-tool-name">(.*?)<\/span>/.exec(chunk)?.[1] ?? ''),
    states: [...chunk.matchAll(/data-state="([\w-]+)"[^>]*>(.*?)<\/span>/g)].map(([, state, text]) => [state, textOf(text)]),
    warnings: [...chunk.matchAll(/<li\b[^>]*data-sw-warning="([\w-]+)"[^>]*>(.*?)<\/li>/g)].map(([, kind, text]) => [kind, textOf(text)]),
    sections: [...chunk.matchAll(/<details\b([^>]*\bdata-sw-tool-section="(\w+)"[^>]*)>(.*?)<\/details>/gs)].map(([, attributes, name, body]) => ({ name, open: /\bopen=/.test(attributes), text: textOf(body) })),
    pruned: /<p\b[^>]*data-sw-pruned[^>]*>(.*?)<\/p>/s.exec(chunk)?.[1],
    markup: chunk,
  }));
}

const drawerTabs = html => [...html.matchAll(/<button\b[^>]*role="tab"([^>]*)>(.*?)<\/button>/g)].map(([, attributes, label]) => [label, /aria-selected="true"/.test(attributes)]);

test('a slot drawer offers its tools beside the other pages only when the slot has a call, a result or a warning to show, never opens on them, and a host that sends none shows none', () => {
  const select = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 1, slotKey: 10 });
  const shown = value => drawerTabs(renderDrawer(select, { [slotKeyOf(1, 10)]: { kind: 'ready', value } }, { ordinals: { 1: { epoch: 1, ordinal: 1 } } }));
  const withTools = [['monitor.slotPage.overview', false], ['monitor.slotPage.summary', true], ['monitor.slotPage.source', false], ['monitor.slotPage.tools', false]];
  const without = withTools.slice(0, 3);

  assert.deepEqual(shown(slotValue(10)), without, 'an answer that has no tools at all');
  assert.deepEqual(shown(slotValue(10, { tools: { warnings: [], calls: [] } })), without, 'nothing to show');
  assert.deepEqual(shown(toolsSlot([toolCard()])), withTools, 'a call');
  assert.deepEqual(shown(toolsSlot([toolCard({ name: null, input: null })])), withTools, 'a result alone');
  assert.deepEqual(shown(slotValue(10, { tools: { warnings: ['read-block'], calls: [] } })), withTools, 'a warning is shown though no call is');
  assert.match(renderDrawer(select, { [slotKeyOf(1, 10)]: { kind: 'ready', value: toolsSlot([toolCard()]) } }, { ordinals: { 1: { epoch: 1, ordinal: 1 } } }), /role="tabpanel"[^>]*data-page="summary"|data-page="summary"[^>]*role="tabpanel"/);
});

test('a card shows its call and its input and original output as two collapsed sections one above the other, with an unrecorded input, an unrecorded result, an empty result and a tool failure told apart where the card is closed', () => {
  const cards = parseCards(pageHtml(SlotToolsPage, toolsSlot([
    toolCard(),
    toolCard({ id: '1:1:r2', input: null, name: null, result: { seq: 12, error: false, empty: false } }),
    toolCard({ id: '1:1:r3', result: null }),
    toolCard({ id: '1:1:r4', result: { seq: 13, error: false, empty: true } }),
    toolCard({ id: '1:1:r5', result: { seq: 14, error: true, empty: false } }),
    toolCard({ id: '1:1:r6', result: { seq: 15, error: true, empty: true } }),
    toolCard({ id: '1:1:r7', input: '' }),
  ], { events: [toolEvent(11, { text: 'text eleven' }), toolEvent(12, { text: 'text twelve' }), toolEvent(13, { text: '' }), toolEvent(14, { text: 'ENOENT', isError: true }), toolEvent(15, { blocks: [] })] })));

  assert.deepEqual(cards.map(({ id, name, states }) => [id, name, states]), [
    ['1:1:r1', 'read', []],
    ['1:1:r2', 'monitor.notRecorded', [['no-input', 'monitor.tool.noInput']]],
    ['1:1:r3', 'read', [['no-result', 'monitor.tool.noResult']]],
    ['1:1:r4', 'read', [['empty-result', 'monitor.tool.emptyResult']]],
    ['1:1:r5', 'read', [['error', 'monitor.tool.failed']]],
    ['1:1:r6', 'read', [['error', 'monitor.tool.failed']]],
    ['1:1:r7', 'read', []],
  ]);
  assert.deepEqual(cards[0].sections, [
    { name: 'input', open: false, text: 'monitor.tool.input{"file_path":"a.js"}' },
    { name: 'output', open: false, text: 'monitor.tool.outputtext eleven' },
  ], 'input above output, each folded, the output the original result\'s own blocks');
  assert.deepEqual(cards[1].sections.map(({ name }) => name), ['output'], 'no section for an input nobody recorded');
  assert.deepEqual(cards[2].sections.map(({ name }) => name), ['input']);
  assert.deepEqual(cards[3].sections.map(({ name }) => name), ['input'], 'an empty result has no output to unfold');
  assert.deepEqual(cards[4].sections.map(({ name }) => name), ['input', 'output']);
  assert.equal(cards[4].markup.includes('data-block="tool-result"'), false, 'the output is the result\'s blocks, not the event around them');
  assert.ok(cards[4].sections[1].text.includes('ENOENT'));
  assert.deepEqual(cards[5].sections.map(({ name }) => name), ['input']);
  assert.ok(cards[6].sections[0].text.includes('monitor.slot.empty'), 'an input recorded as empty text is told from one never recorded');
  assert.deepEqual(cards.map(card => card.states.filter(([state]) => state === 'error').length), [0, 0, 0, 0, 1, 1, 0], 'only an explicit failure is a failure');
});

test('a call\'s name, input and output are set as data: markup and links in them are escaped, and an attachment is shown as its reference', () => {
  const html = pageHtml(SlotToolsPage, toolsSlot([
    toolCard({ name: '<img src=x onerror=alert(1)>', input: '<script>run()</script>', result: { seq: 11, error: false, empty: false } }),
  ], { events: [toolEvent(11, { blocks: [{ type: 'text', text: '[link](javascript:alert(1)) <b>bold</b>' }, { type: 'image', attachment: { id: 'att-1', name: 'shot.png' } }] })] }));

  assert.equal(/<(img|script|b)\b/.test(html), false, 'nothing a call holds becomes an element');
  const text = textOf(html);
  for (const literal of ['<img src=x onerror=alert(1)>', '<script>run()</script>', '[link](javascript:alert(1)) <b>bold</b>']) assert.ok(text.includes(literal), literal);
  assert.ok(html.includes('data-block="image"') && text.includes('"name": "shot.png"'), 'the attachment as the reference the log keeps');
  assert.equal(html.includes('<a '), false);
});

test('a card shows the warnings it holds beside a collapsed card in their own kind, a state kind as its short query or write, a direct read and a blocked read as the attempt they were, failed or not, and the header shows each kind it was given once in the same words, the state kinds in full', () => {
  const cards = parseCards(pageHtml(SlotToolsPage, toolsSlot([
    toolCard({ id: '1:1:a', warnings: [{ kind: 'state-mixed' }] }),
    toolCard({ id: '1:1:b', warnings: [{ kind: 'state-check' }, { kind: 'carrier-recall' }] }),
    toolCard({ id: '1:1:c', warnings: [{ kind: 'state-write' }, { kind: 'verbatim-recall' }, { kind: 'handoff-recall' }] }),
    toolCard({ id: '1:1:d', result: { seq: 12, error: true, empty: false }, warnings: [{ kind: 'read-block' }] }),
    toolCard({ id: '1:1:e', result: { seq: 12, error: true, empty: false }, warnings: [{ kind: 'carrier-recall' }] }),
  ], { warnings: ['state-mixed', 'state-write', 'handoff-recall'], events: [toolEvent(11), toolEvent(12, { text: 'denied', isError: true })] })));
  const html = pageHtml(SlotToolsPage, toolsSlot([toolCard({ warnings: [{ kind: 'state-write' }] })], { warnings: ['state-mixed', 'state-write', 'verbatim-recall', 'handoff-recall', 'carrier-recall', 'read-block'] }));

  assert.deepEqual(cards.map(card => card.warnings), [
    [['state-mixed', 'monitor.tool.stateQuery']],
    [['state-check', 'monitor.tool.stateQuery'], ['carrier-recall', 'monitor.tool.attempt.carrier-recall']],
    [['state-write', 'monitor.tool.stateWrite'], ['verbatim-recall', 'monitor.tool.attempt.verbatim-recall'], ['handoff-recall', 'monitor.tool.attempt.handoff-recall']],
    [['read-block', 'monitor.tool.attempt.read-block']],
    [['carrier-recall', 'monitor.tool.attempt.carrier-recall']],
  ]);
  assert.ok(cards.every(card => card.sections.length > 0 && card.sections.every(section => section.open === false)), 'every card shows its warnings with its sections folded');
  assert.deepEqual([cards[3], cards[4]].map(card => card.states), [[['error', 'monitor.tool.failed']], [['error', 'monitor.tool.failed']]], 'a direct read that failed and a read the guard blocked show their failure beside the warning');

  const header = sectionOf(html, 'warnings');
  assert.deepEqual([...header.matchAll(/data-sw-warning="([\w-]+)"[^>]*>(.*?)<\/li>/g)].map(([, kind, text]) => [kind, textOf(text)]), [
    ['state-mixed', 'monitor.warning.state-mixed'], ['state-write', 'monitor.warning.state-write'], ['verbatim-recall', 'monitor.tool.attempt.verbatim-recall'],
    ['handoff-recall', 'monitor.tool.attempt.handoff-recall'], ['carrier-recall', 'monitor.tool.attempt.carrier-recall'], ['read-block', 'monitor.tool.attempt.read-block'],
  ]);
});

test('a card\'s warning is not repeated in the header', () => {
  const onCard = pageHtml(SlotToolsPage, toolsSlot([toolCard({ warnings: [{ kind: 'read-block' }] })]));
  assert.equal(sectionOf(onCard, 'warnings') === undefined || !sectionOf(onCard, 'warnings').includes('data-sw-warning'), true);
});

test('a card shows pruning as neutral text with a jump to the replacement on the source page, and the source page marks only the event the jump names', () => {
  const [pruned, plain] = parseCards(pageHtml(SlotToolsPage, toolsSlot([
    toolCard({ pruned: { seq: 12 } }),
    toolCard({ id: '1:1:r2', result: { seq: 13, error: false, empty: false } }),
  ], { events: [toolEvent(11, { text: 'the whole file' }), toolEvent(12, { text: 'file pruned' }), toolEvent(13)] })));

  assert.ok(pruned.pruned.includes('monitor.tool.pruned'));
  assert.match(pruned.pruned, /<button\b[^>]*data-sw-open-source="12"[^>]*>monitor\.tool\.openPruned\(seq=12\)<\/button>/);
  assert.equal(pruned.warnings.length + pruned.states.length, 0, 'pruning is neither a warning nor a failure');
  assert.equal(pruned.markup.includes('file pruned'), false, 'no second copy of the pruned output');
  assert.ok(pruned.sections[1].text.includes('the whole file'), 'the output is the original');
  assert.equal(plain.pruned, undefined);

  const detail = slotValue(10, { events: [11, 12, 13].map(seq => ({ ...toolEvent(seq), visible: seq !== 11 })) });
  const marked = html => [...html.matchAll(/data-sw-event="" data-seq="(\d+)"[^>]*>/g)].map(([tag, seq]) => [seq, /data-sw-opened/.test(tag)]);
  assert.deepEqual(marked(pageHtml(SlotSourcePage, detail)), [['11', false], ['12', false], ['13', false]]);
  assert.deepEqual(marked(pageHtml(SlotSourcePage, detail, { opened: { seq: 12 } })), [['11', false], ['12', true], ['13', false]]);
  assert.deepEqual(marked(pageHtml(SlotSourcePage, detail, { opened: { seq: 99 } })), [['11', false], ['12', false], ['13', false]], 'a seq the page does not hold marks nothing');
});

test('the tools of a slot the host answers read as the card list the page renders: a pruned call, a failed direct read and an unrecorded result over a real log', { skip }, async () => {
  const conv = conversation();
  conv.first.data.message.content.push({ type: 'tool-call', id: 'call-2', name: 'bash', arguments: '{"command":"ls"}' });
  const { start, log } = attemptOver(conv);
  const detail = await slotOf(log, start.seq, conv.first.seq);

  const [first, second] = parseCards(pageHtml(SlotToolsPage, detail));
  assert.deepEqual([first.id, second.id], ['1:1:call-1', '1:1:call-2']);
  assert.ok(first.pruned.includes(`data-sw-open-source="${conv.replacement.seq}"`), 'the jump names the replacement event of the slot');
  assert.ok(first.sections[1].text.includes('the whole file') && !first.markup.includes('file pruned'));
  assert.deepEqual(second.states, [['no-result', 'monitor.tool.noResult']]);
});

// ── The usage page of a slot ─────────────────────────────────────────────────

const CALL_USAGE = { input: 1_000, output: 40, cacheRead: 5_000, cacheWrite: 300 };
const NEXT_USAGE = { input: 2_000, output: 60, cacheRead: 7_000, cacheWrite: 0 };
const usageOfSlot = (usage = {}) => slotValue(10, {
  usage: { current: { seq: 10, usage: CALL_USAGE }, next: { kind: 'main', seq: 14, usage: NEXT_USAGE }, sourceTokens: 26_624, ...usage },
});
const FOUR = (usage, unit = 'token') => [
  ['monitor.slotUsage.input', `${usage.input} ${unit}`], ['monitor.usage.output', `${usage.output} ${unit}`],
  ['monitor.usage.cacheRead', `${usage.cacheRead} ${unit}`], ['monitor.usage.cacheWrite', `${usage.cacheWrite} ${unit}`],
];

test('a slot drawer offers its usage after the source text, before the tools, only where the host sent a measured call or an estimate (a zero one too), never opens on it, and an older host or an answer with neither keeps the pages it had', () => {
  const select = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 1, slotKey: 10 });
  const shown = value => drawerTabs(renderDrawer(select, { [slotKeyOf(1, 10)]: { kind: 'ready', value } }, { ordinals: { 1: { epoch: 1, ordinal: 1 } } }));
  const plain = [['monitor.slotPage.overview', false], ['monitor.slotPage.summary', true], ['monitor.slotPage.source', false]];
  const withUsage = [...plain, ['monitor.slotPage.usage', false]];

  assert.deepEqual(shown(slotValue(10)), plain, 'a host that sends no usage field');
  assert.deepEqual(shown(usageOfSlot({ current: null, next: null, sourceTokens: null })), plain, 'a field that holds nothing to show');
  assert.deepEqual(shown(usageOfSlot()), withUsage, 'a measured call');
  assert.deepEqual(shown(usageOfSlot({ current: null, next: null, sourceTokens: 0 })), withUsage, 'an estimate of zero is an estimate');
  assert.deepEqual(shown(usageOfSlot({ sourceTokens: null })), withUsage, 'a carrier older than the estimate keeps the measured page');
  assert.deepEqual(shown({ ...usageOfSlot(), tools: { warnings: ['read-block'], calls: [] } }), [...withUsage, ['monitor.slotPage.tools', false]], 'the tools come after the usage');
});

test('the usage page shows the slot\'s own call and the call after it as two blocks, each under its own source and seq with the four buckets, the original text estimate after them as an approximate count of what the compaction saw', () => {
  const html = pageHtml(SlotUsagePage, usageOfSlot());

  assert.deepEqual(factsOf(sectionOf(html, 'current')), FOUR(CALL_USAGE));
  assert.ok(sectionOf(html, 'current').includes('monitor.slotUsage.current(seq=10)'), 'the slot\'s own call is told by its event seq');
  assert.deepEqual(factsOf(sectionOf(html, 'next')), FOUR(NEXT_USAGE));
  assert.ok(html.includes('monitor.slotUsage.nextMain(seq=14)'), 'the next call is told by its event seq as a main call');
  assert.ok(textOf(sectionOf(html, 'source')).includes('monitor.slotUsage.approx(tokens=26624 token)'), 'the estimate is an approximation');
  assert.ok(html.includes('monitor.slotUsage.source') && html.includes('monitor.slotUsage.sourceNote'), 'named as this slot\'s original text, and as what the compaction saw');
  assert.ok(html.indexOf('data-sw-section="current"') < html.indexOf('data-sw-section="next"') && html.indexOf('data-sw-section="next"') < html.indexOf('data-sw-section="source"'));
});

test('the usage page words the successor as the summary call where the slot is the last with a call, a call with no usage as not recorded as a whole block, and a successor the host could not confirm as such, never as zeros', () => {
  const summary = pageHtml(SlotUsagePage, usageOfSlot({ next: { kind: 'summary', seq: 40, usage: NEXT_USAGE } }));
  assert.ok(summary.includes('monitor.slotUsage.nextSummary(seq=40)') && !summary.includes('monitor.slotUsage.nextMain'));
  assert.deepEqual(factsOf(sectionOf(summary, 'next')), FOUR(NEXT_USAGE));

  const bare = pageHtml(SlotUsagePage, usageOfSlot({ current: { seq: 10, usage: null }, next: { kind: 'main', seq: 14, usage: null } }));
  for (const name of ['current', 'next']) {
    assert.deepEqual(factsOf(sectionOf(bare, name)), [], `${name}: no bucket is shown`);
    assert.ok(sectionOf(bare, name).includes('monitor.notRecorded'), `${name}: the block reads as not recorded`);
  }

  const unconfirmed = pageHtml(SlotUsagePage, usageOfSlot({ next: null }));
  assert.ok(sectionOf(unconfirmed, 'next').includes('monitor.slotUsage.unconfirmed'));
  assert.deepEqual(factsOf(sectionOf(unconfirmed, 'next')), []);
  assert.deepEqual(factsOf(sectionOf(unconfirmed, 'current')), FOUR(CALL_USAGE), 'the slot\'s own call is still measured');

  const reported = pageHtml(SlotUsagePage, usageOfSlot({ current: { seq: 10, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
  assert.deepEqual(factsOf(sectionOf(reported, 'current')), FOUR({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 'a reported zero is shown as zeros');
});

test('the estimate is shown whatever it is, a zero included, and as not recorded where the carrier kept none beside a measured call; with no measured call the page holds the estimate alone', () => {
  const zero = pageHtml(SlotUsagePage, usageOfSlot({ current: null, next: null, sourceTokens: 0 }));
  assert.ok(textOf(sectionOf(zero, 'source')).includes('monitor.slotUsage.approx(tokens=0 token)'));
  assert.equal(sectionOf(zero, 'current'), undefined);
  assert.equal(sectionOf(zero, 'next'), undefined, 'no successor is told where there is no call');
  assert.equal(zero.includes('monitor.slotUsage.unconfirmed'), false);

  const fraction = pageHtml(SlotUsagePage, usageOfSlot({ current: null, next: null, sourceTokens: 1234.5678 }));
  assert.ok(textOf(sectionOf(fraction, 'source')).includes('monitor.slotUsage.approx(tokens=1235 token)'), 'the stored value is whole and the page rounds');

  const missing = pageHtml(SlotUsagePage, usageOfSlot({ sourceTokens: null }));
  assert.ok(sectionOf(missing, 'source').includes('monitor.notRecorded'));
  assert.equal(textOf(sectionOf(missing, 'source')).includes('0 token'), false, 'a missing estimate is no zero');
});

test('a slot detail the host answers over a real log reads on the usage page the very resource the drawer already read, with no further look-up', { skip }, async () => {
  const conv = conversation();
  conv.first.data.usage = { inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 5_000, cacheWriteTokens: 300 };
  conv.last.data.usage = { inputTokens: 2_000, outputTokens: 60, cacheReadTokens: 7_000 };
  const { start, log } = attemptOver(conv);
  const detail = await slotOf(log, start.seq, conv.first.seq);
  const select = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: start.seq, slotKey: conv.first.seq });
  const touched = [];
  const html = renderToString(React.createElement(MonitorDrawer, {
    state: select, monitor: monitorAt(null, { [slotKeyOf(start.seq, conv.first.seq)]: { kind: 'ready', value: detail } }, touched), ordinals: { [start.seq]: { epoch: 1, ordinal: 1 } }, now: NOW, dispatch: () => {}, t,
  }));

  assert.deepEqual(touched, [slotKeyOf(start.seq, conv.first.seq)], 'the one handle the drawer opened');
  assert.match(html, /role="tabpanel"[^>]*data-page="summary"|data-page="summary"[^>]*role="tabpanel"/, 'the page opens at its summary');
  const usage = pageHtml(SlotUsagePage, detail);
  assert.deepEqual(factsOf(sectionOf(usage, 'current')), FOUR({ input: 1_000, output: 40, cacheRead: 5_000, cacheWrite: 300 }));
  assert.deepEqual(factsOf(sectionOf(usage, 'next')), FOUR({ input: 2_000, output: 60, cacheRead: 7_000, cacheWrite: 0 }), 'a bucket the call did not report is zero, as the reducer folds it');
});

// ── The expanded slots ────────────────────────────────────────────────────────

const slotsKey = attempt => resourceKey({ endpoint: 'inner-monitor/slots', attempt });
const slotKeyOf = (attempt, slot) => resourceKey({ endpoint: 'inner-monitor/slot', attempt, slot });
const readySlots = slots => ({ kind: 'ready', value: { slots } });

test('a slot opens at its summary page and offers the overview and the original text beside it, with the raw seq in the header above the tabs whether or not the detail has arrived; a call keeps its overview', () => {
  const ordinals = { 1: { epoch: 1, ordinal: 1 } };
  const select = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 1, slotKey: 10 });
  const ready = renderDrawer(select, { [slotKeyOf(1, 10)]: { kind: 'ready', value: slotValue(10, { c: 'the whole summary' }) } }, { ordinals });
  const loading = renderDrawer(select, {}, { ordinals });

  const tabs = [...ready.matchAll(/<button\b[^>]*role="tab"([^>]*)>(.*?)<\/button>/g)].map(([, attributes, label]) => [label, /aria-selected="true"/.test(attributes)]);
  assert.deepEqual(tabs, [['monitor.slotPage.overview', false], ['monitor.slotPage.summary', true], ['monitor.slotPage.source', false]]);
  assert.match(ready, /role="tabpanel"[^>]*data-page="summary"|data-page="summary"[^>]*role="tabpanel"/);
  assert.ok(ready.includes('the whole summary'), 'the summary page shows the C string');
  assert.equal(ready.includes('monitor.slot.sources'), false, 'the original text waits on its own page');
  for (const [name, html] of [['ready', ready], ['loading', loading]]) {
    assert.equal(subtitleOf(html), 'monitor.drawer.slotKey(id=10)', `${name}: the raw seq is plain text`);
    assert.equal(html.includes('monitor.drawer.attemptId'), false, `${name}: the attempt id is no line of a slot drawer`);
  }
  assert.ok(ready.indexOf('class="sw-mon-drawer-sub"') < ready.indexOf('role="tablist"'), 'the id stands above the tabs');
  assert.equal(ready.includes('monitor.slot.c'), false, 'the summary page opens with the summary itself, under no heading of its own');
  assert.equal(loading.includes('role="tablist"'), false);
});

test('the slot pages show what the slot detail holds: the overview its seqs, turn, step, the first event\'s source with its raw type and kind, and how many source events the call saw; the summary the whole C; the original text the events and the raw JSON', () => {
  const detail = slotValue(10, {
    seqs: [10, 11, 12], turn: null, step: null, source: { type: 'user/message', kind: 'runtime-context', category: 'injected' }, c: '',
    events: [
      { seq: 10, type: 'user/message', visible: true, blocks: [{ type: 'text', text: 'seen' }], raw: { seq: 10 } },
      { seq: 11, type: 'tool/result', visible: false, blocks: [], raw: { seq: 11 } },
      { seq: 12, type: 'tool/result', visible: true, blocks: [], raw: { seq: 12 } },
    ],
  });

  const overview = factsOf(pageHtml(SlotOverviewPage, detail));
  assert.deepEqual(overview, [
    ['monitor.slot.number', '1'],
    ['monitor.slot.seqs', '10, 11, 12'],
    ['monitor.slot.source', 'monitor.source.injected'],
    ['monitor.slot.sourceType', 'user/message'],
    ['monitor.slot.sourceKind', 'runtime-context'],
    ['monitor.slot.visibleCount', 'monitor.slot.visibleCountValue(visible=2,total=3)'],
  ], 'no turn or step is made up');
  const withStep = factsOf(pageHtml(SlotOverviewPage, slotValue(10)));
  assert.deepEqual(withStep.slice(0, 4).map(([term]) => term), ['monitor.slot.number', 'monitor.slot.seqs', 'monitor.slot.turn', 'monitor.slot.step']);
  const bare = factsOf(pageHtml(SlotOverviewPage, { ...detail, source: undefined }));
  assert.deepEqual(bare.slice(2, 5), [['monitor.slot.source', 'monitor.source.other'], ['monitor.slot.sourceType', 'monitor.notRecorded'], ['monitor.slot.sourceKind', 'monitor.notRecorded']], 'a detail from a host that sends no source');

  const summary = pageHtml(SlotSummaryPage, detail);
  assert.match(summary, /data-sw-empty/, 'an empty C is the neutral marker');
  assert.ok(pageHtml(SlotSummaryPage, slotValue(10, { c: 'the note' })).includes('the note'));

  const source = pageHtml(SlotSourcePage, detail);
  assert.equal(source.includes('monitor.slot.visibleNote'), false);
  assert.deepEqual([...source.matchAll(/data-sw-event="" data-seq="(\d+)" data-visible="(\w+)"/g)].map(match => [match[1], match[2]]), [['10', 'true'], ['11', 'false'], ['12', 'true']]);
  assert.ok(source.includes('data-sw-raw'));
  assert.ok(textOf(source).includes('seen'));
});

function renderSplit(attempts, resources, { state = createViewState(), handoffs = [] } = {}) {
  const touched = [];
  const html = renderToString(React.createElement(MonitorSplit, { attempts, handoffs, monitor: monitorAt({ kind: 'ready', attempts, handoffs }, resources, touched), session: sessionAt(null, touched), state, dispatch: () => {}, t }));
  return { html, touched };
}

test('the list reads the slots of the expanded committed attempts alone and lists their slot rows between the call row and the next parent; a collapsed group, a failed one and one in progress are not read', () => {
  const older = attemptRow(1);
  const latest = attemptRow(2);
  const bad = attemptRow(3, { status: 'failed', reason: 'refused', slots: null });
  const resources = {
    [slotsKey(1)]: readySlots([slotRow(10)]),
    [slotsKey(2)]: readySlots([slotRow(20), slotRow(30, { turn: null, step: null })]),
    [slotsKey(3)]: readySlots([slotRow(40)]),
  };

  const slotReads = ({ touched }) => touched.filter(key => key.includes('inner-monitor/slots'));
  const identitiesOf = ({ html }) => parseRows(html).map(row => row.attributes['data-identity']);

  const byDefault = renderSplit([older, latest], resources);
  assert.deepEqual(identitiesOf(byDefault), ['attempt:1', 'attempt:2']);
  assert.deepEqual(slotReads(byDefault), [], 'a closed group costs no slot read, the latest attempt\'s included');

  const onlyLatest = renderSplit([older, latest], resources, { state: opening(2) });
  assert.deepEqual(identitiesOf(onlyLatest), ['attempt:1', 'attempt:2', 'call:2', 'slot:2:20', 'slot:2:30']);
  assert.deepEqual(slotReads(onlyLatest), [slotsKey(2)], 'only the opened group is read');

  const both = renderSplit([older, latest], resources, { state: opening(1, 2) });
  assert.deepEqual(identitiesOf(both), ['attempt:1', 'call:1', 'slot:1:10', 'attempt:2', 'call:2', 'slot:2:20', 'slot:2:30']);
  assert.deepEqual(slotReads(both).sort(), [slotsKey(1), slotsKey(2)].sort());

  const inProgress = renderSplit([older, attemptRow(4, { status: 'generating', endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null } })], { ...resources, [slotsKey(4)]: readySlots([slotRow(50)]) }, { state: opening(4) });
  assert.deepEqual(identitiesOf(inProgress), ['attempt:1', 'attempt:4', 'call:4'], 'the attempt in progress lists no slot rows');
  assert.deepEqual(slotReads(inProgress), [], 'nothing is read for a closed committed attempt or one in progress');

  const failedOpen = renderSplit([older, bad], resources, { state: opening(3) });
  assert.deepEqual(identitiesOf(failedOpen), ['attempt:1', 'attempt:3', 'call:3'], 'the failed attempt has no slot rows');
  assert.deepEqual(slotReads(failedOpen), [], 'nothing is read for a closed committed attempt or a failed one');
});

test('the split hands the drawer the ordinals of all the attempts, so a selection under a folded parent keeps its ordinal title and raw id while the list shows the same ordinal', () => {
  const attempts = [attemptRow(31), attemptRow(207), attemptRow(1_900)];
  const state = reduceView(createViewState(), { type: 'select', kind: 'call', attemptId: 207 });

  const { html } = renderSplit(attempts, {}, { state });

  assert.match(html, /<h2\b[^>]*>monitor\.drawer\.call\(epoch=1,ordinal=2\)<\/h2>/);
  assert.equal(subtitleOf(html), 'monitor.drawer.attemptId(id=207)');
  assert.equal(parseRows(html).find(row => row.attributes['data-identity'] === 'attempt:207').parts.title, 'monitor.object.attempt(epoch=1,ordinal=2)');
  assert.equal(parseRows(html).some(row => row.attributes['data-identity'] === 'call:207'), false, 'the folded group lists no call row');
});

test('a valid array response with a finish chunk and no carrier is not a committed seal: the list looks up no slots resource and lists no slot rows for it, while its call detail still shows the text and the tool call as data', { skip }, async () => {
  const conv = conversation();
  const array = '["asked","read",""]';
  const { start, log } = attemptOver(conv, { stream: toolCallStream(array), committed: false });
  const { attempts } = wire(await accessOver(log).rows(SESSION));
  assert.deepEqual(attempts.map(({ id, status, slots, call }) => [id, status, slots, call.state, call.finish]), [[start.seq, 'unknown', null, 'received', 'tool-calls']], 'the producer reads the valid response and the finish and still no committed seal');
  const detail = await callOf(log, start.seq);
  const slotsTrap = { [slotsKey(start.seq)]: readySlots([slotRow(10)]) };

  const { html, touched } = renderSplit(attempts, { ...slotsTrap, [callKey(start.seq)]: readyOf(detail) }, { state: reduceView(selectCall(start.seq), { type: 'toggle', attemptId: start.seq, open: false }) });

  assert.deepEqual(parseRows(html).map(row => row.attributes['data-identity']), [`attempt:${start.seq}`, `call:${start.seq}`], 'no slot row appears');
  assert.deepEqual(touched.filter(key => key.includes('inner-monitor/slots')), [], 'no slots resource is looked up');
  assert.equal(attempts[0].call.output, array, 'the array text is the call\'s output, which makes it no slot');
  const response = pageHtml(ResponsePage, detail);
  assert.ok(textOf(sectionOf(response, 'assembled')).includes(array));
  assert.ok(sectionOf(response, 'assembled').includes('data-block="tool-call"'), 'the tool call is shown as data');
});

test('a committed attempt whose slots are not loaded, unavailable or unreachable lists its call row and a placeholder row in the place of its slot rows', () => {
  for (const result of [null, { kind: 'unavailable' }, { kind: 'unreachable', message: 'HTTP 502' }]) {
    const { html } = renderSplit([attemptRow(1)], { [slotsKey(1)]: result }, { state: opening(1) });
    assert.deepEqual(parseRows(html).map(row => row.attributes['data-identity']), ['attempt:1', 'call:1', 'placeholder:1'], JSON.stringify(result));
  }
});

test('a selected slot\'s drawer reads the slot endpoint for its own key and survives its parent being closed, which then costs no slots read', () => {
  const older = attemptRow(1);
  const latest = attemptRow(2);
  const state = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 2, slotKey: 20 });
  const slot = { kind: 'ready', value: { key: 20, seqs: [20, 21], turn: 1, step: 1, c: 'the note for slot twenty', events: [] } };

  const { html, touched } = renderSplit([older, latest], { [slotKeyOf(2, 20)]: slot, [slotKeyOf(2, 30)]: { kind: 'ready', value: { ...slot.value, key: 30, c: 'another' } } }, { state });

  assert.equal(parseRows(html).some(row => row.attributes['data-identity'] === 'slot:2:20'), false, 'the selected slot row is not listed');
  assert.match(html, /data-kind="slot"/);
  assert.ok(html.includes('the note for slot twenty'));
  assert.equal(html.includes('another'), false);
  assert.deepEqual(touched.filter(key => key.includes('inner-monitor/slots')), [], 'the closed parent is not read');
  assert.ok(touched.includes(slotKeyOf(2, 20)));
});

// A slot detail over `events` as the producer's pure reader shapes them, `visible` as given.
const slotDetailOf = (events, c = 'note') => ({ key: events[0].seq, seqs: events.map(event => event.seq), turn: null, step: null, c, events: events.map(event => sourceEventView(event, { visible: true })) });

test('the slot detail shows image and file references, a block of another kind as its JSON and a tool error flagged, and sets markup-like text in preformatted blocks without interpreting it', () => {
  const events = [
    { seq: 40, type: 'user/message', data: { role: 'user', content: [
      { type: 'text', text: '<script>alert(1)</script> **not bold**' },
      { type: 'image', attachment: { id: 'att-1', name: 'shot.png' } },
      { type: 'file', attachment: { id: 'att-2', name: 'notes.txt' } },
      { type: 'hologram', payload: 7 },
    ] } },
    { seq: 41, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'boom' }] } } },
  ];

  const html = pageHtml(SlotSourcePage, slotDetailOf(events));

  assert.equal(html.includes('<script>'), false, 'text is escaped and not interpreted');
  assert.ok(textOf(html).includes('<script>alert(1)</script> **not bold**'));
  assert.ok(html.includes('data-block="image"') && textOf(html).includes('"name": "shot.png"'));
  assert.ok(html.includes('data-block="file"') && textOf(html).includes('"name": "notes.txt"'));
  assert.ok(html.includes('data-block="unknown"') && textOf(html).includes('"type": "hologram"'));
  assert.match(html, /data-block="tool-result"[^>]*data-error=""/, 'the tool error is flagged');
  assert.ok(html.includes('monitor.block.toolError(id=call-1)'));
});

// ── The view with its attempts ────────────────────────────────────────────────

test('with attempts read, the view lists them in a focusable region, every group closed, with no drawer and the host\'s composer-overlay mark on its root', () => {
  const html = renderView(monitorAt({ kind: 'ready', attempts: [committed, failed, running], handoffs: [] }));

  assert.match(html, /^<div\b[^>]*data-sw-monitor=""[^>]*data-conversation-composer-overlay=""/);
  assert.match(html, /<div\b[^>]*data-sw-monitor-split=""/);
  const pane = /<div\b[^>]*role="region"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(pane, /aria-label="monitor\.region"/);
  assert.match(pane, /tabindex="0"/);
  assert.deepEqual(parseRows(html).map(row => row.attributes['data-identity']), ['attempt:1', 'attempt:2', 'attempt:3']);
  assert.equal(html.includes('data-sw-monitor-drawer'), false, 'nothing is selected');
  assert.equal(html.includes('monitor.rows.'), false, 'none of the store states\' texts');
});

test('the view reads the monitor store whatever the session\'s inner mode: a mode reader handed in, at any state, is never read, and the rows are listed', () => {
  const modeStates = [null, { kind: 'unavailable' }, { kind: 'ready', mode: 'off', locked: false }, { kind: 'ready', mode: 'invalid', locked: true }, { kind: 'ready', mode: 'on', locked: true }];
  for (const result of modeStates) {
    const modeReads = [];
    const reader = { get result() { modeReads.push('reader.result'); return result; }, subscribe: () => { modeReads.push('reader.subscribe'); return () => {}; } };
    const touched = [];
    const html = renderToString(React.createElement(InnerCompactionView, { reader, monitor: monitorAt({ kind: 'ready', attempts: [committed], handoffs: [] }, {}, touched), t }));
    assert.deepEqual(modeReads, [], `${JSON.stringify(result)}: the mode reader is not read`);
    assert.ok(touched.includes('rows.result'), `${JSON.stringify(result)}: the rows handle is read`);
    assert.deepEqual(parseRows(html).map(row => row.attributes['data-identity']), ['attempt:1'], JSON.stringify(result));
  }
});

// ── The summaries and the carried evidence of a call ──────────────────────────

const slotsOf = async (log, attempt) => wire(await accessOver(log).slots(SESSION, attempt));
const renderSummaries = (detail, attemptId, resources = {}) => {
  const touched = [];
  const html = renderToString(React.createElement(SummariesPage, { detail, monitor: monitorAt(null, resources, touched), attemptId, t }));
  return { html, touched };
};

test('the summaries page of a committed attempt lists each slot under its number, title and first seq with its whole C string in a preformatted block, the over-long one uncut and the empty one as the empty marker, and reads the slots handle of the list', { skip }, async () => {
  const conv = conversation();
  const long = `${'long summary '.repeat(PREVIEW_SOURCE_CHARS)}END`;
  conv.slots[0] = { ...conv.slots[0], text: long };
  const { start, log } = attemptOver(conv);
  const detail = await callOf(log, start.seq);
  const listed = await slotsOf(log, start.seq);
  assert.ok(long.length > PREVIEW_SOURCE_CHARS * 3, 'a C string far beyond the list\'s cut');

  const { html, touched } = renderSummaries(detail, start.seq, { [slotsKey(start.seq)]: { kind: 'ready', value: listed } });

  const sections = [...html.matchAll(/<section\b[^>]*data-sw-slot-summary="(\d+)"[^>]*>(.*?)<\/section>/gs)].map(([, key, inner]) => ({ key, inner }));
  assert.deepEqual(sections.map(({ key }) => key), conv.slots.map(slot => String(slot.seqs[0])));
  assert.deepEqual(sections.map(({ inner }) => textOf(/<h3\b[^>]*>(.*?)<\/h3>/s.exec(inner)[1])), [
    `monitor.summaries.heading(number=1,title=monitor.source.user,seq=${conv.ask.seq})`,
    `monitor.summaries.heading(number=2,title=monitor.object.turn(turn=1) · monitor.object.step(step=1),seq=${conv.first.seq})`,
    `monitor.summaries.heading(number=3,title=monitor.object.turn(turn=1) · monitor.object.step(step=2),seq=${conv.last.seq})`,
  ]);
  assert.equal(textOf(/<pre\b[^>]*>(.*?)<\/pre>/s.exec(sections[0].inner)[1]), long, 'the whole C string, not its cut');
  assert.equal(textOf(/<pre\b[^>]*>(.*?)<\/pre>/s.exec(sections[1].inner)[1]), 'read the file');
  assert.equal(sections[2].inner.includes('<pre'), false);
  assert.ok(sections[2].inner.includes('data-sw-empty') && sections[2].inner.includes('monitor.slot.empty'), 'an empty C string is the neutral marker');
  assert.deepEqual(touched, [slotsKey(start.seq)], 'the one handle the list reads');
});

test('the summaries page of an attempt that has not committed says they come with the commit and reads no handle: failed, in progress or unknown, whatever else it holds', { skip }, async () => {
  const conv = conversation();
  const failedAttempt = attemptOver(conv, { end: { outcome: 'failed', reason: 'refused' }, committed: false });
  const detail = await callOf(failedAttempt.log, failedAttempt.start.seq);
  const generating = callPayload(attemptRow(5, { status: 'generating', slots: null }));
  const unknown = callPayload(attemptRow(6, { status: 'unknown', slots: null }));

  for (const [why, payload] of [['failed', detail], ['generating', generating], ['unknown', unknown]]) {
    const { html, touched } = renderSummaries(payload, payload.row.id, { [slotsKey(payload.row.id)]: readySlots([slotRow(10)]) });
    assert.match(html, /data-sw-monitor-notice="summaries-pending"/, why);
    assert.ok(html.includes('monitor.summaries.pending'), why);
    assert.equal(html.includes('data-sw-slot-summary'), false, why);
    assert.deepEqual(touched, [], `${why}: nothing is subscribed`);
  }
});

test('the summaries page of a committed attempt says in a text of its own that the slots are being read, cannot be read or cannot be reached, and lists none of them', () => {
  const detail = callPayload(attemptRow(7));
  const cases = {
    'detail-loading': [null, 'monitor.detail.loading'],
    'detail-unavailable': [{ kind: 'unavailable' }, 'monitor.detail.unavailable'],
    'detail-unreachable': [{ kind: 'unreachable', message: 'inner_monitor_read_failed' }, 'monitor.detail.unreachable(message=inner_monitor_read_failed)'],
  };
  for (const [marker, [result, text]] of Object.entries(cases)) {
    const { html, touched } = renderSummaries(detail, 7, { [slotsKey(7)]: result });
    assert.match(html, new RegExp(`data-sw-monitor-notice="${marker}"`), marker);
    assert.ok(html.includes(text), marker);
    assert.equal(html.includes('data-sw-slot-summary'), false, marker);
    assert.deepEqual(touched, [slotsKey(7)], marker);
  }
});

test('the call drawer opens at the overview, reading the call\'s own handle alone', { skip }, async () => {
  const conv = conversation();
  const { start, log } = attemptOver(conv);
  const touched = [];
  const monitor = monitorAt(null, { [callKey(start.seq)]: readyOf(await callOf(log, start.seq)) }, touched);

  const html = renderToString(React.createElement(MonitorDrawer, { state: selectCall(start.seq), monitor, ordinals: { [start.seq]: { epoch: 1, ordinal: 1 } }, now: NOW, dispatch: () => {}, t }));

  assert.ok(html.includes('data-page="overview"'));
  assert.deepEqual(touched, [callKey(start.seq)]);
});

test('the quote page lists the quote the attempt record keeps, its inputs, parameters, preset and results, apart from the B its carrier committed; an attempt with no quote says none was recorded', () => {
  const quote = { n: 8, lA: 12400, bEst: 0, cEst: 2400, sEst: 9880, cRatio: 30, fee: 5000, kappa: 1.1, preset: 'E2', nRef: 15, N: 21.96, jRef: 28.868902300206646, q: 1.0377949146956498, arm: 'left', trigger: 'quote' };
  const html = renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(1), { quote, carried: { text: 'B as committed', note: 'The note.', files: [], removed: [], skills: [] } }), t }));
  assert.deepEqual(factsOf(html), [
    ['monitor.quote.n', '8'], ['monitor.quote.lA', '12400'], ['monitor.quote.bEst', '0'], ['monitor.quote.cEst', '2400'], ['monitor.quote.sEst', '9880'],
    ['monitor.quote.cRatio', '30'], ['monitor.quote.fee', '5000'], ['monitor.quote.preset', 'monitor.quote.preset.E2'], ['monitor.quote.kappa', '1.1'],
    ['monitor.quote.q', '1.038'], ['monitor.quote.arm', 'monitor.quote.arm.left'],
  ]);
  assert.ok(html.includes('monitor.quote.note'), 'the page says the quote is the estimate before the summary');
  assert.equal(html.includes('B as committed'), false, 'the committed B is the carried page\'s');

  const { preset, ...recorded } = quote;
  const older = renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(4), { quote: recorded }), t }));
  assert.equal(factOf(older, 'monitor.quote.preset'), 'monitor.notRecorded', 'a quote recorded before the preset existed has none of it');
  assert.equal(factOf(older, 'monitor.quote.bEst'), '0', 'and every other fact it holds');
  const earlier = renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(5), { quote: { ...quote, todoEst: 120 } }), t }));
  assert.deepEqual(factsOf(earlier), factsOf(html), 'the todo estimate of an earlier seal is listed no more');

  const none = renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(3)), t }));
  assert.match(none, /data-sw-monitor-notice="quote-none"/);
  assert.ok(none.includes('monitor.quote.none'));
});

test('the quote page shows the kappa the producer\'s quote was compared with, as the snapshot holds it and not a fixed tolerance, a kappa under 1 included', () => {
  const estimateOf = (n, lA) => ({ n, lA, bEst: 0, cEst: 200 * n, sEst: lA - 200 * n });
  const kappaOf = quote => factOf(renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(1), { quote }), t })), 'monitor.quote.kappa');
  assert.equal(kappaOf(innerQuote({ n: 8, estimate: estimateOf(8, 12400), cRatio: 30, preset: 'E2' })), '1.099');
  assert.equal(kappaOf(innerQuote({ n: 8, estimate: estimateOf(8, 300_000), cRatio: 12.5, preset: 'E2' })), '0.952');
});

test('in each locale the call drawer names its summaries and evidence tabs by those words and its quote tab by the estimate', () => {
  const tabsOf = (dictionary) => [...renderToString(React.createElement(CallDetail, { detail: callPayload(attemptRow(1)), monitor: monitorAt(null), attemptId: 1, now: NOW, t: localized(dictionary) }))
    .matchAll(/<button\b[^>]*role="tab"[^>]*data-page="(\w+)"[^>]*>(.*?)<\/button>/g)].map(([, page, label]) => [page, label]);
  assert.deepEqual(tabsOf(zh), [['overview', '概览'], ['request', '请求'], ['response', '响应'], ['summaries', '摘要'], ['carried', '证据'], ['quote', '估算'], ['usage', '用量'], ['timing', '时间']]);
  assert.deepEqual(tabsOf(en), [['overview', 'Overview'], ['request', 'Request'], ['response', 'Response'], ['summaries', 'Summaries'], ['carried', 'Evidence'], ['quote', 'Estimate'], ['usage', 'Usage'], ['timing', 'Timing']]);
});

test('in each locale the quote page labels its facts in the user\'s words, names the preset it was priced under and lists none of the formula\'s intermediates', () => {
  const quote = { n: 8, lA: 12400, bEst: 0, cEst: 2400, sEst: 9880, cRatio: 30, fee: 5000, kappa: 1.1, preset: 'E2', nRef: 15, N: 21.96, jRef: 28.868902300206646, q: 1.0377949146956498, arm: 'left', trigger: 'quote' };
  const pageOf = (dictionary, overrides = {}) => factsOf(renderToString(React.createElement(QuotePage, { detail: callPayload(attemptRow(1), { quote: { ...quote, ...overrides } }), t: localized(dictionary) })));
  assert.deepEqual(pageOf(zh), [
    ['步数', '8'], ['待压缩 token', '12400'], ['估算证据 token', '0'], ['估算摘要 token', '2400'], ['估算节省 token', '9880'],
    ['缓存写读价比', '30'], ['固定开销 token', '5000'], ['压缩策略', '极激进'], ['提前触发容差', '1.1'], ['偏离度', '1.038'], ['相对参考的一侧', '左侧'],
  ]);
  assert.deepEqual(pageOf(en), [
    ['Steps', '8'], ['Tokens to compact', '12400'], ['Estimated evidence tokens', '0'], ['Estimated summary tokens', '2400'], ['Estimated saved tokens', '9880'],
    ['Cache write-to-read price ratio', '30'], ['Fixed overhead tokens', '5000'], ['Compaction policy', 'Most aggressive'], ['Early-trigger tolerance', '1.1'], ['Deviation', '1.038'], ['Side of the reference', 'Left'],
  ]);
  const names = { E2: ['极激进', 'Most aggressive'], W2: ['激进', 'Aggressive'], M2: ['均衡', 'Balanced'], S3: ['保守', 'Conservative'], X3: ['极保守', 'Most conservative'] };
  for (const [id, [zhName, enName]] of Object.entries(names)) {
    assert.deepEqual(pageOf(zh, { preset: id }).find(([term]) => term === '压缩策略'), ['压缩策略', zhName], id);
    assert.deepEqual(pageOf(en, { preset: id }).find(([term]) => term === 'Compaction policy'), ['Compaction policy', enName], id);
  }
  for (const preset of [undefined, 'Z9']) {
    assert.deepEqual(pageOf(zh, { preset }).find(([term]) => term === '压缩策略'), ['压缩策略', '未记录']);
    assert.deepEqual(pageOf(en, { preset }).find(([term]) => term === 'Compaction policy'), ['Compaction policy', 'Not recorded']);
  }
  assert.deepEqual(pageOf(en, { trigger: null }), pageOf(en), 'a quote with no trigger lists as any other');
});

test('the carried page of a committed attempt lists the evidence its carrier states as the host answers it in structure, each file folded to its row, the removed paths and the skills after them, and has the carrier\'s wording and its whole text as two folds at its foot', { skip }, async () => {
  const conv = conversation();
  const changes = {
    paths: [{ path: '/r/a.txt', displayPath: '/shown/a.txt', totalLines: 9, state: 'readable', write: [[1, 'one <b>'], [2, 'two']], withdraw: [3] }],
    skills: [{ name: 'tdd', text: 'Test first.\nThen build.' }],
    removed: ['/shown/gone.txt'],
  };
  const { start, log } = attemptOver(conv, { changes });
  const detail = await callOf(log, start.seq);

  const html = pageHtml(CarriedPage, detail);

  const element = CarriedPage({ detail, t });
  assert.deepEqual([element.type, element.props.carried], [CarriedFiles, detail.carried], 'the list is handed the carrier\'s whole answer');
  assert.deepEqual(Object.keys(detail.carried), ['text', 'note', 'files', 'removed', 'skills']);
  assert.deepEqual([...html.matchAll(/class="sw-fl-path" title="([^"]*)"/g)].map(([, path]) => path), ['a.txt', 'gone.txt', 'tdd'], 'the paths are relative to the root of the shown path and the removed path; the name of a skill is as it is');
  assert.equal(textOf(/<p class="sw-fl-sub">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.sub.root(root=/shown) · monitor.files.sub.more(parts=monitor.files.sub.skills(count=1) · monitor.files.sub.gone(count=1))');
  assert.deepEqual([...html.matchAll(/<span class="sw-fl-cnt">(.*?)<\/span><span class="sw-fl-pv"/g)].map(([, count]) => textOf(count)), ['+2−1', 'monitor.files.lines(count=2)']);
  assert.deepEqual([...html.matchAll(/<button\b[^>]*class="sw-fl-foldbtn"[^>]*>(.*?)<\/button>/g)].map(([, label]) => textOf(label)), ['monitor.files.foot.note', 'monitor.files.foot.text']);
  assert.equal(html.includes('<pre') || html.includes('<b>'), false, 'nothing of the text is shown while the files and the foot are folded');
  assert.equal(html.includes('data-sw-monitor-notice'), false);
});

test('the carried page keeps a removed path in the form the host recorded it, whole where it shares no root with the shown path of a file', { skip }, async () => {
  const conv = conversation();
  const changes = {
    paths: [{ path: '/r/a.txt', displayPath: '/shown/a.txt', totalLines: 9, state: 'readable', write: [[1, 'one']], withdraw: [] }],
    skills: [],
    removed: ['/r/gone.txt'],
  };
  const { start, log } = attemptOver(conv, { changes });

  const html = pageHtml(CarriedPage, await callOf(log, start.seq));

  assert.deepEqual([...html.matchAll(/class="sw-fl-path" title="([^"]*)"/g)].map(([, path]) => path), ['/shown/a.txt', '/r/gone.txt']);
  assert.equal(textOf(/<p class="sw-fl-sub">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.sub.more(parts=monitor.files.sub.gone(count=1))');
});

test('the carried page of a committed attempt whose carrier changed no evidence says so, and one that has not committed says the evidence comes with the commit; neither shows an empty block', { skip }, async () => {
  const conv = conversation();
  const bare = attemptOver(conv);
  const detail = await callOf(bare.log, bare.start.seq);
  assert.equal(detail.carried, null, 'a carrier with no B in a real log');
  const none = pageHtml(CarriedPage, detail);
  assert.match(none, /data-sw-monitor-notice="carried-none"/);
  assert.ok(none.includes('monitor.carried.none'));
  assert.equal(none.includes('<pre'), false);

  const failedAttempt = attemptOver(conv, { end: { outcome: 'failed', reason: 'refused' }, committed: false });
  const pending = pageHtml(CarriedPage, await callOf(failedAttempt.log, failedAttempt.start.seq));
  assert.match(pending, /data-sw-monitor-notice="carried-pending"/);
  assert.ok(pending.includes('monitor.carried.pending'));
  assert.equal(pending.includes('<pre') || pending.includes('monitor.carried.none'), false);

  const running = pageHtml(CarriedPage, callPayload(attemptRow(5, { status: 'generating', slots: null })));
  assert.match(running, /data-sw-monitor-notice="carried-pending"/, 'an attempt in progress has no carrier yet');
});

test('characterization: every status an attempt can have shows a text of its own on its parent row, and every state its call can have on the overview', () => {
  const statuses = ['generating', 'validating', 'committed', 'failed', 'cancelled', 'unknown'];
  const callStates = ['generating', 'received', 'error', 'absent'];
  const attempts = statuses.map((status, at) => attemptRow(11 + at, { status, call: { state: callStates[at % callStates.length] } }));
  let state = createViewState();
  for (const attempt of attempts.slice(0, -1)) state = reduceView(state, { type: 'toggle', attemptId: attempt.id, open: false });

  const rows = parseRows(renderList(attempts, { state }));

  assert.deepEqual(rows.filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.status), statuses.map(status => `monitor.status.${status}`));
  for (const callState of callStates) {
    const row = attemptRow(11, { call: { state: callState } });
    assert.equal(factOf(pageHtml(OverviewPage, callPayload(row)), 'monitor.overview.callState'), `monitor.callState.${callState}`, callState);
  }
});

test('the overview of a call read from the log by the host\'s own monitor access names the evidence its record kept, and one whose record never held it reads as not observed', { skip }, async () => {
  const conv = conversation();
  const observed = attemptOver(conv, { carrierCache: { results: [{ result: 'skipped', reason: 'no-native-point' }, { result: 'added' }], omitted: 0 } });
  const html = renderToString(React.createElement(OverviewPage, { detail: await callOf(observed.log, observed.start.seq), t }));
  assert.ok(html.includes('data-sw-carrier-cache'), html);
  assert.deepEqual([...html.matchAll(/<li\b[^>]*data-result="(\w+)"/g)].map(([, result]) => result), ['skipped', 'added']);
  assert.ok(textOf(html).includes('monitor.carrierCache.skipped(reason=monitor.carrierCache.reason.no-native-point)'));

  const earlier = attemptOver(conv);
  assert.equal(factOf(renderToString(React.createElement(OverviewPage, { detail: await callOf(earlier.log, earlier.start.seq), t })), 'monitor.overview.carrierCache'), 'monitor.carrierCache.unobserved');
});

test('the overview names what the carrier cache did for the call\'s request, one line per serialization in order: the point added, the native point at the same position reused, the check that added none with its reason, and a call nothing was observed for', () => {
  const overview = (carrierCache, call = {}) => pageHtml(OverviewPage, callPayload(attemptRow(21, { call: { ...call, ...(carrierCache === undefined ? {} : { carrierCache }) } })));
  const lines = html => [...html.matchAll(/<li\b[^>]*data-result="(\w+)"[^>]*>(.*?)<\/li>/g)].map(([, result, text]) => [result, textOf(text)]);

  assert.equal(factOf(overview(undefined), 'monitor.overview.carrierCache'), 'monitor.carrierCache.unobserved', 'a call with no evidence');
  assert.deepEqual(lines(overview(undefined)), []);

  const added = overview({ results: [{ result: 'added' }], omitted: 0 });
  assert.deepEqual(lines(added), [['added', 'monitor.carrierCache.added']]);
  assert.equal(factOf(added, 'monitor.overview.carrierCache'), 'monitor.carrierCache.added');

  assert.deepEqual(lines(overview({ results: [{ result: 'native' }], omitted: 0 })), [['native', 'monitor.carrierCache.native']]);

  const reasons = SKIP_REASONS;
  const skipped = overview({ results: reasons.map(reason => ({ result: 'skipped', reason })), omitted: 0 });
  assert.deepEqual(lines(skipped), reasons.map(reason => ['skipped', `monitor.carrierCache.skipped(reason=monitor.carrierCache.reason.${reason})`]));

  const several = overview({ results: [{ result: 'skipped', reason: 'points-full' }, { result: 'added' }, { result: 'native' }], omitted: 2 });
  assert.deepEqual(lines(several), [
    ['skipped', 'monitor.carrierCache.skipped(reason=monitor.carrierCache.reason.points-full)'], ['added', 'monitor.carrierCache.added'], ['native', 'monitor.carrierCache.native'],
    ['omitted', 'monitor.carrierCache.omitted(count=2)'],
  ], 'the order the requests were serialized in, then what the bound left out');
  assert.equal(textOf(added).includes('monitor.carrierCache.omitted'), false);
});

// A compaction that cut 74000 tokens and rebuilt 8000, its summary call having read 48000 tokens from the cache and taken 1000 more, under a price ratio of 12, pays back within two later steps; the next compaction summarizes two.
const paidPair = () => [
  attemptRow(1, { stepN: 8, contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 }, cRatio: 12, call: { usage: { input: 400, output: 2_400, cacheRead: 48_000, cacheWrite: 600 } } }),
  attemptRow(2, { stepN: 2, contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 }, cRatio: 12, call: { usage: { input: 400, output: 2_400, cacheRead: 48_000, cacheWrite: 600 } } }),
];

test('a compaction that paid back reads paid on its parent row and in the drawer\'s overview, and the compactions that have not keep their status', () => {
  const attempts = paidPair();
  const rows = parseRows(renderList(attempts)).filter(row => row.attributes['data-sw-row'] === 'attempt');
  assert.deepEqual(rows.map(row => row.parts.status), ['monitor.status.paid', 'monitor.status.committed']);
  assert.match(rows[0].markup, /data-status="paid"/);
  assert.match(rows[1].markup, /data-status="committed"/);

  const resources = { [callKey(1)]: { kind: 'ready', value: callPayload(attempts[0]) }, [callKey(2)]: { kind: 'ready', value: callPayload(attempts[1]) } };
  const split = id => renderSplit(attempts, resources, { state: selectCall(id) }).html;
  assert.equal(factOf(split(1), 'monitor.overview.status'), 'monitor.status.paid');
  assert.match(split(1), /<span class="sw-mon-status" data-status="paid">/);
  assert.equal(factOf(split(2), 'monitor.overview.status'), 'monitor.status.committed');

  const alone = payback => factOf(renderDrawer(selectCall(1), resources, { ordinals: { 1: { epoch: 1, ordinal: 1 } }, payback }), 'monitor.overview.status');
  assert.equal(alone(new Map([[1, 100]])), 'monitor.status.paid');
  assert.equal(alone(new Map([[1, 99]])), 'monitor.status.committed');
  assert.equal(alone(new Map()), 'monitor.status.committed');
  assert.equal(alone(undefined), 'monitor.status.committed', 'a drawer given no progress shows the status as the host gave it');
});

test('the overview of a committed compaction lists its payback progress under its status, the percent rising past a whole, none where the progress is not known, and no such line for an attempt that is not committed', () => {
  const attempts = paidPair();
  const resources = { [callKey(1)]: { kind: 'ready', value: callPayload(attempts[0]) }, [callKey(2)]: { kind: 'ready', value: callPayload(attempts[1]) } };
  const split = id => factsOf(renderSplit(attempts, resources, { state: selectCall(id) }).html);
  assert.deepEqual(split(1).slice(0, 2), [['monitor.overview.status', 'monitor.status.paid'], ['monitor.overview.payback', '100%']]);
  assert.deepEqual(split(2).slice(0, 2), [['monitor.overview.status', 'monitor.status.committed'], ['monitor.overview.payback', '0%']], 'the latest compaction has no step after it yet');

  const alone = (row, payback) => factsOf(renderDrawer(selectCall(row.id), { [callKey(row.id)]: { kind: 'ready', value: callPayload(row) } }, { payback }));
  assert.deepEqual(alone(attempts[0], new Map([[1, 250]]))[1], ['monitor.overview.payback', '250%'], 'no ceiling');
  assert.deepEqual(alone(attempts[0], new Map([[1, 7]]))[1], ['monitor.overview.payback', '7%']);
  assert.deepEqual(alone(attempts[0], new Map([[1, null]]))[1], ['monitor.overview.payback', '—']);
  assert.deepEqual(alone(attempts[0], undefined)[1], ['monitor.overview.payback', '—'], 'a drawer given no progress shows none');
  for (const status of ['generating', 'validating', 'failed', 'cancelled', 'unknown']) {
    assert.equal(alone(attemptRow(3, { status, slots: null }), new Map([[3, 100]])).some(([term]) => term === 'monitor.overview.payback'), false, status);
  }
});

test('a compaction that paid back is still a committed one for the list: its open group reads its slots and lists their rows', () => {
  const attempts = paidPair();
  const opened = renderSplit(attempts, { [slotsKey(1)]: readySlots([slotRow(10)]), [slotsKey(2)]: readySlots([slotRow(20)]) }, { state: opening(1) });
  assert.equal(parseRows(opened.html).find(row => row.attributes['data-identity'] === 'attempt:1').parts.status, 'monitor.status.paid');
  assert.deepEqual(parseRows(opened.html).map(row => row.attributes['data-identity']), ['attempt:1', 'call:1', 'slot:1:10', 'attempt:2']);
  assert.ok(opened.touched.includes(slotsKey(1)));
});

// ── The handoff rows ──────────────────────────────────────────────────────────

const handoffKey = handoff => resourceKey({ endpoint: 'inner-monitor/handoff', handoff });
const readyHandoff = (row, overrides) => ({ kind: 'ready', value: handoffPayload(row, overrides) });
/** A view state with the groups of the handoffs `ids` opened. */
const openingHandoffs = (...ids) => ids.reduce((state, handoffId) => reduceView(state, { type: 'toggle', handoffId, open: false }), createViewState());
const rowIds = html => parseRows(html).map(row => row.attributes['data-identity']);
const TURNS = [{ address: 'S1:1', user: 'first\nline', note: 'a note' }, { address: null, user: 'second', note: null }, { address: 'S1:3', user: 'third', note: '' }];

function renderHandoffList(attempts, handoffs, { state = createViewState(), turns = {}, dispatch = () => {} } = {}) {
  return renderToString(React.createElement(MonitorList, { rows: flattenRows(attempts, {}, state, handoffs, turns), selected: state.selected?.identity ?? null, now: NOW, dispatch, t }));
}

test('a handoff is one parent row among the compactions in the order of their ids, titled by its segment with no ordinal and no status, and the compactions\' ordinals count no handoff', () => {
  const rows = parseRows(renderHandoffList([attemptRow(1), attemptRow(9)], [handoffRow(5, { epoch: 1 })]));
  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['attempt:1', 'handoff:5', 'attempt:9']);
  assert.deepEqual(rows.map(row => row.attributes['data-sw-row']), ['attempt', 'handoff', 'attempt']);
  assert.deepEqual(rows.map(row => row.attributes['aria-level']), ['1', '1', '1']);
  assert.deepEqual(rows.map(row => row.attributes['aria-expanded']), ['false', 'false', 'false']);
  assert.deepEqual(rows.map(row => row.parts.title), ['monitor.object.attempt(epoch=1,ordinal=1)', 'monitor.object.handoff(epoch=2)', 'monitor.object.attempt(epoch=1,ordinal=2)']);
  assert.equal(rows[1].parts.status, undefined, 'a handoff has no status word');
  assert.equal(rows[1].attributes['data-sw-attention'], undefined);
  assert.equal(parseRows(renderHandoffList([], [handoffRow(5, { epoch: 0 })]))[0].parts.title, 'monitor.object.handoff(epoch=1)');
});

test('a handoff\'s meta reads in the fixed slots, its type and token as they are, a load\'s context slots as dashes and a continue\'s from its change', () => {
  const [load] = parseRows(renderHandoffList([], [handoffRow(5)]));
  assert.deepEqual(Object.keys(load.parts), ['title', 'type', 'token', 'files', 'skills', 'lineage', 'range', 'context', 'seq']);
  assert.deepEqual(load.parts, {
    title: 'monitor.object.handoff(epoch=2)',
    type: 'monitor.handoff.type.load',
    token: 'tok-abc',
    files: 'monitor.handoff.meta.files(read=3,kept=5)',
    skills: 'monitor.handoff.meta.skills(count=2)',
    lineage: 'monitor.handoff.meta.lineage(count=4)',
    range: '—',
    context: '—',
    seq: 'monitor.overview.seq(seq=5)',
  });
  const [resumed] = parseRows(renderHandoffList([], [handoffRow(5, { type: 'continue', contextChange: { before: 460, after: 710, delta: 250, miss: 510 } })]));
  assert.equal(resumed.parts.type, 'monitor.handoff.type.continue');
  assert.equal(resumed.parts.range, 'monitor.handoff.meta.range(before=460,after=710)');
  assert.equal(resumed.parts.context, 'monitor.change.increase(count=250)');
  assert.equal(resumed.parts.miss, undefined, 'the cache rebuild is no slot of a handoff');
  const [bare] = parseRows(renderHandoffList([], [handoffRow(5, { createdAt: null, read: null, lineage: null, type: 'continue', contextChange: { before: 460, after: null, delta: null, miss: null } })]));
  assert.deepEqual([bare.parts.files, bare.parts.lineage, bare.parts.range, bare.parts.context], ['—', '—', `monitor.handoff.meta.range(before=460,after=—)`, '—']);
});

test('a handoff\'s type slot carries its type for colouring, a load\'s and a continue\'s each its own, and no other slot does', () => {
  for (const type of ['load', 'continue']) {
    const [row] = parseRows(renderHandoffList([], [handoffRow(5, { type })]));
    assert.match(row.titles.type, new RegExp(`data-type="${type}"`));
    assert.deepEqual(Object.keys(row.titles).filter(part => row.titles[part].includes('data-type')), ['type']);
  }
});

test('a closed handoff previews its next task on the parent, an open one on its content row after it, and a handoff with no next task has no preview', () => {
  const closed = parseRows(renderHandoffList([], [handoffRow(5)]));
  assert.equal(previewsOf(closed[0]).output, 'ship the handoff rows');
  assert.equal(closed[0].preview.includes('data-sw-empty'), false);
  const open = parseRows(renderHandoffList([], [handoffRow(5)], { state: openingHandoffs(5) }));
  assert.equal(open[0].preview, undefined, 'the open parent shows none');
  assert.equal(open[1].attributes['data-sw-row'], 'content');
  assert.equal(open[1].parts.title, 'monitor.object.handoffContent');
  assert.equal(open[1].attributes['aria-level'], '2');
  assert.equal(previewsOf(open[1]).output, 'ship the handoff rows');
  assert.equal(parseRows(renderHandoffList([], [handoffRow(5, { nextTask: null })]))[0].preview, undefined);
  const withoutTask = parseRows(renderHandoffList([], [handoffRow(5, { nextTask: null })], { state: openingHandoffs(5) }));
  assert.equal(withoutTask[1].preview, undefined);
});

test('an open handoff lists a leaf row per turn of its loaded detail, the user on the left and the note on the right, a missing note and an empty one each reading their neutral marker', () => {
  const rows = parseRows(renderHandoffList([], [handoffRow(5)], { state: openingHandoffs(5), turns: { 5: TURNS } }));
  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['handoff:5', 'content:5', 'turn:5:0', 'turn:5:1', 'turn:5:2']);
  assert.deepEqual(rows.slice(2).map(row => row.attributes['data-sw-row']), ['turn', 'turn', 'turn']);
  assert.deepEqual(rows.slice(2).map(row => row.attributes['aria-level']), ['2', '2', '2']);
  assert.deepEqual(rows.slice(2).map(row => row.parts.title), ['monitor.object.handoffTurn(n=1)', 'monitor.object.handoffTurn(n=2)', 'monitor.object.handoffTurn(n=3)']);
  assert.deepEqual(rows.slice(2).map(previewsOf), [
    { input: 'first line', output: 'a note' },
    { input: 'second', output: 'monitor.handoff.turn.noNote' },
    { input: 'third', output: 'monitor.slot.empty' },
  ]);
  assert.deepEqual(rows.slice(2).map(row => row.preview.includes('data-sw-empty')), [false, true, true]);
  assert.deepEqual(rowIds(renderHandoffList([], [handoffRow(5)], { state: openingHandoffs(5) })), ['handoff:5', 'content:5'], 'no turns before the detail is loaded');
  assert.deepEqual(rowIds(renderHandoffList([], [handoffRow(5)], { turns: { 5: TURNS } })), ['handoff:5'], 'a closed group lists none');
});

test('a click on a handoff row toggles its group and a click on its content or a turn row selects it by its identity, the selection staying under a collapsed group', () => {
  let state = openingHandoffs(5);
  const dispatch = (action) => { state = reduceView(state, action); };
  const elements = MonitorList({ rows: flattenRows([], {}, state, [handoffRow(5)], { 5: TURNS }), selected: null, now: NOW, dispatch, t }).props.children;
  const rows = elements.map(element => element.type(element.props));
  rows[1].props.onClick();
  assert.equal(state.selected.identity, 'content:5');
  rows[3].props.onClick();
  assert.equal(state.selected.identity, 'turn:5:1');
  assert.equal(isOpen(state, 5), true);
  rows[0].props.onClick();
  assert.equal(isOpen(state, 5), false, 'the parent toggles its group');
  assert.equal(state.selected.identity, 'turn:5:1', 'and the selection stays');
  assert.equal(rows[0].props['aria-expanded'], true);
  assert.equal(rows[0].props.tabIndex, undefined, 'a parent is no selection target');
  assert.equal(rows[2].props.tabIndex, 0);
});

test('the list reads the detail of the expanded handoffs alone and lists their turn rows between the content row and the next parent', () => {
  const handoffs = [handoffRow(5), handoffRow(6)];
  const resources = { [handoffKey(5)]: readyHandoff(handoffs[0]), [handoffKey(6)]: readyHandoff(handoffs[1]) };
  const handoffReads = ({ touched }) => touched.filter(key => key.includes('inner-monitor/handoff'));
  const byDefault = renderSplit([], resources, { handoffs });
  assert.deepEqual(rowIds(byDefault.html), ['handoff:5', 'handoff:6']);
  assert.deepEqual(handoffReads(byDefault), [], 'a closed group costs no read');
  const second = renderSplit([], resources, { handoffs, state: openingHandoffs(6) });
  assert.deepEqual(rowIds(second.html), ['handoff:5', 'handoff:6', 'content:6', 'turn:6:0', 'turn:6:1']);
  assert.deepEqual(handoffReads(second), [handoffKey(6)], 'only the opened group is read');
  const loading = renderSplit([], {}, { handoffs, state: openingHandoffs(5) });
  assert.deepEqual(rowIds(loading.html), ['handoff:5', 'content:5', 'placeholder:5', 'handoff:6'], 'a placeholder stands in for the turn rows before the detail arrives');
});

// ── The placeholder row ───────────────────────────────────────────────────────

const WHAT = { turns: 'what=monitor.leaves.turns', summaries: 'what=monitor.leaves.summaries' };

test('an open group\'s placeholder row is a leaf row with a spinner while its leaves are being read, and its own text where they could not be read or are none, in the words of its group\'s leaves', () => {
  const handoffRows = leaves => parseRows(renderHandoffList([], [handoffRow(5)], { state: openingHandoffs(5), turns: { 5: leaves } }));
  const attemptRows = leaves => parseRows(renderList([attemptRow(1)], { slots: { 1: leaves }, state: opening(1) }));
  const expected = {
    loading: [LEAVES_LOADING, 'monitor.leaves.loading'],
    failed: [LEAVES_FAILED, 'monitor.leaves.failed'],
    empty: [[], 'monitor.leaves.empty'],
  };
  for (const [state, [leaves, key]] of Object.entries(expected)) {
    for (const [rows, what, id] of [[handoffRows(leaves), WHAT.turns, 5], [attemptRows(leaves), WHAT.summaries, 1]]) {
      const row = rows.at(-1);
      assert.equal(row.attributes['data-identity'], `placeholder:${id}`, state);
      assert.equal(row.attributes['data-sw-row'], 'placeholder');
      assert.equal(row.attributes['data-sw-placeholder'], state);
      assert.equal(row.attributes['aria-level'], '2', 'a leaf row');
      assert.deepEqual(row.parts, { text: `${key}(${what})` }, `${state}: its text alone, no title`);
      assert.equal(row.preview, undefined);
      assert.equal(row.markup.includes('sw-mon-spinner'), state === 'loading', `${state}: only a read in progress spins`);
    }
  }
  assert.deepEqual(handoffRows(TURNS).map(row => row.attributes['data-sw-row']), ['handoff', 'content', 'turn', 'turn', 'turn'], 'a list of turns has no placeholder');
});

test('a placeholder row is none of the selectable rows: it has no click, no focus, no selection and no toggle', () => {
  let state = openingHandoffs(5);
  const dispatched = [];
  const dispatch = (action) => { dispatched.push(action); state = reduceView(state, action); };
  const elements = MonitorList({ rows: flattenRows([], {}, state, [handoffRow(5)], { 5: LEAVES_LOADING }), selected: null, now: NOW, dispatch, t }).props.children;
  const placeholder = elements.map(element => element.type(element.props)).at(-1);
  assert.equal(placeholder.props['data-sw-row'], 'placeholder');
  assert.equal(placeholder.props.onClick, undefined);
  assert.equal(placeholder.props.onKeyDown, undefined);
  assert.equal(placeholder.props.tabIndex, undefined);
  assert.equal(placeholder.props['aria-selected'], undefined);
  assert.equal(placeholder.props['aria-expanded'], undefined);
  assert.deepEqual(dispatched, []);
});

test('the list shows a placeholder for the leaves of an expanded group by how their read stands: reading while the answer has not come, failed where it is unavailable or unreachable, empty where it holds none, and the leaves themselves once it holds some', () => {
  const handoffs = [handoffRow(5)];
  const stateOf = html => parseRows(html).find(row => row.attributes['data-sw-row'] === 'placeholder')?.attributes['data-sw-placeholder'] ?? null;
  const turnsOf = resource => stateOf(renderSplit([], resource === undefined ? {} : { [handoffKey(5)]: resource }, { handoffs, state: openingHandoffs(5) }).html);
  assert.equal(turnsOf(undefined), 'loading');
  assert.equal(turnsOf({ kind: 'unavailable' }), 'failed');
  assert.equal(turnsOf({ kind: 'unreachable', message: 'HTTP 502' }), 'failed');
  assert.equal(turnsOf(readyHandoff(handoffs[0], { turns: [] })), 'empty');
  assert.equal(turnsOf(readyHandoff(handoffs[0])), null);

  const slotsOf = resource => stateOf(renderSplit([attemptRow(1)], resource === undefined ? {} : { [slotsKey(1)]: resource }, { state: opening(1) }).html);
  assert.equal(slotsOf(undefined), 'loading');
  assert.equal(slotsOf({ kind: 'unavailable' }), 'failed');
  assert.equal(slotsOf({ kind: 'unreachable', message: 'HTTP 502' }), 'failed');
  assert.equal(slotsOf(readySlots([])), 'empty');
  assert.equal(slotsOf(readySlots([slotRow(10)])), null);

  const two = renderSplit([], { [handoffKey(5)]: readyHandoff(handoffs[0], { turns: [] }), [handoffKey(6)]: { kind: 'unavailable' } }, { handoffs: [handoffs[0], handoffRow(6)], state: openingHandoffs(5, 6) });
  assert.deepEqual(rowIds(two.html), ['handoff:5', 'content:5', 'placeholder:5', 'handoff:6', 'content:6', 'placeholder:6'], 'each group stands on its own read');
  assert.deepEqual(parseRows(two.html).filter(row => row.attributes['data-sw-row'] === 'placeholder').map(row => row.attributes['data-sw-placeholder']), ['empty', 'failed']);
});

test('a session with handoffs and no compaction is listed and one with neither says it has no events', () => {
  const html = renderView(monitorAt({ kind: 'ready', attempts: [], handoffs: [handoffRow(5)] }));
  assert.deepEqual(rowIds(html), ['handoff:5']);
  assert.equal(html.includes('monitor.rows.empty'), false);
  assert.ok(renderView(monitorAt({ kind: 'ready', attempts: [], handoffs: [] })).includes('data-sw-monitor-notice="rows-empty"'));
  assert.deepEqual(rowIds(renderView(monitorAt({ kind: 'ready', attempts: [attemptRow(1)], handoffs: [] }))), ['attempt:1']);
});

// ── The handoff drawers ───────────────────────────────────────────────────────

const selectHandoff = (kind, handoffId, turn) => reduceView(createViewState(), { type: 'select', kind, handoffId, turn });

function renderHandoffDrawer(state, resources = {}, { handoffs = [handoffRow(5)], dictionary } = {}) {
  return renderToString(React.createElement(MonitorDrawer, { state, monitor: monitorAt(null, resources), ordinals: {}, handoffs, now: NOW, dispatch: () => {}, t: dictionary === undefined ? t : localized(dictionary) }));
}

const tabsOfHtml = html => [...html.matchAll(/<button\b[^>]*role="tab"[^>]*data-page="(\w+)"[^>]*>(.*?)<\/button>/g)].map(([, page, label]) => [page, label]);

test('in each locale the handoff drawer is titled by its segment with the handoff id beside it and offers its pages in order, the lineage page only on a load', () => {
  const load = renderHandoffDrawer(selectHandoff('content', 5), { [handoffKey(5)]: readyHandoff(handoffRow(5)) }, { dictionary: zh });
  assert.match(load, /<h2\b[^>]*>分段#2交接<\/h2>/);
  assert.equal(subtitleOf(load), '交接ID：5');
  assert.match(load, /data-kind="content"/);
  assert.deepEqual(tabsOfHtml(load), [['overview', '概览'], ['summary', '摘要'], ['files', '文件'], ['turns', '回合'], ['lineage', '谱系']]);
  assert.match(load, /role="tabpanel"[^>]*data-page="overview"/, 'the drawer opens at its first page');
  const loadEn = renderHandoffDrawer(selectHandoff('content', 5), { [handoffKey(5)]: readyHandoff(handoffRow(5)) }, { dictionary: en });
  assert.match(loadEn, /<h2\b[^>]*>Handoff of segment #2<\/h2>/);
  assert.equal(subtitleOf(loadEn), 'Handoff ID: 5');
  assert.deepEqual(tabsOfHtml(loadEn).map(([page]) => page), ['overview', 'summary', 'files', 'turns', 'lineage']);
  const resumed = readyHandoff(handoffRow(5, { type: 'continue' }), { lineage: null });
  assert.deepEqual(tabsOfHtml(renderHandoffDrawer(selectHandoff('content', 5), { [handoffKey(5)]: resumed }, { dictionary: zh })), [['overview', '概览'], ['summary', '摘要'], ['files', '文件'], ['turns', '回合']]);
  assert.match(renderHandoffDrawer(selectHandoff('content', 5), {}, { handoffs: [], dictionary: zh }), /<h2\b[^>]*>分段#—交接<\/h2>/, 'a handoff the rows do not list has no segment to name');
});

test('the handoff drawer reads its detail by the identity alone: loading before it arrives and its pages after, the drawer staying while the group is collapsed', () => {
  assert.ok(renderHandoffDrawer(selectHandoff('content', 5)).includes('data-sw-monitor-notice="detail-loading"'));
  assert.ok(renderHandoffDrawer(selectHandoff('content', 5), { [handoffKey(5)]: { kind: 'unreachable', message: 'boom' } }).includes('monitor.detail.unreachable(message=boom)'));
  assert.equal(renderHandoffDrawer(selectHandoff('content', 5), { [handoffKey(5)]: readyHandoff(handoffRow(5)) }).includes('data-page="overview"'), true);
  assert.equal(renderHandoffDrawer(selectHandoff('content', 6), { [handoffKey(5)]: readyHandoff(handoffRow(5)) }).includes('data-page="overview"'), false, 'another handoff is not shown this one\'s detail');
  const collapsed = renderSplit([], { [handoffKey(5)]: readyHandoff(handoffRow(5)) }, { handoffs: [handoffRow(5)], state: selectHandoff('content', 5) });
  assert.deepEqual(rowIds(collapsed.html), ['handoff:5']);
  assert.match(collapsed.html, /data-sw-monitor-drawer="" data-kind="content"/);
});

test('the overview page lists the handoff\'s type, token, preparation and delivery times, payload seq, files, skills and the tokens before and after, a dash or the not-recorded text where it has none', () => {
  const load = factsOf(pageHtml(HandoffOverviewPage, handoffPayload(handoffRow(5))));
  assert.deepEqual(load, [
    ['monitor.handoff.overview.type', 'monitor.handoff.type.load'],
    ['monitor.handoff.overview.token', 'tok-abc'],
    ['monitor.handoff.overview.createdAt', new Date(HANDOFF_TIME - 3 * 3_600_000).toISOString()],
    ['monitor.handoff.overview.deliveredAt', new Date(HANDOFF_TIME).toISOString()],
    ['monitor.handoff.overview.seq', 'monitor.overview.seq(seq=5)'],
    ['monitor.handoff.overview.filesRead', '3'],
    ['monitor.handoff.overview.filesKept', '5'],
    ['monitor.handoff.overview.skills', '2'],
    ['monitor.handoff.overview.before', '—'],
    ['monitor.handoff.overview.after', '—'],
  ]);
  const resumed = factsOf(pageHtml(HandoffOverviewPage, handoffPayload(handoffRow(5, { type: 'continue', createdAt: null, read: null, kept: null, contextChange: { before: 460, after: 710, delta: 250, miss: 510 } }))));
  assert.deepEqual(resumed.map(([, value]) => value), ['monitor.handoff.type.continue', 'tok-abc', 'monitor.notRecorded', new Date(HANDOFF_TIME).toISOString(), 'monitor.overview.seq(seq=5)', 'monitor.notRecorded', 'monitor.notRecorded', '2', '460 token', '710 token']);
});

test('the overview page\'s type value carries the handoff\'s type for colouring, and no other value does', () => {
  for (const type of ['load', 'continue']) {
    const html = pageHtml(HandoffOverviewPage, handoffPayload(handoffRow(5, { type })));
    assert.match(html, new RegExp(`<dd><span[^>]*data-type="${type}"[^>]*>monitor\\.handoff\\.type\\.${type}</span></dd>`));
    assert.equal(html.match(/data-type=/g).length, 1);
  }
});

test('the summary page shows the whole summary in a preformatted block, an empty one as the neutral marker', () => {
  const html = pageHtml(HandoffSummaryPage, handoffPayload(handoffRow(5), { summary: 'line one\n<b>two</b> & more' }));
  assert.equal(textOf(/<pre\b[^>]*>(.*?)<\/pre>/s.exec(sectionOf(html, 'summary'))[1]), 'line one\n<b>two</b> & more');
  assert.equal(html.includes('<b>'), false, 'the text is escaped');
  const empty = pageHtml(HandoffSummaryPage, handoffPayload(handoffRow(5), { summary: '' }));
  assert.ok(empty.includes('data-sw-empty') && empty.includes('monitor.slot.empty'));
});

test('the files page lists the files read folded to their rows under the root they share, a file the load recorded no lines of as a row of its own that says so, and a text of its own where no file was read', () => {
  const files = [
    { path: '/work/src/a.js', total: 30, runs: [{ offset: 3, lines: [{ number: 3, text: 'const a = 1;' }] }, { offset: 20, lines: [{ number: 20, text: 'x' }] }] },
    { path: '/work/old/b.js', total: null, runs: [] },
  ];
  const html = pageHtml(HandoffFilesPage, handoffPayload(handoffRow(5), { files }));
  assert.deepEqual([...html.matchAll(/class="sw-fl-path" title="([^"]*)"/g)].map(([, path]) => path), ['src/a.js', 'old/b.js']);
  assert.equal(textOf(/<p class="sw-fl-sub">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.sub.root(root=/work)');
  assert.equal(textOf(/<span class="sw-fl-cnt">(.*?)<\/span>/.exec(html)[1]), 'monitor.files.lines(count=2)');
  assert.equal(textOf(/<span class="sw-fl-why"[^>]*>(.*?)<\/span>/.exec(html)[1]), 'monitor.files.unrecorded');
  assert.equal(html.includes('monitor.handoff.files.none'), false);
  assert.equal(html.includes('const a = 1;'), false, 'a file shows its lines once it is opened');
  const none = pageHtml(HandoffFilesPage, handoffPayload(handoffRow(5), { files: [] }));
  assert.ok(none.includes('monitor.handoff.files.none'));
});

test('the files page over the files the host answers for a load the log holds: a read message with paths reads as its lines, one with none as a file with none, and the handoff\'s own detail keeps its shape', { skip }, async () => {
  const older = '<path>/repo/src/old.js</path>\n<type>file</type>\n<content>\n1: a\n\n(End of file - total 1 lines)\n</content>\n';
  const rendered = '/repo/src/a.js (total lines: 12)\n1: a\n2: b\n--\n9: i\n';
  const file = { path: '/repo/src/a.js', ranges: [{ offset: 1, limit: 2 }, { offset: 9, limit: 1 }], text: rendered, totalLines: 12, windows: [{ offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] }, { offset: 9, lines: [{ number: 9, text: 'i' }] }] };
  const detailOf = async (reads) => {
    const log = sessionLog([loadPayload({ handoffId: null, paths: ['/repo/src/a.js'] }), reads]);
    const access = createMonitorAccess({
      sessionOf: id => (id === SESSION ? {} : undefined), readMonitor: () => fold(log), live: () => [], kit,
      readSession: async () => ({ events: structuredClone(log) }), readStored: async () => undefined, nextTaskOf: () => null,
    });
    return wire(await access.handoff(SESSION, log[0].seq));
  };
  const withLines = await detailOf(loadReads({ files: [file] }));
  const withoutLines = await detailOf(loadMessage({ calls: [{ id: 'sw-load-0000aaaa-1', name: 'read', arguments: JSON.stringify({ file_path: '/repo/src/old.js', ranges: [{ offset: 1, limit: 1 }] }), text: older }] }));
  const detail = { ...withLines, files: [...withLines.files, ...withoutLines.files] };

  const html = pageHtml(HandoffFilesPage, detail);

  assert.deepEqual([...html.matchAll(/class="sw-fl-path" title="([^"]*)"/g)].map(([, path]) => path), ['a.js', 'old.js']);
  assert.equal(textOf(/<span class="sw-fl-cnt">(.*?)<\/span>/.exec(html)[1]), 'monitor.files.lines(count=3)');
  assert.equal(textOf(/<span class="sw-fl-why"[^>]*>(.*?)<\/span>/.exec(html)[1]), 'monitor.files.unrecorded');
  assert.ok(html.includes('monitor.files.segments(count=2)'));
  const open = renderToString(React.createElement(FilesView, { model: readFilesOf(detail.files, t), state: reduceFiles(createFilesState(), { type: 'expand', ids: ['read:0'] }), dispatch: () => {}, t }));
  assert.deepEqual([...open.matchAll(/<div class="sw-fl-n">(.*?)<\/div><div class="sw-fl-t">(.*?)<\/div>/g)].map(([, number, text]) => [number, text]), [['1', 'a'], ['2', 'b'], ['9', 'i']]);
});

test('the turns page shows the turn page whole and the not-recorded text where there is none', () => {
  const page = 'S1:1 U: first\nS1:1 A: <note> & more';
  const html = pageHtml(HandoffTurnsPage, handoffPayload(handoffRow(5), { turnPage: page }));
  assert.equal(textOf(/<pre\b[^>]*>(.*?)<\/pre>/s.exec(html)[1]), page);
  const none = pageHtml(HandoffTurnsPage, handoffPayload(handoffRow(5), { turnPage: null, turns: [] }));
  assert.equal(none.includes('<pre'), false);
  assert.ok(none.includes('monitor.notRecorded'));
});

test('the lineage page lists each member\'s headline by its label, an omitted stretch by its label alone, and reads not recorded where the handoff has none', () => {
  assert.deepEqual(factsOf(pageHtml(HandoffLineagePage, handoffPayload(handoffRow(5)))), [['S1', 'first session'], ['S2-S3', 'monitor.handoff.lineage.omitted']]);
  assert.ok(pageHtml(HandoffLineagePage, handoffPayload(handoffRow(5), { lineage: null })).includes('monitor.notRecorded'));
});

test('in each locale the turn drawer is one page without tabs, titled by its segment with the turn\'s address beside it where it has one, and shows the user and the note whole', () => {
  const resources = { [handoffKey(5)]: readyHandoff(handoffRow(5), { turns: TURNS }) };
  const zhTurn = renderHandoffDrawer(selectHandoff('turn', 5, 0), resources, { dictionary: zh });
  assert.match(zhTurn, /<h2\b[^>]*>分段#2交接的回合<\/h2>/);
  assert.equal(subtitleOf(zhTurn), 'S1:1');
  assert.match(zhTurn, /data-kind="turn"/);
  assert.equal(zhTurn.includes('role="tablist"'), false);
  assert.deepEqual(['user', 'note'].map(name => [textOf(/<h3\b[^>]*>(.*?)<\/h3>/.exec(sectionOf(zhTurn, name))[1]), textOf(/<pre\b[^>]*>(.*?)<\/pre>/s.exec(sectionOf(zhTurn, name))[1])]), [['用户', 'first\nline'], ['笔记', 'a note']]);
  const enTurn = renderHandoffDrawer(selectHandoff('turn', 5, 0), resources, { dictionary: en });
  assert.match(enTurn, /<h2\b[^>]*>Turn of segment #2 handoff<\/h2>/);
  assert.equal(subtitleOf(enTurn), 'S1:1');
  assert.equal(subtitleOf(renderHandoffDrawer(selectHandoff('turn', 5, 1), resources)), undefined, 'a turn with no address has no subtitle');
  assert.equal(subtitleOf(renderHandoffDrawer(selectHandoff('turn', 5, 0))), undefined, 'nor has one whose detail has not arrived');
  assert.ok(renderHandoffDrawer(selectHandoff('turn', 5, 0)).includes('data-sw-monitor-notice="detail-loading"'));
});

test('the turn drawer reads a missing note and an empty one as their neutral markers', () => {
  const resources = { [handoffKey(5)]: readyHandoff(handoffRow(5), { turns: TURNS }) };
  const noNote = sectionOf(renderHandoffDrawer(selectHandoff('turn', 5, 1), resources), 'note');
  assert.ok(noNote.includes('data-sw-empty') && noNote.includes('monitor.handoff.turn.noNote'));
  assert.equal(noNote.includes('<pre'), false);
  const emptyNote = sectionOf(renderHandoffDrawer(selectHandoff('turn', 5, 2), resources), 'note');
  assert.ok(emptyNote.includes('data-sw-empty') && emptyNote.includes('monitor.slot.empty'));
});

// ── The settlement rows and their drawer ─────────────────────────────────────

// Three compactions of one segment, the last without a price ratio, and the continue that cleared the segment after two more steps: 518000 read-price tokens saved of 296000 spent, by the two compactions with figures.
const SETTLING = { contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 }, cRatio: 12, call: { usage: { input: 400, output: 2_400, cacheRead: 48_000, cacheWrite: 600 } } };
const settlingAttempts = () => [attemptRow(1, { ...SETTLING, stepN: 8 }), attemptRow(2, { ...SETTLING, stepN: 1 }), attemptRow(3, { ...SETTLING, stepN: 1, cRatio: null })];
const clearingHandoff = (overrides = {}) => handoffRow(5, { type: 'continue', epoch: 1, tailCalls: 2, contextChange: { before: 460, after: 710, delta: 250, miss: 510 }, ...overrides });
const settlementKey = handoffId => reduceView(createViewState(), { type: 'select', kind: 'settlement', handoffId });

// The settlement resource's answer the drawer draws figures from: only an adjusted settlement is shown, and one that is evidence of recall adjusts the list's figures by nothing.
const ADJUSTED = { kind: 'ready', value: { calls: [], activity: { covered: true, judged: 1, pure: 0, targets: [] } } };

function renderSettlementDrawer(state, settlements, { dictionary, result = null } = {}) {
  const monitor = monitorAt(null, result === null ? {} : { [resourceKey({ endpoint: 'inner-monitor/settlement', handoff: 5 })]: result });
  return renderToString(React.createElement(MonitorDrawer, { state, monitor, ordinals: {}, handoffs: [], settlements, now: NOW, dispatch: () => {}, t: dictionary === undefined ? t : localized(dictionary) }));
}

test('the settlement of a cleared segment is a row of its own in front of the continue that cleared it, titled by the segment and carrying the count, the steps and the four figures in their slots, with no seq, no preview and no toggle', () => {
  const rows = parseRows(renderHandoffList(settlingAttempts(), [clearingHandoff()]));
  assert.deepEqual(rows.map(row => row.attributes['data-identity']), ['attempt:1', 'attempt:2', 'attempt:3', 'settlement:5', 'handoff:5']);
  const row = rows[3];
  assert.equal(row.attributes['data-sw-row'], 'settlement');
  assert.equal(row.attributes['aria-level'], '1');
  assert.equal(row.attributes.role, 'treeitem');
  assert.equal(row.attributes['aria-expanded'], undefined, 'it opens no group');
  assert.equal(row.attributes.tabindex, '0');
  assert.equal(row.preview, undefined);
  assert.deepEqual(row.parts, {
    title: 'monitor.object.settlement(epoch=1)',
    count: 'monitor.settlement.count(count=3)',
    steps: 'monitor.settlement.steps(count=12)',
    saved: 'monitor.settlement.saved(count=518.0k)',
    cost: 'monitor.settlement.cost(count=296.0k)',
    net: 'monitor.settlement.net(count=+222.0k)',
    payback: 'monitor.settlement.payback(percent=175%)',
  });
  assert.deepEqual(Object.keys(row.parts), ['title', 'count', 'steps', 'saved', 'cost', 'net', 'payback']);
  for (const part of ['count', 'steps', 'saved', 'cost', 'net', 'payback']) assert.match(row.titles[part], new RegExp(`title="monitor\\.settlement\\.${part}\\.title"`), part);
  assert.equal(row.markup.includes('sw-mon-toggle'), false);
});

test('the settlement row is no warning: a segment whose compactions did not pay back reads its loss with the minus sign and no mark of attention', () => {
  const html = renderHandoffList([attemptRow(1, { ...SETTLING, stepN: 8 })], [clearingHandoff({ tailCalls: 0 })]);
  const row = parseRows(html).find(each => each.attributes['data-sw-row'] === 'settlement');
  assert.equal(row.parts.net, 'monitor.settlement.net(count=\u2212148.0k)');
  assert.equal(row.parts.payback, 'monitor.settlement.payback(percent=0%)');
  assert.equal(row.markup.includes('data-sw-attention'), false);
});

test('a load, and a continue of a segment with no figures, list no settlement row', () => {
  assert.deepEqual(rowIds(renderHandoffList(settlingAttempts(), [handoffRow(5, { epoch: 1 })])), ['attempt:1', 'attempt:2', 'attempt:3', 'handoff:5']);
  assert.deepEqual(rowIds(renderHandoffList([attemptRow(1, { ...SETTLING, cRatio: null })], [clearingHandoff()])), ['attempt:1', 'handoff:5']);
});

test('a click or the enter or space key on a settlement row selects it by its identity and any other key does not; the row shows its selection', () => {
  let state = createViewState();
  const dispatch = (action) => { state = reduceView(state, action); };
  const render = selected => MonitorList({ rows: flattenRows(settlingAttempts(), {}, state, [clearingHandoff()]), selected, now: NOW, dispatch, t }).props.children.map(element => element.type(element.props));
  const row = render(null).find(element => element.props['data-identity'] === 'settlement:5');
  row.props.onClick();
  assert.deepEqual(state.selected, { identity: 'settlement:5', kind: 'settlement', handoffId: 5, turn: null });
  state = createViewState();
  const prevented = [];
  for (const key of ['Enter', ' ']) row.props.onKeyDown({ key, preventDefault: () => prevented.push(key) });
  assert.equal(state.selected.identity, 'settlement:5');
  assert.deepEqual(prevented, ['Enter', ' ']);
  state = createViewState();
  row.props.onKeyDown({ key: 'a', preventDefault: () => prevented.push('a') });
  assert.equal(state.selected, null);
  assert.equal(row.props['aria-selected'], false);
  assert.equal(render('settlement:5').find(element => element.props['data-identity'] === 'settlement:5').props['aria-selected'], true);
});

test('in each locale the settlement drawer is titled by the segment with the handoff id beside it, with the payback and context tabs, the payback page selected over its panel', () => {
  const settled = settlementsOf(settlingAttempts(), [clearingHandoff()]);
  const zhHtml = renderSettlementDrawer(settlementKey(5), settled, { dictionary: zh });
  assert.match(zhHtml, /<h2\b[^>]*>分段#1压缩结算<\/h2>/);
  assert.equal(subtitleOf(zhHtml), '交接ID：5');
  assert.match(zhHtml, /data-kind="settlement"/);
  assert.deepEqual([...zhHtml.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map(match => [/aria-selected="(\w+)"/.exec(match[0])[1], /data-page="(\w+)"/.exec(match[0])[1], match[1]]), [['true', 'payback', '回本'], ['false', 'context', '上下文']]);
  assert.match(zhHtml, /<div class="sw-mon-page" role="tabpanel" data-page="payback"><div class="sw-pb">/);
  const enHtml = renderSettlementDrawer(settlementKey(5), settled, { dictionary: en });
  assert.match(enHtml, /<h2\b[^>]*>Compaction settlement of segment #1<\/h2>/);
  assert.equal(subtitleOf(enHtml), 'Handoff ID: 5');
  assert.deepEqual([...enHtml.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map(match => match[1]), ['Payback', 'Context']);
  const pending = renderSettlementDrawer(settlementKey(5), settled);
  assert.match(pending, /data-sw-monitor-notice="recall-pending"/);
  assert.equal(pending.includes('sw-pb-head'), false, 'no figure while the adjusted settlement is not there');
  const echoed = renderSettlementDrawer(settlementKey(5), settled, { result: ADJUSTED });
  assert.equal(echoed.includes('<pre'), false, 'the settlement drawer sets no preformatted block');
  assert.equal(echoed.includes('monitor.settlement.total'), false);
  assert.deepEqual([...echoed.matchAll(/<span>(monitor\.settlement\.[a-z]+\(.*?\))[ ·]*<\/span>/g)].map(match => match[1]), [
    'monitor.settlement.count(count=3)', 'monitor.settlement.steps(count=12)', 'monitor.settlement.saved(count=518.0k)', 'monitor.settlement.cost(count=296.0k)', 'monitor.settlement.net(count=+222.0k)', 'monitor.settlement.payback(percent=175%)',
  ], 'the same compact totals as the list row');
  assert.equal([...echoed.matchAll(/<li class="sw-pb-li"/g)].length, 3, 'a row for each compaction, the one with no figures included');
  assert.equal([...echoed.matchAll(/<li class="sw-pb-li"[^>]*\bdata-unknown=""/g)].length, 1);
});

test('the drawer keys the settlement page by its selected identity so another settlement starts on its first tab', () => {
  const settled = settlementsOf(settlingAttempts(), [clearingHandoff()]);
  const drawer = identity => MonitorDrawer({ state: settlementKey(identity), monitor: monitorAt(null), ordinals: {}, handoffs: [], settlements: settled, now: NOW, dispatch: () => {}, t });
  const body = identity => drawer(identity).props.children.find(child => child?.props?.className === 'sw-mon-drawer-body').props.children;
  assert.equal(body(5).key, 'settlement:5');
  assert.equal(body(9).key, 'settlement:9', 'another identity is another key');
});

test('the settlement drawer of a selection the settlements do not list names no segment and shows nothing', () => {
  const html = renderSettlementDrawer(settlementKey(9), new Map(), { dictionary: zh });
  assert.match(html, /<h2\b[^>]*>分段#—压缩结算<\/h2>/);
  assert.equal(subtitleOf(html), '交接ID：9');
  assert.equal(html.includes('<pre'), false);
  assert.equal(html.includes('role="tablist"'), false);
  assert.equal(html.includes('sw-pb'), false);
});

test('the split lists the settlement before its continue and opens its drawer from the selection alone, the compactions reading the steps the clear cut off', () => {
  const handoffs = [clearingHandoff()];
  const { html, touched } = renderSplit(settlingAttempts(), {}, { handoffs, state: settlementKey(5) });
  assert.deepEqual(rowIds(html), ['attempt:1', 'attempt:2', 'attempt:3', 'settlement:5', 'handoff:5']);
  assert.match(html, /data-sw-monitor-drawer="" data-kind="settlement"/);
  assert.ok(html.includes('role="tablist"') && html.includes('class="sw-pb"'), 'the tab strip and the payback page');
  assert.equal(html.includes('monitor.settlement.total'), false);
  assert.deepEqual(touched.filter(key => key.includes('inner-monitor/')), [resourceKey({ endpoint: 'inner-monitor/settlement', handoff: 5 })]);
  assert.deepEqual(parseRows(html).filter(row => row.attributes['data-sw-row'] === 'attempt').map(row => row.parts.status), ['monitor.status.paid', 'monitor.status.paid', 'monitor.status.committed']);
  assert.equal(parseRows(html).find(row => row.attributes['data-identity'] === 'settlement:5').attributes['aria-selected'], 'true');
});

test('a row-selected historical drawer stays hidden when the monitor cannot list its events', () => {
  const html = renderToString(React.createElement(MonitorSplit, {
    attempts: [], handoffs: [], monitor: monitorAt(null), state: settlementKey(5),
    listNotice: React.createElement('p', null, 'Events are unavailable.'), dispatch: () => {}, t,
  }));
  assert.match(html, /Events are unavailable\./);
  assert.doesNotMatch(html, /data-sw-monitor-drawer/);
});

test('the settlement drawer opens on the payback page and reads recall evidence by its handoff without reading the session store', () => {
  const touched = [];
  const settlement = settlementsOf(settlingAttempts(), [clearingHandoff()]).get(5);
  const monitor = monitorAt(null, {}, touched);
  const session = sessionAt(null, touched);
  const html = renderToString(React.createElement(SettlementDetail, { settlement, monitor, session, handoffId: 5, t }));
  assert.match(html, /<div class="sw-mon-page" role="tabpanel" data-page="payback"><div class="sw-pb">/);
  assert.equal(html.includes('sw-cx'), false, 'the context page is not mounted');
  assert.deepEqual(touched, [resourceKey({ endpoint: 'inner-monitor/settlement', handoff: 5 })]);
});

test('the settlement detail hands its pages the settlement, the handoff and the stores, the payback page first and the context page after it', () => {
  const settled = settlementsOf(settlingAttempts(), [clearingHandoff()]);
  const monitor = monitorAt(null);
  const session = sessionAt(null);
  const { props } = SettlementDetail({ settlement: settled.get(5), handoffId: 5, monitor, session, t });
  assert.deepEqual(Object.keys(props.pages), ['payback', 'context']);
  assert.equal(props.first, 'payback');
  assert.equal(props.labels, 'monitor.settlementPage');
  assert.deepEqual([props.settlement, props.handoffId, props.monitor, props.session], [settled.get(5), 5, monitor, session]);
  assert.equal(SettlementDetail({ settlement: undefined, handoffId: 5, monitor, session, t }), null);
  const drawer = MonitorDrawer({ state: settlementKey(5), monitor, session, ordinals: {}, handoffs: [], settlements: settled, now: NOW, dispatch: () => {}, t });
  const body = drawer.props.children.find(child => child?.props?.className === 'sw-mon-drawer-body').props.children;
  assert.deepEqual([body.props.handoffId, body.props.monitor, body.props.session], [5, monitor, session], 'the drawer hands the selected settlement\'s handoff and its own stores on');
});

test('the tab strip hands the page it opens the settlement, the handoff and the stores: the context page asks for the settlement\'s calls by the handoff and reads the line from the session', () => {
  const settlement = settlementsOf(settlingAttempts(), [clearingHandoff()]).get(5);
  const identity = { endpoint: 'inner-monitor/settlement', handoff: 5 };
  const calls = settlement.rows.flatMap((_, at) => [{ seq: 10 * at + 1, stock: 1000 + at, post: false }, { seq: 10 * at + 2, stock: 1100 + at, post: true }]);
  const touched = [];
  // A server render reads the session store's `subscribe` to hand it to the hook and does not call it.
  const session = {
    get result() { touched.push('session.result'); return { kind: 'live', snapshot: { history: [{ segment: settlement.epoch - 1, amberStockL: 1050 }] } }; },
    get subscribe() { touched.push('session.subscribe'); return () => () => {}; },
  };
  const monitor = monitorAt(null, { [resourceKey(identity)]: { kind: 'ready', value: { calls } } }, touched);
  const html = renderToString(React.createElement(PagedDetail, { pages: SETTLEMENT_PAGES, first: 'context', labels: 'monitor.settlementPage', settlement, handoffId: 5, monitor, session, t }));
  assert.match(html, /<div class="sw-mon-page" role="tabpanel" data-page="context"><div class="sw-cx">/);
  assert.deepEqual(touched.filter(key => key.includes('inner-monitor/')), [resourceKey(identity)], 'the settlement\'s calls, by the handoff');
  assert.deepEqual([touched.includes('session.result'), touched.includes('session.subscribe')], [true, true], 'the session\'s store');
  assert.equal(html.includes('sw-cx-svg') && html.includes('sw-cx-warnline'), true, 'the chart over the calls read and the line the session\'s history holds');
  assert.equal(html.includes('sw-pb'), false, 'the payback page is not mounted');
});

test('the overview of a compaction in a cleared segment reads the progress that includes the steps the clear cut off', () => {
  const attempts = paidPair();
  const resources = { [callKey(2)]: { kind: 'ready', value: callPayload(attempts[1]) } };
  const split = handoffs => factsOf(renderSplit(attempts, resources, { handoffs, state: selectCall(2) }).html).slice(0, 2);
  assert.deepEqual(split([]), [['monitor.overview.status', 'monitor.status.committed'], ['monitor.overview.payback', '0%']]);
  assert.deepEqual(split([clearingHandoff()]), [['monitor.overview.status', 'monitor.status.paid'], ['monitor.overview.payback', '100%']]);
});

// A carrier's evidence and a load's files holding every kind of entry the file list words: written and withdrawn lines, a file that could not be read for each reason the list words and for one it does not, an empty file, a file holding none of its lines, a removed path, a skill and a removed skill.
const EVIDENCE = {
  text: 'B text',
  note: 'The note.',
  files: [
    { path: 'src/a.js', total: 40, state: 'readable', reason: null, runs: [{ offset: 1, lines: [{ number: 1, text: 'a' }] }, { offset: 9, lines: [{ number: 9, text: 'b' }] }], withdrawn: [{ first: 4, last: 6 }, { first: 20, last: 20 }] },
    { path: 'src/gone.js', total: null, state: 'unreadable', reason: 'missing', runs: [], withdrawn: [{ first: 1, last: 2 }] },
    { path: 'src/empty.js', total: null, state: 'empty', reason: null, runs: [], withdrawn: [{ first: 1, last: 1 }] },
    { path: 'src/only-withdrawn.js', total: 10, state: null, reason: null, runs: [], withdrawn: [{ first: 3, last: 4 }] },
    ...['missing', 'not-file', 'too-large', 'binary', 'unreadable'].map(reason => ({ path: `src/${reason}.js`, total: null, state: 'unreadable', reason, runs: [], withdrawn: [] })),
    { path: 'src/odd.js', total: null, state: 'unreadable', reason: 'EACCES', runs: [], withdrawn: [] },
    { path: 'src/none.js', total: null, state: 'unreadable', reason: null, runs: [], withdrawn: [] },
    { path: 'src/blank.js', total: null, state: 'empty', reason: null, runs: [], withdrawn: [] },
    { path: 'src/held.js', total: null, state: 'readable', reason: null, runs: [], withdrawn: [] },
  ],
  removed: ['src/old.js'],
  skills: [{ name: 'tdd', text: 'Test first.' }, { name: 'grill', removed: true }],
};
const READ_FILES = [
  { path: '/work/a.js', total: 20, runs: [{ offset: 1, lines: [{ number: 1, text: 'a' }] }, { offset: 9, lines: [{ number: 9, text: 'b' }] }] },
  { path: '/work/b.js', total: null, runs: [] },
  { path: '/work/c.js', total: 0, runs: [] },
  { path: '/work/d.js', total: 5, runs: [] },
];

// ── The filter toolbar ───────────────────────────────────────────────────────

const filterBy = (...actions) => actions.reduce(reduceView, createViewState());
const WARNED = { type: 'warned', warned: true };
const buttonsOf = element => (element?.type === 'button' ? [element] : [element?.props?.children].flat(Infinity).filter(Boolean).flatMap(buttonsOf));

test('the toolbar groups the category filters and exposes the current settlement separately', () => {
  const toolbar = MonitorToolbar({ filter: createViewState().filter, dispatch: () => {}, t });
  assert.equal(toolbar.props.role, 'toolbar');
  assert.equal(toolbar.props['aria-label'], 'monitor.toolbar.label');
  assert.match(renderToString(toolbar), /<div(?=[^>]*role="group")(?=[^>]*aria-label="monitor\.filter\.category")/);
  const texts = state => buttonsOf(MonitorToolbar({ filter: state.filter, dispatch: () => {}, t })).map(button => [button.props.children, button.props['aria-pressed']]);
  assert.deepEqual(texts(createViewState()), [
    ['monitor.filter.all', true], ['monitor.filter.handoff', false], ['monitor.filter.compaction', false], ['monitor.filter.collapseAll', undefined], ['monitor.filter.warned', false], ['monitor.toolbar.currentSettlement', undefined],
  ]);
  assert.deepEqual(texts(filterBy({ type: 'category', category: 'handoff' }, WARNED)).map(([, pressed]) => pressed), [false, true, false, undefined, true, undefined]);
  for (const button of buttonsOf(toolbar)) assert.equal(button.props.type, 'button');
});

test('a click on a category, the collapse button or the warning toggle dispatches its action, and the toggle of a filter that is on switches it off', () => {
  const dispatched = [];
  const press = (state) => {
    const toolbar = MonitorToolbar({ filter: state.filter, dispatch: action => dispatched.push(action), t });
    for (const button of buttonsOf(toolbar)) {
      if (button.props.children !== 'monitor.toolbar.currentSettlement') button.props.onClick();
    }
  };
  press(createViewState());
  assert.deepEqual(dispatched, [
    { type: 'category', category: 'all' }, { type: 'category', category: 'handoff' }, { type: 'category', category: 'compaction' }, { type: 'collapse' }, { type: 'warned', warned: true },
  ]);
  dispatched.length = 0;
  press(filterBy(WARNED));
  assert.deepEqual(dispatched.at(-1), { type: 'warned', warned: false });
});

test('the split puts the toolbar above its list and its drawer, and reads the slots and the turns of the groups the filter lists alone', () => {
  const attempts = settlingAttempts().map(warmed);
  const handoffs = [clearingHandoff()];
  const resources = {
    [slotsKey(1)]: readySlots([slotRow(10)]), [slotsKey(2)]: readySlots([slotRow(20)]), [slotsKey(3)]: readySlots([slotRow(30)]), [handoffKey(5)]: readyHandoff(handoffs[0]),
  };
  const opened = [1, 2, 3].reduce((state, attemptId) => reduceView(state, { type: 'toggle', attemptId, open: false }), openingHandoffs(5));
  const split = (...actions) => renderSplit(attempts, resources, { handoffs, state: actions.reduce(reduceView, opened) });
  const reads = ({ touched }, endpoint) => touched.filter(key => key.includes(endpoint)).sort();
  const slotKeys = ids => ids.map(slotsKey).sort();

  const everything = split();
  assert.ok(everything.html.indexOf('role="toolbar"') < everything.html.indexOf('data-sw-monitor-split'));
  assert.deepEqual(reads(everything, 'inner-monitor/slots'), slotKeys([1, 2, 3]));
  assert.deepEqual(reads(everything, 'inner-monitor/handoff'), [handoffKey(5)]);
  const handoffsOnly = split({ type: 'category', category: 'handoff' });
  assert.deepEqual(reads(handoffsOnly, 'inner-monitor/slots'), []);
  assert.deepEqual(reads(handoffsOnly, 'inner-monitor/handoff'), [handoffKey(5)]);
  assert.deepEqual(rowIds(handoffsOnly.html), ['settlement:5', 'handoff:5', 'content:5', 'turn:5:0', 'turn:5:1']);
  const compactions = split({ type: 'category', category: 'compaction' });
  assert.deepEqual(reads(compactions, 'inner-monitor/slots'), slotKeys([1, 2, 3]));
  assert.deepEqual(reads(compactions, 'inner-monitor/handoff'), []);
  const warned = split(WARNED);
  assert.deepEqual(rowIds(warned.html), ['attempt:2', 'call:2', 'attempt:3', 'call:3']);
  assert.deepEqual(reads(warned, 'inner-monitor/slots'), [], 'cost warnings need no slot list');
  assert.deepEqual(reads(warned, 'inner-monitor/handoff'), []);
  const calls = html => parseRows(html).filter(row => row.attributes['data-sw-row'] === 'call').map(row => [row.attributes['data-sw-attention'], row.attributes['aria-description']]);
  const miss = ['', 'monitor.meta.miss.unexpected'];
  assert.deepEqual(calls(warned.html), [miss, miss], 'cache comparisons still see the hidden predecessor');
  assert.deepEqual(calls(everything.html), [[undefined, undefined], miss, miss], 'the filter does not change the marks');
});

test('the warning filter lists the rows the list marks with a warning, the compaction whose context grew and the one whose cache rebuild was unexpected alike', () => {
  const attempts = [...settlingAttempts().map(warmed), attemptRow(9, { epoch: 1 })];
  const marked = parseRows(renderList(attempts)).filter(row => row.attributes['data-sw-attention'] !== undefined).map(row => row.attributes['data-identity']);
  assert.deepEqual(marked, ['attempt:2', 'attempt:3', 'attempt:9']);
  assert.deepEqual(rowIds(renderList(attempts, { state: filterBy(WARNED) })), marked);
});

const SLOT_WARNINGS = { 40: ['state-check', 'verbatim-recall'], 45: ['state-mixed', 'state-write', 'handoff-recall', 'carrier-recall', 'read-block'] };

test('slot warnings keep the closed parent and, when opened, only the warned slots and any warned call under the warning filter', () => {
  const attempts = [
    attemptRow(1, { contextChange: null }),
    attemptRow(2, { contextChange: null, slotWarnings: SLOT_WARNINGS }),
    attemptRow(3, { contextChange: { before: 100, after: 120, delta: 20, miss: 25 }, slotWarnings: { 60: ['state-write'] } }),
  ];
  const resources = {
    [slotsKey(2)]: readySlots([slotRow(40), slotRow(45), slotRow(50)]),
    [slotsKey(3)]: readySlots([slotRow(60), slotRow(65)]),
  };
  const closed = renderSplit(attempts, resources, { state: filterBy(WARNED) });
  const [parent] = parseRows(closed.html);
  assert.deepEqual(rowIds(closed.html), ['attempt:2', 'attempt:3']);
  assert.equal(parent.attributes['data-sw-attention'], '');
  const plain = parseRows(renderList([attempts[0], attemptRow(2, { contextChange: null })]))[1];
  const withoutBadge = markup => markup.replace(/<span\b[^>]*class="sw-mon-badge"[^>]*>.*?<\/span>/g, '');
  assert.equal(textOf(withoutBadge(parent.markup)), textOf(plain.markup), 'no additional parent text beside the badge');
  assert.deepEqual(closed.touched, [], 'the parent warning does not load details');

  const filtered = reduceView(opening(2, 3), WARNED);
  const { html, touched } = renderSplit(attempts, resources, { state: filtered });
  const group = parseRows(html);
  assert.deepEqual(rowIds(html), ['attempt:2', 'slot:2:40', 'slot:2:45', 'attempt:3', 'call:3', 'slot:3:60']);
  assert.deepEqual(touched, [slotsKey(2), slotsKey(3)]);
  assert.deepEqual(group.map(row => row.attributes['data-sw-attention']), ['', '', '', '', '', '']);
  assert.equal(group[1].attributes['aria-description'], 'monitor.warning.state-check · monitor.warning.verbatim-recall');
  assert.equal(group[2].attributes['aria-description'], 'monitor.warning.state-mixed · monitor.warning.state-write · monitor.warning.handoff-recall · monitor.warning.carrier-recall · monitor.warning.read-block', 'the slot row keeps the wording it had');
  assert.equal(group[1].parts.mark, undefined, 'the reason adds no row text');
  assert.equal(group[4].attributes['aria-description'], 'monitor.meta.context.grew');

  const restored = renderSplit(attempts, resources, { state: reduceView(filtered, { type: 'warned', warned: false }) });
  assert.deepEqual(rowIds(restored.html), ['attempt:1', 'attempt:2', 'call:2', 'slot:2:40', 'slot:2:45', 'slot:2:50', 'attempt:3', 'call:3', 'slot:3:60', 'slot:3:65']);
  assert.deepEqual(parseRows(restored.html).filter(row => row.attributes['data-sw-attention'] !== undefined).map(row => row.attributes['data-identity']), rowIds(html));
});

test('a filter that lists nothing keeps the toolbar and puts one neutral line in the list\'s place', () => {
  const { html } = renderSplit([], {}, { handoffs: [handoffRow(5)], state: filterBy(WARNED) });
  assert.match(html, /data-sw-monitor-notice="filter-empty"[^>]*>monitor\.filter\.empty</);
  assert.deepEqual(rowIds(html), []);
  assert.equal(html.includes('role="tree"'), false);
  assert.match(html, /<button(?=[^>]*data-act="warned")(?=[^>]*aria-pressed="true")/);
});

const placeholdersOf = text => new Set([...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name));

test('every locale key the view and its drawer ask for, over the states of the monitor store, the list, the pages and the slot, is defined in both dictionaries with the placeholders it is given', async () => {
  const asked = new Map();
  listener = (key, names) => { asked.set(key, new Set([...(asked.get(key) ?? []), ...names])); };
  try {
    for (const rows of [null, { kind: 'unavailable' }, { kind: 'unreachable', message: 'x' }, { kind: 'ready', attempts: [], handoffs: [] }]) renderView(monitorAt(rows));
    const statuses = ['generating', 'validating', 'committed', 'failed', 'cancelled', 'unknown'];
    const attempts = statuses.map((status, at) => attemptRow(11 + at, { status, call: { state: ['generating', 'received', 'error', 'absent'][at % 4] } }));
    let state = createViewState();
    for (const attempt of attempts) state = reduceView(state, { type: 'toggle', attemptId: attempt.id, open: false });
    const categories = [['user/message', 'user'], ['user/message', 'runtime-context'], ['system/message', null], ['developer/message', null], ['tool/result', null], ['assistant/message', null], ['other', null]];
    const pair = paidPair();
    renderSplit(pair, { [callKey(1)]: { kind: 'ready', value: callPayload(pair[0]) } }, { state: selectCall(1) });
    renderSplit(attempts, { [slotsKey(13)]: readySlots([slotRow(10), ...categories.map(([type, kind], at) => slotRow(20 + at, { turn: null, step: null, source: { type, kind } }))]) }, { state });
    renderSplit([attemptRow(2, { slotWarnings: SLOT_WARNINGS })], { [slotsKey(2)]: readySlots([slotRow(40), slotRow(45)]) }, { state: opening(2) });
    for (const result of [null, { kind: 'unavailable' }, { kind: 'unreachable', message: 'x' }]) renderDrawer(selectCall(7), { [callKey(7)]: result });
    const slotSelected = reduceView(createViewState(), { type: 'select', kind: 'slot', attemptId: 1, slotKey: 2 });
    renderDrawer(slotSelected);
    renderDrawer(slotSelected, { [slotKeyOf(1, 2)]: { kind: 'ready', value: slotValue(2) } });
    for (const page of [SlotOverviewPage, SlotSummaryPage, SlotSourcePage]) pageHtml(page, slotValue(2, { source: undefined }));
    const everyKind = ['state-check', 'state-mixed', 'state-write', 'verbatim-recall', 'handoff-recall', 'carrier-recall', 'read-block'];
    const toolsDetail = toolsSlot([
      toolCard({ pruned: { seq: 12 }, warnings: everyKind.map(kind => ({ kind })) }),
      toolCard({ id: '1:1:r2', name: null, input: null, result: null }),
      toolCard({ id: '1:1:r3', result: { seq: 13, error: true, empty: true } }),
      toolCard({ id: '1:1:r4', result: { seq: 14, error: false, empty: true } }),
    ], { warnings: everyKind, events: [toolEvent(11), toolEvent(12), toolEvent(13, { blocks: [] }), toolEvent(14, { text: '' })] });
    pageHtml(SlotToolsPage, toolsDetail);
    pageHtml(SlotSourcePage, toolsDetail, { opened: { seq: 12 } });
    renderDrawer(slotSelected, { [slotKeyOf(1, 2)]: { kind: 'ready', value: toolsDetail } });
    const handoffs = [handoffRow(5), handoffRow(6, { type: 'continue', createdAt: null, kept: null, read: null, lineage: null, nextTask: null, contextChange: { before: 460, after: 710, delta: 250, miss: 510 } })];
    const turned = { [handoffKey(5)]: readyHandoff(handoffs[0], { turns: TURNS }), [handoffKey(6)]: readyHandoff(handoffs[1], { turns: TURNS, lineage: null, turnPage: null, followUp: null, files: [] }) };
    renderSplit([attemptRow(1)], turned, { handoffs, state: openingHandoffs(5, 6) });
    for (const handoff of handoffs) for (const [kind, turn] of [['content'], ['turn', 0], ['turn', 1], ['turn', 2]]) renderHandoffDrawer(selectHandoff(kind, handoff.id, turn), turned, { handoffs });
    renderHandoffDrawer(selectHandoff('content', 5), {}, { handoffs });
    renderHandoffDrawer(selectHandoff('content', 5), {}, { handoffs: [] });
    renderHandoffList(settlingAttempts(), [clearingHandoff()]);
    renderSettlementDrawer(settlementKey(5), settlementsOf(settlingAttempts(), [clearingHandoff()]));
    renderSettlementDrawer(settlementKey(9), new Map());
    renderSplit([], {}, { handoffs: [handoffRow(5)], state: filterBy(WARNED) });
    for (const Page of [HandoffDetail, HandoffOverviewPage, HandoffSummaryPage, HandoffFilesPage, HandoffTurnsPage, HandoffLineagePage]) for (const row of handoffs) pageHtml(Page, turned[handoffKey(row.id)].value);
    for (const type of ['minutes', 'hours', 'days']) renderHandoffList([], [handoffRow(5, { createdAt: HANDOFF_TIME - { minutes: 5 * 60_000, hours: 5 * 3_600_000, days: 5 * 86_400_000 }[type] })]);
    renderSummaries(callPayload(attemptRow(7)), 7, { [slotsKey(7)]: readySlots([slotRow(10), slotRow(20, { turn: null, step: null, output: '' })]) });
    renderSummaries(callPayload(attemptRow(7)), 7, { [slotsKey(7)]: null });
    renderSummaries(callPayload(attemptRow(8, { status: 'failed', slots: null })), 8);
    for (const detail of [callPayload(attemptRow(7)), callPayload(attemptRow(7), { carried: EVIDENCE }), callPayload(attemptRow(8, { status: 'failed', slots: null }))]) pageHtml(CarriedPage, detail);
    const everything = [carriedFilesOf(EVIDENCE, t), readFilesOf(READ_FILES, t)];
    for (const model of everything) {
      const ids = model.groups.flatMap(group => group.items).filter(item => item.kind === 'file').map(item => item.id);
      for (const state of [reduceFiles(createFilesState(), { type: 'expand', ids }), reduceFiles(reduceFiles(createFilesState(), { type: 'expand', ids }), { type: 'wrap' })]) {
        renderToString(React.createElement(FilesView, { model, state, dispatch: () => {}, t }));
      }
    }
    if (skip === false) {
      const conv = conversation();
      const full = attemptOver(conv, { request: requestOf(conv, { options: { ...OPTIONS, reasoningEffort: 'low' }, toolHistory: { updates: [{ messageId: 'message-4', additions: ['read'] }] } }) });
      const failedCall = attemptOver(conv, { stream: toolCallStream('["a"'), end: { outcome: 'failed', reason: 'the response called a tool' }, committed: false, thrown: 'socket hang up' });
      const noCall = attemptOver(conv, { stream: null, end: { outcome: 'failed', reason: 'refused' }, request: requestOf(conv, { headerSeq: 9999, tools: { count: 2 } }) });
      const bare = attemptOver(conv, { stream: refusedStream(), end: { outcome: 'failed', reason: 'x' }, committed: false, request: { options: OPTIONS, headerSeq: null } });
      const live = attemptOver(conv, { stream: null, committed: false });
      const entry = { attempt: live.start.seq, phase: 'generating', endedAt: null, request: live.start.data.request, tools: TOOLS, stream: () => streamOf([{ type: 'block-start', index: 0, blockType: 'text' }]) };
      for (const [attempt, liveEntries] of [[full, undefined], [failedCall], [noCall], [bare], [live, [entry]]]) {
        const detail = await callOf(attempt.log, attempt.start.seq, liveEntries);
        for (const Page of [OverviewPage, RequestPage, ResponsePage, CarriedPage, UsagePage, TimingPage]) pageHtml(Page, detail);
        renderDrawer(selectCall(attempt.start.seq), { [callKey(attempt.start.seq)]: readyOf(detail) });
      }
      const slots = attemptOver(conv);
      pageHtml(SlotSourcePage, slotDetailOf([{ seq: 40, type: 'user/message', data: { content: [{ type: 'image', attachment: {} }, { type: 'file', attachment: {} }, { type: 'x' }] } }, { seq: 41, type: 'tool/result', data: { message: { toolCallId: 'c', isError: true, content: [] } } }, { seq: 42, type: 'tool/result', data: { message: { toolCallId: 'c', content: [] } } }]));
      for (const slot of conv.slots) {
        const detail = await slotOf(slots.log, slots.start.seq, slot.seqs[0]);
        for (const Page of [SlotDetail, SlotOverviewPage, SlotSummaryPage, SlotSourcePage]) pageHtml(Page, detail);
      }
    }
  } finally {
    listener = null;
  }
  assert.ok(asked.size > 0);
  for (const [key, names] of asked) {
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
    assert.deepEqual(placeholdersOf(en[key]), names, `en ${key} takes the placeholders the view passes`);
    assert.deepEqual(placeholdersOf(zh[key]), names, `zh ${key} takes the placeholders the view passes`);
  }
});
