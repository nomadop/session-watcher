// lib/turn.js — where a History Turn begins, what it absorbs, and how its text and evidence are stored.
// Pure helpers; no I/O. Consumes the line enumeration (lib/dialogue-fold.js enumerateDialogueLines) as
// data, and the classification of a line as one injected ordered rule list — so no Harness vocabulary,
// tool name or command syntax appears here.
//
// Two independent measurements live here and neither derives from the other: the production skeleton's
// fixed character guardrails (U_HEAD_CHARS / A_CUT_CHARS — they only have to make a turn recognizable;
// ADR 0010 and `CONTEXT.md` Turn Skeleton fix them as guardrails rather than a token budget) and the
// consumer-side token truncation (U_TEXT_TOKENS).
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { enumerateDialogueLines } from './dialogue-fold.js';
import { cjkBigrams } from './handoff.js';
import { stableStringify } from './dialogue-tool.js';
import { safePrefix, safeSuffix, truncateToTokens, truncationMarker } from './turn-history-budget.js';
import { DEFAULT_CTP } from './constants.js';

// ── Sizing constants ───────────────────────────────────────────────────────────

export const U_HEAD_CHARS = 200;
// One value for both sampled assistant cuts: the first message's head and the last one's tail.
export const A_CUT_CHARS = 128;
// Deduplicated basenames shown on a turn's aggregate row before the remainder is counted.
export const AGG_PATH_CAP = 6;
export const U_TEXT_TOKENS = 200;

// ── The `S{k}:{T}` address grammar and the page's `before` grammar ─────────────

export const TURN_ADDRESS_RE = /^S(\d+):(\d+)$/;

// The one rendering of the address that RE above parses, kept beside it because the two are a contract:
// the address travels between three tools as a caller-supplied argument, and a producer that spells the
// form itself can drift from the parser with nothing to catch it — the parser's own tests keep passing on
// strings the parser wrote.
export const turnAddress = (label, sourceOrdinal) => `${label}:${sourceOrdinal}`;

/**
 * Parse an `S{k}:{T}` address, or null for every other shape. The parser accepts no lineage: a caller
 * resolves the label against its own Applicable Lineage and keeps its own error behavior.
 *
 * @param {*} raw
 * @returns {{ label: string, sourceOrdinal: number }|null}
 */
export function parseTurnAddress(raw) {
  if (typeof raw !== 'string') return null;
  const match = TURN_ADDRESS_RE.exec(raw);
  return match ? { label: `S${match[1]}`, sourceOrdinal: Number(match[2]) } : null;
}

// The page's `before` grammar: the address above extended with a bare label, which selects the session's end.
// `resolveBefore` parses through it and `turn_page`'s schema validates against it.
export const TURN_PAGE_BOUNDARY_RE = /^S(\d+)(?::(\d+))?$/;

/**
 * Parse a page boundary, or null for every other shape. `sourceOrdinal` is null for a bare label, which is
 * what distinguishes "this session's end" from "ahead of this turn". The parser accepts no lineage: a
 * caller resolves the label against its own Applicable Lineage and keeps its own error behavior.
 *
 * @param {*} raw
 * @returns {{ label: string, sourceOrdinal: number|null }|null}
 */
export function parseTurnPageBoundary(raw) {
  if (typeof raw !== 'string') return null;
  const match = TURN_PAGE_BOUNDARY_RE.exec(raw);
  if (!match) return null;
  return { label: `S${match[1]}`, sourceOrdinal: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * The transient `S{k}` view of one Applicable Lineage: position supplies the label, so nothing is stored
 * and every Turn History consumer derives the same mapping from the same order.
 *
 * @param {Array<{ sessionId: string, sourceLocator: *, sourceLabel: *, handoffId: number|null }>} lineage
 *        Oldest → newest, as lib/lineage.js returns it
 * @returns {Array<object>} the same entries plus their `label` and lineage `index`
 */
export function labelHistorySources(lineage) {
  return lineage.map((entry, index) => ({ ...entry, label: `S${index + 1}`, index }));
}

/**
 * Read one History Source and project it: the single composition of a DialogueSource read, the Harness
 * Adapter's Dialogue projection and its Turn grouping. `sourceLocator` travels straight to the Adapter's
 * `read` and is interpreted nowhere here, and an unavailable read degrades to an unreadable, empty
 * projection rather than an exception — every consumer decides for itself what an unreadable Source means.
 *
 * @param {{ dialogueSource: object, dialogueProjection: object }} history
 * @param {*} sourceLocator - opaque; captured by the caller before the read
 * @returns {{ readable: boolean, folds: object[], turns: object[] }}
 */
export function readHistorySource({ dialogueSource, dialogueProjection }, sourceLocator) {
  const read = dialogueSource.read(sourceLocator);
  if (read.status !== 'ok') return { readable: false, folds: [], turns: [] };
  const { folds } = dialogueProjection.project(read.observations);
  return { readable: true, folds, turns: dialogueProjection.groupTurns(enumerateDialogueLines(folds)) };
}

// ── History Turn rules ─────────────────────────────────────────────────────────

// A rule that owns nothing on this line. Frozen and shared so a caller can compare identity as well as
// discriminant, and so no rule can mutate the value every other rule returns.
export const PASS = Object.freeze({ kind: 'PASS' });

// This line belongs to the Turn already open. Carries no text: an absorbed line's projection is empty by
// construction, and the skeleton renders such a line from its source text instead.
export const ABSORB = Object.freeze({ kind: 'ABSORB' });

/**
 * Classify one line through an ordered rule list. The first non-PASS result wins, so a rule that owns a
 * line shape shadows every later rule for that shape; rules return a classification and a text and
 * nothing else, and the Turn Head constructor below copies every source fact from the winning line.
 *
 * @param {object} line - one element of enumerateDialogueLines
 * @param {Array<function>} rules - fixed at composition; order is part of the contract
 * @returns {{ kind: 'PASS'|'ABSORB'|'ACK'|'HEAD', text?: string }}
 */
export function applyHeadRules(line, rules) {
  for (const rule of rules) {
    const result = rule(line);
    if (result.kind !== 'PASS') return result;
  }
  return PASS;
}

/**
 * Divide the enumerated lines into Turns. Every line after the first head lands in exactly one span: a
 * head opens a new Turn, everything after it is absorbed into that Turn until the next head. Lines before
 * the first head belong to no span and are dropped — synthesizing one would manufacture an identity the
 * write path then persists.
 *
 * A head line never counts as its own Turn's assistant activity, and an `ACK` Turn accumulates none at
 * all: it is the harness acknowledging its own local command, so a note for it could only ever restate
 * "took no action". Such a Turn keeps its lines and still persists a Turn Record, so the boundary stays
 * visible; it just never earns a NOTE slot. The suppression sits at this one gate, which `buildSkeleton`
 * and `slotKeysOf` both read through `hasAssistantActivity`: a slot the skeleton prints while the slot set
 * omits it would land the producer's note inside the PREVIOUS slot's body, since a non-slot heading is
 * body text to `parseNoteSections`.
 *
 * @param {object[]} lines - output of enumerateDialogueLines
 * @param {Array<function>} rules - the composition's ordered History Turn rules
 * @returns {Array<{ sourceOrdinal: number, sourceEntryId: string|null, timestamp: number|null,
 *            cleanedU: string, classification: 'HEAD'|'ACK', lines: object[],
 *            hasAssistantActivity: boolean }>} Turns in canonical order
 */
export function groupTurns(lines, rules) {
  const turns = [];
  for (const line of lines) {
    const result = applyHeadRules(line, rules);
    if (result.kind === 'HEAD' || result.kind === 'ACK') {
      turns.push({
        sourceOrdinal: line.sourceOrdinal,
        sourceEntryId: line.sourceEntryId,
        timestamp: line.timestamp,
        cleanedU: result.text,
        classification: result.kind,
        lines: [line],
        hasAssistantActivity: false,
      });
      continue;
    }
    if (turns.length === 0) continue;          // 第一个 head 之前的行不属于任何 turn
    const turn = turns[turns.length - 1];
    turn.lines.push(line);
    if (turn.classification !== 'ACK'
        && (line.kind === 'tool' || (line.kind === 'visible' && line.message.role === 'assistant'))) {
      turn.hasAssistantActivity = true;
    }
  }
  return turns;
}

// ── Production capture: skeleton + snapshot fingerprint ────────────────────────

// Both guardrails cut through the safe UTF-16 slices, so a boundary that lands inside a surrogate pair
// backs off instead of emitting a lone half. The marker is bare here: this is the `CONTEXT.md` Turn
// Skeleton, while the counted form is rendered by truncationMarker and reaches the consumer pages —
// projectTurnRecord appends it for Turn Page Operation, notePreview for History Range Location.
// test/turn.capture.test.js `骨架省略` pins the bare form.
const headCut = (s, n) => (s.length > n ? safePrefix(s, n) + '…' : s);
const tailCut = (s, n) => (s.length > n ? '…' + safeSuffix(s, n) : s);

/**
 * Render the capture skeleton the note producer writes into: one block per captured turn, whose rows each
 * repeat an absolute T — every row its own line's source ordinal, which for a ratified ask head is the
 * asking call's row — closed by an aggregate row and a labelled NOTE slot where the turn carries assistant
 * activity. A genuinely note-less turn gets no slot at all, so the slot set is the submission's key set.
 * Assistant text is SAMPLED by message, never projected per message (ADR 0010).
 *
 * It invokes no History Turn rule: the head row renders `turn.cleanedU`, which the winning rule already
 * produced, and every absorbed human line renders its source text — an absorbed line's projection is
 * empty by construction, so rendering the projection would make an interrupt or a local command's output
 * vanish from the skeleton while its turn still claims those physical lines.
 *
 * @param {object[]} turns - groupTurns output, current handoff turn already excluded
 * @param {string} sessionId - the capturing session, rendered in the epoch header
 * @returns {string} Epoch header, then one block per turn, blocks separated by a blank line
 */
export function buildSkeleton(turns, sessionId) {
  const head = `CONTEXT EPOCH  session ${sessionId}   turns ${turns.length}`;
  const blocks = turns.map(turn => {
    // Sampling decides on MESSAGES, so the indices are taken before any row is rendered: with two or
    // more the first is head-cut and the last tail-cut, and with one the single message is still the
    // last — its tail carries the conclusion, while its opening restates a U the head row already has.
    const assistantIdx = turn.lines.reduce((acc, line, i) => {
      if (i > 0 && line.kind !== 'tool' && line.message?.role !== 'human') acc.push(i);
      return acc;
    }, []);
    const shown = new Set(assistantIdx.length > 1
      ? [assistantIdx[0], assistantIdx[assistantIdx.length - 1]]
      : assistantIdx);
    const headCutAt = assistantIdx.length > 1 ? assistantIdx[0] : -1;

    let toolCalls = 0;
    const basenames = new Set();
    const rows = turn.lines.flatMap((line, i) => {
      const t = String(line.sourceOrdinal).padStart(4);
      // The turn's head is lines[0] by construction. A tool line in that position is a ratified ask whose
      // answer IS this turn's U, already projected into cleanedU — rendering it a second time would put
      // one physical line in two contradictory roles, and would make every such turn claim assistant
      // activity it never had. It is not a call the aggregate row counts.
      if (i === 0) {
        const normalized = turn.cleanedU.replace(/\r\n?/g, '\n');
        return headCut(normalized, U_HEAD_CHARS).split('\n').map(part => `T ${t} | U   : ${part}`);
      }
      if (line.kind === 'tool') {
        // Aggregated, never one row per call: every resolved path reaches the index through
        // buildSearchTerms with or without the skeleton, so the row carries recognition only.
        toolCalls++;
        if (line.tool.resourceKey) basenames.add(basename(line.tool.resourceKey));
        return [];
      }
      if (line.message.role !== 'human' && !shown.has(i)) return [];
      const role = line.message.role === 'human' ? 'U  ' : 'A  ';
      // Normalize to '\n' FIRST, then cut. Cutting first spends the guardrail on carriage returns that
      // are about to collapse, so CRLF-heavy text keeps fewer than U_HEAD_CHARS / A_CUT_CHARS normalized
      // characters. The split below frames every physical line with its own repeated role marker, the
      // same framing `CONTEXT.md` Turn Page Operation fixes for the page.
      const normalized = String(line.message.text).replace(/\r\n?/g, '\n');
      const text = line.message.role === 'human'
        ? headCut(normalized, U_HEAD_CHARS)
        : (i === headCutAt ? headCut(normalized, A_CUT_CHARS) : tailCut(normalized, A_CUT_CHARS));
      return text.split('\n').map(part => `T ${t} | ${role} : ${part}`);
    });
    if (turn.hasAssistantActivity) {
      const names = [...basenames];
      const shownNames = names.slice(0, AGG_PATH_CAP).join(',');
      const more = names.length > AGG_PATH_CAP ? ` +${names.length - AGG_PATH_CAP}` : '';
      const tools = toolCalls === 0 ? ''
        : ` · ${toolCalls} tools${shownNames ? `: ${shownNames}${more}` : ''}`;
      rows.push(`${' '.repeat(6)}| A×${assistantIdx.length}${tools}`);
      rows.push(`${' '.repeat(6)}| NOTE[${turn.sourceOrdinal}]: ____`);
    }
    return rows.join('\n');
  });
  return [head, ...blocks].join('\n\n');
}

// ── notes document grammar ─────────────────────────────────────────────────────

// The delimiter is a whole line and nothing else, which is what makes a note's own prose harmless: a
// body may contain `NOTE[9]:`, a `|` row, colons and newlines and still belong to one slot. Exactly
// two hashes — a deeper heading is a note's own subheading and stays in the body. The server writes one
// form; the reader tolerates trailing whitespace and a label spelled with other digits for the same
// value, because a heading that fails to match is not reported — it becomes body text a note absorbs.
const NOTE_SECTION_RE = /^## NOTE\[(\d+)\]\s*$/;

// What get_turn_skeleton answers with. It states the mechanism as well as the step, because a bare
// instruction to use Edit does not tell the producer why a whole-file Write is destructive here.
export const TURN_NOTE_PROTOCOL =
  'Read skeleton_path, then write one note into each `## NOTE[T]` section of notes_path. The headings '
  + 'are already written; put each note under its own heading and leave the heading lines exactly as '
  + 'they are. On a first pass one Write of the whole file is enough. After a re-fetch, Edit the empty '
  + 'sections instead — a whole-file Write would replace notes that file already holds. Then call '
  + 'submit_turn_notes with snapshot_id alone: it reads notes_path itself and accepts no note text.';

/**
 * The notes document for one slot set — headings one blank line apart, each carrying the body supplied
 * for its key. A key with no body gets its heading alone.
 *
 * @param {string[]} slotKeys - NOTE slot T values as strings, in the order they should appear
 * @param {Map<string, string>} [bodies] - Body per slot key, for a slot whose note is already known
 * @returns {string} '' for an empty slot set
 */
export function renderNoteSections(slotKeys, bodies) {
  return slotKeys.map(key => {
    const body = bodies?.get(key);
    return body ? `## NOTE[${key}]\n\n${body}\n` : `## NOTE[${key}]\n`;
  }).join('\n');
}

/**
 * The slot set of one capture, in canonical turn order. One gate — `hasAssistantActivity` — decides
 * both that buildSkeleton renders a NOTE slot and that a submission must carry a note, so the notes
 * file's heading set and the submission's required key set cannot drift apart.
 *
 * @param {object[]} turns - groupTurns output, current handoff turn already excluded
 * @returns {string[]} T values as strings, matching the labels buildSkeleton emits
 */
export function slotKeysOf(turns) {
  return turns.filter(turn => turn.hasAssistantActivity).map(turn => String(turn.sourceOrdinal));
}

/**
 * Split a notes document into one body per slot. Prose ahead of the first heading belongs to no slot
 * and is dropped: a mangled first heading therefore surfaces as that slot's missing note rather than
 * as a second failure class of its own. Every issue carries a numeric `t`, so the submission's issue
 * list has one shape whether the fault is in the file's structure or in a note's content.
 *
 * A section boundary is a function of the CAPTURE, not of the file alone: only a current slot's heading
 * delimits one, so the same bytes yield different sections to different captures.
 *
 * @param {string|null} text - File contents, or null when the file does not exist
 * @param {string[]} slotKeys - This capture's slot keys, from slotKeysOf; the only headings that delimit
 * @returns {{ sections: Map<string, string>, issues: {t: number, message: string}[] }}
 */
export function parseNoteSections(text, slotKeys) {
  const slots = new Set(slotKeys);
  const sections = new Map();
  const issues = [];
  if (text == null) return { sections, issues };
  let current = null;
  let buffer = [];
  const close = () => { if (current != null) sections.set(current, buffer.join('\n').trim()); };
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const match = NOTE_SECTION_RE.exec(line);
    // The label is read as the number it is, so a zero-padded `## NOTE[…]` addresses the slot its digits
    // denote rather than a key that matches no slot while leaving that slot unfilled.
    const key = match ? String(Number(match[1])) : null;
    // ONLY a current slot's heading delimits a section; anything else is body text, `null` key included
    // (`slots.has(null)` is false). The capture decides what a section is, the same way it decides which
    // headings get prewritten, so the producer cannot invent a delimiter any more than it can invent a
    // slot. That one rule carries three faults: a note whose prose holds a `## NOTE[N]` line keeps its
    // tail instead of committing truncated; a heading a rewind orphaned cannot smuggle a note onto a turn
    // this capture has no slot for; and every issue's `t` is a real turn ordinal rather than whatever
    // digits the file happened to carry.
    //
    // The bytes are never rewritten, but a re-read is not a round trip: new headings are appended at the
    // END of the file, so a slot returning after an interval finds its body extended by whatever headings
    // arrived meanwhile. An orphan's text is preserved, not restored unchanged.
    if (!slots.has(key)) { if (current != null) buffer.push(line); continue; }
    close();
    if (sections.has(key)) issues.push({ t: Number(key), message: 'duplicate NOTE section for this T' });
    current = key;
    buffer = [];
  }
  close();
  return { sections, issues };
}

/**
 * Content fingerprint of one capture, used to detect that the boundary moved between reading the
 * skeleton and submitting notes. It covers what the producer actually saw — the turn set, each turn's
 * source identity, time and projected intent, and every line's role, source text and resolved resource
 * key.
 *
 * Not in the digest: the session id, or the capture boundary — so the fingerprint promises no
 * cross-session uniqueness. The epoch key's identity half IS covered, since every turn's `sourceEntryId`
 * is, `turns[0]`'s included; that is what makes a matching fingerprint a guarantee that submission reads
 * the same notes file the fetch named. A tool line's `resourceKey` is the Adapter's own resolution, so
 * the digest covers the same path cue the skeleton and search_terms carry without resolving one here.
 *
 * @param {object[]} turns - The captured turns, in canonical order
 * @returns {string} sha256 hex
 */
export function snapshotDigest(turns) {
  const canonical = turns.map(turn => ({
    t: turn.sourceOrdinal, anchor: turn.sourceEntryId, ts: turn.timestamp, u: turn.cleanedU,
    lines: turn.lines.map(l => l.kind === 'tool'
      ? { k: 't', a: l.sourceEntryId, n: l.tool.name, p: l.tool.resourceKey ?? null }
      : { k: 'v', a: l.sourceEntryId, r: l.message.role, x: l.message.text }),
  }));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

/**
 * The stored form of one turn's user text. uOriginalChars is the CLEANED length in UTF-16 code
 * units — the same unit as uText.length, so truncation is derivable (uOriginalChars > uText.length)
 * instead of persisted as its own flag.
 *
 * @param {string} cleanedU - the winning rule's projection
 * @returns {{ uText: string, uOriginalChars: number }}
 */
export function storedUText(cleanedU) {
  return { uText: truncateToTokens(cleanedU, U_TEXT_TOKENS, DEFAULT_CTP), uOriginalChars: cleanedU.length };
}

// ── search_terms projection ────────────────────────────────────────────────────

/**
 * The FTS side-channel for one stored turn: CJK bigrams of the human-written text plus the resource keys
 * the turn's tools touched. Resource keys only — a tool NAME is never a search term.
 *
 * Two CJK definitions coexist in this file and are NOT interchangeable: cjkBigrams' own ranges cut
 * the index, while the token estimator's ranges drive `storedUText`'s accounting. A query reaches this
 * column through buildFtsMatch, which tokenizes with cjkBigrams too — that pairing is what makes CJK
 * searchable.
 *
 * The key is the Adapter's own resolution, attached to the paired line: nothing here resolves a native
 * input, so the skeleton's basenames, the snapshot digest and this index all read one projection of one
 * relative tool path.
 *
 * @param {{ uText: string, note: string|null, turn: { lines: object[] } }} args
 * @returns {string} Space-joined terms; '' when the turn has neither CJK text nor a resolved key
 */
export function buildSearchTerms({ uText, note, turn }) {
  const bigrams = cjkBigrams(`${uText}\n${note ?? ''}`);
  const keys = new Set();
  for (const line of turn.lines) {
    if (line.kind !== 'tool') continue;
    if (line.tool.resourceKey) keys.add(line.tool.resourceKey);
  }
  return [bigrams, ...keys].filter(Boolean).join(' ');
}

// ── Turn Record projection ─────────────────────────────────────────────────────

/**
 * The one Turn Record projection, shared by the page and by locate so neither grows its own.
 *
 * `t: null` means one thing only: **there is no readable Source to position against** — no `ordinals`
 * map, or an empty one. That is the null `T` address of `CONTEXT.md` Unverified Turn Record. An identity
 * missing from a NON-EMPTY map is an **abandoned** turn (its branch lost the active path), and the caller
 * **excludes** that row rather than rendering it, which is what keeps `t: null` carrying its single
 * meaning.
 *
 * @param {{ anchorUuid: string, uText: string, uOriginalChars: number, note: string|null }} row
 * @param {Map<string, number>|null} [ordinals] - head sourceEntryId → source ordinal, from
 *        activePathOrdinals
 * @returns {{ t: number|null, u: string, note?: string }} note is absent, not null, for a NULL note
 */
export function projectTurnRecord(row, ordinals) {
  const t = ordinals ? (ordinals.get(row.anchorUuid) ?? null) : null;
  const suffix = row.uOriginalChars > row.uText.length ? truncationMarker(row.uOriginalChars) : '';
  const out = { t, u: row.uText + suffix };
  if (row.note != null) out.note = row.note;
  return out;
}

/**
 * Turn-head `sourceEntryId` → that Turn's source ordinal for one Source. Built from the COMPLETE
 * multi-epoch projection: that keeps every compact epoch and drops abandoned sibling branches, which is
 * exactly the active path a stored `anchor_uuid` has to be checked against. `CONTEXT.md` Transcript Line
 * Ordinal (T) assigns an ordinal before any branch selection, so this map is where the branch judgement
 * lands. The production capture side selects the current-epoch suffix instead — the two modes serve
 * different questions.
 *
 * Derived from grouped Turns rather than from folds so that a Turn has one address everywhere: the page,
 * the scope a query resolves, and the skeleton's NOTE slot all read the ordinal `groupTurns` assigns,
 * which for a ratified ask is the question's own tool-use row.
 *
 * @param {object[]} turns - groupTurns output over the whole projection
 * @returns {Map<string, number>} First occurrence wins
 */
export function activePathOrdinals(turns) {
  const map = new Map();
  for (const turn of turns) {
    if (turn.sourceEntryId && !map.has(turn.sourceEntryId)) map.set(turn.sourceEntryId, turn.sourceOrdinal);
  }
  return map;
}
