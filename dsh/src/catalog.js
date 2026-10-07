// dsh/src/catalog.js — the pending-handoff catalog the host injects into a starting agent, built by the Claude Code SessionStart hook's own discovery call.
import { randomUUID } from 'node:crypto';

import { discoverHandoffs, formatHandoffContext } from '../../lib/handoff-discovery.js';
import {
  HANDOFF_HOOK_TTL_DAYS, HANDOFF_HOOK_QUERY_LIMIT, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS,
} from '../../lib/constants.js';

/**
 * The user message announcing the handoffs pending under `projectId` that another session prepared, its text the hook's; its source kind is the plugin's own, so the DSH reducer yields no Observation for it.
 * @returns the message, or null when no handoff is pending or `projectId` is null
 */
export function catalogMessageFor({ dbPath, projectId, sessionId }) {
  const rows = discoverHandoffs(dbPath, projectId, sessionId, {
    ttlDays: HANDOFF_HOOK_TTL_DAYS, queryLimit: HANDOFF_HOOK_QUERY_LIMIT,
  });
  const text = formatHandoffContext(rows, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS);
  if (text === null) return null;
  return {
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'session-watcher', form: 'catalog' },
  };
}
