// dsh/src/inner-seal.js — the inner seal: the `agent/pre-step` listener that summarizes the unsealed source and replaces it with an inner-seal carrier before the step.
// It knows no Cordis and imports no DSH package: the services and the DSH values reach it by parameter.
import { eventFactsOf } from '../../lib/harness/dsh/event-facts.js';
import { pluginRecordType } from '../../lib/harness/dsh/plugin-record.js';
import { innerSource, skeletonSlots } from '../../lib/inner-seal/source.js';
import { ASK_TOOL_NAME } from '../../lib/harness/dsh/history-turn-rules.js';
import { askAnswersOf } from '../../lib/harness/dsh/ask-result.js';
import { CARRIER_TABLE, carriesEvidence } from '../../lib/harness/dsh/carrier-table.js';
import { requestTextOf } from '../../lib/harness/dsh/message-blocks.js';
import { assembleCarrierSource, renderCarrier, sourceEventSeqsOf } from '../../lib/inner-seal/carrier.js';
import { carryState } from '../../lib/inner-seal/state-block.js';
import { GIT_STATE_ITEM } from '../../lib/inner-seal/git-state.js';
import { carriedOf, renderCarried, runsOf } from '../../lib/carried-evidence.js';
import { stockOf, uncachedOf } from '../../lib/measurement/usage.js';
import { touchedOf } from '../../lib/inner-seal/touched.js';
import { estimateInnerA, INNER_QUOTE, innerQuote } from '../../lib/inner-seal/quote.js';
import { ATTEMPT_RECORD_NAME } from '../../lib/inner-seal/attempt-record.js';
import { CALL_RECORD_NAME, callRecordOf, UNCACHED_SHARE_ALERT } from '../../lib/inner-seal/call-record.js';
import { END_RECORD_NAME } from '../../lib/inner-seal/end-record.js';
import { createRetryLadder } from '../../lib/inner-seal/ladder.js';
import { summarizeSlots } from './inner-summary.js';
import { hostDiagnostic, writeDiagnostic } from './watcher-table.js';

/** The plugin record the seal appends for each auxiliary call whose stream it consumed: the call record's name under the DSH log's plugin-record namespace. */
export const INNER_CALL_RECORD_TYPE = pluginRecordType(CALL_RECORD_NAME);
/** The plugin record the monitor appends as an attempt's summary request is dispatched: the attempt record's name under the DSH log's plugin-record namespace. */
export const INNER_ATTEMPT_RECORD_TYPE = pluginRecordType(ATTEMPT_RECORD_NAME);
/** The plugin record the monitor appends when an attempt fails or is cancelled: the end record's name under the DSH log's plugin-record namespace. */
export const INNER_END_RECORD_TYPE = pluginRecordType(END_RECORD_NAME);

/** The text of anything a seal can throw: an error's message, any other value as text. */
export const messageOf = error => (error instanceof Error ? error.message : String(error));

const USAGE_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

// The diagnostic of one recorded call, read from its observed stream: the uncached share under DSH's exclusive usage fields when the usage carries all three, a present zero counting, written only above the alert; else the gap.
function diagnose({ session, recordSeq, call, range, kit }) {
  const usage = kit.lastAssistantStreamChunk(call.stream, 'usage')?.usage;
  const at = `record seq ${recordSeq}`;
  const missing = usage === undefined ? USAGE_FIELDS : USAGE_FIELDS.filter(field => typeof usage[field] !== 'number');
  if (missing.length > 0) {
    const what = usage === undefined ? 'reported no usage' : `reported no ${missing.join(', ')}`;
    writeDiagnostic(session.id, hostDiagnostic('inner_usage_gap', `${at}: the auxiliary call ${what}, so its uncached share is unknown`));
    return;
  }
  const canonical = { input: usage.inputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens };
  const share = uncachedOf(canonical) / stockOf(canonical);
  if (!(share > UNCACHED_SHARE_ALERT)) return;
  const { provider, model, reasoningEffort } = call.selection;
  const selection = `${provider}/${model}${reasoningEffort === undefined ? '' : ` ${reasoningEffort}`}`;
  writeDiagnostic(session.id, hostDiagnostic('inner_uncached_share',
    `${at}, range ${range[0]}-${range.at(-1)}, selection ${selection}: share ${share} above alert ${UNCACHED_SHARE_ALERT}`));
}

// A throw from either check counts as unbalanced.
function pairingBalanced(kit, session, startSeq, endSeq) {
  try {
    return kit.toolPairingBalancedBefore(session, startSeq) && kit.toolPairingBalancedAfter(session, endSeq);
  } catch {
    return false;
  }
}

/** The extension a saved image's file name takes from the media type of the normalized image `readImage` answers. */
const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const stemOf = name => (name === undefined ? 'image' : name.replace(/\.[^./]*$/, '') || name);

// Each slot's attachments, from the file and image blocks of its range nodes in order: a file moves as it is; an image's normalized bytes are saved as a file named for their media type, kept beside the original attachment's id and name.
async function attachmentsOf({ slots, range, events, attachments, signal }) {
  const selected = new Set(range);
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const answer = [];
  for (const { seqs } of slots) {
    const held = [];
    for (const seq of seqs.filter(each => selected.has(each))) {
      const content = (bySeq.get(seq).data?.message ?? bySeq.get(seq).data)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'file') held.push({ file: block.attachment });
        if (block?.type !== 'image') continue;
        const original = block.attachment;
        const { ref, data } = await attachments.readImage(original, signal);
        const file = await attachments.saveFile({ data, name: `${stemOf(original.name)}${IMAGE_EXTENSIONS[ref.mediaType]}` });
        held.push({ file, image: { attachmentId: original.attachmentId, ...(original.name === undefined ? {} : { name: original.name }) } });
      }
    }
    answer.push(held);
  }
  return answer;
}

// The text of a message's text blocks, in order, with nothing between.
const textOfMessage = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('');

// One call's questions that the user answered, each `{ question, user }` as its arguments and its result state them, the answer bound to the question by id, its `user` the labels the user selected in the order given and then the custom text, each as the tool logged it; none for a call whose result is missing or marked as an error, a result `askAnswersOf` reads as no answers, and nothing partial of a question, an answer or an id that does not read as the shape, or of an answer with no text.
function answeredOf(args, result) {
  if (result === undefined || result.isError === true) return [];
  let asked;
  try {
    asked = JSON.parse(args)?.questions;
  } catch {
    return [];
  }
  if (!Array.isArray(asked)) return [];
  const answers = askAnswersOf(textOfMessage(result));
  return asked.flatMap((item) => {
    const answer = typeof item?.id === 'string' ? answers.find(each => each.id === item.id) : undefined;
    const user = answer === undefined ? '' : [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join('\n');
    return typeof item?.question === 'string' && user.trim() !== '' ? [{ question: item.question, user }] : [];
  });
}

// Each slot's original questions with the user's answers, from the frozen events of its seqs in order: the questions of each `ask_user_question` call of its assistant messages (`answeredOf`) with the result paired by call id. A pruner's replacement follows the original it stands for in its slot, so the first result of an id is the original. This is a prompt supplement the seal can do without: a slot that cannot be read as such, whatever throws in reading it, adds nothing, and the seal goes on.
function questionsOf({ slots, bySeq }) {
  return slots.map(({ seqs }) => {
    try {
      const events = seqs.map(seq => bySeq.get(seq));
      const results = new Map();
      for (const event of events) {
        if (event.type === 'tool/result' && !results.has(event.data.message.toolCallId)) results.set(event.data.message.toolCallId, event);
      }
      return events.filter(event => event.type === 'assistant/message').flatMap(({ data }) => data.message.content
        .filter(block => block.type === 'tool-call' && block.name === ASK_TOOL_NAME)
        .flatMap(({ id, arguments: args }) => {
          const result = results.get(id);
          if (result === undefined) return [];
          // The result alone: the asking message's own text is not in the carrier.
          return answeredOf(args, result.data.message).map(pair => ({ ...pair, seqs: [result.seq] }));
        }));
    } catch {
      return [];
    }
  });
}

const holdsEvidence = event => event?.type === 'user/message' && carriesEvidence(event.data?.source);

// The held files read through `read`, each over its held lines, beside the held skills: what a carrier built now states.
async function currentOf(held, read, agent, signal) {
  const current = { paths: new Map(), skills: held.skills };
  for (const [key, lines] of held.paths) {
    const { read: answer, displayPath } = await read(agent, key, runsOf(lines).map(([first, last]) => ({ offset: first, limit: last - first + 1 })), signal);
    current.paths.set(key, { displayPath, read: answer });
  }
  return current;
}

// The carrier sources the surface holds outside `range`, in surface order, which the next request still holds ahead of the carrier being built (the carriers, and the read message a load showed its kept lines in). Evidence inside the range is known by its message id from the slice, the range's nodes being unchanged, and is withdrawn with the range, so it is no baseline.
function retainedSources(session, range, bySeq) {
  const inside = new Set(range.map(seq => bySeq.get(seq)).filter(holdsEvidence).map(event => event.data.id));
  return session.deriveMessages()
    .filter(each => each.role === 'user' && carriesEvidence(each.source) && !inside.has(each.id))
    .map(each => each.source);
}

// The git state as the read `carryState` takes, made ahead of the synchronous stretch because the commands take an await: none where the host has no read or the directory is no repository, and a read that fails as one that throws, so the item is reported and left out as any item whose read fails is, and a cancel meets the abort check that follows instead.
async function gitAhead(readGit, session, signal) {
  if (readGit === undefined) return undefined;
  try {
    const text = await readGit(session, signal);
    return text === null ? undefined : () => text;
  } catch (error) {
    return () => { throw error; };
  }
}

// The `state` field a carrier built now carries against the retained carriers `earlier`, null where it shows none, `git` the git state's read, none where the host has none (`gitAhead`). The session's tools are those its request header lists. An item that fails shows none of itself and writes one diagnostic line naming it; a state that cannot be read at all writes one line and shows none; the seal goes on either way.
function stateAt(session, readState, earlier, git) {
  try {
    const tools = new Set((session.requestHeader()?.tools ?? []).map(({ name }) => name));
    const state = readState(session);
    return carryState({ ...state, items: { ...state.items, [GIT_STATE_ITEM.key]: git } }, {
      stateItems: CARRIER_TABLE.stateItems, tools, earlier, failed: (item, error) => writeDiagnostic(session.id, hostDiagnostic('inner_state_failed', `${item.key}: ${messageOf(error)}`)),
    });
  } catch (error) {
    writeDiagnostic(session.id, hostDiagnostic('inner_state_failed', error));
    return null;
  }
}

// The tokens the summary call reads of the session's active history, the meter's request pressure now: the summary request carries that history, which this stands for without assembling it. A total that is no finite non-negative number is none, which `innerQuote` leaves unused; a meter that throws is kept as the failure `quoteOf` reports.
function historyReadOf(meter, session) {
  try {
    return { tokens: meter.measure(session).totalTokens };
  } catch (error) {
    return { error };
  }
}

// The quote of sealing `range` now, with the pair it read, null where it read none (`ctp`), over the request texts of the messages the session derives from the frozen slice and the text `renderCarried` renders for B, priced under the pair `ctpOf` reads for the session, with the one read of the history the summary call makes (`historyReadOf`) at the cache-read price: the held files are read through `readUnobserved`, which records no observation, and whatever the estimate, the ratio or the history read throws, a session with no pair included, leaves that input missing, one diagnostic line naming why.
async function quoteOf({ session, agent, signal, range, stepN, held, bySeq, readUnobserved, ctpOf, cRatio, preset, history }) {
  let estimate = null;
  let ctp = null;
  try {
    const read = ctpOf(session.id);
    if (read === null) throw new Error(`session ${session.id} has no model policy to price its range under`);
    ctp = read;
    const current = await currentOf(held, readUnobserved, agent, signal);
    const carried = carriedOf(retainedSources(session, range, bySeq), current);
    const texts = range.flatMap((seq) => {
      const message = session.deriveEventMessage(bySeq.get(seq));
      return message === null ? [] : [requestTextOf(message)];
    });
    estimate = estimateInnerA({ n: stepN, texts, bText: renderCarried(carried, CARRIER_TABLE), ctp });
  } catch (error) {
    writeDiagnostic(session.id, hostDiagnostic('inner_quote_failed', error));
  }
  let ratio = null;
  try {
    ratio = cRatio(session.id);
  } catch (error) {
    writeDiagnostic(session.id, hostDiagnostic('inner_quote_failed', error));
  }
  if (history.error !== undefined) writeDiagnostic(session.id, hostDiagnostic('inner_quote_failed', history.error));
  return { quote: innerQuote({ n: stepN, estimate, cRatio: ratio, preset, summaryReadCost: history.tokens }), ctp };
}

// The summary of the frozen slots, each request an attempt of its own over the same history, slots, range and quote, on the selection the ladder (`createRetryLadder`) names.
// A request that fails ends its attempt as failed; the ladder is asked whether another follows only once its call record stands and the turn is not cancelled.
// Answers the request that stands: its attempt, still open, its summary and the exits that settle its call record. Any other failure ends its own attempt and is thrown as it is.
async function requestSummary({ monitor, session, range, quote, ctp, llm, index, events, selection, fallback, slots, held, signal, kit, carrier }) {
  const ladder = createRetryLadder({ selection, fallback });
  for (;;) {
    const attempt = monitor.begin(session, { range, quote });
    let again = false;
    try {
      // A rejection here comes before the stream was consumed, so there is no call to record.
      const summary = await summarizeSlots({ llm, session, index, events, selection: ladder.current(), slots, range, held, signal, kit, ctp, observer: attempt, carrier });
      attempt.responded({ endedAt: summary.call.endedAt });
      // The call is recorded once, by whichever exit settles it; a failed append is not retried. It names the attempt record when one was appended.
      let recorded = false;
      const settle = () => {
        const call = callRecordOf({ ...summary.call, attempt: attempt.startSeq });
        const recordSeq = kit.appendPluginRecord(session, INNER_CALL_RECORD_TYPE, call);
        diagnose({ session, recordSeq, call: summary.call, range, kit });
        recorded = true;
        return recordSeq;
      };
      // A cancel observed before the replace ends the turn as the abort, whatever exit observed it.
      const failed = (reason) => {
        if (signal.aborted) {
          try { settle(); } catch {}
          return signal.reason;
        }
        try {
          settle();
        } catch (error) {
          return new Error(`inner seal of session ${session.id} failed: ${reason}; its call record could not be appended: ${messageOf(error)}`, { cause: error });
        }
        return new Error(`inner seal of session ${session.id} failed: ${reason}`);
      };
      if (summary.ok) return { attempt, summary, settle, failed };
      const error = failed(summary.reason);
      again = recorded && ladder.next(summary.failure);
      throw error;
    } catch (error) {
      // The one place an attempt of this loop ends, so a request asked again closes before the next begins and a cancel met while it closes ends the turn without a second end record.
      attempt.failed(error, { cancelled: signal.aborted, cancelReason: signal.reason });
      if (!again) throw error;
      if (signal.aborted) throw signal.reason;
    }
  }
}

/**
 * The seal listener for `agent/pre-step`.
 * @param {{ readMode: (session: object) => { mode: string },
 *   eventFacts: (sessionId: string) => (Map<number, object>|null),
 *   readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   heldView: (sessionId: string, events: object[]) => { paths: Map<string, number[]>, skills: Map<string, string>, effects: { seq: number, kind: 'path'|'skill', key: string }[], oldReads: { toolUseId: string, seq: number, oldLines: number, newLines: number }[] },
 *   readFile: (agent: object, key: string, ranges: { offset: number, limit: number }[], signal: AbortSignal) => Promise<{ read: object, displayPath: string }>,
 *   readUnobserved: (agent: object, key: string, ranges: { offset: number, limit: number }[], signal: AbortSignal) => Promise<{ read: object, displayPath: string }>,
 *   readState: (session: object) => { asOfSeq: number, items: Record<string, () => unknown> },
 *   readGit?: (session: object, signal: AbortSignal) => Promise<(string|null)>,
 *   cRatio: (sessionId: string) => (number|null),
 *   ctpOf: (sessionId: string) => ({ ascii: number, cjk: number }|null),
 *   llm: object, attachments: object, meter: object, kit: object,
 *   monitor: { begin: (session: object, options: { range: number[], quote: object }) => object },
 *   readSettings: () => { preset: string, fallbackModel: ({ provider: string, model: string }|null) },
 *   carrier?: { scope: () => object } }} services `carrier` is the carrier cache's record (`carrier-evidence.js`), whose scope each summary request takes around its stream; without it a call has no evidence
 * From `INNER_QUOTE.minSteps` counted steps on, an unpaused slice is quoted before anything is summarized (`innerQuote`). `readSettings` is read once when the pre-step enters the quote, before its first await, so the compaction policy the quote is priced under and the backup model the ladder ends on are that one read's for the quote, every attempt and every retry, whatever the settings become meanwhile; the backup model is a route with no effort of its own, so the model's default controls apply. The quote prices the request texts of the range's messages and the text of the B its carrier would render now (`carriedOf`), its held files read through `readUnobserved`, which records no observation, under the pair `ctpOf` reads for the session and the C ratio `cRatio` reads, and pays the one read of the active history its summary call makes: the `meter`'s request pressure taken beside the settings and the surface cut, at the cache-read price (`historyReadOf`); a meter that throws or answers no finite non-negative total leaves the step quoted as it was priced without the read, the throw with one `inner_quote_failed` line. A quote with no trigger permits the step unsealed; a triggered one is every attempt's of the seal, handed to `monitor.begin`. The summary call's tail names the held files and skills the replaced events touched (`touchedOf` over the effects of the held view), where the quote and the carrier read the whole held view. Its requests follow the ladder (`createRetryLadder`) over the session's `modelSelection` and the backup model, each its own attempt, closed as failed before the next begins, its call record naming the selection it took; a failure the ladder does not ask again, a cancel, and every other failure end the turn. The commit reads the held files again through `readFile`, which records the observation, and builds B from that read against the carriers its own surface retains, so the quote's B is the estimate at its decision point. The session state is read at the commit alone, in the synchronous stretch of its checks and appends, and is no term of the quote: `readState` answers the cut and the reads of the items the host can read (`carryState`), the session's tools being those its request header lists; an item that fails is left out with one `inner_state_failed` line naming it, a state that cannot be read as a whole leaves the block out with one such line, and the seal goes on. The git state is the one item whose read takes an await, so `readGit(session, signal)` reads it beside the attachments and the held files, just ahead of that stretch, and `readState`'s items are joined by it as one more read, which stands for no tool of the session: a host with no `readGit`, and a `readGit` answering null for a directory that is no repository, leave it out without a line, and one that rejects fails the item as a read that throws does, while a cancel ends the turn at the check behind it. The carrier's source is assembled from the values taken (`assembleCarrierSource`). Each slot keeps, as metadata for the monitor alone, the held view's `oldReads` whose result's seq is among its own, the reads of the range that returned mostly lines their epoch already held; they are neither summarized, rendered nor read back by the quote. Each slot also keeps, for the monitor alone, `sourceTokens`, the estimate of its original text the committing summary call saw, priced under the very pair the quote read (`quoteOf` answers it, so no retry or read asks again) and answered by `summarizeSlots`; it decides nothing of the quote, the trigger, the commit or the prune. Beside the note of each step it holds the questions its slot's frozen events asked the user through `ask_user_question`, each with the user's own answer (`questionsOf`): a supplement the seal can do without, which a slot that does not read as such leaves out without a trace, the summary call neither asked to leave it out nor shown it. The prune's `shadowedTokenCount` stays the meter's own heuristic of the range's nodes, the unit of the host's protocol, whatever the quote priced.
 */
export function createInnerSeal({ readMode, eventFacts, readSession, heldView, readFile, readUnobserved, readState, readGit, cRatio, ctpOf, llm, attachments, meter, kit, monitor, readSettings, carrier }) {
  // The ids of the sessions whose invalid mode has been reported: the mode is locked by then, so one line says it for the session while this seal lives; a seal mounted again reports it again.
  const reportedInvalid = new Set();
  return async (payload, next) => {
    const { agent, signal, modelSelection } = payload;
    const { session } = agent;
    const { mode } = readMode(session);
    if (mode === 'invalid' && !reportedInvalid.has(session.id)) {
      reportedInvalid.add(session.id);
      writeDiagnostic(session.id, hostDiagnostic('inner_mode_invalid', 'the inner mode record does not read as a mode, so this session seals nothing'));
    }
    if (mode !== 'on') return next();
    const index = eventFacts(session.id);
    if (index === null) return next();
    const cheap = innerSource(index, session.surface.nodes);
    if (cheap.paused || cheap.stepN < INNER_QUOTE.minSteps) return next();

    // One read, ahead of every await of the quote flow: the policy that prices this pre-step's quote and the backup model its retries take are fixed here, and a save that lands later is the next pre-step's.
    const { preset, fallbackModel } = readSettings();
    // The surface, the history read of the summary call and the raw slice are taken in one synchronous stretch, so all cut the log at the same event.
    const nodes = [...session.surface.nodes];
    const history = historyReadOf(meter, session);
    const reading = readSession(session.id);
    const { events } = await reading;
    const facts = eventFactsOf(events);
    const { range, stepN, paused } = innerSource(facts, nodes);
    if (paused || stepN < INNER_QUOTE.minSteps) return next();

    const slots = skeletonSlots(facts, nodes, range);
    const bySeq = new Map(events.map(event => [event.seq, event]));
    const originals = range.flatMap(seq => facts.get(seq).originals);
    // The held view is read before the quote and the call, so B is estimated over the whole view and the tail names the files and skills of it the replaced events touched. A pruner replacement in the range stands for its original result, whose effects the view attributes, so the originals count beside the range.
    const replaced = [...range, ...originals];
    const held = heldView(session.id, events);
    const { quote, ctp } = await quoteOf({ session, agent, signal, range, stepN, held, bySeq, readUnobserved, ctpOf, cRatio, preset, history });
    // A cancel during the quote ends the turn as the abort; it is no missing quote to step on from.
    if (signal.aborted) throw signal.reason;
    if (quote.trigger === null) return next();
    // The summary is requested again while its reply fails the notes' format or a content filter cuts it off; a failure before the request that stands left no open attempt to end.
    const { attempt, summary, settle, failed } = await requestSummary({
      monitor, session, range, quote, ctp, llm, index, events, selection: modelSelection, fallback: fallbackModel, slots, held: touchedOf(held, replaced), signal, kit, carrier,
    });
    // From here to the carrier's append, whatever is thrown ends the attempt of the request that stands as failed or cancelled and is thrown again as it is.
    try {
      let slotAttachments;
      let current;
      let git;
      try {
        slotAttachments = await attachmentsOf({ slots, range, events, attachments, signal });
        current = await currentOf(held, readFile, agent, signal);
        git = await gitAhead(readGit, session, signal);
      } catch (error) {
        throw failed(messageOf(error));
      }

      // From here to the carrier, one synchronous stretch: nothing can come between the checks and the appends.
      if (signal.aborted) throw failed('cancelled');
      const startSeq = range[0];
      const endSeq = range.at(-1);
      const surface = session.surface.nodes;
      const at = surface.indexOf(startSeq);
      if (at < 0 || range.some((seq, offset) => surface[at + offset] !== seq)) throw failed('the range\'s surface nodes changed while it was summarized');
      if (!pairingBalanced(kit, session, startSeq, endSeq)) throw failed('the range would split a tool call from its result (tool pairing is unbalanced)');
      // What the appends carry is built before the first of them, so a throw here appends neither the prune nor the carrier.
      let message;
      let shadowedTokenCount;
      const shadowed = new Set(range);
      try {
        // The commit-time surface decides the carriers B and the state block are built against.
        const earlier = retainedSources(session, range, bySeq);
        const source = assembleCarrierSource({
          slots, summaries: summary.summaries, questions: questionsOf({ slots, bySeq }), attachments: slotAttachments,
          oldReads: slots.map(({ seqs }) => held.oldReads.filter(({ seq }) => seqs.includes(seq))), sourceTokens: summary.sourceTokens,
          verbatimSeqs: summary.verbatimSeqs, changes: carriedOf(earlier, current), state: stateAt(session, readState, earlier, git),
        });
        message = kit.createUserMessage({ content: renderCarrier(source, CARRIER_TABLE), source });
        shadowedTokenCount = meter.measure(session).nodes
          .filter(node => shadowed.has(node.seq)).reduce((sum, node) => sum + node.heuristicTokens, 0);
      } catch (error) {
        throw failed(messageOf(error));
      }
      const recordSeq = settle();
      const prune = session.append('compaction/prune', {
        shadowedRange: { start: startSeq, end: endSeq }, shadowedSeqs: range, shadowedTokenCount,
      });
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: sourceEventSeqsOf({ callSeq: recordSeq, pruneSeq: prune.seq, replaced }),
      });
    } catch (error) {
      attempt.failed(error, { cancelled: signal.aborted, cancelReason: signal.reason });
      throw error;
    }
    attempt.committed();
    return next();
  };
}
