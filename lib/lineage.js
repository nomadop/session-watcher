// lib/lineage.js — Resolve the ordered chain of lineage members reachable from a handoff delivery.
//
// This module alone owns the handoff-graph traversal, the cycle stop and the oldest-to-newest order. A
// member is one handoff: the walk starts at the head handoff and steps to the newest delivery into the
// producing session loaded no later than the node's creation (a delivery of the session's own handoff
// included), so a session that loads its own handoff is a member again for each epoch. A `handoffId` the
// walk has already visited ends it, which is also what bounds the steps by the number of handoffs.
// It reads the stored transcript path into `sourceLocator` and `sourceLabel` and interprets neither: the
// locator is what a DialogueSource is handed, the label is what output naming prints, and only the Harness
// Adapter knows what either one denotes.
//
// An entry is `{ sessionId, sourceLocator, sourceLabel, handoffId, window: { after, through } }`. `window`
// says which of the session's turns the entry holds, in wall-clock terms: `through` is the entry's own
// handoff `createdAt`, `after` is the `createdAt` of the nearest earlier entry of the same session in the
// lineage, `null` when there is none. The readers apply it through `admitsTurn` in lib/turn.js.

// 遍历按 handoffId 记已访问节点：父边在同一毫秒内也可能指回自身或成环，已访问即止。节点链随后按
// oldest-first 映射成条目，每个条目的 `window` 由链序算出（见文件头的条目形状）。
function walk(store, projectId, headHandoff) {
  const seen = new Set();
  const chain = [];
  let node = headHandoff;
  while (node && !seen.has(node.handoffId)) {
    seen.add(node.handoffId);
    chain.push(node);
    node = store.findParentDelivery(projectId, node.sessionId, node.createdAt);
  }
  const entries = [];
  for (const handoff of chain.reverse()) {
    const earlier = entries.findLast(e => e.sessionId === handoff.sessionId);
    entries.push({
      sessionId: handoff.sessionId,
      sourceLocator: handoff.transcriptPath || null,
      sourceLabel: handoff.transcriptPath || null,
      handoffId: handoff.handoffId,
      window: { after: earlier ? earlier.window.through : null, through: handoff.createdAt },
    });
  }
  return entries;
}

/**
 * Resolve the lineage headed by one explicit handoff, oldest-to-newest.
 * The head row's own project is the scope of the walk; an unresolvable head yields [].
 *
 * `handoffId` identifies the handoff that lineage member PRODUCED, which is what lets Turn Browse read
 * a predecessor's `nextTask` by primary key rather than deriving a handoff from a session.
 *
 * @param {{ store, handoffId: number }} opts
 * @returns {Array<{ sessionId: string, sourceLocator: string|null, sourceLabel: string|null,
 *            handoffId: number, window: { after: number|null, through: number } }>}
 */
export function fromHandoff({ store, handoffId }) {
  const head = store.getHandoff(handoffId);
  if (!head) return [];
  return walk(store, head.projectId, head);
}

/**
 * Resolve the lineage the running session is entitled to READ: the head is the newest handoff
 * delivered into this session, and the chain is exactly what fromHandoff would return for it. The
 * current session is deliberately NOT appended — that would shift every S{k} label away from the
 * address contract the load response and the HTTP routes share.
 *
 * @param {{ store, sessionId: string }} opts
 * @returns {Array<{ sessionId: string, sourceLocator: string|null, sourceLabel: string|null,
 *            handoffId: number, window: { after: number|null, through: number } }>}
 */
export function forLoadedHandoff({ store, sessionId }) {
  const head = store.findLatestDeliveryInSession(sessionId);
  return head ? fromHandoff({ store, handoffId: head.handoffId }) : [];
}
