// lib/harness/dsh/inner-seal-message.js — the inner-seal carrier: the `user/message` replace an inner seal appends in place of the source it withdraws.
//
// Its `source` is the one recoverable representation of what the carrier says: the C slots, each holding beside its note
// the questions its step asked the user through `ask_user_question` and the user's answers as `questions`, `{ question, user }`
// in the order they were asked, each text whole as the model wrote the question and the user gave the answer (the sources of
// older seals hold the raw call and result as `asks` instead, which render as they did); and B as the changes against
// what the carriers before it already carry, with the written lines that it leaves out because a carrier before it shows the same text. Carriers chain: folding their sources in order gives what the chain carries, and a
// seal carries only what differs from that fold; what a carrier shows is its source apart from the fold and its `omit`.
// The session state block stands outside that chain: a `state` field holds the items the body displays, each with the value it shows, and is present exactly
// where the body displays any, so the most recent carrier that holds an item is the value last shown for it (`carryState`).
// The read message of a load that opened the session is the chain's first link: its source holds, in the same
// structure, the lines it showed, so a kept line that stands is already carried when the first seal is built.
import { renderFileEvidence } from '../../working-tree-text.js';
import { LOAD_MESSAGE_KIND } from './load-message.js';

/** The carrier's source kind, the plugin's own: no DSH producer writes it, and the DSH reducer reads it as a withdrawal of the events its `sourceEventSeqs` cite. */
export const INNER_SEAL_KIND = 'session-watcher-inner-seal';

/**
 * Whether a message `source` carries evidence in the canonical structure `foldCarried` reads: an inner-seal carrier's, or the read message of a load, whose `paths` state the lines its blocks show.
 */
export const carriesEvidence = source => source?.kind === INNER_SEAL_KIND || (source?.kind === LOAD_MESSAGE_KIND && Array.isArray(source.paths));

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

// ── The body ─────────────────────────────────────────────────────────────────

/**
 * The carrier's provisional model-visible wording. Each entry carries a required meaning and may be reworded
 * without changing it: the summaries stand in for earlier turns of the same session and their replacement changed no
 * file or state; the seqs opening the summary lines are this session's event addresses the history tools read, and a
 * line marked user holds the user's own words; an
 * image saved as a file is not in the current context and `read_image` can read the file below; B states what the
 * carrier carries as of its seal, file text as read from disk then and skill text as the log recorded it, and changes
 * what the evidence of any earlier carrier or kept file excerpt of a load states, and the session's reads behind that file text still let an edit go
 * without a new read; an unreadable path names its reason and a direct read, and is neither file text nor a tool failure;
 * the state block states, as of the named session seq, each item it shows as the tool it stands for would show it: the working directory, the subagents that are running, the jobs that are running, the todo list as last written; `(empty)` is an item with none, even when it is the value the last summary that shows that item states, and a line that says its item is unchanged leaves a value that is not empty to that summary; a line marked
 * question holds a question the step asked the user as the model wrote it, a line marked user under it the user's own
 * answer to it, the selected labels and the custom text, and neither is part of the summary; the lines that open with
 * Original belong to older carriers and are the arguments of a user-question call and the result it was answered with,
 * as the log recorded them, a result the tool marked as an error saying so.
 */
export const CARRIER_WORDING = {
  addresses: 'These summaries stand in for earlier turns of this session; replacing them changed no file and no state, so the work carries on from them. Each summary line below opens with seq numbers: the addresses, in this session\'s log, of the events it summarizes, which the session history tools can read. A line marked user: holds the user\'s own words instead, cut where a marker says so.',
  slotLine: seqs => `seq ${seqs.join(', ')}: `,
  imageSaved: name => `The image ${name} is not in the current context; read_image can read the file below when it is needed.`,
  carried: 'Evidence carried from the replaced context as of this summary: file text as read from disk when it was written, and skill text as the log recorded it. Each entry changes what the evidence of any earlier summary or kept file excerpt here states. The reads behind this file text still count in this session, so edit a file without reading it again.',
  empty: path => `${path} is empty.`,
  unreadable: (path, reason) => `${path} could not be read (${reason}). This is not its text and not a tool failure; read the file directly when it is needed.`,
  skill: (name, text) => `Skill ${name}:\n${text}`,
  stateHeading: seq => `Session state as of session seq ${seq}:`,
  stateLabels: {
    workingDirectory: tool => `Working directory, as ${tool} would show:`,
    subagents: tool => `Running subagents, as ${tool} would show:`,
    jobs: tool => `Running jobs, as ${tool} would show:`,
    todos: tool => `Todo list, as ${tool} last left it:`,
  },
  stateList: entries => entries.map(({ id, label }) => `${id} — ${label}`).join('; '),
  stateUnchanged: 'unchanged since the last summary that shows it',
  stateEmpty: '(empty)',
  questionMark: 'A line marked question: holds the original question.',
  questionLine: question => `question: ${question}`,
  userLine: user => `user: ${user}`,
  askCall: ({ id, name, arguments: args }) => `Original ${name} call ${id}, arguments:\n${args}`,
  askResult: (id, { text, isError }) => `Original result of call ${id}${isError ? ' (marked as an error)' : ''}:\n${text}`,
};

// Consecutive line numbers as runs of `[first, last]`, in order.
function runsOf(numbers) {
  const runs = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last && last[1] + 1 === number) last[1] = number;
    else runs.push([number, number]);
  }
  return runs;
}

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
  const W = CARRIER_WORDING;
  const parts = [];
  if (state === 'empty') parts.push(W.empty(displayPath));
  if (state === 'unreadable') parts.push(W.unreadable(displayPath, reason));
  const runs = shownRuns(write, omit);
  if (runs.length > 0) parts.push(renderFileEvidence(displayPath, { totalLines, runs }).text);
  return parts;
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
 * B, the text of a carrier's evidence, rendered from its `source` alone: the wording of what is carried, then each path
 * entry that is empty, unreadable or writes a line `omit` leaves in, and each skill whose text it writes, separated by
 * blank lines. A line the source withdraws, a path or a skill it removes and the readable state of a path say nothing
 * here, so a source that changes only those has no B: null, and no B block is rendered.
 * @returns {string | null}
 */
export function renderCarried(source) {
  const carried = [
    ...source.paths.flatMap(entryParts),
    ...(source.skills ?? []).filter(skill => skill.removed !== true).map(skill => CARRIER_WORDING.skill(skill.name, skill.text)),
  ];
  return carried.length > 0 ? [CARRIER_WORDING.carried, ...carried].join('\n\n') : null;
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

const isTodoItem = item => item !== null && typeof item === 'object' && typeof item.content === 'string' && typeof item.status === 'string';

/**
 * The items of a todo list `value` as `{ content, status }` in their order: a null and an empty list are the same empty state. A value that is neither is refused with an error, so no text stands in for it.
 */
function todoItemsOf(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(isTodoItem)) throw new Error('the todo list is neither null nor a list of items with a content text and a status text');
  return value.map(({ content, status }) => ({ content, status }));
}

// A list of entries each holding the text fields `fields`, copied to those fields alone; anything else is refused with an error.
function textEntriesOf(value, fields, what) {
  if (!Array.isArray(value) || !value.every(entry => entry !== null && typeof entry === 'object' && fields.every(field => typeof entry[field] === 'string'))) {
    throw new Error(`the ${what} is not a list of entries with ${fields.join(' and ')} texts`);
  }
  return value.map(entry => Object.fromEntries(fields.map(field => [field, entry[field]])));
}

const sameEntries = (fields, a, b) => a.length === b.length && a.every((entry, at) => fields.every(field => entry[field] === b[at][field]));

const AGENT_FIELDS = ['id', 'label'];
const TODO_FIELDS = ['content', 'status'];

/**
 * The items of the state block in the order the block lists them. Each owns the tool whose answer it stands for, the check and copy of the value a host reads for it (`normalize`, which refuses what the item cannot hold with an error), what makes that value empty, when two values are the same, and the text of a value; the host's read of it is the host's. The block wraps whichever of them a seal shows.
 */
export const STATE_ITEMS = Object.freeze([
  Object.freeze({
    key: 'workingDirectory', tool: 'working_directory',
    normalize: (value) => {
      if (typeof value !== 'string' || value === '') throw new Error('the working directory is not a path text');
      return value;
    },
    isEmpty: () => false,
    same: (a, b) => a === b,
    text: value => value,
  }),
  Object.freeze({
    key: 'subagents', tool: 'list_agents',
    normalize: value => textEntriesOf(value, AGENT_FIELDS, 'subagent list'),
    isEmpty: entries => entries.length === 0,
    same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
    text: CARRIER_WORDING.stateList,
  }),
  Object.freeze({
    key: 'jobs', tool: 'job_list',
    normalize: value => textEntriesOf(value, AGENT_FIELDS, 'job list'),
    isEmpty: entries => entries.length === 0,
    same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
    text: CARRIER_WORDING.stateList,
  }),
  Object.freeze({
    key: 'todos', tool: 'todo_write',
    normalize: todoItemsOf,
    isEmpty: items => items.length === 0,
    same: (a, b) => sameEntries(TODO_FIELDS, a, b),
    text: items => JSON.stringify(items),
  }),
]);

const checkedCut = (asOfSeq) => {
  if (!Number.isSafeInteger(asOfSeq)) throw new Error('the session state names no session seq as its cut');
  return asOfSeq;
};

// What `source` shows for `item`, `{ value }`, or undefined where it shows none.
function shownIn(source, { key }) {
  if (source.kind !== INNER_SEAL_KIND) return undefined;
  return Object.hasOwn(source.state?.items ?? {}, key) ? { value: source.state.items[key].value } : undefined;
}

// The `{ value, unchanged? }` a carrier built now shows for `item` holding `value`, or null where it shows none: the first show of an empty item is left out, a value the nearest earlier carrier that shows the item has is shown as unchanged unless it is empty, any other whole. The value is copied.
function carryItem(item, value, earlier) {
  const current = item.normalize(value);
  const last = earlier.map(source => shownIn(source, item)).findLast(shown => shown !== undefined);
  if (last === undefined) return item.isEmpty(current) ? null : { value: current };
  return !item.isEmpty(current) && item.same(current, item.normalize(last.value)) ? { value: current, unchanged: true } : { value: current };
}

/**
 * The `state` field a carrier built now carries, `{ asOfSeq, items }`, or null where no item is shown. `read` is the host's: `asOfSeq`, the session seq its values are cut at, and `items`, for each item the host can read a function answering its value (an item without one is unavailable). An item is read only when `tools`, the names of the tools the session lists, holds its tool. `earlier` are the carrier sources the request holds ahead of the one being built, in order: each item is compared with the value the most recent of them that shows it shows; a value that is the same is marked unchanged unless it is empty, which is shown as empty; the cut is no part of a value, and a null todo list and an empty one are the same empty value.
 * An item whose read throws, whose value is not what the item holds or whose earlier value is not, is left out and handed to `failed(item, error)` once; the others stand. A cut that is no session seq is refused with an error.
 */
export function carryState({ asOfSeq, items }, { tools, earlier, failed }) {
  checkedCut(asOfSeq);
  const shown = {};
  for (const item of STATE_ITEMS) {
    const read = items[item.key];
    if (read === undefined || !tools.has(item.tool)) continue;
    try {
      const carried = carryItem(item, read(), earlier);
      if (carried !== null) shown[item.key] = carried;
    } catch (error) {
      failed(item, error);
    }
  }
  return Object.keys(shown).length === 0 ? null : { asOfSeq, items: shown };
}

// The state block's text without the break that opens it: the heading with the session seq of the cut, then one line for each shown item in the items' order.
function renderState({ asOfSeq, items }) {
  const W = CARRIER_WORDING;
  const lines = STATE_ITEMS.filter(({ key }) => Object.hasOwn(items, key)).map((item) => {
    const { value, unchanged = false } = items[item.key];
    const shown = item.normalize(value);
    return `${W.stateLabels[item.key](item.tool)} ${item.isEmpty(shown) ? W.stateEmpty : unchanged ? W.stateUnchanged : item.text(shown)}`;
  });
  return [W.stateHeading(checkedCut(asOfSeq)), ...lines].join('\n');
}

/**
 * The carrier's content blocks, rendered from its `source` alone: C, the address sentence and one line per slot, each
 * slot's questions to the user with the user's answers as lines after its line (the raw exchanges of older sources the same way), its attachments as file blocks after them, an image saved as a file behind its sentence; then B, when
 * `renderCarried` has text, as one text block; then the state block, when the source has a `state` field.
 * Joined with nothing between them, the blocks keep every line and each later section apart. Nothing is read from disk.
 * @returns {({ type: 'text', text: string } | { type: 'file', attachment: object })[]}
 */
export function renderCarrier(source) {
  const W = CARRIER_WORDING;
  const blocks = [];
  let lines = [source.slots.some(({ questions }) => questions !== undefined) ? `${W.addresses} ${W.questionMark}` : W.addresses];
  const flush = () => {
    if (lines.length > 0) blocks.push({ type: 'text', text: lines.join('\n') });
    lines = [];
  };
  for (const { seqs, text, questions = [], asks = [], attachments = [] } of source.slots) {
    lines.push(`${W.slotLine(seqs)}${text}`);
    for (const { question, user } of questions) lines.push(W.questionLine(question), W.userLine(user));
    for (const { call, result } of asks) lines.push(W.askCall(call), W.askResult(call.id, result));
    for (const { file, image } of attachments) {
      if (image !== undefined) lines.push(W.imageSaved(image.name ?? image.attachmentId));
      flush();
      blocks.push({ type: 'file', attachment: file });
    }
  }
  flush();
  const carried = renderCarried(source);
  const carriedBlock = carried === null ? null : { type: 'text', text: carried };
  const stateBlock = Object.hasOwn(source, 'state') ? { type: 'text', text: renderState(source.state) } : null;
  for (const block of [carriedBlock, stateBlock]) if (block !== null) blocks.push(block);
  // A route that sends a user message as one string joins its blocks with nothing between them, a file block by then its
  // handle text, so each text block carries its own break from the block before it and to a file block after it, and B
  // and the state block, the sections behind C, each open after a blank line.
  return blocks.map((block, index) => {
    if (block.type !== 'text') return block;
    const before = index === 0 ? '' : block === carriedBlock || block === stateBlock ? '\n\n' : '\n';
    const after = blocks[index + 1]?.type === 'file' ? '\n' : '';
    return { type: 'text', text: `${before}${block.text}${after}` };
  });
}
