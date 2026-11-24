// lib/harness/dsh/recall-facts.js — the recall facts of the DSH Source: what each main call is as a recall request and what it cost, in the form the measurement source fold keeps on the call's own `main-call` fact.
// A request that only reads events of its own session back, or whose reads the read guard blocked, is an extra call beside the work: the measurement prices it whole, at the price ratio the seal it follows recorded, where an ordinary call stands for a slot of the interval's rent. The judgement is the one the monitor's settlement makes (`recall-judge.js`); the price is the one its report makes (`public/lib/requestPrice.js`) over the usage the measurement admitted for the call, net of the rebuild premium the first real call behind a seal shares with that seal.
// Behind the first seal of an epoch the log shows whole, every main call states its verdict: `pure` where each call of its request is a recall, `other` where one is none and `unknown` where it may still prove one because a call that reads an event of the epoch has been neither dispatched nor answered. The verdict is the judge's alone and independent of the bill, so a recall with no usage or on a seal that recorded no trusted ratio is `pure` all the same; before that seal there is none.
// A recall fact is `{ net }`, the request's bill in read-price units, or `{ net: null }` where the bill is not known: the request is a recall whose usage is missing or whose ratio is no trusted number, or it may still prove one. Either way the call stays an ordinary slot of its interval. A request that is none, or that no seal precedes, states no recall fact, and a later dispatch, block record or answer rewrites the facts on the call it belongs to.
// Pricing needs the seal's chain as the monitor reads it: an attempt record with its quote, the call record that names the attempt, and the carrier that cites that call record; the epoch the attempt began in is the one the carrier lands in.
import { pluginRecordType } from './plugin-record.js';
import { createRecallJudge, judgeOf } from './recall-judge.js';
import { foldInputOf, isMainCall } from './transcript-observation.js';
import { callSeqOf } from '../../inner-seal/carrier.js';
import { ATTEMPT_RECORD_NAME, attemptQuoteOf, isAttemptRecord } from '../../inner-seal/attempt-record.js';
import { CALL_RECORD_NAME, isCallRecord } from '../../inner-seal/call-record.js';
import { startsEpoch } from '../../measurement/source-facts.js';
import { uncachedOf } from '../../measurement/usage.js';
import { rebuildPremiumOf, requestCostOf } from '../../../public/lib/requestPrice.js';

const ATTEMPT_TYPE = pluginRecordType(ATTEMPT_RECORD_NAME);
const CALL_TYPE = pluginRecordType(CALL_RECORD_NAME);

const isTrusted = ratio => Number.isFinite(ratio) && ratio > 0;

// The usage the reducer admitted for the call, the one the measurement holds: null where the call reported none or the reducer refused the whole call, whatever its raw event carries.
const admittedUsageOf = ({ observations }) => observations.find(observation => observation.type === 'usage')?.usage ?? null;

/**
 * The recall facts of one session's Source, fed each event with the input the source fold takes of it (`foldInputOf`) and the source facts as they stood before it (`createSourceFold().facts()`).
 * `push(event, input, facts)` answers the facts the event states, `[{ seq, recall, verdict }]` with `recall` the recall fact the main call at `seq` now has, or null where it has none, and `verdict` its verdict, or null where no seal precedes it: a main call states its own where it has a verdict, an event that is the dispatch, the block record or the answer of a call of the latest main call's request states what that request is now, and any other event states nothing. The source fold keeps a fact only where it differs from the one a call holds.
 * @param {{ sessionId: string }} options
 * @returns {{ push: (event: object, input: { sealed?: number[] }, facts: { epoch: number, carriers: { seq: number, epoch: number, post: ({ seq: number }|null) }[] }) => { seq: number, recall: ({ net: (number|null) }|null), verdict: ('pure'|'other'|'unknown'|null) }[] }}
 */
export function createRecallFacts({ sessionId }) {
  const judge = createRecallJudge({ sessionId });
  // attempt record seq → { epoch, ratio, callSeq }
  const attempts = new Map();
  // call record seq → the attempt it names
  const callAttempt = new Map();
  // The latest seal of the open epoch whose chain the log shows, as `{ carrier, ratio }`.
  let parent = null;
  // The latest main call, with what its fact rests on besides the judge's reading.
  let latest = null;

  // An attempt whose tail is no message is no attempt the monitor shows (`isMessage` in `dsh/src/inner-monitor-read.js`), and the Source prices the chains the monitor shows (`test/dsh.source-driver.test.js` `holds no message tail`).
  function noteRecord(event, facts) {
    if (event.ignorable !== true) return;
    if (event.type === ATTEMPT_TYPE) {
      const tail = event.data?.request?.messages?.tail;
      if (isAttemptRecord(event.data) && Array.isArray(tail?.content)) attempts.set(event.seq, { epoch: facts.epoch, ratio: attemptQuoteOf(event.data)?.cRatio ?? null, callSeq: null });
    } else if (event.type === CALL_TYPE && isCallRecord(event.data)) {
      const attempt = attempts.get(event.data.attempt);
      if (attempt === undefined) return;
      attempt.callSeq = event.seq;
      callAttempt.set(event.seq, event.data.attempt);
    }
  }

  // A carrier of the shape a seal commits whose call record names an attempt of this epoch: a seal the log shows whole.
  function noteCarrier(event, input, facts) {
    if (!Array.isArray(input.sealed) || !Array.isArray(event.data?.source?.slots)) return;
    const attempt = attempts.get(callAttempt.get(callSeqOf(input.sealed)));
    if (attempt !== undefined && attempt.epoch === facts.epoch && attempt.callSeq === callSeqOf(input.sealed)) parent = { carrier: event.seq, ratio: attempt.ratio };
  }

  // The call is the real first one behind its seal: the first main call that followed it, with a usage or without one.
  const isPost = (call, facts) => facts.carriers.find(carrier => carrier.seq === call.parent.carrier)?.post?.seq === call.seq;

  function recallOf(call, facts, verdict) {
    if (verdict === 'unknown') return { net: null };
    if (verdict !== 'pure') return null;
    const { usage, parent: seal } = call;
    if (usage === null || !isTrusted(seal.ratio)) return { net: null };
    const cost = requestCostOf(usage, seal.ratio);
    const net = isPost(call, facts) ? cost - rebuildPremiumOf(uncachedOf(usage), seal.ratio) : cost;
    return Number.isFinite(net) && net >= 0 ? { net } : { net: null };
  }

  // What the call is as a recall behind its seal, and what it cost: none of either before the first seal.
  function factOf(call, facts) {
    if (call.parent === null) return { recall: null, verdict: null };
    const verdict = judgeOf(call.sample);
    return { recall: recallOf(call, facts, verdict), verdict };
  }

  function push(event, input, facts) {
    if (startsEpoch(input)) {
      judge.reset();
      parent = null;
      latest = null;
    }
    noteRecord(event, facts);
    noteCarrier(event, input, facts);
    const judged = judge.push(event);
    if (judged === undefined) return [];
    if (isMainCall(event)) {
      latest = { seq: event.seq, sample: judged.sample, usage: admittedUsageOf(input), parent };
      const fact = factOf(latest, facts);
      return fact.verdict === null ? [] : [{ seq: event.seq, ...fact }];
    }
    return [{ seq: latest.seq, ...factOf(latest, facts) }];
  }

  return { push };
}

/**
 * The input the measurement source fold takes of each event of a DSH session, `foldInputOf` with the recall facts the event states: the one place the Source's recall facts reach the fold, for the DSH Source driver.
 * @param {{ sessionId: string, fold: { facts: () => object } }} options `fold` the source fold the inputs are pushed through
 * @returns {(event: object) => object}
 */
export function createFoldInputs({ sessionId, fold }) {
  const recall = createRecallFacts({ sessionId });
  return (event) => {
    const input = foldInputOf(event);
    const stated = recall.push(event, input, fold.facts());
    return stated.length === 0 ? input : { ...input, recall: stated };
  };
}
