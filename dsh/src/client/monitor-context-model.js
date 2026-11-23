// dsh/src/client/monitor-context-model.js — the display model of the settlement drawer's context page: the calls of the cleared segment as the input stock chart's series, the line the stock is measured against, the chart's geometry and texts, the trial's arithmetic, chart and list of the rebuild extra, and the page's view state.
import { formatTokenCount } from '../../../public/lib/format.js';
import { PART_SEPARATOR } from './monitor-state.js';
import { compactCount } from './monitor-files-model.js';
import { signedText } from './monitor-model.js';
import { compositionOf, percentText, settlementViewOf } from './monitor-recall-model.js';

const PERCENT = 100;
const round1 = value => Math.round(value * 10) / 10;
const compact = value => compactCount(Math.round(value));
const signedWhole = value => signedText(Math.round(value), formatTokenCount);
const signedCompact = value => signedText(Math.round(value), compactCount);

// ── The line ─────────────────────────────────────────────────────────────────

/**
 * The input stock the session's own measurement puts the amber line at for the segment the settlement of `epoch` cleared, a finite number, or null where there is none to draw: the history point of that segment that carries `amberStockL`, found wherever it stands in the history. The Engine counts its segments from zero and the settlement's epoch counts the boundaries before its payload, so the cleared segment is the one `epoch − 1`.
 * `result` is the session store's: only a live answer holds a history, and a point whose key is absent or holds null, a history that is absent and any other answer have no line.
 */
export function amberLineOf(result, epoch) {
  if (result?.kind !== 'live') return null;
  const history = result.snapshot.history ?? [];
  const point = history.find(each => each.segment === epoch - 1 && Object.hasOwn(each, 'amberStockL'));
  return Number.isFinite(point?.amberStockL) ? point.amberStockL : null;
}

// ── The series ───────────────────────────────────────────────────────────────

/**
 * The calls of a cleared segment as the chart's series, `{ count, calls, drawn, peak, seals }`, or null where the marks do not match the count of rows or no call has a stock to draw. The n-th `post` mark belongs to the n-th row by order, not by ordinal.
 * Each of `calls` is `{ at, seq, stock, post, ordinal, uncompressed }`: `at` its place in the supplied calls counted from one, including calls without stock; `ordinal` that of its mark, null for any other call; `uncompressed` its stock plus each nonnegative known cut starting at its mark, whether or not the compaction has financial figures, null where `stock` is. `drawn` are the calls with a stock, `peak` one of them with the highest stock, and `seals` the marks as `{ ordinal, at, land }`: where the mark stands and the call a jump lands on, the first drawn call from there on, the last where none follows.
 * `rows` are the rows of a settlement of `settlementsOf`, `calls` the `calls` of the host's `inner-monitor/settlement` answer; its count is the count of calls and not of the settlement's steps.
 */
export function seriesOf(rows, calls) {
  if (calls.filter(({ post }) => post).length !== rows.length) return null;
  let mark = 0;
  let uncut = 0;
  const list = calls.map(({ seq, stock, post }, index) => {
    const compaction = post ? rows[mark++] : null;
    if (compaction !== null && compaction.cut !== null) uncut += Math.max(0, compaction.cut);
    return { at: index + 1, seq, stock, post, ordinal: compaction?.ordinal ?? null, uncompressed: stock === null ? null : stock + uncut };
  });
  const drawn = list.filter(({ stock }) => stock !== null);
  if (drawn.length === 0) return null;
  const landing = at => (drawn.find(each => each.at >= at) ?? drawn.at(-1)).at;
  return {
    count: list.length,
    calls: list,
    drawn,
    peak: drawn.reduce((best, each) => (each.stock > best.stock ? each : best)),
    seals: list.filter(({ post }) => post).map(({ ordinal, at }) => ({ ordinal, at, land: landing(at) })),
  };
}

/**
 * Where the series crosses `line`, `{ uncompressed, actual }`: the first drawn call strictly above it on each curve, null where there is no such call or no line.
 */
export function crossingsOf(series, line) {
  const over = key => (line === null ? null : series.drawn.find(each => each[key] > line) ?? null);
  return { uncompressed: over('uncompressed'), actual: over('stock') };
}

// A round step counts as reaching a value it is at least this share of, so a value that is a round step but for floating-point error keeps that step.
const STEP_REACH = 0.9999999;

// The least round step, of a mantissa 1, 2 or 5, that reaches `value`; one for a value that is not positive.
function niceStep(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].map(mantissa => mantissa * 10 ** exponent).find(candidate => candidate >= value * STEP_REACH);
  return step ?? 10 ** (exponent + 1);
}

// The factor the highest value drawn is multiplied by to leave room above it, and the number of steps the scale is first divided into, from which its round step is taken.
const HEADROOM = 1.06;
const SCALE_DIVISIONS = 4;

/**
 * The vertical scale of the stock chart, `{ step, top, ticks }`: the rounded top leaves room above the actual peak.
 */
export function stockScaleOf(series) {
  const room = series.peak.stock * HEADROOM;
  const step = niceStep(room / SCALE_DIVISIONS);
  const top = Math.max(step, Math.ceil(room / step - 1e-9) * step);
  return { step, top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, at) => at * step) };
}

// ── The chart's geometry ─────────────────────────────────────────────────────

// The chart's margins and heights, in pixels: the plot is taller as the chart is wider, in three steps, and never narrower than `PLOT_WIDTH_MIN`.
const LEFT = 40;
const RIGHT = 10;
const TOP = 14;
const FOOT = 30;
const PLOT_WIDTH_MIN = 150;
const NARROW_BELOW = 340;
const WIDE_FROM = 600;
const PLOT_HEIGHTS = { narrow: 150, normal: 180, wide: 210 };
// A label's width is estimated from its characters: a wide one, as of the ideographs, takes the type's size, any other this much.
const WIDE_CHAR_PX = 11;
const CHAR_PX = 6.2;
const WIDE_FROM_CODE_POINT = 0x2e80;
const SEAL_TICK = 11;
const SEAL_HIT = { width: 7, height: 14 };
const X_AXIS = { tick: 3, label: 14, unit: 25 };
// The axis marks the calls at a round step, so that there are at most this many marks.
const X_TICK_TARGET = 7;
const MARK_RADIUS = 5;

const textWidth = text => [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= WIDE_FROM_CODE_POINT ? WIDE_CHAR_PX : CHAR_PX), 0);

/**
 * The geometry of the input stock chart over a chart `width` wide, as plain numbers and texts: `{ width, height, left, plotWidth, plotTop, plotHeight, foot, ticks, seals, line, actual, uncompressed, uncompressedCross, actualCross, xTicks, xUnit, xAxis, axisPath, hit, sealHit, sealTickTop, points, rings }`.
 * The calls lie evenly along the plot, a call without a stock having its place and no point; `ticks` are the vertical scale's `{ value, label, y }`; `seals` the `{ at, x, ordinal, land }` of the compactions. `line` is the threshold's `{ y, label }`, and each crossing is `{ at, x, y, label }`, with the `d` of its diamond for the uncompressed one. These annotations are null when absent or outside the scale. A label is `{ text, x, y, anchor }` and flips to the other side of its point where it would leave the plot. `points` are the drawn calls as `{ at, x, y, uncompressedY }`; the paths `actual` and `uncompressed` follow those coordinates, with the view clipping the dashed path at the plot bounds.
 * `series` is `seriesOf`'s, `line` the stock of the amber line or null, `t` the translate. `rings` marks the calls (by their place in the series) a chosen target's reads link to, `{ at, x, y }` for each that the chart has a point of.
 */
export function stockGeometryOf(series, line, width, t, ringAts = []) {
  const scale = stockScaleOf(series);
  const plotWidth = Math.max(PLOT_WIDTH_MIN, width - LEFT - RIGHT);
  const total = LEFT + plotWidth + RIGHT;
  const plotHeight = width < NARROW_BELOW ? PLOT_HEIGHTS.narrow : width >= WIDE_FROM ? PLOT_HEIGHTS.wide : PLOT_HEIGHTS.normal;
  const foot = TOP + plotHeight;
  const xOf = at => LEFT + (series.count > 1 ? (at - 1) / (series.count - 1) * plotWidth : plotWidth / 2);
  const yOf = value => TOP + plotHeight - value / scale.top * plotHeight;
  const inPlot = value => value >= 0 && value <= scale.top;
  const plotLine = line !== null && inPlot(line) ? line : null;
  const crossings = crossingsOf(series, plotLine);
  // A label as `{ text, x, y, anchor }` from the side `prefer` names, turned to the other where its estimated width would leave the chart or cross the plot's left edge.
  const label = (text, x, y, prefer) => {
    const reach = textWidth(text);
    let anchor = prefer;
    if (prefer === 'end' && x - reach < LEFT + 2) anchor = 'start';
    else if (prefer === 'start' && x + reach > total - 2) anchor = 'end';
    return { text, x: round1(x), y: round1(y), anchor };
  };
  const points = series.drawn.map(({ at, stock, uncompressed }) => ({
    at, x: round1(xOf(at)), y: round1(yOf(stock)), uncompressedY: yOf(uncompressed),
  }));
  const pathOf = key => `M${points.map(point => `${point.x.toFixed(1)},${round1(point[key]).toFixed(1)}`).join(' L')}`;
  const crossing = (call, kind) => {
    if (call === null || !inPlot(call[kind])) return null;
    const x = round1(xOf(call.at));
    const y = round1(yOf(call[kind]));
    if (kind === 'uncompressed') {
      const d = `M${x},${round1(y - MARK_RADIUS)} L${round1(x + MARK_RADIUS)},${y} L${x},${round1(y + MARK_RADIUS)} L${round1(x - MARK_RADIUS)},${y} Z`;
      return { at: call.at, x, y, d, label: label(t('monitor.context.mark.uncompressed', { n: call.at }), x + 8, y - 7, 'start') };
    }
    return { at: call.at, x, y, label: label(t('monitor.context.mark.actual', { n: call.at }), x - 6, y + 20, 'end') };
  };
  const step = Math.max(1, niceStep(series.count / X_TICK_TARGET));
  const xTicks = [];
  for (let at = step; at <= series.count; at += step) xTicks.push({ x: round1(xOf(at)), label: String(at) });
  return {
    width: total,
    height: foot + FOOT,
    left: LEFT,
    plotWidth,
    plotTop: TOP,
    plotHeight,
    ticks: scale.ticks.map(value => ({ value, label: value === 0 ? '0' : compact(value), y: round1(yOf(value)) })),
    seals: series.seals.map(({ at, ordinal, land }) => ({ at, x: round1(xOf(at)), ordinal, land })),
    line: plotLine === null ? null : { y: round1(yOf(plotLine)), label: { text: t('monitor.context.line', { value: compact(plotLine) }), x: LEFT + 4, y: round1(yOf(plotLine) + 13), anchor: 'start' } },
    actual: pathOf('y'),
    uncompressed: pathOf('uncompressedY'),
    uncompressedCross: crossing(crossings.uncompressed, 'uncompressed'),
    actualCross: crossing(crossings.actual, 'stock'),
    xTicks,
    xUnit: { x: LEFT + plotWidth, y: foot + X_AXIS.unit, text: t('monitor.context.unit.calls') },
    axisPath: `M${LEFT},${TOP} V${foot} H${LEFT + plotWidth}`,
    hit: { x: LEFT, y: TOP, width: plotWidth, height: plotHeight - SEAL_HIT.height },
    points,
    rings: points.filter(({ at }) => ringAts.includes(at)).map(({ at, x, y }) => ({ at, x, y })),
    foot,
    sealTickTop: foot - SEAL_TICK,
    sealHit: { ...SEAL_HIT, y: foot - SEAL_HIT.height },
    xAxis: { tickEnd: foot + X_AXIS.tick, labelY: foot + X_AXIS.label },
  };
}

// ── The cursor ───────────────────────────────────────────────────────────────

/** The drawn call nearest `at`, the earlier of two as near. */
export const nearestDrawn = (series, at) => series.drawn.reduce((best, each) => (Math.abs(each.at - at) < Math.abs(best.at - at) ? each : best)).at;

/** The drawn call at `x` along the chart, the plot's share of it mapped to a call and that to the nearest drawn. */
export function callAtX(geometry, series, x) {
  const share = series.count > 1 ? (x - geometry.left) / geometry.plotWidth * (series.count - 1) : 0;
  return nearestDrawn(series, Math.round(share) + 1);
}

/** The cursor line and points at call `at`, or null for no call; `uncompressedY` is null outside the plot. */
export function cursorOf(geometry, at) {
  const point = geometry.points.find(each => each.at === at);
  if (point === undefined) return null;
  const { x, y, uncompressedY } = point;
  return { x, y, uncompressedY: uncompressedY >= geometry.plotTop && uncompressedY <= geometry.foot ? round1(uncompressedY) : null };
}

/** The call the next compaction's seal (`direction` 1) or the previous one's (−1) lands on from `current`, null for no place yet, wrapping round at the ends. */
export function sealStepAt(series, current, direction) {
  const lands = series.seals.map(({ land }) => land);
  const from = current ?? (direction > 0 ? 0 : series.count + 1);
  const next = direction > 0 ? lands.find(land => land > from) : lands.findLast(land => land < from);
  return next ?? (direction > 0 ? lands[0] : lands.at(-1));
}

const KEY_STRIDE = 10;

/**
 * The call a key moves the cursor at `cursor` to, null for a key that is not the cursor's: the arrows go one drawn call, `KEY_STRIDE` with shift, and stop at the ends, Home and End go to either end and Page Down and Up to the next and the previous compaction from the call `shown`, the one the readout shows. With no cursor yet an arrow places it on the first drawn call.
 */
export function cursorKeyAt(series, cursor, key, shift, shown = cursor) {
  const { drawn } = series;
  if (key === 'Home') return drawn[0].at;
  if (key === 'End') return drawn.at(-1).at;
  if (key === 'PageDown') return sealStepAt(series, shown, 1);
  if (key === 'PageUp') return sealStepAt(series, shown, -1);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  if (cursor === null) return drawn[0].at;
  const stride = (shift ? KEY_STRIDE : 1) * (key === 'ArrowLeft' ? -1 : 1);
  return drawn[Math.max(0, Math.min(drawn.length - 1, drawn.findIndex(({ at }) => at === cursor) + stride))].at;
}

/**
 * The readout for a drawn call `at`, or null for no call: its position, seq and any compaction mark, then both stocks and the deepening threshold if present.
 */
export function readoutOf(series, line, at, t) {
  if (at === null) return null;
  const call = series.calls[at - 1];
  const where = [t('monitor.context.read.call', { at, total: series.count }), t('monitor.overview.seq', { seq: call.seq }), ...(call.post ? [t('monitor.context.read.seal', { ordinal: call.ordinal })] : [])];
  const stock = [
    t('monitor.context.read.actual', { value: formatTokenCount(call.stock) }),
    t('monitor.context.read.uncompressed', { value: formatTokenCount(call.uncompressed) }),
    ...(line === null ? [] : [t('monitor.context.line', { value: formatTokenCount(line) })]),
  ];
  return [where.join(PART_SEPARATOR), stock.join(PART_SEPARATOR)];
}

// ── The cache section ────────────────────────────────────────────────────────

/**
 * The cache comparison uses the report's net when `totals` is supplied, otherwise the rows' savings less their costs. It varies only the rebuild portion of that cost and ranks the compactions by their rebuild.
 */
export function cacheOf(rows, totals) {
  const known = rows.filter(({ saved, cost }) => saved !== null && cost !== null);
  const sum = key => known.reduce((total, each) => total + each[key], 0);
  const cost = totals?.cost ?? sum('cost');
  const rebuild = sum('costRebuild');
  const saved = totals?.saved ?? sum('saved');
  const net = saved - cost;
  const ranked = [...known].sort((a, b) => b.costRebuild - a.costRebuild);
  return {
    rebuild,
    net0: net + rebuild,
    net1: net,
    rows: [
      ...ranked.map(each => ({ ordinal: each.ordinal, known: true, rebuild: each.costRebuild, share: each.costRebuild / rebuild })),
      ...rows.filter(each => !known.includes(each)).map(each => ({ ordinal: each.ordinal, known: false, rebuild: null, share: null })),
    ],
    max: Math.max(...ranked.map(each => each.costRebuild)),
  };
}

/** The net with `share`, from 0 to 1, of the rebuild extra counted: the net with none of it less that share of the rebuild. */
export const netAt = (cache, share) => cache.net0 - share * cache.rebuild;

/** The share of the rebuild extra under which the net turns positive, from the net with none of it to the net with all of it, null unless the net is positive with none and negative with all. */
export const crossingShareOf = cache => (cache.rebuild > 0 && cache.net0 > 0 && cache.net1 < 0 ? cache.net0 / cache.rebuild : null);

/** The slider's readout and spoken value: the share of the rebuild extra counted, in words at the two ends, and the net at it. */
export function shareReadoutOf(cache, share, t) {
  const lead = share >= 1 ? t('monitor.context.cache.read.actual') : share <= 0 ? t('monitor.context.cache.read.none') : t('monitor.context.cache.read.at', { percent: Math.round(share * PERCENT) });
  return t('monitor.context.cache.read', { lead, net: signedWhole(netAt(cache, share)) });
}

const LAM = { height: 156, left: 10, right: 10, top: 14, foot: 34, plotMin: 60, headroom: 0.2, gridShares: [0, 0.25, 0.5, 0.75, 1], cursorFrom: 0.004, cursorTo: 0.996 };

/**
 * The geometry of the line chart of the net against the share of the rebuild extra counted, over a chart `width` wide, as plain numbers: `{ width, height, grid, title, zero, segments, crossing, ends, cursor, guide }`.
 * The net runs in a straight line from `net0` at none of the extra to `net1` at all of it, in two segments of a tone, `pos` above zero and `neg` below, where it crosses zero; `crossing` marks that point, `ends` the two ends with their labels, `cursor` the slider's place, null at either end where the end's own mark shows it, and `guide` the vertical extent of the guides drawn at the crossing and the cursor. `cache` is `cacheOf`'s of a settlement whose rebuild is not zero, so its two nets differ.
 */
export function lamGeometryOf(cache, share, width) {
  const { height, left, right, top, foot } = LAM;
  const plotWidth = Math.max(LAM.plotMin, width - left - right);
  const plotHeight = height - top - foot;
  let low = Math.min(0, cache.net0, cache.net1);
  let high = Math.max(0, cache.net0, cache.net1);
  const span = high - low;
  if (high > 0) high += LAM.headroom * span;
  if (low < 0) low -= LAM.headroom * span;
  const xOf = at => left + at * plotWidth;
  const yOf = value => top + (high - value) / (high - low) * plotHeight;
  const zeroY = yOf(0);
  const crossShare = crossingShareOf(cache);
  const pointOf = at => `${xOf(at).toFixed(1)},${yOf(netAt(cache, at)).toFixed(1)}`;
  const segment = (from, to, tone) => ({ tone, points: `${pointOf(from)} ${pointOf(to)}` });
  const end = (kind, at, anchor, radius) => {
    const value = netAt(cache, at);
    return { kind, x: round1(xOf(at)), y: round1(yOf(value)), r: radius, label: { text: signedCompact(value), x: round1(xOf(at)), y: round1(value < 0 ? yOf(value) + 16 : yOf(value) - 8), anchor } };
  };
  const x = round1(xOf(crossShare ?? 0));
  const y0 = round1(zeroY);
  return {
    width: left + plotWidth + right,
    height,
    grid: LAM.gridShares.map(at => ({ x: round1(xOf(at)), label: `${Math.round(at * PERCENT)}%`, anchor: at === 0 ? 'start' : at === 1 ? 'end' : 'middle' })),
    title: { x: round1(left + plotWidth / 2), y: height - 2 },
    zero: { x1: left, x2: left + plotWidth, y: y0, labelX: left + 2, labelY: round1(zeroY + (cache.net0 >= 0 && cache.net1 >= 0 ? -3 : 11)) },
    segments: crossShare === null ? [segment(0, 1, (cache.net0 + cache.net1) / 2 < 0 ? 'neg' : 'pos')] : [segment(0, crossShare, 'pos'), segment(crossShare, 1, 'neg')],
    crossing: crossShare === null ? null : { x, y: y0, d: `M${x} ${round1(y0 - 5)}l5 5l-5 5l-5-5z` },
    ends: [end('none', 0, 'start', 4), end('all', 1, 'end', 4.5)],
    cursor: share > LAM.cursorFrom && share < LAM.cursorTo ? { x: round1(xOf(share)), y: round1(yOf(netAt(cache, share))) } : null,
    guide: { top, bottom: top + plotHeight },
  };
}

// ── The page ─────────────────────────────────────────────────────────────────

// The facts line over the chart: the actual peak and, with a line, the line and where the uncompressed stock crosses it.
function factsOf(series, line, crossings, t) {
  return [
    t('monitor.context.facts.peak', { value: compact(series.peak.stock) }),
    ...(line === null ? [] : [t('monitor.context.line', { value: compact(line) })]),
    ...(crossings.uncompressed === null ? [] : [t('monitor.context.facts.crossed', { n: crossings.uncompressed.at })]),
  ].join(PART_SEPARATOR);
}

// The chart's spoken text, in the pieces the locale words one by one.
function chartLabelOf(series, line, crossings, t) {
  return [
    t('monitor.context.chart.lead', { peak: compact(series.peak.stock) }),
    ...(line === null ? [] : [t('monitor.context.chart.line', { value: compact(line) })]),
    ...(crossings.uncompressed === null ? [] : [t('monitor.context.chart.crossUncompressed', { n: crossings.uncompressed.at })]),
    ...(crossings.actual === null ? [] : [t('monitor.context.chart.crossActual', { n: crossings.actual.at })]),
    t('monitor.context.chart.keys'),
  ].join('');
}

// The trial's and the list's texts: the break-even sentence, the chart's spoken text and the list of the compactions, each row naming the call it jumps to where there is a series.
function cacheTextsOf(sums, series, t) {
  const crossShare = crossingShareOf(sums);
  const crossing = crossShare === null ? null : t('monitor.context.cache.crossing', { percent: percentText(crossShare) });
  const sealOf = ordinal => series?.seals.find(seal => seal.ordinal === ordinal);
  return {
    sums,
    crossing,
    chart: sums.rebuild > 0
      ? { label: t(crossing === null ? 'monitor.context.cache.chart' : 'monitor.context.cache.chart.crossing', { none: signedCompact(sums.net0), actual: signedCompact(sums.net1), sentence: crossing }) }
      : null,
    list: sums.rebuild > 0
      ? sums.rows.map(({ ordinal, known, rebuild, share }) => {
        const jump = sealOf(ordinal)?.land ?? null;
        const text = known ? { rebuild: formatTokenCount(rebuild), share: { text: percentText(share), title: percentText(share) } } : { rebuild: null, share: null };
        const params = { ordinal, at: jump, ...(known ? { rebuild: text.rebuild, share: text.share.text } : {}) };
        return {
          ordinal,
          known,
          bar: known ? (rebuild / sums.max * PERCENT).toFixed(2) : null,
          ...text,
          jump,
          label: jump === null ? null : t(known ? 'monitor.context.cache.row.label' : 'monitor.context.cache.row.labelNone', params),
        };
      })
      : null,
  };
}

/**
 * The settlement's context page over the closed segment's list settlement `settlement` (none for the current segment) and the answer `result` of its settlement read, `line` the amber line of `amberLineOf`. See `contextModelOf`.
 */
export function contextPageOf(settlement, result, line, t) {
  return contextModelOf(settlementViewOf(settlement, result), line, t);
}

/**
 * The context page of a settlement `view` (`settlementViewOf`): the original stock series of the answer's calls, the cost composition of the report (the recall evidence of an adjusted report in it and the same report as the payback page reads) and the trial of the rebuild extra, which varies that report's rebuild alone and changes no figure above it. A failed or older answer draws no stock series and leaves the composition without a total; a view with no priced compaction has no composition, not a composition of nothing. `view` itself is kept for the target graph, which draws on the page's width.
 */
export function contextModelOf(view, line, t) {
  const { base, report, evidence, response } = view;
  const series = Array.isArray(response?.calls) ? seriesOf(base.rows, response.calls) : null;
  const crossings = series === null ? null : crossingsOf(series, line);
  return {
    count: t('monitor.settlement.count', { count: base.count }),
    calls: series === null ? null : t('monitor.context.calls', { count: series.count }),
    loading: evidence.state === 'pending',
    stock: series === null ? null : { series, line, facts: factsOf(series, line, crossings, t), label: chartLabelOf(series, line, crossings, t) },
    composition: view.priced ? compositionOf(report, view.adjusted) : null,
    cache: cacheTextsOf(cacheOf(base.rows, report === base ? undefined : report), series, t),
    recallPartial: report.recall?.partial,
    priced: view.priced,
    view,
  };
}

// ── The view state ───────────────────────────────────────────────────────────

/** A new page: no cursor, no hover, no target chosen, all of the rebuild extra counted and every fold shut. `cursor` and `hover` are the numbers of calls, `target` the seq of the chosen target and `expanded` whether its whole text is shown. */
export const createContextState = () => ({
  cursor: null, hover: null, target: null, expanded: false, share: 1, folds: { rows: false, trial: false, note: false },
});

/** Whether the fold `name` (`rows`, `trial` or `note`) shows open. */
export const isFoldOpen = (state, name) => state.folds[name];

/**
 * The state after `action`, never changed in place; an action of an unknown type answers the state it was given.
 * `{ type: 'hover', at }` and `{ type: 'leave' }` set and clear the call under the pointer, `{ type: 'cursor', at }` places the cursor on a call and clears the hover, `{ type: 'target', seq }` chooses a target or, chosen again, leaves it and shuts its text, `{ type: 'expand' }` opens or shuts the whole text, `{ type: 'share', value }` sets the share of the rebuild extra counted, and `{ type: 'fold', name, open }` records a fold as it was opened or shut.
 */
export function reduceContext(state, action) {
  switch (action.type) {
    case 'hover': return action.at === state.hover ? state : { ...state, hover: action.at };
    case 'leave': return state.hover === null ? state : { ...state, hover: null };
    case 'cursor': return { ...state, cursor: action.at, hover: null };
    case 'target': return { ...state, target: action.seq === state.target ? null : action.seq, expanded: false };
    case 'expand': return { ...state, expanded: !state.expanded };
    case 'share': return { ...state, share: action.value };
    case 'fold': return { ...state, folds: { ...state.folds, [action.name]: action.open } };
    default: return state;
  }
}
