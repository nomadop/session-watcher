// dsh/src/read-guard.js — the read guard: a `tools/post-execute` listener that turns a native `read` whose every returned line the session's context already holds word for word into an error, and the `tools/result` observer that records the block that took effect.
// The read has run as any read does, so DSH's edit guard has recorded the version of the file; only its answer is replaced. It knows no Cordis and imports no DSH package: the services and the DSH values reach it by parameter.
import { carriesEvidence } from '../../lib/harness/dsh/carrier-table.js';
import { callIdOf } from '../../lib/harness/dsh/transcript-observation.js';
import { pluginRecordType } from '../../lib/harness/dsh/plugin-record.js';
import { foldCarried } from '../../lib/carried-evidence.js';
import { heldReadOf } from '../../lib/held-read.js';
import { readRecord } from '../../lib/tool-evidence.js';
import { READ_BLOCK_RECORD_NAME, readBlockRecordOf } from '../../lib/inner-seal/read-block-record.js';
import { targetOf } from './observed-read.js';
import { hostDiagnostic, writeDiagnostic } from './watcher-table.js';

/** The plugin record the guard appends for a block that took effect: the read block record's name under the DSH log's plugin-record namespace. */
export const READ_BLOCK_RECORD_TYPE = pluginRecordType(READ_BLOCK_RECORD_NAME);

const NATIVE_READ = 'read';

/** What the model is told when its read is blocked: the lines the read returned, `first` to `last`, of the file as it named it. */
export const readBlockFeedback = ({ first, last, path }) => `Error: Lines ${first}-${last} of ${path} are already in your context word for word; reading them gives the same text. Use it.`;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The lines of a native read's value `{ path, offset, lines: [{ number, text }], totalLines }`, null for a value that has not that shape.
function linesOf(value) {
  if (!isObject(value) || typeof value.path !== 'string' || !Array.isArray(value.lines)) return null;
  const sound = value.lines.every(line => isObject(line) && Number.isSafeInteger(line.number) && typeof line.text === 'string');
  return sound ? value.lines : null;
}

// The text of a result's content when it is blocks of text alone.
const textOf = content => (Array.isArray(content) && content.every(block => block?.type === 'text') ? content.map(block => block.text).join('') : null);

/**
 * The guard over a host's services.
 * `postExecute(exec, result, next)` is the `tools/post-execute` listener: it takes the decision the listeners behind it came to, and only a direct, uncancelled, successful `read` of the session whose mode is on that no listener has rewritten is judged. The read is blocked when every line it returned is held by the epoch's scratch at the very line and text (`heldReadOf`), the file's key being the one the matcher gives the model's `file_path` under the session's directory; a read whose lines are all held but one the carriers of the surface left unsure, or one of a file a pruner's replacement result on the surface may have cut, is not blocked. Only a read held throughout asks the execution world for its path, which must be what the read itself printed for that key. The block is an error whose only content is `readBlockFeedback`, with the decision's `additionalContexts` kept.
 * Every doubt lets the read through: a throw, a node of the surface with no fact, a pruner replacement whose resources cannot be named, a surface with no counted step, or a path the execution world does not map to the key; the cases that are no degradation (a mode that is off, a failed read, a read of lines not all held) write nothing, and each degradation writes one stderr line, a throw one too. A watcher that is not live writes nothing: the watcher table reports its entry's failure itself.
 * `observeResult(exec, result)` is the `tools/result` observer: only where the final result is the error this guard returned does it append the read block record, once, through `appendPluginRecord`; a block another listener changed leaves none.
 *
 * @param {{ readMode: (session: object) => { mode: string },
 *   heldScratch: (sessionId: string) => (Map<string, Map<number, object>>|null),
 *   eventFacts: (sessionId: string) => (Map<number, object>|null),
 *   recallRecord: (sessionId: string, toolUseId: string) => unknown,
 *   workingTree: { resolve: (base: string, path: string) => (string|null) },
 *   fsOf: () => (object|undefined),
 *   appendPluginRecord: (session: object, type: string, data: object) => number }} services `heldScratch` answers the scratch of the session's live watcher, null while it has none; `eventFacts` the `seq → eventFactOf` Map of its events; `recallRecord` the saved Attribution Record of a call; `fsOf` the `fs` service where the host has it
 */
export function createReadGuard({ readMode, heldScratch, eventFacts, recallRecord, workingTree, fsOf, appendPluginRecord }) {
  // The blocks in flight: the verdict of each execution this guard blocked, until its `tools/result`.
  const blocked = new WeakMap();

  // The stderr line of a degradation; the verdict is none.
  const skip = (sessionId, code, reason) => {
    writeDiagnostic(sessionId, hostDiagnostic(code, reason));
    return null;
  };

  // The resource keys the pruner's replacement results on the surface answer for, a Set; null when a node of the surface has no fact or one's resources cannot be named.
  function prunedResourcesOf(session, facts) {
    const keys = new Set();
    for (const seq of session.surface.nodes) {
      const fact = facts.get(seq);
      if (fact === undefined) return null;
      const { pruned } = fact;
      if (pruned === null) continue;
      if (!isObject(pruned) || !Number.isSafeInteger(pruned.turn) || !Number.isSafeInteger(pruned.step) || typeof pruned.callId !== 'string') return null;
      const record = readRecord(recallRecord(session.id, callIdOf(pruned.turn, pruned.step, pruned.callId)));
      if (record === null) return null;
      for (const { impacts } of record.effects) for (const { resourceKey } of impacts) keys.add(resourceKey);
    }
    return keys;
  }

  // What the carriers the surface holds leave unsure about the file `key`: the lines some carrier left out of its body because another shows the same text, or withdrew, and `whole` when the chain no longer carries the file readably.
  function carrierDoubt(session, key) {
    const sources = session.deriveMessages().filter(message => carriesEvidence(message.source)).map(message => message.source);
    const lines = new Set();
    let named = false;
    for (const source of sources) {
      for (const entry of source.paths ?? []) {
        if (entry.path !== key) continue;
        named = true;
        for (const number of [...(entry.omit ?? []), ...(entry.withdraw ?? [])]) lines.add(number);
      }
    }
    if (!named) return { whole: false, lines };
    const carried = foldCarried(sources).paths.get(key);
    return { whole: carried === undefined || carried.state === 'unreadable' || carried.state === 'empty', lines };
  }

  // The step the surface's latest counted assistant message completes: the one whose tool calls the loop is executing.
  function currentStepOf(session, facts) {
    for (let at = session.surface.nodes.length - 1; at >= 0; at -= 1) {
      const step = facts.get(session.surface.nodes[at])?.step;
      if (step !== null && step !== undefined) return step;
    }
    return null;
  }

  // The verdict on one read, null to let it through.
  async function judge(exec, result) {
    const { session } = exec.agent;
    const returned = linesOf(result.value);
    if (returned === null) return null;
    const file = exec.arguments?.file_path;
    const key = workingTree.resolve(session.header?.cwd, file);
    const scratch = heldScratch(session.id);
    const facts = eventFacts(session.id);
    if (scratch === null || facts === null) return null;
    const held = scratch.get(key);
    if (held === undefined) return null;
    const range = heldReadOf({ lines: returned, entryAt: number => held.get(number) });
    if (range === null) return null;
    const pruned = prunedResourcesOf(session, facts);
    if (pruned === null) return skip(session.id, 'read_guard_unavailable', 'a node of the surface has no fact, or a pruned result of it names no resource');
    if (pruned.has(key)) return null;
    const doubt = carrierDoubt(session, key);
    if (doubt.whole || returned.some(({ number }) => doubt.lines.has(number))) return null;
    const step = currentStepOf(session, facts);
    if (step === null) return skip(session.id, 'read_guard_unavailable', 'the surface holds no counted step');
    const fs = fsOf();
    if (fs === undefined) return skip(session.id, 'read_guard_unmapped', 'the host has no fs service');
    const found = await targetOf(fs, key, exec.signal);
    if (exec.signal.aborted) return null;
    if (found === null || found.displayPath !== result.value.path) return skip(session.id, 'read_guard_unmapped', `${file} is not the file the read printed`);
    return {
      text: readBlockFeedback({ ...range, path: file }),
      record: { turn: step.turn, step: step.step, callId: exec.callId, path: file, ...range },
    };
  }

  async function postExecute(exec, result, next) {
    const decision = await next();
    const session = exec.agent?.session;
    try {
      const direct = decision.kind === 'accept' && decision.content === undefined && !Object.hasOwn(decision, 'value')
        && exec.parent === undefined && exec.name === NATIVE_READ && result.isError === false;
      if (!direct || session === undefined || readMode(session).mode !== 'on') return decision;
      const verdict = await judge(exec, result);
      if (verdict === null) return decision;
      blocked.set(exec, verdict);
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: verdict.text }],
        ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
      };
    } catch (error) {
      if (!exec.signal.aborted && session !== undefined) writeDiagnostic(session.id, hostDiagnostic('read_guard_failed', error));
      return decision;
    }
  }

  function observeResult(exec, result) {
    const verdict = blocked.get(exec);
    if (verdict === undefined) return;
    blocked.delete(exec);
    const { session } = exec.agent;
    try {
      if (result.isError === true && textOf(result.content) === verdict.text) {
        appendPluginRecord(session, READ_BLOCK_RECORD_TYPE, readBlockRecordOf(verdict.record));
      }
    } catch (error) {
      writeDiagnostic(session.id, hostDiagnostic('read_guard_record_failed', error));
    }
  }

  return { postExecute, observeResult };
}
