// test/helpers/dsh-authored-seals.js — a DSH session log authored the way the loop builds one around inner seals: a surface of nodes, each main request reading the derived messages on it as they stand, and a seal replacing every node after the last carrier.
// The log carries what the oracle needs beside it (`dsh-selection-oracle.js`): the carriers and the range each seal replaced.
import * as E from './dsh-events.js';
import { linesText, readResultText } from './attribution-fixtures.js';

// ── The files ────────────────────────────────────────────────────────────────

export const A = '/repo/src/a.js';
export const B = '/repo/src/b.js';
export const C = '/repo/src/c.js';
const A_LINES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map((name, index) => `const ${name} = ${index + 1};`);
const B_LINES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map(name => `export const bravo${name} = 1;`);
const C_LINES = ['north', 'south', 'east', 'west'].map(name => `export const ${name}Wind = true;`);
export const DISK = { [A]: linesText(A_LINES), [B]: linesText(B_LINES), [C]: linesText(C_LINES) };

const READS = {
  a: { path: 'src/a.js', text: readResultText(A, A_LINES) },
  b: { path: 'src/b.js', offset: 2, limit: 2, text: readResultText(B, B_LINES, { from: 2, to: 3 }) },
  bAll: { path: 'src/b.js', text: readResultText(B, B_LINES) },
  c: { path: 'src/c.js', text: readResultText(C, C_LINES) },
  aTail: { path: 'src/a.js', offset: 6, limit: 3, text: readResultText(A, A_LINES, { from: 6, to: 8 }) },
};

// ── The authored session ─────────────────────────────────────────────────────

const FIXED_TOKENS = 40_000;

/**
 * A session built the way the loop builds one: a surface of nodes, each request reading the derived messages on it as it stands, a step's assistant message after the request, and a seal replacing everything after the last carrier.
 * Each request's usage follows the context it read: the stock is a fixed overhead and a weight per derived message read, and what the request shares with the previous one as a prefix is read from the cache, the rest written.
 */
function authoredSession() {
  const events = [];
  let surface = [];
  let previousRead = [];
  let frontier = 0;
  const seals = [];
  let step = 0;
  let systemNode = null;

  const admit = (event, { node = true } = {}) => {
    events.push(event);
    if (node) surface.push(event);
    return event;
  };
  // The derived messages the surface holds; an empty assistant node keeps its position and derives none.
  const derivedNow = () => surface.filter(event => !(event.type === 'assistant/message' && event.data.message.content.length === 0));
  const weightOf = event => 1_000 + 37 * event.seq;
  const stockOf = nodes => FIXED_TOKENS + nodes.reduce((sum, event) => sum + weightOf(event), 0);

  function usageFor(read) {
    const shared = [];
    while (shared.length < Math.min(read.length, previousRead.length) && read[shared.length] === previousRead[shared.length]) shared.push(read[shared.length]);
    const cacheRead = shared.length === 0 ? 0 : stockOf(shared);
    const cacheWrite = stockOf(read) - cacheRead - 1;
    previousRead = read;
    return { inputTokens: 1, outputTokens: 40, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
  }

  return {
    events,
    // The prompt the first request carries, the surface's node 0.
    system(text) {
      systemNode = admit(E.systemMessage({ text }));
      return systemNode;
    },
    ask({ turn, text }) {
      if (turn !== undefined) admit(E.turnStart({ turn }), { node: false });
      return admit(E.userMessage({ text }));
    },
    context(kind) {
      return admit(E.userMessage({ text: `${kind} reading`, kind }));
    },
    // The surface up to here is what the first request carried; the first range opens after it.
    markPrefix() {
      frontier = surface.length;
    },
    // One step: the request reading the derived surface, the assistant message with its usage, and each call's result.
    // The step's own changes come first, as the loop makes them before it freezes the request: `prompt.append` a system node a route that reads a later system message as the prompt takes, `prompt.replace` the surface head normalized in place, `tools` the changed request header and the tool-registry message that tells the model so.
    step({ turn = 1, calls = [], text, empty = false, prompt, tools }) {
      step += 1;
      admit(E.stepStart({ turn, step }), { node: false });
      if (prompt?.append !== undefined) admit(E.systemMessage({ text: prompt.append, turn, step }));
      if (prompt?.replace !== undefined) {
        const replacement = E.systemReplacement({ seq: systemNode.seq, text: prompt.replace, turn, step });
        events.push(replacement);
        surface[surface.indexOf(systemNode)] = replacement;
        systemNode = replacement;
      }
      if (tools !== undefined) {
        const changed = admit(E.requestHeader({ reason: 'change' }), { node: false });
        admit(E.toolRegistryMessage({ additions: tools.add, removals: tools.remove, headerSeq: changed.seq, turn, step }));
      }
      const read = derivedNow();
      const toolCalls = calls.map((call, index) => ({
        id: `call_${step}_${index}`, name: 'read',
        arguments: JSON.stringify({ file_path: call.path, ...(call.offset === undefined ? {} : { offset: call.offset, limit: call.limit }) }),
      }));
      const usage = usageFor(read);
      const assistant = E.assistantMessage({ turn, step, text: empty ? undefined : text, toolCalls, usage });
      admit(assistant);
      calls.forEach((call, index) => admit(E.toolResult({ turn, step, callId: toolCalls[index].id, text: call.text })));
      admit(E.stepEnd({ turn, step }), { node: false });
      return assistant;
    },
    // The seal replaces every node after the frontier: the surface range opens with its first node, and the carrier cites the call record, then the range.
    seal() {
      const range = surface.slice(frontier);
      const record = admit(E.ignorableEvent({ type: 'plugin:session-watcher/inner-call' }), { node: false });
      const carrier = E.innerSealCarrier({
        sourceEventSeqs: [record.seq, ...range.map(event => event.seq)], startSeq: range[0].seq, endSeq: range.at(-1).seq,
      });
      admit(carrier, { node: false });
      surface = [...surface.slice(0, frontier), carrier];
      frontier = surface.length;
      seals.push({ carrier, range });
      return carrier;
    },
    // The log, the seals' replaced ranges by final seq and their carriers' seqs.
    finish() {
      const log = E.sessionLog(events);
      const indexOf = event => events.indexOf(event);
      return {
        events: log,
        ranges: seals.map(({ range }) => range.map(indexOf)),
        carriers: seals.map(({ carrier }) => indexOf(carrier)),
      };
    },
  };
}

// Three seals: the first and the second range open with a model step, the third with the next turn's admitted question, its runtime context and its time reading; the log ends in an unsealed tail.
// Steps 1, 5, 7 and 9 stand beside the tail's step 10: the head and the call right behind each carrier, whatever opens its range.
export function sealedSession() {
  const session = authoredSession();
  session.ask({ turn: 1, text: 'Work on the module.' });
  session.markPrefix();
  session.step({ calls: [READS.a] });
  session.step({ calls: [READS.b] });
  session.step({ calls: [READS.c] });
  session.step({ calls: [READS.aTail] });
  session.seal();
  session.step({ calls: [READS.bAll] });
  session.step({ calls: [READS.c] });
  session.seal();
  session.ask({ turn: 2, text: 'Now the notes.' });
  session.context('runtime-context');
  session.context('time-context');
  session.step({ turn: 2, calls: [READS.a] });
  session.step({ turn: 2, text: 'Done with a.' });
  session.seal();
  session.ask({ turn: 3, text: 'And the rest.' });
  session.context('runtime-context');
  session.step({ turn: 3, calls: [READS.bAll] });
  session.step({ turn: 3, text: 'That is all.' });
  return session.finish();
}

// The prompt and the tool declarations change as an ordinary session changes them: a render change appended mid-range as a system node, the head normalized in place after the seal that took that node, a tool added mid-range, and one removed right behind a carrier, so that the third range opens with the tool-registry message; the log ends in an unsealed tail across another head replacement.
// Steps 1, 4, 7 and 9 stand beside the tail's step 10: the head and the call right behind each carrier, the declaration change that precedes step 7 included.
export function changedSession() {
  const session = authoredSession();
  session.system('You are a coding agent.');
  session.ask({ turn: 1, text: 'Work on the module.' });
  session.markPrefix();
  session.step({ calls: [READS.a] });
  session.step({ calls: [READS.b], prompt: { append: 'You are a coding agent. Prefer small edits.' } });
  session.step({ calls: [READS.c] });
  session.seal();
  session.step({ calls: [READS.bAll], prompt: { replace: 'You are a coding agent. Prefer small edits.' } });
  session.step({ calls: [READS.a] });
  session.step({ calls: [READS.c], tools: { add: ['grep'] } });
  session.seal();
  session.step({ calls: [READS.aTail], tools: { remove: ['grep'] } });
  session.step({ calls: [READS.b] });
  session.seal();
  session.step({ calls: [READS.bAll], prompt: { replace: 'You are a coding agent. Terse.' } });
  session.step({ text: 'Done.' });
  return session.finish();
}
