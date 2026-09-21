// lib/turn-tool-recovery.js — Recovery sentences for the turn read tools.
//
// TOOL SIDE ONLY. The HTTP search and locate shapes carry no extra fields — test/server.turn.test.js
// pins them with two exact-key-set assertions and the three 503 bodies with deepEqual. These
// augmenters therefore run in server.js's turnReadService and index.js's load handler, never inside a
// route. The consumer is an LLM reading text, which is why the payload is a sentence rather than a
// code or a boolean.
//
// Two shapes are absent on purpose. An unresolvable `before` and an absent `scope` are values this
// tool itself handed out, so they are thrown with the sentence as the message rather than given a wire
// name; the SDK returns a thrown handler error as { content: [{ text: err.message }], isError: true }.
// Each sentence states what to do next and the mechanism that makes it the right move. A bare
// prohibition names the action into the frame and makes it MORE available: measured at 8/10 uses of
// the banned form under a prohibition against 1/10 with no instruction at all.

export const NO_HANDOFF_LOADED = Object.freeze({
  error: 'no_handoff_loaded',
  recovery: 'This session has no delivered handoff, so there is no lineage to read. Call load_handoff first; '
    + 'the read tools resolve their lineage from that delivery.',
});

export const STALE_CURSOR_MESSAGE = 'That before boundary resolves to nothing in this lineage. Omit before to '
  + 'start again from the newest page, or take a session label from the load reply\'s lineage.';

export const SCOPE_ABSENT_MESSAGE = 'That S{k}:{T} scope names a turn this lineage does not contain. Call '
  + 'turn_locate for a current scope, or omit scope to cover the whole lineage.';

const PAGE_IS_THE_FALLBACK = 'Read the lineage with turn_page instead — it paginates deterministically over the '
  + 'same sessions and needs no query.';

export function withPageRecovery(result) {
  if (result?.error === 'turn_page_unavailable') {
    return { ...result, recovery: 'Call turn_page again; it reads the transcript and the store afresh on every call. '
      + 'Search and locate have independent projections and may still answer.' };
  }
  return result;
}

// `hitRecovery` is Harness-supplied: the sentence a hit carries names the Source's own wire field and the
// row numbering a reader will use, and only the Harness knows what a locator and an ordinal denote.
export function withSearchRecovery(result, { hitRecovery } = {}) {
  if (result?.error === 'search_unavailable') {
    return { ...result, recovery: PAGE_IS_THE_FALLBACK };
  }
  if (result?.found === false) {
    return { ...result, recovery: 'No readable transcript holds that literal; a near-miss misses like an absent one. '
      + 'Search a shorter fragment, or call turn_locate with a remembered term for candidate turns and the wording '
      + 'actually used.' };
  }
  if (result?.truncated === true) {
    return { ...result, recovery: 'Older matches were dropped to fit the budget, and the cut falls on a match, so the '
      + 'oldest entry may be incomplete. Narrow and search again: a longer literal, the scope of an entry near what '
      + 'you are after, or turn_locate for a candidate.' };
  }
  if (result?.found === true) {
    return { ...result, recovery: hitRecovery };
  }
  return result;
}

export function withLocateRecovery(result) {
  if (result?.error === 'locate_unavailable') {
    return { ...result, recovery: PAGE_IS_THE_FALLBACK };
  }
  if (result?.found === false) {
    return { ...result, recovery: 'The index holds only turns captured at handoff time, so a miss bounds the index, '
      + 'not the history. Retry with fewer words, read the lineage with turn_page, or turn_search a fragment you '
      + 'are sure of.' };
  }
  if (result?.found === true) {
    return { ...result, recovery: 'A hit\'s transcript_path holds its turn at row T of its scope, as grep -n numbers '
      + 'rows; the other entries are the turns adjacent to a hit. Pass a scope as turn_search\'s scope to search '
      + "that turn for a literal, or as turn_page's before to read the history leading up to it." };
  }
  return result;
}

export function withLoadRecovery(result) {
  if (result?.error === 'handoff_delivery_unavailable') {
    return { ...result, recovery: 'The delivery record could not be written, so this response carries no content. '
      + 'Call load_handoff again with the same token once the store is writable.' };
  }
  if (result?.turn_page_error) {
    return { ...result, recovery: 'The handoff loaded and the rest of this response is complete; only its turn page '
      + 'and the lineage headlines beside it failed to build. Call turn_page to obtain the page.' };
  }
  return result;
}
