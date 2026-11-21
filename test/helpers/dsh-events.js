// test/helpers/dsh-events.js — synthetic DSH session events in the v4 log shape, for the sequences the local
// corpus lacks. Every event builder stamps the next `seq` of one running counter and a `time` that advances with it,
// so an event is well-formed on its own and events keep their build order; `sessionLog` renumbers a list into a log
// from zero. A seq-valued argument names the referenced event's own `seq`, which `sessionLog` carries along with it.

import { carryChanges, foldCarried } from '../../lib/carried-evidence.js';

const T0 = Date.UTC(2026, 8, 27);
const TICK_MS = 1000;
const PROVIDER = 'deepseek';
const MODEL = 'deepseek-v4-pro';

let cursor = 0;

function stamp() {
  const seq = cursor++;
  return { seq, time: T0 + seq * TICK_MS };
}

const messageId = seq => `message-${seq}`;
const textBlocks = text => (text === undefined ? [] : [{ type: 'text', text }]);

/**
 * The log's header line, `{ type: 'session', version: 4, id, createdAt, cwd, parentSession?, isSeeded: false,
 * origin?, delegationDepth }`; `delegationDepth` defaults to the depth of a top-level session's direct child when
 * `origin` is `'subagent'` and to a top-level session's depth otherwise.
 */
export function header({
  id = 'session-synthetic', cwd = '/repo', parentSession, origin, delegationDepth = origin === 'subagent' ? 1 : 0,
} = {}) {
  return {
    type: 'session', version: 4, id, createdAt: T0, cwd,
    ...(parentSession === undefined ? {} : { parentSession }),
    isSeeded: false,
    ...(origin === undefined ? {} : { origin }),
    delegationDepth,
  };
}

/** A `turn/start` opening turn `turn`. */
export function turnStart({ turn = 1 } = {}) {
  return { type: 'turn/start', ...stamp(), data: { turn } };
}

/** A `step/start` opening step `step` of turn `turn`. */
export function stepStart({ turn = 1, step = 1 } = {}) {
  return { type: 'step/start', ...stamp(), data: { turn, step } };
}

/** A `step/end` closing step `step` of turn `turn`. */
export function stepEnd({ turn = 1, step = 1 } = {}) {
  return { type: 'step/end', ...stamp(), data: { turn, step } };
}

/** A `turn/end` closing turn `turn` for `reason`, a completion unless given. */
export function turnEnd({ turn = 1, reason = { kind: 'completed' } } = {}) {
  return { type: 'turn/end', ...stamp(), data: { turn, reason } };
}

/**
 * An appended `user/message`, whose `data` is the message itself: `{ content, source: { kind, form? }, role: 'user',
 * id }`, the content one text block when `text` is given and empty otherwise.
 */
export function userMessage({ text, kind = 'user', form } = {}) {
  const { seq, time } = stamp();
  return {
    type: 'user/message', seq, time,
    data: {
      content: textBlocks(text), source: { kind, ...(form === undefined ? {} : { form }) }, role: 'user',
      id: messageId(seq),
    },
    surfaceOp: 'append',
  };
}

/**
 * A `system/message`, the surface head DSH renders the system prompt into: `{ turn, step, message }`, the message
 * `{ role: 'system', content, source: { kind: 'system-prompt' }, id }` under `data.message`, appended to the surface.
 */
export function systemMessage({ text = 'You are a coding agent.', turn = 1, step = 1 } = {}) {
  const { seq, time } = stamp();
  return {
    type: 'system/message', seq, time,
    data: {
      turn, step,
      message: { role: 'system', content: textBlocks(text), source: { kind: 'system-prompt' }, id: messageId(seq) },
    },
    surfaceOp: 'append',
  };
}

/**
 * A `system/message` that replaces the surface node `seq` in place, as the loop normalizes the head when the rendered prompt changes: the same `data` shape as {@link systemMessage}, the surface op `{ op: 'replace', startSeq: seq, endSeq: seq }`, `sourceEventSeqs: [seq]`.
 */
export function systemReplacement({ seq, text = 'You are a coding agent.', turn = 1, step = 1 } = {}) {
  return { ...systemMessage({ text, turn, step }), surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] };
}

/**
 * The appended `developer/message` of the `tool-registry` source the loop logs when the request header's tools differ from the baseline: one `tool-addition` block per name of `additions` and one `tool-removal` block per name of `removals`, and `headerSeq`, the changed header's own `seq`, exactly when there are additions.
 */
export function toolRegistryMessage({ additions = [], removals = [], headerSeq, turn = 1, step = 1 } = {}) {
  const { seq, time } = stamp();
  return {
    type: 'developer/message', seq, time,
    data: {
      turn, step,
      message: {
        role: 'developer',
        content: [...additions.map(toolName => ({ type: 'tool-addition', toolName })), ...removals.map(toolName => ({ type: 'tool-removal', toolName }))],
        source: { kind: 'tool-registry' }, id: messageId(seq),
      },
      ...additions.length > 0 ? { headerSeq } : {},
    },
    surfaceOp: 'append',
  };
}

/**
 * An appended `assistant/message` in step `step` of turn `turn`: `{ turn, step, message, usage?, stream: [],
 * interrupted? }`. The message's content is a text block when `text` is given, then one `tool-call` block per entry
 * of `toolCalls` (`arguments` the raw JSON string, `'{}'` unless given); its source is `{ kind: 'model', provider,
 * model }`. `usage` is DSH's token usage exactly as given, absent when omitted.
 */
export function assistantMessage({
  text, toolCalls = [], usage, model = MODEL, interrupted = false, turn = 1, step = 1,
} = {}) {
  const { seq, time } = stamp();
  const content = [
    ...textBlocks(text),
    ...toolCalls.map(({ id, name, arguments: args = '{}' }) => ({ type: 'tool-call', id, name, arguments: args })),
  ];
  return {
    type: 'assistant/message', seq, time,
    data: {
      turn, step,
      message: { role: 'assistant', content, source: { kind: 'model', provider: PROVIDER, model }, id: messageId(seq) },
      ...(usage === undefined ? {} : { usage }),
      stream: [],
      ...(interrupted ? { interrupted: true } : {}),
    },
    surfaceOp: 'append',
  };
}

/** A `tool/call`, the model's request as the loop logs it: `{ turn, step, callId, name, arguments }`. */
export function toolCall({ callId, name, arguments: args = '{}', turn = 1, step = 1 } = {}) {
  return { type: 'tool/call', ...stamp(), data: { turn, step, callId, name, arguments: args } };
}

/**
 * A `tool/result`: `{ turn, step, message, error?, meta? }`, the message `{ role: 'tool', source: { kind: 'tool',
 * callId }, toolCallId, content, isError, id }` whose content is one text block when `text` is given; `surfaceOp` is
 * an append unless given.
 */
export function toolResult({
  callId, text, isError = false, error, meta, surfaceOp = 'append', turn = 1, step = 1,
} = {}) {
  const { seq, time } = stamp();
  return {
    type: 'tool/result', seq, time,
    data: {
      turn, step,
      message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: textBlocks(text), isError,
        id: messageId(seq),
      },
      ...(error === undefined ? {} : { error }),
      ...(meta === undefined ? {} : { meta }),
    },
    surfaceOp,
  };
}

/**
 * An `assistant/attempt`, a model attempt that committed no message: `{ turn, step, stream }`, the stream holding a
 * raw `usage` chunk when `usageChunk` is given and a raw `finish` chunk for the `finish` reason when that is.
 */
export function attempt({ usageChunk, finish, turn = 1, step = 1 } = {}) {
  const { seq, time } = stamp();
  const stream = [
    ...(usageChunk === undefined ? [] : [{ type: 'chunk', time, chunk: { type: 'usage', usage: usageChunk } }]),
    ...(finish === undefined ? [] : [{ type: 'chunk', time, chunk: { type: 'finish', reason: finish } }]),
  ];
  return { type: 'assistant/attempt', seq, time, data: { turn, step, stream } };
}

/** An `llm/retry` scheduling retry `retry` of the step's request after `failure`, in the normal retry mode. */
export function llmRetry({
  retryId = 'retry-1', retry = 1, failure = { message: 'request failed', code: 'PI_AI_ERROR' }, turn = 1, step = 1,
} = {}) {
  return {
    type: 'llm/retry', ...stamp(),
    data: {
      retryId, turn, step, provider: PROVIDER, mode: 'normal', policyKey: PROVIDER, retry, maxRetries: 5, delayMs: 500,
      failure,
    },
  };
}

/** The `llm/retry-started` that ends retry `retry`'s wait, just before the retried attempt. */
export function llmRetryStarted({ retryId = 'retry-1', retry = 1, turn = 1, step = 1 } = {}) {
  return { type: 'llm/retry-started', ...stamp(), data: { retryId, turn, step, retry } };
}

/** A `request/header` for the next request: `{ header: { config: { provider, model } }, reason, startsSeries? }`. */
export function requestHeader({ reason = 'initial', startsSeries = false, model = MODEL } = {}) {
  return {
    type: 'request/header', ...stamp(),
    data: {
      header: { config: { provider: PROVIDER, model } }, reason, ...(startsSeries ? { startsSeries: true } : {}),
    },
  };
}

/** A `request/context` naming the route of the next request: `{ provider, model, contextWindow }`. */
export function requestContext({ model = MODEL, contextWindow = 1_000_000 } = {}) {
  return { type: 'request/context', ...stamp(), data: { provider: PROVIDER, model, contextWindow } };
}

/**
 * An appended `user/message` of the plugin's load kind, written out in the shape `/sw-load` hands the model:
 * `{ content, source: { kind: 'session-watcher-load', route, calls }, role: 'user', id }`, one text block per entry
 * of `calls` holding its `text`, and each call `{ id, name, arguments }`.
 */
export function loadMessage({
  route = { provider: PROVIDER, model: MODEL },
  calls = [{ id: 'sw-load-0000aaaa-1', name: 'load_handoff', arguments: '{}', text: '{"found":true}' }],
  paths,
} = {}) {
  const { seq, time } = stamp();
  return {
    type: 'user/message', seq, time,
    data: {
      content: calls.map(({ text }) => ({ type: 'text', text })),
      source: {
        kind: 'session-watcher-load', route,
        calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
        ...(paths === undefined ? {} : { paths }),
      },
      role: 'user',
      id: messageId(seq),
    },
    surfaceOp: 'append',
  };
}

/**
 * The payload message of a `/sw-load` or the load a `/sw-continue` makes: a load message holding the one `load_handoff` call, whose text is the delivery's JSON
 * `{ found, handoff_id, load_token, created_at, summary, paths_to_keep, skills_to_keep?, lineage?, turn_page? }`. A `null` `handoffId` and an `undefined` `skills`, `lineage` or `turnPage` leave their field out; `text` replaces the whole JSON.
 */
export function loadPayload({
  token = 'amber-falcon', handoffId = 7, createdAt = T0 - 3 * 3600_000, summary = 'The summary of the prepared handoff.', paths = [],
  skills, lineage, turnPage, text,
} = {}) {
  const payload = {
    found: true,
    ...(handoffId === null ? {} : { handoff_id: handoffId }),
    load_token: token, created_at: createdAt, summary, paths_to_keep: paths,
    ...(skills === undefined ? {} : { skills_to_keep: skills }),
    ...(lineage === undefined ? {} : { lineage }),
    ...(turnPage === undefined ? {} : { turn_page: turnPage }),
  };
  return loadMessage({ calls: [{ id: 'sw-load-0000aaaa-0', name: 'load_handoff', arguments: JSON.stringify({ load_token: token }), text: text ?? JSON.stringify(payload) }] });
}

/**
 * The read message of a load: one `read` call per entry of `files`, each `{ path, displayPath, ranges, text, totalLines, windows }`, its arguments the logical `{ file_path, ranges }`, its text the rendering and `displayPath` (the path by default) the path the rendering names. The source's `paths` state the lines `windows` hold, `[{ offset, lines: [{ number, text }] }]`, of a file of `totalLines` lines, as the read message of a load carries them.
 */
export function loadReads({
  files = [{
    path: '/repo/src/a.js', ranges: [{ offset: 1, limit: 2 }], text: '/repo/src/a.js (total lines: 2)\n1: a\n2: b\n',
    totalLines: 2, windows: [{ offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] }],
  }],
} = {}) {
  const view = { paths: new Map(files.map(({ path, displayPath = path, totalLines, windows }) => [path, { displayPath, read: { status: 'readable', totalLines, windows } }])), skills: new Map() };
  return loadMessage({
    calls: files.map(({ path, ranges, text }, index) => ({
      id: `sw-load-0000aaaa-${index + 1}`, name: 'read', arguments: JSON.stringify({ file_path: path, ranges }), text,
    })),
    paths: carryChanges(foldCarried([]), view).paths,
  });
}

/** The follow-up user message that wakes the model on a loaded handoff, opening with the sentence that names `token`. */
export function loadFollowUp({ token = 'amber-falcon', rest = 'The harness placed two messages before this one.' } = {}) {
  return userMessage({ text: `Handoff "${token}" is loaded. ${rest}` });
}

/** The compact-checkpoint of a `/sw-continue` clear, as the command writes it: the one text block naming `token`. */
export function continueCheckpoint({ token = 'amber-falcon', startSeq = 0, endSeq = 0 } = {}) {
  return compactCheckpoint({ startSeq, endSeq, text: `[Session Watcher] Context cleared by /sw-continue. Handoff token: ${token}` });
}

/**
 * The inner-seal carrier `user/message`: the summary as one text block, source `{ kind: 'session-watcher-inner-seal' }`
 * (given `slots`, the seal's own `{ kind, v: 1, slots, paths: [] }` with `changes`, the `paths`, `removed` and `skills`
 * of B, laid over it), replacing the surface from `startSeq` through `endSeq`
 * (the least and the greatest of `sourceEventSeqs` unless given) and citing `sourceEventSeqs`, the events it
 * withdraws; the seal lists its call record first.
 */
export function innerSealCarrier({
  sourceEventSeqs, startSeq = Math.min(...sourceEventSeqs), endSeq = Math.max(...sourceEventSeqs), text = 'sealed',
  slots, changes = {},
} = {}) {
  const { seq, time } = stamp();
  return {
    type: 'user/message', seq, time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'session-watcher-inner-seal', ...(slots === undefined ? {} : { v: 1, slots, paths: [], ...changes }) },
      role: 'user',
      id: messageId(seq),
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs,
  };
}

// The C tail the summary request ends with: one user message holding the instruction as one text block.
const summaryTail = text => ({ role: 'user', content: textBlocks(text) });

/*
 * The three plugin records the inner monitor's attempt leaves, as `appendPluginRecord` leaves them: ignorable events
 * whose data the monitor owns. Their seq-valued data (`attempt`, a range) names the final seq of an event, which
 * `sessionLog` does not follow, so a log of them is built from the events as they are, or written with the addresses
 * the renumbered log will have.
 */

/**
 * The `inner-attempt` record, appended as an attempt's summary request is dispatched: `{ v: 1, range: { first, last,
 * count }, request }` over `range`, the seqs the attempt summarizes, its request showing the C tail as one user
 * message holding `tail`. `request` adds to the request display, a key it names replacing the key as shown here.
 * `quote`, the `innerQuote` snapshot the seal triggered on, is kept when given; a record without one has the shape of
 * one written before the quote.
 */
export function innerAttempt({ range = [3, 4, 5], tail = 'Write concise continuity notes.', request = {}, quote } = {}) {
  return ignorableEvent({
    type: 'plugin:session-watcher/inner-attempt',
    data: {
      v: 1,
      ...(quote === undefined ? {} : { quote }),
      range: { first: range[0], last: range.at(-1), count: range.length },
      request: {
        options: { provider: PROVIDER, model: MODEL, purpose: 'inner-compaction', sessionId: 'session-synthetic' },
        messages: { count: 1, tail: summaryTail(tail) },
        throughSeq: range.at(-1),
        headerSeq: null,
        ...request,
      },
    },
  });
}

/**
 * The `inner-call` record of an auxiliary call whose stream was consumed: `{ v: 1, purpose, selection, input, range,
 * stream, endedAt?, thrown?, attempt? }`, `stream` its compact stream. `attempt`, the seq of the attempt's record, and
 * `endedAt` are the fields an attempt with an attempt record adds; a call without them has the shape of one written
 * before the monitor. `thrown` is the message of an error thrown while the stream was consumed or assembled.
 * `carrierCache`, the evidence of the opt-in pi-ai entry's payload hook, is a field a call carries only where the hook reported.
 */
export function innerCall({ range = [3, 4, 5], tail = 'Write concise continuity notes.', stream = [], attempt: began, endedAt, thrown, carrierCache } = {}) {
  return ignorableEvent({
    type: 'plugin:session-watcher/inner-call',
    data: {
      v: 1, purpose: 'inner-compaction', selection: { provider: PROVIDER, model: MODEL },
      input: { throughSeq: range.at(-1), headerSeq: null, tail: summaryTail(tail) },
      range, stream,
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(thrown === undefined ? {} : { thrown: { message: thrown } }),
      ...(began === undefined ? {} : { attempt: began }),
      ...(carrierCache === undefined ? {} : { carrierCache }),
    },
  });
}

/** The `inner-end` record of an attempt that failed or was cancelled: `{ v: 1, attempt, outcome, reason }`. */
export function innerEnd({ attempt: began, outcome = 'failed', reason = 'the summary failed' } = {}) {
  return ignorableEvent({ type: 'plugin:session-watcher/inner-end', data: { v: 1, attempt: began, outcome, reason } });
}

/** A `compaction/start` taking the compaction lock inside turn `turn`. */
export function compactionStart({ compactionId = 'compaction-1', turn = 1 } = {}) {
  return { type: 'compaction/start', ...stamp(), data: { compactionId, turn } };
}

/** A `compaction/summary` carrying the summary as one text block and pricing the surface nodes `shadowedSeqs`. */
export function compactionSummary({ compactionId = 'compaction-1', text = 'summary', shadowedSeqs = [0] } = {}) {
  return {
    type: 'compaction/summary', ...stamp(),
    data: {
      compactionId, summary: [{ type: 'text', text }],
      shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) }, shadowedSeqs, shadowedTokenCount: 1000,
      provider: PROVIDER, model: MODEL,
    },
  };
}

/**
 * The compact-checkpoint `user/message` a successful compaction appends: the summary as one text block, source
 * `{ kind: 'compact-checkpoint', compactionId }`, replacing the surface from `startSeq` through `endSeq` and citing
 * every seq of that range.
 */
export function compactCheckpoint({ startSeq = 0, endSeq = 0, compactionId = 'compaction-1', text = 'summary' } = {}) {
  const { seq, time } = stamp();
  return {
    type: 'user/message', seq, time,
    data: {
      content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint', compactionId }, role: 'user',
      id: messageId(seq),
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: Array.from({ length: endSeq - startSeq + 1 }, (_, offset) => startSeq + offset),
  };
}

/** A `compaction/end` releasing the lock; an `error` records the compaction as failed. */
export function compactionEnd({ compactionId = 'compaction-1', turn = 1, error } = {}) {
  return {
    type: 'compaction/end', ...stamp(), data: { compactionId, turn, ...(error === undefined ? {} : { error }) },
  };
}

/** The `compaction/prune` pricing the replacement of `original`, the tool result a prune shadows. */
export function compactionPrune(original, { shadowedTokenCount = 1000 } = {}) {
  return {
    type: 'compaction/prune', ...stamp(),
    data: {
      shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], shadowedTokenCount,
    },
  };
}

/**
 * The replacement row a prune appends for `original`: the original's `data` with only the message content swapped
 * for `text`, replacing and citing the surface node at the original's seq.
 */
export function prunedResult(original, { text = 'pruned' } = {}) {
  return {
    type: 'tool/result', ...stamp(),
    data: { ...original.data, message: { ...original.data.message, content: [{ type: 'text', text }] } },
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq],
  };
}

/** An event of a type the reducer table has no row for. */
export function unknownEvent({ type = 'plugin/unknown', data = {} } = {}) {
  return { type, ...stamp(), data };
}

/** An external event marked `ignorable: true`, which a reader that does not know its type may skip. */
export function ignorableEvent({ type = 'plugin/note', data = {} } = {}) {
  return { type, ...stamp(), data, ignorable: true };
}

/**
 * The events as one log, as new event objects: `seq` renumbered from zero in list order, and every seq reference
 * among them — a replacement's surface range and cited seqs, a compaction's shadowed seqs, a tool-registry message's
 * header — following the event it names. A reference to an event outside the list keeps its value.
 */
export function sessionLog(events) {
  const renumbered = new Map(events.map((event, index) => [event.seq, index]));
  const follow = seq => renumbered.get(seq) ?? seq;
  return events.map((event, index) => {
    const next = { ...event, seq: index };
    if (event.surfaceOp?.op === 'replace') {
      next.surfaceOp = {
        ...event.surfaceOp, startSeq: follow(event.surfaceOp.startSeq), endSeq: follow(event.surfaceOp.endSeq),
      };
    }
    if (Array.isArray(event.sourceEventSeqs)) next.sourceEventSeqs = event.sourceEventSeqs.map(follow);
    if (Number.isInteger(event.data?.headerSeq)) next.data = { ...event.data, headerSeq: follow(event.data.headerSeq) };
    if (Array.isArray(event.data?.shadowedSeqs)) {
      const { shadowedRange, shadowedSeqs } = event.data;
      next.data = {
        ...event.data,
        shadowedRange: { start: follow(shadowedRange.start), end: follow(shadowedRange.end) },
        shadowedSeqs: shadowedSeqs.map(follow),
      };
    }
    return next;
  });
}

// DSH's `read` result for a whole file: the model-visible envelope and the line window its `meta` persists.
function readResult({ callId, path, lines, turn = 1, step = 1 }) {
  const numbered = lines.map((text, index) => ({ number: index + 1, text }));
  const body = numbered.map(line => `${line.number}: ${line.text}`).join('\n');
  return toolResult({
    callId, turn, step,
    text: `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n(End of file - total ${lines.length} lines)\n`
      + '</content>',
    meta: { path, offset: 1, lines: numbered, totalLines: lines.length },
  });
}

const readArguments = path => JSON.stringify({ file_path: path });

const ASK_ARGUMENTS = JSON.stringify({
  questions: [{ id: 'plan', question: 'Which release plan?', options: [{ label: 'Ship now' }, { label: 'Wait' }] }],
});

/**
 * One turn whose compaction between its steps fails: `compaction/start`, then `compaction/end` with an error, and
 * no summary or checkpoint between them.
 */
export function compactionFailure() {
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Review the module.' }),
    stepStart({ step: 1 }),
    assistantMessage({
      step: 1, toolCalls: [{ id: 'call_read', name: 'read', arguments: readArguments('src/a.js') }],
      usage: { inputTokens: 3, outputTokens: 48, totalTokens: 9651, cacheWriteTokens: 9600 },
    }),
    toolCall({ step: 1, callId: 'call_read', name: 'read', arguments: readArguments('src/a.js') }),
    readResult({ step: 1, callId: 'call_read', path: 'src/a.js', lines: ['export const a = 1;'] }),
    stepEnd({ step: 1 }),
    compactionStart(),
    compactionEnd({ error: 'compaction summary request failed' }),
    stepStart({ step: 2 }),
    assistantMessage({
      step: 2, text: 'The module exports one constant.',
      usage: { inputTokens: 2, outputTokens: 12, totalTokens: 9724, cacheReadTokens: 9600, cacheWriteTokens: 110 },
    }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

/**
 * One step whose first model attempt settles as an error with a non-zero usage chunk in its stream, followed by
 * `llm/retry`, `llm/retry-started` and the retried request's `assistant/message`.
 */
export function retryWithUsage() {
  const failure = { message: 'stream ended before the response completed', code: 'PI_AI_ERROR' };
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Summarise the change.' }),
    stepStart(),
    attempt({
      usageChunk: { inputTokens: 3, outputTokens: 20, totalTokens: 9623, cacheWriteTokens: 9600 },
      finish: { kind: 'error', failure },
    }),
    llmRetry({ failure }),
    llmRetryStarted(),
    assistantMessage({
      text: 'The change moves the parser into its own module.',
      usage: { inputTokens: 3, outputTokens: 64, totalTokens: 9667, cacheReadTokens: 9600 },
    }),
    stepEnd(),
    turnEnd(),
  ]);
}

/** The files `reusedCallIdAcrossSteps` reads: the path it names for each, relative to the session directory, and its lines. */
export const REUSED_CALL_ID_FILES = {
  'src/a.js': ['export const a = 1;'],
  'src/b.js': ['export const b = 2;', 'export default b;'],
};

/** The same two paths with declarations an outline reads as symbols, for a case whose read files must carry them. */
export const REUSED_CALL_ID_SYMBOL_FILES = {
  'src/a.js': ['export function a() { return 1; }'],
  'src/b.js': ['export function b() { return 2; }', 'export default b;'],
};

/**
 * One turn of two consecutive steps, each a `read` of a different file under the same provider call id with its own
 * result: DSH keeps a call id unique within a step only. The reads show the lines of `files`.
 */
export function reusedCallIdAcrossSteps({ files = REUSED_CALL_ID_FILES } = {}) {
  const id = 'call_read';
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Compare the two modules.' }),
    stepStart({ step: 1 }),
    assistantMessage({
      step: 1, toolCalls: [{ id, name: 'read', arguments: readArguments('src/a.js') }],
      usage: { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 },
    }),
    toolCall({ step: 1, callId: id, name: 'read', arguments: readArguments('src/a.js') }),
    readResult({ step: 1, callId: id, path: 'src/a.js', lines: files['src/a.js'] }),
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    assistantMessage({
      step: 2, toolCalls: [{ id, name: 'read', arguments: readArguments('src/b.js') }],
      usage: { inputTokens: 2, outputTokens: 40, totalTokens: 9752, cacheReadTokens: 9600, cacheWriteTokens: 110 },
    }),
    toolCall({ step: 2, callId: id, name: 'read', arguments: readArguments('src/b.js') }),
    readResult({ step: 2, callId: id, path: 'src/b.js', lines: files['src/b.js'] }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

/** The index in `reusedCallIdAcrossSteps()` of its first `step/end`: a log cut there ends after one measured call. */
export const FIRST_STEP_END = reusedCallIdAcrossSteps().findIndex(event => event.type === 'step/end');

/** One turn whose `read` of a missing file fails: the result is an error carrying DSH's failure identity. */
export function toolError() {
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Open the missing module.' }),
    stepStart({ step: 1 }),
    assistantMessage({
      step: 1, toolCalls: [{ id: 'call_read', name: 'read', arguments: readArguments('src/missing.js') }],
      usage: { inputTokens: 3, outputTokens: 36, totalTokens: 9639, cacheWriteTokens: 9600 },
    }),
    toolCall({ step: 1, callId: 'call_read', name: 'read', arguments: readArguments('src/missing.js') }),
    toolResult({
      step: 1, callId: 'call_read', text: 'Error: cannot read "src/missing.js": not found', isError: true,
      error: { name: 'FsError', code: 'FS_NOT_FOUND' },
    }),
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    assistantMessage({
      step: 2, text: 'That module does not exist.',
      usage: { inputTokens: 2, outputTokens: 10, totalTokens: 9672, cacheReadTokens: 9600, cacheWriteTokens: 60 },
    }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

/**
 * One turn whose `ask_user_question` is aborted before the user answers: the error result the question service's
 * abort produces, then the aborted turn's end.
 */
export function askAborted() {
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Help me pick a release plan.' }),
    stepStart(),
    assistantMessage({
      toolCalls: [{ id: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }],
      usage: { inputTokens: 3, outputTokens: 52, totalTokens: 9655, cacheWriteTokens: 9600 },
    }),
    toolCall({ callId: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }),
    toolResult({
      callId: 'call_ask', text: 'Error: ask_user_question was aborted before the user answered', isError: true,
      error: { name: 'UserQuestionError', code: 'ASK_ABORTED' },
    }),
    stepEnd(),
    turnEnd({ reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]);
}

/** One turn whose `ask_user_question` comes back answered with nothing selected and no custom answer. */
export function askEmptyAnswer() {
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Help me pick a release plan.' }),
    stepStart({ step: 1 }),
    assistantMessage({
      step: 1, toolCalls: [{ id: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }],
      usage: { inputTokens: 3, outputTokens: 52, totalTokens: 9655, cacheWriteTokens: 9600 },
    }),
    toolCall({ step: 1, callId: 'call_ask', name: 'ask_user_question', arguments: ASK_ARGUMENTS }),
    toolResult({ step: 1, callId: 'call_ask', text: JSON.stringify({ answers: [{ id: 'plan', selected: [] }] }) }),
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    assistantMessage({
      step: 2, text: 'Nothing was chosen, so the plan stays as it is.',
      usage: { inputTokens: 2, outputTokens: 14, totalTokens: 9686, cacheReadTokens: 9600, cacheWriteTokens: 70 },
    }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}
