// lib/tool-effects.js — an Engine record has one grammar for every harness's native tools: the
// translation from an adapter table's `update` vocabulary (`grepMultiFile`, `fullSet`, `write`,
// `lineUpdate`, total adjustment) to the Engine's effect and path telemetry records.

// One resource has ONE fragment key space: every fragment snapshot keys by source line number, so an
// observation that overlaps an earlier one OVERWRITES it instead of accumulating beside it. A whole-content
// snapshot is distinguished by its mutation KIND — `replace-fragments` supersedes the whole set — not by
// carrying a key of its own, which is what a second key space would have meant.
//
// Last write wins within one impact, because a line's own text may begin with a line-number cue and produce
// the same key twice. The Ledger treats a duplicate key inside one impact as an invariant failure, and an
// application invariant failure is owner-fatal — so ordinary file content would kill the owner. Deduping
// here is also what the baseline did: its `_setLine` was a plain `Map.set` per line.
export function lineFragments(lines) {
  const byLine = new Map();
  for (const [line, tokens] of lines) byLine.set(line, tokens);
  return [...byLine].map(([key, tokens]) => ({ key, tokens }));
}

export function effectFor(update, resourceKey) {
  const spentTokens = update.spent > 0 ? update.spent : 0;
  if (update.type === 'grepMultiFile') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: Object.entries(update.files).map(([key, entries]) => ({
        resourceKey: key,
        mutation: { kind: 'merge-fragments', fragments: lineFragments(entries) },
      })),
    };
  }
  if (update.type === 'fullSet') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  if (update.type === 'write') {
    return {
      access: 'write',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  if (update.type === 'lineUpdate') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'merge-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  // A total adjustment localizes nothing, so it allocates no framing overhead and stays single-impact.
  return {
    access: 'write',
    overheadTokens: 0,
    spentTokens,
    impacts: [{ resourceKey, mutation: { kind: 'adjust-total', deltaTokens: update.value } }],
  };
}

// A read of many files fans out one event per file, because the single resolved target is null there and
// one event would drop every touch. Its raw spelling is the canonical key: the tool argument was a
// pattern, not a path.
export function pathEventsFor(update, resourceKey, rawPath, toolType) {
  if (update.type === 'grepMultiFile') {
    return Object.keys(update.files).map(key => ({ path: key, rawPath: key, toolType, isFullRead: 0 }));
  }
  if (resourceKey == null) return [];
  const isFullRead = update.type === 'fullSet' ? 1
    : update.type === 'lineUpdate' ? 0
    : null;   // a write is not a read
  return [{ path: resourceKey, rawPath, toolType, isFullRead }];
}
