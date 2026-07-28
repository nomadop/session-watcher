// lib/bookmark.js
import { readFileSync } from 'node:fs';
import { isUserTurnBoundary } from './extract.js';
import { STOP_WORDS, redactSecrets } from './handoff.js';

// §8 Constants
export const BOOKMARK_BUDGET_MIN = 3;
export const BOOKMARK_BUDGET_MAX = 15;
export const BOOKMARK_EXCERPT_CHARS = 60;
export const MAX_KEYWORDS_PER_TURN = 128;
export const USER_INTENT_CHAR_LIMIT = 100;
export const USER_INTENT_TOTAL_CAP = 800;
export const USER_INTENT_MIN_LENGTH = 15;
export const DETAIL_WINDOW = 3;
export const DETAIL_ASST_TRUNCATE = 500;
export const DETAIL_USER_TRUNCATE = 200;
export const DETAIL_MAX_RESPONSE = 10000; // soft budget; actual output may exceed by up to DETAIL_ASST_TRUNCATE

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const EN_WORD_RE = /[a-z][a-z0-9_-]{2,}/gi;
const SYSTEM_RESIDUAL_RE = /^<(command-name|command-message|local-command-caveat|local-command-stdout|system-reminder|task-notification)>|^\[Request interrupted/;

let _segmenter;
function getSegmenter() {
  if (!_segmenter) _segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return _segmenter;
}

/** Safe-slice: avoid splitting UTF-16 surrogate pairs at truncation boundary */
function safeSlice(str, limit) {
  if (str.length <= limit) return str;
  const sliced = str.slice(0, limit);
  const last = sliced.charCodeAt(limit - 1);
  if (last >= 0xD800 && last <= 0xDBFF) return sliced.slice(0, -1);
  return sliced;
}

/** Normalize whitespace: collapse runs to single space, strip control chars */
function normalizeWs(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
}

/** Tokenize text into keywords using Intl.Segmenter (CJK) + regex (English) */
function tokenize(text) {
  const keywords = new Set();
  const seg = getSegmenter();
  for (const { segment, isWordLike } of seg.segment(text)) {
    if (!isWordLike) continue;
    const lower = segment.toLowerCase();
    if (lower.length <= 1) continue;
    if (STOP_WORDS.has(lower)) continue;
    keywords.add(lower);
    if (keywords.size >= MAX_KEYWORDS_PER_TURN) break;
  }
  // English/identifier tokens (catches camelCase, snake_case identifiers)
  for (const m of text.matchAll(EN_WORD_RE)) {
    if (keywords.size >= MAX_KEYWORDS_PER_TURN) break;
    const lower = m[0].toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    keywords.add(lower);
  }
  return keywords;
}

/**
 * Parse transcript JSONL → mixed turn array.
 * Each entry: { turnIndex, role, text, tools, keywords, rawUserText }
 */
function parseTranscript(transcriptPath, { skipKeywords = false } = {}) {
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch { return []; }
  const lines = raw.split('\n');
  const turns = [];

  for (const line of lines) {
    if (line.length < 10) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'assistant' && entry.message?.content) {
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      const textParts = content.filter(c => c?.type === 'text' && c.text).map(c => c.text);
      const tools = content.filter(c => c?.type === 'tool_use' && c.name).map(c => c.name);
      const rawText = textParts.join('\n');
      if (!rawText.trim()) continue; // tool-only turn: excluded
      const stripped = rawText.replace(CODE_FENCE_RE, ' ');
      const keywords = skipKeywords ? null : tokenize(stripped);
      turns.push({
        turnIndex: turns.length,
        role: 'assistant',
        text: rawText,
        tools,
        keywords,
      });
    } else if (entry.type === 'user') {
      if (!isUserTurnBoundary(entry)) continue;
      const msg = entry.message;
      let text = '';
      if (typeof msg?.content === 'string') text = msg.content;
      else if (Array.isArray(msg?.content)) {
        text = msg.content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join(' ');
      }
      if (!text.trim()) continue;
      if (SYSTEM_RESIDUAL_RE.test(text.trimStart())) continue;
      turns.push({
        turnIndex: turns.length,
        role: 'user',
        rawUserText: text,
      });
    }
  }
  return turns;
}

/** MMR selection on assistant turns */
function selectBookmarks(turns) {
  const assistantTurns = turns.filter(t => t.role === 'assistant');
  const n = assistantTurns.length;
  if (n === 0) return [];
  if (n <= BOOKMARK_BUDGET_MIN) return assistantTurns;

  const budget = Math.min(n, Math.max(BOOKMARK_BUDGET_MIN, Math.min(BOOKMARK_BUDGET_MAX, Math.round(Math.sqrt(n)))));

  const selected = [assistantTurns[0]]; // first turn always
  const covered = new Set(assistantTurns[0].keywords);

  while (selected.length < budget - 1) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 1; i < n - 1; i++) {
      if (selected.includes(assistantTurns[i])) continue;
      const t = assistantTurns[i];
      let newCount = 0;
      for (const kw of t.keywords) {
        if (!covered.has(kw)) newCount++;
      }
      if (newCount === 0) continue; // no novel keywords → skip (positionBias alone must not fill budget)
      const positionBias = (i / n) * 0.5;
      const score = newCount + positionBias;
      // Deterministic tie-break: higher turnIndex wins
      if (score > bestScore || (score === bestScore && (bestIdx === -1 || assistantTurns[i].turnIndex > assistantTurns[bestIdx].turnIndex))) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestScore <= 0) break;
    selected.push(assistantTurns[bestIdx]);
    for (const kw of assistantTurns[bestIdx].keywords) covered.add(kw);
  }

  // Always include last turn
  const last = assistantTurns[n - 1];
  if (!selected.includes(last)) selected.push(last);

  // Sort by turnIndex
  selected.sort((a, b) => a.turnIndex - b.turnIndex);
  return selected;
}

/** Format a bookmark line: T<index>: [tools] excerpt */
function formatBookmarkLine(turn) {
  const tools = turn.tools.length ? turn.tools.join(', ') : '';
  const cleaned = normalizeWs(turn.text.replace(CODE_FENCE_RE, ' '));
  const excerpt = safeSlice(redactSecrets(cleaned), BOOKMARK_EXCERPT_CHARS);
  return `T${turn.turnIndex}: [${tools}] ${excerpt}`;
}

/** Extract and format user intents with U0 pinning */
function selectUserIntents(turns) {
  const userTurns = turns.filter(t => t.role === 'user');
  // Apply additional filters
  const pool = userTurns.filter(t => {
    const text = t.rawUserText.trim();
    if (text.length < USER_INTENT_MIN_LENGTH) return false;
    return true;
  });

  if (pool.length === 0) return [];

  // Format each
  const formatted = pool.map(t => {
    const cleaned = normalizeWs(t.rawUserText);
    const excerpt = safeSlice(redactSecrets(cleaned), USER_INTENT_CHAR_LIMIT);
    return { turnIndex: t.turnIndex, display: `U${t.turnIndex}: ${excerpt}` };
  });

  // Apply cap with U0 pinning
  let total = formatted.reduce((s, f) => s + f.display.length, 0);
  if (total <= USER_INTENT_TOTAL_CAP) return formatted.map(f => f.display);

  // Drop from oldest (index 1+), keeping index 0 pinned
  const result = [...formatted];
  let i = 1; // start after U0
  while (total > USER_INTENT_TOTAL_CAP && i < result.length) {
    total -= result[i].display.length;
    result.splice(i, 1);
    // don't increment i — next element shifts into position
  }
  return result.map(f => f.display);
}

/**
 * Main entry point: build bookmark index from a transcript file.
 * Pure read — no side effects beyond reading the file.
 */
export function buildBookmarkIndex(transcriptPath) {
  if (!transcriptPath) return { bookmarkIndex: [], recentUserIntents: [] };
  const turns = parseTranscript(transcriptPath);
  if (turns.length === 0) return { bookmarkIndex: [], recentUserIntents: [] };

  const bookmarks = selectBookmarks(turns);
  const bookmarkIndex = bookmarks.map(formatBookmarkLine);
  const recentUserIntents = selectUserIntents(turns);

  return { bookmarkIndex, recentUserIntents };
}

/**
 * Drill-down: return ±DETAIL_WINDOW turns around a target turn index.
 */
export function buildBookmarkDetail(transcriptPath, turnIndex, fullText = false) {
  if (!transcriptPath) return null;
  const turns = parseTranscript(transcriptPath, { skipKeywords: true });
  if (turns.length === 0 || turnIndex < 0 || turnIndex >= turns.length) return null;

  const start = Math.max(0, turnIndex - DETAIL_WINDOW);
  const end = Math.min(turns.length - 1, turnIndex + DETAIL_WINDOW);

  const window = [];
  let totalChars = 0;

  for (let i = start; i <= end; i++) {
    const t = turns[i];
    if (totalChars >= DETAIL_MAX_RESPONSE) break;

    if (t.role === 'assistant') {
      const isTarget = i === turnIndex;
      const limit = (isTarget && fullText) ? DETAIL_MAX_RESPONSE : DETAIL_ASST_TRUNCATE;
      const cleaned = normalizeWs(t.text);
      const text = redactSecrets(cleaned);
      const truncated = text.length > limit;
      const display = truncated ? safeSlice(text, limit) : text;
      const tools = t.tools || [];
      const entry = { turn_index: t.turnIndex, role: 'assistant', tools, text: display };
      if (truncated) { entry.truncated = true; entry.original_chars = text.length; }
      totalChars += display.length;
      window.push(entry);
    } else {
      const isTarget = i === turnIndex;
      const userLimit = (isTarget && fullText) ? DETAIL_MAX_RESPONSE : DETAIL_USER_TRUNCATE;
      const text = redactSecrets(normalizeWs(t.rawUserText));
      const truncated = text.length > userLimit;
      const display = truncated ? safeSlice(text, userLimit) : text;
      const entry = { turn_index: t.turnIndex, role: 'user', text: display };
      if (truncated) { entry.truncated = true; entry.original_chars = text.length; }
      totalChars += display.length;
      window.push(entry);
    }
  }

  return {
    target_turn_index: turnIndex,
    window_start: start,
    window_end: Math.min(end, start + window.length - 1),
    turns: window,
  };
}
