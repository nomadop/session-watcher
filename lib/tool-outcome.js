// lib/tool-outcome.js — Unified tool outcome classification (Task 3).
// Single decision point for Path/Skill/Residual. Consumed by processToolEvents (fold.js)
// and later by Detail projection (Task 8) via the canonical transcript model CTP.
// Zero dependencies beyond sibling lib/; never throws into the polling path.

import { matchAdapter, extractToolResultText } from './measure.js';

/**
 * Resolve a tool_use block to an adapter + path. NEVER throws — catches extractPath exceptions
 * and returns an unresolved record so the classifier returns Residual.
 * @param {{ name: string, input: object }} toolUse - The tool_use block (name + input)
 * @param {string} cwd - Working directory for path resolution
 * @returns {{ name: string, input: object, cwd: string, path: string|null, adapter: object|null, extractError?: string }}
 */
export function resolveToolUse({ name, input }, cwd) {
  const adapter = matchAdapter(name);
  if (!adapter) {
    return { name, input: input || {}, cwd, path: null, adapter: null };
  }
  let path = null;
  let extractError;
  try {
    path = adapter.extractPath(input || {}, cwd);
  } catch (err) {
    // extractPath exception → unresolved; classifier will return Residual.
    extractError = err?.message || 'extractPath threw';
  }
  return { name, input: input || {}, cwd, path, adapter, ...(extractError ? { extractError } : {}) };
}

/**
 * Exact predicate: is this update effective for B_rebuild?
 * Rules are type-specific:
 * - grepMultiFile: needs files object with at least one key
 * - fullSet/lineUpdate: needs non-null path AND non-empty lines array
 * - write/editDelta: needs non-null path
 * @param {object|null} update - The adapter computeUpdate result
 * @param {string|null} path - Resolved path (null for multi-file or unresolved)
 * @returns {boolean}
 */
export function isEffectiveBucketUpdate(update, path) {
  if (!update) return false;
  if (update.type === 'grepMultiFile') {
    return !!update.files && Object.keys(update.files).length > 0;
  }
  if (update.type === 'fullSet' || update.type === 'lineUpdate') {
    return path != null && Array.isArray(update.lines) && update.lines.length > 0;
  }
  if (update.type === 'write' || update.type === 'editDelta') {
    return path != null;
  }
  return false;
}

/**
 * Classify a resolved tool outcome into Path, Skill, or Residual.
 * This is the SINGLE decision point — callers never infer class from tool name.
 *
 * Returns:
 *   { kind: 'path'|'skill'|'residual', resolved, update, resultText, reason? }
 *
 * Residual reasons: 'no_adapter', 'extract_error', 'missing_result', 'is_error',
 *                   'adapter_exception', 'ineffective_update'
 *
 * @param {object} resolved - From resolveToolUse
 * @param {object} resultBlock - The tool_result content block
 * @param {{ ascii: number, cjk: number }} ctp - Chars-to-tokens parameters
 * @returns {{ kind: string, resolved: object, update: object|null, resultText: string, reason?: string }}
 */
export function classifyResolvedToolOutcome(resolved, resultBlock, ctp) {
  // 1. No adapter → Residual
  if (!resolved.adapter) {
    return { kind: 'residual', resolved, update: null, resultText: '', reason: 'no_adapter' };
  }

  // 2. extractPath threw → Residual
  if (resolved.extractError) {
    return { kind: 'residual', resolved, update: null, resultText: '', reason: 'extract_error' };
  }

  // 3. Missing/malformed result block → Residual
  if (!resultBlock || (resultBlock.type !== 'tool_result' && !resultBlock.content && resultBlock.content !== '')) {
    return { kind: 'residual', resolved, update: null, resultText: '', reason: 'missing_result' };
  }

  // 4. Error result → Residual
  if (resultBlock.is_error === true) {
    return { kind: 'residual', resolved, update: null, resultText: '', reason: 'is_error' };
  }

  // 5. Extract result text
  const resultText = extractToolResultText(resultBlock);

  // 6. Call computeUpdate — catch adapter exceptions → Residual
  let update;
  try {
    update = resolved.adapter.computeUpdate(resolved.input, resultText, resolved.cwd, ctp);
  } catch (err) {
    return { kind: 'residual', resolved, update: null, resultText, reason: 'adapter_exception' };
  }

  // 7. Check effectiveness
  if (!isEffectiveBucketUpdate(update, resolved.path)) {
    return { kind: 'residual', resolved, update: null, resultText, reason: 'ineffective_update' };
  }

  // 8. Skill adapter → kind 'skill'; all other effective updates → 'path'
  const kind = resolved.adapter.name === 'Skill' ? 'skill' : 'path';
  return { kind, resolved, update, resultText };
}
