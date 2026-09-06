// lib/turn-query.js — the two history query operations over one lineage.
//
// Exact Transcript Search is a literal lookup over the canonical transcript entities, measured on the
// wire it is about to return; it reads the persisted turn index only to say WHICH TURN a hit landed in,
// so a hit inside a turn that was never recorded still returns. History Range Location asks the persisted
// turn_note index for candidates, resolves every one of them back onto the live active path so it never
// hands out an address it did not verify, and returns each verified hit with the turns adjacent to it so
// a query that landed near its target re-aims without a second call.
import { DEFAULT_CTP, NOTE_PREVIEW_TOKENS } from './constants.js';
import { enumerateLines, foldAnchor, foldLines, readCanonicalTranscript } from './dialogue-fold.js';
import { BOOKMARK_PREVIEW_CHARS, estimateWireTokens, isWithinBookmarkBudget, truncationMarker } from './bookmark-core.js';
import { classifyToolPair, serializeResult, stableStringify } from './bookmark-detail.js';
import { buildFtsMatch } from './handoff.js';
import { projectSession } from './turn-page.js';
import { cleanUserText, groupTurns, truncateToTokens, turnAddress, TURN_ADDRESS_RE } from './turn.js';

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

/**
 * Parse an `S{k}:{T}` scope, or null for every other shape. The HTTP route turns that null into
 * 400 invalid_scope before the search runs, so the format rule lives in exactly one regex.
 *
 * @param {string} raw
 * @returns {{ label: string, t: number }|null}
 */
export function parseScope(raw) {
  if (typeof raw !== 'string') return null;
  const match = TURN_ADDRESS_RE.exec(raw);
  return match ? { label: `S${match[1]}`, t: Number(match[2]) } : null;
}

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
 * the fold's lines as foldLines enumerates them — the visible body, then each Residual tool line in
 * `toolPairs` order, contributing tool name, serialized input, serialized result. A Path/Skill pair
 * contributes nothing: its ground truth is the working tree, and exact transcript search covers only
 * the evidence that exists solely in the transcript (ADR 0004).
 *
 * The scan surface is `foldLines`, not a second walk of `fold.toolPairs`: one definition of a line keeps
 * the skeleton and this in step on what a fold contains, pinned by test/turn-query.test.js
 * `search 的扫描面与行枚举同源`. The classifier runs on DEFAULT_CTP; the turn chain never reads the
 * calling session's model.
 */
function canonicalEntities(fold) {
  const entities = [];
  for (const line of foldLines(fold)) {
    if (line.kind === 'visible') {
      if (typeof line.message.text === 'string') entities.push({ text: line.message.text, line: line.t });
      continue;
    }
    // `kind` is ctp-independent, which is what lets this call site fix DEFAULT_CTP while
    // bookmark-detail classifies the SAME pair under ctpForModel(canonical.model): every gate that can
    // return a bucket — the adapter lookup, extractPath, the result block, is_error, and
    // isEffectiveBucketUpdate in lib/tool-outcome.js — inspects STRUCTURE only, while ctp merely
    // scales token values inside an update that is already effective. So the two classifications
    // cannot disagree on which pairs ADR 0004 keeps out of this surface.
    if (classifyToolPair(line.tool, DEFAULT_CTP) !== 'residual') continue;
    // A name and an input are blocks of the tool_use row; a result is its own row; only the visible
    // text sits on the fold's anchor row. This is the one place those differences are resolved, so a
    // hit's `line` always names the row its excerpt is on.
    const useLine = line.tool.useLineOrdinal;
    if (typeof line.tool.name === 'string') entities.push({ text: line.tool.name, line: useLine });
    if (line.tool.input != null) entities.push({ text: stableStringify(line.tool.input), line: useLine });
    const { resultStr } = serializeResult(line.tool.result);
    if (resultStr !== null) entities.push({ text: resultStr, line: line.tool.resultLineOrdinal ?? line.t });
  }
  return entities;
}

/**
 * Is this fold part of the match surface at all? A visible user fold whose cleanUserText projection is
 * ABSORB is `CONTEXT.md` Absorbed Harness Evidence and leaves the transcript only as a note. The
 * judgement is made on the projection, but the surface stays the fold's RAW text — a page-side synthetic
 * join like `/model opus` is therefore not findable while the raw `/model` is.
 */
function isSearchable(fold) {
  if (fold.message && fold.message.role === 'user') return cleanUserText(fold.message.text).kind !== 'ABSORB';
  return true;
}

const isHighSurrogate = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c) => c >= 0xDC00 && c <= 0xDFFF;

/**
 * Cut at most BOOKMARK_PREVIEW_CHARS source characters around one hit. The hit span is contained FIRST
 * and only the remainder is split between the two sides, so a q longer than half the window keeps its
 * own text whole. Ellipsis markers are bare and sit outside those characters, one per elided side.
 */
function excerptAround(entity, hitStart, hitLength) {
  const hitEnd = hitStart + hitLength;
  const remaining = Math.max(0, BOOKMARK_PREVIEW_CHARS - hitLength);
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
 * The sessions to scan, in scan order and parsed no sooner than they are reached.
 * Scopeless: the readable lineage, newest → oldest; a session with no path or no readable transcript is
 * skipped silently — an incomplete scan returns the hits it did reach, pinned by test/turn-query.test.js
 * `不可读会话在无 scope 搜索里被静默跳过`. Scoped: exactly one turn span.
 *
 * `folds` is the scan surface — narrowed to one span under a scope — while `transcript` is always the
 * WHOLE session, because turn membership and active-path positions are properties of the session and
 * not of the surface. `entry` is the lineage entry plus its lineage index, the shape projectSession
 * takes, and it is where the session id and the `S{k}` label are read from.
 */
function* sessionsToScan(lineage, scope, readTranscript) {
  if (scope != null) {
    yield scopedSession(lineage, scope, readTranscript);
    return;
  }
  for (let index = lineage.length - 1; index >= 0; index--) {
    const entry = lineage[index];
    if (!entry.transcriptPath) continue;
    const transcript = readTranscript(entry.transcriptPath);
    if (transcript.status !== 'ok') continue;
    yield { entry: { ...entry, index }, folds: transcript.folds, transcript };
  }
}

/**
 * Resolve `S{k}:{T}` with the existing primitives only: exact label, canonical transcript,
 * enumerateLines → groupTurns, the unique turn at that T. The searchable surface is that turn's whole
 * line span, so every fold from the head U up to (not including) the next HEAD is in scope.
 */
function scopedSession(lineage, scope, readTranscript) {
  const parsed = parseScope(scope);
  if (!parsed) throw scopeNotFound();
  const index = lineage.findIndex(e => e.label === parsed.label);
  const entry = lineage[index];                     // index -1 reads as undefined, which the next line rejects
  if (!entry || !entry.transcriptPath) throw scopeNotFound();
  const transcript = readTranscript(entry.transcriptPath);
  if (transcript.status !== 'ok') throw scopeNotFound();
  // readCanonicalTranscript keeps the active path only, so a T on an abandoned branch — like a T that
  // is not a head U at all — simply has no turn here.
  const turns = groupTurns(enumerateLines(transcript)).filter(turn => turn.t === parsed.t);
  if (turns.length !== 1) throw scopeNotFound();
  const span = new Set(turns[0].lines.map(line => line.t));
  return {
    entry: { ...entry, index },
    folds: transcript.folds.filter(fold => span.has(fold.sourceRef.lineOrdinal)),
    transcript,
  };
}

/**
 * The turn each fold sits in, as a fold anchor → turn head anchor map.
 *
 * The two anchors are different animals. A match's `anchor_uuid` is the MATCHING FOLD's anchor, while a
 * turn_note row is keyed on its turn HEAD's anchor; they coincide only when the literal landed in the
 * head fold, so both grouping and the record join have to go through turn membership. `groupTurns` is the
 * one place that decides membership and it groups the same lines the scan matches on, so every fold
 * anchor a hit can carry is reachable here. Positioning by T instead — the greatest `record.t ≤` the hit
 * fold's T — would MIS-ATTRIBUTE: records exist only for turns that earned a note, so a hit inside an
 * un-noted turn (an `/exit` echo) or inside any turn past the handoff's capture boundary would silently
 * take the previous noted turn's record.
 *
 * Separate from the record lookup below because a session can hold hits and no records at all, and its
 * hits still have to group: grouping needs this map, enrichment needs the other one.
 *
 * @param {object} transcript - One whole canonical transcript, status 'ok'
 * @returns {Map<string, string>}
 */
function turnHeadByFold(transcript) {
  const headByFold = new Map();
  for (const turn of groupTurns(enumerateLines(transcript))) {
    for (const line of turn.lines) headByFold.set(line.anchor, turn.anchorUuid);
  }
  return headByFold;
}

/**
 * One session's persisted Turn Records, keyed by the head anchor a group is keyed on.
 *
 * The transcript is already in hand, so projectSession reads it from here instead of from disk a second
 * time; scan order is unchanged and so is the one-read-per-session the lazy-parsing test pins.
 *
 * @param {object} store
 * @param {object} entry - A lineage entry plus its lineage index, as projectSession takes it
 * @param {object} transcript - That entry's whole canonical transcript, status 'ok'
 * @returns {Map<string, { t: number, u: string, note?: string }>}
 */
function recordByTurnHead(store, entry, transcript) {
  // `t: null` is the unverified address of a session that reads but positions nothing. It can never be
  // rendered into a scope, so it leaves the map rather than being guarded at the point of use.
  const { records } = projectSession(store, entry, () => transcript);
  return new Map(records.filter(r => r.record.t !== null).map(r => [r.anchorUuid, r.record]));
}

// The physical closed interval one fold occupies: its own row, widened by every row its pairs' results
// sit on. Classification is deliberately not consulted — the interval describes the file, and a reader
// given it will see whatever the file holds there regardless of what the search corpus admits.
const foldSpan = (fold) => {
  const own = fold.sourceRef.lineOrdinal;
  let min = own;
  let max = own;
  for (const pair of fold.toolPairs || []) {
    const at = pair.resultLineOrdinal;
    if (at == null) continue;
    if (at < min) min = at;
    if (at > max) max = at;
  }
  return [min, max];
};

/**
 * Exact literal search over the canonical entities of one lineage, grouped by the turn each hit sits in.
 *
 * Scanning runs newest → oldest, and newest → oldest within a session, while the response is one flat
 * `ranges` list in canonical oldest → newest order — turns and, inside each, its matches. A turn carries
 * its address and record ONCE for the whole entry, which is what the grouping buys: a literal matching
 * several folds of one turn would otherwise copy that turn's whole record onto every one of them.
 *
 * Admission stays per MATCH, measured against the grouped wire the retained set would produce — each
 * entry's transcript path included. So the budget spends what grouping saves on reach, while the
 * smallest thing it can drop is one excerpt: the first match that does not fit sets `truncated` and stops
 * everything, with no older match in the current session and no older session opened. Grouping is
 * therefore output shaping, never a unit of admission — which is what keeps a turn holding more matches
 * than the budget can carry from rejecting the whole response. What `truncated` drops is always the
 * oldest, so the OLDEST retained entry is the one that may hold fewer matches than its turn really has.
 * CTP is fixed at DEFAULT_CTP, so one hit set measures the same under load and under HTTP.
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
 * @param {Array<{ label: string, sessionId: string, transcriptPath: string|null }>} args.lineage
 *        Oldest → newest, as lib/lineage.js labels it
 * @param {string} args.q - The literal to find; ASCII case-insensitive, no normalization
 * @param {string|null} [args.scope] - `S{k}:{T}`; restricts the scan to that turn's span, which is also
 *        what leaves its group bare
 * @param {function} [args.readTranscript] - Injected only so lazy parsing is assertable; production
 *        always takes the default reader
 * @returns {{ found: false }|{ found: true, ranges: Array<{ transcript_path: string, scope?: string,
 *          u?: string, note?: string, matches: Array<{ line: number, span: [number, number],
 *          excerpt: string }> }>, truncated: boolean }}
 * @throws An error with `code: 'scope_not_found'` for any `scope` that does not resolve mechanically
 */
export function searchTranscripts({ store, lineage, q, scope = null, readTranscript = readCanonicalTranscript }) {
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
    let byHead = new Map();
    for (const m of matches) {
      if (m.sessionId !== session) { session = m.sessionId; byHead = new Map(); }
      const open = byHead.get(m.head);
      if (open) { open.matches.push(m.wire); continue; }
      const fresh = { label: m.label, record: m.record, transcriptPath: m.transcriptPath, matches: [m.wire] };
      byHead.set(m.head, fresh);
      out.push(fresh);
    }
    return out.map(({ label, record, transcriptPath, matches: inner }) => ({
      // The file whose rows the matches' `line` numbers, carried once for the turn. The session id is
      // not carried beside it: a production transcript is named for its session, so the identity
      // travels inside the path.
      transcript_path: transcriptPath,
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
  for (const { entry, folds, transcript } of sessionsToScan(lineage, scope, readTranscript)) {
    // Per session, so the dedup key is the bare anchor: two sessions may carry the same anchor, and a
    // per-session set keeps them apart without composing a key out of two strings. The key never
    // reaches the wire.
    const seen = new Set();
    // Built on this session's first hit and reused by every later one, so neither pass runs for a session
    // the literal never appears in. Grouping needs the head map; only the address needs projectSession,
    // and a scoped scan needs neither.
    // Deliberately not shared with locateRanges' own per-session memo: that one holds a different
    // projection (the record array plus its anchor index, with no head map) and fills in FTS rank order,
    // where "a session holding only lower-ranked candidates is never opened" is asserted through the
    // injected readTranscript seam. One store across both would let this newest → oldest scan decide
    // whether that assertion's read has already happened.
    let headByFold = null;
    let recordByHead = null;
    for (let i = folds.length - 1; i >= 0; i--) {
      const fold = folds[i];
      if (!isSearchable(fold)) continue;
      // The scan's dedup key is the fold's anchor; the wire's address is the hit's own row.
      const anchorUuid = foldAnchor(fold);
      if (!anchorUuid) continue;
      // Dedup is by fold identity, so two folds sharing one anchor return once — the newest of them,
      // which is the one this scan order reaches first. The anchor stays internal to the scan.
      if (seen.has(anchorUuid)) continue;
      const hit = firstHit(canonicalEntities(fold), needle);
      if (!hit) continue;
      seen.add(anchorUuid);

      // A scoped scan's surface is ONE turn's line span, so it is one entry by construction and needs no
      // membership map; that entry would also hand back the very scope the caller passed in, which is
      // zero information at the cost of the capacity the scope was narrowed to get. Both lookups sit
      // behind this condition, so a scoped scan runs neither pass rather than discarding their results.
      let head = entry.sessionId;
      if (scope == null) {
        headByFold ??= turnHeadByFold(transcript);
        recordByHead ??= recordByTurnHead(store, entry, transcript);
        head = headByFold.get(anchorUuid) ?? anchorUuid;
      }
      const candidate = {
        sessionId: entry.sessionId, label: entry.label, head, record: recordByHead?.get(head) ?? null,
        transcriptPath: entry.transcriptPath,
        wire: { line: hit.line, span: foldSpan(fold), excerpt: excerptAround(hit.text, hit.index, needle.length) },
      };
      if (!isWithinBookmarkBudget(estimateWireTokens(wireOf([...retained, candidate]), DEFAULT_CTP))) {
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
// that is returned for the measurement to mean anything. The path rides on the existing hit branch:
// a context entry is there to be recognized rather than read, and a path repeated down the window
// would spend the candidate capacity the window exists to fill.
const locateEntry = (projected, isHit, transcriptPath) => {
  const { index, record } = projected;
  const wire = { scope: scopeOf(projected), u: record.u };
  if (record.note != null) wire.note = isHit ? record.note : notePreview(record.note);
  if (isHit) {
    wire.hit = true;
    wire.transcript_path = transcriptPath;
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
 * path index across the lineage's sessions. Every candidate is then resolved against the CURRENT
 * transcript before it can be returned — the anchor must sit on the active path, and its runtime line
 * ordinal is the `T` in the returned address. A candidate whose session has no readable transcript,
 * or whose anchor lost the active path, is omitted; no substitute address is invented. So exhausting
 * the candidates without a verified hit is `{ found: false }`, indistinguishable from an FTS miss,
 * and the count of unverifiable candidates never reaches the caller.
 *
 * A verified hit brings up to LOCATE_WINDOW records either side of it, read off its OWN session's
 * projection — which is why a window is short at a session edge rather than continuing into the
 * neighbouring session. Hits and context arrive in one chronological list: `hit: true` marks what
 * matched, its absence marks context, and a record two windows reach appears once, as a hit if any pass
 * selected it. A hit carries its whole note; a context entry carries a preview.
 * A hit also carries the transcript file whose row its `T` names, so the row behind a hit can be
 * read at full length where the entry's `u` is cut; a context entry carries no path.
 *
 * The walk keeps the SQL's global rank order row by row and caches the projection per session — the
 * first time a session is reached it is read once, and the walk stops the moment the fifth hit is
 * verified, so a session that only holds lower-ranked candidates is never opened. It also stops when the
 * accumulated wire would leave the bookmark budget, and that cut is silent: a candidate count is exactly
 * what this shape does not expose. One maximal hit with a full window measures under half the budget, so
 * the cut can never reject a FIRST hit whose note is within `NOTE_TOKEN_LIMIT`.
 *
 * @param {object} args
 * @param {object} args.store - Store instance (turn_note FTS + per-session note reads)
 * @param {Array<{ label: string, sessionId: string, transcriptPath: string|null }>} args.lineage
 *        Oldest → newest, as lib/lineage.js labels it
 * @param {string} args.q - A distinctive literal; whitespace terms stay ANDed and CJK becomes bigrams
 * @param {function} [args.readTranscript] - Injected only so lazy parsing is assertable; production
 *        always takes the default reader
 * @returns {{ found: false }|{ found: true, ranges: Array<{ scope: string, u: string, note?: string,
 *          hit?: true, transcript_path?: string }> }} Oldest → newest, carrying at most
 *          LOCATE_CANDIDATES hits; a hit also carries the transcript file whose row its scope names
 * @throws An error with `code: 'locate_unavailable'` when the turn FTS index cannot answer
 */
export function locateRanges({ store, lineage, q, readTranscript = readCanonicalTranscript }) {
  if (!store.turnFtsAvailable()) throw locateUnavailable();

  const sessions = new Map(lineage.map((entry, index) => [entry.sessionId, { ...entry, index }]));
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
      const { readable, records } = projectSession(store, entry, readTranscript);
      projected.set(entry.sessionId, readable
        ? { records, indexByAnchor: new Map(records.map((r, i) => [r.anchorUuid, i])) }
        : null);
    }
    const session = projected.get(entry.sessionId);
    if (!session) continue;
    const at = session.indexByAnchor.get(row.anchorUuid);
    // Absent ⇒ projectSession dropped an abandoned anchor. Present with `t: null` ⇒ the transcript reads
    // but addresses nothing, so the session projects unverified. Both omitted, never re-addressed.
    if (at === undefined || session.records[at].record.t === null) continue;

    // Copy-on-write: the budget verdict lands on the wire this hit WOULD produce, so this hit and its
    // window may only be committed once that measurement passes.
    const next = new Map(accumulated);
    const first = Math.max(0, at - LOCATE_WINDOW);
    const last = Math.min(session.records.length - 1, at + LOCATE_WINDOW);
    for (let i = first; i <= last; i++) {
      const projected = session.records[i];
      const scope = scopeOf(projected);
      // The hit always writes, and that write IS the upgrade: a record already carried as context gains
      // `hit` and its whole note. Context never overwrites, so nothing is demoted and the first window to
      // reach a record fixes its preview. turn_note is UNIQUE on (source_session_id, anchor_uuid), so no
      // two rows of one walk can claim the same scope as a hit. The decision runs on the key alone, so a
      // record an earlier window already carries is never re-entered and its note is never re-cut.
      if (i === at || !next.has(scope)) next.set(scope, locateEntry(projected, i === at, entry.transcriptPath));
    }

    if (!isWithinBookmarkBudget(estimateWireTokens(locateWire(next), DEFAULT_CTP))) break;
    accumulated = next;
    if (++hits === LOCATE_CANDIDATES) break;
  }

  if (hits === 0) return { found: false };
  return locateWire(accumulated);
}
