// lib/carried-evidence.js — the evidence a carrier carries beyond its summary: B, the file text and the skill text of the replaced context.
//
// B is the changes against what the carriers before it already carry, with the written lines that it leaves out because a
// carrier before it shows the same text. Carriers chain: folding their sources in order gives what the chain carries, and a
// seal carries only what differs from that fold; what a carrier shows is its source apart from the fold and its `omit`.
// The read message of a load that opened the session is the chain's first link: its source holds, in the same
// structure, the lines it showed, so a kept line that stands is already carried when the first seal is built.
// Everything here reads and writes that structure alone: no native event, tool or session API, and no carrier kind.
import { renderFileEvidence } from './working-tree-text.js';

/**
 * B's own model-visible wording. Each entry carries a required meaning and may be reworded without changing it: an
 * unreadable path names its reason and a direct read, and is neither file text nor a tool failure.
 */
export const CARRIED_WORDING = {
  empty: path => `${path} is empty.`,
  unreadable: (path, reason) => `${path} could not be read (${reason}). This is not its text and not a tool failure; read the file directly when it is needed.`,
  skill: (name, text) => `Skill ${name}:\n${text}`,
};

/**
 * The paragraph B opens with: what the carrier carries as of its seal, file text as read from disk then and skill text as
 * the log recorded it, and that it changes what the evidence of any earlier carrier or kept file excerpt of a load states;
 * then `wording.editGuard`, the harness's sentence on editing that file text.
 * @param {{ editGuard: string }} wording
 * @returns {string}
 */
export const carriedNote = wording => `Evidence carried from the replaced context as of this summary: file text as read from disk when it was written, and skill text as the log recorded it. Each entry changes what the evidence of any earlier summary or kept file excerpt here states. ${wording.editGuard}`;

/**
 * Ascending line numbers as runs of consecutive lines, `[first, last][]` in order.
 * @param {number[]} numbers
 * @returns {[number, number][]}
 */
export function runsOf(numbers) {
  const runs = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last && last[1] + 1 === number) last[1] = number;
    else runs.push([number, number]);
  }
  return runs;
}

/**
 * What a chain of carrier sources carries, applied in order, a later entry winning: each path's `state`, the
 * unreadable `reason` while it stays unreadable, and its carried lines; each skill's text. A path entry's
 * `displayPath`, `totalLines` and `omit` are rendering facts of their seal and take no part.
 * @param {object[]} sources the carrier sources and the sources of a load's read message, in model-visible order
 * @returns {{ paths: Map<string, { state: string, reason?: string, lines: Map<number, string> }>, skills: Map<string, string> }}
 */
export function foldCarried(sources) {
  const paths = new Map();
  const skills = new Map();
  for (const source of sources) {
    for (const entry of source.paths) {
      const held = paths.get(entry.path) ?? { state: entry.state, lines: new Map() };
      if (entry.state !== undefined) {
        held.state = entry.state;
        if (entry.state === 'unreadable') held.reason = entry.reason;
        else delete held.reason;
      }
      for (const line of entry.withdraw ?? []) held.lines.delete(line);
      for (const [line, text] of entry.write ?? []) held.lines.set(line, text);
      paths.set(entry.path, held);
    }
    for (const path of source.removed ?? []) paths.delete(path);
    for (const skill of source.skills ?? []) {
      if (skill.removed === true) skills.delete(skill.name);
      else skills.set(skill.name, skill.text);
    }
  }
  return { paths, skills };
}

/**
 * The `paths`, `removed` and `skills` of a carrier source: what `current`, the view a seal reconstructs, holds that
 * `baseline`, a `foldCarried` answer, does not already carry. `current.paths` maps each held path, the Working Tree
 * key, to `{ displayPath, read }`, `read` being the `readTreeWindows` answer over its held lines; `current.skills`
 * maps each held skill to its text. A held line the read holds is written when the baseline carries another text or
 * none; a baseline line the read does not hold is withdrawn, so a held line past the file's end is withdrawn too; a
 * baseline path no longer held is removed; a skill is written when its text changed and removed when it left.
 * A path is `unreadable` with the read's `reason`, `empty` when its file has no line, else `readable`; an empty or
 * unreadable path holds no line, so every carried line is withdrawn. `state`, and `reason` with an unreadable one, is
 * set when either changed or the path is new; `totalLines` comes with writes.
 */
export function carryChanges(baseline, current) {
  const paths = [];
  for (const [path, { displayPath, read }] of current.paths) {
    const base = baseline.paths.get(path);
    const state = read.status === 'unreadable' ? 'unreadable' : read.totalLines === 0 ? 'empty' : 'readable';
    const reason = state === 'unreadable' ? read.reason : undefined;
    const lines = new Map(state === 'readable'
      ? read.windows.flatMap(window => window.lines).map(({ number, text }) => [number, text])
      : []);
    const write = [...lines].filter(([number, text]) => base?.lines.get(number) !== text);
    const withdraw = [...(base?.lines.keys() ?? [])].filter(number => !lines.has(number)).sort((a, b) => a - b);
    const stateChanged = base?.state !== state || base.reason !== reason;
    if (!stateChanged && write.length === 0 && withdraw.length === 0) continue;
    paths.push({
      path, displayPath,
      ...(write.length > 0 ? { totalLines: read.totalLines } : {}),
      ...(stateChanged ? { state, ...(reason === undefined ? {} : { reason }) } : {}),
      ...(write.length > 0 ? { write } : {}),
      ...(withdraw.length > 0 ? { withdraw } : {}),
    });
  }
  const removed = [...baseline.paths.keys()].filter(path => !current.paths.has(path));
  const skills = [...current.skills].filter(([name, text]) => baseline.skills.get(name) !== text).map(([name, text]) => ({ name, text }));
  for (const name of baseline.skills.keys()) if (!current.skills.has(name)) skills.push({ name, removed: true });
  return {
    paths,
    ...(removed.length > 0 ? { removed } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

/**
 * `changes`, a `carryChanges` answer, with the lines of each path entry's `write` that the carriers already in the
 * request show again marked by their numbers in the entry's `omit`: the carrier leaves their text out and the `write`
 * itself stays whole, so what the fold and a later carrier read is untouched. `earlier` are the carrier sources the
 * request holds ahead of the one being built, in order. A written line is shown again when a line of the same path in
 * one of them has the very same text, whatever either number is and whether or not that carrier's lines still stand,
 * and that carrier shows it, not itself lists it in `omit`; a repeat within `changes` is shown.
 */
export function omitShown(changes, earlier) {
  const shown = new Map();
  for (const source of earlier) {
    for (const entry of source.paths) {
      const left = new Set(entry.omit);
      const texts = shown.get(entry.path) ?? new Set();
      for (const [number, text] of entry.write ?? []) if (!left.has(number)) texts.add(text);
      shown.set(entry.path, texts);
    }
  }
  return {
    ...changes,
    paths: changes.paths.map((entry) => {
      const omit = (entry.write ?? []).filter(([, text]) => shown.get(entry.path)?.has(text)).map(([number]) => number);
      return omit.length > 0 ? { ...entry, omit } : entry;
    }),
  };
}

/**
 * The B a carrier built over `current` carries behind `earlier`, the carrier sources the request holds ahead of it in
 * order: its changes against their fold (`carryChanges`) with the lines they show left out (`omitShown`). A seal's quote
 * and its commit each call it over the sources and the read of their own moment, so the commit carries what it read, not
 * what the quote estimated.
 * @param {object[]} earlier
 * @param {{ paths: Map<string, { displayPath: string, read: object }>, skills: Map<string, string> }} current
 */
export const carriedOf = (earlier, current) => omitShown(carryChanges(foldCarried(earlier), current), earlier);

// The lines of an entry's `write` that its `omit` does not leave out, as runs of consecutive line numbers, each `{ offset, lines: [{ number, text }] }`.
function shownRuns(write, omit) {
  const texts = new Map(write);
  const left = new Set(omit);
  return runsOf(write.map(([number]) => number).filter(number => !left.has(number))).map(([first, last]) => ({
    offset: first, lines: Array.from({ length: last - first + 1 }, (_, at) => ({ number: first + at, text: texts.get(first + at) })),
  }));
}

// One B entry's parts: its state when it is empty or unreadable, then the written lines `omit` does not leave out
// as one file block under the entry's seal-time display path and line count, no block when it leaves out all of them.
function entryParts({ displayPath, totalLines, state, reason, write = [], omit = [] }) {
  const W = CARRIED_WORDING;
  const parts = [];
  if (state === 'empty') parts.push(W.empty(displayPath));
  if (state === 'unreadable') parts.push(W.unreadable(displayPath, reason));
  const runs = shownRuns(write, omit);
  if (runs.length > 0) parts.push(renderFileEvidence(displayPath, { totalLines, runs }).text);
  return parts;
}

/**
 * B, the text of a carrier's evidence, rendered from its `source` alone: `carriedNote(wording)`, then each path
 * entry that is empty, unreadable or writes a line `omit` leaves in, and each skill whose text it writes, separated by
 * blank lines. A line the source withdraws, a path or a skill it removes and the readable state of a path say nothing
 * here, so a source that changes only those has no B: null, and no B block is rendered.
 * @param {object} source
 * @param {{ editGuard: string }} wording the harness's wording table
 * @returns {string | null}
 */
export function renderCarried(source, wording) {
  const carried = [
    ...source.paths.flatMap(entryParts),
    ...(source.skills ?? []).filter(skill => skill.removed !== true).map(skill => CARRIED_WORDING.skill(skill.name, skill.text)),
  ];
  return carried.length > 0 ? [carriedNote(wording), ...carried].join('\n\n') : null;
}

// Whether a path entry changes something the monitor shows: what B prints of it, a withdrawn line, or a readable state with no written line to say it.
function showsChange(entry) {
  const { state, write = [], withdraw = [] } = entry;
  return entryParts(entry).length > 0 || withdraw.length > 0 || (state === 'readable' && write.length === 0);
}

/**
 * What the `source` changes, as structure, for the monitor: `{ files, removed, skills }`, null where it changes nothing. It shows what the source changes whether or not B prints it, so besides what B prints it holds the withdrawn lines, the removed paths and skills and the readable state of a path. `files` holds the path entries that change something, in B's order, each `{ path, total, state, reason, runs, withdrawn }`: the seal-time display path, the entry's own record of its line count, state and reason, each null where the entry records none (a path whose state did not change records none of its state), the written lines that remain after `omit` as runs of consecutive lines, and the withdrawn lines as `{ first, last }` spans. A file whose written lines are all left out and which changes nothing else is not listed; one that still has withdrawals is, with its line count though B prints no header for it. `removed` are the removed paths and `skills` the skills as the source holds them, `{ name, text }` or `{ name, removed: true }`.
 * @returns {{ files: object[], removed: string[], skills: object[] } | null}
 */
export function carriedEvidence(source) {
  const files = source.paths.filter(showsChange).map(({ displayPath, totalLines, state, reason, write = [], withdraw = [], omit }) => ({
    path: displayPath,
    total: totalLines ?? null,
    state: state ?? null,
    reason: reason ?? null,
    runs: shownRuns(write, omit),
    withdrawn: runsOf(withdraw).map(([first, last]) => ({ first, last })),
  }));
  const removed = [...(source.removed ?? [])];
  const skills = (source.skills ?? []).map(skill => (skill.removed === true ? { name: skill.name, removed: true } : { name: skill.name, text: skill.text }));
  return files.length + removed.length + skills.length > 0 ? { files, removed, skills } : null;
}
