// lib/harness/dsh/message-blocks.js — what DSH messages' content blocks say: the text they put in the request, as the quote prices it, and the facts of a seal slot's derived messages, as the summary's rows and verbatim notes read them.

// The text of a content block as the request carries it: a text or reasoning block its text, a call its name and arguments, any other block its JSON.
const blockText = block => (block.type === 'text' || block.type === 'reasoning' ? block.text
  : block.type === 'tool-call' ? `${block.name}${block.arguments}` : JSON.stringify(block));

/**
 * The text of a message's blocks as the request carries them, joined with nothing between.
 * @param {{ content: object[] }} message
 * @returns {string}
 */
export const requestTextOf = message => message.content.map(blockText).join('');

const blocksOf = message => (Array.isArray(message?.content) ? message.content : []);

// The text of messages as the provider projection joins it: their text blocks, in order, with nothing between.
const textOf = messages => messages.flatMap(blocksOf).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');

/**
 * The facts of one seal slot (`lib/inner-seal/source.js`) over `messages`, the current projection of its selected events, as `planSummary` reads them.
 * `own` is a user's own message: a slot outside any counted step whose first message is a user message the user wrote. `text` joins the text blocks of every message.
 * A counted step is `'step'`, with the text of its assistant messages and their calls, a call `failed` when a tool message of the slot answers its id with an error; a slot outside a step whose first message is a tool message is `'result'`, naming the call it answers; any other slot is `'other'`.
 *
 * @param {{ step?: object }} slot
 * @param {object[]} messages
 * @returns {{ own: boolean, kind: ('step'|'result'|'other'), text: string, toolCallId?: string, assistantText?: string,
 *   calls?: { id: string, name: string, arguments: string, failed: boolean }[] }}
 */
export function slotFactsOf(slot, messages) {
  const [first] = messages;
  const text = textOf(messages);
  if (slot.step === undefined) {
    if (first?.role === 'tool') return { own: false, kind: 'result', text, toolCallId: first.toolCallId };
    return { own: first?.role === 'user' && first.source?.kind === 'user', kind: 'other', text };
  }
  const failed = new Set(messages.filter(message => message.role === 'tool' && message.isError === true).map(message => message.toolCallId));
  const assistant = messages.filter(message => message.role === 'assistant');
  const calls = assistant.flatMap(blocksOf).filter(block => block?.type === 'tool-call')
    .map(call => ({ id: call.id, name: call.name, arguments: call.arguments, failed: failed.has(call.id) }));
  return { own: false, kind: 'step', text, assistantText: textOf(assistant), calls };
}
