// lib/lineage.js — Resolve the ordered chain of sessions reachable from a handoff delivery.
//
// This module alone owns the handoff-graph traversal, the session deduplication and the oldest-to-newest
// order. It reads the stored transcript path into `sourceLocator` and `sourceLabel` and interprets
// neither: the locator is what a DialogueSource is handed, the label is what output naming prints, and
// only the Harness Adapter knows what either one denotes.

// handoff 图可证无环（created_at 沿链单调不减），但 S 标的是 session，而 A→B→A 这类无环链
// 会让同一 session 重复出现 —— 它的 turn_note 只按 source_session_id 索引，会被渲染两遍。
// 故在 session 上截断（保留较新出现），让每个 session 只作为 `CONTEXT.md` Applicable Lineage 的一个
// Lineage Session 成员出现；截断同时把遍历步数上界定在 session 数上。
function walk(store, projectId, headHandoff, seen = new Set()) {
  const chain = [];
  let node = headHandoff;
  while (node && !seen.has(node.sessionId)) {
    seen.add(node.sessionId);
    chain.push({
      sessionId: node.sessionId,
      sourceLocator: node.transcriptPath || null,
      sourceLabel: node.transcriptPath || null,
      handoffId: node.handoffId,
    });
    node = store.findParentDelivery(projectId, node.sessionId, node.createdAt);
  }
  return chain.reverse();
}

/**
 * Resolve the lineage headed by one explicit handoff, oldest-to-newest.
 * The head row's own project is the scope of the walk; an unresolvable head yields [].
 *
 * `handoffId` identifies the handoff that lineage session PRODUCED, which is what lets Turn Browse read
 * a predecessor's `nextTask` by primary key rather than deriving a handoff from a session.
 *
 * @param {{ store, handoffId: number }} opts
 * @returns {Array<{ sessionId: string, sourceLocator: string|null, sourceLabel: string|null,
 *            handoffId: number }>}
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
 *            handoffId: number }>}
 */
export function forLoadedHandoff({ store, sessionId }) {
  const head = store.findLatestDeliveryInSession(sessionId);
  return head ? fromHandoff({ store, handoffId: head.handoffId }) : [];
}
