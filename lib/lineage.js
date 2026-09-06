// lib/lineage.js — Resolve the ordered chain of sessions reachable from a handoff delivery.

// handoff 图可证无环（created_at 沿链单调不减），但 S 标的是 session，而 A→B→A 这类无环链
// 会让同一 session 重复出现 —— 它的 turn_note 只按 source_session_id 索引，会被渲染两遍。
// 故在 session 上截断（保留较新出现），让每个 session 只作为 `CONTEXT.md` Applicable Lineage 的一个
// Lineage Session 成员出现；截断同时把遍历步数上界定在 session 数上。
function walk(store, projectId, headHandoff, seen = new Set()) {
  const chain = [];
  let node = headHandoff;
  while (node && !seen.has(node.sessionId)) {
    seen.add(node.sessionId);
    chain.push({ sessionId: node.sessionId, transcriptPath: node.transcriptPath || null, handoffId: node.handoffId });
    node = store.findParentDelivery(projectId, node.sessionId, node.createdAt);
  }
  return chain.reverse();
}

function label(chain) {
  return chain.map((s, i) => ({ ...s, label: `S${i + 1}` }));
}

/**
 * Resolve the lineage headed by one explicit handoff, oldest-to-newest.
 * The head row's own project is the scope of the walk; an unresolvable head yields [].
 *
 * @param {{ store, handoffId: number }} opts
 * @returns {Array<{ label: string, sessionId: string, transcriptPath: string|null, handoffId: number }>}
 */
export function fromHandoff({ store, handoffId }) {
  const head = store.getHandoff(handoffId);
  if (!head) return [];
  return label(walk(store, head.projectId, head));
}

/**
 * Resolve the lineage of the running session: the ancestors reachable from the latest handoff
 * delivered into it, with the session itself appended as the newest segment.
 *
 * @param {{ store, projectId: string|null, sessionId: string, transcriptPath: string|null }} opts
 * @returns {Array<{ label: string, sessionId: string, transcriptPath: string|null, handoffId: number|null }>}
 */
export function forCurrentSession({ store, projectId, sessionId, transcriptPath }) {
  const head = store.findLatestDeliveryHandoff(projectId, sessionId);
  const ancestors = head ? walk(store, projectId, head, new Set([sessionId])) : [];
  return label([...ancestors, { sessionId, transcriptPath: transcriptPath || null, handoffId: null }]);
}

/**
 * Resolve the lineage the running session is entitled to READ: the head is the newest handoff
 * delivered into this session, and the chain is exactly what fromHandoff would return for it. The
 * current session is deliberately NOT appended — that would shift every S{k} label away from the
 * address contract the load response and the HTTP routes share.
 *
 * @param {{ store, sessionId: string }} opts
 * @returns {Array<{ label: string, sessionId: string, transcriptPath: string|null, handoffId: number }>}
 */
export function forLoadedHandoff({ store, sessionId }) {
  const head = store.findLatestDeliveryInSession(sessionId);
  return head ? fromHandoff({ store, handoffId: head.handoffId }) : [];
}
