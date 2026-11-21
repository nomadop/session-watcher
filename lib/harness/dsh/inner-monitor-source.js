// lib/harness/dsh/inner-monitor-source.js — the structured reading of one source event of an inner seal's slot: the content blocks a monitor's detail shows, the plain text a row previews, raw and as a list displays it, and the source category a slot row is named by (`slotSourceOf`), which the client takes as the word the host gives it.
//
// A message is read as `eventFactOf` reads it, from `event.data.message` and else from `event.data` itself, so the surface messages of a step and a user message take one path. The functions are total over malformed events and read no log, surface or DSH package.
import { redactCmd } from '../../bash-feature.js';
import { dshToolEvidenceProfile } from './tool-evidence-profile.js';
import { parseArguments } from './transcript-observation.js';

// The block of a message's content as the reading keeps it.
function blockOf(block) {
  switch (block?.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'reasoning': return { type: 'reasoning', text: block.text };
    case 'tool-call': return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments };
    case 'image': return { type: 'image', attachment: block.attachment };
    case 'file': return { type: 'file', attachment: block.attachment };
    default: return { type: 'unknown', raw: block };
  }
}

/**
 * One source event as a slot's detail shows it: `{ seq, type, visible, blocks, raw }`, `visible` what the caller says of the event and `raw` the event itself.
 * `blocks` are the content blocks of its message in order: `{ type: 'text' | 'reasoning', text }`, `{ type: 'tool-call', id, name, arguments }` with the arguments as the raw string, `{ type: 'image' | 'file', attachment }`, the placeholder of the reference the log keeps, and `{ type: 'unknown', raw }` for any other. A tool result is the one block `{ type: 'tool-result', callId, isError, blocks }` around its content, `callId` the `id` of the call it answers, so a call and its result pair by it.
 * An event with no content blocks to read has none, which is no failure.
 *
 * @param {object} event
 * @param {{ visible: boolean }} options
 */
export function sourceEventView(event, { visible }) {
  const message = event.data?.message ?? event.data;
  const blocks = (Array.isArray(message?.content) ? message.content : []).map(blockOf);
  const shown = event.type === 'tool/result' ? [{ type: 'tool-result', callId: message?.toolCallId, isError: message?.isError === true, blocks }] : blocks;
  return { seq: event.seq, type: event.type, visible, blocks: shown, raw: event };
}

const SOURCE_CATEGORIES = { 'system/message': 'system', 'developer/message': 'developer', 'tool/result': 'tool', 'assistant/message': 'assistant' };
const HUMAN_SOURCE_KIND = 'user';

// The category of a slot's source, `{ type, kind }` of its first event: `user` for a user message whose recorded kind is the human's, `injected` for a user message of any other recorded kind, `system`, `developer`, `tool` or `assistant` by the event type, else `other`. A user message that records no kind is `other`; no list of producers takes part.
function sourceCategoryOf({ type, kind }) {
  if (type === 'user/message') {
    if (typeof kind !== 'string') return 'other';
    return kind === HUMAN_SOURCE_KIND ? 'user' : 'injected';
  }
  return SOURCE_CATEGORIES[type] ?? 'other';
}

/** The source of a slot's event as a slot row names it: `{ type, kind, category }`, its type, the `kind` of its message's source, `null` where the message records none, and the `category` the two fall into, one of `user`, `injected`, `system`, `developer`, `tool`, `assistant` and `other`. */
export function slotSourceOf(event) {
  const message = event.data?.message ?? event.data;
  const source = { type: event.type, kind: message?.source?.kind ?? null };
  return { ...source, category: sourceCategoryOf(source) };
}

const placeholderOf = ({ type, attachment }) => `[${type}${attachment?.name === undefined ? '' : ` ${attachment.name}`}]`;

// A tool call as the bucket names it: the group's name and its detail, the non-empty ones apart by a space, a bash one redacted. The arguments are read as DSH's agent loop reads them, so a call whose arguments are not JSON names itself by its tool alone.
function callLabel(block) {
  const { groupKey, kind, detail } = dshToolEvidenceProfile.residualIdentity(block.name, parseArguments(block.arguments) ?? {});
  const label = [groupKey, detail].filter(part => part !== '').join(' ');
  return kind === 'bash' ? redactCmd(label) : label;
}

function blockText(block, callText) {
  switch (block.type) {
    case 'text': return block.text;
    case 'tool-call': return callText(block);
    case 'tool-result': return textOf(block.blocks, callText);
    case 'image':
    case 'file': return placeholderOf(block);
    default: return '';
  }
}

const rawCallText = block => [block.name, block.arguments].filter(part => typeof part === 'string' && part !== '').join(' ');
// A call whose name is no text is not one the bucket can name; it reads as the raw text does.
const displayCallText = block => (typeof block.name === 'string' ? callLabel(block) : rawCallText(block));

const textOf = (blocks, callText) => blocks.map(block => blockText(block, callText)).filter(text => text !== '').join('\n');

/**
 * The plain text a row previews of an event, one block to a line: its text, each tool call as its name and arguments, a tool result's own text and a bracketed placeholder naming each image or file. Reasoning and unknown blocks add nothing; an event with nothing to preview previews as the empty text.
 *
 * @param {object} event
 * @returns {string}
 */
export function eventPreviewText(event) {
  return textOf(sourceEventView(event, { visible: true }).blocks, rawCallText);
}

/**
 * The text a list displays of an event: `eventPreviewText` with each structured `tool-call` block named as the bucket names a call, its tool and detail, instead of its tool and raw arguments. Only a block of that type is a call; a tool's name in text stays text.
 *
 * @param {object} event
 * @returns {string}
 */
export function eventDisplayText(event) {
  return textOf(sourceEventView(event, { visible: true }).blocks, displayCallText);
}
