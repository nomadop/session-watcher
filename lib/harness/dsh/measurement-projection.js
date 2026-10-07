// lib/harness/dsh/measurement-projection.js — DSH Measurement Projection.
// A thin Adapter: the phase machine, the Segment Telemetry sidecar and the mapping to MeasurementRecords
// live in `lib/measurement-projection.js`. What it adds is this host's own — the checks on the interpreters
// its composition injects, the context native interpretation reads, and its diagnostic scope and capture
// labels.

import nodePath from 'node:path';

import { createMeasurementProjection } from '../../measurement-projection.js';

function invariant(ok, message) {
  if (!ok) throw new Error(`dsh measurement projection invariant: ${message}`);
}

// A DSH `skill` result carries the skill body itself, so `completeDshToolResult` arms no payload
// continuation and the shared Projection never reaches this slot.
function noSkillPayload() {
  invariant(false, 'no skill payload phase in DSH');
}

export function createDshMeasurementProjection({
  cwd = null,
  projectRoot = null,
  resolveModelPolicy,
  interpretToolUse,
  completeToolResult,
} = {}) {
  invariant(typeof interpretToolUse === 'function', 'interpretToolUse must be a function');
  invariant(typeof completeToolResult === 'function', 'completeToolResult must be a function');

  // The session directory native target resolution resolves a relative target against. DSH reads `~` as a
  // directory name, so the context carries no home directory.
  const context = { path: nodePath, sessionCwd: cwd || projectRoot || null, resolveModelPolicy };

  return createMeasurementProjection({
    scope: 'dsh-measurement-projection',
    context,
    captureSources: { live: 'dsh-live', replay: 'dsh-replay' },
    interpretToolUse,
    completeToolResult,
    interpretSkillPayload: noSkillPayload,
  });
}
