// dsh/src/model-names.js — the DSH llm catalog `name` of each (provider, id) pair a session's model calls and loads name, and the event that carries it in place of the id: an `assistant/message` in its `source.model`, a load message in its `source.route.model`.
// It knows no DSH and no provider: the host hands it `resolve`, and a pair keeps the first name a resolve fulfils it with.
import { loadRouteOf } from '../../lib/harness/dsh/load-message.js';

const keyOf = (provider, id) => `${provider}\u0000${id}`;
const isName = name => typeof name === 'string' && name.length > 0;

function pairOf(fields) {
  const { provider, model } = fields ?? {};
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}

function pairOfEvent(event) {
  if (event?.type === 'request/header') return pairOf(event.data?.header?.config);
  if (event?.type === 'assistant/message') return pairOf(event.data?.message?.source);
  if (event?.type === 'user/message') return pairOf(loadRouteOf(event.data));
  return undefined;
}

/**
 * The model names over `resolve(provider, id) → Promise<{ name }>`, kept in a map from each pair to its name.
 * `nameOf(provider, id)` answers the pair's name, `undefined` until a resolve has fulfilled with one.
 * `warm(pairs)` starts one resolve for each pair with neither a name nor a resolve in flight, and answers the `Promise.allSettled` over the in-flight resolve of every pair in `pairs` without a name, whichever call started it; a rejection, or a fulfilment whose `name` is not a non-empty string, stores nothing.
 * `pairsOf(events)` answers the distinct `{ provider, model }` pairs, in first-seen order, of the `request/header` events' `data.header.config`, the `assistant/message` events' `data.message.source` and the load messages' `source.route` whose two fields are strings; any other event contributes nothing.
 * `mapEvent(event)` answers `event` itself unless it is an `assistant/message` or a load message whose pair has a name, and then a copy of the path down to its source, or its route, with `model` the name, every other property shared with `event`.
 *
 * @param {{ resolve: (provider: string, id: string) => Promise<{ name: string }> }} options
 * @returns {{ nameOf: (provider: string, id: string) => string | undefined,
 *   warm: (pairs: Iterable<{ provider: string, model: string }>) => Promise<PromiseSettledResult<void>[]>,
 *   pairsOf: (events: Iterable<object>) => { provider: string, model: string }[],
 *   mapEvent: (event: object) => object }}
 */
export function createModelNames({ resolve }) {
  const names = new Map();
  const inFlight = new Map();

  const store = key => ({ name }) => { if (isName(name)) names.set(key, name); };
  const nameOf = (provider, id) => names.get(keyOf(provider, id));

  function warm(pairs) {
    const waits = [];
    for (const { provider, model } of pairs) {
      const key = keyOf(provider, model);
      if (names.has(key)) continue;
      let pending = inFlight.get(key);
      if (pending === undefined) {
        pending = resolve(provider, model).then(store(key)).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      waits.push(pending);
    }
    return Promise.allSettled(waits);
  }

  function pairsOf(events) {
    const pairs = new Map();
    for (const event of events) {
      const pair = pairOfEvent(event);
      if (pair !== undefined) pairs.set(keyOf(pair.provider, pair.model), pair);
    }
    return [...pairs.values()];
  }

  function mapEvent(event) {
    const pair = pairOfEvent(event);
    if (pair === undefined || event.type === 'request/header') return event;
    const name = nameOf(pair.provider, pair.model);
    if (name === undefined) return event;
    const { data } = event;
    if (event.type === 'user/message') {
      return { ...event, data: { ...data, source: { ...data.source, route: { ...data.source.route, model: name } } } };
    }
    const { message } = data;
    return { ...event, data: { ...data, message: { ...message, source: { ...message.source, model: name } } } };
  }

  return { nameOf, warm, pairsOf, mapEvent };
}
