// lib/turn-read-service.js — the turn read tools' service, which both hosts call: `server.js`'s `createServer`, which hands it to the Claude Code MCP tools, and the DSH host's tools.
//
// The read tools take no lineage identifier. forLoadedHandoff resolves the newest handoff delivered into the session `sessionId` names and runs the same walk as the explicit-head HTTP routes. The page result is byte-identical; search and locate add only their tool-side recovery. Because the head is never a parameter, "you must have loaded a handoff" is a precondition the schema cannot express wrongly — there is no guessable integer to fabricate.
//
// An address the caller supplied that does not resolve is rethrown with its recovery as the message: the HTTP route answers 404 there, and 404 has no meaning to a tool, while turn_page_unavailable's "call again" would be wrong advice for a value that reproduces the same failure. A `k` that breaks the position grammar, or names a position the lineage lacks, is thrown the same way.
//
// `lineageHeadlines` answers the lineage map, not turn history: its answer is the complete headlines of the positions asked for, with no budget, because the positions are what the caller chose.
import { forLoadedHandoff } from './lineage.js';
import { parseLineagePositions, selectLineagePositions } from './lineage-headlines.js';
import {
  NO_HANDOFF_LOADED, STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE, UNUSABLE_POSITIONS_MESSAGE,
  withPageRecovery, withSearchRecovery, withLocateRecovery, withHeadlinesRecovery,
} from './turn-tool-recovery.js';
import { lineageHeadlines } from './turn-browse.js';
import { buildTurnPage } from './turn-page.js';
import { searchTranscripts, locateRanges } from './turn-query.js';
import { turnPageWire } from './wire.js';

/**
 * @param {object} deps
 * @param {() => object} deps.store - thunk returning the store, read on every call
 * @param {() => string} deps.sessionId - thunk naming the session whose newest delivered handoff heads the lineage
 * @param {object} deps.dialogueSource
 * @param {object} deps.dialogueProjection
 * @param {{ notice: string, searchHit: string, locateHit: string }} deps.recovery - the host's own sentences
 * @param {Function} [deps.turnPageBuilder]
 * @returns {{ turnPage: Function, turnSearch: Function, turnLocate: Function, lineageHeadlines: Function }}
 */
export function createTurnReadService({
  store, sessionId, dialogueSource, dialogueProjection, recovery, turnPageBuilder = buildTurnPage,
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
          store: store(), lineage, q, scope: scope || null, ...history,
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

    // The lineage resolves first, then `k`, then the headline reads: a caller that loaded nothing meets
    // no_handoff_loaded whatever it passed, and a `k` that cannot parse costs no turn-note read. The throw
    // stays outside the try so that it is not mistaken for a store failure.
    async lineageHeadlines({ k } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const ranges = parseLineagePositions(k);
        if (ranges !== null) {
          const selected = selectLineagePositions(lineageHeadlines({ store: store(), lineage }), ranges);
          if (selected !== null) return { lineage: selected };
        }
      } catch (err) {
        if (process.env.SW_DEBUG) console.error('[lineage_headlines_tool]', err);
        return withHeadlinesRecovery({ error: 'lineage_headlines_unavailable', retryable: true });
      }
      throw new Error(UNUSABLE_POSITIONS_MESSAGE);
    },
  };
}
