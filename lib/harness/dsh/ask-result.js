// lib/harness/dsh/ask-result.js — the one reading of an `ask_user_question` result text.

/**
 * The answers of an `ask_user_question` result, which renders its value, `{ answers: [{ id, selected, custom? }] }`,
 * as the result's JSON text. A text that is no such value, or that holds an answer whose `selected` is no list
 * of strings or whose `custom` is present and no string, holds no answer at all: the whole result reads as `[]`,
 * a well-formed answer beside a malformed one included. `id` is carried as given, for the caller to pair by.
 *
 * @param {string} resultText
 * @returns {{ id: *, selected: string[], custom?: string }[]}
 */
export function askAnswersOf(resultText) {
  let value;
  try {
    value = JSON.parse(resultText);
  } catch {
    return [];
  }
  if (!Array.isArray(value?.answers)) return [];
  const answers = [];
  for (const answer of value.answers) {
    const { id, selected, custom } = answer ?? {};
    if (!Array.isArray(selected) || !selected.every(label => typeof label === 'string')) return [];
    if (custom !== undefined && typeof custom !== 'string') return [];
    answers.push(custom === undefined ? { id, selected } : { id, selected, custom });
  }
  return answers;
}
