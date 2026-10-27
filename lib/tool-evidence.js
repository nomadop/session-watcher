// lib/tool-evidence.js — Tool Evidence Interpreter: the one interpreter every harness shares. A tool call's text
// is partitioned once, when its result is folded in, into the lines of the working tree's files it holds and a
// remainder. The partition becomes the Engine's effect and residual records and is offered to the store as the
// call's Attribution Record, which Source Reconstruction replays in place of matching again. Between calls it keeps
// the entries it has sent the ledger, so that when a file's lines have moved they are sent again under the lines they
// are on now, and so that a residual is weighed by what its call's lines leave beyond the entries' growth. What
// belongs to one harness (how a call is named, which tool loads a handoff, which resource is not a file) arrives as
// its profile.

import { SKILL_FRAMING_TOKENS } from './constants.js';
import { alignOrdered } from './line-align.js';
import { sideTextOf } from './resource-attribution.js';
import { CJK_RE, charsToTokens, countsToTokens } from './token-estimate.js';

// ── Lines ────────────────────────────────────────────────────────────────────

const cjkOf = text => (text.match(CJK_RE) ?? []).length;

const isFingerprint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

// The base a relative path resolves against: the row's own directory, else the session's, else none.
function baseOf(row, sessionCwd) {
  if (typeof row.cwd === 'string' && row.cwd.length > 0) return row.cwd;
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0) return sessionCwd;
  return null;
}

function resolvedLoadToken(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.load_token === 'string' ? parsed.load_token : null;
  } catch {
    return null;   // a partial or non-JSON result simply leaves the token unresolved
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

const RECORD_VERSION = 1;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isText = value => typeof value === 'string';

// A stored entry as the interpreter replays it, or null for one it does not recognize. Its fingerprint is kept
// only when it is one, and its mark as moved only when the mark is `true`; an entry with any other replays its
// facts without it, and an entry without the mark is a line the call sent.
function readEntry(raw) {
  if (!isObject(raw) || !isCount(raw.key) || !isCount(raw.chars) || !isCount(raw.cjk) || raw.cjk > raw.chars) return null;
  const entry = { key: raw.key, chars: raw.chars, cjk: raw.cjk };
  if (isFingerprint(raw.fp)) entry.fp = raw.fp;
  if (raw.moved === true) entry.moved = true;
  return entry;
}

function readImpact(raw) {
  if (!isObject(raw) || !isText(raw.resourceKey) || raw.resourceKey.length === 0) return null;
  if (raw.kind !== 'replace-fragments' && raw.kind !== 'merge-fragments') return null;
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) return null;
  const entries = raw.entries.map(readEntry);
  // The ledger rejects a key repeated within one impact.
  if (entries.includes(null) || new Set(entries.map(entry => entry.key)).size !== entries.length) return null;
  return { resourceKey: raw.resourceKey, kind: raw.kind, entries };
}

function readEffect(raw) {
  if (!isObject(raw) || (raw.access !== 'read' && raw.access !== 'write')) return null;
  if (!Array.isArray(raw.impacts) || raw.impacts.length === 0) return null;
  const impacts = raw.impacts.map(readImpact);
  return impacts.includes(null) ? null : { access: raw.access, impacts };
}

function readResidual(raw) {
  if (!isObject(raw) || !isText(raw.groupKey) || raw.groupKey.length === 0) return undefined;
  if (!isText(raw.kind) || !isText(raw.detail) || !isCount(raw.weight)) return undefined;
  return { groupKey: raw.groupKey, kind: raw.kind, detail: raw.detail, weight: raw.weight };
}

// The record a store gave back, or null when this version cannot read it: a miss, so the call is partitioned
// afresh. Only what the record shape names is taken from it.
function readRecord(raw) {
  if (!isObject(raw) || raw.v !== RECORD_VERSION || !Array.isArray(raw.effects)) return null;
  const effects = raw.effects.map(readEffect);
  if (effects.includes(null)) return null;
  const residual = raw.residual === null ? null : readResidual(raw.residual);
  return residual === undefined ? null : { v: RECORD_VERSION, effects, residual };
}

// ── Impacts ──────────────────────────────────────────────────────────────────

// One resource's lines on one side as an impact. A row naming a line the group already holds replaces it, in
// the place the key first took: the ledger rejects a key repeated within one impact. The matcher's `files` hold
// the fingerprints of the file as it was read; a resource without them cannot be shown whole. A side is whole when
// its own lines are every line of the file, whatever else the interpreter holds of the resource.
function impactFor({ resourceKey, lines }, files) {
  const fingerprints = files?.[resourceKey];
  const entries = new Map();
  for (const { line, text } of lines) {
    const entry = { key: line, chars: text.length, cjk: cjkOf(text) };
    const fp = fingerprints?.[line - 1];
    if (isFingerprint(fp)) entry.fp = fp;
    entries.set(line, entry);
  }
  let whole = Array.isArray(fingerprints) && fingerprints.length > 0 && entries.size === fingerprints.length;
  for (let line = 1; whole && line <= fingerprints.length; line++) whole = entries.has(line);
  return { resourceKey, kind: whole ? 'replace-fragments' : 'merge-fragments', entries: [...entries.values()] };
}

// The Engine's effects for a record's: every entry priced from its counts under `ctp`. The spend is the sum of the
// entries the call sent: one that moved from another key was in context before, and its tokens are not spend.
function priced(effects, ctp) {
  return effects.map(({ access, impacts }) => {
    let spentTokens = 0;
    const pricedImpacts = impacts.map(({ resourceKey, kind, entries }) => ({
      resourceKey,
      mutation: {
        kind,
        fragments: entries.map(({ key, chars, cjk, moved }) => {
          const tokens = countsToTokens({ chars, cjk }, ctp);
          if (moved !== true) spentTokens += tokens;
          return { key, tokens };
        }),
      },
    }));
    return { access, overheadTokens: 0, spentTokens, impacts: pricedImpacts };
  });
}

// One event per impact of every effect, from the Engine's effects and the name of the tool that made the call. A
// write has no `isFullRead`; a read is whole when it replaced the resource's fragments.
function pathEventsFor(effects, toolType) {
  return effects.flatMap(({ access, impacts }) => impacts.map(({ resourceKey, mutation }) => ({
    path: resourceKey,
    rawPath: resourceKey,
    toolType,
    isFullRead: access === 'write' ? null : mutation.kind === 'replace-fragments' ? 1 : 0,
  })));
}

// ── Scratch ──────────────────────────────────────────────────────────────────

// The scratch is what the interpreter has sent the ledger, kept to move it and to weigh a residual by it: a Map from
// resource key to a Map from line key to { chars, cjk, tokens, fp? }. It folds each impact as the ledger folds the
// mutation, whether the record is a fresh partition's or a recalled one's, so it holds what the ledger holds of every
// resource a record named. `recorded` is the record's effects and `effects` the Engine's for them, entry for fragment.
function foldInto(scratch, recorded, effects) {
  recorded.forEach(({ impacts }, effectAt) => impacts.forEach(({ resourceKey, kind, entries }, impactAt) => {
    const { fragments } = effects[effectAt].impacts[impactAt].mutation;
    const held = kind === 'replace-fragments' ? new Map() : scratch.get(resourceKey) ?? new Map();
    entries.forEach(({ key, chars, cjk, fp }, entryAt) => {
      const entry = { chars, cjk, tokens: fragments[entryAt].tokens };
      if (fp !== undefined) entry.fp = fp;
      held.set(key, entry);
    });
    scratch.set(resourceKey, held);
  }));
}

// What the file's current fingerprints make of the entries the scratch holds of a resource: a zero entry for each
// key whose entry moved or whose line is gone, then the entries that moved, each under the key of the line it is on
// now and marked as moved. The recorded fingerprints are laid out one slot to a key, with holes where nothing was recorded: the equal
// head the alignment trims pairs a slot only with the line of its number, and the cells it weighs against the cap
// are those of the table it would fill. An entry without a fingerprint takes no part, nor one whose key the table
// cannot reach. Nothing moves while every recorded fingerprint agrees with the file's, or when the table is over the
// cap: the entries keep the keys they were sent under. `judged` is false where an entry that holds characters keeps a
// key the file may have left, because it takes no part, or the table is over the cap, or the file has no fingerprints:
// which line a new one replaced is then not known. An entry of no characters cannot mislead, whatever key it keeps.
function movedEntries(held, fingerprints, { maxCells, minTrim }) {
  if (held === undefined) return { moved: [], judged: true };
  if (!Array.isArray(fingerprints)) return { moved: [], judged: false };
  const reach = fingerprints.length + maxCells;
  const recorded = [];
  let stranded = false;
  for (const item of held) {
    const [key, entry] = item;
    if (entry.fp !== undefined && Number.isInteger(key) && key >= 1 && key <= reach) recorded.push(item);
    else if (entry.chars > 0) stranded = true;
  }
  const judged = !stranded;
  if (recorded.every(([key, entry]) => fingerprints[key - 1] === entry.fp)) return { moved: [], judged };
  recorded.sort(([a], [b]) => a - b);
  const slots = new Array(recorded[recorded.length - 1][0]).fill(NaN);
  for (const [key, entry] of recorded) slots[key - 1] = entry.fp;
  const pairs = alignOrdered(slots, fingerprints, { maxCells, minTrim });
  if (pairs === null) return { moved: [], judged: false };
  const landing = new Map(pairs.map(([from, to]) => [from + 1, to + 1]));
  const zeroed = [];
  const shifted = [];
  for (const [key, entry] of recorded) {
    const at = landing.get(key);
    if (at === key) continue;
    zeroed.push({ key, chars: 0, cjk: 0 });
    if (at !== undefined) shifted.push({ key: at, chars: entry.chars, cjk: entry.cjk, fp: entry.fp, moved: true });
  }
  return { moved: [...zeroed, ...shifted], judged };
}

// The impact with the entries `movedEntries` answers for its resource sent along. For one key the order is the zero
// entry, then the moved entry, then this call's own line, the last word: the impact repeats no key, and a line of
// the call that lands on a moved key is the call's, unmarked.
function relocated(impact, moved) {
  if (moved.length === 0) return impact;
  const entries = new Map();
  for (const entry of moved) entries.set(entry.key, entry);
  for (const entry of impact.entries) entries.set(entry.key, entry);
  return { ...impact, entries: [...entries.values()] };
}

const charsHeld = held => {
  let total = 0;
  for (const { chars } of held?.values() ?? []) total += chars;
  return total;
};

// The characters of a call's matched lines that its impacts do not add to the entries, summed over the resources it
// touches: those of a resource's matched lines less the net change in the characters its entries hold, never below
// zero. The ledger holds one entry a key, so a line read again, a line carried twice and an old line a new one
// replaces are still in context and in no entry's growth. The impacts are folded as `emit` will fold them and taken
// as they stand, with the moved entries placed: a shift nets to zero, and an edited line is set against the entry
// the alignment left unpaired, not against the entry that held its number. A resource whose relocation made no
// judgement counts none, for the entry a line replaced is not known.
function residentPart(matches, effects, scratch, unjudged, ctp) {
  const matched = new Map();
  for (const { resourceKey, lines } of matches) {
    let chars = matched.get(resourceKey) ?? 0;
    for (const { text } of lines) chars += text.length;
    matched.set(resourceKey, chars);
  }
  const folded = new Map([...matched.keys()].map(resourceKey => [resourceKey, new Map(scratch.get(resourceKey))]));
  foldInto(folded, effects, priced(effects, ctp));
  let part = 0;
  for (const [resourceKey, chars] of matched) {
    if (unjudged.has(resourceKey)) continue;
    part += Math.max(0, chars - (charsHeld(folded.get(resourceKey)) - charsHeld(scratch.get(resourceKey))));
  }
  return part;
}

// ── Interpreter ──────────────────────────────────────────────────────────────

// The members of `ATTRIBUTION_LIMITS` this interpreter requires: the alignment-cell cap and the evidence floor.
const LIMIT_NAMES = ['alignCells', 'evidenceFloor'];

function requireLimit(limits, name) {
  const value = limits?.[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Tool Evidence Interpreter limit ${name} must be a finite positive number`);
  }
}

function requireMethods(owner, label, methods) {
  for (const method of methods) {
    if (typeof owner?.[method] !== 'function') {
      throw new TypeError(`Tool Evidence Interpreter ${label} must provide ${method}`);
    }
  }
}

/**
 * The interpreter over a matcher and a harness profile. `limits` must carry each member this interpreter
 * requires, so a member that drifts from its constant fails where the interpreter is built.
 * @param {{ attribution: object, profile: object, limits: object }} deps
 * @returns {{ interpretToolUse: function, completeToolResult: function, resourceKeysOf: function }}
 */
export function createToolEvidenceInterpreter({ attribution, profile, limits } = {}) {
  requireMethods(attribution, 'attribution', ['attribute']);
  requireMethods(profile, 'profile', ['residualIdentity', 'isLoadHandoffTool', 'nonFileResource']);
  for (const name of LIMIT_NAMES) requireLimit(limits, name);
  const readsSkillPayload = typeof profile.interpretSkillPayload === 'function';
  const bound = { maxCells: limits.alignCells, minTrim: limits.evidenceFloor };

  // The write effect, the input's side, comes before the read effect, the result's. What no line explains is the
  // residual, weighed by the characters the matcher left on both sides and by the lines it did explain that the
  // entries do not grow by (`residentPart`). Only the first impact of a call on a resource has the entries the
  // scratch holds of it placed under the file's lines, and only when its side is not whole: a later impact finds the
  // resource as that one left it.
  function partition(pending, observation, scratch) {
    const { matches, files, unmatched } = attribution.attribute({
      base: pending.base,
      input: pending.input,
      output: observation.content,
    });
    const handled = new Set();
    const unjudged = new Set();
    const effects = [];
    for (const access of ['write', 'read']) {
      const impacts = matches.filter(match => (match.side === 'input') === (access === 'write')).map((match) => {
        const impact = impactFor(match, files);
        const later = handled.has(match.resourceKey);
        handled.add(match.resourceKey);
        if (later || impact.kind === 'replace-fragments') return impact;
        const { moved, judged } = movedEntries(scratch.get(match.resourceKey), files?.[match.resourceKey], bound);
        if (!judged) unjudged.add(match.resourceKey);
        return relocated(impact, moved);
      });
      if (impacts.length > 0) effects.push({ access, impacts });
    }
    const weight = unmatched.input + unmatched.output
      + residentPart(matches, effects, scratch, unjudged, pending.issuingPolicy.ctp);
    const { groupKey, kind, detail } = pending.residual;
    return {
      v: RECORD_VERSION,
      effects,
      residual: weight > 0 ? { groupKey, kind, detail, weight } : null,
    };
  }

  // The record of a call: the store's when it holds one this version reads, else a fresh partition, which the
  // store is then offered to keep.
  function recordOf(pending, observation, frameCtx, scratch) {
    const recalled = typeof frameCtx.recall === 'function' ? readRecord(frameCtx.recall(pending.toolUseId)) : null;
    if (recalled !== null) return recalled;
    const record = partition(pending, observation, scratch);
    if (typeof frameCtx.remember === 'function') frameCtx.remember(pending.toolUseId, record);
    return record;
  }

  // A record as the Engine and the telemetry take it, priced under the policy of the issuing step, and folded into
  // the scratch. A recalled record and a fresh partition pass through here alike. `hadError` is the result's own,
  // never the record's.
  function emit(record, pending, observation, telemetry, scratch) {
    const effects = priced(record.effects, pending.issuingPolicy.ctp);
    foldInto(scratch, record.effects, effects);
    telemetry.pathEvents = pathEventsFor(effects, pending.name);
    const residuals = record.residual === null ? [] : [{
      groupKey: record.residual.groupKey,
      weight: record.residual.weight,
      hadError: observation.isError === true,
      meta: { kind: record.residual.kind, detail: record.residual.detail },
    }];
    return { effects, residuals, telemetry, skillContinuation: null };
  }

  // A resource that is not a file holds its result's text whole: nothing in it is matched or kept as a record.
  function completeNonFileResource(pending, observation, telemetry) {
    if (observation.isError === true) return { effects: [], residuals: [], telemetry, skillContinuation: null };
    const { resourceKey } = pending.nonFile;
    const tokens = charsToTokens(sideTextOf(observation.content), pending.issuingPolicy.ctp);
    const effects = [{
      access: 'read',
      overheadTokens: SKILL_FRAMING_TOKENS,
      spentTokens: tokens + SKILL_FRAMING_TOKENS,
      impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] } }],
    }];
    telemetry.pathEvents = pathEventsFor(effects, pending.name);
    const skillContinuation = readsSkillPayload ? { resourceKey, issuingPolicy: pending.issuingPolicy } : null;
    return { effects, residuals: [], telemetry, skillContinuation };
  }

  /**
   * Interpret one `tool-use` observation: what the call is named, the policy of its issuing step and the base
   * its relative paths resolve against, kept in the `pending` the Projection hands back with the result. Nothing
   * is read from the working tree here, and `pending` is never null.
   * @returns {{ pending: object, effects: [], residuals: [], telemetry: object }}
   */
  function interpretToolUse(observation, context) {
    const { toolUseId, name } = observation;
    // DSH hands a tool the value of valid JSON or the raw text, and `null` is a value; Claude Code's may be absent.
    const input = observation.input ?? {};
    const issuingStepId = observation.messageId ?? null;
    const loadsHandoff = profile.isLoadHandoffTool(name);
    const explicitToken = loadsHandoff && typeof input.load_token === 'string' ? input.load_token : null;
    const nonFile = profile.nonFileResource({ name, input }) ?? null;
    return {
      pending: {
        toolUseId,
        issuingStepId,
        issuingPolicy: context.resolveModelPolicy(observation.model ?? null),
        // An auto-matched load carries no token in its input; the resolved one comes back in its result.
        awaitLoadToken: loadsHandoff && explicitToken === null,
        name,
        input,
        base: baseOf(observation, context.sessionCwd),
        nonFile,
        residual: nonFile === null ? profile.residualIdentity(name, input) : null,
      },
      effects: [],
      residuals: [],
      telemetry: { toolUseId, issuingStepId, loadToken: explicitToken, pathEvents: [] },
    };
  }

  /**
   * Complete a pending tool use with its `tool-result` observation: the one partition of the call, replayed
   * from the store's record when the frame context recalls one. The scratch is the epoch's, the Projection's.
   * @returns {{ effects: object[], residuals: object[], telemetry: object, skillContinuation: object|null }}
   */
  function completeToolResult(pending, observation, _context, { scratch = new Map(), frameCtx } = {}) {
    const telemetry = {
      toolUseId: pending.toolUseId,
      issuingStepId: pending.issuingStepId,
      loadToken: pending.awaitLoadToken ? resolvedLoadToken(sideTextOf(observation.content)) : null,
      pathEvents: [],
    };
    if (pending.nonFile !== null) return completeNonFileResource(pending, observation, telemetry);
    return emit(recordOf(pending, observation, frameCtx ?? {}, scratch), pending, observation, telemetry, scratch);
  }

  /**
   * The keys of the resources a Dialogue pair is attributed to, for Turn History at capture. A record the store
   * holds answers without a read of the tree; only a miss asks the matcher, and nothing is kept. A resource that
   * is not a file is the pair's key whatever the store holds. It never throws: the answer is always a list.
   * @param {object} pair a Dialogue tool pair
   * @param {{ recall?: function, sessionCwd?: ?string }} [capture]
   * @returns {string[]}
   */
  function resourceKeysOf(pair, capture) {
    try {
      const { recall, sessionCwd } = capture ?? {};
      const input = pair.input ?? {};
      const resource = profile.nonFileResource({ name: pair.name, input });
      if (resource) return [resource.resourceKey];
      const recorded = typeof recall === 'function' ? readRecord(recall(pair.toolUseId)) : null;
      const impacts = recorded
        ? recorded.effects.flatMap(effect => effect.impacts)
        : attribution.attribute({ base: baseOf(pair, sessionCwd), input, output: pair.result }).matches;
      return [...new Set(impacts.map(impact => impact.resourceKey))];
    } catch {
      return [];
    }
  }

  return { interpretToolUse, completeToolResult, resourceKeysOf };
}
