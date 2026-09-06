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
    + 'these tools resolve their own lineage from that delivery and take no lineage identifier.',
});

export const STALE_CURSOR_MESSAGE = 'That before cursor resolves to no record in this lineage — it may predate a '
  + 'change in the persisted turns, name a segment this lineage no longer contains, or point into a transcript that '
  + 'is currently unreadable. Omit before to start again from the newest page.';

export const SCOPE_ABSENT_MESSAGE = 'That S{k}:{T} scope names a turn this lineage does not contain. Call '
  + 'turn_locate for a current scope, or omit scope to cover the whole lineage.';

const PAGE_IS_THE_FALLBACK = 'Read the lineage with turn_page instead — it paginates deterministically over the '
  + 'same sessions and needs no query.';

export function withPageRecovery(result) {
  if (result?.error === 'turn_page_unavailable') {
    return { ...result, recovery: 'Call turn_page again. It reads the transcript and the store on every call, so a '
      + 'transient failure clears on retry; a persistent one means the page projection remains unavailable. Search '
      + 'and locate have independent projections and may still answer.' };
  }
  return result;
}

export function withSearchRecovery(result) {
  if (result?.error === 'search_unavailable') {
    return { ...result, recovery: `${PAGE_IS_THE_FALLBACK} Exact transcript search is unavailable for this call; `
      + 'turn_page does not evaluate q and reports its own availability.' };
  }
  if (result?.found === false) {
    return { ...result, recovery: 'The scan found no searchable entity containing that literal in the readable '
      + 'transcripts it reached. Matching is an exact case-folded substring with no tokenization, so a near-miss '
      + 'phrase scores the same as an absent one: call turn_locate with a remembered term to get candidate ranges '
      + 'and the wording actually used.' };
  }
  if (result?.truncated === true) {
    return { ...result, recovery: 'More matches exist than the response budget carries, and the ones dropped are the '
      + 'oldest. The cut falls on a match rather than on a turn, so the OLDEST entry here may hold fewer matches '
      + 'than its turn actually has. Narrow to one range and search again: pass back the scope of an entry near what '
      + 'you are after, or call turn_locate for a candidate when no entry carries one.' };
  }
  if (result?.found === true) {
    return { ...result, recovery: 'Matches are grouped by the turn they landed in: each ranges entry '
      + 'carries its transcript_path once, and every match under it carries line, the transcript row '
      + 'its excerpt sits on, and span, the interval spanning its fold\'s anchor row and its results\' '
      + 'rows. Both are numbered as grep -n, sed -n and Read number rows, so the file can be read at '
      + 'line directly. Read the file there where an excerpt leaves a specific gap, and take span '
      + 'as context around line rather than as a range containing it. An entry that also carries scope '
      + 'names the turn: hand that scope back as scope to search that turn alone, or to turn_page as '
      + 'before to read up to it. An entry without one is either a turn whose record was never '
      + 'captured or cannot be positioned on the active path, or your own scoped call, whose turn you '
      + 'already named — either way its matches stay addressed by transcript_path and line.' };
  }
  return result;
}

export function withLocateRecovery(result) {
  if (result?.error === 'locate_unavailable') {
    return { ...result, recovery: `${PAGE_IS_THE_FALLBACK} Range location is unavailable for this call; turn_page `
      + 'does not depend on a located scope and reports its own availability.' };
  }
  if (result?.found === false) {
    return { ...result, recovery: `${PAGE_IS_THE_FALLBACK} This index names only turns captured at handoff time, `
      + 'which is a subset of what exact search reaches — a miss bounds the index, not the history.' };
  }
  if (result?.found === true) {
    return { ...result, recovery: 'Every entry carries an S{k}:{T} scope; the ones marked hit are what the index '
      + 'matched, and the rest are the turns adjacent to them, there so a query that landed near its target re-aims '
      + "from this response. Pass any scope as turn_search's scope to search that range for an exact literal. As a "
      + "page boundary the same address ends the page strictly before that turn, so turn_page's before gives the "
      + 'history leading up to it rather than the turn itself.' };
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
      + 'failed to build. Call turn_page to obtain the page.' };
  }
  return result;
}
