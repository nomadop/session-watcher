// dsh/src/client/monitor-context.js — the context page of the settlement drawer: the input stock chart of the cleared segment's calls with its readout, cursor and the line it is measured against, and the cache-rebuild section with its net chart, slider and list. The model is `monitor-context-model.js`; the view state is its reducer's.
import React from 'react';
import { NOT_AVAILABLE, PART_SEPARATOR } from './monitor-state.js';
import { Label, useElementWidth } from './monitor-chart.js';
import { Notice, RecallNotice, useSettlementResult } from './monitor-handle.js';
import {
  amberLineOf, stockGeometryOf, lamGeometryOf, callAtX, cursorOf, cursorKeyAt, sealStepAt, readoutOf, shareReadoutOf, contextPageOf, createContextState, reduceContext, isFoldOpen,
} from './monitor-context-model.js';

const h = React.createElement;

const SHARE_INPUT_ID = 'sw-cx-share';

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

// A figure of the cache section as a small card: its name over its value, the tone of a net as a class beside the text's own sign and glyph.
const Figure = ({ name, value, tone }) => h('div', { className: 'sw-cx-kv' }, h('div', { className: 'sw-cx-t' }, name), h('div', { className: tone === undefined || tone === 'zero' ? 'sw-cx-v' : `sw-cx-v sw-cx-${tone}` }, value));

// The cache section: the cache rebuild's share of the cost and the net, then, where there is a rebuild to count, the card with the line chart (which `lamRef` measures), the slider with its readout and the break-even sentence, and the folded list.
function CacheSection({ cache, state, dispatch, lamWidth, lamRef, t }) {
  const readout = shareReadoutOf(cache.sums, state.share, t);
  return h('section', { className: 'sw-cx-cache', 'aria-label': t('monitor.context.cache') },
    h('div', { className: 'sw-cx-h' }, h('h3', null, t('monitor.context.cache'))),
    h('div', { className: 'sw-cx-sum' }, h(Figure, { name: t('monitor.context.cache.share'), value: cache.share }), h(Figure, { name: t('monitor.context.cache.net'), value: cache.net.text, tone: cache.net.tone })),
    cache.chart === null ? null : h('div', { className: 'sw-cx-card' },
      h('div', { className: 'sw-cx-lamchart', role: 'img', 'aria-label': cache.chart.label, ref: lamRef }, h(LamChart, { geometry: lamGeometryOf(cache.sums, state.share, lamWidth), t })),
      h('div', { className: 'sw-cx-sl' },
        h('label', { htmlFor: SHARE_INPUT_ID }, t('monitor.context.cache.slider')),
        h('input', {
          id: SHARE_INPUT_ID, className: 'sw-cx-slider', type: 'range', min: 0, max: 1, step: 0.01, value: state.share, 'aria-valuetext': readout, onChange: event => dispatch({ type: 'share', value: Number(event.currentTarget.value) }),
        })),
      h('p', { className: 'sw-cx-rd' }, readout),
      cache.crossing === null ? null : h('p', { className: 'sw-cx-thr' }, cache.crossing)),
    cache.list === null ? null : h(RebuildList, { list: cache.list, state, dispatch, t }));
}

// The fold that says what the line is, shown where the chart draws one.
function Note({ state, dispatch, t }) {
  return h('details', { className: 'sw-cx-note', open: isFoldOpen(state, 'note'), onToggle: event => dispatch({ type: 'fold', name: 'note', open: event.currentTarget.open }) },
    h('summary', null, t('monitor.context.note')),
    h('div', { className: 'sw-cx-in' }, h('p', null, t('monitor.context.note.line'))));
}

/**
 * The context page over a `model` (`contextPageOf`) under the view state `state` of `reduceContext` and its `dispatch`: the readout, the count line, the chart or the notice for the series still being read, the cache section, the note and the unit line pinned at the foot.
 * `width` is the stock chart's width and `lamWidth` the net chart's, and `chartRef` and `lamRef` the refs of the elements that measure them. It is a function of its props: the page that holds the state, reads the series and the line and measures the widths is `ContextPage`.
 */
export function ContextView({ model, state, dispatch, width, lamWidth, chartRef, lamRef, notice, t }) {
  const { stock } = model;
  const shown = state.hover ?? state.cursor;
  return h('div', { className: 'sw-cx' },
    stock === null ? null : h(Readout, { lines: readoutOf(stock.series, stock.line, shown, t), t }),
    h('p', { className: 'sw-cx-ctx' }, [model.count, model.calls].filter(text => text !== null).join(PART_SEPARATOR)),
    model.loading ? h(Notice, { state: 'context-loading' }, t('monitor.detail.loading')) : null,
    stock === null ? null : h(StockBlock, { stock, geometry: stockGeometryOf(stock.series, stock.line, width, t), state, shown, chartRef, dispatch, t }),
    notice,
    h(CacheSection, { cache: model.cache, state, dispatch, lamWidth, lamRef, t }),
    stock === null || stock.line === null ? null : h(Note, { state, dispatch, t }),
    h('div', { className: 'sw-cx-pin' }, h('p', { className: 'sw-cx-unit' }, t('monitor.settlement.unit'))));
}

// The line of the session's history for the segment `epoch` settles, selected from the store's result as the number it is.
function useAmberLine(session, epoch) {
  const read = () => amberLineOf(session.result, epoch);
  return React.useSyncExternalStore(session.subscribe, read, read);
}

/**
 * The context page of a settlement, the tab of the settlement drawer: the calls of its segment read from `monitor`'s resource of `handoffId`, the line from `session`'s history, the view state in a reducer of its own and the two widths a resize observer keeps as the drawer is dragged.
 * It subscribes to the session store for as long as it is mounted, which the drawer does for the selected page alone.
 */
export function ContextPage({ settlement, handoffId, monitor, session, t }) {
  const result = useSettlementResult(monitor, handoffId);
  const line = useAmberLine(session, settlement.epoch);
  return h(ContextReport, { model: contextPageOf(settlement, result, line, t), result, t });
}

export function ContextReport({ model, result, current, t }) {
  const [state, dispatch] = React.useReducer(reduceContext, undefined, createContextState);
  const [chartRef, width] = useElementWidth();
  const [lamRef, lamWidth] = useElementWidth();
  const notice = h(React.Fragment, null,
    current && model.stock === null ? h(Notice, { state: 'current-stock-unavailable' }, t('monitor.settlement.current.stockUnavailable')) : null,
    h(RecallNotice, { result, partial: model.recallPartial, t }));
  return h(ContextView, { model, state, dispatch, width, lamWidth, chartRef, lamRef, notice, t });
}
