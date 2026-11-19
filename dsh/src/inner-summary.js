// dsh/src/inner-summary.js — the auxiliary call of the inner seal: one model call over the session's active history that summarizes the frozen slots of the range being replaced.
// It knows no Cordis and imports no DSH package: the stream, assembly and error values reach it by parameter.
import { headerSeqOf } from '../../lib/harness/dsh/inner-source.js';
import { storedUText } from '../../lib/turn.js';
import { safePrefix, safeSuffix, truncationMarker } from '../../lib/turn-history-budget.js';

/** The request purpose the call declares. */
export const SUMMARY_PURPOSE = 'inner-compaction';
/** The `failure` of an outcome whose stream stopped with no tool call and whose text is not the notes object: a failure a new request on the same route may cure. */
export const FORMAT_FAILURE = 'format';
/** The `failure` of an outcome whose stream a content filter cut off: the stream's finish is an error whose message holds `FILTER_TEXT`. */
export const FILTER_FAILURE = 'filtered';
/** What the provider's stop text holds when its content filter ended the stream. DSH carries no structured refusal code, so the wording is the only mark. */
const FILTER_TEXT = 'content_filtered';

const DISPLAYED_OPTIONS = ['provider', 'model', 'reasoningEffort', 'purpose', 'sessionId'];
const DISPLAYED_INPUT = ['throughSeq', 'headerSeq'];

// The entries of `source` under `keys` that it provides: a key it lacks, or holds as `undefined`, is not made up, because an explicit `undefined` would make the record's append throw.
const provided = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));

/**
 * The display of the request `options` and `input` describe, as the attempt record keeps it: a whitelist read from the very objects `summarizeSlots` sends and records.
 * It shows the route, the C tail beside the count of the history before it, the cut and the header seq, the count of the tools and the names each tool-history update adds; the history's messages and the tools' definitions are not in it, the header at `headerSeq` holding the definitions.
 * It copies no key outside its list and makes up none the request lacks. It is a shape, not a redaction.
 *
 * @param {{ provider: string, model: string, reasoningEffort?: string, purpose?: string, sessionId?: string, messages: object[],
 *   tools?: object[], toolHistory?: { updates: { messageId: string, additions: { name: string }[] }[] } }} options
 * @param {{ throughSeq?: number, headerSeq?: (number|null) }} input
 */
export function requestDisplayOf(options, input) {
  const { messages, tools, toolHistory } = options;
  return {
    options: provided(options, DISPLAYED_OPTIONS),
    messages: { count: messages.length - 1, tail: messages.at(-1) },
    ...provided(input, DISPLAYED_INPUT),
    ...(tools === undefined ? {} : { tools: { count: tools.length } }),
    ...(toolHistory === undefined ? {} : {
      toolHistory: { updates: toolHistory.updates.map(({ messageId, additions }) => ({ messageId, additions: additions.map(tool => tool.name) })) },
    }),
  };
}

// The width of a text cue: what a row repeats of a message's text.
const C_CUE_TEXT_CHARS = 60;

const blocksOf = message => (Array.isArray(message?.content) ? message.content : []);

// The text of a message as the provider projection joins it: its text blocks, in order, with nothing between.
const textOf = messages => messages.flatMap(blocksOf).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');

// A text as one JSON string cue, so a row stays one line: its whitespace folded, then whole when short, else its opening and ending around an ellipsis.
function cueText(text) {
  const folded = text.replace(/\s+/gu, ' ');
  const half = C_CUE_TEXT_CHARS / 2;
  return JSON.stringify(folded.length <= C_CUE_TEXT_CHARS ? folded : `${safePrefix(folded, half)}…${safeSuffix(folded, half)}`);
}

// The messages of each slot: the current projection of the slot's events that the range selects.
function slotMessagesOf({ slots, session, events, range }) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const selected = new Set(range);
  return slots.map(slot => slot.seqs.filter(seq => selected.has(seq)).map(seq => session.deriveEventMessage(bySeq.get(seq))).filter(message => message != null));
}

// The note of a slot that is a user's own message, written by the program: `user: ` and the text cut as a turn note cuts its U, to the turn-note width with its truncation marker. Any other slot answers `null` and is asked of the model.
function verbatimNoteOf(slot, messages) {
  const [message] = messages;
  if (slot.step !== undefined || message?.role !== 'user' || message.source?.kind !== 'user') return null;
  const { uText, uOriginalChars } = storedUText(textOf(messages));
  const u = uOriginalChars > uText.length ? `${uText}${truncationMarker(uOriginalChars)}` : uText;
  return `user: ${u}`;
}

// The string values of a parsed arguments value in order of appearance, nested ones included; a number, boolean or null is none.
function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(item => stringsOf(item, found));
  return found;
}

// The cue of a call's arguments, `: ` and the text of its string values joined by spaces, as a text cue; arguments that are not JSON count as one string, and a call with no string text has no suffix.
function argumentsCueOf(call) {
  let parsed;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    parsed = call.arguments;
  }
  const text = stringsOf(parsed).join(' ').trim();
  return text === '' ? '' : `: ${cueText(text)}`;
}

// The rows of the slots in their order, one block each: a slot the model is asked for numbered from 1, a user's slot, which takes its verbatim note, by an unnumbered row with its text cue that keeps its place. An assistant step's call row names the call's id, tool, outcome and the cue of its arguments' text. The program's seq, turn and step stay in the slots; the model sees what the messages say.
function rowsOf(entries) {
  let number = 0;
  return entries.map(({ slot, messages, verbatim }) => {
    if (verbatim !== null) return `user, no note: ${cueText(textOf(messages))}`;
    number += 1;
    const label = `[${number}]`;
    if (slot.step === undefined) {
      const [message] = messages;
      if (message?.role === 'tool') return `${label} tool result of call ${message.toolCallId}`;
      return `${label} harness: ${cueText(textOf(messages))}`;
    }
    const failed = new Set(messages.filter(message => message.role === 'tool' && message.isError === true).map(message => message.toolCallId));
    const assistant = messages.filter(message => message.role === 'assistant');
    const text = textOf(assistant);
    const calls = assistant.flatMap(blocksOf).filter(block => block?.type === 'tool-call');
    return [
      `${label} assistant step`,
      `  text: ${text === '' ? 'none' : cueText(text)}`,
      ...calls.map(call => `  call ${call.id} ${call.name} → ${failed.has(call.id) ? 'error' : 'ok'}${argumentsCueOf(call)}`),
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

const tailMessage = ({ entries, asked, held }) => {
  const rows = rowsOf(entries);
  const heldList = [...[...held.paths.keys()].map(key => `- file ${key}`), ...[...held.skills.keys()].map(name => `- skill ${name}`)].join('\n') || 'none';
  const values = { rows, N: String(asked.length), held: heldList };
  return {
    role: 'user',
    content: [{ type: 'text', text: TAIL_TEMPLATE.replace(/\{(rows|N|held)\}/gu, (_, key) => values[key]) }],
  };
};

// The notes of a parsed reply in slot order when it is an object keyed "1" to `count` with a string under each key and no other key; anything else is `undefined`.
function notesOf(parsed, count) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== count) return undefined;
  const notes = Array.from({ length: count }, (_, at) => parsed[String(at + 1)]);
  return notes.every(note => typeof note === 'string') ? notes : undefined;
}

// The notes of a reply, recovered as `summarizeSlots` documents; both paths read through `notesOf`.
function parseSummaries(text, count, loads) {
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
  return notesOf(parsed, count);
}

// An observer that watches nothing.
const NO_OBSERVER = Object.freeze({ dispatch() {}, chunk() {} });
// A carrier cache record that observes nothing: the body runs as it is and no evidence stands.
const NO_CARRIER = Object.freeze({ scope: () => ({ run: body => body(), evidence: () => null }) });

/**
 * Streams one summary call over `session`'s active history and the tail message naming the slots that are not a user's own message; a user's slot is answered with its verbatim note, the model's notes filling the others in order.
 * The call's input is what `session` holds when the function is called, `index` included: the live `seq → sourceFactOf` Map of its events, which names the request header the call sends.
 * `held` is the files and skills the tail names as carried beside the notes: those of the seal's held view of `events` that `range` touched.
 * The tail's rows are cued from `events`, the frozen raw slice `slots` and `range` were taken over, as `session` projects each event of a slot that `range` selects.
 * The text of a stream that stopped with no tool call is the notes object when it parses as one, or, only where its JSON syntax fails, when `kit.loads` recovers one from it, once: legal JSON of another shape is never handed to `kit.loads`, and a `kit.loads` that throws or answers another shape leaves the text no notes.
 * An outcome that is no success is `{ ok: false, reason, call }`, with `failure` set to `FORMAT_FAILURE` exactly when the stream stopped with no tool call and its text is not the notes object, and to `FILTER_FAILURE` exactly when the stream's finish is an error whose message holds `FILTER_TEXT`; these are the two replies the seal may ask for again, the other failures name no category.
 * The `observer` is handed `{ options, input, stream }` once the request is built and before `llm.stream` is called, `options` the very object `llm.stream` receives and `stream()` the accumulator's snapshot as it stands, and is told of each chunk after it is accumulated. The call's `endedAt` is the time the stream iteration ended, taken before the stream is assembled.
 * The `carrier` record (`carrier-evidence.js`) opens a scope around the call that starts the stream and its whole iteration; the evidence its scope holds when the stream ends is the call's `carrierCache`, `{ results, omitted }`, the closed results the pi-ai entry's wrapped payload hook reported for this request in the order it ran, and the field is absent where it reported none (no such hook, or an adapter that never ran it).
 *
 * @param {{ llm: { stream: (options: object) => AsyncIterable<object> }, session: object, index: Map<number, { type: string }>, events: { seq: number }[],
 *   selection: { provider: string, model: string, reasoningEffort?: string },
 *   slots: { seqs: number[], step?: { turn: number, step: number } }[], range: number[],
 *   held: { paths: Map<string, number[]>, skills: Map<string, string> }, signal: AbortSignal,
 *   kit: { AssistantStreamAccumulator: new () => object, BlockAssembler: new () => object, lastAssistantStreamChunk: (stream: object[], type: string) => (object|undefined),
 *     errorChain: (value: unknown) => string, loads: (text: string) => unknown },
 *   observer?: { dispatch: (request: { options: object, input: object, stream: () => object[] }) => void, chunk: () => void },
 *   carrier?: { scope: () => { run: (body: () => Promise<object>) => Promise<object>, evidence: () => ({ results: object[], omitted: number }|null) } }}} options
 */
export async function summarizeSlots({ llm, session, index, events, selection, slots, range, held, signal, kit, observer = NO_OBSERVER, carrier = NO_CARRIER }) {
  const { provider, model, reasoningEffort } = selection;
  // The record keeps the route as plain JSON: an explicit `undefined` effort would make the record's append throw.
  const chosen = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  const tools = session.requestHeader()?.tools;
  const perSlot = slotMessagesOf({ slots, session, events, range });
  const verbatim = slots.map((slot, index) => verbatimNoteOf(slot, perSlot[index]));
  const entries = slots.map((slot, index) => ({ slot, messages: perSlot[index], verbatim: verbatim[index], index }));
  const asked = entries.filter(entry => entry.verbatim === null);
  const tail = tailMessage({ entries, asked, held });
  const input = { throughSeq: session.seq - 1, headerSeq: headerSeqOf(index), tail };
  const options = {
    ...chosen,
    messages: [...session.deriveMessages(), tail],
    ...(tools === undefined ? {} : { tools }),
    toolHistory: session.toolHistory(),
    sessionId: session.id,
    purpose: SUMMARY_PURPOSE,
    signal,
  };
  const accumulator = new kit.AssistantStreamAccumulator();
  const assembler = new kit.BlockAssembler();
  observer.dispatch({ options, input, stream: () => accumulator.snapshot() });
  // The scope stands around the whole consumption, the call that starts the stream included, so whatever the adapter does for this request, its wrapped payload hook among it, is filed under this request and no other.
  const watching = carrier.scope();
  const { thrown, blocks, endedAt } = await watching.run(async () => {
    // Consumption begins at the stream's first `next()`, so a throw from the call or from handing out the iterator rejects: the iterator is taken here, outside the `try`, and the loop is handed it as it is.
    const iterator = llm.stream(options)[Symbol.asyncIterator]();
    let failed;
    let assembled;
    let ended;
    try {
      try {
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          const accumulated = accumulator.push({ time: Date.now(), chunk });
          observer.chunk();
          assembler.push(accumulated.chunk);
        }
      } finally {
        ended = Date.now();
      }
      assembled = assembler.blocks();
    } catch (error) {
      failed = { message: kit.errorChain(error) };
    }
    return { thrown: failed, blocks: assembled, endedAt: ended };
  });
  const stream = accumulator.snapshot();
  // What the wrapped payload hook did for this request's serializations, where it ran: a request it never saw has no field, which reads as not observed.
  const carrierCache = watching.evidence();
  const call = { v: 1, purpose: SUMMARY_PURPOSE, selection: chosen, input, range, stream, endedAt, ...(carrierCache === null ? {} : { carrierCache }), ...(thrown === undefined ? {} : { thrown }) };
  if (thrown !== undefined) return { ok: false, reason: `the summary stream threw: ${thrown.message}`, call };
  // The stream's own finish chunk decides: an assembler reports a stop for a stream that ended without one.
  const finish = kit.lastAssistantStreamChunk(stream, 'finish');
  if (finish === undefined) return { ok: false, reason: 'the summary stream ended without a finish chunk', call };
  if (finish.reason.kind !== 'stop') {
    const detail = finish.reason.failure === undefined ? '' : `: ${finish.reason.failure.message}`;
    const reason = `the summary stream finished with ${finish.reason.kind}${detail}`;
    const filtered = finish.reason.kind === 'error' && String(finish.reason.failure?.message).includes(FILTER_TEXT);
    return { ok: false, ...(filtered ? { failure: FILTER_FAILURE } : {}), reason, call };
  }
  if (blocks.some(block => block.type === 'tool-call')) return { ok: false, reason: 'the summary stream made a tool call', call };
  // The text is that of the text blocks in their assembled order, not of the raw deltas: a block-end text wins and a delta after its block closed is ignored.
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  const notes = parseSummaries(text, asked.length, kit.loads);
  if (notes === undefined) {
    return { ok: false, failure: FORMAT_FAILURE, reason: `the summary text is not a JSON object of ${asked.length} strings keyed "1" to "${asked.length}"`, call };
  }
  // The model's notes fill the asked slots in order; a user's slot keeps its verbatim note.
  const answered = new Map(asked.map(({ index }, at) => [index, notes[at]]));
  const summaries = verbatim.map((note, index) => note ?? answered.get(index));
  return { ok: true, summaries, call };
}
