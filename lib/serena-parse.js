// lib/serena-parse.js
/**
 * Parsers for Serena MCP tool results.
 * Extracts body content (source code) from JSON envelope for B_rebuild tracking.
 */

const ERROR_PATTERNS = /^Error executing tool[:\s]|^No \w+ found matching/;

/**
 * Detect whether a Serena tool result is an error response.
 * All adapters must call this before processing — errors should not update B.
 */
export function isSerenaError(resultText) {
  if (!resultText || typeof resultText !== 'string') return false;
  // Direct error text (raw, not JSON-wrapped — safe to match broadly)
  if (ERROR_PATTERNS.test(resultText)) return true;
  if (/^Error: /.test(resultText)) return true;
  // Wrapped in {"result":"Error executing tool: ..."}
  try {
    const outer = JSON.parse(resultText);
    const raw = outer?.result;
    if (typeof raw === 'string' && ERROR_PATTERNS.test(raw)) return true;
  } catch { /* not JSON — already checked raw text above */ }
  return false;
}

/**
 * Parse find_symbol result.
 * Returns items with bodies (for B tracking) and a truncated flag.
 */
export function parseSerenaFindSymbol(resultText) {
  try {
    const outer = JSON.parse(resultText);
    const raw = outer?.result ?? '';
    if (typeof raw !== 'string') return { items: [], truncated: false };

    // Truncated result starts with "Matched N>max_matches=M symbols."
    if (raw.startsWith('Matched ')) return { items: [], truncated: true };

    const items = [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { items: [], truncated: false };

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const path = normPath(item.relative_path || '');
      if (!path) continue;
      items.push({
        path,
        startLine: item.body_location?.start_line ?? 0,
        endLine: item.body_location?.end_line ?? 0,
        body: typeof item.body === 'string' ? item.body : null,
      });
    }
    return { items, truncated: false };
  } catch {
    return { items: [], truncated: false };
  }
}

/**
 * Parse get_symbols_overview result.
 * Returns flat list of symbol names (body content for B).
 */
export function parseSerenaSymbolsOverview(resultText) {
  try {
    const outer = JSON.parse(resultText);
    const raw = outer?.result ?? '';
    if (typeof raw !== 'string') return { names: [] };
    const dict = JSON.parse(raw);
    if (typeof dict !== 'object' || dict === null || Array.isArray(dict)) return { names: [] };
    const names = [];
    for (const arr of Object.values(dict)) {
      if (Array.isArray(arr)) {
        for (const name of arr) { if (typeof name === 'string') names.push(name); }
      }
    }
    return { names };
  } catch {
    return { names: [] };
  }
}

/**
 * Parse find_referencing_symbols result.
 * Returns per-file entries with context snippets.
 */
export function parseSerenaReferencing(resultText) {
  try {
    const outer = JSON.parse(resultText);
    const raw = outer?.result ?? '';
    if (typeof raw !== 'string') return { files: {} };
    const dict = JSON.parse(raw);
    if (typeof dict !== 'object' || dict === null || Array.isArray(dict)) return { files: {} };

    const files = {};
    for (const [filePath, kinds] of Object.entries(dict)) {
      if (typeof kinds !== 'object' || kinds === null) continue;
      const entries = [];
      for (const refs of Object.values(kinds)) {
        if (!Array.isArray(refs)) continue;
        for (const ref of refs) {
          if (!ref || typeof ref !== 'object') continue;
          entries.push({
            startLine: ref.body_location?.start_line ?? 0,
            endLine: ref.body_location?.end_line ?? 0,
            context: ref.content_around_reference || '',
          });
        }
      }
      if (entries.length > 0) files[normPath(filePath)] = entries;
    }
    return { files };
  } catch {
    return { files: {} };
  }
}

/**
 * Unwrap Serena's standard {"result": "..."} envelope for plain-text results.
 * Falls back to raw text if not valid JSON.
 */
export function parseSerenaPlainText(resultText) {
  try {
    const outer = JSON.parse(resultText);
    const raw = outer?.result;
    return typeof raw === 'string' ? raw : resultText;
  } catch {
    return resultText;
  }
}

// Normalize backslash paths to posix (Serena on Windows emits \\)
function normPath(p) {
  if (!p) return '';
  return p.replace(/\\\\/g, '/').replace(/\\/g, '/');
}
