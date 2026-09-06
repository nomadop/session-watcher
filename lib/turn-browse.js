// lib/turn-browse.js — the human browse snapshot over the stored Turn Records of one Applicable
// Lineage. It shares the lineage walk with the agent page and nothing below it: no transcript is
// opened, so there is no active-path ordinal to address a row by and no abandoned-anchor judgement
// to make. A person gets every row that was stored; an agent's page gets every row still on the
// active path, addressed by its ordinal. The two answer different questions, so that divergence is
// the design rather than a gap. This module imports nothing.

// Separates the turns a root section's wayfinder is built from. The parts are whole sentences a
// person wrote, so a comma would read as their own punctuation instead of as the seam between them.
const ROOT_HEADLINE_JOIN = ' · ';

// The lineage root's own opening: the leading run of turns nothing was noted against, plus the first
// noted one, which is where an opening stops being an opening. A row whose note is empty counts as
// unnoted here, the same test the drawer applies to decide whether a row has assistant text at all.
function rootHeadline(rows) {
  const opening = [];
  for (const row of rows) {
    opening.push(row.uText);
    if ((row.note ?? '') !== '') break;
  }
  return opening.join(ROOT_HEADLINE_JOIN);
}

/**
 * Build the whole-lineage browse snapshot, one section per Lineage Session that stored rows.
 *
 * Ordering is established here because listTurnNotes carries no ORDER BY. `turnNoteId` is the key:
 * it is unique and the store assigns it in submission order, where source_timestamp is neither
 * unique nor an order the store guarantees.
 *
 * A section exists exactly where its session has rows. A segment whose turns are not captured yet is
 * never represented by a synthesised section, because there is nothing stored to represent, and the
 * drawer's search rests on that: a section it cannot fill is a section it cannot match. The drawer
 * states that fixed horizon with static client copy; it is not browse-response state.
 *
 * `headline` is the wayfinder a collapsed section shows in place of its rows, and it is always a
 * string. A non-root section carries the assignment it was handed — the `nextTask` of the handoff its
 * PREDECESSOR produced, already secret-redacted at prepare time, so nothing is redacted again here.
 * Where that handoff is out of reach (the predecessor holds no id, its row was swept between lineage
 * assembly and this read, or the task is null) the headline degrades to empty rather than to a
 * synthesised stand-in, in one expression rather than a branch per cause. The root has no
 * predecessor, so it speaks for itself, and its run stops at the first noted turn so that a trailing
 * harness command cannot join the wayfinder (test/turn-browse.test.js `第一条有 note 之后`).
 *
 * @param {object} args
 * @param {object} args.store - Store instance (turn_note reads + handoff point lookups)
 * @param {Array<{ label: string, sessionId: string, handoffId: number|null }>} args.lineage
 *   Oldest → newest, as lib/lineage.js labels it
 * @returns {{ sections: Array<{ label: string, headline: string,
 *             entries: Array<{ u_text: string, note?: string }> }> }}
 */
export function buildTurnBrowse({ store, lineage }) {
  const sections = [];
  lineage.forEach((entry, i) => {
    const rows = [...store.listTurnNotes(entry.sessionId)]
      .sort((a, b) => a.turnNoteId - b.turnNoteId);
    if (rows.length === 0) return;
    const entries = rows.map((row) => {
      const out = { u_text: row.uText };
      if (row.note != null) out.note = row.note;
      return out;
    });
    const headline = i === 0
      ? rootHeadline(rows)
      : (store.getHandoff(lineage[i - 1].handoffId)?.nextTask ?? '');
    sections.push({ label: entry.label, headline, entries });
  });
  return { sections };
}
