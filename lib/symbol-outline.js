import { Parser, Language } from 'web-tree-sitter';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_SYMBOL_FILE_BYTES = 512 * 1024; // skip parse for files larger than this

// Extension → grammar WASM filename
const EXT_TO_GRAMMAR = {
  '.js': 'tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.ts': 'tree-sitter-typescript.wasm',
  '.mts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.py': 'tree-sitter-python.wasm',
};

// Extension → language key (for profiles/orphan sets)
const EXT_TO_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
};

// Per-language orphan exclusion sets
const ORPHAN_EXCLUDE = {
  javascript: new Set(['import_statement', 'comment', 'empty_statement', 'hash_bang_line']),
  typescript: new Set(['import_statement', 'comment', 'empty_statement', 'hash_bang_line']),
  python: new Set(['import_statement', 'import_from_statement', 'comment', 'pass_statement']),
};

let parser = null;
let parserReady = false;
let initPromise = null;
const grammarPromises = new Map(); // grammarFile → Promise
const grammars = new Map(); // grammarFile → Language
const grammarAttempts = new Map(); // grammarFile → number (failure count)
const MAX_GRAMMAR_ATTEMPTS = 3;

// Extensions handled by regex (no tree-sitter grammar needed)
// SYNC: when adding entries, also add extraction branch in extractSymbols() and activeSymbolsForPath()
export const REGEX_EXTS = new Set(['.md']);

export function isParserReady() { return parserReady; }
export function isGrammarLoaded(ext) { return grammars.has(EXT_TO_GRAMMAR[ext]); }
export function isSupported(ext) { ext = ext.toLowerCase(); return ext in EXT_TO_GRAMMAR || REGEX_EXTS.has(ext); }
export function canExtract(ext) {
  ext = ext.toLowerCase();
  if (REGEX_EXTS.has(ext)) return true;
  return parserReady && isGrammarLoaded(ext);
}

let _wasmDir = __dirname; // default: co-located in dist/ (bundle); overridable for tests

// Single-flight parser init — concurrent calls share one promise; retry on failure
export function initParser({ wasmDir } = {}) {
  if (parserReady) return Promise.resolve();
  if (initPromise) return initPromise;
  if (wasmDir) _wasmDir = wasmDir;
  initPromise = Parser.init({ locateFile: (file) => join(_wasmDir, file) })
    .then(() => { parser = new Parser(); parserReady = true; })
    .catch(err => { initPromise = null; throw err; }); // allow retry
  return initPromise;
}

// Single-flight grammar load — chains on parser init; retry on failure
export function loadGrammar(ext, { wasmDir } = {}) {
  const file = EXT_TO_GRAMMAR[ext];
  if (!file) return Promise.resolve();
  if (grammars.has(file)) return Promise.resolve();
  if (grammarPromises.has(file)) return grammarPromises.get(file);
  if ((grammarAttempts.get(file) || 0) >= MAX_GRAMMAR_ATTEMPTS) return Promise.resolve(); // gave up
  const dir = wasmDir || _wasmDir;
  const promise = initParser() // never forward grammar-specific wasmDir to parser init (#5)
    .then(() => Language.load(join(dir, file)))
    .then(lang => { grammars.set(file, lang); })
    .catch(err => {
      grammarPromises.delete(file);
      // Only burn grammar retry budget if parser is ready (i.e., Language.load failed, not initParser)
      if (parserReady) grammarAttempts.set(file, (grammarAttempts.get(file) || 0) + 1);
      throw err;
    });
  grammarPromises.set(file, promise);
  return promise;
}

function getLanguage(ext) {
  const file = EXT_TO_GRAMMAR[ext];
  return file ? grammars.get(file) : undefined;
}

// INVARIANT: parse is synchronous. setLanguage + parse must not be separated by an await.
// The single parser instance is safe only because Node's event loop cannot interleave
// synchronous calls. If this is ever made async, introduce per-call parser instances.
function parse(code, ext) {
  const lang = getLanguage(ext);
  if (!lang) return null;
  parser.setLanguage(lang);
  return parser.parse(code);
}

// Wrapper that ensures tree.delete() is always called after use
function withTree(code, ext, fn) {
  const tree = parse(code, ext);
  if (!tree) return null;
  try { return fn(tree); }
  finally { tree.delete(); }
}

// ── Extraction Profiles ──

const JS_LEVEL0_TYPES = new Set([
  'function_declaration', 'generator_function_declaration', 'class_declaration',
]);
const JS_LEVEL0_VAR_TYPES = new Set(['lexical_declaration', 'variable_declaration']);

const TS_EXTRA_LEVEL0 = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration']);

function extractName(node) {
  const nameNode = node.childForFieldName('name');
  return nameNode ? nameNode.text : null;
}

function varDeclName(node) {
  // First declarator's name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'variable_declarator') {
      const n = child.childForFieldName('name');
      return n ? n.text : null;
    }
  }
  return null;
}

function nodeSpan(node) {
  return node.endPosition.row - node.startPosition.row + 1;
}

// ── Markdown Extraction (regex fast-path) ──

const MD_HEADING_RE = /^ {0,3}(#{1,3})\s+(.+?)(?:\s+#+\s*)?$/;
const MD_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const MD_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function _extractMarkdownSymbols(code) {
  // Normalize line endings (CRLF → LF, bare CR → LF)
  const normalized = code.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const headings = []; // { level, rawName, startLine }
  let inFence = false;
  let fenceChar = null;  // '`' or '~'
  let fenceLen = 0;      // minimum length needed to close
  let startIdx = 0;

  // Skip YAML frontmatter: if first line is '---', skip until closing '---' (max 50 lines)
  if (lines[0] && lines[0].trim() === '---') {
    const fmLimit = Math.min(lines.length, 50);
    for (let i = 1; i < fmLimit; i++) {
      if (lines[i].trim() === '---') { startIdx = i + 1; break; }
    }
    // If no close found within 50 lines, not frontmatter — parse from start (startIdx stays 0)
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    // Fence state machine
    if (!inFence) {
      const openMatch = line.match(MD_FENCE_OPEN_RE);
      if (openMatch) {
        const ch = openMatch[1][0];
        // CommonMark §4.5: backtick fence info string must not contain backticks
        if (ch === '`') {
          const afterFence = line.slice(line.indexOf(openMatch[1]) + openMatch[1].length);
          if (afterFence.includes('`')) { /* not a valid fence opening — fall through to heading check */ }
          else {
            inFence = true;
            fenceChar = ch;
            fenceLen = openMatch[1].length;
            continue;
          }
        } else {
          inFence = true;
          fenceChar = ch;
          fenceLen = openMatch[1].length;
          continue;
        }
      }
    } else {
      // Only close if same char, sufficient length, AND nothing but whitespace after
      const closeMatch = line.match(MD_FENCE_CLOSE_RE);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      continue; // whether we closed or not, this line is consumed by the fence
    }

    const match = line.match(MD_HEADING_RE);
    if (match) {
      const level = match[1].length; // 1, 2, or 3
      const rawName = match[2].trim();
      if (!rawName) continue;
      headings.push({ level, rawName, startLine: i + 1 }); // 1-indexed
    }
  }

  if (headings.length === 0) return [];

  // Trailing newline produces a phantom empty final element — exclude it
  const totalLines = (lines.length > 0 && lines[lines.length - 1] === '') ? lines.length - 1 : lines.length;

  // Build nested names and compute endLines
  const symbols = [];
  const stack = []; // [{ level, fullName }] — current ancestry

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];

    // Pop stack to find parent (anything at same or higher level)
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    // Build full name
    const fullName = stack.length > 0
      ? `${stack[stack.length - 1].fullName} > ${h.rawName}`
      : h.rawName;

    // Push onto stack
    stack.push({ level: h.level, fullName });

    // endLine = line before next heading of same or higher level, or last real line of file
    let endLine = totalLines;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].startLine - 1;
        break;
      }
    }

    symbols.push({ name: fullName, startLine: h.startLine, endLine, depth: stack.length - 1 });
  }

  // Duplicate name bailout
  const seen = new Set();
  for (const s of symbols) {
    if (seen.has(s.name)) return [];
    seen.add(s.name);
  }

  return symbols;
}

export function extractSymbols(code, ext) {
  ext = ext.toLowerCase();
  if (ext === '.md') {
    if (code.length > MAX_SYMBOL_FILE_BYTES) return [];
    return _extractMarkdownSymbols(code);
  }
  return withTree(code, ext, (tree) => {
    const lang = EXT_TO_LANG[ext] || 'javascript';
    return _extractFromTree(tree, ext, lang);
  }) || [];
}

function _extractFromTree(tree, ext, lang) {
  const symbols = [];
  const root = tree.rootNode;

  for (let i = 0; i < root.namedChildCount; i++) {
    let node = root.namedChild(i);

    // Unwrap export_statement (covers both `export` and `export default` in JS/TS)
    if (node.type === 'export_statement' || node.type === 'export_default_declaration') {
      const decl = node.childForFieldName('declaration') || node.namedChild(0);
      if (decl && decl.type !== node.type) node = decl;
      else continue;
    }

    // Python: decorated_definition — name from inner, startLine from outer
    if (lang === 'python' && node.type === 'decorated_definition') {
      const outerStart = node.startPosition.row + 1;
      const outerEnd = node.endPosition.row + 1;
      const inner = node.childForFieldName('definition') || node.namedChild(node.namedChildCount - 1);
      if (inner && (inner.type === 'function_definition' || inner.type === 'class_definition' || inner.type === 'async_function_definition')) {
        const name = extractName(inner);
        if (name) {
          symbols.push({ name, startLine: outerStart, endLine: outerEnd, depth: 0 });
          if (inner.type === 'class_definition') {
            extractClassMethods(inner, name, symbols, lang);
          }
        }
      }
      continue;
    }

    // Python: function_definition, async_function_definition, class_definition at top level
    if (lang === 'python') {
      if (node.type === 'function_definition' || node.type === 'async_function_definition' || node.type === 'class_definition') {
        const name = extractName(node);
        if (name) {
          symbols.push({ name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
          if (node.type === 'class_definition') {
            extractClassMethods(node, name, symbols, lang);
          }
        }
        continue;
      }
      // Top-level assignment ≥3 lines
      if (node.type === 'expression_statement' && nodeSpan(node) >= 3) {
        const assign = node.namedChild(0);
        if (assign && assign.type === 'assignment') {
          const left = assign.childForFieldName('left');
          if (left) {
            symbols.push({ name: left.text, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
          }
        }
      }
      continue;
    }

    // JS/TS: function/generator/class declarations
    if (JS_LEVEL0_TYPES.has(node.type) || (lang === 'typescript' && TS_EXTRA_LEVEL0.has(node.type))) {
      const name = extractName(node);
      if (!name) continue;
      const span = nodeSpan(node);
      if (lang === 'typescript' && TS_EXTRA_LEVEL0.has(node.type) && span < 3) continue;
      symbols.push({ name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
      if (node.type === 'class_declaration') {
        extractClassMethods(node, name, symbols, lang);
      }
      continue;
    }

    // JS/TS: variable declarations ≥3 lines
    if (JS_LEVEL0_VAR_TYPES.has(node.type) && nodeSpan(node) >= 3) {
      const name = varDeclName(node);
      if (name) {
        symbols.push({ name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
      }
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine);
  return symbols;
}

function extractClassMethods(classNode, className, symbols, lang) {
  // Find class_body (JS/TS) or block (Python)
  let body = null;
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child.type === 'class_body' || child.type === 'block') {
      body = child;
      break;
    }
  }
  if (!body) return;

  for (let i = 0; i < body.namedChildCount; i++) {
    let node = body.namedChild(i);

    // Python: unwrap decorated_definition inside class
    if (lang === 'python' && node.type === 'decorated_definition') {
      const outerStart = node.startPosition.row + 1;
      const outerEnd = node.endPosition.row + 1;
      const inner = node.childForFieldName('definition') || node.namedChild(node.namedChildCount - 1);
      if (inner && (inner.type === 'function_definition' || inner.type === 'async_function_definition')) {
        const name = extractName(inner);
        if (name) symbols.push({ name: `${className}.${name}`, startLine: outerStart, endLine: outerEnd, depth: 1 });
      }
      continue;
    }

    // JS/TS: method_definition
    if (node.type === 'method_definition') {
      const name = extractName(node) || (node.childForFieldName('name')?.text);
      if (name) symbols.push({ name: `${className}.${name}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
      continue;
    }

    // Python: function_definition / async_function_definition inside class
    if (lang === 'python' && (node.type === 'function_definition' || node.type === 'async_function_definition')) {
      const name = extractName(node);
      if (name) symbols.push({ name: `${className}.${name}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
      continue;
    }

    // TS: field_definition ≥3 lines
    if (lang === 'typescript' && node.type === 'field_definition' && nodeSpan(node) >= 3) {
      const nameNode = node.childForFieldName('property') || node.childForFieldName('name');
      if (nameNode) symbols.push({ name: `${className}.${nameNode.text}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
    }
  }
}

// ── Fitting ──

export function fitLinesToSymbols(lineNumbers, symbols) {
  const matched = new Set();
  const orphanLines = [];
  let coveredCount = 0;

  for (const line of lineNumbers) {
    let tightest = null;
    let tightestSpan = Infinity;
    for (const sym of symbols) {
      if (sym.startLine <= line && line <= sym.endLine) {
        const span = sym.endLine - sym.startLine;
        if (span < tightestSpan) { tightest = sym; tightestSpan = span; }
      }
    }
    if (tightest) { matched.add(tightest.name); coveredCount++; }
    else { orphanLines.push(line); }
  }

  return { activeSymbols: [...matched], coveredCount, orphanLines };
}

export function classifyOrphans(orphanLines, tree, language) {
  const excludeSet = ORPHAN_EXCLUDE[language] || ORPHAN_EXCLUDE.javascript;
  let excluded = 0;

  for (const line of orphanLines) {
    // Find the AST node at this line (column 0)
    const node = tree.rootNode.descendantForPosition({ row: line - 1, column: 0 });
    if (node) {
      // Walk up to find the top-level statement node
      let current = node;
      while (current.parent && current.parent !== tree.rootNode) current = current.parent;
      if (excludeSet.has(current.type)) { excluded++; }
    }
  }

  return { excluded, structural: orphanLines.length - excluded };
}

// ── Main API: activeSymbolsForPath ──

// Shared post-processing for activeSymbolsForPath (both tree-sitter and regex paths).
// Receives pre-computed fitting results to avoid redundant fitLinesToSymbols calls.
function _selectActiveSymbols(symbols, fitResult, totalBucketLines, hasFullSnapshot, excludedOrphanCount) {
  const cap = 30;

  if (hasFullSnapshot) {
    // Depth-aware cap: greedy trim from deepest level, stop at depth 1
    let selected = symbols;
    if (selected.length > cap) {
      const maxDepth = selected.reduce((m, s) => Math.max(m, s.depth), 0);
      for (let d = maxDepth; d > 1 && selected.length > cap; d--) {
        const atThisDepth = selected.filter(s => s.depth === d);
        const others = selected.filter(s => s.depth !== d);
        const keep = cap - others.length;
        if (keep <= 0) {
          selected = others;
        } else {
          selected = others.concat(atThisDepth.slice(0, keep));
          selected.sort((a, b) => a.startLine - b.startLine);
        }
      }
      if (selected.length > cap) selected = selected.slice(0, cap);
    }
    const names = selected.map(s => s.name);
    return { activeSymbols: names.length ? names : null };
  }

  const { activeSymbols, coveredCount } = fitResult;
  if (totalBucketLines === 0) return { activeSymbols: null };

  const adjustedTotal = totalBucketLines - excludedOrphanCount;
  const adjustedCoverage = adjustedTotal > 0 ? coveredCount / adjustedTotal : 1.0;
  if (adjustedCoverage < 0.5) return { activeSymbols: null };

  // Deduplicate and order by source position
  const activeSet = new Set(activeSymbols);
  const seen = new Set();
  const ordered = [];
  for (const s of symbols) {
    if (activeSet.has(s.name) && !seen.has(s.name)) {
      seen.add(s.name);
      ordered.push(s.name);
    }
  }
  const capped = ordered.slice(0, cap);
  return { activeSymbols: capped.length ? capped : null };
}

export function activeSymbolsForPath(code, ext, bucketLineNumbers, hasFullSnapshot) {
  ext = ext.toLowerCase();
  if (!canExtract(ext)) return { activeSymbols: null };
  if (code.length > MAX_SYMBOL_FILE_BYTES) return { activeSymbols: null };

  // Markdown: regex path (no tree, no classifyOrphans)
  if (ext === '.md') {
    const symbols = _extractMarkdownSymbols(code);
    if (symbols.length === 0) return { activeSymbols: null };
    const fitResult = fitLinesToSymbols(bucketLineNumbers, symbols);
    return _selectActiveSymbols(symbols, fitResult, bucketLineNumbers.length, hasFullSnapshot, 0);
  }

  // Tree-sitter path
  return withTree(code, ext, (tree) => {
    const lang = EXT_TO_LANG[ext] || 'javascript';
    const symbols = _extractFromTree(tree, ext, lang);
    const fitResult = fitLinesToSymbols(bucketLineNumbers, symbols);
    const { excluded } = classifyOrphans(fitResult.orphanLines, tree, lang);
    return _selectActiveSymbols(symbols, fitResult, bucketLineNumbers.length, hasFullSnapshot, excluded);
  }) || { activeSymbols: null };
}

// ── buildSymbolRanges (prepare-side) ──

export function buildSymbolRanges(code, ext, keptNames, bucketLineNumbers) {
  ext = ext.toLowerCase();
  if (!canExtract(ext)) return Object.create(null);
  if (code.length > MAX_SYMBOL_FILE_BYTES) return Object.create(null);

  const symbols = extractSymbols(code, ext);
  // First-match Map for consistent lookup (same semantics as resolveSymbolLines)
  const symMap = new Map();
  for (const s of symbols) { if (!symMap.has(s.name)) symMap.set(s.name, s); }

  const result = Object.create(null);

  for (const name of keptNames) {
    const sym = symMap.get(name);
    if (!sym) continue; // omit if not found at re-parse time

    // Collect bucket lines that fall within this symbol's range
    const linesInSymbol = bucketLineNumbers.filter(l => l >= sym.startLine && l <= sym.endLine);
    if (linesInSymbol.length === 0) continue;

    // Collapse to ranges
    linesInSymbol.sort((a, b) => a - b);
    const ranges = [];
    let start = linesInSymbol[0], end = linesInSymbol[0];
    for (let i = 1; i < linesInSymbol.length; i++) {
      if (linesInSymbol[i] <= end + 1) { end = linesInSymbol[i]; }
      else { ranges.push([start, end]); start = linesInSymbol[i]; end = linesInSymbol[i]; }
    }
    ranges.push([start, end]);
    result[name] = ranges;
  }

  return result;
}

// ── resolveSymbolLines (load-side) ──

export function resolveSymbolLines(code, ext, symbolRanges) {
  ext = ext.toLowerCase();
  const resolved = [];
  const stale = [];

  if (!code || !canExtract(ext)) {
    // Cannot parse — all symbols are stale
    for (const [name, ranges] of Object.entries(symbolRanges || {})) {
      stale.push({ name, storedRanges: ranges });
    }
    return { resolved, stale };
  }

  const symbols = extractSymbols(code, ext);
  // First-match Map (consistent with buildSymbolRanges — first declaration wins)
  const symMap = new Map();
  for (const s of symbols) { if (!symMap.has(s.name)) symMap.set(s.name, s); }

  for (const [name, ranges] of Object.entries(symbolRanges || {})) {
    const sym = symMap.get(name);
    if (sym) {
      resolved.push({ name, startLine: sym.startLine, endLine: sym.endLine });
    } else {
      stale.push({ name, storedRanges: ranges });
    }
  }

  return { resolved, stale };
}
