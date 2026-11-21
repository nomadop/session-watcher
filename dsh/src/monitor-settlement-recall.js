// The closed-epoch report reads recall evidence without storing a projection or changing the session surface.
import { eventReadTargetOf } from '../../lib/harness/dsh/event-read.js';
import { eventFactOf } from '../../lib/harness/dsh/event-facts.js';
import { callUsageOf, isMainCall } from '../../lib/harness/dsh/transcript-observation.js';
import { isCallRecord } from '../../lib/inner-seal/call-record.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { charsToTokens } from '../../lib/token-estimate.js';

const stepKey = ({ turn, step } = {}) => `${turn}:${step}`;
const pureRecall = ({ tools, marked }) => marked.size > 0 && tools.every(({ id }) => marked.has(id));

// The report counts distinct steps in each committed range, then main calls of the tail. A sample outside those counts must not move a correction to another step.
function reportPositions(seals, samples, tailCalls) {
  const positions = new Map();
  let offset = 0;
  for (const { attempt, range } of seals.values()) {
    const steps = new Map();
    for (const seq of range) {
      const sample = samples.get(seq);
      if (sample?.counted) steps.set(stepKey(sample.event.data), seq);
    }
    const n = attempt.quote?.n ?? 0;
    if (steps.size === n) for (const seq of steps.values()) positions.set(seq, offset += 1);
    else offset += n;
  }
  const lastCarrier = [...seals.keys()].at(-1);
  const tail = [...samples.values()].filter(({ event, counted }) => counted && event.seq > lastCarrier);
  if (tail.length === tailCalls) for (const { event } of tail) positions.set(event.seq, offset += 1);
  return positions;
}

/** Report evidence only: a pure request's usage and recorded ratio, the returned copies in other requests, and the copies already reflected in each seal's stock delta. An unplaceable step leaves the report partial. */
export function settlementRecallOf({ events, log, attempts, postByAttempt, tailCalls, sessionId, isNoise }) {
  const seals = new Map(attempts.map(attempt => {
    const call = log.get(attempt.call?.seq)?.data;
    return [attempt.carrier.seq, { attempt, range: isCallRecord(call) ? call.range : [] }];
  }));
  if (seals.size === 0) return undefined;
  const starts = new Set(attempts.map(({ id }) => id));
  const samples = new Map();
  const before = new Map();
  const active = new Map();
  let ctp;
  let lastMeasured;
  let seal;
  let sample;
  for (const event of events) {
    const { seq, type, data } = event;
    if (starts.has(seq)) before.set(seq, lastMeasured);
    if (seals.has(seq)) {
      seal = seals.get(seq);
      for (const replaced of seal.range) active.delete(replaced);
      lastMeasured = undefined;
    }
    if (isMainCall(event)) {
      const usage = callUsageOf(data?.usage);
      if (usage !== null) ctp ??= modelPolicyFor(data?.message?.source?.model).ctp;
      const resident = [...active.values()].reduce((sum, tokens) => sum + tokens, 0);
      const content = data?.message?.content;
      const tools = Array.isArray(content) ? content.filter(block => block?.type === 'tool-call') : [];
      sample = { event, counted: eventFactOf(event).step !== null, usage, resident, seal: seal?.attempt, tools, marked: new Set() };
      if (!isNoise(event)) lastMeasured = usage === null ? undefined : sample;
      samples.set(seq, sample);
    }
    if (seal === undefined || sample === undefined) continue;
    if (type === 'tool/call' && stepKey(data) === stepKey(sample.event.data) && sample.tools.some(({ id }) => id === data.callId)) {
      const target = eventReadTargetOf(data);
      if (target && (target.sessionId === undefined || target.sessionId === sessionId)
        && target.seq >= events[0].seq && target.seq < sample.event.seq && log.has(target.seq)) sample.marked.add(data.callId);
    }
    if (type === 'tool/result') {
      const op = event.surfaceOp;
      const replaced = op?.op === 'replace' && op.startSeq === op.endSeq && active.delete(op.startSeq);
      // A failed read returns no copy of its target, a refusal of a held one included.
      const returned = op === 'append' && data.message?.isError !== true && stepKey(data) === stepKey(sample.event.data) && sample.marked.has(data.message?.toolCallId);
      if (!replaced && !returned) continue;
      const content = data.message?.content;
      const text = Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
      const tokens = charsToTokens(text, ctp ?? modelPolicyFor().ctp);
      if (tokens > 0) active.set(seq, tokens);
    }
  }
  const cuts = attempts.flatMap(({ id }) => {
    const pre = before.get(id);
    // The before reading includes generated output; pure recall output is absent from the baseline.
    const output = pre && pureRecall(pre) ? pre.usage.output : 0;
    const tokens = (pre?.resident ?? 0) + output - (samples.get(postByAttempt.get(id))?.resident ?? 0);
    return tokens === 0 ? [] : [{ id, tokens }];
  });
  const steps = [];
  let partial = false;
  const positions = reportPositions(seals, samples, tailCalls);
  for (const sample of samples.values()) {
    const { event, counted, usage, resident, seal: parent } = sample;
    const pure = pureRecall(sample);
    if (!counted || (!pure && resident === 0)) continue;
    const { seq } = event;
    const at = positions.get(seq);
    if (at === undefined) { partial = true; continue; }
    if (pure) {
      const ratio = parent?.quote?.cRatio ?? null;
      const post = postByAttempt.get(parent?.id) === seq ? parent.id : undefined;
      steps.push({ at, seq, usage, ratio, ...(post === undefined ? {} : { post }) });
    } else {
      steps.push({ at, seq, resident });
    }
  }
  return steps.length === 0 && cuts.length === 0 && !partial ? undefined : { steps, cuts, ...(partial ? { partial } : {}) };
}
