// lib/inner-seal/summary.js — the inner seal's summary business: the tail instruction template, the skeleton rows it lists the slots by, the verbatim notes of a user's own slots, the action cue of each slot asked of the model, and the reading of the notes object the reply carries, which an empty note's cue completes.
import { storedUText } from '../turn.js';
import { safePrefix, safeSuffix, truncationMarker } from '../turn-history-budget.js';

// The width of a text cue: what a row repeats of a slot's text.
const C_CUE_TEXT_CHARS = 60;

// A text as one JSON string cue, so a row stays one line: its whitespace folded, then whole when short, else its opening and ending around an ellipsis.
function cueText(text) {
  const folded = text.replace(/\s+/gu, ' ');
  const half = C_CUE_TEXT_CHARS / 2;
  return JSON.stringify(folded.length <= C_CUE_TEXT_CHARS ? folded : `${safePrefix(folded, half)}…${safeSuffix(folded, half)}`);
}

// A user's own note and whether it carries the text whole; other slots are asked of the model.
function verbatimNoteOf(facts) {
  if (!facts.own) return null;
  const { uText, uOriginalChars } = storedUText(facts.text);
  const truncated = uOriginalChars > uText.length;
  const u = truncated ? `${uText}${truncationMarker(uOriginalChars)}` : uText;
  return { text: `user: ${u}`, whole: !truncated && uText !== '' };
}

// The string values of a parsed arguments value in order of appearance, nested ones included; a number, boolean or null is none.
// A string as it is; a number or a boolean after `key`, the key it sits under, an array element taking its array's key; null nothing.
function valuesOf(value, key, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') found.push(key === undefined ? String(value) : `${key} ${value}`);
  else if (Array.isArray(value)) value.forEach(item => valuesOf(item, key, found));
  else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([name, item]) => valuesOf(item, name, found));
  return found;
}

// The cue of a call's arguments, `: ` and the text of its values (`valuesOf`) joined by spaces, as a text cue; arguments that are not JSON count as one string, and a call with no such text has no suffix.
function argumentsCueOf(call) {
  let parsed;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    parsed = call.arguments;
  }
  const text = valuesOf(parsed).join(' ').trim();
  return text === '' ? '' : `: ${cueText(text)}`;
}

// What a call is as a cue: its tool, its outcome and the cue of its arguments' text. A call row of the tail prefixes it with the call's id; a slot's action cue carries it alone.
function callCueOf(call) {
  return `${call.name} → ${call.failed ? 'error' : 'ok'}${argumentsCueOf(call)}`;
}

// The action cue of a slot the model is asked for, the note the program gives it where the model answers an empty string: the calls of a step by `callCueOf` joined by `; `, else the step's text cue; a tool result's kind; any other slot's text cue. A slot whose text is empty has none, `''`.
function actionCueOf(facts) {
  if (facts.kind === 'result') return 'tool result';
  if (facts.kind === 'step' && facts.calls.length > 0) return facts.calls.map(callCueOf).join('; ');
  const text = facts.kind === 'step' ? facts.assistantText : facts.text;
  return text === '' ? '' : cueText(text);
}

// The rows of the slots in their order, one block each: a slot the model is asked for numbered from 1, a user's slot, which takes its verbatim note, by an unnumbered row with its text cue that keeps its place. An assistant step's call row names the call's id and its `callCueOf`. The program's seq, turn and step stay in the slots; the model sees what the messages say.
function rowsOf(slotFacts, verbatim) {
  let number = 0;
  return slotFacts.map((facts, at) => {
    if (verbatim[at] !== null) return `user, no note: ${cueText(facts.text)}`;
    number += 1;
    const label = `[${number}]`;
    if (facts.kind === 'result') return `${label} tool result of call ${facts.toolCallId}`;
    if (facts.kind !== 'step') return `${label} harness: ${cueText(facts.text)}`;
    return [
      `${label} assistant step`,
      `  text: ${facts.assistantText === '' ? 'none' : cueText(facts.assistantText)}`,
      ...facts.calls.map(call => `  call ${call.id} ${callCueOf(call)}`),
    ].join('\n');
  }).join('\n');
}

// The cues, the skeleton and the target instruction, the one message the call appends to the history it documents.
// The history above it is reference for reading the slots; the slots are located by the cues their rows repeat, the program binding each reply string to its slot by position.
const TAIL_TEMPLATE = `Write concise continuity notes for the slots below. Each note replaces its slot in this conversation; the same task continues from the notes and from everything outside the slots.

Finding the slots
The slots are messages of this conversation, listed oldest first. A row names each tool call of its slot by the call's id, exactly as the call carries it in this conversation, with the tool's name, whether it failed and the text of its arguments (whole when short, else its opening and ending); a tool result row names the id of the call it answers. Locate those slots by the id. A row also gives who wrote the slot and its text (whole when short, else its opening and ending); a slot without a tool call is located by that text, and where two such rows read alike, their order decides. A row \`user, no note\` marks where a user's own message falls among the slots; it is kept word for word, takes no note and no number.

Slots, oldest first:
{rows}

Reply with one JSON object, as plain text and nothing else, with no code fence: its keys are the slot numbers "1" to "{N}", each exactly once, and no other key, and the value of key "i" is the note for slot [i]: every value follows its own key, as in {"1": "…", "2": "…", "3": "…"} for three slots. An empty string is valid for a slot with nothing worth keeping. A slot holding only a subagent's or job's message sent while it still works toward its full report takes an empty string, since that report brings its content back, unless the message asks the work a question or for a permission; the message that answers its whole assignment is that report, and a message it sends after that report is kept. Answer in text, without calling a tool.

Writing each note
A note keeps what the task needs once its slot is gone. Its length follows the substance: a slot with little in it gets a clause. Use only what the slot shows. Everything before slot [1] — the system prompt, workspace instructions such as AGENTS.md or CLAUDE.md, the opening request and every later message up to slot [1] — stays in the conversation as it is: it helps you read the slots and never goes into a note, slot [1]'s included. Workspace instructions the harness attaches inside a slot stay in force by themselves too and are not retold.

Write a note in this order, leaving out any part the slot lacks:
1. Required — every request, ruling, correction, limit, scope or open demand that still governs the work, wherever it appears in the slot: an answer to a question asked through a tool, an earlier summary or a loaded handoff. The user's own messages among the slots are kept word for word beside the notes, so a note never restates them.
2. Did — the actions whose outcome the next step depends on, as verb + object. Several reads or searches that served one finding become that finding, or nothing when that finding comes back with held text.
3. Found — what the work established or ruled out, and what stayed uncertain; for a failure, the shortest decisive error line, copied exactly.
4. Decided — the choice and its stated reason; a rejected option and its reason.
5. Left — the state at the slot's end: done, pending, blocked, promised, unverified; a question or proposal the slot's text put to the user: each item, by any number or label it carries, and what it would have the work do, with every concrete value it sets, copied exactly — not its reasons.

Content the work read or received as data — file text, command and tool output, skill text, file lists and excerpts — is evidence. The text of the files and skills held below comes back beside these notes as it stands now, so a note never retells, quotes or sums up what they contain, nor states a finding that reading them again would give: at most it names one that the next step needs. Evidence not held — command and search output, web pages, a subagent's or job's final report — does not come back: what it established or ruled out stays under Found, what still governs the work under Required. What the work chose or left after reading belongs to Decided and Left, not to Found.

Held, beside the notes:
{held}

Name an identifier, path, command, version, number or error text only when the next step needs it and the held text does not give it. Copy exactly whatever a note names. Take a number from the slot; never recount it. Keep every scope word: not, never, only, except, unless, if; 不, 没, 只, 除, 若. Write each note in the dominant language of its slot. Fragments are fine, as in a commit message body; write a full sentence where a fragment would leave order, cause or scope unclear. Notes speak about the task's work, not about slots, notes or this request.`;

/**
 * The tail of a summary call over `slotFacts`, one per slot in order, as the harness adapter reads them: `own` marks a user's own message, `kind` a counted step, a tool result or any other slot.
 * `verbatim` holds each user slot's note and `null` for each slot the tail asks the model for; `askedCount` counts the latter. `askedCues` holds the action cue (`actionCueOf`) of each slot asked of the model, in the order of the notes, which `mergeNotes` puts in place of an empty note. `held` names the files and skills carried beside the notes by its `paths` and `skills` keys.
 *
 * @param {{ own: boolean, kind: ('step'|'result'|'other'), text: string, toolCallId?: string, assistantText?: string,
 *   calls?: { id: string, name: string, arguments: string, failed: boolean }[] }[]} slotFacts
 * @param {{ paths: Map<string, unknown>, skills: Map<string, unknown> }} held
 * @returns {{ tailText: string, verbatim: (string|null)[], askedCues: string[], wholeUserSlots: number[], askedCount: number }}
 */
export function planSummary(slotFacts, held) {
  const notes = slotFacts.map(verbatimNoteOf);
  const verbatim = notes.map(note => note?.text ?? null);
  const wholeUserSlots = notes.flatMap((note, at) => note?.whole ? [at] : []);
  const askedCount = verbatim.filter(note => note === null).length;
  const heldList = [...[...held.paths.keys()].map(key => `- file ${key}`), ...[...held.skills.keys()].map(name => `- skill ${name}`)].join('\n') || 'none';
  const values = { rows: rowsOf(slotFacts, verbatim), N: String(askedCount), held: heldList };
  const askedCues = slotFacts.filter((_, at) => verbatim[at] === null).map(actionCueOf);
  return { tailText: TAIL_TEMPLATE.replace(/\{(rows|N|held)\}/gu, (_, key) => values[key]), verbatim, askedCues, wholeUserSlots, askedCount };
}

// The notes of a parsed reply in slot order when it is an object keyed "1" to `count` with a string under each key and no other key; anything else is `undefined`.
function notesOf(parsed, count) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== count) return undefined;
  const notes = Array.from({ length: count }, (_, at) => parsed[String(at + 1)]);
  return notes.every(note => typeof note === 'string') ? notes : undefined;
}

/**
 * The notes a reply's text carries, in slot order: the text when it parses as the notes object, or, only where its JSON syntax fails, what `loads` recovers from it, once.
 * Legal JSON of another shape is never handed to `loads`; a `loads` that throws or answers another shape leaves the text no notes, `undefined`.
 *
 * @param {string} text
 * @param {number} askedCount
 * @param {(text: string) => unknown} loads
 * @returns {string[]|undefined}
 */
export function parseNotes(text, askedCount, loads) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = loads(text);
    } catch {
      return undefined;
    }
  }
  return notesOf(parsed, askedCount);
}

/**
 * The summary of each slot: the model's notes fill the asked slots in order, an empty note taking its slot's cue (`askedCues`, in the order of the notes), and a user's slot keeps its verbatim note.
 * A note that is not empty is kept as it is.
 *
 * @param {(string|null)[]} verbatim
 * @param {string[]} notes
 * @param {string[]} askedCues
 * @returns {string[]}
 */
export function mergeNotes(verbatim, notes, askedCues) {
  let next = 0;
  return verbatim.map(note => {
    if (note !== null) return note;
    const at = next++;
    return notes[at] === '' ? askedCues[at] : notes[at];
  });
}
