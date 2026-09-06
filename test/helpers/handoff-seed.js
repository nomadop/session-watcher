// Seed a handoff whose legacy delivery columns are bound to `sessionId`. Tests that need the append-only
// delivery fact call the real load route afterward; that route is what writes `handoff_load` atomically.
// Shared by the turn-page tests and the read-tool tests.

export function _seedDeliveredHandoff(store, { sessionId, sourceSessionId, loadToken, transcriptPath, projectId = 'proj-boot' }) {
  const { handoffId } = store.insertHandoff({
    sessionId: sourceSessionId, segment: 0, loadToken,
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'turn page test summary',
    summaryTokens: 10, projectId, transcriptPath,
  });
  store._db.prepare('UPDATE handoff SET delivered_at=?, delivered_session_id=? WHERE handoff_id=?')
    .run(Date.now(), sessionId, handoffId);
  return handoffId;
}
