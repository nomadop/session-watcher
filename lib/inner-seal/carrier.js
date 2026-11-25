// lib/inner-seal/carrier.js — the inner-seal carrier: the message an inner seal appends in place of the source it seals.
//
// Its `source` is the one recoverable representation of what the carrier says: the C slots, each holding beside its note
// the questions its step asked the user and the user's answers as `questions`, `{ question, user }` in the order they were
// asked, each text whole as the model wrote the question and the user gave the answer; B, the evidence it carries
// (`lib/carried-evidence.js`); and the session state block (`lib/inner-seal/state-block.js`) as its `state` field.
// A slot may also keep `sourceTokens`, a fact for the monitor's usage page alone; no rendering or summary request reads it.
// The tool names and the sentences that depend on the harness are the harness's wording table, handed to `renderCarrier`.
// The carrier is one reminder holding everything but the user's own words: those, and the answers to the questions its slots hold, follow the reminder's closing tag as lines of their own, each pointed to from its place inside by an anchor.
import { renderCarried } from '../carried-evidence.js';
import { REMINDER_OPEN, frameReminder } from '../system-reminder.js';
import { renderState } from './state-block.js';

/** The carrier's source kind, the plugin's own: no host writes it, and a harness adapter reads it as the replacement of the events its `sourceEventSeqs` cite. */
export const INNER_SEAL_KIND = 'session-watcher-inner-seal';

/**
 * The events a carrier cites as its `sourceEventSeqs`, in order: the seal's call record, its prune, then `replaced`, the
 * events the carrier replaces, as given.
 * @param {{ callSeq: number, pruneSeq: number, replaced: number[] }} seqs
 * @returns {number[]}
 */
export const sourceEventSeqsOf = ({ callSeq, pruneSeq, replaced }) => [callSeq, pruneSeq, ...replaced];

/** The seq of the call record among a carrier's `sourceEventSeqs` (`sourceEventSeqsOf`). */
export const callSeqOf = seqs => seqs[0];

/**
 * A carrier's `source` from the values a seal took: each slot of `slots` with its seqs and the summary of `summaries` at
 * its position, its `questions` and `attachments` at that position where it has any, then `changes`, the B a
 * `carriedOf` answer gives, and `state` where it is not null. `verbatimSeqs` records the first seq of each slot that holds a user's own text whole and the seqs of the results of injected questions: the monitor reads them as held in context, and `renderCarrier` reads the slots whose first seq is among them as the user's own, which it renders after the reminder.
 * `sourceTokens` is each slot's estimate of the tokens of its original text the summary call saw, kept on the slot as it was computed for the monitor's usage page, never rendered or summarized; a zero is an estimate, and a slot whose entry is no finite number holds no field.
 * @param {{ slots: { seqs: number[] }[], summaries: string[], questions: { question: string, user: string, seqs?: number[] }[][], attachments: object[][], sourceTokens?: (number|undefined)[], verbatimSeqs?: number[], changes: object, state: (object|null) }} parts
 */
export function assembleCarrierSource({ slots, summaries, questions, attachments, sourceTokens = [], verbatimSeqs = [], changes, state }) {
  const injected = [...new Set([...verbatimSeqs, ...questions.flat().flatMap(({ seqs }) => seqs ?? [])])];
  return {
    kind: INNER_SEAL_KIND, v: 1,
    slots: slots.map(({ seqs }, index) => ({
      seqs, text: summaries[index],
      ...(questions[index].length > 0 ? { questions: questions[index].map(({ question, user }) => ({ question, user })) } : {}),
      ...(attachments[index].length > 0 ? { attachments: attachments[index] } : {}),
      ...(Number.isFinite(sourceTokens[index]) ? { sourceTokens: sourceTokens[index] } : {}),
    })),
    ...(injected.length > 0 ? { verbatimSeqs: injected } : {}),
    ...changes,
    ...(state === null ? {} : { state }),
  };
}

// ── The body ─────────────────────────────────────────────────────────────────

/**
 * What the first text block of every carrier `renderCarrier` renders opens with: the reminder's opening, then the wording's address sentence. It is what a carrier is told by.
 * @param {{ addresses: string }} wording the harness's wording table
 * @returns {string}
 */
export const carrierPrefixOf = wording => `${REMINDER_OPEN}${wording.addresses}`;

const slotLine = seqs => `seq ${seqs.join(', ')}: `;

/**
 * The carrier's provisional model-visible wording that no harness's tool names. Each entry carries a required meaning and may be reworded
 * without changing it: a line marked user holds the user's own words; an image saved as a file is not in the current context and the named
 * tool can read the file below; a line marked question holds a question the step asked the user as the model wrote it, and the user's
 * whole answer to it, the selected labels and the custom text, is given below under the same seq, and neither is part of the summary.
 * `userAnchor` and `answerAnchor` stand inside the reminder where a user's message and an answer would be and say that the text is below; that text follows the reminder under the seqs of its slot, a user's message as its slot's note and an answer as its `userLine`.
 */
export const CARRIER_WORDING = {
  slotLine,
  imageSaved: (name, tool) => `The image ${name} is not in the current context; ${tool} can read the file below when it is needed.`,
  questionMark: 'A line marked question: holds the question as it was asked; the user\'s whole answer is given below under the same seq.',
  questionLine: question => `question: ${question}`,
  userLine: user => `user: ${user}`,
  userAnchor: seqs => `${slotLine(seqs)}[user message, below]`,
  answerAnchor: 'user: [answer, below]',
};

/**
 * The carrier's content blocks, rendered from its `source` alone: C, the address sentence and one line per slot, each
 * slot's questions to the user with an anchor for each answer as lines after its line, its attachments as file blocks after them, an image saved as a file behind its sentence naming `wording.imageReadTool`; then B, when
 * `renderCarried` has text, as one text block; then the state block of `wording.stateItems`, when the source has a `state` field.
 * Joined with nothing between them, the blocks keep every line and each later section apart. These blocks are one reminder (`frameReminder`), so the closing tag in any of their text is escaped.
 * A slot whose first seq `source.verbatimSeqs` names holds a user's own text: the seal recorded that from the slot's own message, so a model's note that opens as a user line is not taken for one. Such a slot is an anchor in its place, and its note and each answer follow the closing tag in one more text block, unframed and in carrier order, a line for each, with a break of its own at its start.
 * That block is not escaped: no frame is left for a closing tag in it to end, and the user's words stay as the user wrote them. A source with no such line renders no more blocks. Nothing is read from disk.
 * @param {object} source
 * @param {{ addresses: string, imageReadTool: string, stateItems: object[] }} wording the harness's wording table, whose `addresses` sentence opens the carrier
 * @returns {({ type: 'text', text: string } | { type: 'file', attachment: object })[]}
 */
export function renderCarrier(source, wording) {
  const W = CARRIER_WORDING;
  const blocks = [];
  let lines = [source.slots.some(({ questions }) => questions !== undefined) ? `${wording.addresses} ${W.questionMark}` : wording.addresses];
  const flush = () => {
    if (lines.length > 0) blocks.push({ type: 'text', text: lines.join('\n') });
    lines = [];
  };
  const verbatim = new Set(source.verbatimSeqs);
  const outside = [];
  for (const { seqs, text, questions = [], attachments = [] } of source.slots) {
    if (verbatim.has(seqs[0])) {
      lines.push(W.userAnchor(seqs));
      outside.push(`${W.slotLine(seqs)}${text}`);
    } else lines.push(`${W.slotLine(seqs)}${text}`);
    for (const { question, user } of questions) {
      lines.push(W.questionLine(question), W.answerAnchor);
      outside.push(`${W.slotLine(seqs)}${W.userLine(user)}`);
    }
    for (const { file, image } of attachments) {
      if (image !== undefined) lines.push(W.imageSaved(image.name ?? image.attachmentId, wording.imageReadTool));
      flush();
      blocks.push({ type: 'file', attachment: file });
    }
  }
  flush();
  const carried = renderCarried(source);
  const carriedBlock = carried === null ? null : { type: 'text', text: carried };
  const stateBlock = Object.hasOwn(source, 'state') ? { type: 'text', text: renderState(source.state, wording.stateItems) } : null;
  for (const block of [carriedBlock, stateBlock]) if (block !== null) blocks.push(block);
  // A route that sends a user message as one string joins its blocks with nothing between them, a file block by then its
  // handle text, so each text block carries its own break from the block before it and to a file block after it, and B
  // and the state block, the sections behind C, each open after a blank line.
  const framed = frameReminder(blocks.map((block, index) => {
    if (block.type !== 'text') return block;
    const before = index === 0 ? '' : block === carriedBlock || block === stateBlock ? '\n\n' : '\n';
    const after = blocks[index + 1]?.type === 'file' ? '\n' : '';
    return { type: 'text', text: `${before}${block.text}${after}` };
  }));
  return outside.length === 0 ? framed : [...framed, { type: 'text', text: `\n${outside.join('\n')}` }];
}
