// lib/dialogue-tool.js — deterministic serialization of one Dialogue tool pair's input and result.
// Pure; no I/O, no native tool name. Turn History fingerprints and searches tool evidence through these
// two functions, so two spellings of one native input have to produce one byte sequence.

/**
 * Compact JSON with object keys sorted recursively; array order is preserved because an array's order
 * is content rather than spelling.
 *
 * @param {*} value
 * @returns {string|undefined} `undefined` for `undefined`, the way JSON.stringify answers it
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
  if (typeof value === 'object') {
    const pairs = Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * One tool result as text plus the encoding that text is in. A block array that is entirely text joins
 * with newlines and stays readable; anything else becomes stable JSON so a consumer can still match on it.
 * An absent result answers `null`, which is what distinguishes "no result row was paired" from "the
 * result was the string 'null'".
 *
 * @param {*} result - The paired result content
 * @returns {{ resultStr: string|null, encoding: 'text'|'json' }}
 */
export function serializeResult(result) {
  if (result == null) return { resultStr: null, encoding: 'text' };
  if (typeof result === 'string') return { resultStr: result, encoding: 'text' };
  if (Array.isArray(result)) {
    const allText = result.every(block =>
      block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
    if (allText) return { resultStr: result.map(b => b.text).join('\n'), encoding: 'text' };
    return { resultStr: stableStringify(result), encoding: 'json' };
  }
  return { resultStr: stableStringify(result), encoding: 'json' };
}
