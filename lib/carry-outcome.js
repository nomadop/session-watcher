// PURE transformer: folded per-segment step records + raw per-touch events → normalized rows for
// profile_step_usage / profile_path_event. No I/O, no store access, and — critically — NO import of
// fold.js/watcher.js/store.js, so this stays a leaf and no import cycle forms. Called from the live
// archival path in fold.js (handleSegmentBoundary), and — because the sweep reuses that SAME
// production replay/boundary — it covers the crash-recovery path too, with no separate replay module.

// Collapse step records to one row per foldedSeq (a step may be revised in place during folding —
// keep the highest-total revision, matching foldCall's snapshot-fold rule). Assign a 0-based
// event_ordinal to each touch within its step, in arrival order.
export function buildTelemetryPayload(segmentCalls, pathEvents) {
  const bySeq = new Map();
  for (const c of segmentCalls) {
    const total = (c.cacheRead || 0) + (c.cacheCreation || 0) + (c.input || 0) + (c.output || 0);
    const prev = bySeq.get(c.foldedSeq);
    const prevTotal = prev ? (prev.cacheRead || 0) + (prev.cacheCreation || 0) + (prev.input || 0) + (prev.output || 0) : -1;
    if (!prev || total >= prevTotal) {
      bySeq.set(c.foldedSeq, {
        foldedSeq: c.foldedSeq, ts: c.ts ?? null,
        cacheRead: c.cacheRead ?? null, cacheCreation: c.cacheCreation ?? null,
        input: c.input ?? null, output: c.output ?? null,
        toolCalls: c.toolCalls ?? null,
        // load_token is sticky across revisions — a later revision with null must not erase it.
        loadToken: c.loadToken ?? (prev ? prev.loadToken : null),
      });
    } else if (c.loadToken && prev && !prev.loadToken) {
      prev.loadToken = c.loadToken;
    }
  }
  const steps = [...bySeq.values()].sort((a, b) => a.foldedSeq - b.foldedSeq);

  const ordinalBySeq = new Map();
  const events = [];
  for (const e of pathEvents) {
    const ord = ordinalBySeq.get(e.foldedSeq) || 0;
    ordinalBySeq.set(e.foldedSeq, ord + 1);
    events.push({ foldedSeq: e.foldedSeq, eventOrdinal: ord, path: e.path, rawPath: e.rawPath ?? e.path ?? null, toolType: e.toolType, isFullRead: e.isFullRead ?? null });
  }
  return { steps, events };
}
