// lib/system-reminder.js — the frame DSH writes a harness-owned reminder in: `<system-reminder>`, a line break, the body, a line break and the closing tag, the closing tag inside the body escaped. DSH's `llm-pi-ai` (`packages/llm/llm-pi-ai/src/context.ts` in the DSH checkout) frames a system message it sends as a user message the same way, and its instruction frame (`packages/context/agent-instructions/src/render.ts`) escapes alike.
// The inner-seal carrier is written in it (`lib/inner-seal/carrier.js`), and the read guard reads the escape to tell a line the carrier cannot hold word for word (`lib/held-read.js`).

/** What a framed message opens with. */
export const REMINDER_OPEN = '<system-reminder>\n';

const REMINDER_CLOSE = '</system-reminder>';
const ESCAPED_CLOSE = '<\\/system-reminder>';

/**
 * The text as a framed body holds it: each closing tag written as `<\/system-reminder>`, so none ends the frame early.
 * @param {string} text
 * @returns {string}
 */
export const escapeReminder = text => text.replaceAll(REMINDER_CLOSE, ESCAPED_CLOSE);

/**
 * The content blocks of a message framed as one reminder: every text block escaped, the opening ahead of the first block, which is a text block, and the closing after the last on a line of its own, whatever the last block ends with, as DSH writes it. A last block that is no text has a text block of the closing placed after it. A route that sends the message as one string joins the blocks with nothing between them, so that text block opens with its own line break, as the carrier's blocks each do.
 * @param {[{ type: 'text', text: string }, ...({ type: 'text', text: string } | { type: string })[]]} blocks
 * @returns {({ type: 'text', text: string } | { type: string })[]} new blocks; the ones handed in are left as they were
 */
export function frameReminder(blocks) {
  const framed = blocks.map(block => (block.type === 'text' ? { ...block, text: escapeReminder(block.text) } : block));
  framed[0] = { ...framed[0], text: `${REMINDER_OPEN}${framed[0].text}` };
  const last = framed.at(-1);
  if (last.type === 'text') framed[framed.length - 1] = { ...last, text: `${last.text}\n${REMINDER_CLOSE}` };
  else framed.push({ type: 'text', text: `\n${REMINDER_CLOSE}` });
  return framed;
}
