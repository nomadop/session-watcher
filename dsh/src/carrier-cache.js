// dsh/src/carrier-cache.js — the carrier cache point of the opt-in pi-ai adapter entry (`pi-ai-index.js`): a resolved profile's pi-ai provider whose `streamSimple` writes one extra cache point at the end of the last inner-seal carrier into the payload pi-ai's own serializer built.
// It knows no Cordis and imports no DSH or pi-ai package: the carrier's opening text and the diagnostic sink reach it by parameter, and it reads only the payload, the model pi-ai hands the request's `onPayload` hook and the options the request was made with.
// A request it does not give a point reaches the endpoint exactly as the native serializer wrote it.
// Each call of its hook ends in one closed result (`pi-ai-integration.js` `CARRIER_RESULTS`), which `observe` is handed; the result describes the payload the hook saw, so it claims nothing of what the endpoint did with it.
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

/**
 * @param {{ carrierPrefix: string, report: (message: string) => void, observe?: (result: object) => void, responsesBreakpoint?: () => boolean }} parameters
 *   `carrierPrefix` is the text every carrier's top-level text starts with; `report` receives the one-line diagnostic of a request whose carrier could not be given a cache point, of a result `observe` could not take and of a switch that could not be read; `observe` is told the closed result of each hook call and may throw, which leaves the request as it is.
 *   `responsesBreakpoint` is the owner's Responses switch, read once for each Responses request and off unless it answers `true`; one that throws is off, with one diagnostic.
 */
export function createCarrierCache({ carrierPrefix, report, observe = () => {}, responsesBreakpoint = () => false }) {
  // The index of the last user message of `messages` whose top-level text opens with the carrier prefix, -1 for none; `textOf` reads that text off a wire message of the protocol.
  const lastCarrier = (messages, textOf) => messages.findLastIndex(message => message?.role === 'user' && textOf(message).startsWith(carrierPrefix));

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
      report(`llm-pi-ai carrier cache: route "${model.provider}/${model.id}" (${model.api}) already sends ${marked.length} cache points, so the last carrier is given none`);
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

  function anthropic(payload, model) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    return controlPoint({ message: payload.messages[at], marked: anthropicMarked(payload), pick: blocks => blocks.at(-1), model });
  }

  // The gateway's system message, last tool and last message carry the markers: tool definitions and message content parts.
  function completions(payload, model) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    const marked = controlled([
      ...(Array.isArray(payload.tools) ? payload.tools : []),
      ...payload.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])),
    ]);
    return controlPoint({ message: payload.messages[at], marked, pick: parts => parts.findLast(part => part?.type === 'text'), model });
  }

  // ── Bedrock Converse: a standalone `cachePoint` block closing the message's content ──
  const bedrockText = message => (Array.isArray(message.content) ? message.content.filter(block => typeof block?.text === 'string').map(block => block.text).join('') : '');

  function bedrock(payload) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, bedrockText);
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
      report('llm-pi-ai carrier cache: the Responses breakpoint setting could not be read, so the request is sent without it');
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
  function responses(payload, model, options) {
    if (!switchedOn()) return RESPONSES_OFF;
    if (!Array.isArray(payload.input) || chatGptSignIn(model, options?.apiKey)) return UNSUPPORTED;
    // Caching off is how the serializer says the route is not cached, which the breakpoint would turn on.
    if (options?.cacheRetention === 'none') return NO_NATIVE_POINT;
    const at = lastCarrier(payload.input, responsesText);
    if (at < 0) return NO_CARRIER;
    // The implicit breakpoint of the latest message already ends a carrier that is the last item.
    if (at === payload.input.length - 1) return NATIVE;
    const block = payload.input[at].content.findLast(part => part?.type === 'input_text');
    block.prompt_cache_breakpoint = { mode: 'explicit' };
    explicitOptions(payload);
    return ADDED;
  }

  const WRITERS = { 'anthropic-messages': anthropic, 'bedrock-converse-stream': bedrock, 'openai-responses': responses, 'openai-completions': completions };

  // The result goes to `observe` after the writer ran, whatever the writer concluded; a throw from `observe` is a warning and leaves the request as the writer made it.
  const observed = (outcome) => {
    try {
      observe(outcome);
    } catch {
      report('llm-pi-ai carrier cache: the cache evidence of a request could not be recorded');
    }
  };

  // The `onPayload` hook of one request: the hook the caller set, when it did, runs first and its replacement payload is the one written to.
  const hookOf = (earlier, options) => async (payload, model) => {
    const replaced = await earlier?.(payload, model);
    const body = replaced ?? payload;
    const outcome = WRITERS[model.api]?.(body, model, options) ?? UNSUPPORTED;
    observed(outcome);
    return outcome === ADDED ? body : replaced;
  };

  // The provider with its `streamSimple` replaced; every other member, its auth included, is the original's, and the original runs as the receiver of the call.
  const wrapProvider = provider => Object.create(provider, {
    streamSimple: {
      value: (model, context, options) => provider.streamSimple(model, context, { ...options, onPayload: hookOf(options?.onPayload, options) }),
      enumerable: true, writable: true, configurable: true,
    },
  });

  return {
    /** The resolved profiles with each route's pi-ai provider wrapped; a route that resolved none is left as it is. */
    decorateProfiles: profiles => new Map([...profiles].map(([route, profile]) => [
      route, profile.piProvider === undefined ? profile : { ...profile, piProvider: wrapProvider(profile.piProvider) },
    ])),
  };
}
