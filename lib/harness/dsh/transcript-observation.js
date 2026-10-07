// lib/harness/dsh/transcript-observation.js — DSH Transcript Observation.
// Reduces one DSH v4 session event to one contiguous batch of canonical Observations in the shapes the
// Claude Code reducer emits, so the shared Dialogue fold and Measurement Projection read a DSH session
// unchanged. The reducer holds no state and reads only the event in hand: call identity, the epoch judgment
// and the replacement judgment are each read off that one event, so the snapshot's replace frame and a
// live append frame reduce it to the same Observations. It is the one place DSH's native usage field
// names are read, and a token fact leaves it only as a usage Observation.

const SCOPE = 'dsh-transcript-observation';
const MESSAGE_NAMESPACE = 'dsh:message:';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;
const isId = value => typeof value === 'string' && value !== '';
const isSurfaceOp = value => value === 'append' || (isObject(value) && value.op === 'replace');

const nothing = () => ({ observations: [], diagnostics: [] });

function violation(event, field) {
  const at = isIndex(event.seq) ? ` at seq ${event.seq}` : '';
  return {
    observations: [],
    diagnostics: [{ scope: SCOPE, code: 'shape-violation', message: `${event.type}${at}: malformed ${field}` }],
  };
}

// A row lists each field it reads beside whether that field holds its DSH shape, and the first that does
// not names the violation. The list is judged whole before any Observation is built, so a malformed event
// yields no partial batch (test/dsh.transcript-observation.test.js `a known type with a broken shape`).
function faultOf(checks) {
  return checks.find(([, holds]) => !holds)?.[0] ?? null;
}

function envelopeChecks(event) {
  return [['seq', isIndex(event.seq)], ['time', Number.isFinite(event.time)]];
}

// The event envelope carries no id of its own, and `seq` is the address `session_event_read` dereferences,
// so it is both the position and the entry identity of every Observation one event yields.
function baseOf(event) {
  return { sourceOrdinal: event.seq, sourceEntryId: String(event.seq), timestamp: event.time };
}

// DSH's block vocabulary is merge-extensible: only the block types a row reads carry a checked shape, and
// any other type — reasoning, an image, one a later DSH adds — passes unread.
const textShaped = block => block.type !== 'text' || typeof block.text === 'string';
const toolCallShaped = block => block.type !== 'tool-call'
  || (isId(block.id) && typeof block.name === 'string' && typeof block.arguments === 'string');

function isContent(content, ...shapes) {
  return Array.isArray(content) && content.every(block => isObject(block) && shapes.every(shaped => shaped(block)));
}

// A message's text is its text blocks end to end; a reasoning block is model output no human addressed, and
// its tokens are in usage (test/dsh.transcript-observation.test.js `reasoning blocks contribute nothing`).
function textOf(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('');
}

// DSH keeps a provider call id unique within one step only — a `tool/result` answers its own step's pending
// call — so the event's turn and step qualify the id into the name of one logical call
// (test/dsh.transcript-observation.test.js `the same provider call id in two steps`).
function callIdOf(turn, step, id) {
  return `${turn}:${step}:${id}`;
}

// The input the tool received: DSH's agent loop hands a tool `{}` for empty arguments, the value of valid
// JSON, and the raw text otherwise (`parseArguments` in `dsh-agent-loop/tool-calls`).
function parseArguments(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

// DSH's accounting for one settled model call, where a cache bucket the provider did not report is absent.
function isUsage(usage) {
  return isObject(usage)
    && Number.isFinite(usage.inputTokens)
    && Number.isFinite(usage.outputTokens)
    && (usage.cacheReadTokens === undefined || Number.isFinite(usage.cacheReadTokens))
    && (usage.cacheWriteTokens === undefined || Number.isFinite(usage.cacheWriteTokens));
}

function usageOf(usage) {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
}

function reduceHumanMessage(event) {
  const { data } = event;
  const fault = faultOf([
    ...envelopeChecks(event),
    ['data.id', isId(data.id)],
    ['data.content', isContent(data.content, textShaped)],
  ]);
  if (fault !== null) return violation(event, fault);
  const base = baseOf(event);
  const observations = [{ type: 'turn-boundary', ...base, provenance: 'human' }];
  const text = textOf(data.content);
  if (text !== '') {
    observations.push({
      type: 'text', role: 'human', text, messageId: MESSAGE_NAMESPACE + data.id, ...base, provenance: 'human',
    });
  }
  return { observations, diagnostics: [] };
}

function reduceCheckpoint(event) {
  if (!isSurfaceOp(event.surfaceOp)) return violation(event, 'surfaceOp');
  if (event.surfaceOp === 'append') return nothing();
  const fault = faultOf(envelopeChecks(event));
  if (fault !== null) return violation(event, fault);
  return { observations: [{ type: 'epoch-boundary', ...baseOf(event), provenance: 'harness' }], diagnostics: [] };
}

// `turn-boundary` both opens a Measurement turn and makes a human text a Dialogue line, so a kind is
// visible exactly where it opens a turn. Every other kind is a harness producer writing into the model's
// own turn, whose tokens are in the next step's usage, and producers declare their kinds as an open set:
// each yields nothing and no diagnostic
// (test/dsh.transcript-observation.test.js `any other user/message kind`).
function reduceUserMessage(event) {
  const kind = event.data?.source?.kind;
  if (kind === 'user') return reduceHumanMessage(event);
  if (kind === 'compact-checkpoint') return reduceCheckpoint(event);
  return typeof kind === 'string' ? nothing() : violation(event, 'data.source.kind');
}

function reduceAssistantMessage(event) {
  const { data } = event;
  const message = data?.message;
  const fault = faultOf([
    ...envelopeChecks(event),
    ['data.turn', isIndex(data?.turn)],
    ['data.step', isIndex(data?.step)],
    ['data.message.id', isId(message?.id)],
    ['data.message.source.model', typeof message?.source?.model === 'string'],
    ['data.message.content', isContent(message?.content, textShaped, toolCallShaped)],
    ['data.usage', data?.usage === undefined || isUsage(data.usage)],
  ]);
  if (fault !== null) return violation(event, fault);
  const base = baseOf(event);
  const messageId = MESSAGE_NAMESPACE + message.id;
  const model = message.source.model;
  const observations = [];
  const text = textOf(message.content);
  if (text !== '') {
    observations.push({ type: 'text', role: 'assistant', text, messageId, ...base, provenance: 'assistant' });
  }
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue;
    observations.push({
      type: 'tool-use',
      messageId,
      model,
      cwd: null,
      toolUseId: callIdOf(data.turn, data.step, block.id),
      name: block.name,
      input: parseArguments(block.arguments),
      ...base,
      provenance: 'assistant',
    });
  }
  if (data.usage !== undefined) {
    observations.push({
      type: 'usage', messageId, model, usage: usageOf(data.usage), ...base, provenance: 'assistant',
    });
  }
  return { observations, diagnostics: [] };
}

function reduceToolResult(event) {
  if (!isSurfaceOp(event.surfaceOp)) return violation(event, 'surfaceOp');
  // A replacement rewrites an earlier result's content rather than answering its call again, and Dialogue
  // pairs a call with its last result, so admitting one would show the pruned text at the replacement's seq
  // (test/dsh.transcript-observation.test.js `a replacement tool result yields nothing`).
  if (event.surfaceOp !== 'append') return nothing();
  const { data } = event;
  const message = data?.message;
  const fault = faultOf([
    ...envelopeChecks(event),
    ['data.turn', isIndex(data?.turn)],
    ['data.step', isIndex(data?.step)],
    ['data.message.toolCallId', isId(message?.toolCallId)],
    ['data.message.isError', message?.isError === undefined || typeof message.isError === 'boolean'],
    ['data.message.content', isContent(message?.content, textShaped)],
  ]);
  if (fault !== null) return violation(event, fault);
  return {
    observations: [{
      type: 'tool-result',
      toolUseId: callIdOf(data.turn, data.step, message.toolCallId),
      content: textOf(message.content),
      isError: message.isError,
      // The tool's private metadata and failure identity ride uninterpreted, as Claude Code's
      // `toolUseResult` does.
      resultMeta: { meta: data.meta ?? null, error: data.error ?? null },
      ...baseOf(event),
      provenance: 'harness',
    }],
    diagnostics: [],
  };
}

/**
 * One DSH session event as one contiguous Observation batch. Every Observation carries the event's `seq` as
 * its `sourceOrdinal`, the same seq as a string as its `sourceEntryId`, and the event's `time` as its
 * `timestamp`.
 *
 * - `user/message` of kind `user`: a `turn-boundary`, then a human `text` when its text blocks join to a
 *   non-empty string; a compact-checkpoint replacement: one `epoch-boundary`; any other kind: nothing.
 * - `assistant/message`: an assistant `text` when its text blocks join to a non-empty string, one `tool-use`
 *   per `tool-call` block, then a `usage` when it carries usage.
 * - `tool/result`: one `tool-result` when appended; a replacement yields nothing.
 * - Every other type, known to DSH or not, yields nothing: an attempt's stream is not read even when it
 *   holds a usage chunk, and neither a request header nor a compaction event is epoch evidence
 *   (test/dsh.transcript-observation.test.js `attempts, tool calls, request headers`).
 *
 * A field a row reads without its DSH shape yields no Observation and one `shape-violation` diagnostic
 * naming the event's type and, when it has one, its seq.
 *
 * @param {object} event - one DSH v4 session event `{ type, seq, time, data, surfaceOp? }`
 * @returns {{ observations: object[], diagnostics: { scope: string, code: string, message: string }[] }}
 */
export function reduceDshEvent(event) {
  switch (event.type) {
    case 'user/message': return reduceUserMessage(event);
    case 'assistant/message': return reduceAssistantMessage(event);
    case 'tool/result': return reduceToolResult(event);
    default: return nothing();
  }
}

/**
 * A whole snapshot's events reduced one by one: the batch of each event that yields Observations, in event
 * order; those batches flattened; and every event's diagnostics, in event order.
 *
 * @param {object[]} events - DSH v4 session events in log order
 * @returns {{ batches: object[][], observations: object[], diagnostics: object[] }}
 */
export function reduceDshSnapshot(events) {
  const batches = [];
  const diagnostics = [];
  for (const event of events) {
    const reduced = reduceDshEvent(event);
    if (reduced.observations.length > 0) batches.push(reduced.observations);
    diagnostics.push(...reduced.diagnostics);
  }
  return { batches, observations: batches.flat(), diagnostics };
}
