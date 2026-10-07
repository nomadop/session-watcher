// The DSH composer dock's view: the pill, a lamp ring with the bill premium or one short word, and the popover of the position, the context stock and the alert clock it opens through the handed portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createDock, latestAlert } from '../dsh/src/client/dock.js';
import { en, zh } from '../dsh/src/client/locales.js';

const translate = dictionary => (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => params[name]);
const tEn = translate(en);
const tZh = translate(zh);

/** Pass-through hook fakes and a portal that returns its node, each recording its calls. */
function fakes({ position = null } = {}) {
  const calls = { anchored: [], dismiss: [], portal: [] };
  const useAnchoredPosition = (options) => { calls.anchored.push(options); return position; };
  const useDismissOnOutsidePointer = (...args) => { calls.dismiss.push(args); };
  const createPortal = (node, target) => { calls.portal.push(target); return node; };
  return { calls, ...createDock({ useAnchoredPosition, useDismissOnOutsidePointer, createPortal }) };
}

/** A `document` stub carrying the `body` the open popover portals into, restored after the case. */
function stubDocument(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = { body: { tag: 'body' }, addEventListener() {}, removeEventListener() {} };
  globalThis.document = doc;
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  return doc;
}

/**
 * A live result whose reference is the line x = 0.5 + 2u, so the axis starts at 0.5 and a position's x is 0.5 + 2u; its landmarks put the four bands at 10%, 30%, 40% and 20% of the track and the sweet spot at 20%. The origin and the slope are not 1, so a track that assumes either places everything differently.
 * `rateLamp` overrides merge into the rate lamp, the other keys into the status.
 */
function liveResult({ rateLamp = {}, ...status } = {}) {
  return {
    kind: 'live',
    snapshot: {
      status: {
        lamp: 'amber', L: 120000, B: 150000, bDefault: 100000,
        rateLamp: {
          reliable: true, br: 0.129, u: 1.5, gEma: 450.4,
          reference: { a: 0.5, d: 2, provisional: false }, xSweet: 2.5, xBrAmberL: 1.5, xBrAmberR: 4.5, xBrRedR: 8.5,
          rentMeter: { depthActive: true, depthProgress: 0.379, backstopLapCount: 0, depthHot: false },
          lastStopEvent: null,
          ...rateLamp,
        },
        ...status,
      },
      history: [], capabilities: {}, bucketData: {},
    },
  };
}

/** A stop event in the shape the rent ledger emits: `billCount` is the lap count the clock had reached when it fired. */
const alertEvent = (billCount, message = `Carry rent reminder ${billCount}: accumulated rent reached the reminder point. Consider restart/compact at the next natural boundary.`) => ({
  kind: 'backstop', delivery: 'reader_path', message, billCount, seq: billCount * 10,
});
/** A live result whose alert clock has rolled `backstopLapCount` laps. */
const withLaps = backstopLapCount => liveResult({ rateLamp: { rentMeter: { depthActive: true, depthProgress: 0.379, backstopLapCount, depthHot: backstopLapCount >= 3 } } });

const render = (DockView, props) => renderToString(React.createElement(DockView, { t: tEn, open: false, onOpenChange: () => {}, alert: null, ...props }));

const CLOSE = '</button>';
/** The markup of the popover that follows the pill button. */
const panelOf = html => html.slice(html.indexOf(CLOSE) + CLOSE.length);
/** The visible text fragments of some markup, in order. */
const texts = html => html.replace(/<[^>]*>/g, '\n').split('\n').map(part => part.trim()).filter(Boolean);
const attr = (html, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(html)?.[1];

const BOOTSTRAPPING = { kind: 'state', state: 'bootstrapping' };
const UNOBSERVED = { kind: 'state', state: 'unobserved' };
const FAILED = { kind: 'state', state: 'failed', diagnostic: { message: 'read refused' } };
const UNREACHABLE = { kind: 'unreachable', message: 'socket closed' };
const UNRELIABLE = liveResult({ lamp: null, rateLamp: { reliable: false } });
/** A reliable lamp before the first interval closes: `u` is zero and `br` is null. */
const NO_BR = liveResult({ lamp: 'white', rateLamp: { br: null, u: 0 } });

test('a result without a reading renders the pill as a white ring with no arc and one short word, closed with no popover', () => {
  const { DockView, calls } = fakes();
  const cases = [
    [null, 'reading'], [BOOTSTRAPPING, 'reading'], [UNOBSERVED, 'unobserved'], [FAILED, 'failed'], [UNREACHABLE, 'unreachable'], [UNRELIABLE, 'Calibrating'],
    [NO_BR, 'Calibrating'], [liveResult({ rateLamp: { br: NaN } }), 'Calibrating'], [liveResult({ rateLamp: { br: undefined } }), 'Calibrating'],
  ];
  for (const [result, word] of cases) {
    const html = render(DockView, { result });
    assert.match(html, /^<button [^>]*data-sw-dock=""/, word);
    assert.deepEqual(texts(html), [word]);
    assert.ok(html.includes('data-zone="white"'), word);
    assert.ok(!html.includes('class="arc"') && !html.includes('sw-arm') && !html.includes('sw-count') && !html.includes('%'), html);
    assert.equal(attr(html, 'aria-label'), `Session Watcher: ${word}`);
    assert.equal(attr(html, 'title'), `Session Watcher: ${word}`);
    assert.ok(!html.includes('role="dialog"'), html);
  }
  assert.deepEqual(calls.portal, []);
});

test('a result without a reading names its short word in the Chinese locale too', () => {
  const { DockView } = fakes();
  assert.deepEqual(texts(render(DockView, { result: UNRELIABLE, t: tZh })), ['校准中']);
  assert.deepEqual(texts(render(DockView, { result: null, t: tZh })), ['读取中']);
  assert.equal(attr(render(DockView, { result: UNOBSERVED, t: tZh }), 'aria-label'), 'Session Watcher：未观测');
});

test('a reading renders the pill as the lamp ring, the bill premium with its label, the arm arrow, and a full-sentence name', () => {
  const { DockView, calls } = fakes();
  const html = render(DockView, { result: liveResult() });
  assert.match(html, /^<button [^>]*data-sw-dock=""/);
  assert.match(html, /^<button [^>]*aria-expanded="false"/);
  assert.deepEqual(texts(html), ['Bill premium 12%']);
  assert.ok(html.includes('data-zone="amber"'), 'the ring\'s core is the lamp zone');
  assert.ok(!html.includes('sw-count'), 'no laps, no badge');
  const name = 'Session Watcher: Bill premium 12%, Right arm: bill premium rises as the session continues, Alert clock 37%';
  assert.equal(attr(html, 'aria-label'), name);
  assert.equal(attr(html, 'title'), name);
  assert.ok(!html.includes('role="dialog"'), 'closed, no popover');
  assert.deepEqual(calls.portal, []);

  const chinese = render(DockView, { result: liveResult(), t: tZh });
  assert.deepEqual(texts(chinese), ['账单溢价 12%']);
  assert.equal(attr(chinese, 'aria-label'), 'Session Watcher：账单溢价 12%，右臂：账单溢价随会话推进而上升，提醒时钟 37%');
});

test('the pill caps the printed bill premium at 99% while its name keeps the real value', () => {
  const { DockView } = fakes();
  const over = render(DockView, { result: liveResult({ rateLamp: { br: 2.96 } }) });
  assert.deepEqual(texts(over), ['Bill premium 99%']);
  assert.ok(attr(over, 'aria-label').includes('Bill premium 296%'), attr(over, 'aria-label'));
  assert.deepEqual(texts(render(DockView, { result: liveResult({ rateLamp: { br: 0.995 } }) })), ['Bill premium 99%']);
  assert.deepEqual(texts(render(DockView, { result: liveResult({ rateLamp: { br: 0.5 } }) })), ['Bill premium 50%']);
  assert.deepEqual(texts(render(DockView, { result: liveResult({ rateLamp: { br: 0 } }) })), ['Bill premium 0%'], 'zero is a reading');
});

test('the arrow points down for u below one and up for u at one or above', () => {
  const { DockView } = fakes();
  const arm = u => attr(render(DockView, { result: liveResult({ rateLamp: { u } }) }), 'data-arm');
  assert.equal(arm(0.7), 'left');
  assert.equal(arm(0.999), 'left');
  assert.equal(arm(1), 'right');
  assert.equal(arm(1.26), 'right');
  const left = render(DockView, { result: liveResult({ rateLamp: { u: 0.7 } }) });
  assert.ok(attr(left, 'aria-label').includes('Left arm: bill premium falls as the session continues'), attr(left, 'aria-label'));
});

test('the glyph itself falls across its width for the left arm and rises for the right arm, where the data-arm attribute alone would pass a swapped pair', () => {
  const { DockView } = fakes();
  // The glyph's line is the first subpath of its path, absolute x y pairs; SVG's y grows downward, so a line that falls ends at the larger y.
  const fall = (u) => {
    const ys = attr(render(DockView, { result: liveResult({ rateLamp: { u } }) }), 'd').split('M')[1].trim().split(/\s+/).map(Number).filter((_, index) => index % 2 === 1);
    return ys.at(-1) - ys[0];
  };
  assert.ok(fall(0.7) > 0);
  assert.ok(fall(1.5) < 0);
});

test('the ring\'s arc is the clock\'s floor percent, clamped below a full turn, absent at zero, and the ring is dashed and arcless while the clock is idle', () => {
  const { DockView } = fakes();
  const meter = rentMeter => render(DockView, { result: liveResult({ rateLamp: { rentMeter } }) });
  const active = meter({ depthActive: true, depthProgress: 0.379, backstopLapCount: 0, depthHot: false });
  assert.equal(attr(active, 'stroke-dasharray'), '37 100');
  assert.ok(!active.includes('data-idle'), active);
  assert.equal(attr(meter({ depthActive: true, depthProgress: 1.4, backstopLapCount: 0, depthHot: false }), 'stroke-dasharray'), '99 100');
  const fresh = meter({ depthActive: true, depthProgress: 0, backstopLapCount: 0, depthHot: false });
  assert.ok(!fresh.includes('class="arc"') && !fresh.includes('data-idle'), fresh);
  const idle = meter({ depthActive: false, depthProgress: 0.379, backstopLapCount: 0, depthHot: false });
  assert.ok(idle.includes('data-idle=""') && !idle.includes('class="arc"'), idle);
  assert.ok(attr(idle, 'aria-label').endsWith('Alert clock idle'), attr(idle, 'aria-label'));
  assert.ok(!idle.includes('37%'), idle);
});

test('a lap count above zero puts a badge on the pill showing the count up to 99 and 99+ beyond, warn-coloured until the count is hot', () => {
  const { DockView } = fakes();
  const badge = (backstopLapCount, depthHot = false) => render(DockView, {
    result: liveResult({ rateLamp: { rentMeter: { depthActive: true, depthProgress: 0.379, backstopLapCount, depthHot } } }),
  });
  assert.ok(!badge(0).includes('sw-count'));
  for (const [count, shown] of [[1, '1'], [99, '99'], [100, '99+'], [1000, '99+']]) {
    const html = badge(count);
    assert.deepEqual(texts(html), ['Bill premium 12%', shown], String(count));
    assert.equal(attr(html, 'aria-label'), `Session Watcher: Bill premium 12%, Right arm: bill premium rises as the session continues, Alert clock 37%, Alert clock laps: ${count}`);
    assert.ok(html.includes(`aria-label="Alert clock laps: ${count}"`), html);
    assert.ok(!html.includes('data-hot'), html);
  }
  assert.ok(badge(3, true).includes('data-hot=""'));
});

test('the hooks run on every render, open or closed', (t_) => {
  stubDocument(t_);
  const { DockView, calls } = fakes();
  const onOpenChange = () => {};
  const renders = [
    { result: null, open: false },
    { result: UNRELIABLE, open: false },
    { result: liveResult(), open: false },
    { result: liveResult(), open: true },
  ];
  for (const props of renders) render(DockView, { ...props, onOpenChange });
  assert.equal(calls.anchored.length, renders.length);
  assert.equal(calls.dismiss.length, renders.length);
  for (const [index, options] of calls.anchored.entries()) {
    assert.equal(options.open, renders[index].open);
    assert.equal(options.side, 'top');
    assert.equal(typeof options.gap, 'number');
    assert.equal(typeof options.margin, 'number');
    const [root, open, setOpen, portal] = calls.dismiss[index];
    assert.equal(root, options.anchorRef, 'the dismissal root is the anchor');
    assert.equal(portal, options.panelRef, 'the portaled panel counts as inside');
    assert.equal(open, renders[index].open);
    assert.equal(setOpen, onOpenChange);
  }
});

const open = (DockView, props) => render(DockView, { open: true, ...props });

test('an open popover is portaled into document.body as one dialog, hidden until the position is measured, under a reading and without one', (t_) => {
  const doc = stubDocument(t_);
  const { DockView, calls } = fakes();
  for (const result of [liveResult(), UNRELIABLE, null]) {
    const html = open(DockView, { result });
    assert.match(html, /^<button [^>]*aria-expanded="true"/);
    assert.match(panelOf(html), /^<div data-sw-dock="" role="dialog" aria-label="Session Watcher readings"/);
    assert.ok(panelOf(html).includes('visibility:hidden'), 'the panel stays hidden until the position is measured');
  }
  assert.deepEqual(calls.portal, [doc.body, doc.body, doc.body]);

  const placed = fakes({ position: { left: 10, top: 20 } });
  const positioned = open(placed.DockView, { result: liveResult() });
  assert.ok(panelOf(positioned).includes('left:10px;top:20px'), positioned);
  assert.ok(!positioned.includes('visibility:hidden'));
});

test('an open popover without a reading holds the header with the pill\'s word and one line: the state text, or for a live result that there is not enough data yet', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const lines = result => texts(panelOf(open(DockView, { result })));
  assert.deepEqual(lines(null), ['Session Watcher', 'reading', 'Session Watcher is reading this session…']);
  assert.deepEqual(lines(UNOBSERVED), ['Session Watcher', 'unobserved', 'Session Watcher is not observing this session.']);
  assert.deepEqual(lines(FAILED), ['Session Watcher', 'failed', 'Session Watcher could not measure this session: read refused']);
  assert.deepEqual(lines(UNREACHABLE), ['Session Watcher', 'unreachable', 'Session Watcher cannot be reached: socket closed']);
  assert.deepEqual(lines(UNRELIABLE), ['Session Watcher', 'Calibrating', 'Not enough data yet for a reliable reading.']);
  assert.deepEqual(lines(NO_BR), ['Session Watcher', 'Calibrating', 'Not enough data yet for a reliable reading.']);
  assert.deepEqual(texts(panelOf(open(DockView, { result: UNRELIABLE, t: tZh }))), ['Session Watcher', '校准中', '数据尚不足以形成可靠读数。']);
  const toned = result => panelOf(open(DockView, { result })).includes('data-tone="error"');
  assert.deepEqual([FAILED, UNREACHABLE, UNOBSERVED, null, UNRELIABLE].map(toned), [true, true, false, false, false]);
});

test('an open popover with a reading lists the bill premium, the position, the context stock and the alert clock as labels beside values, with no abbreviated name and no explanation', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const html = panelOf(open(DockView, { result: liveResult() }));
  assert.deepEqual(texts(html), [
    'Session Watcher', 'Deepening',
    '12%', 'Bill premium', '1.5', 'Normalized position',
    'Sweet spot',
    'Context stock', '120,000 tok', 'Rebuild baseline', '100,000 tok', 'Effective context', '20,000 tok', 'Growth per call', '450 tok',
    'Alert clock', '37%',
  ]);
  assert.deepEqual(texts(panelOf(open(DockView, { result: liveResult(), t: tZh }))), [
    'Session Watcher', '渐深',
    '12%', '账单溢价', '1.5', '归一化位置',
    '甜点',
    '上下文存量', '120,000 tok', '重建基线', '100,000 tok', '有效上下文', '20,000 tok', '每次调用增长', '450 tok',
    '提醒时钟', '37%',
  ]);
});

test('the header value names the lamp\'s zone in the aux bar\'s words, the amber band as the stretch where sweet turns deep, and the header ring carries the zone', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const header = (lamp, t) => {
    const html = panelOf(open(DockView, { result: liveResult({ lamp }), t }));
    return [texts(html)[1], html.slice(0, html.indexOf('</svg>')).includes(`data-zone="${lamp}"`)];
  };
  assert.deepEqual(['white', 'green', 'amber', 'red'].map(lamp => header(lamp, tEn)), [['Shallow', true], ['Sweet', true], ['Deepening', true], ['Deep', true]]);
  assert.deepEqual(['white', 'green', 'amber', 'red'].map(lamp => header(lamp, tZh)), [['偏浅', true], ['甜点区', true], ['渐深', true], ['偏深', true]]);
});

test('the panel prints the real bill premium, above the pill\'s cap, and an unavailable growth as the placeholder', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  assert.equal(texts(panelOf(open(DockView, { result: liveResult({ rateLamp: { br: 2.96 } }) })))[2], '296%');
  const growth = gEma => texts(panelOf(open(DockView, { result: liveResult({ rateLamp: { gEma } }) }))).at(-3);
  assert.equal(growth(450.4), '450 tok');
  assert.equal(growth(12345.6), '12,346 tok');
  assert.equal(growth(0.5), '—');
  assert.equal(growth(null), '—');
});

/** The track's bands with their zone and flex weight, the lit layer as the percent of the track its clip shows with the bands it repeats, and the marker, sweet-spot tick and label positions in percent. */
function trackOf(html) {
  const percent = pattern => { const match = pattern.exec(html); return match === null ? null : Number(match[1]); };
  const bandsIn = markup => [...markup.matchAll(/<i data-zone="(\w+)" style="flex:([\d.]+)"><\/i>/g)].map(([, zone, flex]) => ({ zone, flex: Number(flex) }));
  const lit = /<div class="sw-lit" style="clip-path:inset\(0 ([\d.]+)% 0 0\)">(.*?)<\/div>/.exec(html);
  return {
    bands: bandsIn(lit === null ? html : html.replace(lit[0], '')),
    lit: lit === null ? null : { shown: 100 - Number(lit[1]), bands: bandsIn(lit[2]) },
    marker: percent(/<b style="left:([\d.]+)%"/),
    tick: percent(/<s style="left:([\d.]+)%/),
    label: percent(/<span style="left:([\d.]+)%">Sweet spot</),
  };
}

test('the position track places the four bands, the marker at the projected x and the sweet spot at its landmark, on the reference\'s x axis', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const track = trackOf(panelOf(open(DockView, { result: liveResult() })));
  assert.deepEqual(track.bands, [
    { zone: 'white', flex: 10 }, { zone: 'green', flex: 30 }, { zone: 'amber', flex: 40 }, { zone: 'red', flex: 20 },
  ]);
  assert.deepEqual([track.marker, track.tick, track.label], [30, 20, 20]);
  assert.equal(trackOf(panelOf(open(DockView, { result: liveResult({ rateLamp: { u: 0 } }) }))).marker, 0);
  assert.equal(trackOf(panelOf(open(DockView, { result: liveResult({ rateLamp: { u: 10 } }) }))).marker, 100, 'a position beyond the axis stays on its end');
});

test('the position track lights its bands from the start of the axis up to the marker, the lit layer repeating the bands so the light ends inside the band the position stands in', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const trackAt = u => trackOf(panelOf(open(DockView, { result: liveResult({ rateLamp: { u } }) })));
  // On this fixture's axis the marker stands at 20 percent per unit of u, and a position beyond the axis stays on its end.
  for (const [u, shown] of [[0, 0], [0.4, 8], [1.5, 30], [2.3, 46], [3.9, 78], [10, 100]]) {
    const track = trackAt(u);
    assert.equal(track.lit?.shown, shown, `u ${u}`);
    assert.equal(track.marker, shown, `u ${u}`);
    assert.deepEqual(track.lit?.bands, track.bands, `u ${u}`);
  }
});

test('the position track is absent, its label with it, when the reference or any landmark or the position is missing or not finite', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const missing = [
    { reference: null }, { reference: undefined }, { u: NaN }, { u: null },
    ...['xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR'].flatMap(key => [{ [key]: null }, { [key]: undefined }, { [key]: NaN }, { [key]: Infinity }]),
  ];
  for (const rateLamp of missing) {
    const html = panelOf(open(DockView, { result: liveResult({ rateLamp }) }));
    assert.ok(!html.includes('<i data-zone'), JSON.stringify(rateLamp));
    assert.ok(!texts(html).includes('Sweet spot'), JSON.stringify(rateLamp));
    assert.ok(texts(html).includes('Context stock'), 'the other blocks stay');
  }
});

/** The context bar's two segments' flex weights, baseline then effective. */
const stockOf = html => [...html.matchAll(/<i data-k="(base|eff)" style="flex:(\d+)"><\/i>/g)].map(([, kind, flex]) => [kind, Number(flex)]);

test('the context bar is two segments weighted by the rebuild baseline and the effective context, the baseline from bDefault else B', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const panel = result => panelOf(open(DockView, { result }));
  const normal = panel(liveResult());
  assert.deepEqual(stockOf(normal), [['base', 100000], ['eff', 20000]]);
  assert.deepEqual(stockOf(panel(liveResult({ bDefault: undefined }))), [['base', 150000], ['eff', 0]], 'B is the baseline when bDefault is absent, and L below it leaves no effective context');
  assert.ok(texts(panel(liveResult({ bDefault: undefined }))).includes('150,000 tok'));
});

test('the context stock prints its counts whole and grouped by thousands, where an abbreviation would drop the digits', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const lines = texts(panelOf(open(DockView, { result: liveResult({ L: 1234567, bDefault: 100000 }) })));
  assert.deepEqual(lines.slice(7, 13), ['Context stock', '1,234,567 tok', 'Rebuild baseline', '100,000 tok', 'Effective context', '1,134,567 tok']);
});

test('the context bar and its rows cap a negative effective context at zero and do not fail at a zero stock', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const panel = result => panelOf(open(DockView, { result }));
  const below = panel(liveResult({ L: 60000 }));
  assert.deepEqual(stockOf(below), [['base', 100000], ['eff', 0]]);
  assert.deepEqual(texts(below).slice(7, 13), ['Context stock', '60,000 tok', 'Rebuild baseline', '100,000 tok', 'Effective context', '0 tok']);
  const empty = panel(liveResult({ L: 0 }));
  assert.deepEqual(stockOf(empty), [['base', 100000], ['eff', 0]]);
  assert.deepEqual(texts(empty).slice(7, 13), ['Context stock', '0 tok', 'Rebuild baseline', '100,000 tok', 'Effective context', '0 tok']);
  for (const html of [below, empty]) assert.ok(!html.includes('NaN'), html);
});

test('the alert clock row shows the floor percent with a bar of that width, and while idle the idle word and no bar', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const clock = (rentMeter, t = tEn) => panelOf(open(DockView, { result: liveResult({ rateLamp: { rentMeter } }), t }));
  const active = clock({ depthActive: true, depthProgress: 0.379, backstopLapCount: 0, depthHot: false });
  assert.deepEqual(texts(active).slice(-2), ['Alert clock', '37%']);
  assert.equal(/<div class="sw-bar" data-zone="amber" aria-hidden="true"><i style="width:(\d+)%"><\/i><\/div>/.exec(active)?.[1], '37');
  const idle = clock({ depthActive: false, depthProgress: 0.379, backstopLapCount: 0, depthHot: false });
  assert.deepEqual(texts(idle).slice(-2), ['Alert clock', 'idle']);
  assert.ok(!idle.includes('sw-bar'), idle);
  assert.deepEqual(texts(clock({ depthActive: false }, tZh)).slice(-2), ['提醒时钟', '未启动']);
});

test('the lap count and the arm have no place in the popover: the pill badge carries the count and the pill\'s name the arm', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const baseline = texts(panelOf(open(DockView, { result: liveResult({ rateLamp: { u: 0.7 } }) })));
  const hot = liveResult({ rateLamp: { u: 0.7, rentMeter: { depthActive: true, depthProgress: 0.379, backstopLapCount: 42, depthHot: true } } });
  const lines = texts(panelOf(open(DockView, { result: hot })));
  assert.deepEqual(lines, baseline);
  assert.ok(!lines.some(line => /42|arm:|falls|rises/.test(line)), lines.join(' | '));
});

test('the alert shows as its message in a box under the alert clock while the clock\'s laps have not fallen below the alert\'s billCount, and no box without one', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const alert = alertEvent(3);
  const alerted = panelOf(open(DockView, { result: withLaps(3), alert }));
  assert.deepEqual(texts(alerted).slice(-3), ['Alert clock', '37%', alert.message]);
  assert.ok(alerted.includes(`<div class="sw-alert" data-zone="amber"><p>${alert.message}</p></div>`), alerted);
  assert.ok(panelOf(open(DockView, { result: withLaps(5), alert })).includes('sw-alert'), 'later laps of the same context keep it');
  for (const result of [withLaps(2), withLaps(0), liveResult()]) {
    assert.ok(!panelOf(open(DockView, { result, alert })).includes('sw-alert'), 'laps below billCount, as after a context restart: no box');
  }
  assert.ok(!panelOf(open(DockView, { result: withLaps(3) })).includes('sw-alert'), 'no alert, no box');
  const idle = liveResult({ rateLamp: { rentMeter: { depthActive: false, backstopLapCount: 3 } } });
  assert.deepEqual(texts(panelOf(open(DockView, { result: idle, alert }))).slice(-3), ['Alert clock', 'idle', alert.message]);
  assert.ok(!panelOf(open(DockView, { result: UNRELIABLE, alert })).includes(alert.message), 'without a reading the popover holds its one line');
});

test('latestAlert keeps the latest alert event a live result carried: one that appears stays over results without an event and over results that are not live, and a newer one replaces it', () => {
  const carrying = lastStopEvent => liveResult({ rateLamp: { lastStopEvent } });
  const first = alertEvent(1);
  assert.equal(latestAlert(null, null), null);
  assert.equal(latestAlert(null, liveResult()), null);
  assert.equal(latestAlert(null, carrying(first)), first);
  assert.equal(latestAlert(first, liveResult()), first, 'the server clearing the event does not clear the alert');
  assert.equal(latestAlert(first, UNREACHABLE), first);
  assert.equal(latestAlert(first, null), first);
  assert.equal(latestAlert(first, liveResult({ rateLamp: { reliable: false, lastStopEvent: null } })), first);
  const second = alertEvent(2);
  assert.equal(latestAlert(first, carrying(second)), second);
  assert.equal(latestAlert(first, carrying(alertEvent(2, ''))), first, 'an event without a message is no event');
});

test('an alert stays through results that drop it, hides when a context restart takes the laps back below its billCount, and shows again when a newer alert arrives', (t_) => {
  stubDocument(t_);
  const { DockView } = fakes();
  const shows = (alert, result) => panelOf(open(DockView, { result, alert })).includes('sw-alert');
  const third = alertEvent(3);
  let alert = latestAlert(null, liveResult({ rateLamp: { lastStopEvent: third, rentMeter: { depthActive: true, depthProgress: 0.1, backstopLapCount: 3, depthHot: true } } }));
  assert.equal(shows(alert, withLaps(3)), true);
  alert = latestAlert(alert, withLaps(3));
  assert.equal(shows(alert, withLaps(3)), true, 'the event cleared at the turn boundary, the laps unchanged');
  alert = latestAlert(alert, withLaps(0));
  assert.equal(shows(alert, withLaps(0)), false, 'the restarted context starts over at zero laps');
  const restarted = alertEvent(1);
  alert = latestAlert(alert, liveResult({ rateLamp: { lastStopEvent: restarted, rentMeter: { depthActive: true, depthProgress: 0.1, backstopLapCount: 1, depthHot: false } } }));
  assert.equal(alert, restarted);
  assert.equal(shows(alert, withLaps(1)), true);
});
