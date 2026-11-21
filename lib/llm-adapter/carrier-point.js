// lib/llm-adapter/carrier-point.js — the carrier cache point writers: given a text prefix, the writer of a request's wire protocol gives the last user message that opens with it one cache point at its end, in the payload the protocol's serializer built.
// It knows no SW and no DSH module and no pi-ai package: it reads the prefix, the payload, the model that names the protocol and the options the request was made with, and reports through the sink it is handed.
// A request it does not give a point is the serializer's as it was, whatever it holds; each call ends in one closed result (`carrier-results.js`), which describes the payload the writer saw and claims nothing of what the endpoint did with it.
// An OpenAI Responses request is given a breakpoint only while the owner's switch (`responsesBreakpoint`) is on, whatever its model declares about explicit prompt-cache mode; the request-level options that go with a breakpoint are written in the same step, so a request that gets none is the serializer's.

/** The most cache points one request may carry on a route that marks content blocks with `cache_control`. */
const MAX_CONTROL_POINTS = 4;

const ADDED = Object.freeze({ result: 'added' });
const NATIVE = Object.freeze({ result: 'native' });
const skipped = reason => Object.freeze({ result: 'skipped', reason });
const NO_CARRIER = skipped('no-carrier');
const NO_NATIVE_POINT = skipped('no-native-point');
const POINTS_FULL = skipped('points-full');
const RESPONSES_OFF = skipped('responses-off');
const UNSUPPORTED = skipped('unsupported');

// How pi-ai's Responses serializer (`openai-responses.js`, `getPromptCacheRetention` and `getPromptCacheOptions`) writes a long route's lifetime: as `prompt_cache_retention` for a route that declares nothing, as `prompt_cache_options` for one that declares explicit prompt-cache mode, which a breakpoint goes with.
const LONG_RETENTION = '24h';
const LONG_OPTIONS = Object.freeze({ ttl: '30m' });

const textOfBlocks = blocks => blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');

// The index of the last user message of `messages` whose top-level text opens with `prefix`, -1 for none; `textOf` reads that text off a wire message of the protocol.
const lastCarrier = (prefix, messages, textOf) => messages.findLastIndex(message => message?.role === 'user' && textOf(message).startsWith(prefix));

/**
 * @param {{ report: (message: string) => void, responsesBreakpoint: () => boolean }} parameters
 *   `report` receives the one-line diagnostic of a request whose carrier could not be given a cache point and of a switch that could not be read; `responsesBreakpoint` is the owner's Responses switch, a function that answers the current state, called once for each Responses request and for no other: it is off unless it answers `true`, and one that throws is off, with one diagnostic.
 * @returns {(request: { prefix: string, payload: object, model: { api: string }, options?: object }) => ({ result: 'added' | 'native' } | { result: 'skipped', reason: string })}
 *   `writeCarrierPoint` gives the last user message of `payload` whose top-level text opens with `prefix` a cache point at its end and answers the closed result; only an `added` result changes `payload`, and a protocol none of the writers serves is `unsupported`.
 */
export function createCarrierPointWriter({ report, responsesBreakpoint }) {
  // ── `cache_control` on a content block: Anthropic Messages and Chat Completions gateways of the Anthropic format ──
  const blocksText = content => (typeof content === 'string' ? content : Array.isArray(content) ? textOfBlocks(content) : '');
  const controlText = message => blocksText(message.content);

  // The blocks of `parts` that carry a `cache_control`.
  const controlled = parts => parts.filter(part => part?.cache_control !== undefined);

  // The carrier message's last block `pick` chooses, a string content represented as the one text block of the same text, takes the cache control the request's own points have; a message the request's own points already end, or a request with no free point, is left as it is.
  function controlPoint({ message, marked, pick, model }) {
    // The serializer writes its own points only for a route it caches on, with the lifetime it is configured for; a request with none stays as it is.
    if (marked.length === 0) return NO_NATIVE_POINT;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const last = pick(blocks);
    // The block that already ends the carrier is left alone.
    if (last.cache_control !== undefined) return NATIVE;
    if (marked.length >= MAX_CONTROL_POINTS) {
      report(`carrier cache: route "${model.provider}/${model.id}" (${model.api}) already sends ${marked.length} cache points, so the last carrier is given none`);
      return POINTS_FULL;
    }
    last.cache_control = { ...marked[0].cache_control };
    if (typeof message.content === 'string') message.content = blocks;
    return ADDED;
  }

  // The `cache_control` blocks of a request in the serializer's three places: system blocks, tool definitions and message content blocks.
  const anthropicMarked = payload => controlled([
    ...(Array.isArray(payload.system) ? payload.system : []),
    ...(Array.isArray(payload.tools) ? payload.tools : []),
    ...(Array.isArray(payload.messages) ? payload.messages : []).flatMap(message => (Array.isArray(message.content) ? message.content : [])),
  ]);

  function anthropic({ prefix, payload, model }) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(prefix, payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    return controlPoint({ message: payload.messages[at], marked: anthropicMarked(payload), pick: blocks => blocks.at(-1), model });
  }

  // The gateway's system message, last tool and last message carry the markers: tool definitions and message content parts.
  function completions({ prefix, payload, model }) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(prefix, payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    const marked = controlled([
      ...(Array.isArray(payload.tools) ? payload.tools : []),
      ...payload.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])),
    ]);
    return controlPoint({ message: payload.messages[at], marked, pick: parts => parts.findLast(part => part?.type === 'text'), model });
  }

  // ── Bedrock Converse: a standalone `cachePoint` block closing the message's content ──
  const bedrockText = message => (Array.isArray(message.content) ? message.content.filter(block => typeof block?.text === 'string').map(block => block.text).join('') : '');

  function bedrock({ prefix, payload }) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(prefix, payload.messages, bedrockText);
    if (at < 0) return NO_CARRIER;
    const blocks = [...(Array.isArray(payload.system) ? payload.system : []), ...payload.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))];
    const point = blocks.find(block => block?.cachePoint !== undefined);
    // The serializer writes its own points only for a model it caches, with the lifetime the route is configured for.
    if (point === undefined) return NO_NATIVE_POINT;
    const { content } = payload.messages[at];
    if (content.at(-1)?.cachePoint !== undefined) return NATIVE;
    content.push({ cachePoint: { ...point.cachePoint } });
    return ADDED;
  }

  // ── OpenAI Responses: `prompt_cache_breakpoint` on an `input_text` block ──
  const responsesText = item => (item?.role === 'user' && Array.isArray(item.content) ? item.content.filter(part => part?.type === 'input_text' && typeof part.text === 'string').map(part => part.text).join('') : '');

  // pi-ai's own test for the ChatGPT sign-in lane, whose endpoint refuses the cache fields it leaves out of that request: the official OpenAI endpoint reached with a key that is no API key.
  const chatGptSignIn = (model, apiKey) => model.provider === 'openai' && model.baseUrl === 'https://api.openai.com/v1' && apiKey !== undefined && !apiKey.startsWith('sk-');

  // The switch as the Responses writer reads it: once for a request, and not at all for the other protocols.
  const switchedOn = () => {
    try {
      return responsesBreakpoint() === true;
    } catch {
      report('carrier cache: the Responses breakpoint setting could not be read, so the request is sent without it');
      return false;
    }
  };

  // The request-level options pi-ai writes beside a breakpoint, read off the payload it wrote for a route that declares nothing: a long route's retention gives way to the lifetime option, and any other request holds none to change.
  const explicitOptions = (payload) => {
    if (payload.prompt_cache_retention !== LONG_RETENTION) return;
    delete payload.prompt_cache_retention;
    payload.prompt_cache_options = { ...LONG_OPTIONS };
  };

  // Every condition is read off the payload and options as they stand before anything is written, so a request that gets the breakpoint gets its options with it and one that does not is the serializer's, whatever its model declares or its retention.
  function responses({ prefix, payload, model, options }) {
    if (!switchedOn()) return RESPONSES_OFF;
    if (!Array.isArray(payload.input) || chatGptSignIn(model, options?.apiKey)) return UNSUPPORTED;
    // Caching off is how the serializer says the route is not cached, which the breakpoint would turn on.
    if (options?.cacheRetention === 'none') return NO_NATIVE_POINT;
    const at = lastCarrier(prefix, payload.input, responsesText);
    if (at < 0) return NO_CARRIER;
    // The implicit breakpoint of the latest message already ends a carrier that is the last item.
    if (at === payload.input.length - 1) return NATIVE;
    const block = payload.input[at].content.findLast(part => part?.type === 'input_text');
    block.prompt_cache_breakpoint = { mode: 'explicit' };
    explicitOptions(payload);
    return ADDED;
  }

  const WRITERS = { 'anthropic-messages': anthropic, 'bedrock-converse-stream': bedrock, 'openai-responses': responses, 'openai-completions': completions };

  return function writeCarrierPoint({ prefix, payload, model, options }) {
    return WRITERS[model.api]?.({ prefix, payload, model, options }) ?? UNSUPPORTED;
  };
}
