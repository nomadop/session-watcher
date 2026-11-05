// lib/harness/dsh/load-message.js — the `user/message` a handoff load hands the model: the calls the load ran, one text block per call holding its result, and the route the watcher prices them by. The producer builds the message input here and the reducer reads the message back here, so the two read one shape.

/** The message's source kind, the plugin's own: no DSH producer writes it, and the DSH reducer reads it as calls. */
export const LOAD_MESSAGE_KIND = 'session-watcher-load';

/**
 * The input of a load message, as `createUserMessage` takes it: `content` one text block per call holding its `text`, in call order, and `source` `{ kind, route: { provider, model }, calls: [{ id, name, arguments }] }`, with nothing else of `route` or of a call.
 *
 * @param {{ route: { provider: string, model: string },
 *   calls: { id: string, name: string, arguments: string, text: string }[] }} load
 * @returns {{ content: { type: 'text', text: string }[], source: object }}
 */
export function loadMessageInput({ route, calls }) {
  return {
    content: calls.map(({ text }) => ({ type: 'text', text })),
    source: {
      kind: LOAD_MESSAGE_KIND,
      route: { provider: route.provider, model: route.model },
      calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    },
  };
}

/** The `source.route` of a load message, and undefined for any other message. */
export function loadRouteOf(message) {
  return message?.source?.kind === LOAD_MESSAGE_KIND ? message.source.route : undefined;
}

const isId = value => typeof value === 'string' && value !== '';
const isCall = call => call !== null && typeof call === 'object'
  && isId(call.id) && typeof call.name === 'string' && typeof call.arguments === 'string';
const isTextBlock = block => block?.type === 'text' && typeof block.text === 'string';

/**
 * A load message's calls, each `{ id, name, arguments, text }` with the text of the block at its position; null when a call is not well-formed or the content does not hold one text block per call.
 */
export function loadCallsOf(message) {
  const calls = message?.source?.calls;
  const content = message?.content;
  if (!Array.isArray(calls) || !Array.isArray(content) || calls.length !== content.length) return null;
  if (!calls.every(isCall) || !content.every(isTextBlock)) return null;
  return calls.map(({ id, name, arguments: args }, index) => ({ id, name, arguments: args, text: content[index].text }));
}
