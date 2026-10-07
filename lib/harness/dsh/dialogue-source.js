// lib/harness/dsh/dialogue-source.js — DSH DialogueSource Adapter.
// A read-only pull path: one call reads the complete Source, and resolves to a detached canonical
// multi-epoch observation snapshot. The Adapter is the only interpreter of `sourceLocator`; DSH uses the
// session id. `readSession` is the host's acquisition, injected so this module reads no store and no
// process-level session registry.

import { reduceDshSnapshot } from './transcript-observation.js';

/**
 * @param {{ readSession: (sessionId: string) => Promise<{ events: object[] }> }} options - `readSession`
 *        resolves to a DSH v4 snapshot; only its `events` are read, since the header is the composition
 *        root's business (`projectId` via `lib/project-key.js`)
 * @returns {{ read: (sessionId: string) => Promise<{ status: 'ok', observations: object[] }
 *   | { status: 'unavailable', observations: [] }> }}
 */
export function createDshDialogueSource({ readSession }) {
  return {
    async read(sessionId) {
      let snapshot;
      // Acquisition failure is a read result, not application health, and not a reducer invariant
      // failure: only the acquisition itself is guarded here, so a reducer throw still propagates.
      try { snapshot = await readSession(sessionId); }
      catch { return { status: 'unavailable', observations: [] }; }
      return { status: 'ok', observations: reduceDshSnapshot(snapshot.events).observations };
    },
  };
}
