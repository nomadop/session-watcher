// dsh/src/client/monitor-recall-model.js — what the settlement drawer shows of recall, from the one answer both drawers read: the evidence an answer gives, the report priced from it, the cost composition, the pure recall share and the target graph on the settlement axis.
import { paybackCurveOf, settlementForSegment, settlementWithRecall } from '../../../public/lib/compactionEconomics.js';
import { formatTokenCount } from '../../../public/lib/format.js';

const PERCENT = 100;
export const percentText = ratio => `${(Math.round(ratio * PERCENT * 10) / 10).toFixed(1)}%`;

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isRead = value => value !== null && typeof value === 'object' && isCount(value.at) && isCount(value.seq);
const isTarget = value => value !== null && typeof value === 'object' && isCount(value.seq) && typeof value.type === 'string'
  && (value.at === null || isCount(value.at)) && Array.isArray(value.reads) && value.reads.every(isRead);
const isActivity = value => value !== null && typeof value === 'object' && typeof value.covered === 'boolean' && isCount(value.judged) && isCount(value.pure)
  && Array.isArray(value.targets) && value.targets.every(isTarget);

/**
 * What a settlement answer is evidence of, `{ state, activity?, recall? }`: `pending` while no answer came, `unavailable` for an answer that failed, `old` for one with no recall activity, which only a host older than this client sends and which adjusts nothing, and `ready` for one that has it; its `recall` is the report evidence, absent where the segment holds no recall to adjust by.
 * `result` is a resource's or the one-shot read's result.
 */
export function evidenceOf(result) {
  if (result === null || result === undefined) return { state: 'pending' };
  if (result.kind !== 'ready') return { state: 'unavailable' };
  const { activity, recall } = result.value ?? {};
  return isActivity(activity) ? { state: 'ready', activity, recall } : { state: 'old' };
}

const hasFigures = settlement => settlement.rows.some(row => row.saved !== null);
const isPricing = response => Array.isArray(response?.attempts) && Number.isSafeInteger(response.epoch) && response.epoch >= 1 && isCount(response.tailCalls);

/**
 * The settlement a drawer shows, `{ base, evidence, report, priced, adjusted, curve, response }`. `base` is priced from the answer's own attempts at its cut, so the two drawers price alike, and only from `listed`, the list's settlement, where the answer holds no pricing inputs (a closed segment's drawer has it before its answer comes; the current drawer has none): figures of another cut are never shown beside the answer's evidence, and an answer that prices nothing prices nothing. `priced` is whether any compaction of `base` has figures.
 * `adjusted` is whether `report` is `base` adjusted by the recall evidence of a ready answer, which needs figures to adjust; otherwise `report` is `base` itself, null where there is no `base`. `curve` is the adjusted report's cumulative net and null where it is not adjusted, so no page can draw an unadjusted curve; `response` is the answer whole where one came, an older host's included.
 */
export function settlementViewOf(listed, result) {
  const evidence = evidenceOf(result);
  const response = result?.kind === 'ready' ? result.value : undefined;
  const base = isPricing(response) ? settlementForSegment(response.attempts, { epoch: response.epoch, tailCalls: response.tailCalls }) : listed ?? null;
  const priced = base !== null && hasFigures(base);
  const adjusted = priced && evidence.state === 'ready';
  const report = adjusted ? settlementWithRecall(base, evidence.recall) : base;
  return {
    base, evidence, report, priced, adjusted, curve: adjusted ? paybackCurveOf(report) : null, response: response ?? null,
  };
}

/**
 * The cost composition of a report, `{ total, items }`: the summary calls and the cache rebuilds of the priced compactions, and what the pure recall requests cost beyond the rebuild already counted; each item is `{ key, value, text, share, percent }`, `value` the unrounded figure, `text` the whole number shown and `share` and `percent` its share of the report's cost, null where that cost is no trusted total.
 * Without evidence the recall item and the total are none and no share is given: the compactions' own cost is not the report's. The shown total is the rounded cost and the summary is what is left of it after the other two, so the whole numbers add up.
 * A report that is partial lacks adjustment evidence, so its cost is a subtotal and no total to give shares of: the figures stand, the shares do not.
 * `adjusted` is whether the report is adjusted by evidence of recall (`settlementViewOf`'s).
 */
export function compositionOf(report, adjusted) {
  const known = report.rows.filter(row => row.saved !== null);
  const rebuild = known.reduce((sum, row) => sum + row.costRebuild, 0);
  const summary = known.reduce((sum, row) => sum + row.cost - row.costRebuild, 0);
  const recall = adjusted ? (report.recall?.requests ?? 0) - (report.recall?.overlap ?? 0) : null;
  const total = adjusted ? report.cost : null;
  const trusted = adjusted && Number.isFinite(total) && total > 0 && !report.recall?.partial;
  const shown = { rebuild: Math.round(rebuild), recall: recall === null ? null : Math.round(recall) };
  shown.summary = total === null ? Math.round(summary) : Math.round(total) - shown.rebuild - shown.recall;
  const item = (key, value) => ({
    key,
    value,
    text: value === null ? null : formatTokenCount(shown[key]),
    share: value === null || !trusted ? null : value / total,
    percent: value === null || !trusted ? null : percentText(value / total),
  });
  return {
    total: total === null ? null : { value: total, text: formatTokenCount(Math.round(total)) },
    items: [item('summary', summary), item('rebuild', rebuild), item('recall', recall)],
  };
}

/**
 * The share of pure recall steps among the judged steps after the first seal, `{ pure, judged, percent }`, null unless the evidence is ready, proves the axis covered and judges at least one step: it is then 0% only for a segment confirmed to hold no pure step.
 */
export function shareOf(evidence) {
  if (evidence.state !== 'ready') return null;
  const { covered, judged, pure } = evidence.activity;
  return covered && judged > 0 ? { pure, judged, percent: percentText(pure / judged) } : null;
}

// ── The target graph ─────────────────────────────────────────────────────────

// The graph's margin and least plot width, in pixels, and the width of a zone label as estimated from its characters.
const PAD = 12;
const PLOT_WIDTH_MIN = 150;
const CHAR_PX = 6.2;
const LABEL_PAD = 6;
const round1 = value => Math.round(value * 10) / 10;

const NAME_KEYS = {
  'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'toolResult', 'tool/call': 'toolCall', 'system/message': 'system', 'developer/message': 'developer',
};
// The name of an event type; a type with no name is its own.
const nameOf = (type, t) => (Object.hasOwn(NAME_KEYS, type) ? t(`monitor.recall.name.${NAME_KEYS[type]}`) : type);

/** The `at` of the call of `series` that is the request `read` names and has a stock to draw, null where the chart has none: a read links to its own call, never to the nearest. */
export function linkOf(read, series) {
  return series?.calls.find(call => call.seq === read.seq && call.stock !== null)?.at ?? null;
}

/**
 * The graph of the targets on the settlement axis, or null without ready evidence or a compaction to take the axis from. The axis is the report's steps and its lines the seals of every compaction row, so the number of seals is the segment's; `#0` is the band before the first.
 * `{ count, repeated, width, plotLeft, plotWidth, seals, zero, zones, rows }`: `seals` are `{ ordinal, at, x }`, `zero` the band `{ x0, x1, label }`, `zones` the labels `{ label, x }` that the seals leave room for, and each row `{ seq, type, name, count, ring, dots, label }` with `ring` the mark of the original `{ at, x, zero }`, null where the answer gives no landing, and `dots` the reads `{ at, seq, x, call }`, `call` the `linkOf` of the read. `repeated` counts the targets read in the steps of more than one zone.
 * `view` is `settlementViewOf`'s, `series` `seriesOf`'s or null, `t` the translate.
 */
export function targetGraphOf({ evidence, report }, series, width, t) {
  if (evidence.state !== 'ready' || report === null || report.rows.length === 0) return null;
  const plotWidth = Math.max(PLOT_WIDTH_MIN, width - 2 * PAD);
  const span = Math.max(1, report.steps);
  const stepX = step => round1(PAD + Math.max(step - 0.5, 0) / span * plotWidth);
  const lineX = step => round1(PAD + Math.min(step, span) / span * plotWidth);
  const seals = report.rows.map(row => ({ ordinal: row.ordinal, at: row.sealAt, x: lineX(row.sealAt) })).sort((a, b) => a.at - b.at);
  const firstEnd = seals[0]?.at ?? 0;
  const zoneOf = at => seals.filter(seal => seal.at < at).length;
  const zones = [];
  for (const zone of [{ label: '#0', x: PAD }, ...seals.map(seal => ({ label: `#${seal.ordinal}`, x: seal.x }))]) {
    const last = zones.at(-1);
    if (last === undefined || zone.x - last.x >= last.label.length * CHAR_PX + LABEL_PAD) zones.push(zone);
  }
  const rows = evidence.activity.targets.map((target) => {
    const name = nameOf(target.type, t);
    return {
      seq: target.seq,
      type: target.type,
      name,
      count: target.reads.length,
      ring: target.at === null ? null : { at: target.at, x: stepX(target.at), zero: target.at <= firstEnd },
      dots: target.reads.map(read => ({ at: read.at, seq: read.seq, x: stepX(read.at), call: linkOf(read, series) })),
      label: t('monitor.recall.row.label', { seq: target.seq, name, count: target.reads.length }),
    };
  });
  const repeated = evidence.activity.targets.filter(target => new Set(target.reads.map(read => zoneOf(read.at))).size > 1).length;
  return {
    count: rows.length, repeated, width: plotWidth + 2 * PAD, plotLeft: PAD, plotWidth, seals,
    zero: { x0: PAD, x1: lineX(firstEnd), label: '#0' }, zones, rows,
  };
}

/**
 * What the panel of a chosen target says, `{ seq, title, landing, reads }`, or null for a seq that is no row of the graph: where the original stands (the step, and the zone it lies in) or that no evidence says, and the steps that read it, each with the `call` of the stock chart it links to.
 */
export function selectionOf(graph, seq, t) {
  const row = graph?.rows.find(each => each.seq === seq);
  if (row === undefined) return null;
  let landing = t('monitor.recall.landing.unknown');
  if (row.ring !== null) {
    const { at } = row.ring;
    const zone = graph.seals.filter(seal => seal.at < at).length;
    landing = row.ring.zero ? t('monitor.recall.landing.zero', { at }) : t('monitor.recall.landing.at', { at, zone: graph.seals[zone - 1].ordinal });
  }
  return { seq, title: t('monitor.recall.title', { seq, name: row.name }), landing, reads: row.dots.map(({ at, call }) => ({ at, label: t('monitor.recall.read', { at }), call })) };
}

/** The first `limit` characters of `text` and how many it leaves out, cut between characters; null for a text that is none or empty, which there is nothing to expand of. */
export function excerptOf(text, limit) {
  if (typeof text !== 'string' || text === '') return null;
  if (text.length <= limit) return { text, hidden: 0 };
  let end = 0;
  let kept = 0;
  for (const character of text) {
    if (kept === limit) break;
    end += character.length;
    kept += 1;
  }
  let hidden = 0;
  for (const _ of text.slice(end)) hidden += 1;
  return { text: text.slice(0, end), hidden };
}
