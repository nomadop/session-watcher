// lib/turn-query.js — the two history query operations over one lineage.
//
// Exact Transcript Search is a literal lookup over the projected Dialogue entities, measured on the wire
// it is about to return; it reads the persisted turn index only to say WHICH TURN a hit landed in, so a
// hit inside a turn that was never recorded still returns. History Range Location asks the persisted
// turn_note index for candidates, resolves every one of them back onto the live active path so it never
// hands out an address it did not verify, and returns each verified hit with the turns adjacent to it so
// a query that landed near its target re-aims without a second call.
//
// Neither operation interprets a Harness outcome taxonomy: which tool pairs are part of the match surface
// arrives as one injected predicate, and a pair's path cue arrives as the Adapter's own `resourceKey`.
import { DEFAULT_CTP, NOTE_PREVIEW_TOKENS } from './constants.js';
import { dialogueFoldLines } from './dialogue-fold.js';
import { serializeResult, stableStringify } from './dialogue-tool.js';
import {
  HISTORY_EXCERPT_CHARS, estimateWireTokens, isWithinHistoryBudget, truncateToTokens, truncationMarker,
} from './turn-history-budget.js';
import { buildFtsMatch } from './handoff.js';
import { projectSession } from './turn-page.js';
import { labelHistorySources, parseTurnAddress, readHistorySource, turnAddress } from './turn.js';

// Locate verifies at most this many ranked candidates as HITS — the `CONTEXT.md` History Range Location
// cap. The name stays on the rank side because rank still SELECTS candidates; the wire presents them as
// hits. The cap is applied AFTER active-path verification, which is why the SQL behind it has no LIMIT.
const LOCATE_CANDIDATES = 5;

// Each hit also carries up to this many records either side of it. Two is what lets a query that landed
// NEAR its target re-aim from the response instead of from another round trip.
const LOCATE_WINDOW = 2;

// A scope that cannot be resolved mechanically is this one error, with no echo of the input.
// Callers map it to 404 { error: 'scope_not_found' }.
const scopeNotFound = () => Object.assign(new Error('scope_not_found'), { code: 'scope_not_found' });

// ASCII case folding, one code unit at a time, A–Z only. `String.prototype.toLowerCase()` is banned
// here: 'İ'.toLowerCase() grows from one code unit to two, which shifts every later hit offset and
// silently mis-slices the excerpt. This mapping keeps length invariant, so an offset found in the
// folded text projects straight back onto the source text.
function foldAscii(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c >= 65 && c <= 90) ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/**
 * The canonical entities of one target fold, in the order that fixes both dedup and the excerpt centre:
 * the fold's lines as dialogueFoldLines enumerates them — the visible body, then each admitted tool line
 * in `toolPairs` order, contributing tool name, serialized input, serialized result.
 *
 * Which pairs are admitted is the injected predicate's decision alone, called after last-result-wins
 * pairing. Exact transcript search covers only the evidence that exists solely in the Source: a pair whose
 * ground truth is the working tree contributes nothing (ADR 0004), and this module knows that only through
 * the predicate's answer.
 *
 * The scan surface is `dialogueFoldLines`, not a second walk of `fold.toolPairs`: one definition of a line
 * keeps the skeleton and this in step on what a fold contains, pinned by test/turn-query.test.js
 * `search 的扫描面与行枚举同源`.
 */
function canonicalEntities(fold, includeToolEvidence) {
  const entities = [];
  for (const line of dialogueFoldLines(fold)) {
    if (line.kind === 'visible') {
      if (typeof line.message.text === 'string') entities.push({ text: line.message.text, line: line.sourceOrdinal });
      continue;
    }
    if (!includeToolEvidence(line.tool)) continue;
    // A name and an input are blocks of the tool-use row; a result is its own row; only the visible body
    // sits on the fold's own row. This is the one place those differences are resolved, so a hit's `line`
    // always names the row its excerpt is on.
    const useLine = line.sourceOrdinal;
    if (typeof line.tool.name === 'string') entities.push({ text: line.tool.name, line: useLine });
    if (line.tool.input != null) entities.push({ text: stableStringify(line.tool.input), line: useLine });
    const { resultStr } = serializeResult(line.tool.result);
    if (resultStr !== null) {
      entities.push({ text: resultStr, line: line.tool.resultSourceOrdinal ?? useLine });
    }
  }
  return entities;
}

const isHighSurrogate = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c) => c >= 0xDC00 && c <= 0xDFFF;

/**
 * Cut at most HISTORY_EXCERPT_CHARS source characters around one hit. The hit span is contained FIRST
 * and only the remainder is split between the two sides, so a q longer than half the window keeps its
 * own text whole. Ellipsis markers are bare and sit outside those characters, one per elided side.
 */
function excerptAround(entity, hitStart, hitLength) {
  const hitEnd = hitStart + hitLength;
  const remaining = Math.max(0, HISTORY_EXCERPT_CHARS - hitLength);
  const before = Math.floor(remaining / 2);
  let start = hitStart - before;
  let end = hitEnd + (remaining - before);
  if (start < 0) { end -= start; start = 0; }
  if (end > entity.length) { start -= end - entity.length; end = entity.length; }
  if (start < 0) start = 0;
  // Context may not end on half a surrogate pair; the hit span itself is never shortened for it.
  if (start < hitStart && isLowSurrogate(entity.charCodeAt(start))) start++;
  if (end > hitEnd && isHighSurrogate(entity.charCodeAt(end - 1))) end--;
  return (start > 0 ? '…' : '') + entity.slice(start, end) + (end < entity.length ? '…' : '');
}

// First hit in canonical entity order. The offset comes from the folded copy and indexes the source
// text; the line comes from the entity, so it names the physical row the excerpt sits on.
function firstHit(entities, needle) {
  for (const entity of entities) {
    const index = foldAscii(entity.text).indexOf(needle);
    if (index >= 0) return { text: entity.text, index, line: entity.line };
  }
  return null;
}

/**
 * The Sources to scan, in scan order and read no sooner than they are reached.
 * Scopeless: the readable lineage, newest → oldest; a Source with no locator or an unavailable read is
 * skipped silently — an incomplete scan returns the hits it did reach, pinned by test/turn-query.test.js
 * `不可读会话在无 scope 搜索里被静默跳过`. Scoped: exactly one turn span.
 *
 * `folds` is the scan surface — narrowed to one span under a scope — while `turns` is always grouped over
 * the WHOLE Source, because turn membership and active-path positions are properties of the Source and not
 * of the surface.
 */
function* sessionsToScan(sources, scope, readSource) {
  if (scope != null) {
    yield scopedSession(sources, scope, readSource);
    return;
  }
  for (let index = sources.length - 1; index >= 0; index--) {
    const entry = sources[index];
    if (!entry.sourceLocator) continue;
    const read = readSource(entry.sourceLocator);
    if (!read.readable) continue;
    yield { entry, folds: read.folds, turns: read.turns };
  }
}

/**
 * Resolve `S{k}:{T}` with the existing primitives only: exact label, projected Dialogue, grouped Turns,
 * the unique Turn at that ordinal. The searchable surface is that Turn's whole line span, so every fold
 * a line of it belongs to is in scope.
 */
function scopedSession(sources, scope, readSource) {
  const parsed = parseTurnAddress(scope);
  if (!parsed) throw scopeNotFound();
  const entry = sources.find(e => e.label === parsed.label);
  if (!entry || !entry.sourceLocator) throw scopeNotFound();
  const read = readSource(entry.sourceLocator);
  if (!read.readable) throw scopeNotFound();
  // The projection keeps the active path only, so an ordinal on an abandoned branch — like one that is
  // not a Turn Head at all — simply has no Turn here.
  const turns = read.turns.filter(turn => turn.sourceOrdinal === parsed.sourceOrdinal);
  if (turns.length !== 1) throw scopeNotFound();
  const span = new Set(turns[0].lines.map(line => line.foldOrdinal));
  return {
    entry,
    folds: read.folds.filter(fold => span.has(fold.ordinal)),
    turns,
  };
}

/**
 * The Turn each fold sits in, as a fold ordinal → `{ turnIndex, sourceEntryId }` map.
 *
 * The two identities are different animals. A match sits in a FOLD, while a turn_note row is keyed on its
 * Turn HEAD's `sourceEntryId`; they coincide only when the literal landed in the head fold, so both
 * grouping and the record join have to go through Turn membership. `groupTurns` is the one place that
 * decides membership and it groups the same lines the scan matches on, so every fold a hit can carry is
 * reachable here. Positioning by ordinal instead — the greatest `record.t ≤` the hit fold's ordinal —
 * would MIS-ATTRIBUTE: records exist only for turns that earned a note, so a hit inside an un-noted turn
 * (an acknowledged harness command) or inside any turn past the handoff's capture boundary would
 * silently take the previous noted turn's record.
 *
 * Grouping keys on the Turn's own position rather than on its identity, so two Turns whose heads carry no
 * identity stay two entries.
 *
 * @param {object[]} turns - grouped Turns over the whole Source
 * @returns {Map<number, { turnIndex: number, sourceEntryId: string|null }>}
 */
function turnByFold(turns) {
  const byFold = new Map();
  turns.forEach((turn, turnIndex) => {
    for (const line of turn.lines) {
      byFold.set(line.foldOrdinal, { turnIndex, sourceEntryId: turn.sourceEntryId });
    }
  });
  return byFold;
}

// A visible human fold is part of the match surface exactly when it opens a Turn. Every other one is
// `CONTEXT.md` Absorbed Harness Evidence and leaves the Source only as a note: the composition's human
// rule classifies every visible human line as either a head or absorbed, so Turn membership answers the
// question without this module reading a command syntax of its own.
const headFoldsOf = (turns) => new Set(turns.map(turn => turn.lines[0].foldOrdinal));

/**
 * One session's persisted Turn Records, keyed by the Turn Head identity a group is keyed on.
 *
 * The Source is already projected, so projectSession reads it from here instead of reading a second time;
 * scan order is unchanged and so is the one-read-per-session the lazy-read test pins.
 *
 * @returns {Map<string, { t: number, u: string, note?: string }>}
 */
function recordByTurnHead(store, entry, turns) {
  // `t: null` is the unverified address of a Source that reads but positions nothing. It can never be
  // rendered into a scope, so it leaves the map rather than being guarded at the point of use.
  const { records } = projectSession(store, entry, () => ({ readable: true, turns }));
  return new Map(records.filter(r => r.record.t !== null).map(r => [r.anchorUuid, r.record]));
}

// The physical closed interval one fold occupies: its own row, widened by every row its pairs' results
// sit on. Admission is deliberately not consulted — the interval describes the Source, and a reader given
// it will see whatever the Source holds there regardless of what the search corpus admits.
const foldSpan = (fold) => {
  const own = fold.sourceOrdinal;
  let min = own;
  let max = own;
  for (const pair of fold.toolPairs || []) {
    const at = pair.resultSourceOrdinal;
    if (at == null) continue;
    if (at < min) min = at;
    if (at > max) max = at;
  }
  return [min, max];
};

/**
 * Exact literal search over the projected Dialogue of one lineage, grouped by the Turn each hit sits in.
 *
 * Scanning runs newest → oldest, and newest → oldest within a Source, while the response is one flat
 * `ranges` list in canonical oldest → newest order — turns and, inside each, its matches. A turn carries
 * its address and record ONCE for the whole entry, which is what the grouping buys: a literal matching
 * several folds of one turn would otherwise copy that turn's whole record onto every one of them.
 *
 * Each fold is scanned once and keeps its FIRST matching entity, so two folds that happen to share a
 * native entry identity stay two distinct matches.
 *
 * Admission stays per MATCH, measured against the grouped wire the retained set would produce — each
 * entry's Source label included. So the budget spends what grouping saves on reach, while the smallest
 * thing it can drop is one excerpt: the first match that does not fit sets `truncated` and stops
 * everything, with no older match in the current Source and no older Source opened. Grouping is therefore
 * output shaping, never a unit of admission — which is what keeps a turn holding more matches than the
 * budget can carry from rejecting the whole response. What `truncated` drops is always the oldest, so the
 * OLDEST retained entry is the one that may hold fewer matches than its turn really has. CTP is fixed at
 * DEFAULT_CTP, so one hit set measures the same under load and under HTTP.
 *
 * A turn with a persisted record carries its address and record, which is what lets an agent page from a
 * hit or narrow around it; a turn with none carries neither. A SCOPED scan does not enrich at all — its
 * every hit sits in the turn the caller named — so it keeps the bare capacity and returns one group.
 *
 * `q` is a literal, never a pattern. Its emptiness and length rules belong to each caller's own input
 * gate: isValidTurnQuery on the HTTP route, and the min/max/non-blank zod shape the MCP tool registers.
 *
 * @param {object} args
 * @param {object} args.store - Read for the turn records only; a hit is returned whether or not its
 *        turn has one
 * @param {Array<object>} args.lineage - Oldest → newest, as lib/lineage.js returns it
 * @param {string} args.q - The literal to find; ASCII case-insensitive, no normalization
 * @param {string|null} [args.scope] - `S{k}:{T}`; restricts the scan to that turn's span, which is also
 *        what leaves its group bare
 * @param {object} args.dialogueSource - the Harness DialogueSource Adapter
 * @param {object} args.dialogueProjection - the Harness-bound Dialogue Adapter
 * @param {function} args.includeToolEvidence - `(pair) => boolean`, the Harness's own admission rule;
 *        required, and called only after last-result-wins pairing
 * @returns {{ found: false }|{ found: true, ranges: Array<object>, truncated: boolean }}
 * @throws An error with `code: 'scope_not_found'` for any `scope` that does not resolve mechanically
 */
export function searchTranscripts({
  store, lineage, q, scope = null, dialogueSource, dialogueProjection, includeToolEvidence,
}) {
  const sources = labelHistorySources(lineage);
  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const needle = foldAscii(String(q));
  // `truncated: false` renders longer than `true`, so a match that fits under it fits the response.
  const wire = (ranges, truncated) => ({ found: true, ranges, truncated });

  // The turn structure is applied on the way OUT: a match carries its turn while filling, and matches of
  // one turn collapse into one entry here. Keeping it out of admission is what bounds the damage a budget
  // can do — the smallest thing the cut can drop is one excerpt, never a whole turn's worth of them.
  // Keyed per session, and the reset on a session change is safe because `walk` in lib/lineage.js
  // truncates on a repeated sessionId — a lineage holds each session ONCE, so one pass yields each as a
  // single run. Contiguity alone would NOT be enough: two runs of one session would reset the map between
  // them and emit two entries for one turn. Keying this way avoids composing a key out of two strings,
  // and makes the grouping independent of whether a turn's folds are contiguous — a turn reached twice
  // merges into the entry its earliest match opened.
  const groupsOf = (matches) => {
    const out = [];
    let session = null;
    let byTurn = new Map();
    for (const m of matches) {
      if (m.sessionId !== session) { session = m.sessionId; byTurn = new Map(); }
      const open = byTurn.get(m.turnKey);
      if (open) { open.matches.push(m.wire); continue; }
      const fresh = { label: m.label, record: m.record, sourceLabel: m.sourceLabel, matches: [m.wire] };
      byTurn.set(m.turnKey, fresh);
      out.push(fresh);
    }
    return out.map(({ label, record, sourceLabel, matches: inner }) => ({
      // The Source whose rows the matches' `line` numbers name, carried once for the turn. The session id
      // is not carried beside it: Claude Code names a Source for its session, so the identity travels
      // inside the label.
      transcript_path: sourceLabel,
      // The containing turn's own address and record, so a hit can be paged from and narrowed around
      // instead of being a navigational dead end — carried once for the turn rather than once per match.
      // All three arrive or none does: a turn with no usable record — one that earned no note, one past
      // the handoff's capture boundary, or one positioning nothing on the active path — leaves its
      // matches exactly as bare as they were rather than half-addressed. `scope` addresses the TURN,
      // while a match's own `line` addresses one row, so the two are not two spellings of one thing.
      ...(record && {
        scope: turnAddress(label, record.t),
        u: record.u,
        ...(record.note != null && { note: record.note }),
      }),
      matches: inner,
    }));
  };
  // What the budget measures IS what would be returned: grouped, chronological, same keys and nesting. So
  // the saving grouping buys is spent on reach rather than left on the table, while the granularity the
  // budget acts at stays one match.
  const wireOf = (matches) => wire(groupsOf([...matches].reverse()), false);

  const retained = [];               // matches, newest → oldest while filling
  let truncated = false;

  scan:
  for (const { entry, folds, turns } of sessionsToScan(sources, scope, readSource)) {
    // Built on this session's first hit and reused by every later one, so neither pass runs for a Source
    // the literal never appears in. Grouping needs the membership map; only the address needs
    // projectSession, and a scoped scan needs neither.
    // Deliberately not shared with locateRanges' own per-session memo: that one holds a different
    // projection (the record array plus its identity index, with no membership map) and fills in FTS rank
    // order, where "a session holding only lower-ranked candidates is never opened" is asserted through
    // the injected read seam. One store across both would let this newest → oldest scan decide whether
    // that assertion's read has already happened.
    let membership = null;
    let recordByHead = null;
    let headFolds = null;
    for (let i = folds.length - 1; i >= 0; i--) {
      const fold = folds[i];
      const hit = firstHit(canonicalEntities(fold, includeToolEvidence), needle);
      if (!hit) continue;
      headFolds ??= headFoldsOf(turns);
      if (fold.message && fold.message.role === 'human' && !headFolds.has(fold.ordinal)) continue;

      // A scoped scan's surface is ONE turn's line span, so it is one entry by construction and needs no
      // membership map; that entry would also hand back the very scope the caller passed in, which is
      // zero information at the cost of the capacity the scope was narrowed to get. Both lookups sit
      // behind this condition, so a scoped scan runs neither pass rather than discarding their results.
      let turnKey = entry.sessionId;
      let record = null;
      if (scope == null) {
        membership ??= turnByFold(turns);
        recordByHead ??= recordByTurnHead(store, entry, turns);
        const member = membership.get(fold.ordinal);
        turnKey = member ? member.turnIndex : `fold:${fold.ordinal}`;
        record = member && member.sourceEntryId ? recordByHead.get(member.sourceEntryId) ?? null : null;
      }
      const candidate = {
        sessionId: entry.sessionId, label: entry.label, turnKey, record,
        sourceLabel: entry.sourceLabel,
        wire: { line: hit.line, span: foldSpan(fold), excerpt: excerptAround(hit.text, hit.index, needle.length) },
      };
      if (!isWithinHistoryBudget(estimateWireTokens(wireOf([...retained, candidate]), DEFAULT_CTP))) {
        truncated = true;
        break scan;
      }
      retained.push(candidate);
    }
  }

  if (retained.length === 0 && !truncated) return { found: false };
  return wire(groupsOf([...retained].reverse()), truncated);
}

// Locate has exactly one failure: the turn FTS index is not usable. No echo of the input.
// Callers map it to 503 { error: 'locate_unavailable' }.
const locateUnavailable = () => Object.assign(new Error('locate_unavailable'), { code: 'locate_unavailable' });

// A context entry is there to be RECOGNIZED, not read — its whole job is letting a query that landed near
// its target re-aim — so its note is cut an order of magnitude below a hit's. The cut carries the shared
// truncationMarker, so one truncation form covers the whole turn wire.
const notePreview = (note) => {
  const cut = truncateToTokens(note, NOTE_PREVIEW_TOKENS, DEFAULT_CTP);
  return cut === note ? note : `${cut}${truncationMarker(note.length)}`;
};

// The address the wire carries and the key the walk dedups on, from the projected record alone — so the
// dedup decision can be made before an entry exists. Both readers take it from here, which is what keeps
// one rendering of an address that `CONTEXT.md` freezes as the scope form.
const scopeOf = ({ label, record }) => turnAddress(label, record.t);

// One projected record → its wire entry, plus the two coordinates the final sort runs on. Those stay
// OUTSIDE the entry: `ranges` is a frozen shape, and the wire the budget measures has to be the wire
// that is returned for the measurement to mean anything. The Source label rides on the existing hit
// branch: a context entry is there to be recognized rather than read, and a label repeated down the window
// would spend the candidate capacity the window exists to fill.
const locateEntry = (projected, isHit, sourceLabel) => {
  const { index, record } = projected;
  const wire = { scope: scopeOf(projected), u: record.u };
  if (record.note != null) wire.note = isHit ? record.note : notePreview(record.note);
  if (isHit) {
    wire.hit = true;
    wire.transcript_path = sourceLabel;
  }
  return { index, t: record.t, wire };
};

// Oldest → newest over the whole lineage: lineage index, then T. Same order buildTurnPage renders, and
// the reason it cannot be a timestamp order is projectSession's own docstring.
const locateWire = (accumulated) => ({
  found: true,
  ranges: [...accumulated.values()].sort((a, b) => a.index - b.index || a.t - b.t).map(e => e.wire),
});

/**
 * Locate the history ranges of one lineage relevant to `q`.
 *
 * FTS only nominates candidates: it ranks the persisted `u_text` prefix, the note and the mechanical
 * resource-key index across the lineage's sessions. Every candidate is then resolved against the CURRENT
 * Source before it can be returned — the stored identity must sit on the active path, and its runtime
 * source ordinal is the `T` in the returned address. A candidate whose Source is unreadable, or whose
 * identity lost the active path, is omitted; no substitute address is invented. So exhausting the
 * candidates without a verified hit is `{ found: false }`, indistinguishable from an FTS miss, and the
 * count of unverifiable candidates never reaches the caller.
 *
 * A verified hit brings up to LOCATE_WINDOW records either side of it, read off its OWN session's
 * projection — which is why a window is short at a session edge rather than continuing into the
 * neighbouring session. Hits and context arrive in one chronological list: `hit: true` marks what
 * matched, its absence marks context, and a record two windows reach appears once, as a hit if any pass
 * selected it. A hit carries its whole note; a context entry carries a preview.
 * A hit also carries the Source whose row its `T` names, so the row behind a hit can be read at full
 * length where the entry's `u` is cut; a context entry carries no label.
 *
 * The walk keeps the SQL's global rank order row by row and caches the projection per session — the
 * first time a session is reached it is read once, and the walk stops the moment the fifth hit is
 * verified, so a session that only holds lower-ranked candidates is never opened. It also stops when the
 * accumulated wire would leave the read budget, and that cut is silent: a candidate count is exactly
 * what this shape does not expose. One maximal hit with a full window measures under half the budget, so
 * the cut can never reject a FIRST hit whose note is within `NOTE_TOKEN_LIMIT`.
 *
 * @param {object} args
 * @param {object} args.store - Store instance (turn_note FTS + per-session note reads)
 * @param {Array<object>} args.lineage - Oldest → newest, as lib/lineage.js returns it
 * @param {string} args.q - A distinctive literal; whitespace terms stay ANDed and CJK becomes bigrams
 * @param {object} args.dialogueSource - the Harness DialogueSource Adapter
 * @param {object} args.dialogueProjection - the Harness-bound Dialogue Adapter
 * @returns {{ found: false }|{ found: true, ranges: Array<object> }} Oldest → newest, carrying at most
 *          LOCATE_CANDIDATES hits
 * @throws An error with `code: 'locate_unavailable'` when the turn FTS index cannot answer
 */
export function locateRanges({ store, lineage, q, dialogueSource, dialogueProjection }) {
  if (!store.turnFtsAvailable()) throw locateUnavailable();

  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const sessions = new Map(labelHistorySources(lineage).map(entry => [entry.sessionId, entry]));
  let rows;
  try {
    rows = store.locateTurnNotes([...sessions.keys()], buildFtsMatch(q, 'plain'));
  } catch {
    // Availability is decided at open, so a failure of this statement is a failure since then, and the
    // class is wider than a dropped virtual table: a drifted index raises SQLITE_CORRUPT_VTAB on a
    // perfectly legal MATCH. Neither is distinguishable here and both take one code, which is what
    // locate_unavailable's own capability wording already claims.
    throw locateUnavailable();
  }

  const projected = new Map();            // session id → { records, indexByAnchor }, or null when unreadable
  let accumulated = new Map();            // scope → { index, t, wire } — the scope IS (session, T) rendered
  let hits = 0;
  for (const row of rows) {
    const entry = sessions.get(row.sourceSessionId);
    if (!entry) continue;                 // no label ⇒ no address ⇒ nothing to return
    if (!projected.has(entry.sessionId)) {
      const { readable, records } = projectSession(store, entry, readSource);
      projected.set(entry.sessionId, readable
        ? { records, indexByAnchor: new Map(records.map((r, i) => [r.anchorUuid, i])) }
        : null);
    }
    const session = projected.get(entry.sessionId);
    if (!session) continue;
    const at = session.indexByAnchor.get(row.anchorUuid);
    // Absent ⇒ projectSession dropped an abandoned identity. Present with `t: null` ⇒ the Source reads
    // but addresses nothing, so the session projects unverified. Both omitted, never re-addressed.
    if (at === undefined || session.records[at].record.t === null) continue;

    // Copy-on-write: the budget verdict lands on the wire this hit WOULD produce, so this hit and its
    // window may only be committed once that measurement passes.
    const next = new Map(accumulated);
    const first = Math.max(0, at - LOCATE_WINDOW);
    const last = Math.min(session.records.length - 1, at + LOCATE_WINDOW);
    for (let i = first; i <= last; i++) {
      const candidate = session.records[i];
      const scope = scopeOf(candidate);
      // The hit always writes, and that write IS the upgrade: a record already carried as context gains
      // `hit` and its whole note. Context never overwrites, so nothing is demoted and the first window to
      // reach a record fixes its preview. turn_note is UNIQUE on (source_session_id, anchor_uuid), so no
      // two rows of one walk can claim the same scope as a hit. The decision runs on the key alone, so a
      // record an earlier window already carries is never re-entered and its note is never re-cut.
      if (i === at || !next.has(scope)) next.set(scope, locateEntry(candidate, i === at, entry.sourceLabel));
    }

    if (!isWithinHistoryBudget(estimateWireTokens(locateWire(next), DEFAULT_CTP))) break;
    accumulated = next;
    if (++hits === LOCATE_CANDIDATES) break;
  }

  if (hits === 0) return { found: false };
  return locateWire(accumulated);
}
