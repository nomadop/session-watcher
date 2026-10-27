// dsh/src/composition.js — the one composition of a DSH session's `SessionWatcher`.
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';

import { SessionWatcher } from '../../lib/session-watcher.js';
import { createResourcePolicy } from '../../lib/resource-policy.js';
import { createResourceEnrichment } from '../../lib/resource-enrichment.js';
import { createHandoffComposition } from '../../lib/handoff.js';
import { createMeasurementEngine } from '../../lib/measurement/engine.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { loadPricingOverride } from '../../lib/pricing-store.js';
import { resolveProjectKey } from '../../lib/project-key.js';
import { PLUGIN_VERSION } from '../../lib/version.js';
import {
  ATTRIBUTION_LIMITS, DEFAULT_CACHE_TTL, WORKING_TREE_CACHE_CHARS, WORKING_TREE_CACHE_ENTRIES,
} from '../../lib/constants.js';
import { createNodeWorkingTree } from '../../lib/working-tree.js';
import { createResourceAttribution } from '../../lib/resource-attribution.js';
import { createToolEvidenceInterpreter } from '../../lib/tool-evidence.js';
import { createDshDialogueSource } from '../../lib/harness/dsh/dialogue-source.js';
import { createDshDialogueProjection } from '../../lib/harness/dsh/history-turn-rules.js';
import { createDshMeasurementProjection } from '../../lib/harness/dsh/measurement-projection.js';
import { dshToolEvidenceProfile } from '../../lib/harness/dsh/tool-evidence-profile.js';

/** The Turn Notes root the host binds: under the system temp directory, which DSH's `workspace-write` sandbox admits. */
export const DSH_TURN_NOTES_ROOT = join(tmpdir(), 'session-watcher', 'turn-notes');

// One Node tree for every session of the process: it holds the DSH path namespace, where `~` is a directory name
// and not the home directory, and a bounded cache of file text. The base a relative path resolves against comes
// with each call, so the sessions' directories need no tree of their own.
let sharedWorkingTree = null;

function nodeWorkingTree() {
  sharedWorkingTree ??= createNodeWorkingTree({
    path: nodePath, homeDir: null, cacheEntries: WORKING_TREE_CACHE_ENTRIES, cacheChars: WORKING_TREE_CACHE_CHARS,
  });
  return sharedWorkingTree;
}

// The interpreters the Measurement Projection is built with and the capture-time keys of Turn History: the one
// interpreter over a matcher that reads `workingTree`, the process's Node tree when none is handed over; the
// matcher and the interpreter take the same limits, and the keys at capture resolve a relative path against the
// session's directory as the interpreter does.
function interpretersFor({ workingTree, cwd }) {
  const attribution = createResourceAttribution({ workingTree: workingTree ?? nodeWorkingTree(), limits: ATTRIBUTION_LIMITS });
  const interpreter = createToolEvidenceInterpreter({
    attribution, profile: dshToolEvidenceProfile, limits: ATTRIBUTION_LIMITS,
  });
  return {
    interpretToolUse: interpreter.interpretToolUse,
    completeToolResult: interpreter.completeToolResult,
    resourceKeysOf: (pair, capture) => interpreter.resourceKeysOf(pair, { ...capture, sessionCwd: cwd }),
  };
}

/**
 * A `SessionWatcher` for one DSH session and the Dialogue pair it reads through.
 * The session id is its Source locator, and a null id, the replay route's, archives no profile row; `cwd` is the session header's, the project root and the base a relative tool target resolves against, and `projectId` derives from it through `lib/project-key.js`; Turn Notes live under `turnNotesRoot`; `readSession` is the host's snapshot acquisition; `isIgnored` is the project's ignore matcher, or null.
 * The host, `server.js`'s replay route and the tests compose through it.
 * The model policy prices a model under `cacheTtl()`, the lifetime the route of the session's latest measured call declares, or under `DEFAULT_CACHE_TTL` when it declares none, and takes a saved pricing override's `ratio` as its `cRatio`, read from the store singleton on every resolution.
 * A call's text is attributed to the lines of the files it holds, matched against `workingTree` (the Node tree of the DSH namespace the process shares, unless one is handed over), and each live call keeps its record.
 *
 * @param {{ sessionId: string|null, cwd: string|null, store: object, turnNotesRoot: string,
 *   readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   isIgnored: ((path: string) => boolean)|null, cacheTtl: () => string|null,
 *   workingTree?: object }} options
 * @returns {{ watcher: SessionWatcher, dialogueSource: object, dialogueProjection: object }}
 */
export function composeWatcher({
  sessionId, cwd, store, turnNotesRoot, readSession, isIgnored, cacheTtl, workingTree,
}) {
  const dialogueSource = createDshDialogueSource({ readSession });
  const dialogueProjection = createDshDialogueProjection();
  const { interpretToolUse, completeToolResult, resourceKeysOf } = interpretersFor({ workingTree, cwd });
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
      cwd, projectRoot: cwd, resolveModelPolicy, interpretToolUse, completeToolResult,
    }),
    resourceKeysOf,
    modelPolicyFor: (modelId) => {
      const policy = modelPolicyFor(modelId, cacheTtl() ?? DEFAULT_CACHE_TTL);
      const saved = loadPricingOverride(modelId);
      if (saved) policy.cRatio = saved.ratio;
      return policy;
    },
  });
  return { watcher, dialogueSource, dialogueProjection };
}
