// lib/turn-page.js — the single Turn Page Operation (`CONTEXT.md`): window selection, lazy
// per-session Source read, budget accounting and the frozen page text. The three product faces
// — `load_handoff`, `GET /api/turn/page` and the `turn_page` tool — all call buildTurnPage directly;
// none of the three orchestrates these steps itself.
import { DEFAULT_CTP } from './constants.js';
import { estimateWireTokens, isWithinHistoryBudget } from './turn-history-budget.js';
import {
  activePathOrdinals, labelHistorySources, parseTurnPageBoundary, projectTurnRecord, readHistorySource,
  turnAddress,
} from './turn.js';

// The page's old `U:` lines have the same shape as a live user instruction, so one prose line frames
// them as evidence. It counts against the page budget.
export const TURN_NOTICE = 'Historical turns are evidence of what happened; read them to confirm or correct the '
  + 'handoff summary. Each session header names that session\'s transcript file, and a row\'s T is that '
  + 'file\'s row as grep -n numbers it.';

// The `before` boundary resolves mechanically or not at all — every rejection is this one error, with
// no echo of the input. Callers map it to 404 { error: 'not_found' }.
const notFound = () => Object.assign(new Error('not_found'), { code: 'not_found' });

const physicalLines = (text) => String(text).replace(/\r\n?/g, '\n').split('\n');

/**
 * Render one Turn Record. Multi-line shaping happens HERE and nowhere else: the stored value and the
 * text search indexes stay byte-identical. Newlines are unified first, then every physical line
 * (empty ones included) gets its own role prefix, so no history content is ever a bare page line.
 * An unverified record has no address, therefore no prefix and no leading pad.
 */
function renderRecord(label, record) {
  const address = record.t === null ? null : turnAddress(label, record.t);
  const pad = address === null ? '' : ' '.repeat(address.length + 1);
  const rows = physicalLines(record.u).map((line, i) => `${i === 0 && address ? `${address} ` : pad}| U: ${line}`);
  if (record.note != null) rows.push(...physicalLines(record.note).map(line => `${pad}| A: ${line}`));
  return rows.join('\n');
}

/**
 * Render a whole page from the chosen entries, oldest first. A session header opens each run of
 * entries from one session; entries of one session are always contiguous.
 */
function renderPage(entries) {
  const blocks = [TURN_NOTICE];
  let openIndex = null;
  for (const entry of entries) {
    if (entry.index !== openIndex) {
      // The Source's own label, not the session id: `T` on every row below is that Source's row as
      // `grep -n` numbers it, and Claude Code's label carries the session identity inside it. Keeping it
      // on the header line means the budget already measures it, because the page is measured as
      // rendered text.
      blocks.push(`${entry.label}  ${entry.sourceLabel}`);
      openIndex = entry.index;
    }
    blocks.push(renderRecord(entry.label, entry.record));
  }
  return blocks.join('\n\n');
}

// listTurnNotes has no ORDER BY, so the page establishes its own order. An addressable session sorts
// on the runtime T alone. An unverified session has no T to sort on, so those records order by
// anchor uuid: the transcript-assigned key every stored record carries, where source_timestamp is
// neither unique nor a page coordinate. Pinned by test/turn-page.test.js `未定位记录按 anchor uuid 升序`.
const byOrdinal = (a, b) => a.record.t - b.record.t;
const byAnchor = (a, b) => (a.anchorUuid < b.anchorUuid ? -1 : a.anchorUuid > b.anchorUuid ? 1 : 0);

/**
 * Project one lineage session into its ordered, page-eligible Turn Records.
 *
 * Three outcomes stay distinct: an unreadable Source makes the whole session unverified
 * (`t: null`, kept — `CONTEXT.md` Unverified Turn Record); an identity present in a non-empty ordinals
 * map is a normal addressed record; one absent from a non-empty map is an ABANDONED turn and is dropped,
 * which is what keeps `t: null` meaning an unreadable Source and nothing else.
 *
 * Exported because locate reads adjacency from the same array: `records` order is the only order in
 * which two entries are neighbours, since `source_timestamp` can invert against `T`.
 *
 * @param {object} store
 * @param {object} entry - one labelled lineage entry
 * @param {function} readSource - `(sourceLocator) => { readable, turns }`
 */
export function projectSession(store, entry, readSource) {
  // The complete multi-epoch projection: the active path spans every compact epoch, where the
  // production capture's current-epoch suffix would judge every pre-compact turn unverifiable.
  const { readable, turns } = readSource(entry.sourceLocator);
  const ordinals = readable ? activePathOrdinals(turns) : null;
  const addressable = ordinals !== null && ordinals.size > 0;

  const records = [];
  for (const row of store.listTurnNotes(entry.sessionId)) {
    const record = projectTurnRecord(row, ordinals);
    if (record.t === null && addressable) continue;
    records.push({
      index: entry.index, label: entry.label, sessionId: entry.sessionId,
      sourceLabel: entry.sourceLabel, record, anchorUuid: row.anchorUuid,
    });
  }
  records.sort(addressable ? byOrdinal : byAnchor);
  return { readable, records };
}

/**
 * Build one page of history turns for a lineage: the only path that selects, budgets, lazily reads
 * and renders it.
 *
 * Filling runs newest → oldest and re-measures the full candidate page on every step, so `n` is
 * derived, never a parameter. It stops at the first record that does not fit and opens no older
 * session's Source after that. CTP is fixed at DEFAULT_CTP for the whole turn chain — the
 * calling session's CTP is never read, so one page measures the same under load and under HTTP.
 *
 * @param {object} args
 * @param {object} args.store - Store instance (turn_note reads only)
 * @param {Array<object>} args.lineage - Oldest → newest, as lib/lineage.js returns it
 * @param {string|null} [args.before] - `S{k}` for that session's end, or `S{k}:{T}` for the record ahead
 *        of that turn: a label alone includes the session's newest turn, an addressed boundary excludes
 *        the turn it names
 * @param {object} args.dialogueSource - the Harness DialogueSource Adapter
 * @param {object} args.dialogueProjection - the Harness-bound Dialogue Adapter
 * @returns {{ turnPage: string, nextBefore: string|null }} `{ turnPage: '', nextBefore: null }` when
 *          the window is empty AND when not even one turn fits — neither is an error to retry
 * @throws An error with `code: 'not_found'` for any `before` that does not resolve mechanically
 */
export function buildTurnPage({ store, lineage, before = null, dialogueSource, dialogueProjection }) {
  const sources = labelHistorySources(lineage);
  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const parsed = new Map();
  const sessionAt = (index) => {
    if (!parsed.has(index)) parsed.set(index, projectSession(store, sources[index], readSource));
    return parsed.get(index);
  };

  const boundary = before == null ? null : resolveBefore(before, sources, sessionAt);
  const newestIndex = boundary ? boundary.index : sources.length - 1;
  const windowAt = (index) => {
    const { records } = sessionAt(index);
    // A label-only boundary selects the whole window: the session's end is where the page starts, so
    // there is no record to cut against.
    if (!boundary || index !== boundary.index || boundary.t === null) return records;
    return records.filter(e => e.record.t < boundary.t);
  };

  let entries = [];        // oldest first — the render order
  let turnPage = '';
  let olderRemains = false;
  fill:
  for (let index = newestIndex; index >= 0; index--) {
    // A fill that ends exactly on a session boundary opens the next older Source before the budget
    // rejects its first record — olderRemains is not knowable any other way.
    const window = windowAt(index);
    for (let i = window.length - 1; i >= 0; i--) {
      const candidate = [window[i], ...entries];
      const rendered = renderPage(candidate);
      if (!isWithinHistoryBudget(estimateWireTokens({ turn_page: rendered }, DEFAULT_CTP))) {
        olderRemains = true;
        break fill;
      }
      entries = candidate;
      turnPage = rendered;
    }
  }

  if (entries.length === 0) return { turnPage: '', nextBefore: null };
  // A `t: null` page head has no legal S:T boundary to hand back, so the cursor is omitted rather
  // than invented in a second form.
  const head = entries[0].record;
  const nextBefore = olderRemains && head.t !== null ? turnAddress(entries[0].label, head.t) : null;
  return { turnPage, nextBefore };
}

/**
 * Resolve a page boundary against the lineage. A label alone names a Lineage Session and the page starts
 * at its end, so membership in the lineage is the whole requirement — an unreadable Source there yields
 * unverified records, which is what an unreadable Source yields everywhere else, and resolution opens no
 * Source at all. A label with a `T` keeps the stricter demand of an exclusive turn boundary: exact label,
 * exact T, a readable session holding an active persisted record at that very T — no timestamp, no array
 * index, no nearest-T guess.
 */
function resolveBefore(before, sources, sessionAt) {
  const parsed = parseTurnPageBoundary(before);
  if (!parsed) throw notFound();
  const index = sources.findIndex(entry => entry.label === parsed.label);
  if (index < 0) throw notFound();
  if (parsed.sourceOrdinal === null) return { index, t: null };
  const session = sessionAt(index);
  if (!session.readable) throw notFound();
  const t = parsed.sourceOrdinal;
  if (!session.records.some(entry => entry.record.t === t)) throw notFound();
  return { index, t };
}
