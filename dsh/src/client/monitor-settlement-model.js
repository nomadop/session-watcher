// dsh/src/client/monitor-settlement-model.js — the payback page's texts, plot rows, appendix, cumulative net geometry and view state.
import { NOT_AVAILABLE } from './monitor-state.js';
import { compactCount } from './monitor-files-model.js';
import { settlementFigures, settlementMetaParts, signedText } from './monitor-model.js';
import { paybackCurveOf, settlementWithRecall } from '../../../public/lib/compactionEconomics.js';
import { formatTokenCount } from '../../../public/lib/format.js';

const PERCENT = 100;
/** The sign of the steps a compaction that never pays back would need. */
export const UNBOUNDED = '\u221e';
const ARROW = '\u2192';
const UP = '\u2191';

const roundTo = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const round1 = value => roundTo(value, 1);

// A figure on the curve's axes and marks: rounded to a whole number, signed, in compact counts.
const compactSigned = value => signedText(Math.round(value), compactCount);
const compactTokens = value => {
  const whole = Math.round(value);
  return whole < 0 ? `-${compactCount(-whole)}` : compactCount(whole);
};

// ── The page ─────────────────────────────────────────────────────────────────

// The curve may have its axis clipped when its top is above this many times its depth, and a clipped axis reaches this many times the depth.
const CLIP_DEPTH_RATIO = 4;
const CLIP_TOP_RATIO = 2.5;

const topOf = net => net.reduce((top, value) => Math.max(top, value), 0);

// The text of a run of steps below zero: its one step, its first and last step, or its first step and the segment's end.
function rangeText([from, to], steps, t, current) {
  if (!current && to === steps && from < to) return t('monitor.payback.rangeToEnd', { from });
  return from === to ? t('monitor.payback.rangeAt', { at: from }) : t('monitor.payback.range', { from, to });
}

function chartLabelOf({ steps, net, lowest, below }, recall, t, current) {
  const ranges = () => below.map(range => rangeText(range, steps, t, current)).join(t('monitor.payback.listSeparator'));
  return [
    t('monitor.payback.chart.lead'),
    ...(lowest.value < 0 ? [t('monitor.payback.chart.lowest', { value: compactSigned(lowest.value), step: lowest.at })] : []),
    ...(below.length > 0 ? [t('monitor.payback.chart.below', { ranges: ranges() })] : []),
    t(current ? 'monitor.payback.chart.snapshotEnd' : 'monitor.payback.chart.end', { value: compactSigned(net[steps]) }),
    t(recall === undefined ? 'monitor.payback.chart.tail' : 'monitor.payback.chart.recallTail'),
  ].join(t('monitor.payback.chart.separator'));
}

// The marks of a row's plot, each a share of the plot's width, the plot running from the seal to the segment's last step: the line of the steps taken to its end, the diamond at the steps needed with, between them, the steps beyond what was needed or the steps still missing, the line and the number that run off the plot where the steps needed are beyond it, and the sign of a compaction that never pays back.
function plotOf(row, steps) {
  const share = value => roundTo(Math.min(value, steps) / steps * PERCENT, 3);
  const end = share(row.follow);
  const plot = { end, diamond: null, surplus: null, missing: null, beyond: null, unbounded: false };
  const { needed } = row;
  if (needed === null) return plot;
  if (needed === Infinity) return { ...plot, unbounded: true };
  if (needed > steps) return { ...plot, beyond: { left: end, label: String(needed) } };
  const diamond = share(needed);
  if (needed < row.follow) return { ...plot, diamond, surplus: { left: diamond, width: roundTo(end - diamond, 3) } };
  return { ...plot, diamond, missing: needed > row.follow ? { left: end, width: roundTo(diamond - end, 3) } : null };
}

const neededText = row => (row.needed === null ? NOT_AVAILABLE : row.needed === Infinity ? UNBOUNDED : String(row.needed));
const gapText = row => (row.gap === null ? NOT_AVAILABLE : signedText(row.gap, String));

// The whole numbers a row with figures shows its cost as: the cost, its cache rebuild and the rest of it, the summary call, so that the two parts add up to the cost shown.
function shownCostOf(row) {
  const cost = Math.round(row.cost);
  const rebuild = Math.round(row.costRebuild);
  return { cost, summary: cost - rebuild, rebuild };
}

// The words a row is named by to a screen reader: the steps taken, the steps needed and, where there is one, the gap.
function labelOf(row, t) {
  const params = { ordinal: row.ordinal, actual: t('monitor.payback.steps', { count: row.follow }), needed: row.needed === null || row.needed === Infinity ? neededText(row) : t('monitor.payback.steps', { count: row.needed }) };
  return row.gap === null ? t('monitor.payback.row.labelNoGap', params) : t('monitor.payback.row.label', { ...params, gap: signedText(row.gap, String) });
}

function rowOf(row, steps, t) {
  return {
    ordinal: row.ordinal,
    unknown: row.saved === null,
    gap: row.gap,
    label: labelOf(row, t),
    cells: { actual: String(row.follow), needed: neededText(row), gap: gapText(row) },
    plot: plotOf(row, Math.max(1, steps)),
  };
}

const TABLE_COLUMNS = ['ordinal', 'sealAt', 'stock', 'cost', 'summary', 'rebuild', 'perStep', 'actual', 'needed', 'gap', 'net'];

// The context is the before/after reading; saved per step uses the corrected cut. Net is the curve's value at the seal step.
function tableRowOf(row, net, t) {
  const known = row.saved !== null;
  const { cost, summary, rebuild } = known ? shownCostOf(row) : {};
  const cut = known && row.cut !== null ? formatTokenCount(Math.max(0, row.cut)) : NOT_AVAILABLE;
  return {
    unknown: !known,
    cells: [
      `#${row.ordinal}`,
      String(row.sealAt),
      row.cut === null ? NOT_AVAILABLE : `${formatTokenCount(row.before)} ${ARROW} ${formatTokenCount(row.after)}`,
      known ? formatTokenCount(cost) : NOT_AVAILABLE,
      known ? formatTokenCount(summary) : NOT_AVAILABLE,
      known ? formatTokenCount(rebuild) : NOT_AVAILABLE,
      known && row.cut !== null && row.cut !== row.before - row.after ? t('monitor.payback.col.perStep.adjusted', { count: cut }) : cut,
      String(row.follow),
      neededText(row),
      gapText(row),
      known ? signedText(Math.round(net[row.sealAt]), formatTokenCount) : NOT_AVAILABLE,
    ],
  };
}

function formulaRowsOf(base, { saved, cost, recall }, t, format) {
  const { saved: shownSaved, cost: shownCost, net } = settlementFigures(saved, cost, format);
  const line = (key, count, terms, unrounded = []) => [
    t(`monitor.settlement.${key}`, { count }),
    unrounded.every(Number.isInteger) ? '=' : '≈',
    t(`monitor.payback.formula.${key}`, terms),
  ];
  const rows = [line('net', net, { saved: shownSaved, cost: shownCost })];
  if (recall === undefined) return rows;

  const { withdrawn, residence, cutCredit, requests, overlap } = recall;
  const cut = Math.round(cutCredit);
  rows.push(
    line('saved', shownSaved, {
      base: format(base.saved), withdrawn: format(withdrawn), residence: format(residence),
      cut: cut < 0 ? `(${signedText(cut, format)})` : format(Math.abs(cut)),
    }, [base.saved, withdrawn, residence, cutCredit]),
    line('cost', shownCost, {
      base: format(base.cost), requests: format(requests), overlap: format(overlap),
    }, [base.cost, requests, overlap]),
  );
  return rows;
}

/** Builds the historical payback page from the base settlement and its optional recall evidence. */
export function settlementPageOf(base, t, evidence) {
  const report = settlementWithRecall(base, evidence);
  return paybackModelOf(base, report, paybackCurveOf(report), t);
}

/** Formats the payback figures without repricing the settlement. */
export function paybackModelOf(base, settlement, curve, t, current = false) {
  const { steps, net, lowest, below, medianNeeded } = curve;
  const { recall } = settlement;
  const equations = formulaRowsOf(base, settlement, t, formatTokenCount);
  const formula = formulaRowsOf(base, settlement, t, compactTokens).map(([left, sign, right], at) => {
    const [wholeLeft, , wholeRight] = equations[at];
    return `${left} ${left === wholeLeft && right === wholeRight ? sign : '≈'} ${right}`;
  });
  return {
    epoch: settlement.epoch,
    curve,
    current,
    header: settlementMetaParts(settlement, t, compactTokens).map(({ text }) => text),
    recallPartial: recall?.partial,
    facts: [
      ...formula,
      ...(lowest.value < 0 ? [t('monitor.payback.lowest', { value: compactSigned(lowest.value), step: lowest.at })] : []),
      ...(below.length > 0 ? [t('monitor.payback.below', { ranges: below.map(range => rangeText(range, steps, t, current)).join(t('monitor.payback.listSeparator')) })] : []),
      ...(medianNeeded === null ? [] : [t('monitor.payback.median', { count: medianNeeded })]),
    ],
    chart: { label: chartLabelOf(curve, recall, t, current), clippable: lowest.value < 0 && topOf(net) > CLIP_DEPTH_RATIO * -lowest.value },
    axis: { mid: String(Math.round(steps / 2)), end: t('monitor.payback.steps', { count: steps }) },
    rows: settlement.rows.map(row => rowOf(row, steps, t)),
    appendix: {
      equations,
      head: TABLE_COLUMNS.map(column => t(`monitor.payback.col.${column}`)),
      rows: settlement.rows.map(row => tableRowOf(row, net, t)),
    },
  };
}

/** The rows in the order of `sort`: `ordinal` as they are, `gap` those with a gap first, the largest first and equal gaps by ordinal, then the rest in their own order. The rows given are not changed. */
export function sortRows(rows, sort) {
  if (sort !== 'gap') return [...rows];
  return [...rows.filter(row => row.gap !== null).sort((a, b) => b.gap - a.gap || a.ordinal - b.ordinal), ...rows.filter(row => row.gap === null)];
}

// ── The curve ────────────────────────────────────────────────────────────────

// The plot's size and margins, in pixels: the gutter that holds the axis labels is at least this wide and wider where a label needs it, a label being as wide as a character of this width times its characters.
const GUTTER_MIN = 34;
const RIGHT_MARGIN = 6;
const LABEL_GAP = 5;
const CHAR_PX = 6.2;
const LABEL_PAD = 4;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 8;
// The plot is this tall from this chart width on, and shorter below the last.
const PLOT_HEIGHTS = [[620, 200], [380, 170]];
const PLOT_HEIGHT_MIN = 150;
// The lane of seals under the plot, and the row of steps under the lane.
const LANE_GAP = 4;
const LANE_HEIGHT = 12;
const LANE_BELOW = 4;
const STEPS_ROW = 16;
const STEPS_BASELINE = 12;
// The steps along the plot: a tick keeps this far from the next, at the first of these steps that does, and the last step is added where it lies this far from the tick before it.
const STEP_SIZES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
const TICK_MIN_PX = 34;
const END_TICK_MIN_PX = 30;

const plotHeightOf = width => PLOT_HEIGHTS.find(([from]) => width >= from)?.[1] ?? PLOT_HEIGHT_MIN;
const textWidth = text => text.length * CHAR_PX + LABEL_PAD;
const point = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * The geometry of the cumulative net curve over a chart `width` wide, as plain numbers and texts: `{ width, height, gutter, labelX, plotWidth, plotHeight, zeroY, line, area, clips, ticks, lane, lowest, end, steps, clipNote }`.
 * The plot's vertical domain runs from the lowest net, or zero, to the highest, or, where `clipped`, to `CLIP_TOP_RATIO` times the depth. `ticks` are the axis' values (zero, the lowest net where it is below zero, the top) each `{ value, label, y, grid, clip }`; `lane` is the row of seals with their x positions; `lowest` and `end` are the marks of the lowest net and of the segment's end with their labels, `{ x, y, label }` and `{ x, y, above, arrow?, label }`, a label null where it would lie over one placed before it; `steps` the row of steps under the lane; `clipNote` the text that names the step the curve first goes over a clipped axis, null where the axis is not.
 * `curve` is `paybackCurveOf` of a settlement, `t` the translate.
 */
export function curveGeometryOf(curve, width, clipped, t, current = false) {
  const { steps, net, lowest: lowestNet, seals } = curve;
  const span = Math.max(1, steps);
  const low = Math.min(0, lowestNet.value);
  const high = topOf(net);
  const top = clipped ? CLIP_TOP_RATIO * -low : high === low ? low + 1 : high;
  const values = [...new Set([0, low, top])];
  const labels = values.map(compactSigned);
  const gutter = Math.max(GUTTER_MIN, Math.ceil(Math.max(...labels.map(label => label.length)) * CHAR_PX) + LABEL_GAP);
  const plotWidth = Math.max(0, width - gutter - RIGHT_MARGIN);
  const plotHeight = plotHeightOf(width);
  const y = value => PLOT_TOP + (top - value) / (top - low) * (plotHeight - PLOT_TOP - PLOT_BOTTOM);
  const x = step => gutter + step / span * plotWidth;
  const zeroY = round1(y(0));
  const line = net.map((value, step) => `${step === 0 ? 'M' : 'L'}${point(x(step), y(value))}`).join('');
  const laneY = plotHeight + LANE_GAP;
  const stepsY = laneY + LANE_HEIGHT + LANE_BELOW;
  const boxes = [];
  // A label as `{ text, x, y, anchor }`, kept inside the chart, or null where its box covers one placed before it.
  const label = (text, at, atY, anchor) => {
    const w = textWidth(text);
    let x0 = anchor === 'end' ? at - w : at;
    if (x0 < gutter) x0 = gutter;
    if (x0 + w > width) x0 = width - w;
    const box = { x0, x1: x0 + w, y0: atY - 10, y1: atY + 3 };
    if (boxes.some(other => !(box.x1 < other.x0 || box.x0 > other.x1 || box.y1 < other.y0 || box.y0 > other.y1))) return null;
    boxes.push(box);
    return { text, x: round1(anchor === 'end' ? x0 + w : x0), y: round1(atY), anchor };
  };
  const lowestX = x(lowestNet.at);
  const lowestY = y(lowestNet.value);
  const lowRight = lowestX > gutter + plotWidth * 0.5;
  const lowest = {
    x: round1(lowestX),
    y: round1(lowestY),
    label: label(t('monitor.payback.lowestLabel', { value: compactSigned(lowestNet.value) }), lowRight ? lowestX - 7 : lowestX + 7, Math.min(lowestY + 4, plotHeight), lowRight ? 'end' : 'start'),
  };
  const final = net[steps];
  const endText = t(current ? 'monitor.payback.snapshotEndLabel' : 'monitor.payback.endLabel', { value: compactSigned(final) });
  const endX = x(steps);
  const end = final <= top
    ? { x: round1(endX), y: round1(y(final)), above: false, label: label(endText, endX - 7, final >= net[Math.max(0, steps - 1)] ? Math.max(y(final) - 7, 11) : Math.min(y(final) + 14, plotHeight - 2), 'end') }
    : { x: round1(endX), y: null, above: true, arrow: `M${round1(endX - 4)},${PLOT_TOP + 5}h8l-4,-7z`, label: label(`${endText} ${UP}`, endX - 7, PLOT_TOP + 10, 'end') };
  const tickStep = STEP_SIZES.find(size => size / span * plotWidth >= TICK_MIN_PX) ?? STEP_SIZES.at(-1);
  const marks = [];
  for (let step = 0; step <= steps; step += tickStep) marks.push(step);
  if (steps % tickStep !== 0 && (steps - Math.floor(steps / tickStep) * tickStep) / span * plotWidth >= END_TICK_MIN_PX) marks.push(steps);
  const over = clipped ? net.findIndex(value => value > top) : -1;
  return {
    width,
    height: stepsY + STEPS_ROW,
    gutter,
    labelX: gutter - LABEL_GAP,
    plotWidth,
    plotHeight,
    zeroY,
    line,
    area: `${line}L${point(x(steps), y(0))}L${point(x(0), y(0))}Z`,
    clips: {
      plot: { x: gutter, y: 0, width: plotWidth, height: plotHeight },
      above: { x: 0, y: 0, width, height: zeroY },
      below: { x: 0, y: zeroY, width, height: round1(plotHeight - zeroY) },
    },
    ticks: values.map((value, at) => ({ value, label: labels[at], y: round1(y(value)), grid: value !== 0, clip: clipped && value === top })),
    lane: { y: laneY, height: LANE_HEIGHT, label: t('monitor.payback.seal'), labelY: laneY + 9, seals: seals.map(step => round1(x(step))) },
    lowest,
    end,
    steps: { unit: t('monitor.payback.stepUnit'), unitX: 0, y: stepsY + STEPS_BASELINE, ticks: marks.map(step => ({ x: round1(x(step)), label: String(step) })) },
    clipNote: over < 0 ? null : t('monitor.payback.clipNote', { top: compactSigned(top), step: over }),
  };
}

// ── The view state ───────────────────────────────────────────────────────────

/** A new page sorts by compaction ordinal and clips the curve's axis where it may be clipped. */
export const createPaybackState = () => ({ sort: 'ordinal', full: false });

export function reducePayback(state, action) {
  switch (action.type) {
    case 'sort': return { ...state, sort: action.sort };
    case 'axis': return { ...state, full: !state.full };
    default: return state;
  }
}
