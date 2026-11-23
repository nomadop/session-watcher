// test/helpers/dsh-inner-recall-log.js — a small DSH session log with a seal, whose requests that only read events back have a closed form the product is not read for.
// The model is `claude-sonnet-4-5`, whose price ratio R is 12.5, and the head stands at stock 3000 with no resource, so `B = 3000` and `K = R·B = 37500` throughout. Each interval spans 8 main calls: the head, 7 calls a carrier withdraws, and the post behind it.
// With the post P of the first carrier a recall request at stock 10000 of which 300 were written and 200 uncached, its bill is 9500 + 12.5·500 = 15750 less the (12.5 − 1)·500 = 5750 rebuild the seal paid, 10000 net; the next interval's recall, the withdrawn call `d3` at 10300 cached, pays 10300, and the post P2 of the second carrier is the recall of 17000 stock (100 uncached, 400 written) that nets 17000.
// The independent model these numbers come from prices the interval H→P at the left endpoint (L 3000, rent 0) and the right (L 9500, rent 6500), 7 ordinary slots at their mean rent 3250 and the recall's net: (7·3250 + 10000)/37500.
import {
  assistantMessage, stepEnd, stepStart, toolCall, toolResult,
} from './dsh-events.js';
import { pricedSeal, readCall } from './dsh-settlement.js';

export const MODEL = 'claude-sonnet-4-5';
export const RATIO = 12.5;

const cached = (cacheRead, { input = 0, cacheWrite = 0 } = {}) => ({ inputTokens: input, outputTokens: 100, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

// A request that reads `target` back: its step, the model request, the loop's dispatch and the answer. The dispatch is what proves the request a recall.
function recallStep({ turn, step, target, usage }) {
  const call = readCall(`r${turn}-${step}`, target);
  const request = assistantMessage({ text: 'reading back', model: MODEL, turn, step, toolCalls: [call], usage });
  const dispatch = toolCall({ turn, step, callId: call.id, name: call.name, arguments: call.arguments });
  const answer = toolResult({ turn, step, callId: call.id, text: 'the event text' });
  return { request, dispatch, answer, events: [stepStart({ turn, step }), request, dispatch, answer, stepEnd({ turn, step })] };
}

const plain = (turn, step, usage) => assistantMessage({ text: 'work', model: MODEL, turn, step, usage });

/**
 * The log as `{ event, tag }` entries to feed in order, `tag` naming the events a test reads: `P` the first post's request, `P-proof` its dispatch, `d3` the withdrawn recall request, `d3-proof` its dispatch, `carrier-2`, `P2`, `P2-proof`.
 * The head is the first main call; a carrier lists the 7 calls before each post, whole steps. With `usageFirstBehind` false the first call behind the first carrier is an interrupted call that reported no usage, and the recall request follows it.
 */
export function recallLog({ usageFirstBehind = true } = {}) {
  const head = plain(1, 1, cached(3000));
  const first = Array.from({ length: 7 }, (_, index) => plain(1, index + 2, cached(3100 + 100 * index)));
  const seal1 = pricedSeal(first, undefined, { cRatio: RATIO });
  const interrupted = assistantMessage({ text: 'cut short', model: MODEL, turn: 2, step: 0, interrupted: true });
  const post = recallStep({ turn: 2, step: 1, target: head.seq, usage: cached(9500, { input: 200, cacheWrite: 300 }) });
  const entries = [
    { event: head, tag: 'head' },
    ...first.map(event => ({ event, tag: 'work' })),
    ...seal1.events.map(event => ({ event, tag: 'seal-1' })),
    ...(usageFirstBehind ? [] : [{ event: interrupted, tag: 'interrupted' }]),
    ...post.events.map(event => ({ event, tag: event === post.request ? 'P' : event === post.dispatch ? 'P-proof' : 'P-step' })),
  ];
  if (!usageFirstBehind) return entries;
  const pending = Array.from({ length: 7 }, (_, index) => (index === 2
    ? recallStep({ turn: 3, step: 3, target: head.seq, usage: cached(10_300) })
    : { request: plain(3, index + 1, cached(10_000 + 100 * (index + 1))), events: [] }));
  const withdrawn = pending.flatMap(each => [each.request, ...each.events.filter(event => event !== each.request)]);
  for (const [index, each] of pending.entries()) {
    if (index === 2) entries.push(...each.events.map(event => ({ event, tag: event === each.request ? 'd3' : event === each.dispatch ? 'd3-proof' : 'd3-step' })));
    else entries.push({ event: each.request, tag: 'work' });
  }
  const seal2 = pricedSeal(withdrawn, undefined, { cRatio: RATIO });
  const second = recallStep({ turn: 4, step: 1, target: head.seq, usage: cached(16_500, { input: 100, cacheWrite: 400 }) });
  entries.push(
    ...seal2.events.map(event => ({ event, tag: event === seal2.carrier ? 'carrier-2' : 'seal-2' })),
    ...second.events.map(event => ({ event, tag: event === second.request ? 'P2' : event === second.dispatch ? 'P2-proof' : 'P2-step' })),
  );
  return entries;
}

/**
 * The log through the first post's step, then one more main call `X` (a read of the head) at stock 10100 whose request is `how`: `'open'` leaves it as the model requested it, so it may yet prove a recall; `'proven'` dispatches and answers it; `'cancelled'` answers it with the cancellation DSH gives a call it never dispatched, so it is no recall. The tags `X` and `X-proof` name the request and its evidence.
 */
export function afterPostLog(how) {
  const entries = recallLog();
  const through = entries.findLastIndex(entry => entry.tag === 'P-step') + 1;
  const head = entries[0].event;
  const call = readCall('x', head.seq);
  const request = assistantMessage({ text: 'reading back', model: MODEL, turn: 3, step: 1, toolCalls: [call], usage: cached(10_100) });
  const tail = [{ event: stepStart({ turn: 3, step: 1 }), tag: 'X-step' }, { event: request, tag: 'X' }];
  if (how === 'proven') {
    tail.push({ event: toolCall({ turn: 3, step: 1, callId: call.id, name: call.name, arguments: call.arguments }), tag: 'X-proof' });
    tail.push({ event: toolResult({ turn: 3, step: 1, callId: call.id, text: 'the event text' }), tag: 'X-step' });
  } else if (how === 'cancelled') {
    const error = { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' };
    tail.push({ event: toolResult({ turn: 3, step: 1, callId: call.id, text: 'Error: tool call aborted before dispatch', isError: true, error }), tag: 'X-proof' });
  }
  tail.push({ event: stepEnd({ turn: 3, step: 1 }), tag: 'X-step' });
  return [...entries.slice(0, through), ...tail];
}

/**
 * The log through the second carrier, whose post `Z` reports a usage of no tokens at all, then ordinary calls `P3` at stock 10800 and `P4` at 10900: the withdrawn recall request `d3` and the 7 calls around it fall in the one stretch from the first post to `P3`, which `Z` interrupts without being a measured point of it.
 */
export function zeroStockPostLog() {
  const entries = recallLog();
  const through = entries.findIndex(entry => entry.tag === 'P2-step');
  return [
    ...entries.slice(0, through),
    { event: plain(4, 1, cached(0)), tag: 'Z' },
    { event: plain(4, 2, cached(10_800)), tag: 'P3' },
    { event: plain(4, 3, cached(10_900)), tag: 'P4' },
  ];
}
