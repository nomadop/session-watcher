// The carrier's blocks with the reminder frame taken off, after the frame is checked to stand: the first text block opens it and the block that closes it ends it, a text block of its own where the last one inside is a file. The text a carrier leaves after the closing tag is no part of the frame (`splitFrame`). The tags are written out here, so a change of the frame fails the tests that read the carrier through this.
import assert from 'node:assert/strict';

const OPEN = '<system-reminder>\n';
const CLOSE = '</system-reminder>';

/**
 * @param {({ type: 'text', text: string } | { type: 'file' })[]} blocks the blocks `renderCarrier` returned
 * @returns {({ type: 'text', text: string } | { type: 'file' })[]} the blocks between the frame's tags, each text block a copy
 */
export const unframed = blocks => splitFrame(blocks).inside;

function stripFrame(blocks) {
  const body = blocks.map(block => ({ ...block }));
  assert.equal(body[0].type, 'text', 'the frame opens in a text block');
  assert.ok(body[0].text.startsWith(OPEN), 'the first block opens the frame');
  body[0].text = body[0].text.slice(OPEN.length);
  const last = body.at(-1);
  assert.equal(last.type, 'text', 'the frame closes in a text block');
  assert.ok(last.text.endsWith(`\n${CLOSE}`), 'the last block closes the frame after a line break');
  last.text = last.text.slice(0, -`\n${CLOSE}`.length);
  return last.text === '' && body.length > 1 && body.at(-2).type === 'file' ? body.slice(0, -1) : body;
}

/**
 * The carrier's blocks split at the frame: the blocks between its tags and the blocks after its closing tag, which the frame does not hold. The closing tag is the one a block ends with after a line break; every closing tag in the framed text is escaped, so the first such block is the frame's own.
 * @param {({ type: 'text', text: string } | { type: 'file' })[]} blocks the blocks `renderCarrier` returned
 * @returns {{ inside: ({ type: 'text', text: string } | { type: 'file' })[], outside: ({ type: 'text', text: string } | { type: 'file' })[] }}
 */
export function splitFrame(blocks) {
  const closing = blocks.findIndex(block => block.type === 'text' && block.text.endsWith(`\n${CLOSE}`));
  assert.ok(closing >= 0, 'the frame closes in a text block');
  return { inside: stripFrame(blocks.slice(0, closing + 1)), outside: blocks.slice(closing + 1) };
}
