// dsh/src/model-names.js — the DSH llm catalog `name` of each (provider, id) pair a session's model calls name, and the `assistant/message` that carries it in place of the id.
// It knows no DSH and no provider: the host hands it `resolve`, and a pair keeps the first name a resolve fulfils it with.

const keyOf = (provider, id) => `${provider}\u0000${id}`;
const isName = name => typeof name === 'string' && name.length > 0;

function pairOf(fields) {
  const { provider, model } = fields ?? {};
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}

function pairOfEvent(event) {
  if (event?.type === 'request/header') return pairOf(event.data?.header?.config);
  if (event?.type === 'assistant/message') return pairOf(event.data?.message?.source);
  return undefined;
}

/**
 * The model names over `resolve(provider, id) → Promise<{ name }>`, kept in a map from each pair to its name.
 * `nameOf(provider, id)` answers the pair's name, `undefined` until a resolve has fulfilled with one.
 * `warm(pairs)` starts one resolve for each pair with neither a name nor a resolve in flight, and answers the `Promise.allSettled` over the in-flight resolve of every pair in `pairs` without a name, whichever call started it; a rejection, or a fulfilment whose `name` is not a non-empty string, stores nothing.
 * `pairsOf(events)` answers the distinct `{ provider, model }` pairs, in first-seen order, of the `request/header` events' `data.header.config` and the `assistant/message` events' `data.message.source` whose two fields are strings; any other event contributes nothing.
 * `mapEvent(event)` answers `event` itself unless it is an `assistant/message` whose pair has a name, and then a copy of the path down to its source with `source.model` the name, every other property shared with `event`.
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
    if (event?.type !== 'assistant/message') return event;
    const pair = pairOf(event.data?.message?.source);
    const name = pair && nameOf(pair.provider, pair.model);
    if (name === undefined) return event;
    const { data } = event;
    const { message } = data;
    return { ...event, data: { ...data, message: { ...message, source: { ...message.source, model: name } } } };
  }

  return { nameOf, warm, pairsOf, mapEvent };
}
