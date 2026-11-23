// The closed-epoch report reads recall evidence without storing a projection or changing the session surface.
import { eventFactOf } from '../../lib/harness/dsh/event-facts.js';
import { callUsageOf, isMainCall } from '../../lib/harness/dsh/transcript-observation.js';
import { createRecallJudge, isInitiated, judgeOf, stepKey } from '../../lib/harness/dsh/recall-judge.js';
import { isCallRecord } from '../../lib/inner-seal/call-record.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { charsToTokens } from '../../lib/token-estimate.js';

// The report counts distinct steps in each committed range, then main calls of the tail. A sample outside those counts must not move a correction to another step.
// `landing` is the step a step key counts as, `sealAt` the step each carrier stands after, and `covered` whether every counted step after the first carrier was placed by a range or the tail that the counts prove.
function reportPositions(seals, samples, tailCalls) {
  const positions = new Map();
  const landing = new Map();
  const sealAt = new Map();
  let offset = 0;
  let proved = true;
  for (const [carrier, { attempt, range }] of seals) {
    const steps = new Map();
    for (const seq of range) {
      const sample = samples.get(seq);
      if (sample?.counted) steps.set(stepKey(sample.event.data), seq);
    }
    const n = attempt.quote?.n ?? 0;
    if (steps.size === n) {
      for (const [key, seq] of steps) {
        positions.set(seq, offset += 1);
        landing.set(key, offset);
      }
    } else {
      offset += n;
      if (sealAt.size > 0) proved = false;
    }
    sealAt.set(carrier, offset);
  }
  const lastCarrier = [...seals.keys()].at(-1);
  const tail = [...samples.values()].filter(({ counted, event }) => counted && event.seq > lastCarrier);
  if (tail.length === tailCalls) {
    for (const { event } of tail) {
      positions.set(event.seq, offset += 1);
      landing.set(stepKey(event.data), offset);
    }
  } else {
    proved = false;
  }
  const firstCarrier = seals.keys().next().value;
  const covered = proved && [...samples.values()].every(({ counted, event }) => !counted || event.seq <= firstCarrier || positions.has(event.seq));
  return { positions, landing, sealAt, covered };
}

// The step an original event stands on: the one that owns it, or the line of the seal whose carrier it is; none where the log gives it neither.
const placeOf = (seq, owners, { landing, sealAt }) => sealAt.get(seq) ?? landing.get(owners.get(seq)) ?? null;

/**
 * What a segment's log shows of recall, as `{ recall?, activity? }`, both absent where the segment holds no committed seal. The cut is the caller's: `events` are the segment's up to it.
 * `recall` is report evidence only: a pure request's usage and recorded ratio, the returned copies in other requests, and the copies already reflected in each seal's stock delta. An unplaceable step leaves the report partial.
 * `activity` is `{ covered, judged, pure, targets }`: the settlement steps after the first seal that are judged (a request that is a recall or is none, never one still unknown) and the pure recall ones among them, the share's terms; `covered` whether the counts prove every counted step after the first seal placed. `targets` are the originals the pure requests after the first seal read, ascending by seq, `{ seq, type, at, reads }`: `at` the step the original stands on where the log says so, else null, and `reads` the steps that read it, once each, `{ at, seq }` with the request's own seq. A pure request placed on no step still names its targets, with no read.
 */
export function settlementRecallOf({ events, log, attempts, postByAttempt, tailCalls, sessionId, isNoise }) {
  const seals = new Map(attempts.map(attempt => {
    const call = log.get(attempt.call?.seq)?.data;
    return [attempt.carrier.seq, { attempt, range: isCallRecord(call) ? call.range : [] }];
  }));
  if (seals.size === 0) return {};
  const starts = new Set(attempts.map(({ id }) => id));
  const samples = new Map();
  const before = new Map();
  const active = new Map();
  const owners = new Map();
  let ctp;
  let lastMeasured;
  let seal;
  let sample;
  let open = null;
  const judge = createRecallJudge({ sessionId });
  for (const event of events) {
    const { seq, type, data } = event;
    if (starts.has(seq)) before.set(seq, lastMeasured);
    if (seals.has(seq)) {
      seal = seals.get(seq);
      for (const replaced of seal.range) active.delete(replaced);
      lastMeasured = undefined;
    }
    // The step an event is the loop's own is the one its data names; a message admitted after `step/start` and before `step/end` is the step's.
    if (type === 'step/start') open = stepKey(data);
    else if (type === 'step/end') open = null;
    else if (type === 'user/message' && eventFactOf(event).marker === null && open !== null) owners.set(seq, open);
    else if (type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') {
      if (Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)) owners.set(seq, stepKey(data));
    }
    // The judge follows the dispatches and answers of a request from the first seal on.
    const judged = judge.push(event, { track: seal !== undefined });
    if (isMainCall(event)) {
      const usage = callUsageOf(data?.usage);
      if (usage !== null) ctp ??= modelPolicyFor(data?.message?.source?.model).ctp;
      const resident = [...active.values()].reduce((sum, tokens) => sum + tokens, 0);
      const { tools, calls } = judged.sample;
      sample = { event, counted: eventFactOf(event).step !== null, usage, resident, seal: seal?.attempt, tools, calls };
      if (!isNoise(event)) lastMeasured = usage === null ? undefined : sample;
      samples.set(seq, sample);
    }
    if (seal === undefined || sample === undefined) continue;
    if (type === 'tool/result') {
      const op = event.surfaceOp;
      const call = judged.call;
      const replaced = op?.op === 'replace' && op.startSeq === op.endSeq && active.delete(op.startSeq);
      // A failed read returns no copy of its target, a refusal of a held one included.
      const returned = op === 'append' && data.message?.isError !== true && call !== undefined && isInitiated(call);
      if (!replaced && !returned) continue;
      const content = data.message?.content;
      const text = Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
      const tokens = charsToTokens(text, ctp ?? modelPolicyFor().ctp);
      if (tokens > 0) active.set(seq, tokens);
    }
  }
  // A request is judged once, where the log up to the cut is whole: the dispatches and answers of its calls come after it. Pricing, the copies a seal withdraws, the share and the targets read this verdict alone.
  for (const sample of samples.values()) sample.verdict = judgeOf(sample);
  const cuts = attempts.flatMap(({ id }) => {
    const pre = before.get(id);
    // The before reading includes generated output; pure recall output is absent from the baseline.
    const output = pre?.verdict === 'pure' ? pre.usage.output : 0;
    const tokens = (pre?.resident ?? 0) + output - (samples.get(postByAttempt.get(id))?.resident ?? 0);
    return tokens === 0 ? [] : [{ id, tokens }];
  });
  const steps = [];
  let partial = false;
  const axis = reportPositions(seals, samples, tailCalls);
  const { positions } = axis;
  const reads = new Map();
  let judged = 0;
  let pure = 0;
  for (const sample of samples.values()) {
    const { event, counted, usage, resident, seal: parent, verdict } = sample;
    const { seq } = event;
    const at = positions.get(seq);
    if (counted && parent !== undefined) {
      if (verdict === 'pure') {
        for (const { id } of sample.tools) {
          const { target } = sample.calls.get(id);
          const landings = reads.get(target) ?? new Map();
          reads.set(target, landings);
          if (at !== undefined) landings.set(at, { at, seq });
        }
      }
      if (at !== undefined && verdict !== 'unknown') {
        judged += 1;
        if (verdict === 'pure') pure += 1;
      }
    }
    if (!counted || (verdict !== 'pure' && resident === 0)) continue;
    if (at === undefined) { partial = true; continue; }
    if (verdict === 'pure') {
      const ratio = parent?.quote?.cRatio ?? null;
      const post = postByAttempt.get(parent?.id) === seq ? parent.id : undefined;
      steps.push({ at, seq, usage, ratio, ...(post === undefined ? {} : { post }) });
    } else {
      steps.push({ at, seq, resident });
    }
  }
  const targets = [...reads].sort(([a], [b]) => a - b).map(([seq, landings]) => ({
    seq, type: log.get(seq).type, at: placeOf(seq, owners, axis), reads: [...landings.values()].sort((a, b) => a.at - b.at),
  }));
  const recall = steps.length === 0 && cuts.length === 0 && !partial ? undefined : { steps, cuts, ...(partial ? { partial } : {}) };
  return { recall, activity: { covered: axis.covered, judged, pure, targets } };
}
