// The settlement drawers over one answer: the closed segment's (`SettlementDetail`, over the list's settlement and the settlement resource) and the current segment's (`CurrentSettlementDetail`, over the answer the toolbar read once) show the same evidence of recall, and a target's text is read when it is chosen and not before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PagedDetail, SETTLEMENT_PAGES, CURRENT_SETTLEMENT_PAGES, CurrentSettlementDetail } from '../dsh/src/client/monitor-drawer.js';
import { MonitorDrawer } from '../dsh/src/client/monitor-view.js';
import { settlementsOf } from '../public/lib/compactionEconomics.js';
import { settlementViewOf } from '../dsh/src/client/monitor-recall-model.js';
import { contextModelOf } from '../dsh/src/client/monitor-context-model.js';
import { paybackPageOf } from '../dsh/src/client/monitor-settlement-model.js';
import { createViewState, reduceView } from '../dsh/src/client/monitor-state.js';
import { zh } from '../dsh/src/client/locales.js';

const t = (key, params) => zh[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]));

// Two committed compactions of segment 0 that sealed 4 steps each, then two steps of the tail; the third call after each seal is a recall step.
const attempt = (id, stepN) => ({
  id, status: 'committed', epoch: 0, contextChange: { before: 1000, after: 900, delta: -100, miss: 30 }, call: { usage: { input: 50, output: 5, cacheRead: 100, cacheWrite: 0 } }, stepN, cRatio: 2,
});
const ATTEMPTS = [attempt(10, 4), attempt(20, 4)];
const CALLS = Array.from({ length: 10 }, (_, at) => ({ seq: 100 + at, stock: 1000 + at * 10, post: at === 4 || at === 8 }));
const TARGETS = [{ seq: 7, type: 'user/message', at: 2, reads: [{ at: 6, seq: 105 }] }, { seq: 8, type: 'tool/result', at: null, reads: [{ at: 7, seq: 999 }] }];
const ANSWER = {
  epoch: 1, attempts: ATTEMPTS, tailCalls: 2, calls: CALLS, cut: { segment: 0, through: 150 },
  recall: { steps: [{ at: 6, seq: 105, usage: { input: 20, output: 3, cacheRead: 40, cacheWrite: 10 }, ratio: 2, post: 10 }], cuts: [] },
  activity: { covered: true, judged: 5, pure: 2, targets: TARGETS },
};
const ready = value => ({ kind: 'ready', value });

// The monitor the drawers read: the resource of the closed segment and the reader factory, which records what is asked of it.
function monitorOf(result, asked = []) {
  return {
    resource: () => ({ get result() { return result; }, subscribe: () => () => {} }),
    settlementTarget: (cut) => {
      asked.push(['reader', cut]);
      return { state: { selected: null, result: null }, select: seq => asked.push(['select', seq]), subscribe: () => () => {} };
    },
  };
}
const session = { result: null, subscribe: () => () => {} };

const closedPage = (first, result = ready(ANSWER), asked = []) => {
  const listed = settlementsOf(ATTEMPTS, [{ id: 99, type: 'continue', epoch: 1, tailCalls: 2 }]).get(99);
  return renderToString(React.createElement(PagedDetail, {
    pages: SETTLEMENT_PAGES, first, labels: 'monitor.settlementPage', settlement: listed, handoffId: 99, monitor: monitorOf(result, asked), session, t,
  }));
};
const currentPage = (first, result = ready(ANSWER), asked = []) => renderToString(React.createElement(PagedDetail, {
  pages: CURRENT_SETTLEMENT_PAGES, first, labels: 'monitor.settlementPage', view: settlementViewOf(null, result), monitor: monitorOf(result, asked), t,
}));
const between = (html, open, close) => html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)));
const section = (html, name) => between(html, `<section class="${name}"`, '</section>');

test('the two drawers draw the same composition, the same targets and the same share from one answer', () => {
  for (const page of ['context', 'payback']) {
    const closed = page === 'context' ? closedPage('context') : closedPage('payback');
    const current = page === 'context' ? currentPage('context') : currentPage('payback');
    const strip = html => html.replace(/<div class="sw-mon-tabs".*?<\/div>/s, '').replace(/ data-page="\w+"/g, '');
    if (page === 'context') {
      assert.equal(section(closed, 'sw-cx-comp'), section(current, 'sw-cx-comp'));
      assert.equal(section(closed, 'sw-rc'), section(current, 'sw-rc'));
      assert.match(section(current, 'sw-cx-comp'), /合计 /);
      assert.equal(between(closed, '<p class="sw-cx-ctx">', '</p>'), between(current, '<p class="sw-cx-ctx">', '</p>'));
    } else {
      assert.equal(between(closed, '<p class="sw-pb-share">', '</p>'), between(current, '<p class="sw-pb-share">', '</p>'));
      assert.match(between(current, '<p class="sw-pb-share">', '</p>'), /纯召回步占比 40\.0%（2\/5 步）/);
      assert.equal(strip(closed).includes('sw-pb-curve'), true);
    }
  }
});

test('the composition of the answer reconciles with the payback page: its total is the cost of the page\'s formula, and its parts add up to that total', () => {
  const view = settlementViewOf(null, ready(ANSWER));
  const { composition } = contextModelOf(view, null, t);
  const { appendix } = paybackPageOf(view, t, true);

  assert.ok(appendix.equations.some(([left]) => left === `成本 ${composition.total.text}`), 'the cost of the formula is the composition\'s total');
  assert.equal(composition.items.reduce((sum, { text }) => sum + Number(text.replace(/,/g, '')), 0), Number(composition.total.text.replace(/,/g, '')));
  assert.equal(composition.total.value, view.report.cost, 'the report\'s own cost, unrounded');
});

test('the page makes the reader of a target\'s text for the cut the answer named, once, and reads nothing before a target is chosen', () => {
  for (const render of [closedPage, currentPage]) {
    const asked = [];
    render('context', ready(ANSWER), asked);
    assert.deepEqual(asked, [['reader', { segment: 0, through: 150 }]], render.name);
  }
  const none = [];
  closedPage('context', ready({ ...ANSWER, cut: undefined }), none);
  closedPage('context', null, none);
  closedPage('context', { kind: 'unreachable', message: 'x' }, none);
  assert.deepEqual(none, [], 'no cut, no reader');
});

test('the current drawer says an empty segment, one with nothing priced yet and one priced in part, and shows the pages for the rest', () => {
  const render = value => renderToString(React.createElement(CurrentSettlementDetail, { result: ready({ ...ANSWER, ...value }), monitor: monitorOf(null), t }));
  assert.match(render({ attempts: [] }), /data-sw-monitor-notice="current-empty"/);
  const unpriced = { ...attempt(10, 4), contextChange: null };
  assert.match(render({ attempts: [unpriced] }), /data-sw-monitor-notice="current-pending"/);
  const partial = render({ attempts: [attempt(10, 4), unpriced] });
  assert.match(partial, /data-sw-monitor-notice="current-partial"/);
  assert.match(partial, /role="tablist"/);
  const whole = render({});
  assert.equal(whole.includes('current-partial'), false);
  assert.match(whole, /data-page="payback"/);
  assert.equal(renderToString(React.createElement(CurrentSettlementDetail, { result: { kind: 'unreachable', message: 'boom' }, monitor: monitorOf(null), t })).includes('boom'), true);
});

test('the current drawer is titled by the segment and the step the answer reaches', () => {
  const state = reduceView(reduceView(createViewState(), { type: 'open-current-settlement', request: 1 }), { type: 'current-settlement-result', request: 1, result: ready(ANSWER) });
  const html = renderToString(React.createElement(MonitorDrawer, { state, monitor: monitorOf(null), session, ordinals: {}, handoffs: [], settlements: new Map(), now: 0, dispatch: () => {}, t }));
  assert.match(html, /分段 #1/);
  assert.match(html, /截至第 10 步/);
});

test('a closed segment whose answer prices nothing keeps its entry and its targets, and shows neither the list\'s figures nor a zero of its own', () => {
  const unpriced = ready({ ...ANSWER, attempts: ATTEMPTS.map(each => ({ ...each, contextChange: null })) });
  const payback = closedPage('payback', unpriced);
  assert.match(payback, /data-sw-monitor-notice="recall-unpriced"/);
  assert.match(between(payback, '<p class="sw-pb-share">', '</p>'), /纯召回步占比 40\.0%（2\/5 步）/);
  for (const name of ['sw-pb-head', 'sw-pb-chart', 'sw-pb-list', 'sw-pb-table']) assert.equal(payback.includes(name), false, name);
  const context = closedPage('context', unpriced);
  assert.equal(context.includes('sw-cx-comp'), false, 'no composition of nothing');
  assert.match(context, /data-sw-monitor-notice="recall-unpriced"/);
  assert.equal([...context.matchAll(/class="sw-rc-row"/g)].length, TARGETS.length, 'the targets are usable');
});

test('the payback page of either drawer is the status alone while no adjusted settlement is there: pending, failed, an older host\'s; the context page keeps its figures', () => {
  const old = ready({ ...ANSWER, activity: undefined });
  for (const [result, status] of [[null, 'recall-pending'], [{ kind: 'unreachable', message: 'x' }, 'recall-unavailable'], [old, 'recall-unavailable']]) {
    for (const render of [closedPage, currentPage]) {
      if (render === currentPage && result?.kind !== 'ready') continue;
      const html = render('payback', result);
      assert.match(html, new RegExp(`data-sw-monitor-notice="${status}"`), `${render.name} ${status}`);
      for (const name of ['sw-pb-head', 'sw-pb-facts', 'sw-pb-chart', 'sw-pb-list', 'sw-pb-table', 'sw-pb-share']) assert.equal(html.includes(name), false, `${render.name} ${status} ${name}`);
    }
    const context = closedPage('context', result);
    assert.equal(context.includes('sw-cx-comp-list'), true, 'the composition of the figures there are stays reachable');
    assert.equal(context.includes('sw-cx-comp-total'), false);
  }
});
