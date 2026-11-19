// lib/turn-page.js — the single Turn Page Operation (`CONTEXT.md`): window selection, lazy
// per-Source read, budget accounting and the frozen page text. The three product faces
// — `load_handoff`, `GET /api/turn/page` and the `turn_page` tool — all call buildTurnPage directly;
// none of the three orchestrates these steps itself.
import { DEFAULT_CTP } from './constants.js';
import { estimateWireTokens, isWithinHistoryBudget } from './turn-history-budget.js';
import {
  activePathOrdinals, admitsTurn, createHistoryReader, labelHistorySources, parseTurnPageBoundary,
  projectTurnRecord, turnAddress,
} from './turn.js';

// The `before` boundary resolves mechanically or not at all — every rejection is this one error, with
// no echo of the input. Callers map it to 404 { error: 'not_found' }.
const notFound = () => Object.assign(new Error('not_found'), { code: 'not_found' });

// The shared layer holds no prose of its own: a missing notice is a construction fault, not a runtime
// one, so it fails loud rather than opening the page with an empty first line.
function invariant(ok, message) {
  if (!ok) throw new Error(`turn page invariant: ${message}`);
}

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
 * Render a whole page from the chosen entries, oldest first. A header opens each run of entries of one
 * lineage member, so two members that name one session and one Source still open their own blocks.
 * Exported for `parseTurnPage`'s round trip.
 */
export function renderPage(entries, notice) {
  const blocks = [notice];
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

// A record's physical line as `renderRecord` writes it: the address on the first line of an addressed record, else the
// pad that is blank for an unaddressed one and as wide as the address and its space for a continuation, then the role
// prefix. `s` lets a content hold the Unicode line separators `.` otherwise stops at.
const RECORD_LINE = /^(?:(S\d+:\d+) | *)\| ([UA]): (.*)$/s;

/**
 * Read the records back out of a page's text: the inverse of `renderPage` over what a page shows of a record.
 * A line that carries a role prefix belongs to a record; the notice and the member header blocks carry none and are
 * skipped. A record's lines never contain a bare blank line, so the blank line between blocks closes the open record,
 * and its first line carries the address, none for a record with no address (`t: null`). The newlines inside a U or an
 * A were unified when the page was rendered, so the lines of each role join with `\n`.
 *
 * @param {unknown} text - the page text, `turn_page` of a load or of the `turn_page` tool
 * @returns {Array<{ address: string|null, user: string, note: string|null }>} the records in page order; `note` is
 *          null where the record has no A line, which an empty note is not
 */
export function parseTurnPage(text) {
  const records = [];
  let open = null;
  const close = () => {
    if (open !== null) {
      records.push({ address: open.address, user: open.user.join('\n'), note: open.note.length === 0 ? null : open.note.join('\n') });
    }
    open = null;
  };
  for (const line of typeof text === 'string' ? text.split('\n') : []) {
    const match = RECORD_LINE.exec(line);
    if (match === null) {
      close();
      continue;
    }
    const [, address, role, content] = match;
    open ??= { address: address ?? null, user: [], note: [] };
    (role === 'U' ? open.user : open.note).push(content);
  }
  close();
  return records;
}

// A member header as `renderPage` writes it opens with the member's label and a space. A line of a record opens with its address, whose label a colon follows, or with a pad or a role prefix, so no record line does.
const MEMBER_HEADER = /^S\d+ /;

/**
 * The part of a page's text the newest lineage member wrote: from the last member header on, which `parseTurnPage` reads as the records of that member alone. A page with no header, and any value that is no page text, has no member to cut to: the page as it is, and the empty text for a value that is no text.
 * The lines are split on `\n` alone, as `renderPage` joins them, so a Unicode line separator inside a record never starts a line.
 *
 * @param {unknown} text - the page text, `turn_page` of a load or of the `turn_page` tool
 * @returns {string}
 */
export function newestMemberOf(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  const at = lines.findLastIndex(line => MEMBER_HEADER.test(line));
  return at < 0 ? text : lines.slice(at).join('\n');
}

// listTurnNotes has no ORDER BY, so the page establishes its own order. An addressable session sorts
// on the runtime T alone. An unverified session has no T to sort on, so those records order by
// anchor uuid, an order that is deterministic but not conversation time: the transcript-assigned
// key every stored record carries, where source_timestamp is neither unique nor a page coordinate.
// Pinned by test/turn-page.test.js `未定位记录按 anchor uuid 升序`.
const byOrdinal = (a, b) => a.record.t - b.record.t;
const byAnchor = (a, b) => (a.anchorUuid < b.anchorUuid ? -1 : a.anchorUuid > b.anchorUuid ? 1 : 0);

/**
 * Project one lineage member into its ordered, page-eligible Turn Records: the session's stored notes that
 * the entry's `window` admits (`admitsTurn`), so members that name one session hold disjoint records.
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
 * @param {function} readSource - `(sourceLocator) => { readable, turns }` or a Promise of it; awaited
 * @returns {Promise<{ readable: boolean, records: object[] }>}
 */
export async function projectSession(store, entry, readSource) {
  // The complete multi-epoch projection: the active path spans every compact epoch, where the
  // production capture's current-epoch suffix would judge every pre-compact turn unverifiable.
  const { readable, turns } = await readSource(entry.sourceLocator);
  const ordinals = readable ? activePathOrdinals(turns) : null;
  const addressable = ordinals !== null && ordinals.size > 0;

  const records = [];
  for (const row of store.listTurnNotes(entry.sessionId)) {
    if (!admitsTurn(entry, row.sourceTimestamp)) continue;
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
 * member's Source after that. CTP is fixed at DEFAULT_CTP for the whole turn chain — the
 * calling session's CTP is never read, so one page measures the same under load and under HTTP.
 *
 * @param {object} args
 * @param {object} args.store - Store instance (turn_note reads only)
 * @param {Array<object>} args.lineage - Oldest → newest, as lib/lineage.js returns it
 * @param {string|null} [args.before] - `S{k}` for that member's end, or `S{k}:{T}` for the record ahead
 *        of that turn: a label alone includes the member's newest turn, an addressed boundary excludes
 *        the turn it names
 * @param {object} args.dialogueSource - the Harness DialogueSource Adapter
 * @param {object} args.dialogueProjection - the Harness-bound Dialogue Adapter
 * @param {string} args.notice - the Harness's page-opening sentence; a required non-empty string
 * @returns {Promise<{ turnPage: string, nextBefore: string|null }>} `{ turnPage: '', nextBefore: null }`
 *          when the window is empty AND when not even one turn fits — neither is an error to retry
 * @throws Rejects with an error carrying `code: 'not_found'` for any `before` that does not resolve
 *         mechanically
 */
export async function buildTurnPage({ store, lineage, before = null, dialogueSource, dialogueProjection, notice }) {
  invariant(typeof notice === 'string' && notice.length > 0, 'notice is required');
  const sources = labelHistorySources(lineage);
  const readSource = createHistoryReader({ dialogueSource, dialogueProjection });
  const parsed = new Map();
  const sessionAt = (index) => {
    if (!parsed.has(index)) parsed.set(index, projectSession(store, sources[index], readSource));
    return parsed.get(index);
  };

  const boundary = before == null ? null : await resolveBefore(before, sources, sessionAt);
  const newestIndex = boundary ? boundary.index : sources.length - 1;
  const windowAt = async (index) => {
    const { records } = await sessionAt(index);
    // A label-only boundary selects the whole window: the member's end is where the page starts, so
    // there is no record to cut against.
    if (!boundary || index !== boundary.index || boundary.t === null) return records;
    return records.filter(e => e.record.t < boundary.t);
  };

  let entries = [];        // oldest first — the render order
  let turnPage = '';
  let olderRemains = false;
  fill:
  for (let index = newestIndex; index >= 0; index--) {
    // A fill that ends exactly on a member boundary projects the next older member, opening its Source
    // unless a newer member of the same session already did, before the budget rejects its first record —
    // olderRemains is not knowable any other way.
    const window = await windowAt(index);
    for (let i = window.length - 1; i >= 0; i--) {
      const candidate = [window[i], ...entries];
      const rendered = renderPage(candidate, notice);
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
 * Resolve a page boundary against the lineage. A label alone names a lineage member and the page starts
 * at its end, so membership in the lineage is the whole requirement — an unreadable Source there yields
 * unverified records, which is what an unreadable Source yields everywhere else, and resolution opens no
 * Source at all. A label with a `T` keeps the stricter demand of an exclusive turn boundary: exact label,
 * exact T, a readable member holding an active persisted record at that very T — no timestamp, no array
 * index, no nearest-T guess.
 */
async function resolveBefore(before, sources, sessionAt) {
  const parsed = parseTurnPageBoundary(before);
  if (!parsed) throw notFound();
  const index = sources.findIndex(entry => entry.label === parsed.label);
  if (index < 0) throw notFound();
  if (parsed.sourceOrdinal === null) return { index, t: null };
  const t = parsed.sourceOrdinal;
  if (!(await sessionAt(index)).records.some(entry => entry.record.t === t)) throw notFound();
  return { index, t };
}
