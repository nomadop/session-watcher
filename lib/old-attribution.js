// lib/old-attribution.js — the Old Attribution Scorer: while the held view replays one raw slice, which successful tool
// calls returned mostly lines of files that their Context Epoch already held when the call's step started. A call is
// scored from its saved Attribution Record, which the interpreter decodes and hands over before it prices the record
// or folds it into the epoch's scratch (`frameCtx.observeRecord`); a call whose record is missing or unreadable is no
// evidence and leaves the steps that start after it in its epoch unscored. Everything it keeps is local to one replay.

// A read is a hit above this share of its determinable lines, strictly; the monitor's slot detail rounds the share it shows against it.
export const OLD_SHARE_ABOVE = 0.9;

/**
 * The scorer of one replay. `startStep(stepKey)` opens the step a raw `step/start` names, `startEpoch()` closes the step
 * in progress and clears the epoch's gap at a Context Epoch boundary, and `observe(call)` takes each file call's decoded
 * record before it is folded into `call.scratch`, the epoch's per-resource line entries. `hits` lists, in the order the
 * calls complete, `{ toolUseId, seq, oldLines, newLines }` of each call that is a hit.
 * @returns {{ hits: object[], startStep: function, startEpoch: function, observe: function }}
 */
export function createOldAttributionScorer() {
  const hits = [];
  // The step in progress: `scored` is false when a gap came before it in its epoch; `undo` holds, for each line a call of
  // the step has folded into the scratch, what the scratch held of it when the step started (null for none), so the
  // step's baseline is the same for every call of it, whichever completed first.
  let step = null;
  let gapSeen = false;

  const startStep = (key) => { step = { key, scored: !gapSeen, undo: new Map() }; };
  const startEpoch = () => { step = null; gapSeen = false; };

  // The record's lines that the scratch is about to change are noted before it does, each at its first change in the step.
  function freeze(record, scratch) {
    for (const { impacts } of record.effects) {
      for (const { resourceKey, kind, entries } of impacts) {
        const before = scratch.get(resourceKey);
        const undone = step.undo.get(resourceKey) ?? new Map();
        if (kind === 'replace-fragments') {
          for (const [line, entry] of before ?? []) if (!undone.has(line)) undone.set(line, entry);
        }
        for (const { key } of entries) if (!undone.has(key)) undone.set(key, before?.get(key) ?? null);
        step.undo.set(resourceKey, undone);
      }
    }
  }

  // The file as the step started: its line entry, and whether a line of fingerprint `fp` may be one the epoch held under
  // another number, which is so when the fingerprint is held at another line or a held line has none to rule it out.
  function heldIn(resourceKey, scratch) {
    const undone = step.undo.get(resourceKey);
    let overview = null;
    const overviewOf = () => {
      const lines = new Map(scratch.get(resourceKey));
      for (const [line, entry] of undone ?? []) {
        if (entry === null) lines.delete(line);
        else lines.set(line, entry);
      }
      const fps = new Set();
      let unfingerprinted = false;
      for (const entry of lines.values()) {
        if (entry.fp === undefined) unfingerprinted = true;
        else fps.add(entry.fp);
      }
      return { fps, unfingerprinted };
    };
    return {
      entryAt: line => (undone?.has(line) ? undone.get(line) ?? undefined : scratch.get(resourceKey)?.get(line)),
      mayHaveMoved(fp) {
        overview ??= overviewOf();
        return overview.unfingerprinted || overview.fps.has(fp);
      },
    };
  }

  // The lines the record's read effects returned, each (resource, line) once: not the entries relocation inserted, and
  // none without a fingerprint, of which nothing can be said.
  function returnedBy(record) {
    const byResource = new Map();
    for (const { access, impacts } of record.effects) {
      if (access !== 'read') continue;
      for (const { resourceKey, entries } of impacts) {
        const lines = byResource.get(resourceKey) ?? new Map();
        for (const { key, fp, moved } of entries) if (moved !== true && fp !== undefined) lines.set(key, fp);
        byResource.set(resourceKey, lines);
      }
    }
    return byResource;
  }

  function score({ pending, observation, record, scratch }) {
    let oldLines = 0;
    let newLines = 0;
    for (const [resourceKey, lines] of returnedBy(record)) {
      const held = heldIn(resourceKey, scratch);
      for (const [key, fp] of lines) {
        if (held.entryAt(key)?.fp === fp) oldLines += 1;
        else if (!held.mayHaveMoved(fp)) newLines += 1;
      }
    }
    if (oldLines > 0 && oldLines / (oldLines + newLines) > OLD_SHARE_ABOVE) {
      hits.push({ toolUseId: pending.toolUseId, seq: observation.sourceOrdinal, oldLines, newLines });
    }
  }

  function observe(call) {
    if (!call.recalled) gapSeen = true;
    if (step === null || !step.scored) return;
    if (call.recalled && call.observation.isError !== true && call.observation.stepKey === step.key) score(call);
    freeze(call.record, call.scratch);
  }

  return { hits, startStep, startEpoch, observe };
}
