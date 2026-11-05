// dsh/src/continue.js — `/sw-continue`: the clear as one compaction-protocol transaction the plugin writes itself with no model call, and the command around it.
// It knows no Cordis: the watcher table, the store, the token meter, the flush, the load's delivery, tool runtime and working directory, and the DSH values it builds events from (`kit`) reach it by parameter.
import { randomUUID } from 'node:crypto';

import { handOver, loadHandoffInto } from './load.js';

// The summary's route names this plugin and the command: no model wrote it.
const SUMMARY_PROVIDER = 'session-watcher';
const SUMMARY_MODEL = 'sw-continue';

/**
 * A clear that did not complete. `code` is `start` when nothing was appended and `commit` once `compaction/start` has been; `cause` is the failure that ended it.
 */
export class ClearError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ClearError';
    this.code = code;
  }
}

const COMMAND_NAME = 'sw-continue';
const COMMAND_DESCRIPTION = 'Clear the session and resume from its last handoff';

const USAGE = 'Usage: /sw-continue (no arguments)';
const NO_HANDOFF = 'No handoff has been prepared in this session. Run the sw-handoff skill first.';
const STALE_HANDOFF = 'The last handoff was prepared before the session\'s latest context reset. Run the sw-handoff skill again.';
const NOT_IDLE = '/sw-continue runs only while the agent is idle.';
const NOT_STARTED = 'Clearing could not start; the session history is unchanged.';
const NOT_FINISHED = 'Clearing did not finish cleanly; some history may be shadowed. Inspect the session before retrying.';
const NOT_SAVED = 'Clearing finished, but the session could not be saved.';
const NOTHING_TO_CLEAR = 'No history to clear.';

const checkpointText = token => `[Session Watcher] Context cleared by /sw-continue. Handoff token: ${token}`;
const clearedText = ({ count, shadowedTokenCount }, token) => `Cleared ${count} history items (~${shadowedTokenCount} tokens); loaded handoff ${token}.`;
const notLoadedText = (reason, token) => `Context cleared, but the handoff was not loaded: ${reason}. Run /sw-load ${token}.`;
const textBlocks = token => [{ type: 'text', text: checkpointText(token) }];
const messageOf = error => (error instanceof Error ? error.message : String(error));

// The priced nodes after the `system/message` head, or all of them when another event starts the surface.
function nodesAfterHead(session, meter) {
  const { nodes } = meter.measure(session);
  const first = nodes.length > 0 && session.eventAt(nodes[0].seq).type === 'system/message' ? 1 : 0;
  return nodes.slice(first);
}

// A failed close leaves the compaction open; the failure that led here is the one the caller reports.
function closeWithError(session, lifecycle, cause) {
  try {
    session.append('compaction/end', { ...lifecycle, error: messageOf(cause) });
  } catch { /* nothing more can be written */ }
}

/**
 * Shadow every surface node after the `system/message` head (every node when none heads the surface) behind one compact-checkpoint, which opens a new Context Epoch, in the four appends of a compaction: `compaction/start`, `compaction/summary`, the replacing `user/message` and `compaction/end`, all under the invocation's `commandId`.
 * The appends run in one synchronous stretch, so no abort or other writer falls inside the transaction.
 * `kit` is `{ CompactionId, compactCheckpointSource, createUserMessage }`, the DSH values the events are built from.
 *
 * @returns {{ count: number, shadowedTokenCount: number } | null} the shadowed nodes' count and their heuristic price; `null` with nothing appended when no node lies after the head
 * @throws {ClearError} `start` when nothing was appended; `commit` once `compaction/start` has been, after a `compaction/end` carrying `error` unless the end itself was what failed
 */
export function clearSurface({ session, meter, kit, commandId, token }) {
  const compactionId = kit.CompactionId(randomUUID());
  const lifecycle = { compactionId, sourceCommandId: commandId, turn: null };
  let range;
  let checkpoint;
  let startEvent;
  try {
    range = nodesAfterHead(session, meter);
    if (range.length === 0) return null;
    checkpoint = kit.createUserMessage({
      content: textBlocks(token), source: kit.compactCheckpointSource(compactionId, commandId),
    });
    startEvent = session.append('compaction/start', lifecycle);
  } catch (cause) {
    throw new ClearError('start', `clearing could not start: ${messageOf(cause)}`, { cause });
  }

  const shadowedSeqs = range.map(node => node.seq);
  const shadowedRange = { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) };
  const shadowedTokenCount = range.reduce((total, node) => total + node.heuristicTokens, 0);
  let summaryEvent;
  try {
    // The summary prices the replacement that follows: the token meter folds a replace with the `compaction/summary` immediately before it, so an event between the two expires that price and the replacement is then folded without it.
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      sourceCommandId: commandId,
      summary: textBlocks(token),
      shadowedRange,
      shadowedSeqs,
      shadowedTokenCount,
      provider: SUMMARY_PROVIDER,
      model: SUMMARY_MODEL,
    });
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    });
  } catch (cause) {
    closeWithError(session, lifecycle, cause);
    throw new ClearError('commit', `clearing did not finish: ${messageOf(cause)}`, { cause });
  }
  try {
    session.append('compaction/end', lifecycle);
  } catch (cause) {
    throw new ClearError('commit', `clearing did not close: ${messageOf(cause)}`, { cause });
  }
  return { count: shadowedSeqs.length, shadowedTokenCount };
}

const failure = text => ({ kind: 'error', text });
const success = text => ({ kind: 'success', text });

/**
 * The `/sw-continue` command definition.
 * A call with arguments is refused; otherwise the calling session's newest handoff must belong to the segment its live watcher reads now, and the clear, the load of that handoff's token (`loadHandoffInto`) and one flush run as one `agent.runMaintenance` task, the flush whatever the load's outcome, so a cleared session is saved either way.
 * Once the task has settled, a loaded handoff is handed over (`handOver`, with `resume`), which wakes the model; a failed load answers its reason and the token to load by hand, and a rejected flush answers that the session could not be saved, whatever the load's outcome; neither wakes anything.
 * The task is an async function, so a throw inside it is a rejection and only `runMaintenance` refusing the agent throws synchronously.
 * Only a `ClearError` and the flush's rejection become results; any other rejection, the watcher's wait among them, and a throw of the hand-over reach the caller unchanged.
 * `meter` is the token meter, `flush(session)` saves the session, `kit` is `clearSurface`'s and `loadHandoffInto`'s, and `deliver`, `tools` and `cwdOf` are `loadHandoffInto`'s.
 *
 * @returns {{ name: string, description: string, handler: Function }} the definition the command registry takes
 */
export function createContinueCommand({ table, store, kit, meter, flush, deliver, tools, cwdOf }) {
  async function handler({ commandId, agent, rawInput, signal }) {
    if (rawInput.trim().length > 0) return failure(USAGE);
    const { session } = agent;
    const handoff = store.loadHandoffBySession(session.id);
    if (handoff === null) return failure(NO_HANDOFF);
    const { watcher } = await table.waitLive(session.id, signal);
    if (handoff.segment !== watcher.getStatus().segment) return failure(STALE_HANDOFF);
    const token = handoff.loadToken;

    let maintenance;
    try {
      maintenance = agent.runMaintenance(async () => {
        const cleared = clearSurface({ session, meter, kit, commandId, token });
        if (cleared === null) return { status: 'empty' };
        const load = await loadHandoffInto({ agent, session, tools, deliver, kit, signal, token, cwdOf });
        // Only a rejection is a failure: the real flush resolves `false` when no listener saves the session, and the clear stands.
        try {
          await flush(session);
        } catch {
          return { status: 'unsaved' };
        }
        return { status: 'cleared', cleared, load };
      });
    } catch {
      return failure(NOT_IDLE);
    }

    let outcome;
    try {
      outcome = await maintenance;
    } catch (error) {
      if (error instanceof ClearError) return failure(error.code === 'start' ? NOT_STARTED : NOT_FINISHED);
      throw error;
    }
    if (outcome.status === 'empty') return success(NOTHING_TO_CLEAR);
    if (outcome.status === 'unsaved') return failure(NOT_SAVED);
    if (outcome.load.failed) return failure(notLoadedText(outcome.load.failed.reason, token));
    handOver({ agent, loaded: outcome.load.loaded, resume: true });
    return success(clearedText(outcome.cleared, token));
  }
  return { name: COMMAND_NAME, description: COMMAND_DESCRIPTION, handler };
}
