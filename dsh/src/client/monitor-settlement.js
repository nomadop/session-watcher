// dsh/src/client/monitor-settlement.js — the settlement drawer's payback page: for an adjusted report its summary, share of pure recall steps, cumulative net curve, per-seal payback plots and folded appendix, otherwise its status and the share alone.
import React from 'react';
import { RecallNotice, useSettlementResult } from './monitor-handle.js';
import { PART_SEPARATOR } from './monitor-state.js';
import { Label, useElementWidth } from './monitor-chart.js';
import {
  settlementPageOf, sortRows, curveGeometryOf, createPaybackState, reducePayback, UNBOUNDED,
} from './monitor-settlement-model.js';

const h = React.createElement;

// The legend's marks, each the key of its legend text and of the mark it draws.
const KEYS = ['actual', 'needed', 'missing', 'surplus'];
const percent = value => `${value}%`;

// A mark's label next to it, where the model found it room.
const MarkLabel = ({ label }) => (label === null ? null : h(Label, { className: 'sw-pb-lbl sw-pb-halo sw-pb-strong', x: label.x, y: label.y, anchor: label.anchor }, label.text));

/**
 * The curve as one static picture over `geometry` (`curveGeometryOf`): its area above and below zero, the curve, its own axis, the lane of seals, the lowest and end marks and the steps under it. It is an image with the model's spoken text and holds nothing to press or point at.
 */
function CurveImage({ geometry: g, label }) {
  const clip = (id, { x, y, width, height }) => h('clipPath', { id }, h('rect', { x, y, width, height }));
  return h('svg', { viewBox: `0 0 ${g.width} ${g.height}`, width: g.width, height: g.height, role: 'img', 'aria-label': label },
    h('defs', null,
      h('pattern', { id: 'sw-pb-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, h('line', { className: 'sw-pb-hatch-line', x1: 0, y1: 0, x2: 0, y2: 5 })),
      clip('sw-pb-plot-clip', g.clips.plot),
      clip('sw-pb-above-clip', g.clips.above),
      clip('sw-pb-below-clip', g.clips.below)),
    g.ticks.map(tick => h(React.Fragment, { key: tick.value },
      tick.grid ? h('line', { className: 'sw-pb-grid', x1: g.gutter, x2: g.gutter + g.plotWidth, y1: tick.y, y2: tick.y }) : null,
      tick.clip ? h('line', { className: 'sw-pb-clipline', x1: g.gutter, x2: g.gutter + g.plotWidth, y1: tick.y, y2: tick.y }) : null,
      h(Label, { className: 'sw-pb-lbl', x: g.labelX, y: tick.y + 4, anchor: 'end' }, tick.label))),
    h('g', { clipPath: 'url(#sw-pb-plot-clip)' },
      h('path', { className: 'sw-pb-gain', clipPath: 'url(#sw-pb-above-clip)', d: g.area }),
      h('path', { className: 'sw-pb-loss', fill: 'url(#sw-pb-hatch)', clipPath: 'url(#sw-pb-below-clip)', d: g.area }),
      h('path', { className: 'sw-pb-curve', d: g.line })),
    h('line', { className: 'sw-pb-zero', x1: g.gutter, x2: g.gutter + g.plotWidth, y1: g.zeroY, y2: g.zeroY }),
    h(Label, { className: 'sw-pb-lbl', x: g.labelX, y: g.lane.labelY, anchor: 'end' }, g.lane.label),
    h('rect', { className: 'sw-pb-lane', x: g.gutter, y: g.lane.y, width: g.plotWidth, height: g.lane.height }),
    g.lane.seals.map((x, at) => h('line', { key: at, className: 'sw-pb-seal', x1: x, x2: x, y1: g.lane.y + 1, y2: g.lane.y + g.lane.height - 1 })),
    h('circle', { className: 'sw-pb-pt', cx: g.lowest.x, cy: g.lowest.y, r: 3 }),
    h(MarkLabel, { label: g.lowest.label }),
    g.end.above ? h('path', { className: 'sw-pb-pt', d: g.end.arrow }) : h('circle', { className: 'sw-pb-pt', cx: g.end.x, cy: g.end.y, r: 3 }),
    h(MarkLabel, { label: g.end.label }),
    h(Label, { className: 'sw-pb-lbl sw-pb-xlbl', x: g.steps.unitX, y: g.steps.y }, g.steps.unit),
    g.steps.ticks.map(tick => h(Label, { key: tick.label, className: 'sw-pb-lbl sw-pb-xlbl', x: tick.x, y: g.steps.y, anchor: 'middle' }, tick.label)));
}

// The caption of the curve with the button that clips or frees its axis where the axis may be clipped, the curve itself, which `chartRef` measures, and the note of where a clipped axis cuts it.
function Curve({ model, geometry, state, dispatch, chartRef, t }) {
  return h(React.Fragment, null,
    h('div', { className: 'sw-pb-cap' },
      h('span', { className: 'sw-pb-cap-k' }, t('monitor.payback.curve')),
      model.chart.clippable
        ? h('button', { type: 'button', className: 'sw-pb-axisbtn', 'aria-pressed': state.full, onClick: () => dispatch({ type: 'axis' }) }, t(state.full ? 'monitor.payback.axis.full' : 'monitor.payback.axis.clipped'))
        : null),
    h('div', { className: 'sw-pb-chart', ref: chartRef }, h(CurveImage, { geometry, label: model.chart.label })),
    geometry.clipNote === null ? null : h('p', { className: 'sw-pb-note' }, geometry.clipNote));
}

// A row's plot, which is for the eye: the numbers beside it say the same.
function Plot({ plot }) {
  return h('span', { className: 'sw-pb-plot', 'aria-hidden': 'true' },
    h('i', { className: 'sw-pb-line', style: { width: percent(plot.end) } }),
    plot.surplus === null ? null : h('i', { className: 'sw-pb-surplus', style: { left: percent(plot.surplus.left), width: percent(plot.surplus.width) } }),
    h('b', { className: 'sw-pb-end', style: { left: percent(plot.end) } }),
    plot.missing === null ? null : h('i', { className: 'sw-pb-missing', style: { left: percent(plot.missing.left), width: percent(plot.missing.width) } }),
    plot.beyond === null ? null : [
      h('i', { key: 'run', className: 'sw-pb-missing', style: { left: percent(plot.beyond.left), right: '7px' } }),
      h('b', { key: 'arrow', className: 'sw-pb-arrow' }),
      h('em', { key: 'number', className: 'sw-pb-over' }, plot.beyond.label),
    ],
    plot.diamond === null ? null : h('b', { className: 'sw-pb-dia', style: { left: percent(plot.diamond) } }),
    plot.unbounded ? h('em', { className: 'sw-pb-inf', style: { left: percent(plot.end) } }, UNBOUNDED) : null);
}

function Row({ row, t }) {
  const number = key => h('span', { className: 'sw-pb-num', 'data-muted': row.unknown ? '' : undefined }, h('small', null, t(`monitor.payback.col.${key}`)), row.cells[key]);
  return h('li', { className: 'sw-pb-li', 'data-unknown': row.unknown ? '' : undefined, 'aria-label': row.label },
    h('span', { className: 'sw-pb-id' }, `#${row.ordinal}`),
    h(Plot, { plot: row.plot }),
    number('actual'),
    number('needed'),
    number('gap'));
}

// The legend of the plot's marks, the sort buttons, the axis over the rows and the rows in the order the state asks for.
function Rows({ model, state, dispatch, t }) {
  const { mid, end } = model.axis;
  return h('div', { className: 'sw-pb-rows' },
    h('div', { className: 'sw-pb-keys', 'aria-hidden': 'true' }, KEYS.map(key => h('span', { key }, h('i', { className: 'sw-pb-key', 'data-key': key }), t(`monitor.payback.legend.${key}`)))),
    h('div', { className: 'sw-pb-sort' },
      h('span', null, t('monitor.payback.sort')),
      ['ordinal', 'gap'].map(sort => h('button', { key: sort, type: 'button', className: 'sw-pb-sortbtn', 'aria-pressed': state.sort === sort, onClick: () => dispatch({ type: 'sort', sort }) }, t(`monitor.payback.sort.${sort}`)))),
    h('div', { className: 'sw-pb-axis', role: 'presentation' },
      h('span', { className: 'sw-pb-idh' }, t('monitor.payback.col.ordinal')),
      h('span', { className: 'sw-pb-ax', 'aria-hidden': 'true' },
        h('span', { className: 'sw-pb-tick sw-pb-t0' }, '0'),
        h('span', { className: 'sw-pb-tick sw-pb-t1' }, mid),
        h('span', { className: 'sw-pb-tick sw-pb-t2' }, end)),
      h('span', { className: 'sw-pb-num' }, t('monitor.payback.col.actual')),
      h('span', { className: 'sw-pb-num' }, t('monitor.payback.col.needed')),
      h('span', { className: 'sw-pb-num', title: t('monitor.payback.col.gap.title') }, t('monitor.payback.col.gap'))),
    h('ul', { className: 'sw-pb-list', role: 'list', 'aria-label': t('monitor.payback.list', { epoch: model.epoch }) },
      sortRows(model.rows, state.sort).map(row => h(Row, { key: row.ordinal, row, t }))));
}

function Appendix({ appendix: { equations, head, rows }, t }) {
  return h('details', { className: 'sw-pb-table' },
    h('summary', null, t('monitor.payback.table')),
    h('table', { className: 'sw-pb-equations', 'aria-label': t('monitor.payback.table.formula') },
      h('tbody', null, equations.map(([left, sign, right]) => h('tr', { key: left },
        h('th', { scope: 'row' }, left), h('td', null, sign), h('td', null, right))))),
    h('div', { className: 'sw-pb-scroll', role: 'region', tabIndex: 0, 'aria-label': t('monitor.payback.table.label') },
      h('table', { className: 'sw-pb-tbl', 'aria-label': t('monitor.payback.table.seals') },
        h('thead', null, h('tr', null, head.map(text => h('th', { key: text, scope: 'col' }, text)))),
        h('tbody', null, rows.map(({ cells: [seal, ...figures], unknown }) => h('tr', { key: seal, 'data-unknown': unknown ? '' : undefined },
          h('th', { scope: 'row' }, seal), figures.map((text, at) => h('td', { key: at }, text))))))));
}

/**
 * The payback page over a `model` (`settlementPageOf`) under the view `state` of `reducePayback` and its `dispatch`, the chart `width` it draws at and the `chartRef` of the element that measures it, the unit line pinned at its foot.
 * A model that is not adjusted has no figures: the page is its status (`notice`) and the share of pure recall steps where the evidence gives one.
 * It is a function of its props: the page that holds the state and measures the width is `PaybackPage`.
 */
export function PaybackView({ model, state, dispatch, width, chartRef, notice, t }) {
  const share = model.evidence.state !== 'ready' ? null : h('p', { className: 'sw-pb-share' }, model.share === null
    ? t('monitor.payback.share.none')
    : t('monitor.payback.share', { percent: model.share.percent, pure: model.share.pure, judged: model.share.judged }));
  if (!model.adjusted) return h('div', { className: 'sw-pb' }, notice, share);
  const geometry = curveGeometryOf(model.curve, width, model.chart.clippable && !state.full, t, model.current);
  return h('div', { className: 'sw-pb' },
    h('p', { className: 'sw-pb-head' }, model.header.map((text, at) => h('span', { key: at }, at < model.header.length - 1 ? `${text}${PART_SEPARATOR.trimEnd()}` : text))),
    notice,
    share,
    h('div', { className: 'sw-pb-facts' }, model.facts.map((text, at) => h('p', { key: at }, text))),
    h(Curve, { model, geometry, state, dispatch, chartRef, t }),
    h(Rows, { model, state, dispatch, t }),
    h(Appendix, { appendix: model.appendix, t }),
    h('div', { className: 'sw-pb-pin' }, h('p', { className: 'sw-pb-unit' }, t('monitor.settlement.unit'))));
}

/**
 * The payback page reads the same answer as the context page from the closed segment's settlement resource and prices from it (`settlementViewOf`); the list's settlement stands only where the answer holds no pricing inputs, and only an adjusted report has figures.
 */
export function PaybackPage({ settlement, monitor, handoffId, t }) {
  const result = useSettlementResult(monitor, handoffId);
  return h(PaybackReport, { model: settlementPageOf(settlement, t, result), t });
}

export function PaybackReport({ model, t }) {
  const [state, dispatch] = React.useReducer(reducePayback, undefined, createPaybackState);
  const [chartRef, width] = useElementWidth();
  const notice = h(RecallNotice, { evidence: model.evidence, partial: model.recallPartial, priced: model.priced, pending: true, t });
  return h(PaybackView, { model, state, dispatch, width, chartRef, notice, t });
}
