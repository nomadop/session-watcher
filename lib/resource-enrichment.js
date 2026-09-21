// lib/resource-enrichment.js — Resource Enrichment: the only place that opens a resource's local file,
// asks for a grammar, captures symbol ranges, or resolves them.
//
// Parser and grammar work is delegated whole to `lib/symbol-outline.js`; nothing here re-derives a symbol,
// a range, or a language rule. Nothing here reads or changes selection, overrides, or measurement state
// either: every entry point takes a path plus the line coverage its caller already holds, and answers with
// facts. That is what keeps the bucket read, handoff preparation and handoff delivery from each growing a
// private copy of "which symbols is this file resident in".
//
// Every filesystem and grammar capability is injected, so a test drives the real extraction over a fixture
// string with no wasm grammar present.
import { extname, isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  canExtract as defaultCanExtract, loadGrammar as defaultLoadGrammar,
  activeSymbolsForPath, buildSymbolRanges, resolveSymbolLines,
} from './symbol-outline.js';

export function createResourceEnrichment({
  readFile = (absPath) => readFileSync(absPath, 'utf8'),
  // The grammar prewarm request. It performs no filtering of its own: an extension with no grammar, and one
  // already loaded, are both a resolved promise inside `loadGrammar`.
  warmer = defaultLoadGrammar,
  loadGrammar = defaultLoadGrammar,
  canExtract = defaultCanExtract,
} = {}) {

  /**
   * Ask for a grammar for every key's extension, once per key.
   *
   * It is called from the resource-policy flush, which must not be able to fail on it: a grammar is a
   * display convenience and the flush it rides along with owns the position basis. So this returns
   * synchronously, swallows a rejected warmer, and continues past a warmer that throws — a later key's
   * grammar is not the earlier key's to lose.
   *
   * @param {string[]} keys resource keys, exactly as the Engine reported them
   * @returns {undefined}
   */
  function warm(keys) {
    for (const key of keys ?? []) {
      const ext = extname(String(key)).toLowerCase();
      try {
        const pending = warmer(ext);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch { /* a grammar this session never gets is a display loss, not a measurement one */ }
    }
    return undefined;
  }

  function readCode(absPath) {
    try { return readFile(absPath); } catch { return null; }
  }

  /**
   * The symbols a bucket row's resident lines actually sit in.
   *
   * @param {{ path: string, lineNumbers: number[], fullSnapshot: boolean }} row
   * @returns {string[]|null} symbol names, or null when the file cannot contribute any
   */
  function activeSymbols({ path, lineNumbers = [], fullSnapshot = false }) {
    const ext = extname(path);
    if (!canExtract(ext)) return null;
    const code = readCode(path);
    if (code == null) return null;
    try {
      return activeSymbolsForPath(code, ext, lineNumbers ?? [], fullSnapshot === true).activeSymbols;
    } catch { return null; }
  }

  /**
   * The stored line ranges of each named symbol, within one resource's own coverage.
   *
   * `lineNumbers` is the resource's own coverage, whatever produced it: a whole-content read holds every line
   * it was read with, and a partial one holds the lines it named. There is ONE route — the ranges are computed
   * against the lines the READ saw, while the file's text is read at this moment, so code comes from now and
   * coverage from then. An EMPTY coverage — a resource whose only mutation moved its total without naming a
   * line — captures nothing, exactly as an empty coverage should.
   *
   * @param {{ path: string, symbols: string[], lineNumbers: number[] }} request
   * @returns {Record<string, [number, number][]>|null} ranges by symbol name, or null when none was captured
   */
  function symbolRanges({ path, symbols, lineNumbers }) {
    if (!Array.isArray(symbols) || symbols.length === 0) return null;
    const ext = extname(path);
    if (!canExtract(ext)) return null;
    const code = readCode(path);
    if (code == null) return null;
    const coverage = Array.isArray(lineNumbers) ? lineNumbers : [];
    if (coverage.length === 0) return null;
    try {
      const ranges = buildSymbolRanges(code, ext, symbols, coverage);
      return (ranges && Object.keys(ranges).length > 0) ? ranges : null;
    } catch { return null; }
  }

  /**
   * Where each stored symbol range sits in the file as it is NOW.
   *
   * The facts are structured, never rendered: `parsed` says whether a parser could speak about this file at
   * all, `readable` whether the file is still there, and each stored name lands in `resolved` with its
   * current lines or in `stale` with the lines it was stored under. Handoff composition turns them into the
   * wording a consumer reads.
   *
   * @param {{ path: string, symbolRanges: Record<string, [number, number][]>, projectDir: string|null }} request
   * @returns {Promise<{ parsed: boolean, readable: boolean, resolved: object[], stale: object[] }>}
   */
  async function resolveSymbols({ path, symbolRanges: storedRanges, projectDir }) {
    const stored = storedRanges && typeof storedRanges === 'object' ? storedRanges : {};
    const staleAll = Object.entries(stored).map(([name, ranges]) => ({ name, storedRanges: ranges }));
    const ext = extname(path).toLowerCase();
    // A cold consumer has done no folding, so its grammar is not loaded yet and `canExtract` would refuse a
    // file the producer parsed perfectly well. The request is awaited for that reason and swallowed for the
    // usual one: a missing grammar downgrades the answer, it does not fail the delivery.
    try { await loadGrammar(ext); } catch { /* the canExtract check below reports it */ }
    if (!canExtract(ext)) return { parsed: false, readable: false, resolved: [], stale: staleAll };
    const absolute = isAbsolute(path) ? path : (projectDir ? join(projectDir, path) : path);
    const code = readCode(absolute);
    if (code == null) return { parsed: true, readable: false, resolved: [], stale: staleAll };
    const { resolved, stale } = resolveSymbolLines(code, ext, stored);
    return { parsed: true, readable: true, resolved, stale };
  }

  return { warm, activeSymbols, symbolRanges, resolveSymbols };
}
