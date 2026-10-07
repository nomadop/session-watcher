// lib/harness/claude-code/measurement-projection.js — Claude Code Measurement Projection.
// A thin Adapter: the phase machine, the Segment Telemetry sidecar and the mapping to MeasurementRecords
// live in `lib/measurement-projection.js`. What it adds is this host's own — the checks on the functions
// its composition injects, the context native interpretation reads with the transcript's own directory in
// it, the task-notification observation it answers before delegating, and its diagnostic scope and capture
// labels.

import nodePath from 'node:path';
import { homedir } from 'node:os';

import { createMeasurementProjection } from '../../measurement-projection.js';

function invariant(ok, message) {
  if (!ok) throw new Error(`claude code measurement projection invariant: ${message}`);
}

export function createClaudeCodeMeasurementProjection({
  cwd = null,
  projectRoot = null,
  sourceLocator = null,
  resolveModelPolicy,
  interpretToolUse,
  completeToolResult,
  interpretSkillPayload,
  interpretTaskNotification,
} = {}) {
  invariant(typeof resolveModelPolicy === 'function', 'resolveModelPolicy must be a function');
  invariant(typeof interpretToolUse === 'function', 'interpretToolUse must be a function');
  invariant(typeof completeToolResult === 'function', 'completeToolResult must be a function');
  invariant(typeof interpretSkillPayload === 'function', 'interpretSkillPayload must be a function');
  invariant(typeof interpretTaskNotification === 'function', 'interpretTaskNotification must be a function');

  // The immutable session directory native target resolution falls back to when a row names none of its own.
  // An empty session directory falls through to the project root: the composition supplied no directory, and
  // the layer below this one sees only the value that survives here.
  const sessionCwd = cwd || projectRoot || null;
  // The transcript's own directory is the last resort of native target resolution. A null locator has no
  // directory, so the Projection resolves none rather than naming the host process's working directory.
  const transcriptDir = typeof sourceLocator === 'string' && sourceLocator.length > 0
    ? nodePath.dirname(sourceLocator)
    : null;
  // The path and home-directory capabilities native interpretation reaches the filesystem namespace
  // through; it holds no implementation of its own, so the Projection supplies one and the target
  // resolution order below is the whole of this Harness's ambient directory knowledge.
  const context = { path: nodePath, homedir, sessionCwd, transcriptDir, resolveModelPolicy };

  const shared = createMeasurementProjection({
    scope: 'claude-code-measurement-projection',
    context,
    captureSources: { live: 'cc-live', replay: 'cc-replay' },
    interpretToolUse,
    completeToolResult,
    interpretSkillPayload,
  });

  function project(observation) {
    if (observation?.type === 'task-notification') {
      // A sub-agent completion notice is residual evidence on its own, with no tool use to correlate and
      // no step whose telemetry it belongs to.
      const interpreted = interpretTaskNotification(observation);
      return {
        records: [
          ...interpreted.effects.map(effect => ({ type: 'effect', ...effect })),
          ...interpreted.residuals.map(residual => ({ type: 'residual', ...residual })),
        ],
        diagnostics: [],
      };
    }
    return shared.project(observation);
  }

  return { project, finishSegment: shared.finishSegment };
}
