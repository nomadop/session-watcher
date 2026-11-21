// lib/harness/dsh/event-read.js — the DSH tool that reads one event of a session log back as the text it holds, and the projection that text is made by.
//
// An address a Turn History row or a carrier line gives is the event `seq` of one session, so the name of the tool that dereferences it is the Harness's, and the wording that names it (`turn-recovery.js`, the system prompt guidance `EVENT_READ_GUIDANCE`) takes it from here.

import { INNER_SEAL_KIND } from '../../inner-seal/carrier.js';
import { CHECKPOINT_KIND } from './event-facts.js';
import { LOAD_MESSAGE_KIND } from './load-message.js';

/** The registered name of the DSH tool that reads an event by its session id and `seq`. */
export const EVENT_READ_TOOL = 'sw_event_read';

// DSH's own tool that reads an event of the session log; a call of it names the same target as `EVENT_READ_TOOL`'s.
const NATIVE_EVENT_READ = 'session_event_read';

/** The system prompt's guidance on when to read an event. */
export const EVENT_READ_GUIDANCE = `Use ${EVENT_READ_TOOL} when you need exact data from an earlier event.`;

const isText = value => typeof value === 'string';
const listOf = value => (Array.isArray(value) ? value : []);

/** The target of a direct logged event-read call by `EVENT_READ_TOOL` or DSH's native tool, independent of any neighbor window or tool result. */
export function eventReadTargetOf(call) {
  if (call?.name !== EVENT_READ_TOOL && call?.name !== NATIVE_EVENT_READ) return undefined;
  try {
    const { seq, session_id: sessionId } = JSON.parse(call.arguments);
    if (Number.isSafeInteger(seq) && seq >= 0 && (sessionId === undefined || isText(sessionId))) return { seq, sessionId };
  } catch {
    return undefined;
  }
  return undefined;
}

// The fields of `source` that are kept: its kind, which tells a user's own message from a carrier or a load.
const sourceOf = source => (isText(source?.kind) ? { source: { kind: source.kind } } : {});

// One content block by its known fields, or none for a block of another kind. A block this projection does not know is left out; a reasoning block keeps only its recorded text.
function blockOf(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning': return isText(block.text) ? [{ type: block.type, text: block.text }] : [];
    case 'tool-call': return [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }];
    case 'file':
    case 'image': return block.attachment === undefined ? [] : [{ type: block.type, attachment: block.attachment }];
    default: return [];
  }
}

const blocksOf = content => listOf(content).flatMap(blockOf);

// The known fields of the data of each event type that holds a body; any other type holds none.
const BODIES = {
  'user/message': data => ({ content: blocksOf(data.content), ...sourceOf(data.source) }),
  // `interrupted` marks a prefix a cancellation cut short, which a reader must not take for a finished message.
  'assistant/message': data => ({ message: { content: blocksOf(data.message?.content) }, ...data.interrupted === true ? { interrupted: true } : {} }),
  'tool/call': data => ({ callId: data.callId, name: data.name, arguments: data.arguments }),
  'tool/result': (data) => {
    const { message, error } = data;
    return {
      message: {
        ...isText(message?.toolCallId) ? { toolCallId: message.toolCallId } : {},
        ...typeof message?.isError === 'boolean' ? { isError: message.isError } : {},
        content: blocksOf(message?.content),
      },
      ...error === undefined || error === null ? {} : { error: { name: error.name, code: error.code } },
    };
  },
};

/**
 * The text of one event as the tool answers it: its type, `seq` and time, and for an event type that holds a body, that body by its known fields at the paths the event keeps them under, every string as the log holds it.
 * An event of any other type, a request header and an attempt's stream included, is its identity alone.
 *
 * @param {{ type: string, seq: number, time: number, data?: object }} event
 * @returns {object}
 */
export function eventTextOf(event) {
  const { type, seq, time } = event;
  const body = Object.hasOwn(BODIES, type) ? BODIES[type](event.data ?? {}) : undefined;
  return { type, seq, time, ...body === undefined ? {} : { data: body } };
}

const NO_TEXT = ' | (no semantic text)';

// The source kinds of the messages that stand in for earlier events with a body of their own: a handoff's payload and its file excerpts, a seal's carrier, a compaction checkpoint.
const CARRIER_KINDS = new Set([LOAD_MESSAGE_KIND, INNER_SEAL_KIND, CHECKPOINT_KIND]);

// One neighbor: its identity, then the semantic text `textOf` extracts from it, under its line and indented. A carrier is its identity alone, its body read as the target.
function neighborLine(event, textOf) {
  const identity = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`;
  if (event.type === 'user/message' && CARRIER_KINDS.has(event.data?.source?.kind)) return identity;
  const text = textOf(event);
  return `${identity}${text.length === 0 ? NO_TEXT : `\n  ${text.replaceAll('\n', '\n  ')}`}`;
}

/**
 * The answer to a read: the session's id and title, the target event's text as fenced JSON, and the semantic summary of each neighbor of the window before and after it.
 *
 * @param {{ sessionId: string, title: string, window: { target: object, events: object[] }, textOf: (event: object) => string }} read
 * @returns {string}
 */
export function formatEventRead({ sessionId, title, window, textOf }) {
  const { target } = window;
  const lines = [`Session ${sessionId} — ${title}`, `Target event seq ${target.seq}:`, '```json', JSON.stringify(eventTextOf(target), null, 2), '```'];
  for (const [heading, neighbors] of [['Before:', window.events.filter(event => event.seq < target.seq)], ['After:', window.events.filter(event => event.seq > target.seq)]]) {
    if (neighbors.length > 0) lines.push('', heading, ...neighbors.map(event => neighborLine(event, textOf)));
  }
  return lines.join('\n');
}
