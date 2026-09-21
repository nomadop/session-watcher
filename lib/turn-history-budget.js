// lib/turn-history-budget.js — the sizing primitives of every Turn History read: the excerpt/query
// character limit, the read token budget, UTF-16-safe slicing, the truncation marker, wire sizing, and
// token-bounded truncation. Pure; depends only on the token estimator.
import { CJK_RE, charsToTokens, countsToTokens } from './token-estimate.js';

// The one character limit shared by a query and the excerpt around its hit: an excerpt contains its hit
// span whole, so a query may not be longer than the window that has to hold it.
export const HISTORY_EXCERPT_CHARS = 200;

// The ceiling every Turn History read fits itself to — page, search and locate each measure the wire they
// are about to return against it.
export const HISTORY_TOKEN_BUDGET = 5000;

// ── Safe UTF-16 slices ─────────────────────────────────────────────────────────
// String.length counts UTF-16 code units, which is the unit both bounds above are stated in. A CJK
// character is one unit and an emoji is two, so a boundary can land inside a surrogate pair; these back
// off instead of emitting a lone half.

/** Up to `limit` leading UTF-16 code units, backing up one when the boundary is a high surrogate. */
export function safePrefix(text, limit) {
  let end = Math.min(text.length, limit);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xD800 && code <= 0xDBFF) end--;
  return text.slice(0, end);
}

/** Up to `limit` trailing UTF-16 code units, advancing one when the boundary is a low surrogate. */
export function safeSuffix(text, limit) {
  let start = Math.max(0, text.length - limit);
  const code = text.charCodeAt(start);
  if (start > 0 && code >= 0xDC00 && code <= 0xDFFF) start++;
  return text.slice(start);
}

/**
 * The counted truncation marker every consumer-facing page appends. `originalChars` is the length BEFORE
 * the cut, never the number of characters removed.
 *
 * The trigger and the count source stay at each producer, because they genuinely differ: a note measured
 * against the read budget, a stored `u_original_chars` against its stored text. Only the rendered form
 * lives here, and it lives here because each producer's assertion sees its own site alone — a format
 * edited at one of them reddens that one and ships two spellings of one marker.
 */
export function truncationMarker(originalChars) {
  return ` [truncated; ${originalChars} chars]`;
}

/**
 * Token cost of one wire payload, measured on the JSON the response actually sends — the same
 * JSON.stringify + charsToTokens path, so the estimate is exact rather than approximate.
 */
export function estimateWireTokens(payload, ctp) {
  return Math.round(charsToTokens(JSON.stringify(payload), ctp));
}

/** True iff the given token count fits within HISTORY_TOKEN_BUDGET. */
export function isWithinHistoryBudget(tokens) {
  return tokens <= HISTORY_TOKEN_BUDGET;
}

// CJK_RE is global, and /g + .test() is stateful (lastIndex advances, silently skipping characters) — the
// per-character probe needs its own non-global clone.
const CJK_ONE = new RegExp(CJK_RE.source);

/**
 * Longest prefix of `text` whose charsToTokens value stays within `tokenLimit`. countsToTokens shares
 * charsToTokens' exact two-division form, so the boundary this finds is the same one charsToTokens sees.
 * The cut goes through safePrefix so a surrogate pair is never split apart and stored as a lone half.
 *
 * @param {string} text
 * @param {number} tokenLimit
 * @param {{ ascii: number, cjk: number }} ctp
 * @returns {string} `text` itself when it already fits
 */
export function truncateToTokens(text, tokenLimit, ctp) {
  let chars = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const isCjk = CJK_ONE.test(text[i]);
    if (countsToTokens({ chars: chars + 1, cjk: cjk + (isCjk ? 1 : 0) }, ctp) > tokenLimit) {
      return safePrefix(text, i);
    }
    chars += 1;
    if (isCjk) cjk += 1;
  }
  return text;
}
