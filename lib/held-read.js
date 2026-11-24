// lib/held-read.js — whether a read's lines are all lines its context already holds word for word: the one rule the read guard applies to what a read returned and what the epoch's scratch holds of its file (`lib/tool-evidence.js`).
// The scratch keeps no text, only what the matcher saw of each line: the fingerprint of the file's line with its trailing space cut, and the length of the line as the model was shown it. A returned line is the same as a held one when both agree, so a line whose text differs, or whose trailing space changed in length, is not; an entry placed under the number of the line it moved to was shown at another number, so it is no line held at this one. What the comparison does not tell apart is the backlog item `DSH-READ-BLOCK-LOOSE-EQUALITY` (`docs/2026-09-27-dsh-plugin-deferred-minors.md`).
import { fingerprintOf, normalizeLine } from './line-align.js';
import { escapeReminder } from './system-reminder.js';
import { rowOf } from './working-tree-text.js';

/**
 * The first and last line number of a read whose every line is held, null otherwise: a read with no line, a line the scratch holds no fingerprinted entry for, one whose entry moved there, one whose text differs from the held one and one the reminder frame escapes (`escapeReminder`) all answer null, the context holding that line, where a carrier wrote it, in the escaped text.
 * @param {{ lines: { number: number, text: string }[], entryAt: (number: number) => ({ fp?: number, chars: number, moved?: boolean }|undefined) }} read `lines` in the order the read returned them, `entryAt` the scratch's entry of the file at a line
 * @returns {{ first: number, last: number }|null}
 */
export function heldReadOf({ lines, entryAt }) {
  if (lines.length === 0) return null;
  for (const line of lines) {
    if (escapeReminder(line.text) !== line.text) return null;
    const entry = entryAt(line.number);
    if (entry?.fp !== fingerprintOf(normalizeLine(line.text)) || entry.moved === true) return null;
    // A line another call showed as it stands carries no row number, one the `read` tool printed carries its row.
    if (entry.chars !== line.text.length && entry.chars !== rowOf(line).length) return null;
  }
  return { first: lines[0].number, last: lines.at(-1).number };
}
