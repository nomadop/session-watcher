// lib/turn.js — where a turn begins, what it absorbs, and how its user text is stored.
// Pure helpers; no I/O. Consumes the line enumeration (lib/dialogue-fold.js enumerateLines) as data.
//
// Two independent measurements live here and neither derives from the other: the production
// skeleton's fixed character guardrails (U_HEAD_CHARS / A_CUT_CHARS — they only have to make a turn
// recognizable; ADR 0010 and `CONTEXT.md` Turn Skeleton fix them as guardrails rather than a token
// budget) and the consumer-side token truncation (U_TEXT_TOKENS).
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CJK_RE, countsToTokens } from './measure.js';
import { safePrefix, safeSuffix, truncationMarker } from './bookmark-core.js';
import { cjkBigrams } from './handoff.js';
import { resolveToolUse } from './tool-outcome.js';
import { stableStringify } from './bookmark-detail.js';
import { enumerateLines, foldAnchor } from './dialogue-fold.js';
import { DEFAULT_CTP } from './constants.js';

// ── Sizing constants ───────────────────────────────────────────────────────────

export const U_HEAD_CHARS = 200;
// One value for both sampled assistant cuts: the first message's head and the last one's tail.
export const A_CUT_CHARS = 128;
// Deduplicated basenames shown on a turn's aggregate row before the remainder is counted.
export const AGG_PATH_CAP = 6;
export const U_TEXT_TOKENS = 200;

// The one `S{k}:{T}` address grammar. The page's `before` cursor, the query module's `scope` and
// locate's emitted `scope` all address the same coordinates, so they read one regex. Non-global, so
// there is no shared lastIndex between callers.
export const TURN_ADDRESS_RE = /^S(\d+):(\d+)$/;

// The one rendering of the address that RE above parses, kept beside it because the two are a contract:
// the address travels between three tools as a caller-supplied argument, and a producer that spells the
// form itself can drift from the parser with nothing to catch it — the parser's own tests keep passing on
// strings the parser wrote.
export const turnAddress = (label, t) => `${label}:${t}`;

// ── cleaning projection ────────────────────────────────────────────────────────

// Wrapper blocks that carry no human intent of their own; removing them leaves the residue.
const TAG_BLOCKS = /<(command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+)>[\s\S]*?<\/\1>/g;
// The wrapped fragments that DO carry intent and are re-emitted as segments.
const CAPTURE = /<(command-name|command-args|bash-input)>([\s\S]*?)<\/\1>/g;
// CC's own echo of the session-ending local command — see the gate in `groupTurns`.
const EXIT_ECHO = '<command-name>/exit</command-name>';

/**
 * Project one raw human message onto its cleaned intent, and judge whether it opens a turn.
 * ABSORB means "this line belongs to the turn already open"; HEAD means "a new turn starts here".
 * The judgement is made on the residue, never on the mere presence of a tag — a message that
 * quotes `<command-name>` inside its prose is a real question and keeps its full text.
 *
 * @param {string} rawText - The visible text of a user line
 * @returns {{ kind: 'HEAD'|'ABSORB', cleaned: string }} cleaned is '' for every ABSORB class
 */
export function cleanUserText(rawText) {
  let s = String(rawText || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  const captured = [];
  for (const m of s.matchAll(CAPTURE)) captured.push({ tag: m[1], text: m[2].trim() });
  const residue = s.replace(TAG_BLOCKS, '').trim();

  if (/^\[Request interrupted/.test(residue)) return { kind: 'ABSORB', cleaned: '' };
  if (!residue && captured.length === 0) return { kind: 'ABSORB', cleaned: '' };
  const segments = [];
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    if (c.tag === 'command-name') {
      const next = captured[i + 1];
      if (next && next.tag === 'command-args' && next.text) { segments.push(`${c.text} ${next.text}`); i++; }
      else segments.push(c.text);
    } else if (c.tag === 'bash-input') segments.push(`!${c.text}`);
  }
  if (residue) segments.push(residue);
  const cleaned = segments.filter(Boolean).join(' — ');
  // Nothing survived the projection (args with no name, an empty command name): there is no intent to
  // open a turn on, so it absorbs. Judged on the projection, symmetrically for every such shape.
  if (!cleaned) return { kind: 'ABSORB', cleaned: '' };
  return { kind: 'HEAD', cleaned };
}

// ── AskUserQuestion head projection — the second shape that opens a turn ───────

// A ratified answer never reaches the transcript as a visible user line: it arrives as a
// tool_result block on a `type:"user"` row, which materializeDialogue folds into the ASKING
// assistant's own fold as a tool pair. The anchor that fold yields is NOT always the sourceRef.uuid
// fallback: a fold groups every row sharing one message.id, and while the row carrying the ask block
// never carries text, ask folds that have a visible assistant message answer with its anchor instead.
// Neither form is contended — only a visible USER line and a ratified ask tool line open turns,
// so no Turn Record ever claims an assistant anchor.
export const ASK_TOOL_NAME = 'AskUserQuestion';

// The degradation cut is bounded at BOTH ends on purpose. A changed structure is exactly the case
// where we no longer know where the ratification sits in the string, and today it sits at the tail
// (`"Q"="A"` after a fixed prefix) — a head-only cut of ASK_FALLBACK_HEAD loses it; bounding the
// tail at ASK_FALLBACK_TAIL keeps it.
export const ASK_FALLBACK_HEAD = 200;
export const ASK_FALLBACK_TAIL = 200;

/**
 * Project one tool line onto its ratified intent, and judge whether it opens a turn. The sibling of
 * cleanUserText: same return shape, same rule that the judgement is made on the PROJECTION and
 * never on the presence of a marker.
 *
 * @param {object} tool - One toolPairs entry, as carried on a `kind:'tool'` line
 * @returns {{ kind: 'HEAD'|'ABSORB', cleaned: string }} cleaned is '' for every ABSORB class
 */
export function cleanAskAnswer(tool) {
  if (!tool || tool.name !== ASK_TOOL_NAME) return { kind: 'ABSORB', cleaned: '' };
  // A question the human dismissed with ESC, or one whose arguments failed validation, carries no
  // ratification at all — it is `CONTEXT.md` Absorbed Harness Evidence, the same class as [Request
  // interrupted]. Measured: is_error===true holds on exactly the 44 of 468 live result rows that have
  // no readable answers, with zero exceptions in either direction (468 = 424 readable + 44 error).
  if (tool.isError === true) return { kind: 'ABSORB', cleaned: '' };
  const structured = projectAskAnswers(tool.resultMeta?.raw);
  // A READABLE structure is authoritative even when it projects to nothing; only an unreadable one
  // degrades to the raw string. Otherwise a deliberately empty answer would resurrect the envelope.
  const cleaned = structured.readable ? structured.cleaned : askFallbackCut(tool.result);
  if (!cleaned) return { kind: 'ABSORB', cleaned: '' };
  return { kind: 'HEAD', cleaned };
}

// The structured path. `header` is a required field of the tool's schema and is the label the human
// saw on the chip, so it identifies the question in a fraction of its bytes (measured p50 5 / max 21
// chars against p50 62 / max 910 for the question text). `annotations[q].notes` is where the picker
// records prose the human typed instead of choosing, and without it `answers` degrades to a literal
// placeholder on 33 of 424 live rows — the richest ones. The placeholder is NOT stripped: matching
// its wording is the prose dependency this whole projection exists to avoid, and 12 wasted
// characters cost less than a silent loss when that wording changes.
function projectAskAnswers(raw) {
  const answers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.answers : null;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { readable: false, cleaned: '' };
  const headers = new Map();
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    if (q && typeof q === 'object' && q.question != null) headers.set(String(q.question), q.header);
  }
  const segments = [];
  for (const [question, answer] of Object.entries(answers)) {
    const label = headers.get(question) ?? question;
    const notes = raw.annotations?.[question]?.notes;
    const body = notes ? `${answer} · ${notes}` : String(answer);
    segments.push(`${label} → ${body}`);
  }
  return { readable: true, cleaned: segments.join(' — ').trim() };
}

// The degradation. It parses NOTHING: no prefix match, no trailing-sentence strip, no field name —
// so its only failure mode is an ugly line, never a silent empty one. Newlines are unified first so
// the cut spends its budget on characters that survive — the same order the skeleton's cuts use.
function askFallbackCut(result) {
  const s = String(result ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  if (s.length <= ASK_FALLBACK_HEAD + ASK_FALLBACK_TAIL) return s;
  return safePrefix(s, ASK_FALLBACK_HEAD) + '…' + safeSuffix(s, ASK_FALLBACK_TAIL);
}

// ── Span grouping ──────────────────────────────────────────────────────────────

/**
 * The head judgement for ONE line — the single place that decides whether a line opens a turn and
 * what identity that turn carries. A `CONTEXT.md` History Turn opens on a genuine user intent, and
 * two shapes carry one: a visible user line whose cleanUserText projection survives, and a tool line
 * carrying a ratified AskUserQuestion answer.
 *
 * Both shapes take the anchor from `line.anchor`, the value foldAnchor already computed: for a
 * visible line that IS `message.anchorUuid`, and for a message-less fold it is the `sourceRef.uuid`
 * fallback. One read, one definition.
 *
 * The ROW and the TIMESTAMP are where the two shapes differ, and that asymmetry is load-bearing. A
 * visible line is its own row, so it dates itself and addresses itself. A ratified answer is folded
 * into the asking message's fold, whose anchor row is that message's first visible-text row where it
 * has one, so the turn takes its `t` from the tool_use row the question was written on and its
 * timestamp from the ANSWERING row, because that is when the decision was actually made. Nothing in the
 * turn chain computes on source_timestamp, so the split costs no invariant.
 *
 * @param {{ t, kind, anchor, message, tool }} line - One element of enumerateLines
 * @returns {{ t: number, cleanedU: string, anchorUuid: string, anchorTimestamp: number|null }|null}
 *          null when the line opens no turn
 */
function headOf(line) {
  if (line.kind === 'visible' && line.message.role === 'user') {
    const cleaned = cleanUserText(line.message.text);
    if (cleaned.kind !== 'HEAD') return null;
    return {
      t: line.t,
      cleanedU: cleaned.cleaned,
      anchorUuid: line.anchor,
      anchorTimestamp: line.message.anchorTimestamp,
    };
  }
  if (line.kind === 'tool') {
    const cleaned = cleanAskAnswer(line.tool);
    if (cleaned.kind !== 'HEAD') return null;
    // The question is asked on the tool_use row, not on the fold's anchor row that the enumerated
    // line carries as `t`: T is what grep -n prints for the row the reader opens.
    return {
      t: line.tool.useLineOrdinal,
      cleanedU: cleaned.cleaned,
      anchorUuid: line.anchor,
      anchorTimestamp: line.tool.resultMeta?.timestamp ?? null,
    };
  }
  return null;
}

/**
 * Divide the enumerated lines into turns. Every line after the first head lands in exactly one
 * span: a head opens a new turn, everything after it is absorbed into that turn until the next head.
 * Lines before the first head belong to no span and are dropped — synthesizing one would manufacture
 * an anchor the write path then persists.
 *
 * A head line never counts as its own turn's assistant activity. For a ratified answer that means a
 * run of consecutive questions yields turns with no NOTE slot, and `CONTEXT.md` Turn Record persists
 * each of those with a null note: the assistant genuinely did nothing there but ask the next
 * question, and that next question is the following turn's own U row.
 *
 * @param {{ t, kind, anchor, message, tool }[]} lines - Output of enumerateLines
 * @returns {{ t: number, anchorUuid: string, anchorTimestamp: number|null, cleanedU: string,
 *            lines: object[], hasAssistantActivity: boolean }[]} Turns in canonical order
 */
export function groupTurns(lines) {
  const turns = [];
  // CC writes the `/exit` echo into the transcript it is about to abandon, and on the resume path back
  // into that same file it appends an `assistant: "No response requested."` parented to the echo's
  // stdout line — so that reply lands inside the `/exit` turn. It is the harness acknowledging its own
  // local command, not this turn's assistant contribution, and a note for it can only ever restate
  // "took no action". The turn keeps its lines and still persists a row, so the restart stays visible as
  // a boundary exactly as the `/clear` echo turn is; it just never earns a NOTE slot. Suppressed at the
  // one gate `buildSkeleton` and `slotKeysOf` both read: a slot the skeleton prints while the slot set
  // omits it would land the producer's note inside the PREVIOUS slot's body, since a non-slot heading is
  // body text to `parseNoteSections`. The conjunction is what makes it the echo rather than the string:
  // `cleanedU` excludes human prose that quotes the tag (that prose keeps residue), and the raw tag
  // excludes a human message whose whole body is literally `/exit`. The kind test leads because a `tool`
  // head — a ratified ask — has no `message` to read at all, and its degraded projection can be any
  // envelope text including this one.
  let harnessEcho = false;
  for (const line of lines) {
    const head = headOf(line);
    if (head) {
      harnessEcho = line.kind === 'visible' && head.cleanedU === '/exit'
        && String(line.message.text).includes(EXIT_ECHO);
      turns.push({ ...head, lines: [line], hasAssistantActivity: false });
      continue;
    }
    if (turns.length === 0) continue;          // 第一个 head 之前的行不属于任何 turn
    const cur = turns[turns.length - 1];
    cur.lines.push(line);
    if (!harnessEcho && (line.kind === 'tool' || (line.kind === 'visible' && line.message.role === 'assistant'))) {
      cur.hasAssistantActivity = true;
    }
  }
  return turns;
}

// ── Production capture: skeleton + snapshot fingerprint ────────────────────────

// Both guardrails cut through the safe UTF-16 slices, so a boundary that lands inside a surrogate pair
// backs off instead of emitting a lone half. The marker is bare here: this is the `CONTEXT.md` Turn
// Skeleton, while the counted form is rendered by truncationMarker and reaches the consumer pages —
// projectTurnRecord appends it for Turn Page Operation, notePreview for History Range Location.
// test/turn.test.js `骨架省略` pins the bare form.
const headCut = (s, n) => (s.length > n ? safePrefix(s, n) + '…' : s);
const tailCut = (s, n) => (s.length > n ? '…' + safeSuffix(s, n) : s);

/**
 * Render the capture skeleton the note producer writes into: one block per captured turn, whose rows
 * each repeat an absolute T — a sampled row its own, the head row its turn's, which for a ratified ask
 * is the asking call's row — closed by an aggregate row and a labelled NOTE slot where the turn
 * carries assistant activity. A genuinely note-less turn gets no slot at all, so the slot set is the
 * submission's key set. Assistant text is SAMPLED by message, never projected per message (ADR 0010).
 *
 * @param {object[]} turns - groupTurns output, current handoff turn already excluded
 * @param {string} sessionId - the capturing session, rendered in the epoch header
 * @param {string} cwd - resolves relative tool paths; MUST be the same cwd snapshotDigest and
 *                       buildSearchTerms see, or one relative path gets three different projections
 * @returns {string} Epoch header, then one block per turn, blocks separated by a blank line
 */
export function buildSkeleton(turns, sessionId, cwd) {
  const head = `CONTEXT EPOCH  session ${sessionId}   turns ${turns.length}`;
  const blocks = turns.map(turn => {
    // Sampling decides on MESSAGES, so the indices are taken before any row is rendered: with two or
    // more the first is head-cut and the last tail-cut, and with one the single message is still the
    // last — its tail carries the conclusion, while its opening restates a U the head row already has.
    const assistantIdx = turn.lines.reduce((acc, line, i) => {
      if (i > 0 && line.kind !== 'tool' && line.message?.role !== 'user') acc.push(i);
      return acc;
    }, []);
    const shown = new Set(assistantIdx.length > 1
      ? [assistantIdx[0], assistantIdx[assistantIdx.length - 1]]
      : assistantIdx);
    const headCutAt = assistantIdx.length > 1 ? assistantIdx[0] : -1;

    let toolCalls = 0;
    const basenames = new Set();
    const rows = turn.lines.flatMap((line, i) => {
      const t = String(line.t).padStart(4);
      // The turn's head is lines[0] by construction. A tool line in that position is a ratified
      // AskUserQuestion whose answer IS this turn's U, already projected into cleanedU — rendering
      // it a second time would put one physical line in two contradictory roles, and would make every
      // such turn claim assistant activity it never had. It is not a call the aggregate row counts.
      if (i === 0 && line.kind === 'tool') {
        // The row printed is the turn's own T, not the enumerated line's: a tool line carries its
        // fold's anchor row, while the question was asked on its own row, and the block's NOTE slot
        // names that one. A producer keys `## NOTE[T]` off what this block prints, so the two
        // numbers are the same number or the block has no usable address.
        const normalized = turn.cleanedU.replace(/\r\n?/g, '\n');
        const headT = String(turn.t).padStart(4);
        return headCut(normalized, U_HEAD_CHARS).split('\n').map(part => `T ${headT} | U   : ${part}`);
      }
      if (line.kind === 'tool') {
        // Aggregated, never one row per call: every resolved path reaches the index through
        // buildSearchTerms with or without the skeleton, so the row carries recognition only.
        toolCalls++;
        const { path } = resolveToolUse({ name: line.tool.name, input: line.tool.input }, cwd);
        if (path) basenames.add(basename(path));
        return [];
      }
      if (line.message.role !== 'user' && !shown.has(i)) return [];
      const role = line.message.role === 'user' ? 'U  ' : 'A  ';
      // An ABSORB line is visible to the producer: its cleaned projection is empty by construction, so
      // rendering the projection would make an interrupt or a local command's output vanish from the
      // skeleton while its turn still claims those physical lines. Raw text, same head guardrail.
      const cleaned = line.message.role === 'user' ? cleanUserText(line.message.text) : null;
      const raw = line.message.role === 'user'
        ? (cleaned.kind === 'HEAD' ? cleaned.cleaned : line.message.text)
        : line.message.text;
      // Normalize to '\n' FIRST, then cut. Cutting first spends the guardrail on carriage returns that
      // are about to collapse, so CRLF-heavy text keeps fewer than U_HEAD_CHARS / A_CUT_CHARS
      // normalized characters. The split below frames every physical line with its own repeated role
      // marker, the same framing `CONTEXT.md` Turn Page Operation fixes for the page.
      const normalized = String(raw).replace(/\r\n?/g, '\n');
      const text = line.message.role === 'user'
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
      rows.push(`${' '.repeat(6)}| NOTE[${turn.t}]: ____`);
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
  return turns.filter(turn => turn.hasAssistantActivity).map(turn => String(turn.t));
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
 * anchor/timestamp/cleaned intent, and every line's role, raw text and mechanical tool projection.
 *
 * Not in the digest: the session id, or the capture boundary — so the fingerprint promises no
 * cross-session uniqueness. The epoch key's anchor half IS covered, since every turn's anchor is,
 * `turns[0]`'s included; that is what makes a matching fingerprint a guarantee that submission reads the
 * same notes file the fetch named. `cwd` resolves the tool projection the digest already covers into the
 * same absolute path the skeleton and search_terms carry.
 *
 * @param {object[]} turns - The captured turns, in canonical order
 * @param {string} cwd - Same cwd buildSkeleton was given
 * @returns {string} sha256 hex
 */
export function snapshotDigest(turns, cwd) {
  const canonical = turns.map(turn => ({
    t: turn.t, anchor: turn.anchorUuid, ts: turn.anchorTimestamp, u: turn.cleanedU,
    lines: turn.lines.map(l => l.kind === 'tool'
      ? { k: 't', a: l.anchor, n: l.tool.name, p: resolveToolUse({ name: l.tool.name, input: l.tool.input }, cwd).path ?? null }
      : { k: 'v', a: l.anchor, r: l.message.role, x: l.message.text }),
  }));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

// ── Consumer-side token truncation ─────────────────────────────────────────────

// CJK_RE is global, and /g + .test() is stateful (lastIndex advances, silently skipping
// characters) — the per-character probe needs its own non-global clone.
const CJK_ONE = new RegExp(CJK_RE.source);

/**
 * Longest prefix of `text` whose charsToTokens value stays within `tokenLimit`. countsToTokens
 * shares charsToTokens' exact two-division form, so the boundary this finds is the same one
 * charsToTokens sees. The cut goes through safePrefix so a surrogate pair is never split apart
 * and stored as a lone half.
 *
 * @param {string} text
 * @param {number} tokenLimit
 * @param {{ ascii: number, cjk: number }} ctp
 * @returns {string} `text` itself when it already fits
 */
export function truncateToTokens(text, tokenLimit, ctp) {
  let chars = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const isCjk = CJK_ONE.test(text[i]);
    if (countsToTokens({ chars: chars + 1, cjk: cjk + (isCjk ? 1 : 0) }, ctp) > tokenLimit) {
      return safePrefix(text, i);
    }
    chars += 1;
    if (isCjk) cjk += 1;
  }
  return text;
}

/**
 * The stored form of one turn's user text. uOriginalChars is the CLEANED length in UTF-16 code
 * units — the same unit as uText.length, so truncation is derivable (uOriginalChars > uText.length)
 * instead of persisted as its own flag.
 *
 * @param {string} cleanedU - cleanUserText's projection
 * @returns {{ uText: string, uOriginalChars: number }}
 */
export function storedUText(cleanedU) {
  return { uText: truncateToTokens(cleanedU, U_TEXT_TOKENS, DEFAULT_CTP), uOriginalChars: cleanedU.length };
}

// ── search_terms projection ────────────────────────────────────────────────────

/**
 * The FTS side-channel for one stored turn: CJK bigrams of the human-written text plus the file
 * paths the turn's tools touched. Paths only — a tool NAME is never a search term.
 *
 * Two CJK definitions coexist in this file and are NOT interchangeable: cjkBigrams' own ranges cut
 * the index, while CJK_RE drives token accounting above. A query reaches this column through
 * buildFtsMatch, which tokenizes with cjkBigrams too — that pairing is what makes CJK searchable.
 *
 * `cwd` is mandatory: resolveToolUse hands the tool input to canonicalizePath, which resolves a
 * relative path against `cwd || '/'` — so an omitted cwd would index `lib/store.js` as
 * `/lib/store.js`. (bookmark-detail passes '/' on purpose; it discards the path after classifying.
 * Here the path IS the product.) The same cwd must feed the skeleton's tool lines and snapshotDigest
 * so one relative tool path has one mechanical projection everywhere.
 *
 * @param {{ uText: string, note: string|null, turn: { lines: object[] }, cwd: string }} args
 * @returns {string} Space-joined terms; '' when the turn has neither CJK text nor a resolved path
 */
export function buildSearchTerms({ uText, note, turn, cwd }) {
  const bigrams = cjkBigrams(`${uText}\n${note ?? ''}`);
  const paths = new Set();
  for (const line of turn.lines) {
    if (line.kind !== 'tool') continue;
    const { path } = resolveToolUse({ name: line.tool.name, input: line.tool.input }, cwd);
    if (path) paths.add(path);
  }
  return [bigrams, ...paths].filter(Boolean).join(' ');
}

// ── Turn Record projection ─────────────────────────────────────────────────────

/**
 * The one Turn Record projection, shared by the page and by locate so neither grows its own.
 *
 * `t: null` means one thing only: **there is no readable transcript to position against** — no
 * `ordinals` map, or an empty one. That is the null `T` address of `CONTEXT.md` Unverified Turn
 * Record. An anchor missing from a NON-EMPTY map is an **abandoned** turn (its branch lost the active
 * path), and the caller **excludes** that row rather than rendering it, which is what keeps `t: null`
 * carrying its single meaning.
 *
 * @param {{ anchorUuid: string, uText: string, uOriginalChars: number, note: string|null }} row
 * @param {Map<string, number>|null} [ordinals] - anchor uuid → line ordinal, from activePathOrdinals
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
 * turn-head anchor uuid → that turn's T for one transcript. Build it on readCanonicalTranscript's
 * DEFAULT mode: that keeps every compact epoch and drops abandoned sibling branches, which is exactly
 * the active path a stored anchor has to be checked against. `CONTEXT.md` Transcript Line Ordinal (T)
 * assigns an ordinal before any branch selection, so this map is where the branch judgement happens.
 * The production capture side reads the same transcript with `{ afterLatestCompact: true }` — the two
 * modes serve different questions here.
 *
 * Derived from `groupTurns` rather than from the folds so that a turn has one address everywhere: the
 * page, the scope a query resolves, and the skeleton's NOTE slot all read the T `groupTurns` assigns,
 * which for a ratified ask is the question's tool_use row and not the fold's anchor row.
 *
 * @param {{ folds }} transcript - Result from readCanonicalTranscript
 * @returns {Map<string, number>} First occurrence wins
 */
export function activePathOrdinals(transcript) {
  const map = new Map();
  for (const turn of groupTurns(enumerateLines(transcript))) {
    if (turn.anchorUuid && !map.has(turn.anchorUuid)) map.set(turn.anchorUuid, turn.t);
  }
  return map;
}
