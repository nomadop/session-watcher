// lib/inner-seal/carrier.js — the inner-seal carrier: the message an inner seal appends in place of the source it seals.
//
// Its `source` is the one recoverable representation of what the carrier says: the C slots, each holding beside its note
// the questions its step asked the user and the user's answers as `questions`, `{ question, user }` in the order they were
// asked, each text whole as the model wrote the question and the user gave the answer; B, the evidence it carries
// (`lib/carried-evidence.js`); and the session state block (`lib/inner-seal/state-block.js`) as its `state` field.
// The tool names and the sentences that depend on the harness are the harness's wording table, handed to `renderCarrier`.
import { renderCarried } from '../carried-evidence.js';
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
 * `carriedOf` answer gives, and `state` where it is not null. `verbatimSeqs` records the sources of whole user text and the results of injected questions for the monitor; it is not rendered.
 * @param {{ slots: { seqs: number[] }[], summaries: string[], questions: { question: string, user: string, seqs?: number[] }[][], attachments: object[][], verbatimSeqs?: number[], changes: object, state: (object|null) }} parts
 */
export function assembleCarrierSource({ slots, summaries, questions, attachments, verbatimSeqs = [], changes, state }) {
  const injected = [...new Set([...verbatimSeqs, ...questions.flat().flatMap(({ seqs }) => seqs ?? [])])];
  return {
    kind: INNER_SEAL_KIND, v: 1,
    slots: slots.map(({ seqs }, index) => ({
      seqs, text: summaries[index],
      ...(questions[index].length > 0 ? { questions: questions[index].map(({ question, user }) => ({ question, user })) } : {}),
      ...(attachments[index].length > 0 ? { attachments: attachments[index] } : {}),
    })),
    ...(injected.length > 0 ? { verbatimSeqs: injected } : {}),
    ...changes,
    ...(state === null ? {} : { state }),
  };
}

// ── The body ─────────────────────────────────────────────────────────────────

/**
 * The carrier's provisional model-visible wording that no harness's tool names. Each entry carries a required meaning and may be reworded
 * without changing it: a line marked user holds the user's own words; an image saved as a file is not in the current context and the named
 * tool can read the file below; a line marked question holds a question the step asked the user as the model wrote it,
 * a line marked user under it the user's own answer to it, the selected labels and the custom text, and neither is part
 * of the summary.
 */
export const CARRIER_WORDING = {
  slotLine: seqs => `seq ${seqs.join(', ')}: `,
  imageSaved: (name, tool) => `The image ${name} is not in the current context; ${tool} can read the file below when it is needed.`,
  questionMark: 'A line marked question: holds the question as it was asked, and the user: line under it the user\'s whole answer.',
  questionLine: question => `question: ${question}`,
  userLine: user => `user: ${user}`,
};

/**
 * The carrier's content blocks, rendered from its `source` alone: C, the address sentence and one line per slot, each
 * slot's questions to the user with the user's answers as lines after its line, its attachments as file blocks after them, an image saved as a file behind its sentence naming `wording.imageReadTool`; then B, when
 * `renderCarried` has text under `wording`, as one text block; then the state block of `wording.stateItems`, when the source has a `state` field.
 * Joined with nothing between them, the blocks keep every line and each later section apart. Nothing is read from disk.
 * @param {object} source
 * @param {{ addresses: string, editGuard: string, imageReadTool: string, stateItems: object[] }} wording the harness's wording table, whose `addresses` sentence opens the carrier
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
  for (const { seqs, text, questions = [], attachments = [] } of source.slots) {
    lines.push(`${W.slotLine(seqs)}${text}`);
    for (const { question, user } of questions) lines.push(W.questionLine(question), W.userLine(user));
    for (const { file, image } of attachments) {
      if (image !== undefined) lines.push(W.imageSaved(image.name ?? image.attachmentId, wording.imageReadTool));
      flush();
      blocks.push({ type: 'file', attachment: file });
    }
  }
  flush();
  const carried = renderCarried(source, wording);
  const carriedBlock = carried === null ? null : { type: 'text', text: carried };
  const stateBlock = Object.hasOwn(source, 'state') ? { type: 'text', text: renderState(source.state, wording.stateItems) } : null;
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
