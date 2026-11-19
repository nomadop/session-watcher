// test/helpers/dsh-inner-reminder-log.js — a DSH session log on a static grid, sealed on a fixed cadence, whose qualified path has a closed form.
// The grid: the head at stock B and the post behind the n-th carrier at B + n·D, with D the growth the carrier keeps per interval and each interval spanning `SEAL_EVERY` main calls. With R the price ratio of the model, `SEAL_EVERY·D / (2·R·B)` is the first interval's bill, the n posts together cost `n²` of it, and the wallet clock pays every interval but the first (no growth is realized before it) at the interval of the movable fraction that growth gives, `uAtBr(mf, BR_AMBER)² / 2`, the growth per main call being `D / SEAL_EVERY`. Nothing here reads the product: `test/dsh.inner-reminder-qualified-path.integration.test.js` `unsealed ordinary session` checks the table against a plain path of the same stocks whose metered calls lie as far apart.
import { assistantMessage, innerSealCarrier } from './dsh-events.js';

// The model whose `C_RATIO_TABLE` row gives the price ratio R.
export const MODEL = 'claude-sonnet-4-5';
export const HEAD_STOCK = 20_000;
export const SEAL_EVERY = 8;
// The growth each call leaves in the carrier, and the growth a call adds on top of its predecessor while it is still unsealed.
export const KEPT_STEP = 1_000;
export const PENDING_STEP = 2_000;
export const CALLS = 111;

/**
 * `calls` main calls whose stock is the head's plus what every sealed cycle left plus the unsealed growth of the cycle's calls so far; after every `SEAL_EVERY` calls the carrier lists them. Each entry is `{ event, kind, post }`, `post` the number of carriers the call follows when it is the first main call behind one.
 */
export function authoredLog({ calls = CALLS, sealed = true } = {}) {
  const entries = [];
  let block = [];
  let kept = 0;
  let age = 0;
  let carriers = 0;
  let behindCarrier = false;
  for (let index = 0; index < calls; index += 1) {
    if (sealed && age === SEAL_EVERY) {
      entries.push({ event: innerSealCarrier({ sourceEventSeqs: block.map(call => call.seq) }), kind: 'carrier', post: null });
      kept += KEPT_STEP * SEAL_EVERY;
      age = 0;
      block = [];
      carriers += 1;
      behindCarrier = true;
    }
    const call = assistantMessage({
      text: 'work', model: MODEL,
      usage: { inputTokens: 0, outputTokens: 100, cacheReadTokens: HEAD_STOCK + kept + PENDING_STEP * age, cacheWriteTokens: 0 },
    });
    entries.push({ event: call, kind: 'call', post: behindCarrier ? carriers : null });
    block.push(call);
    age += 1;
    behindCarrier = false;
  }
  return entries;
}

// The ledger a post leaves: the head and the n posts as the closed form prices them. Derived from `D = KEPT_STEP·SEAL_EVERY`, `B = HEAD_STOCK` and `R`, the ratio of `MODEL`: bill `n²` first intervals, wallet `n²−1` of them over the interval of the movable fraction.
export const BUDGET_AT_POST = {
  1: { bill: 0.128, wallet: 0 },
  2: { bill: 0.512, wallet: 0.19441111532548466 },
  3: { bill: 1.152, wallet: 0.5184296408679592 },
  4: { bill: 2.048, wallet: 0.9720555766274233 },
  5: { bill: 3.2, wallet: 1.5552889226038775 },
  13: { bill: 21.632, wallet: 10.887022458227142 },
};
