// dsh/src/composition.js — the one composition of a DSH session's `SessionWatcher`.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionWatcher } from '../../lib/session-watcher.js';
import { createResourcePolicy } from '../../lib/resource-policy.js';
import { createResourceEnrichment } from '../../lib/resource-enrichment.js';
import { createHandoffComposition } from '../../lib/handoff.js';
import { createMeasurementEngine } from '../../lib/measurement/engine.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { loadPricingOverride } from '../../lib/pricing-store.js';
import { resolveProjectKey } from '../../lib/project-key.js';
import { PLUGIN_VERSION } from '../../lib/version.js';
import { DEFAULT_CACHE_TTL } from '../../lib/constants.js';
import { createDshDialogueSource } from '../../lib/harness/dsh/dialogue-source.js';
import { createDshDialogueProjection } from '../../lib/harness/dsh/history-turn-rules.js';
import { createDshMeasurementProjection } from '../../lib/harness/dsh/measurement-projection.js';
import { interpretDshToolUse, completeDshToolResult } from '../../lib/harness/dsh/native-tools.js';

/** The Turn Notes root the host binds: under the system temp directory, which DSH's `workspace-write` sandbox admits. */
export const DSH_TURN_NOTES_ROOT = join(tmpdir(), 'session-watcher', 'turn-notes');

/**
 * A `SessionWatcher` for one DSH session and the Dialogue pair it reads through.
 * The session id is its Source locator, and a null id, the replay route's, archives no profile row; `cwd` is the session header's, the project root and the base a relative tool target resolves against, and `projectId` derives from it through `lib/project-key.js`; Turn Notes live under `turnNotesRoot`; `readSession` is the host's snapshot acquisition; `isIgnored` is the project's ignore matcher, or null.
 * The host, `server.js`'s replay route and the tests compose through it.
 * The model policy prices a model under `cacheTtl()`, the lifetime the route of the session's latest measured call declares, or under `DEFAULT_CACHE_TTL` when it declares none, and takes a saved pricing override's `ratio` as its `cRatio`, read from the store singleton on every resolution.
 *
 * @param {{ sessionId: string|null, cwd: string|null, store: object, turnNotesRoot: string,
 *   readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   isIgnored: ((path: string) => boolean)|null, cacheTtl: () => string|null }} options
 * @returns {{ watcher: SessionWatcher, dialogueSource: object, dialogueProjection: object }}
 */
export function composeWatcher({ sessionId, cwd, store, turnNotesRoot, readSession, isIgnored, cacheTtl }) {
  const dialogueSource = createDshDialogueSource({ readSession });
  const dialogueProjection = createDshDialogueProjection({ sessionCwd: cwd });
  const watcher = new SessionWatcher({
    sessionId,
    sourceLocator: sessionId,
    projectId: resolveProjectKey({ cwd }),
    projectRoot: cwd,
    turnNotesRoot,
    resourcePolicy: createResourcePolicy({ projectRoot: cwd, isIgnored }),
    resourceEnrichment: createResourceEnrichment(),
    handoffComposition: createHandoffComposition(),
    loaderVersion: PLUGIN_VERSION,
    store,
    dialogueSource,
    dialogueProjection,
    createEngine: createMeasurementEngine,
    createMeasurementProjection: (_locator, resolveModelPolicy) => createDshMeasurementProjection({
      cwd, projectRoot: cwd, resolveModelPolicy,
      interpretToolUse: interpretDshToolUse,
      completeToolResult: completeDshToolResult,
    }),
    modelPolicyFor: (modelId) => {
      const policy = modelPolicyFor(modelId, cacheTtl() ?? DEFAULT_CACHE_TTL);
      const saved = loadPricingOverride(modelId);
      if (saved) policy.cRatio = saved.ratio;
      return policy;
    },
  });
  return { watcher, dialogueSource, dialogueProjection };
}
