// lib/harness/dsh/recall-judge.js — the recall judgement of a DSH main call: what its request is as a recall, and which call an event of its dispatch, its block record or its answer belongs to.
// The inner monitor's settlement report (`dsh/src/monitor-settlement-recall.js`) and the measurement Source's recall facts (`recall-facts.js`) judge the same request through this one module and do not read each other.
// A call recalls after the loop dispatched it and did not skip it, or after the read guard blocked it: a blocked read is one more read of what the context already holds, though it names no event. A call is judged by the events of its own step that follow it, so the judgement of a request can change until its calls are answered.
import { eventReadTargetOf } from './event-read.js';
import { pluginRecordType } from './plugin-record.js';
import { isMainCall } from './transcript-observation.js';
import { READ_BLOCK_RECORD_NAME, isReadBlockRecord } from '../../inner-seal/read-block-record.js';

const READ_BLOCK_TYPE = pluginRecordType(READ_BLOCK_RECORD_NAME);

/** The code DSH's loop gives the result of a call it skipped after a cancellation, one it never dispatched. */
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';

/** The key of the step an event's data names: its turn and step. */
export const stepKey = ({ turn, step } = {}) => `${turn}:${step}`;

// A call reads an event back only after the loop dispatched it and did not skip it; the copy it returns and the targets rest on this one condition.
export const isInitiated = ({ target, dispatched, skipped }) => target !== undefined && dispatched && !skipped;

// What one call is as a recall: `recall` where it was initiated or the guard blocked it, `other` where it is none (a tool of another kind, a target outside this segment or session, a call the loop skipped or answered without starting, a read of a file not blocked) and `unknown` where an unanswered one has not been dispatched.
const callRecallOf = (call = {}) => (call.blocked === true || isInitiated(call) ? 'recall' : call.target === undefined || call.dispatched || call.resulted ? 'other' : 'unknown');

/**
 * What one request is as a recall, the one reading of its calls: `pure` where each call is a recall, `other` where one is no recall however the others stand, and `unknown` where no call is known to be none yet an unanswered one has not been dispatched.
 * @param {{ tools: { id: string }[], calls: Map<string, object> }} sample a request as `push` answers it
 */
export function judgeOf({ tools, calls }) {
  const states = tools.map(({ id }) => callRecallOf(calls.get(id)));
  if (states.includes('other') || states.length === 0) return 'other';
  return states.includes('unknown') ? 'unknown' : 'pure';
}

/**
 * The judge of one Context Epoch's calls, fed the epoch's events one by one in log order.
 * `push(event, { track })` answers nothing for an event that touches no request, else `{ sample, call? }`: `sample` the request `{ seq, step, tools, calls }` the event is the main call of or the dispatch, block record or answer of one call of (the latest main call whose step the event names), `call` the state of the call an answer, dispatch or block record names, `{ target, dispatched, skipped, resulted, blocked }`, which the judge keeps current. A main call's target is the event it reads back where that is an event of this epoch and session, written before the request: the epoch's own events are the ones pushed since `reset`. A block record is the read guard's `inner-read-block` plugin record that reads as one (`isReadBlockRecord`) and names the turn and step of the latest request; it marks the call its call id names as `blocked`, the call having no target. Dispatches, block records and answers are followed while `track` holds, as the caller says where its judgement starts; a main call is opened whatever `track` says.
 * `reset()` starts the next epoch: no event before it is a target and no request is open.
 * @param {{ sessionId: string }} options
 */
export function createRecallJudge({ sessionId }) {
  const seen = new Set();
  let first;
  let latest;

  // A call recalls an event of this epoch and session written before its request.
  const targetOf = (call, requestSeq) => {
    const target = eventReadTargetOf(call);
    return target && (target.sessionId === undefined || target.sessionId === sessionId)
      && target.seq >= first && target.seq < requestSeq && seen.has(target.seq) ? target.seq : undefined;
  };

  function open(event) {
    const content = event.data?.message?.content;
    const tools = Array.isArray(content) ? content.filter(block => block?.type === 'tool-call') : [];
    const calls = new Map(tools.map(block => [block.id, { target: targetOf(block, event.seq), dispatched: false, skipped: false, resulted: false, blocked: false }]));
    return { seq: event.seq, step: stepKey(event.data), tools, calls };
  }

  function push(event, { track = true } = {}) {
    const { seq, type, data } = event;
    first ??= seq;
    let touched;
    if (isMainCall(event)) {
      latest = open(event);
      touched = { sample: latest };
    } else if (track && latest !== undefined) {
      if (type === 'tool/call' && stepKey(data) === latest.step) {
        const call = latest.calls.get(data.callId);
        if (call !== undefined) call.dispatched = true;
        touched = { sample: latest, call };
      } else if (type === READ_BLOCK_TYPE && event.ignorable === true && isReadBlockRecord(data) && stepKey(data) === latest.step) {
        const call = latest.calls.get(data.callId);
        if (call !== undefined) call.blocked = true;
        touched = { sample: latest, call };
      } else if (type === 'tool/result') {
        const call = stepKey(data) === latest.step ? latest.calls.get(data.message?.toolCallId) : undefined;
        if (call !== undefined) {
          call.resulted = true;
          if (data.error?.code === ABORTED_BEFORE_DISPATCH) call.skipped = true;
        }
        touched = { sample: latest, call };
      }
    }
    seen.add(seq);
    return touched;
  }

  function reset() {
    seen.clear();
    first = undefined;
    latest = undefined;
  }

  return { push, reset };
}
