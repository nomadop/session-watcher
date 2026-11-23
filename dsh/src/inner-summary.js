// dsh/src/inner-summary.js — the DSH adapter of the inner seal's auxiliary call: it reads each slot's derived messages into slot facts, builds the request over the session's active history and the tail `lib/inner-seal/summary.js` writes, accumulates and assembles the stream, and tells a content filter's stop apart.
// It knows no Cordis and imports no DSH package: the stream, assembly and error values reach it by parameter.
import { requestTextOf, slotFactsOf } from '../../lib/harness/dsh/message-blocks.js';
import { callRecordOf } from '../../lib/inner-seal/call-record.js';
import { FILTER_FAILURE, FORMAT_FAILURE } from '../../lib/inner-seal/ladder.js';
import { headerSeqIn } from '../../lib/inner-seal/source.js';
import { mergeNotes, parseNotes, planSummary } from '../../lib/inner-seal/summary.js';
import { charsToTokens } from '../../lib/token-estimate.js';

/** The request purpose the call declares. */
export const SUMMARY_PURPOSE = 'inner-compaction';
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

// The messages of each slot: the current projection of the slot's events that the range selects.
function slotMessagesOf({ slots, session, events, range }) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const selected = new Set(range);
  return slots.map(slot => slot.seqs.filter(seq => selected.has(seq)).map(seq => session.deriveEventMessage(bySeq.get(seq))).filter(message => message != null));
}

// An observer that watches nothing.
const NO_OBSERVER = Object.freeze({ dispatch() {}, chunk() {} });
// A carrier cache record that observes nothing: the body runs as it is and no evidence stands.
const NO_CARRIER = Object.freeze({ scope: () => ({ run: body => body(), evidence: () => null }) });

/**
 * Streams one summary call over `session`'s active history and the tail message naming the slots that are not a user's own message; a user's slot is answered with its verbatim note, the model's notes filling the others in order, an empty note taking its slot's action cue.
 * The call's input is what `session` holds when the function is called, `index` included: the live `seq → eventFactOf` Map of its events, whose latest header (`headerSeqIn`) is the request header the call sends.
 * `held` is the files and skills the tail names as carried beside the notes: those of the seal's held view of `events` that `range` touched.
 * The tail's rows are cued from `events`, the frozen raw slice `slots` and `range` were taken over, as `session` projects each event of a slot that `range` selects.
 * The text of a stream that stopped with no tool call is read for the notes by `parseNotes` with `kit.loads` as its recovery.
 * An outcome that is no success is `{ ok: false, reason, call }`, with `failure` set to `FORMAT_FAILURE` exactly when the stream finished with tool-calls, stopped with a tool call, or stopped with text that is not the notes object, and to `FILTER_FAILURE` exactly when the stream's finish is an error whose message holds `FILTER_TEXT`; these are the two replies the seal may ask for again, the other failures name no category.
 * `ctp` is the calibrated pair the seal's quote priced the range under; given, a success also answers `sourceTokens`, one estimate for each slot of the tokens of the messages of that very call's `perSlot`, each priced as the quote prices a message (`requestTextOf`, `charsToTokens`), the sum unrounded and a slot with no message zero; without it the success has none. It is the monitor's, decides nothing of the seal and is read by nothing here.
 * The `observer` is handed `{ options, input, stream }` once the request is built and before `llm.stream` is called, `options` the very object `llm.stream` receives and `stream()` the accumulator's snapshot as it stands, and is told of each chunk after it is accumulated. The call's `endedAt` is the time the stream iteration ended, taken before the stream is assembled.
 * The `carrier` record (`carrier-evidence.js`) opens a scope around the call that starts the stream and its whole iteration; the evidence its scope holds when the stream ends is the call's `carrierCache`, `{ results, omitted }`, the closed results the pi-ai entry's wrapped payload hook reported for this request in the order it ran, and the field is absent where it reported none (no such hook, or an adapter that never ran it).
 *
 * @param {{ llm: { stream: (options: object) => AsyncIterable<object> }, session: object, index: Map<number, { header: boolean }>, events: { seq: number }[],
 *   selection: { provider: string, model: string, reasoningEffort?: string },
 *   slots: { seqs: number[], step?: { turn: number, step: number } }[], range: number[],
 *   held: { paths: Map<string, number[]>, skills: Map<string, string> }, signal: AbortSignal, ctp?: ({ ascii: number, cjk: number }|null),
 *   kit: { AssistantStreamAccumulator: new () => object, BlockAssembler: new () => object, lastAssistantStreamChunk: (stream: object[], type: string) => (object|undefined),
 *     errorChain: (value: unknown) => string, loads: (text: string) => unknown },
 *   observer?: { dispatch: (request: { options: object, input: object, stream: () => object[] }) => void, chunk: () => void },
 *   carrier?: { scope: () => { run: (body: () => Promise<object>) => Promise<object>, evidence: () => ({ results: object[], omitted: number }|null) } }}} options
 */
export async function summarizeSlots({ llm, session, index, events, selection, slots, range, held, signal, kit, ctp = null, observer = NO_OBSERVER, carrier = NO_CARRIER }) {
  const { provider, model, reasoningEffort } = selection;
  // The record keeps the route as plain JSON: an explicit `undefined` effort would make the record's append throw.
  const chosen = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  const tools = session.requestHeader()?.tools;
  const perSlot = slotMessagesOf({ slots, session, events, range });
  const { tailText, verbatim, askedCues, wholeUserSlots, askedCount } = planSummary(slots.map((slot, at) => slotFactsOf(slot, perSlot[at])), held);
  const tail = { role: 'user', content: [{ type: 'text', text: tailText }] };
  const input = { throughSeq: session.seq - 1, headerSeq: headerSeqIn(index, { latest: true }), tail };
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
  const call = callRecordOf({ purpose: SUMMARY_PURPOSE, selection: chosen, input, range, stream, endedAt, carrierCache, thrown });
  if (thrown !== undefined) return { ok: false, reason: `the summary stream threw: ${thrown.message}`, call };
  // The stream's own finish chunk decides: an assembler reports a stop for a stream that ended without one.
  const finish = kit.lastAssistantStreamChunk(stream, 'finish');
  if (finish === undefined) return { ok: false, reason: 'the summary stream ended without a finish chunk', call };
  if (finish.reason.kind !== 'stop') {
    const detail = finish.reason.failure === undefined ? '' : `: ${finish.reason.failure.message}`;
    const reason = `the summary stream finished with ${finish.reason.kind}${detail}`;
    const filtered = finish.reason.kind === 'error' && String(finish.reason.failure?.message).includes(FILTER_TEXT);
    const failure = filtered ? FILTER_FAILURE : finish.reason.kind === 'tool-calls' ? FORMAT_FAILURE : undefined;
    return { ok: false, ...(failure === undefined ? {} : { failure }), reason, call };
  }
  if (blocks.some(block => block.type === 'tool-call')) return { ok: false, failure: FORMAT_FAILURE, reason: 'the summary stream made a tool call', call };
  // The text is that of the text blocks in their assembled order, not of the raw deltas: a block-end text wins and a delta after its block closed is ignored.
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  const notes = parseNotes(text, askedCount, kit.loads);
  if (notes === undefined) {
    return { ok: false, failure: FORMAT_FAILURE, reason: `the summary text is not a JSON object of ${askedCount} strings keyed "1" to "${askedCount}"`, call };
  }
  const sourceTokens = ctp === null ? undefined : perSlot.map(messages => messages.reduce((sum, message) => sum + charsToTokens(requestTextOf(message), ctp), 0));
  return { ok: true, summaries: mergeNotes(verbatim, notes, askedCues), verbatimSeqs: wholeUserSlots.map(at => slots[at].seqs[0]), sourceTokens, call };
}
