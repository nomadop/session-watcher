// lib/bookmark-service.js — Shared list and desired-state bookmark command service.
// Factory: createBookmarkService(deps) → service with listMessages, setDesiredState.
// Also owns materializeLineage, the bookmark-domain projection of a resolved lineage.
// No DB transactions wrap budget-check-then-upsert (intentional; see brief §6).

import { forCurrentSession } from './lineage.js';
import { readCanonicalTranscript, visibleMessages } from './dialogue-fold.js';
import {
  buildPreview,
  estimateBookmarkTokens,
  isWithinBookmarkBudget,
  BOOKMARK_TOKEN_BUDGET,
  formatBookmarkId,
} from './bookmark-core.js';

/**
 * Materialize domain rows from a resolved lineage.
 * For each session in the lineage:
 *   - If transcript available: read the canonical transcript, map bookmarks, emit rows
 *   - If unavailable: emit only active persisted bookmark rows with source_available:false
 *
 * @param {{ store, lineage, projectId, includeUnbookmarked, warn }} opts
 * @returns {Array<object>} Domain rows in lineage order (oldest session first)
 */
export function materializeLineage({ store, lineage, projectId, includeUnbookmarked = true, warn }) {
  const warnFn = typeof warn === 'function' ? warn : () => {};
  const allRows = [];

  for (const segment of lineage) {
    const { sessionId, transcriptPath } = segment;
    const activeBookmarks = store.listActiveBookmarksForSession(projectId, sessionId);

    // Build a map of active bookmarks by anchor UUID for quick lookup
    const bookmarkByAnchor = new Map();
    for (const bk of activeBookmarks) {
      bookmarkByAnchor.set(bk.anchorUuid, bk);
    }

    const transcript = readCanonicalTranscript(transcriptPath);

    if (transcript.status === 'unavailable') {
      // Names the session, never the path: these reach server diagnostics, which stay free of
      // filesystem detail.
      warnFn(`transcript unavailable for session ${sessionId}; using persisted bookmark previews`);

      // Emit only active persisted rows with source_available:false, sorted by timestamp
      const unavailableRows = activeBookmarks
        .slice()
        .sort((a, b) => a.sourceTimestamp - b.sourceTimestamp)
        .map(bk => ({
          sessionId,
          anchorUuid: bk.anchorUuid,
          role: bk.role,
          text: bk.previewText,
          source_available: false,
          bookmarked: true,
          orphan: false,
          sourceTimestamp: bk.sourceTimestamp,
          originalChars: bk.originalChars,
          truncated: bk.truncated,
        }));
      allRows.push(...unavailableRows);
      continue;
    }

    // Propagate transcript warnings
    if (transcript.warnings && transcript.warnings.length > 0) {
      for (const w of transcript.warnings) warnFn(w);
    }

    const matchedAnchors = new Set();
    const canonicalRows = [];

    // Include canonical messages in physical order
    for (const msg of visibleMessages(transcript)) {
      const isBookmarked = bookmarkByAnchor.has(msg.anchorUuid);
      if (isBookmarked) matchedAnchors.add(msg.anchorUuid);

      if (includeUnbookmarked || isBookmarked) {
        canonicalRows.push({
          sessionId,
          anchorUuid: msg.anchorUuid,
          role: msg.role,
          text: msg.text,
          source_available: true,
          bookmarked: isBookmarked,
          orphan: false,
          sourceTimestamp: msg.anchorTimestamp || null,
        });
      }
    }

    allRows.push(...canonicalRows);

    // An active bookmark the transcript could not resolve is an orphan: §10 keeps it visible
    // through its persisted preview rather than letting it disappear. source_available is false
    // per spec §5.5 — it reports that this canonical message is unresolvable, not that the file
    // is missing. Claiming true would send the row down the preview-recompute path, which
    // re-previews an already-capped preview and loses its truncation metadata.
    const orphans = activeBookmarks
      .filter(bk => !matchedAnchors.has(bk.anchorUuid))
      .sort((a, b) => a.sourceTimestamp - b.sourceTimestamp)
      .map(bk => ({
        sessionId,
        anchorUuid: bk.anchorUuid,
        role: bk.role,
        text: bk.previewText,
        source_available: false,
        bookmarked: true,
        orphan: true,
        sourceTimestamp: bk.sourceTimestamp,
        originalChars: bk.originalChars,
        truncated: bk.truncated,
      }));

    allRows.push(...orphans);
  }

  return allRows;
}

// Exact set of allowed input keys for setDesiredState
const ALLOWED_INPUT_KEYS = new Set(['add', 'anchor_uuid', 'source_session_id']);

/**
 * Convert a camelized store bookmark row to the snake_case wire format expected by consumers.
 * Returns null when passed null/undefined.
 */
function serializeBookmark(row) {
  if (!row) return null;
  return {
    bookmark_id: formatBookmarkId(row.bookmarkId),
    source_session_id: row.sourceSessionId,
    anchor_uuid: row.anchorUuid,
    role: row.role,
    preview_text: row.previewText,
    original_chars: row.originalChars,
    truncated: !!row.truncated,
    source_timestamp: row.sourceTimestamp,
  };
}

/**
 * Validate setDesiredState input keys and types.
 * Throws on extra keys or wrong `add` type.
 */
function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid input: expected object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new Error(`Invalid input: unexpected key "${key}"`);
    }
  }
  if (typeof input.add !== 'boolean') {
    throw new Error('Invalid input: "add" must be a boolean');
  }
  if (typeof input.anchor_uuid !== 'string') {
    throw new Error('Invalid input: "anchor_uuid" must be a string');
  }
  if (typeof input.source_session_id !== 'string') {
    throw new Error('Invalid input: "source_session_id" must be a string');
  }
}

/**
 * Map a domain row from materializeLineage + bookmark store data into the REST-ready BookmarkListItem shape.
 * `bookmarkByAnchor` maps anchorUuid -> store bookmark row (for the session).
 * `previewFn` is buildPreview (passed for testability; always uses live text when available).
 */
function rowToListItem(row, projectId, previewFn) {
  // Determine preview: use stored preview for orphans/unavailable; compute fresh for available rows.
  let previewText, originalChars, truncated;
  if (row.source_available && row.text != null) {
    const p = previewFn(row.text);
    previewText = p.previewText;
    originalChars = p.originalChars;
    truncated = p.truncated;
  } else {
    // Unavailable source: the stored preview is already server-computed and capped, so its own
    // length is not the source length. Carry the persisted metadata through when the row has it,
    // otherwise the elision stops being visible.
    previewText = row.text || '';
    originalChars = row.originalChars != null ? row.originalChars : previewText.length;
    truncated = row.truncated != null ? !!row.truncated : false;
  }

  return {
    source_session_id: row.sessionId,
    anchor_uuid: row.anchorUuid,
    role: row.role,
    preview_text: previewText,
    original_chars: originalChars,
    truncated: truncated,
    bookmark_id: row.bookmarked && row.bookmarkId != null ? formatBookmarkId(row.bookmarkId) : null,
    source_available: row.source_available,
  };
}

/**
 * Compute budget from only active applicable bookmark rows.
 * Uses estimateBookmarkTokens with the exact dynamic URL and current CTP.
 * @param {object} opts
 * @returns {number} token count
 */
function computeBudget({ store, projectId, lineage, detailUrl, ctp }) {
  // Collect active bookmark rows across the lineage
  const bookmarkRows = [];
  for (const seg of lineage) {
    const active = store.listActiveBookmarksForSession(projectId, seg.sessionId);
    for (const bk of active) {
      bookmarkRows.push({
        bookmarkId: bk.bookmarkId,
        role: bk.role,
        previewText: bk.previewText,
        originalChars: bk.originalChars,
        truncated: bk.truncated,
      });
    }
  }
  return estimateBookmarkTokens(bookmarkRows, { detailUrl, ctp });
}

/**
 * Create the bookmark service.
 *
 * deps:
 *   store                  — Store instance
 *   currentProjectId()     — () => string | null
 *   currentSessionId()     — () => string
 *   currentTranscriptPath()— () => string | null
 *   currentCtp()           — () => { ascii, cjk }
 *   warn(message)          — diagnostic sink; receives one self-describing sentence
 */
export function createBookmarkService(deps) {
  // `store` is accessed lazily via deps.store (supports getter for late-bound store injection).
  const { currentProjectId, currentSessionId, currentTranscriptPath, currentCtp, warn } = deps;
  const warnFn = typeof warn === 'function' ? warn : () => {};

  /**
   * Resolve the current applicable lineage (tail = current session).
   */
  function resolveCurrentLineage() {
    return forCurrentSession({
      store: deps.store,
      projectId: currentProjectId(),
      sessionId: currentSessionId(),
      transcriptPath: currentTranscriptPath(),
    });
  }

  /**
   * List all messages in the applicable lineage with bookmark status and server-computed previews.
   * Budget is computed from only active applicable bookmark rows using the exact dynamic URL.
   *
   * @param {{ detailUrl: string|null }} opts
   * @returns {{ messages: BookmarkListItem[], budget_used_tokens: number, budget_limit_tokens: number }}
   */
  function listMessages({ detailUrl } = {}) {
    const projectId = currentProjectId();
    const ctp = currentCtp();
    const lineage = resolveCurrentLineage();

    const domainRows = materializeLineage({
      store: deps.store, lineage, projectId,
      includeUnbookmarked: true,
      warn: warnFn,
    });

    // Build a quick lookup: sessionId+anchorUuid -> store bookmark row (for bookmark_id)
    // We need to retrieve the stored bookmarkId for bookmarked rows.
    // materializeLineage's rows have bookmarked:true but no bookmarkId — fetch from store.
    const storeBookmarkCache = new Map();
    for (const row of domainRows) {
      if (row.bookmarked) {
        const key = `${row.sessionId}|${row.anchorUuid}`;
        if (!storeBookmarkCache.has(key)) {
          const bk = deps.store.getBookmarkByIdentity(projectId, row.sessionId, row.anchorUuid);
          if (bk) storeBookmarkCache.set(key, bk);
        }
      }
    }

    const messages = domainRows.map(row => {
      const enriched = { ...row };
      if (row.bookmarked) {
        const bk = storeBookmarkCache.get(`${row.sessionId}|${row.anchorUuid}`);
        if (bk) enriched.bookmarkId = bk.bookmarkId;
      }
      return rowToListItem(enriched, projectId, buildPreview);
    });

    const budget_used_tokens = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });

    return {
      messages,
      budget_used_tokens,
      budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
    };
  }

  /**
   * Add or remove a bookmark per the desired-state input.
   *
   * For add:
   *   1. Validate exact keys + boolean type
   *   2. Resolve lineage; source_session_id must be present
   *   3. Return existing active row before budget admission (already_bookmarked)
   *   4. Resolve canonical target from transcript; derive trusted metadata
   *   5. If inactive row exists, use its immutable data and ID (re-add path)
   *   6. Otherwise use peekNextBookmarkId as proposed wire id
   *   7. Build proposed wire (current active rows + new proposal)
   *   8. Reject if estimated tokens > 5000
   *   9. upsertBookmark; recompute returned budget
   *
   * For remove:
   *   1. Validate source in current lineage
   *   2. deactivateBookmark by identity (no transcript read)
   *   3. Return bookmark:null; recompute budget
   *
   * @param {{ add: boolean, anchor_uuid: string, source_session_id: string }} input
   * @param {{ detailUrl: string|null }} opts
   * @returns {{ status, bookmark, budget_used_tokens, budget_limit_tokens }}
   */
  function setDesiredState(input, { detailUrl } = {}) {
    // Step 1: validate
    validateInput(input);

    const { add, anchor_uuid, source_session_id } = input;
    const projectId = currentProjectId();
    const ctp = currentCtp();

    // Step 2: resolve lineage — source_session_id must be a member
    const lineage = resolveCurrentLineage();
    const sessionInLineage = lineage.some(seg => seg.sessionId === source_session_id);

    if (add) {
      // ── ADD path ─────────────────────────────────────────────────────────────

      if (!sessionInLineage) {
        const budget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
        return {
          status: 'not_found',
          bookmark: null,
          budget_used_tokens: budget,
          budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
        };
      }

      // Step 3: return existing active row before budget admission
      const existingRow = deps.store.getBookmarkByIdentity(projectId, source_session_id, anchor_uuid);
      if (existingRow && existingRow.active === 1) {
        const budget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
        return {
          status: 'already_bookmarked',
          bookmark: serializeBookmark(existingRow),
          budget_used_tokens: budget,
          budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
        };
      }

      // Step 4: resolve canonical target from transcript; derive trusted metadata
      const seg = lineage.find(s => s.sessionId === source_session_id);
      const transcriptPath = seg ? seg.transcriptPath : null;
      const transcript = readCanonicalTranscript(transcriptPath);

      const canonicalMsg = visibleMessages(transcript)
        .find(m => m.anchorUuid === anchor_uuid) || null;

      if (!canonicalMsg) {
        const budget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
        return {
          status: 'not_found',
          bookmark: null,
          budget_used_tokens: budget,
          budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
        };
      }

      // Step 5: if inactive row exists, use its immutable data and ID
      // (upsertBookmark will re-activate it preserving preview/role/timestamp)
      const proposedPreview = existingRow
        ? { previewText: existingRow.previewText, originalChars: existingRow.originalChars, truncated: existingRow.truncated }
        : buildPreview(canonicalMsg.text || '');

      const proposedRole = existingRow ? existingRow.role : canonicalMsg.role;
      const proposedTimestamp = existingRow ? existingRow.sourceTimestamp : (canonicalMsg.anchorTimestamp || Date.now());

      // Step 6: peek next bookmark id for new rows (inactive path re-uses existing id)
      // We still need the proposed id for budget estimation.
      const proposedId = existingRow ? existingRow.bookmarkId : deps.store.peekNextBookmarkId();

      // Step 7: build proposed wire — current active bookmarks + proposal
      const currentActive = [];
      for (const s of lineage) {
        const active = deps.store.listActiveBookmarksForSession(projectId, s.sessionId);
        for (const bk of active) {
          currentActive.push({
            bookmarkId: bk.bookmarkId,
            role: bk.role,
            previewText: bk.previewText,
            originalChars: bk.originalChars,
            truncated: bk.truncated,
          });
        }
      }
      const proposalRow = {
        bookmarkId: proposedId,
        role: proposedRole,
        previewText: proposedPreview.previewText,
        originalChars: proposedPreview.originalChars,
        truncated: proposedPreview.truncated,
      };
      const proposedWire = [...currentActive, proposalRow];

      // Step 8: reject if estimated integer exceeds 5000
      const proposedTokens = estimateBookmarkTokens(proposedWire, { detailUrl, ctp });
      if (!isWithinBookmarkBudget(proposedTokens)) {
        return {
          status: 'budget_exceeded',
          bookmark: null,
          budget_used_tokens: proposedTokens,
          budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
        };
      }

      // Step 9: upsertBookmark
      const upserted = deps.store.upsertBookmark({
        projectId,
        sourceSessionId: source_session_id,
        anchorUuid: anchor_uuid,
        role: proposedRole,
        previewText: proposedPreview.previewText,
        originalChars: proposedPreview.originalChars,
        truncated: proposedPreview.truncated ? 1 : 0,
        sourceTimestamp: proposedTimestamp,
        createdAt: Date.now(),
      });

      // Recompute returned budget after write
      const finalBudget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
      return {
        status: 'success',
        bookmark: serializeBookmark(upserted),
        budget_used_tokens: finalBudget,
        budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
      };

    } else {
      // ── REMOVE path ──────────────────────────────────────────────────────────

      // Step 1: validate source is in lineage (required for remove too)
      if (!sessionInLineage) {
        const budget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
        return {
          status: 'not_found',
          bookmark: null,
          budget_used_tokens: budget,
          budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
        };
      }

      // Step 2: deactivate by identity (no transcript read)
      deps.store.deactivateBookmark(projectId, source_session_id, anchor_uuid);

      // Step 3: return bookmark:null; recompute budget
      const budget = computeBudget({ store: deps.store, projectId, lineage, detailUrl, ctp });
      return {
        status: 'success',
        bookmark: null,
        budget_used_tokens: budget,
        budget_limit_tokens: BOOKMARK_TOKEN_BUDGET,
      };
    }
  }

  return {
    listMessages,
    setDesiredState,
  };
}
