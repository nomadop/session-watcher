// test/helpers/dsh-selection-oracle.js — which main-call usages of a DSH session stand in the measurement after the inner seals it holds, written from the log alone.
// The expectation is the structure the log shows: in each epoch, the head (the first call with a usage through the first call with a positive stock), the first main call after each carrier, and the calls no seal replaced. It reads no reducer, no fold and no carrier field but its position; the ranges are the seals' own, as the run that wrote them recorded them.

const isCheckpoint = event => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint' && event.surfaceOp?.op === 'replace';
const stockOf = ({ inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 }) => inputTokens + cacheReadTokens + cacheWriteTokens;

/**
 * The seqs of the usage-bearing main calls whose usage stands, in log order.
 * `carriers` are the seqs of the seals' carrier events and `ranges[i]` the seqs the seal of `carriers[i]` replaced; a stock compaction's checkpoint opens an epoch of its own, and a carrier's post is the first main call after it in its epoch, whether or not that call reports a usage.
 * @param {{ events: object[], carriers: number[], ranges: number[][] }} log
 * @returns {number[]}
 */
export function standingUsages({ events, carriers, ranges }) {
  const epochs = [[]];
  for (const event of events) {
    if (isCheckpoint(event)) epochs.push([]);
    epochs.at(-1).push(event);
  }
  return epochs.flatMap((epoch) => {
    const calls = epoch.filter(event => event.type === 'assistant/message');
    const withUsage = calls.filter(event => event.data.usage !== undefined);
    const firstPositive = withUsage.findIndex(event => stockOf(event.data.usage) > 0);
    const head = withUsage.slice(0, firstPositive < 0 ? withUsage.length : firstPositive + 1);
    const sealed = new Set(), posts = [];
    carriers.forEach((carrier, index) => {
      if (!epoch.some(event => event.seq === carrier)) return;
      ranges[index].forEach(seq => sealed.add(seq));
      posts.push(calls.find(event => event.seq > carrier));
    });
    return withUsage
      .filter(event => head.includes(event) || posts.includes(event) || !sealed.has(event.seq))
      .map(event => event.seq);
  });
}
