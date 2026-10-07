// lib/turn-read-service.js — the three turn read tools' service, which both hosts call: `server.js`'s `createServer`, which hands it to the Claude Code MCP tools, and the DSH host's tools.
//
// The three read tools take no lineage identifier. forLoadedHandoff resolves the newest handoff delivered into the session `sessionId` names and runs the same walk as the explicit-head HTTP routes. The page result is byte-identical; search and locate add only their tool-side recovery. Because the head is never a parameter, "you must have loaded a handoff" is a precondition the schema cannot express wrongly — there is no guessable integer to fabricate.
//
// An address the caller supplied that does not resolve is rethrown with its recovery as the message: the HTTP route answers 404 there, and 404 has no meaning to a tool, while turn_page_unavailable's "call again" would be wrong advice for a value that reproduces the same failure.
import { forLoadedHandoff } from './lineage.js';
import {
  NO_HANDOFF_LOADED, STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE,
  withPageRecovery, withSearchRecovery, withLocateRecovery,
} from './turn-tool-recovery.js';
import { buildTurnPage } from './turn-page.js';
import { searchTranscripts, locateRanges } from './turn-query.js';
import { turnPageWire } from './wire.js';

/**
 * @param {object} deps
 * @param {() => object} deps.store - thunk returning the store, read on every call
 * @param {() => string} deps.sessionId - thunk naming the session whose newest delivered handoff heads the lineage
 * @param {object} deps.dialogueSource
 * @param {object} deps.dialogueProjection
 * @param {(pair: object) => boolean} deps.includeToolEvidence - search's admission of a tool pair
 * @param {{ notice: string, searchHit: string, locateHit: string }} deps.recovery - the host's own sentences
 * @param {Function} [deps.turnPageBuilder]
 * @returns {{ turnPage: Function, turnSearch: Function, turnLocate: Function }}
 */
export function createTurnReadService({
  store, sessionId, dialogueSource, dialogueProjection, includeToolEvidence, recovery, turnPageBuilder = buildTurnPage,
}) {
  const history = { dialogueSource, dialogueProjection, notice: recovery.notice };
  return {
    async turnPage({ before = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const page = await turnPageBuilder({
          store: store(), lineage, before: before || null, ...history,
        });
        return withPageRecovery(turnPageWire(page));
      } catch (err) {
        if (err && err.code === 'not_found') throw new Error(STALE_CURSOR_MESSAGE);
        if (process.env.SW_DEBUG) console.error('[turn_page_tool]', err);
        return withPageRecovery({ error: 'turn_page_unavailable', retryable: true });
      }
    },

    async turnSearch({ q, scope = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const found = await searchTranscripts({
          store: store(), lineage, q, scope: scope || null, ...history, includeToolEvidence,
        });
        return withSearchRecovery(found, { hitRecovery: recovery.searchHit });
      } catch (err) {
        if (err && err.code === 'scope_not_found') throw new Error(SCOPE_ABSENT_MESSAGE);
        if (process.env.SW_DEBUG) console.error('[turn_search_tool]', err);
        return withSearchRecovery({ error: 'search_unavailable' });
      }
    },

    async turnLocate({ q } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const located = await locateRanges({ store: store(), lineage, q, ...history });
        return withLocateRecovery(located, { hitRecovery: recovery.locateHit });
      } catch (err) {
        if (process.env.SW_DEBUG) console.error('[turn_locate_tool]', err);
        return withLocateRecovery({ error: 'locate_unavailable' });
      }
    },
  };
}
