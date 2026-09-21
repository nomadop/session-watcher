// lib/token-estimate.js — the sole owner of chars→tokens estimation.
// Token-at-Ingestion: every stored token value is produced by applying one of these two functions once,
// at the moment the text was observed, under the CTP a model policy supplied. The module holds no CTP of
// its own — the caller passes the pair it resolved — so the same estimator serves any provider.

// CJK ranges: U+3000–U+9FFF (CJK sym+ideographs), U+AC00–U+D7AF (Hangul), U+F900–U+FAFF (compat).
export const CJK_RE = /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

// chars → tokens via the Two-CTP model: ASCII and CJK have different tokenizer efficiency, so a single
// divisor understates one of them. `asciiOnly` skips the scan for a resource whose extension is
// known-ASCII, where the scan can only ever find nothing.
export function charsToTokens(text, ctp, { asciiOnly = false } = {}) {
  if (!text) return 0;
  if (asciiOnly) return text.length / ctp.ascii;
  const cjkCount = (text.match(CJK_RE) || []).length;
  if (cjkCount === 0) return text.length / ctp.ascii;
  return (text.length - cjkCount) / ctp.ascii + cjkCount / ctp.cjk;
}

// Integer-counter variant for a caller that already accumulated {chars, cjk} and would otherwise
// materialise a large string solely to read its length. Shares charsToTokens' exact two-division form,
// so both agree on the same text to the last bit.
export function countsToTokens({ chars, cjk }, ctp) {
  if (chars === 0) return 0;
  if (cjk === 0) return chars / ctp.ascii;
  return (chars - cjk) / ctp.ascii + cjk / ctp.cjk;
}
