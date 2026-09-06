// lib/dialogue-fold.js — Bookmark-only Dialogue Projection.
// Consumers: bookmark-service.js, bookmark-detail.js.
// Shared topology (byte reader, branch selection) remains in canonical-fold.js.

import { readFileSync } from 'node:fs';
import {
  readCompleteJsonlEventsFromBuffer,
  selectCanonicalBranches,
} from './canonical-fold.js';

// --- System noise filters ---

function isSystemNoise(entry) {
  if (!entry) return true;
  if (entry.isSidechain === true) return true;
  if (entry.isMeta === true) return true;
  if (entry.type === 'user' && typeof entry.message?.content === 'string'
      && entry.message.content.trimStart().startsWith('<task-notification>')) return true;
  if (entry.isCompactSummary === true) return true;
  if (entry.type === 'attachment') return true;
  if (entry.type === 'system') return true;
  return false;
}

// Transcripts carry ISO-8601 timestamps, but source_timestamp is an INTEGER column and lineage
// sorts numerically — so the epoch conversion happens here, at the single Dialogue boundary.
// Unparseable input yields null (never NaN, which would poison comparisons).
function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// --- Text / tool extraction ---

function extractVisibleText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text || null;
}

function extractToolUses(entry, lineOrdinal) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const tools = [];
  for (const block of content) {
    if (block?.type === 'tool_use' && block.id) {
      tools.push({ id: block.id, name: block.name, input: block.input, lineOrdinal });
    }
  }
  return tools;
}

function extractToolResults(entry, lineOrdinal) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const results = [];
  for (const block of content) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      // Absent is_error stays undefined so the wire can report null; a present false must not
      // collapse into the same value (spec §10.3 preserves the raw field when it exists).
      const isError = block.is_error === undefined ? undefined : block.is_error === true;
      // The harness's own annotation of THIS result row, carried through UNINTERPRETED. The tool-name
      // set is a product of local plugin configuration, so this layer stays name-agnostic and hands the
      // structure on whole instead of deciding what it means. Whoever needs the structure interprets
      // it — see cleanAskAnswer in lib/turn.js.
      const resultMeta = { raw: entry.toolUseResult, timestamp: normalizeTimestamp(entry.timestamp) };
      results.push({ toolUseId: block.tool_use_id, content: block.content, isError, resultMeta, lineOrdinal });
    }
  }
  return results;
}

// --- Dialogue materialization ---

function materializeDialogue(observations) {
  const groups = [];
  const assistantGroups = new Map();
  // Keyed by tool_use_id so a repeated result overwrites the earlier payload (spec: same ID is
  // last-wins). A list plus findIndex would take the first occurrence instead.
  const pendingResults = new Map();

  for (const obs of observations) {
    const entry = obs.entry;
    if (isSystemNoise(entry)) continue;

    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      const messageId = entry.message.id;
      if (!messageId) continue;

      if (!assistantGroups.has(messageId)) {
        const visibleText = extractVisibleText(entry);
        const toolIds = [];
        const toolMap = new Map();
        for (const t of extractToolUses(entry, obs.sourceRef.lineOrdinal)) {
          if (!toolMap.has(t.id)) toolIds.push(t.id);
          toolMap.set(t.id, { name: t.name, input: t.input, useLineOrdinal: t.lineOrdinal });
        }
        const group = {
          role: 'assistant',
          sourceRef: obs.sourceRef,
          anchorUuid: obs.sourceRef.uuid || entry.uuid || null,
          anchorTimestamp: normalizeTimestamp(entry.timestamp),
          rawTimestamp: entry.timestamp,
          text: visibleText,
          hasVisibleText: visibleText !== null,
          toolIds,
          toolMap,
        };
        assistantGroups.set(messageId, group);
        groups.push(group);
      } else {
        const group = assistantGroups.get(messageId);
        const visibleText = extractVisibleText(entry);
        if (visibleText !== null) {
          group.text = visibleText;
          // The anchor tracks the FIRST visible-text observation, so a later revision supplies
          // text without moving it — but a group that was tool-only until now has no anchor yet.
          if (!group.hasVisibleText) {
            group.sourceRef = obs.sourceRef;
            group.anchorUuid = obs.sourceRef.uuid || entry.uuid || group.anchorUuid;
            group.anchorTimestamp = normalizeTimestamp(entry.timestamp) ?? group.anchorTimestamp;
            group.rawTimestamp = entry.timestamp;
            group.hasVisibleText = true;
          }
        }
        for (const t of extractToolUses(entry, obs.sourceRef.lineOrdinal)) {
          if (!group.toolMap.has(t.id)) group.toolIds.push(t.id);
          group.toolMap.set(t.id, { name: t.name, input: t.input, useLineOrdinal: t.lineOrdinal });
        }
      }
    } else if (entry.type === 'user' && entry.message?.role === 'user') {
      const toolResults = extractToolResults(entry, obs.sourceRef.lineOrdinal);
      if (toolResults.length > 0) {
        for (const r of toolResults) pendingResults.set(r.toolUseId, r);
        continue;
      }
      const visibleText = extractVisibleText(entry);
      if (visibleText !== null) {
        groups.push({
          role: 'user',
          sourceRef: obs.sourceRef,
          anchorUuid: obs.sourceRef.uuid || entry.uuid || null,
          anchorTimestamp: normalizeTimestamp(entry.timestamp),
          rawTimestamp: entry.timestamp,
          text: visibleText,
          hasVisibleText: true,
          toolIds: [],
          toolMap: new Map(),
        });
      }
    }
  }

  const folds = [];
  const warnings = [];
  const seenAnchors = new Set();

  for (const group of groups) {
    const toolPairs = [];
    for (const id of group.toolIds) {
      const tool = group.toolMap.get(id);
      const pending = pendingResults.get(id);
      let result = null;
      // null means "this tool use has no paired result row", which is not the same as a result row
      // that carried no annotation — that one is an object with raw:undefined.
      let resultMeta = null;
      // undefined means "no raw is_error to report"; an unpaired tool use has none either.
      let isError;
      // CC writes each content block of a message as its own row, so the tool_use row and the result
      // row are both different physical lines from the fold's anchor, and the search wire sends a
      // reader to the line its excerpt actually sits on. `foldLines`' `t` stays the fold's own
      // ordinal — turn membership, the scoped span and the skeleton all read it — so both ordinals
      // ride on the pair instead. A result may never arrive; a tool use always has its row.
      let resultLineOrdinal = null;
      if (pending !== undefined) {
        result = pending.content;
        isError = pending.isError;
        resultMeta = pending.resultMeta;
        resultLineOrdinal = pending.lineOrdinal;
        pendingResults.delete(id);
      }
      toolPairs.push({
        id, name: tool.name, input: tool.input, result, isError, resultMeta,
        useLineOrdinal: tool.useLineOrdinal, resultLineOrdinal,
      });
    }

    // Anchor anomalies are reported, not enforced. None of the three occurs in 2703 real
    // transcripts (366,221 lines): entries lacking uuid/timestamp are session-metadata types that
    // never reach this point, no timestamp has ever failed to parse, and uuids are unique per line.
    // Dropping the candidate would narrow §10's field-level degradation for no real-input gain,
    // so these warn to stay observable if CC's uuid/timestamp generation ever changes.
    if (group.hasVisibleText) {
      if (!group.anchorUuid) {
        warnings.push(`anchor uuid missing on ${group.role} fold ${folds.length}; candidate cannot be bookmarked`);
      } else if (seenAnchors.has(group.anchorUuid)) {
        warnings.push(`duplicate anchor uuid "${group.anchorUuid}" on fold ${folds.length}; keeping canonical order`);
      } else {
        seenAnchors.add(group.anchorUuid);
      }
      if (group.rawTimestamp != null && group.anchorTimestamp === null) {
        warnings.push(`invalid timestamp "${group.rawTimestamp}" on fold ${folds.length}; anchorTimestamp degraded to null`);
      }
    }

    folds.push({
      ordinal: folds.length,
      sourceRef: group.sourceRef,
      role: group.role,
      // message===null is how a tool-only or residual-only fold says "no visible candidate here".
      // Detail still traverses this fold; Candidate/List derive from message!==null and skip it.
      message: group.hasVisibleText
        ? {
          role: group.role,
          text: group.text,
          anchorUuid: group.anchorUuid,
          anchorTimestamp: group.anchorTimestamp,
        }
        : null,
      toolPairs,
    });
  }

  return { folds, warnings };
}

// --- Public API ---

/**
 * Read a canonical transcript from disk and materialize dialogue folds.
 * @param {string} path - Path to the JSONL transcript file
 * @param {object} [opts] - Options
 * @param {boolean} [opts.afterLatestCompact] - If true, start strictly after the last native compact summary
 * @returns {{ status, folds, model, warnings }} folds[] is the only authoritative state
 */
export function readCanonicalTranscript(path, { afterLatestCompact = false } = {}) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return { status: 'unavailable', folds: [], warnings: [] };
  }

  const warnings = [];

  // Read and parse
  const { observations } = readCompleteJsonlEventsFromBuffer(buf, {
    baseOffset: 0,
    maxBytes: buf.length,
    atEof: true,
  });

  if (observations.length === 0) {
    return { status: 'ok', folds: [], warnings };
  }

  // Select canonical branches
  const branches = selectCanonicalBranches(observations);

  // Flatten all branches
  let allObservations = [];
  for (const branch of branches) {
    allObservations = allObservations.concat(branch);
  }

  // afterLatestCompact: a compact opens a second null-parent root, and selectCanonicalBranches
  // returns one branch per root in physical order — so the newest tree is the last branch. The
  // topology is authoritative here because isCompactSummary is not always present on a compacted
  // transcript, while a new root always is.
  if (afterLatestCompact) {
    allObservations = branches[branches.length - 1].slice();
    let lastCompactIdx = -1;
    for (let i = 0; i < allObservations.length; i++) {
      if (allObservations[i].entry.isCompactSummary === true) lastCompactIdx = i;
    }
    if (lastCompactIdx >= 0) {
      allObservations = allObservations.slice(lastCompactIdx + 1);
    }
  }

  // Extract the model from the first assistant entry that has one
  let model = null;
  for (const obs of allObservations) {
    const m = obs.entry?.message?.model;
    if (m) { model = m; break; }
  }

  const { folds, warnings: anchorWarnings } = materializeDialogue(allObservations);
  warnings.push(...anchorWarnings);

  return { status: 'ok', folds, model, warnings };
}

/**
 * The anchor of ONE fold — the single definition of the rule. A fold with a visible message answers
 * with that message's anchor; a tool-only or residual-only fold falls back to its source uuid. Those
 * are exactly the two keys findFoldByAnchor resolves, so an anchor produced here is always fetchable
 * as bookmark detail — and it is never a tool_use_id, a line ordinal or a `T`.
 *
 * A fold whose visible message carries no anchor uuid answers falsy (materializeDialogue warns on it:
 * the candidate cannot be bookmarked). Callers gate on truthiness rather than substituting a key.
 *
 * @param {object} fold - One element of readCanonicalTranscript's folds[]
 * @returns {string|null}
 */
export function foldAnchor(fold) {
  return fold.message ? fold.message.anchorUuid : fold.sourceRef.uuid;
}

/**
 * The lines of ONE fold — the single definition of what counts as a line. A fold contributes one
 * 'visible' line when it has a message, plus one 'tool' line per tool pair in `toolPairs` order; every
 * line of one fold shares that fold's ANCHOR row as its `t`, since a message spreads its content
 * blocks over rows and the fold is anchored on its first visible-text row where it has one. A tool's
 * own rows travel on the pair, as `useLineOrdinal` and `resultLineOrdinal`.
 *
 * Every line consumer resolves a fold through this function — the skeleton and the search scan surface
 * via enumerateLines and canonicalEntities respectively — so no second answer to "what is a line" can
 * appear without changing this one.
 *
 * @param {object} fold - One element of readCanonicalTranscript's folds[]
 * @returns {{ t: number, anchor: string|null, kind: 'visible'|'tool', message: object|null, tool: object|null }[]}
 */
export function foldLines(fold) {
  const t = fold.sourceRef.lineOrdinal;
  const anchor = foldAnchor(fold);
  const lines = [];
  if (fold.message) {
    lines.push({ t, anchor, kind: 'visible', message: fold.message, tool: null });
  }
  for (const tool of fold.toolPairs || []) {
    lines.push({ t, anchor, kind: 'tool', message: null, tool });
  }
  return lines;
}

/**
 * Enumerate the whole transcript as lines: foldLines over folds[], in canonical order.
 * @param {{ folds }} transcript - Result from readCanonicalTranscript
 * @returns {{ t: number, anchor: string|null, kind: 'visible'|'tool', message: object|null, tool: object|null }[]}
 */
export function enumerateLines(transcript) {
  // Same guard as visibleMessages: bookmark-service.js feeds reader output straight in, degenerate
  // returns included, so narrowing this would break callers that never check status.
  if (!transcript || !transcript.folds) return [];
  return transcript.folds.flatMap(fold => foldLines(fold));
}

/**
 * Visible messages, derived from folds. A fold with message===null (tool-only or residual-only)
 * has no visible counterpart, so this array is intentionally shorter than folds[] — never index
 * one against the other.
 * @param {{ folds }} transcript - Result from readCanonicalTranscript
 * @returns {object[]} The visible messages in canonical order
 */
export function visibleMessages(transcript) {
  if (!transcript || !transcript.folds) return [];
  return enumerateLines(transcript).filter(l => l.kind === 'visible').map(l => l.message);
}

/**
 * Find the fold whose message carries the given anchor UUID.
 * @param {{ folds }} transcript - Result from readCanonicalTranscript
 * @param {string} anchorUuid - The UUID to search for
 * @returns {object|null} The fold, or null if not found
 */
export function findFoldByAnchor(transcript, anchorUuid) {
  if (!transcript || !transcript.folds) return null;
  for (const fold of transcript.folds) {
    if (fold.message && fold.message.anchorUuid === anchorUuid) return fold;
  }
  // A fold with no visible message is not a candidate, but a stored bookmark may still point at
  // it — Detail must keep resolving it so its residual evidence stays reachable.
  for (const fold of transcript.folds) {
    if (fold.message === null && fold.sourceRef?.uuid === anchorUuid) return fold;
  }
  return null;
}

/**
 * Find a specific message by its anchor UUID in a canonical transcript result.
 * @param {{ folds }} transcript - Result from readCanonicalTranscript
 * @param {string} anchorUuid - The UUID to search for
 * @returns {object|null} The message object, or null if not found
 */
export function findCanonicalMessage(transcript, anchorUuid) {
  const fold = findFoldByAnchor(transcript, anchorUuid);
  return fold ? fold.message : null;
}
