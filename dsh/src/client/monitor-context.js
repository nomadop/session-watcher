// dsh/src/client/monitor-context.js — the context page of the settlement drawer: the input stock chart of the segment's calls with its readout, cursor and the line it is measured against, the cost composition, the list of the rebuild of each compaction, the recall targets on the settlement axis with the text of the chosen one, and the folded trial of the rebuild extra. The model is `monitor-context-model.js` and `monitor-recall-model.js`; the view state is the reducer's.
import React from 'react';
import { NOT_AVAILABLE, PART_SEPARATOR } from './monitor-state.js';
import { Label, useElementWidth } from './monitor-chart.js';
import { Notice, RecallNotice, useSettlementResult } from './monitor-handle.js';
import {
  amberLineOf, stockGeometryOf, lamGeometryOf, callAtX, cursorOf, cursorKeyAt, sealStepAt, readoutOf, shareReadoutOf, contextPageOf, createContextState, reduceContext, isFoldOpen,
} from './monitor-context-model.js';
import { targetGraphOf, selectionOf, excerptOf } from './monitor-recall-model.js';

const h = React.createElement;

const PERCENT = 100;
const SHARE_INPUT_ID = 'sw-cx-share';
// The heights of a target row's track and of the axis over the rows, in pixels.
const TRACK_HEIGHT = 20;
const AXIS_HEIGHT = 18;
// How much of a target's text shows before it is expanded, in characters.
const EXCERPT_CHARS = 280;

const MarkLabel = ({ label, className }) => h(Label, { className: `sw-cx-halo ${className}`, x: label.x, y: label.y, anchor: label.anchor }, label.text);

/**
 * The input stock chart over `geometry` (`stockGeometryOf`) of `series`: the lines and marks, the axes, the seals with their hit areas and, over the plot, the area the pointer reads the call from. The chart takes the focus and the keys that move the cursor; `shown` is the call the readout shows and `cursor` the one the keys move.
 */
function StockChart({ stock, geometry: g, cursor, shown, dispatch, t }) {
  const { series } = stock;
  const place = (event) => {
    const box = event.currentTarget.ownerSVGElement.getBoundingClientRect();
    return callAtX(g, series, (event.clientX - box.left) * g.width / box.width);
  };
  const marker = cursorOf(g, shown);
  return h('svg', {
    className: 'sw-cx-svg',
    width: g.width,
    height: g.height,
    viewBox: `0 0 ${g.width} ${g.height}`,
    tabIndex: 0,
    role: 'group',
    'aria-roledescription': t('monitor.context.chart.kind'),
    'aria-label': stock.label,
    onFocus() { if (cursor === null) dispatch({ type: 'cursor', at: series.drawn[0].at }); },
    onKeyDown(event) {
      const at = cursorKeyAt(series, cursor, event.key, event.shiftKey, shown);
      if (at === null) return;
      event.preventDefault();
      dispatch({ type: 'cursor', at });
    },
    onPointerLeave() { dispatch({ type: 'leave' }); },
  },
  h('rect', { className: 'sw-cx-plotbg', x: g.left, y: g.plotTop, width: g.plotWidth, height: g.plotHeight }),
  g.ticks.map(tick => h(React.Fragment, { key: tick.value },
    h('line', { className: 'sw-cx-grid', x1: g.left, y1: tick.y, x2: g.left + g.plotWidth, y2: tick.y }),
    h(Label, { className: 'sw-cx-lbl', x: g.left - 4, y: tick.y + 4, anchor: 'end' }, tick.label))),
  h(Label, { className: 'sw-cx-lbl', x: g.left, y: g.plotTop - 4 }, t('monitor.context.chart.y')),
  g.seals.map(seal => h(React.Fragment, { key: seal.at },
    h('line', { className: 'sw-cx-sealline', x1: seal.x, y1: g.plotTop, x2: seal.x, y2: g.foot }),
    h('line', { className: 'sw-cx-seal', x1: seal.x, y1: g.foot, x2: seal.x, y2: g.sealTickTop }))),
  g.line === null ? null : h(React.Fragment, null,
    h('line', { className: 'sw-cx-warnline', x1: g.left, y1: g.line.y, x2: g.left + g.plotWidth, y2: g.line.y }),
    h(MarkLabel, { label: g.line.label, className: 'sw-cx-warn' })),
  h('path', { className: 'sw-cx-actual', d: g.actual }),
  h('svg', { x: g.left, y: g.plotTop, width: g.plotWidth, height: g.plotHeight, viewBox: `${g.left} ${g.plotTop} ${g.plotWidth} ${g.plotHeight}`, overflow: 'hidden', 'aria-hidden': 'true' },
    h('path', { className: 'sw-cx-uncompressed', d: g.uncompressed })),
  g.uncompressedCross === null ? null : h(React.Fragment, null,
    h('path', { className: 'sw-cx-xmark', d: g.uncompressedCross.d }),
    h(MarkLabel, { label: g.uncompressedCross.label, className: 'sw-cx-biz' })),
  g.actualCross === null ? null : h(React.Fragment, null,
    h('circle', { className: 'sw-cx-actualcross', cx: g.actualCross.x, cy: g.actualCross.y, r: 3.5 }),
    h(MarkLabel, { label: g.actualCross.label, className: 'sw-cx-ink' })),
  g.rings.map(ring => h('circle', { key: ring.at, className: 'sw-cx-ring', cx: ring.x, cy: ring.y, r: 6, 'aria-hidden': 'true' })),
  h('path', { className: 'sw-cx-axis', d: g.axisPath }),
  g.xTicks.map(tick => h(React.Fragment, { key: tick.label },
    h('line', { className: 'sw-cx-grid', x1: tick.x, y1: g.foot, x2: tick.x, y2: g.xAxis.tickEnd }),
    h(Label, { className: 'sw-cx-lbl', x: tick.x, y: g.xAxis.labelY, anchor: 'middle' }, tick.label))),
  h(Label, { className: 'sw-cx-lbl', x: g.xUnit.x, y: g.xUnit.y, anchor: 'end' }, g.xUnit.text),
  g.seals.map(seal => h('rect', { key: seal.at, className: 'sw-cx-sealhit', x: seal.x - g.sealHit.width / 2, y: g.sealHit.y, width: g.sealHit.width, height: g.sealHit.height, onClick: () => dispatch({ type: 'cursor', at: seal.land }) })),
  h('rect', {
    className: 'sw-cx-hit', x: g.hit.x, y: g.hit.y, width: g.hit.width, height: g.hit.height,
    onPointerMove: event => dispatch({ type: 'hover', at: place(event) }),
    onClick: event => dispatch({ type: 'cursor', at: place(event) }),
  }),
  marker === null ? null : h('g', { className: 'sw-cx-curg', pointerEvents: 'none' },
    h('line', { className: 'sw-cx-cur', x1: marker.x, y1: g.plotTop, x2: marker.x, y2: g.foot }),
    marker.uncompressedY === null ? null : h('circle', { className: 'sw-cx-curdot sw-cx-curp', cx: marker.x, cy: marker.uncompressedY, r: 3.2 }),
    h('circle', { className: 'sw-cx-curdot', cx: marker.x, cy: marker.y, r: 3.2 })));
}

// The legend of the chart's lines: each its swatch drawn as the line is and its name, the uncompressed line with its assumption.
function Legend({ t }) {
  const swatch = (width, height, className, d) => h('svg', { width, height, 'aria-hidden': 'true' }, h('path', { className: `sw-cx-sw ${className}`, d }));
  return h('ul', { className: 'sw-cx-legend', 'aria-label': t('monitor.context.legend') },
    h('li', null, swatch(20, 8, 'sw-cx-sw-actual', 'M0 4 H20'), t('monitor.context.legend.actual')),
    h('li', null, swatch(20, 8, 'sw-cx-sw-uncompressed', 'M0 4 H20'), t('monitor.context.legend.uncompressed'), ' ', h('span', { className: 'sw-cx-assume' }, t('monitor.context.legend.assumption'))),
    h('li', null, swatch(14, 12, 'sw-cx-sw-seal', 'M7 0 V10'), t('monitor.context.seal')));
}

// The readout over the chart, sticky: what to do while there is no call to read, else the call's two lines.
function Readout({ lines, t }) {
  return h('div', { className: 'sw-cx-read', 'aria-live': 'polite' }, lines === null
    ? h('span', { className: 'sw-cx-r sw-cx-hint' }, t('monitor.context.read.hint'))
    : [h('span', { key: 'where', className: 'sw-cx-r sw-cx-r1' }, lines[0]), h('span', { key: 'stock', className: 'sw-cx-r' }, lines[1])]);
}

// The chart with its heading and the buttons that step the cursor to the compaction before and after the call shown, the facts line, the chart whose container `chartRef` measures and the legend.
function StockBlock({ stock, geometry, state, shown, chartRef, dispatch, t }) {
  const step = direction => () => { dispatch({ type: 'cursor', at: sealStepAt(stock.series, shown, direction) }); };
  const button = (direction, label, text) => h('button', { type: 'button', className: 'sw-cx-btn', 'aria-label': t(label), onClick: step(direction) }, text);
  return h(React.Fragment, null,
    h('div', { className: 'sw-cx-h' }, h('h3', null, t('monitor.context.stock')), h('span', { className: 'sw-cx-tag' }, button(-1, 'monitor.context.seal.prev', '‹'), ` ${t('monitor.context.seal')} `, button(1, 'monitor.context.seal.next', '›'))),
    h('div', { className: 'sw-cx-facts' }, h('span', null, stock.facts)),
    h('div', { className: 'sw-cx-chartbox', ref: chartRef }, h(StockChart, { stock, geometry, cursor: state.cursor, shown, dispatch, t })),
    h(Legend, { t }));
}

// The line chart of the net against the share of the rebuild extra counted, a picture the card names in words.
function LamChart({ geometry: g, t }) {
  return h('svg', { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, 'aria-hidden': 'true' },
    g.grid.map(tick => h(React.Fragment, { key: tick.label },
      h('line', { className: 'sw-cx-lax', x1: tick.x, y1: g.guide.top, x2: tick.x, y2: g.guide.bottom }),
      h(Label, { className: 'sw-cx-ll', x: tick.x, y: g.height - 16, anchor: tick.anchor }, tick.label))),
    h(Label, { className: 'sw-cx-ll', x: g.title.x, y: g.title.y, anchor: 'middle' }, t('monitor.context.cache.axis')),
    h('line', { className: 'sw-cx-zero', x1: g.zero.x1, y1: g.zero.y, x2: g.zero.x2, y2: g.zero.y }),
    h(Label, { className: 'sw-cx-ll', x: g.zero.labelX, y: g.zero.labelY }, '0'),
    g.segments.map(segment => h('polyline', { key: segment.tone, className: `sw-cx-net sw-cx-${segment.tone}`, points: segment.points })),
    g.crossing === null ? null : h(React.Fragment, null,
      h('line', { className: 'sw-cx-guide', x1: g.crossing.x, y1: g.crossing.y, x2: g.crossing.x, y2: g.guide.bottom }),
      h('path', { className: 'sw-cx-star', d: g.crossing.d })),
    g.ends.map(end => h(React.Fragment, { key: end.kind },
      h('circle', { className: end.kind === 'none' ? 'sw-cx-pt-m' : 'sw-cx-pt-f', cx: end.x, cy: end.y, r: end.r }),
      h(Label, { className: 'sw-cx-ll sw-cx-pri', x: end.label.x, y: end.label.y, anchor: end.label.anchor }, end.label.text))),
    g.cursor === null ? null : h(React.Fragment, null,
      h('line', { className: 'sw-cx-guide', x1: g.cursor.x, y1: g.guide.top, x2: g.cursor.x, y2: g.guide.bottom }),
      h('circle', { className: 'sw-cx-lamcursor', cx: g.cursor.x, cy: g.cursor.y, r: 3.5 })));
}

// One row of the list: the compaction's number, a bar of its rebuild against the greatest, the rebuild and its share, a dash for each figure a compaction without figures has none of.
function RowCells({ row }) {
  return row.known
    ? [
      h('span', { key: 'n' }, `#${row.ordinal}`),
      h('span', { key: 'bar', className: 'sw-cx-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${row.bar}%` } })),
      h('span', { key: 'rebuild' }, row.rebuild),
      h('span', { key: 'share', title: row.share.title }, row.share.text),
    ]
    : [h('span', { key: 'n' }, `#${row.ordinal}`), h('span', { key: 'bar' }), h('span', { key: 'rebuild' }, NOT_AVAILABLE), h('span', { key: 'share' }, NOT_AVAILABLE)];
}

// The folded list of the compactions by their rebuild extra: a button that jumps the chart's cursor to the compaction's call where there is a chart, else a plain row.
function RebuildList({ list, state, dispatch, t }) {
  return h('details', { className: 'sw-cx-rows', open: isFoldOpen(state, 'rows'), onToggle: event => dispatch({ type: 'fold', name: 'rows', open: event.currentTarget.open }) },
    h('summary', null, t('monitor.context.cache.rows')),
    h('div', { className: 'sw-cx-rl', role: 'list' },
      h('div', { className: 'sw-cx-rr sw-cx-rh', 'aria-hidden': 'true' }, h('span', null, t('monitor.context.cache.rows.ordinal')), h('span', null), h('span', null, t('monitor.context.cache.rows.rebuild')), h('span', null, t('monitor.context.cache.rows.share'))),
      list.map(row => h('div', { key: row.ordinal, role: 'listitem' }, row.jump === null
        ? h('div', { className: 'sw-cx-rr' }, h(RowCells, { row }))
        : h('button', { type: 'button', className: 'sw-cx-rr', 'aria-label': row.label, onClick: () => dispatch({ type: 'cursor', at: row.jump }) }, h(RowCells, { row }))))));
}

// The cost composition: the three parts of the settlement's cost over one total, as a stacked bar where the shares are known and as a list that is always there; a part or a share that is not known is a dash.
function CompositionSection({ composition, t }) {
  const { total, items } = composition;
  const bar = items.every(({ share }) => share !== null);
  return h('section', { className: 'sw-cx-comp', 'aria-label': t('monitor.context.comp') },
    h('div', { className: 'sw-cx-h' }, h('h3', null, t('monitor.context.comp'))),
    total === null ? null : h('p', { className: 'sw-cx-comp-total' }, t('monitor.context.comp.total', { value: total.text })),
    bar ? h('div', { className: 'sw-cx-stack', 'aria-hidden': 'true' }, items.map(({ key, share }) => h('i', { key, className: 'sw-cx-seg', 'data-key': key, style: { width: `${(Math.max(0, share) * PERCENT).toFixed(2)}%` } }))) : null,
    h('ul', { className: 'sw-cx-comp-list' }, items.map(({ key, text, percent }) => h('li', { key, className: 'sw-cx-comp-row', 'data-key': key },
      h('i', { className: 'sw-cx-swatch', 'data-key': key, 'aria-hidden': 'true' }),
      h('span', { className: 'sw-cx-comp-name' }, t(`monitor.context.comp.${key}`)),
      h('span', { className: 'sw-cx-comp-value' }, text ?? NOT_AVAILABLE),
      h('span', { className: 'sw-cx-comp-percent' }, percent ?? NOT_AVAILABLE)))));
}

// The folded trial of the rebuild extra: the line chart of the net against the share counted, a card with the slider, its readout and the break-even sentence. It varies the report's rebuild alone and moves nothing above it.
function TrialSection({ cache, state, dispatch, lamWidth, lamRef, t }) {
  const readout = shareReadoutOf(cache.sums, state.share, t);
  return h('details', { className: 'sw-cx-trial', open: isFoldOpen(state, 'trial'), onToggle: event => dispatch({ type: 'fold', name: 'trial', open: event.currentTarget.open }) },
    h('summary', null, t('monitor.context.trial')),
    h('div', { className: 'sw-cx-card' },
      h('div', { className: 'sw-cx-lamchart', role: 'img', 'aria-label': cache.chart.label, ref: lamRef }, h(LamChart, { geometry: lamGeometryOf(cache.sums, state.share, lamWidth), t })),
      h('div', { className: 'sw-cx-sl' },
        h('label', { htmlFor: SHARE_INPUT_ID }, t('monitor.context.cache.slider')),
        h('input', {
          id: SHARE_INPUT_ID, className: 'sw-cx-slider', type: 'range', min: 0, max: 1, step: 0.01, value: state.share, 'aria-valuetext': readout, onChange: event => dispatch({ type: 'share', value: Number(event.currentTarget.value) }),
        })),
      h('p', { className: 'sw-cx-rd' }, readout),
      cache.crossing === null ? null : h('p', { className: 'sw-cx-thr' }, cache.crossing)));
}

// The marks of one row of the graph, over the seals the graph draws: the original as a ring and each read as a dot, on the settlement axis; the seals as lines and the band of `#0` as a rectangle.
function TargetTrack({ graph: g, row }) {
  return h('svg', { className: 'sw-rc-track', width: g.width, height: TRACK_HEIGHT, viewBox: `0 0 ${g.width} ${TRACK_HEIGHT}`, 'aria-hidden': 'true' },
    h('rect', { className: 'sw-rc-zero', x: g.zero.x0, y: 0, width: Math.max(0, g.zero.x1 - g.zero.x0), height: TRACK_HEIGHT }),
    g.seals.map(seal => h('line', { key: seal.ordinal, className: 'sw-rc-seal', x1: seal.x, y1: 0, x2: seal.x, y2: TRACK_HEIGHT })),
    h('line', { className: 'sw-rc-rail', x1: g.plotLeft, y1: TRACK_HEIGHT / 2, x2: g.plotLeft + g.plotWidth, y2: TRACK_HEIGHT / 2 }),
    row.dots.map(dot => h('circle', { key: dot.at, className: 'sw-rc-dot', cx: dot.x, cy: TRACK_HEIGHT / 2, r: 3 })),
    row.ring === null ? null : h('circle', { className: 'sw-rc-ring', cx: row.ring.x, cy: TRACK_HEIGHT / 2, r: 4.5 }));
}

// The seals' lines and the labels of the zones over the rows, one picture the rows' own tracks line up with.
function TargetAxis({ graph: g, t }) {
  return h('svg', { className: 'sw-rc-axis', width: g.width, height: AXIS_HEIGHT, viewBox: `0 0 ${g.width} ${AXIS_HEIGHT}`, 'aria-hidden': 'true' },
    h('rect', { className: 'sw-rc-zero', x: g.zero.x0, y: 0, width: Math.max(0, g.zero.x1 - g.zero.x0), height: AXIS_HEIGHT }),
    g.seals.map(seal => h('line', { key: seal.ordinal, className: 'sw-rc-seal', x1: seal.x, y1: 0, x2: seal.x, y2: AXIS_HEIGHT })),
    g.zones.map(zone => h(Label, { key: zone.label, className: 'sw-rc-lbl', x: zone.x + 3, y: AXIS_HEIGHT - 5 }, zone.label)));
}

// The text of the chosen target: its excerpt first and the whole on request; the states of the read, and none for an event with no text.
function TargetText({ text, expanded, dispatch, t }) {
  if (text === null) return h(Notice, { state: 'recall-text-loading' }, t('monitor.recall.text.loading'));
  if (text.kind !== 'ready') return h(Notice, { state: 'recall-text-failed' }, text.kind === 'unavailable' ? t('monitor.detail.unavailable') : t('monitor.recall.text.failed', { message: text.message }));
  const excerpt = excerptOf(text.value.text, EXCERPT_CHARS);
  if (excerpt === null) return h('p', { className: 'sw-mon-note', 'data-sw-recall-text': 'none' }, t('monitor.recall.text.none'));
  const count = Array.from(excerpt.text).length + excerpt.hidden;
  return h(React.Fragment, null,
    h('pre', { className: 'sw-rc-text', 'data-sw-recall-text': expanded || excerpt.hidden === 0 ? 'whole' : 'excerpt' }, expanded || excerpt.hidden === 0 ? text.value.text : `${excerpt.text}…`),
    excerpt.hidden === 0 ? null : h('button', { type: 'button', className: 'sw-rc-more', 'aria-expanded': expanded, onClick: () => dispatch({ type: 'expand' }) }, t(expanded ? 'monitor.recall.text.collapse' : 'monitor.recall.text.expand', { count })));
}

// The panel of the chosen target: what it is, where its original stands, its text and the steps that read it, each a button to its call on the stock chart where the chart has one.
function TargetPanel({ selection, state, text, dispatch, t }) {
  return h('div', { className: 'sw-rc-panel', 'data-sw-target': selection.seq },
    h('h4', { className: 'sw-rc-title' }, selection.title),
    h('p', { className: 'sw-rc-landing' }, selection.landing),
    h(TargetText, { text, expanded: state.expanded, dispatch, t }),
    selection.reads.length === 0 ? null : h('ul', { className: 'sw-rc-reads', 'aria-label': t('monitor.recall.reads') }, selection.reads.map(read => h('li', { key: read.at },
      read.call === null
        ? h('span', { className: 'sw-rc-read' }, read.label)
        : h('button', { type: 'button', className: 'sw-rc-read', 'aria-label': t('monitor.recall.read.call', { at: read.at, call: read.call }), onClick: () => dispatch({ type: 'cursor', at: read.call }) }, read.label)))));
}

// The recall targets of the segment: one row for each original event on the settlement axis of the whole segment, the chosen one's panel under the list.
function TargetSection({ graph, state, text, dispatch, graphRef, t }) {
  const selection = selectionOf(graph, state.target, t);
  return h('section', { className: 'sw-rc', 'aria-label': t('monitor.recall.heading') },
    h('div', { className: 'sw-cx-h' },
      h('h3', null, t('monitor.recall.heading')),
      h('span', { className: 'sw-cx-tag' }, [t('monitor.recall.count', { count: graph.count }), ...(graph.repeated > 0 ? [t('monitor.recall.repeated', { count: graph.repeated })] : [])].join(PART_SEPARATOR))),
    graph.rows.length === 0 ? h('p', { className: 'sw-mon-note', 'data-sw-recall': 'none' }, t('monitor.recall.none')) : h('div', { className: 'sw-rc-chart', ref: graphRef },
      h(TargetAxis, { graph, t }),
      h('ul', { className: 'sw-rc-list', 'aria-label': t('monitor.recall.heading') }, graph.rows.map(row => h('li', { key: row.seq },
        h('button', {
          type: 'button', className: 'sw-rc-row', 'data-seq': row.seq, 'aria-pressed': state.target === row.seq, 'aria-label': row.label, onClick: () => dispatch({ type: 'target', seq: row.seq }),
        },
        h('span', { className: 'sw-rc-name' }, t('monitor.recall.title', { seq: row.seq, name: row.name }), h('small', null, t('monitor.recall.row.count', { count: row.count }))),
        h(TargetTrack, { graph, row }))))),
      h('p', { className: 'sw-rc-keys', 'aria-hidden': 'true' },
        h('i', { className: 'sw-rc-key sw-rc-ring-key' }), t('monitor.recall.legend.original'), h('i', { className: 'sw-rc-key sw-rc-dot-key' }), t('monitor.recall.legend.read'),
        h('i', { className: 'sw-rc-key sw-rc-seal-key' }), t('monitor.recall.legend.seal'), h('i', { className: 'sw-rc-key sw-rc-zero-key' }), t('monitor.recall.legend.zero'))),
    selection === null ? null : h(TargetPanel, { selection, state, text, dispatch, t }));
}

// The fold that says what the line is, shown where the chart draws one.
function Note({ state, dispatch, t }) {
  return h('details', { className: 'sw-cx-note', open: isFoldOpen(state, 'note'), onToggle: event => dispatch({ type: 'fold', name: 'note', open: event.currentTarget.open }) },
    h('summary', null, t('monitor.context.note')),
    h('div', { className: 'sw-cx-in' }, h('p', null, t('monitor.context.note.line'))));
}

/**
 * The context page over a `model` (`contextPageOf`) under the view state `state` of `reduceContext` and its `dispatch`: the readout, the count line, the chart or the notice for the series still being read, the cost composition, the list of the rebuild of each compaction, the recall targets, the folded trial of the rebuild extra, the note and the unit line pinned at the foot.
 * `width` is the stock chart's width, `lamWidth` the trial chart's and `graphWidth` the target graph's, and `chartRef`, `lamRef` and `graphRef` the refs of the elements that measure them; `text` is the read of the chosen target's text as a resource result, null while it is read. It is a function of its props: the page that holds the state, reads the series, the line and the text and measures the widths is `ContextReport`.
 */
export function ContextView({ model, state, dispatch, width, lamWidth, graphWidth, chartRef, lamRef, graphRef, notice, text = null, t }) {
  const { stock } = model;
  const shown = state.hover ?? state.cursor;
  const graph = targetGraphOf(model.view, stock === null ? null : stock.series, graphWidth, t);
  const rings = selectionOf(graph, state.target, t)?.reads.flatMap(({ call }) => (call === null ? [] : [call])) ?? [];
  return h('div', { className: 'sw-cx' },
    stock === null ? null : h(Readout, { lines: readoutOf(stock.series, stock.line, shown, t), t }),
    h('p', { className: 'sw-cx-ctx' }, [model.count, model.calls].filter(value => value !== null).join(PART_SEPARATOR)),
    model.loading ? h(Notice, { state: 'context-loading' }, t('monitor.detail.loading')) : null,
    stock === null ? null : h(StockBlock, { stock, geometry: stockGeometryOf(stock.series, stock.line, width, t, rings), state, shown, chartRef, dispatch, t }),
    notice,
    model.composition === null ? null : h(CompositionSection, { composition: model.composition, t }),
    model.cache.list === null ? null : h(RebuildList, { list: model.cache.list, state, dispatch, t }),
    graph === null ? null : h(TargetSection, { graph, state, text, dispatch, graphRef, t }),
    model.cache.chart === null ? null : h(TrialSection, { cache: model.cache, state, dispatch, lamWidth, lamRef, t }),
    stock === null || stock.line === null ? null : h(Note, { state, dispatch, t }),
    h('div', { className: 'sw-cx-pin' }, h('p', { className: 'sw-cx-unit' }, t('monitor.settlement.unit'))));
}

// The line of the session's history for the segment `epoch` settles, selected from the store's result as the number it is.
function useAmberLine(session, epoch) {
  const read = () => amberLineOf(session.result, epoch);
  return React.useSyncExternalStore(session.subscribe, read, read);
}

const NO_TARGET = Object.freeze({ selected: null, result: null });
const noSubscription = () => () => {};

// The reader of the chosen target's text for the cut the answer named, made again for another cut or monitor, so an answer of the one the page left reaches nobody. None where the answer names no cut or the page has no monitor.
function useTargetReader(monitor, cut) {
  const reader = React.useMemo(
    () => (monitor === undefined || !Number.isSafeInteger(cut?.segment) || !Number.isSafeInteger(cut?.through) ? null : monitor.settlementTarget({ segment: cut.segment, through: cut.through })),
    [monitor, cut?.segment, cut?.through],
  );
  const read = () => reader?.state ?? NO_TARGET;
  return { reader, read: React.useSyncExternalStore(reader?.subscribe ?? noSubscription, read, read) };
}

/**
 * The context page of a settlement, the tab of the settlement drawer: the calls of its segment read from `monitor`'s resource of `handoffId`, the line from `session`'s history, the view state in a reducer of its own and the widths a resize observer keeps as the drawer is dragged.
 * It subscribes to the session store for as long as it is mounted, which the drawer does for the selected page alone.
 */
export function ContextPage({ settlement, handoffId, monitor, session, t }) {
  const result = useSettlementResult(monitor, handoffId);
  const line = useAmberLine(session, settlement.epoch);
  return h(ContextReport, { model: contextPageOf(settlement, result, line, t), monitor, t });
}

/**
 * The page of a settlement model `model`, with the state of its own. `current` marks the current segment's snapshot, which says so where it cannot draw the stock chart; `monitor` hands the reader of a chosen target's text.
 * A target is read when it is chosen and not before: the reader asks the host once for the choice and drops the answer of any it was moved off.
 */
export function ContextReport({ model, current, monitor, t }) {
  const [state, dispatch] = React.useReducer(reduceContext, undefined, createContextState);
  const [chartRef, width] = useElementWidth();
  const [lamRef, lamWidth] = useElementWidth();
  const [graphRef, graphWidth] = useElementWidth();
  const { reader, read } = useTargetReader(monitor, model.view.response?.cut);
  const graph = targetGraphOf(model.view, model.stock === null ? null : model.stock.series, graphWidth, t);
  const chosen = selectionOf(graph, state.target, t) === null ? null : state.target;
  React.useEffect(() => { reader?.select(chosen); }, [reader, chosen]);
  const notice = h(React.Fragment, null,
    current && model.stock === null ? h(Notice, { state: 'current-stock-unavailable' }, t('monitor.settlement.current.stockUnavailable')) : null,
    h(RecallNotice, { evidence: model.view.evidence, partial: model.recallPartial, priced: model.priced, t }));
  return h(ContextView, { model, state, dispatch, width, lamWidth, graphWidth, chartRef, lamRef, graphRef, notice, text: read.selected === chosen ? read.result : null, t });
}
