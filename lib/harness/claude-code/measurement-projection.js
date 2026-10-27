// lib/harness/claude-code/measurement-projection.js — Claude Code Measurement Projection.
// A thin Adapter: the phase machine, the Segment Telemetry sidecar and the mapping to MeasurementRecords
// live in `lib/measurement-projection.js`. What it adds is this host's own — the checks on the functions
// its composition injects, the context they read, the task-notification observation it answers before
// delegating, and its diagnostic scope and capture labels.

import { createMeasurementProjection } from '../../measurement-projection.js';

function invariant(ok, message) {
  if (!ok) throw new Error(`claude code measurement projection invariant: ${message}`);
}

export function createClaudeCodeMeasurementProjection({
  cwd = null,
  projectRoot = null,
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

  // The immutable session directory a relative path resolves against when a row names none of its own. An
  // empty session directory falls through to the project root: the composition supplied no directory, and
  // the layer below this one sees only the value that survives here. With neither, a relative path has no base.
  const sessionCwd = cwd || projectRoot || null;
  const context = { sessionCwd, resolveModelPolicy };

  const shared = createMeasurementProjection({
    scope: 'claude-code-measurement-projection',
    context,
    captureSources: { live: 'cc-live', replay: 'cc-replay' },
    interpretToolUse,
    completeToolResult,
    interpretSkillPayload,
  });

  function project(observation, frameCtx) {
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
    return shared.project(observation, frameCtx);
  }

  return { project, finishSegment: shared.finishSegment };
}
