// dsh/src/handoff-text.js — the two sentences the handoff commands write into the session log and the inner monitor reads back: the checkpoint `/sw-continue` leaves and the lead of the follow-up a load queues.
// The producers (`continue.js`, `load.js`) and the reader (`inner-monitor-read.js`) build and parse them here, so the two cannot drift.

const CHECKPOINT_LEAD = '[Session Watcher] Context cleared by /sw-continue. Handoff token: ';

/** The text of the compact checkpoint `/sw-continue` replaces the cleared surface with. */
export const checkpointText = token => `${CHECKPOINT_LEAD}${token}`;

/** The token a `/sw-continue` checkpoint text names, or null for any other text. */
export function checkpointTokenOf(text) {
  if (typeof text !== 'string' || !text.startsWith(CHECKPOINT_LEAD)) return null;
  const token = text.slice(CHECKPOINT_LEAD.length);
  return token === '' ? null : token;
}

/** A value as a JSON string, so it reads back whole, with each slash that follows whitespace escaped (`\/` is `/` in JSON): inside such a string only that slash can begin a whitespace-bounded `/name` token. */
export const quoted = value => JSON.stringify(value).replace(/(?<=\s)\//g, '\\/');

/** The opening sentence of a loaded handoff's follow-up message. */
export const loadedLead = token => `Handoff ${quoted(token)} is loaded.`;

const LEAD_PATTERN = /^Handoff ("(?:[^"\\]|\\.)*") is loaded\./;

/** The token a follow-up message opens by naming, or null for any text that does not open with the sentence `loadedLead` writes. */
export function loadedTokenOf(text) {
  const match = typeof text === 'string' ? LEAD_PATTERN.exec(text) : null;
  if (match === null) return null;
  try {
    const token = JSON.parse(match[1]);
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}
