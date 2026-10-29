// lib/lineage-headlines.js — what a load carries of its lineage's headlines, and how the rest is read
// back. One module owns the bound that cuts the `CONTEXT.md` Lineage Headline list to a token budget and
// collapses what it leaves out into `CONTEXT.md` Omitted Lineage Run entries, the grammar of the
// positions that name those runs, and the selection those positions make, so the load, the tool
// schemas, the service and the route cannot disagree on any of them. Pure; imports only the constants
// and the wire sizing.
import { DEFAULT_CTP, LINEAGE_HEADLINE_TOKEN_BUDGET } from './constants.js';
import { estimateWireTokens } from './turn-history-budget.js';

// An entry's position is the number in its label, `S{k}`. The label is the only place it lives: the list
// holds no index, because a member whose window holds no rows leaves a hole in the numbering.
const positionOf = (entry) => Number(entry.label.slice(1));

// ── The bound ──────────────────────────────────────────────────────────────────

// A run of several is `S2-S5`; a run of one keeps its own label, so the reader meets one spelling of a
// position whether it stands alone or inside a range.
const runOf = (from, to) => ({ label: from === to ? `S${from}` : `S${from}-S${to}`, omitted: true });

/**
 * Collapse the entries the fill left out into maximal groups of consecutive positions. A group never
 * spans a position with no entry, so every position inside a run is one the selection can answer.
 *
 * @param {Array<{ label: string }>} entries - oldest → newest
 * @returns {Array<{ label: string, omitted: true }>}
 */
function collapseRuns(entries) {
  const runs = [];
  let from = null;
  let to = null;
  for (const entry of entries) {
    const n = positionOf(entry);
    if (to !== null && n === to + 1) {
      to = n;
      continue;
    }
    if (to !== null) runs.push(runOf(from, to));
    from = to = n;
  }
  if (to !== null) runs.push(runOf(from, to));
  return runs;
}

/**
 * Cut a lineage's headlines to the budget a load carries. The fill takes entries from the newest
 * backward and stops at the first whose suffix no longer fits, measured as the kept entries alone on
 * the wire the way the turn page measures a candidate page. Everything older then collapses into runs
 * after the measure, so the runs are not part of it: the budget bounds the headlines, and the field as
 * sent may exceed it by its runs. When not even the newest entry fits, the result is the runs alone.
 *
 * @param {Array<{ label: string, headline: string }>} entries - oldest → newest
 * @param {number} [budget] - a test seam; no production caller passes it
 * @returns {Array<{ label: string, headline?: string, omitted?: true }>} oldest → newest
 */
export function boundLineageHeadlines(entries, budget = LINEAGE_HEADLINE_TOKEN_BUDGET) {
  let start = entries.length;
  while (start > 0 && estimateWireTokens({ lineage: entries.slice(start - 1) }, DEFAULT_CTP) <= budget) {
    start--;
  }
  return [...collapseRuns(entries.slice(0, start)), ...entries.slice(start)];
}

// ── The positions ──────────────────────────────────────────────────────────────

// One pattern over the whole string, so no input reaches a split that the grammar has not already
// cleared: items are `n` or `a-b`, comma-separated, with no space, no `S` prefix and no leading zero.
const ITEM = '[1-9][0-9]*(?:-[1-9][0-9]*)?';
const POSITIONS = new RegExp(`^${ITEM}(?:,${ITEM})*$`);

/**
 * Parse the `k` of a position read into `[from, to]` pairs, one per comma-separated item.
 *
 * @param {unknown} text
 * @returns {Array<[number, number]>|null} at least one pair, or null for anything but a string that
 *   obeys the grammar, a range whose start is past its end included
 */
export function parseLineagePositions(text) {
  if (typeof text !== 'string' || !POSITIONS.test(text)) return null;
  const ranges = text.split(',').map((item) => {
    const [from, to = from] = item.split('-').map(Number);
    return [from, to];
  });
  return ranges.some(([from, to]) => from > to) ? null : ranges;
}

/**
 * The entries inside the ranges, once each in list order. A range is checked by counting the entries
 * inside it against its width, never by walking its integers, so a range as wide as the grammar allows
 * costs one pass over the list.
 *
 * @param {Array<{ label: string, headline: string }>} entries - oldest → newest
 * @param {Array<[number, number]>} ranges - as parseLineagePositions answers them
 * @returns {Array<{ label: string, headline: string }>|null} null when any range is not fully covered
 */
export function selectLineagePositions(entries, ranges) {
  const positions = entries.map(positionOf);
  const inside = ([from, to], n) => n >= from && n <= to;
  const covered = ranges.every((range) => {
    const [from, to] = range;
    return positions.filter((n) => inside(range, n)).length === to - from + 1;
  });
  if (!covered) return null;
  return entries.filter((_, i) => ranges.some((range) => inside(range, positions[i])));
}
