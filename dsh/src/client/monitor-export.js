// dsh/src/client/monitor-export.js — the inner compaction monitor's export as Markdown: the session's attempts and handoffs as a list, and one attempt as a document of its slots with each slot's source events and C string whole.
// It is a renderer of the display model (`monitor-model.js`), as the React pages are, and reads through a reader that resolves the monitor endpoints' payloads and rejects when a read fails. It imports nothing but its siblings, so Node and the browser bundle load it alike.
import { slotTitleOf, ordinalsOf, paybackOf, settlementsOf, shownStatusOf, PART_SEPARATOR } from './monitor-state.js';
import { parentMetaParts, handoffMetaParts, handoffTitle, settlementMetaParts, blockListParts, slotFactsOf } from './monitor-model.js';

const MIN_FENCE_LENGTH = 3;
/** The kinds of block the export leaves out: the model's reasoning and a block it cannot name. */
const OMITTED_KINDS = ['reasoning', 'unknown'];

const longestRun = text => (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);

// A text in a fenced block that no run of backticks in the text can close: the fence is one backtick longer than the longest run.
function fenced(text) {
  const fence = '`'.repeat(Math.max(MIN_FENCE_LENGTH, longestRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

// A block as the chunks it takes in the document: its label where it has one, then its body fenced; a tool result is its label and the chunks of its inner blocks.
function blockChunks(part) {
  if (OMITTED_KINDS.includes(part.kind)) return [];
  if (part.kind === 'tool-result') return [part.label, ...part.children.flatMap(blockChunks)];
  return [...(part.label === undefined ? [] : [part.label]), fenced(part.text ?? part.json)];
}

// A slot as the chunks it takes: its heading, its facts, its whole C string and the source events the call saw. An event it did not see is left out, and its seq stays in the facts.
function slotChunks(detail, t) {
  const facts = slotFactsOf(detail, t).map(([term, value]) => `- ${term}: ${value ?? t('monitor.notRecorded')}`);
  return [
    `## #${detail.number}${PART_SEPARATOR}${slotTitleOf(detail, t)}`,
    facts.join('\n'),
    '### Summary',
    detail.c === '' ? t('monitor.slot.empty') : fenced(detail.c),
    '### Sources',
    ...detail.events.filter(event => event.visible).flatMap(event => [`#### seq ${event.seq}${PART_SEPARATOR}${event.type}`, ...blockListParts(event.blocks, t).flatMap(blockChunks)]),
  ];
}

const metaOf = (attempt, now, t) => parentMetaParts(attempt, now, t).map(({ text }) => text).join(PART_SEPARATOR);
const titleOf = ({ epoch, ordinal }, attempt, payback, t) => [t('monitor.object.attempt', { epoch, ordinal }), t(`monitor.status.${shownStatusOf(attempt, payback)}`)].join(PART_SEPARATOR);
const handoffLine = (handoff, t) => [handoffTitle(handoff, t), ...handoffMetaParts(handoff, t).map(({ text }) => text)].join(PART_SEPARATOR);
const settlementLine = (settlement, t) => [t('monitor.object.settlement', { epoch: settlement.epoch }), ...settlementMetaParts(settlement, t).map(({ text }) => text)].join(PART_SEPARATOR);

/**
 * The attempts and handoffs of the session as a Markdown list, a line per attempt or handoff in the order of their ids: an attempt's title by its segment and its place in that segment, its status and its meta, the seq in the meta being the id `exportAttempt` takes; a handoff's title by its segment and its meta, which the list of the monitor shows too, and in front of the line of a handoff that cleared a segment the line of that segment's settlement.
 * `reader.rows()` resolves the `inner-monitor` payload `{ attempts, handoffs }`, `now` is the clock a running span reads, and a read that rejects rejects the export.
 *
 * @param {{ reader: { rows: () => Promise<{ attempts: object[], handoffs?: object[] }> }, t: Function, now: number }} options
 * @returns {Promise<string>}
 */
export async function exportSession({ reader, t, now }) {
  const { attempts, handoffs = [] } = await reader.rows();
  if (attempts.length === 0 && handoffs.length === 0) return `${t('monitor.rows.empty')}\n`;
  const ordinals = ordinalsOf(attempts);
  const payback = paybackOf(attempts, handoffs);
  const settlements = settlementsOf(attempts, handoffs);
  const lines = [
    ...attempts.map(attempt => ({ id: attempt.id, text: [titleOf(ordinals[attempt.id], attempt, payback, t), metaOf(attempt, now, t)].join(PART_SEPARATOR) })),
    ...handoffs.flatMap(handoff => [
      ...(settlements.has(handoff.id) ? [{ id: handoff.id, text: settlementLine(settlements.get(handoff.id), t) }] : []),
      { id: handoff.id, text: handoffLine(handoff, t) },
    ]),
  ].sort((a, b) => a.id - b.id);
  return `${lines.map(({ text }) => `- ${text}`).join('\n')}\n`;
}

/**
 * One attempt as a Markdown document: its title and meta line, then a section per slot in the order `reader.slots(attemptId)` lists them.
 * A section holds the slot's facts, its whole C string and the source events the call saw (`visible`) with their text blocks, tool calls, tool results and attachments as the drawer shows them; reasoning, a block of an unknown kind and an event's raw JSON are not written, and nothing is cut.
 * `reader.slots(attemptId)` resolves `{ slots }` and `reader.slot(attemptId, key)` the `inner-monitor/slot` payload; a read that rejects, an attempt that has no slots to read included, rejects the export with that error, and no part of the document is returned.
 *
 * @param {{ reader: { rows: Function, slots: Function, slot: Function }, attemptId: number, t: Function, now: number }} options
 * @returns {Promise<string>}
 */
export async function exportAttempt({ reader, attemptId, t, now }) {
  const { attempts, handoffs } = await reader.rows();
  const attempt = attempts.find(each => each.id === attemptId);
  if (attempt === undefined) throw new Error(`the inner monitor holds no attempt ${attemptId}`);
  const { slots } = await reader.slots(attemptId);
  const chunks = [`# ${titleOf(ordinalsOf(attempts)[attemptId], attempt, paybackOf(attempts, handoffs), t)}`, metaOf(attempt, now, t)];
  // One slot at a time: a read of a slot reads the whole log, so the reads are not issued together.
  for (const { key } of slots) chunks.push(...slotChunks(await reader.slot(attemptId, key), t));
  return `${chunks.join('\n\n')}\n`;
}
