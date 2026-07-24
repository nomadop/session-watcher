import path from 'node:path';
import { TOOL_OVERHEAD, ALPHA_EMA, G_FLOOR } from './constants.js';

// lib/measure.js — v3 continuous-B measurement layer (spec §2).
// Pure helpers + the BRebuild sparse per-path token map. Zero dependencies beyond sibling lib/.
// All token values are Token-at-Ingestion: charsToTokens() applied once at write time.

// CJK ranges: U+3000–U+9FFF (CJK sym+ideographs), U+AC00–U+D7AF (Hangul), U+F900–U+FAFF (compat).
export const CJK_RE = /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

// chars → tokens via the Two-CTP model. ASCII and CJK have different tokenizer efficiency (spec §2.1).
// asciiOnly skips the regex scan for known-ASCII file extensions (fast path — <0.1ms on 10KB files).
export function charsToTokens(text, ctp, { asciiOnly = false } = {}) {
  if (!text) return 0;
  if (asciiOnly) return text.length / ctp.ascii;
  const cjkCount = (text.match(CJK_RE) || []).length;
  if (cjkCount === 0) return text.length / ctp.ascii;
  return (text.length - cjkCount) / ctp.ascii + cjkCount / ctp.cjk;
}

// Integer-counter variant: convert pre-accumulated {chars, cjk} counts to tokens without
// materialising the full string. Use this when only the count is needed (e.g. reasoning attribution).
export function countsToTokens({ chars, cjk }, ctp) {
  if (chars === 0) return 0;
  if (cjk === 0) return chars / ctp.ascii;
  return (chars - cjk) / ctp.ascii + cjk / ctp.cjk;
}

// All B_rebuild map keys are canonicalized so the same physical file under different path
// representations (./a.js, /cwd/a.js) maps to ONE entry — prevents B inflation from fragmentation (spec §2.3).
export function canonicalizePath(rawPath, cwd) {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd || '/', rawPath);
  return path.normalize(abs);
}

// Sole entry point for all adapter computeUpdate calls. The JSONL allows string OR array-of-parts
// content; array form (multi-part messages) must be collapsed to text-only before parsing, else
// adapters see '' → B stays 0 → false early alerts (spec §2.3 normalizer + invariant 11).
export function extractToolResultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) {
    return block.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

// Bash command parser — detects file-reading AND heredoc-writing commands (spec §2.3).
// Returns { type, path, effectiveCwd, heredocBody? } or null.
// Read types: cat, head, grep-n. Write type: cat-write (heredoc > path).
// Everything else (tail, grep-without-n, npm test, git log, …) → null → residual (safe direction).
export function parseBashFileRead(command) {
  let effectiveCwd = null;
  let cmd = String(command || '').trim();
  // Strip leading comment lines (LLMs emit `# description\nactual_command` — same strip as bashFeature).
  cmd = cmd.replace(LEADING_COMMENT_RE, '').trim();
  if (!cmd) return null;
  // Extract effective cwd from cd prefixes: "cd src && cat file" → effectiveCwd = "src" (last cd wins).
  const cdMatch = cmd.match(/^((?:cd\s+(\S+)\s*&&\s*)+)/);
  if (cdMatch) {
    const cdParts = cdMatch[1].matchAll(/cd\s+(\S+)\s*&&/g);
    for (const part of cdParts) effectiveCwd = part[1];
    cmd = cmd.slice(cdMatch[0].length);
  }
  cmd = cmd.replace(/^(fn\w+\s*&&\s*)+/g, ''); // strip function prefixes

  let m = cmd.match(/^cat\s+(?:-[A-Za-z]*\s*)*['"]?([^\s|;><'"]+)/);
  if (m && !_hasShellExpansion(m[1])) return { type: 'cat', path: m[1], effectiveCwd };

  m = cmd.match(/^head\s+(?:-[A-Za-z]*\s*\d*\s+)*['"]?([^\s|;><'"]+)/);
  if (m && !_hasShellExpansion(m[1])) return { type: 'head', path: m[1], effectiveCwd };

  // tail → not matched (line numbers unknown → residual, safe direction).

  m = cmd.match(/^(grep|rg)\s+(.*)/);
  if (m) {
    const hasLineNum = /(?:^|\s)-[A-Za-z]*n/.test(m[2]);
    if (!hasLineNum) return null; // grep without -n: no line numbers → skip
    // Strip quoted strings first so that \| inside patterns isn't mistaken for a pipe,
    // and spaces inside patterns don't pollute the token split.
    const bare = _stripQuotedStrings(m[2]);
    // Now split on real pipe operators and take the first stage.
    const firstStage = bare.split('|')[0];
    // Strip all redirections (>/dev/null, 2>&1, 1>out, >>file).
    const tokens = firstStage.replace(/\s*\d*>{1,2}.*$/, '').trim().split(/\s+/).filter(Boolean);
    let path = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.startsWith('-')) continue; // skip flags (--include, -r, etc.)
      if (/[./]/.test(t)) { path = t; break; }
      break; // first non-flag from the end without . or / → no path found
    }
    if (path && !_isUnresolvablePath(path)) return { type: 'grep-n', path, effectiveCwd };
  }

  // Heredoc write: cat <<'MARKER' > path  (content lives in command, not in tool_result)
  // Match only the first line of cmd (no /m) to avoid body-line false matches.
  const heredocMatch = cmd.split('\n')[0].match(/^cat\s+<<-?\s*['"]?([\w-]+)['"]?\s*>\s*['"]?([^\s'"]+)['"]?\s*$/);
  if (heredocMatch) {
    const marker = heredocMatch[1];
    const writePath = heredocMatch[2];
    if (_hasShellExpansion(writePath)) return null;
    // Extract heredoc body: lines between the first line and the EOF marker
    const allLines = String(command || '').split('\n');
    // Find the line containing the heredoc redirect (skip cd preamble lines)
    let startIdx = 0;
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].includes('<<') && allLines[i].includes(marker)) { startIdx = i; break; }
    }
    let endIdx = -1;
    for (let i = startIdx + 1; i < allLines.length; i++) {
      if (allLines[i].trim() === marker) { endIdx = i; break; }
    }
    if (endIdx < 0) return null; // unterminated heredoc — can't determine body
    const heredocBody = allLines.slice(startIdx + 1, endIdx).join('\n');
    return { type: 'cat-write', path: writePath, effectiveCwd, heredocBody };
  }

  return null;
}

// Strip single- and double-quoted strings from a shell command fragment so that
// pattern content (which may contain spaces, /, and .) doesn't pollute path detection.
function _stripQuotedStrings(s) {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) break; // unterminated: discard remainder (conservative)
      i = end + 1;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      if (j >= s.length) break; // unterminated: discard remainder (conservative)
      i = j + 1;
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

// Detect shell expansions / unresolvable patterns in cat/head paths.
function _hasShellExpansion(p) {
  if (/\$[({A-Za-z_]|`/.test(p) || p.startsWith('~')) return true;
  if (/[*?]/.test(p)) return true; // unexpanded glob
  return false;
}

// Detect grep path candidates that would produce phantom B_rebuild entries.
function _isUnresolvablePath(p) {
  if (p.includes('$(') || p.includes('`') || p.startsWith('~')) return true;
  if (/[*?]/.test(p)) return true;         // unexpanded glob
  if (p === '.' || p === '/') return true;  // directory-only, not a specific file
  if (p === '/dev/null') return true;
  return false;
}

// Adapter registry (spec §2.3). Ordered array; first match wins; no match → residual.
// Each computeUpdate is called ONLY after tool_result confirms success (is_error=false).
// ctp is passed explicitly (not a module global) so the same registry serves any session's CTP.
export const BUILTIN_ADAPTERS = [
  {
    name: 'Read',
    match: (name) => name === 'Read',
    extractPath: (input, cwd) => (input.file_path ? canonicalizePath(input.file_path, cwd) : null),
    computeUpdate: (input, result, cwd, ctp) => {
      if (result.length < 100 && !result.includes('\n')) return null; // wasted call (harness hint)
      const lineEntries = [];
      for (const physicalLine of result.split('\n')) {
        const m = physicalLine.match(/^(\d+)\t/); // parse ACTUAL line-number prefix, not positional index
        if (!m) continue;
        lineEntries.push([Number(m[1]), charsToTokens(physicalLine, ctp)]);
      }
      const requestedFull = input.offset == null && input.limit == null;
      const looksComplete = lineEntries.length > 0 && !/(truncated|use offset|too large)/i.test(result.slice(-200));
      const isFullRead = requestedFull && looksComplete;
      const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Read;
      return { type: isFullRead ? 'fullSet' : 'lineUpdate', lines: lineEntries, overhead: TOOL_OVERHEAD.Read, spent };
    },
  },
  {
    name: 'Write',
    match: (name) => name === 'Write',
    extractPath: (input, cwd) => (input.file_path ? canonicalizePath(input.file_path, cwd) : null),
    computeUpdate: (input, _result, _cwd, ctp) => {
      const rawLines = String(input.content ?? '').split('\n');
      // Write content is raw; a future Read returns it with "N\t" prefix. Pre-compute Read-equivalent tokens.
      const lineEntries = rawLines.map((l, i) => [i + 1, charsToTokens(String(i + 1) + '\t' + l, ctp)]);
      const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Write;
      return { type: 'write', lines: lineEntries, overhead: TOOL_OVERHEAD.Write, spent };
    },
  },
  {
    name: 'Edit',
    match: (name) => name === 'Edit',
    extractPath: (input, cwd) => (input.file_path ? canonicalizePath(input.file_path, cwd) : null),
    // Edit returns editDelta (token difference), NOT fullSet — it has no independent overhead because the
    // framing cost is already captured by the subsequent Read that re-reads the file (TOOL_OVERHEAD.Edit
    // exists in constants for documentation/future use but is intentionally not charged here to avoid
    // double-counting with the corrective Read that follows most Edits).
    computeUpdate: (input, _result, _cwd, ctp) => {
      const tokenDelta = charsToTokens(input.new_string ?? '', ctp) - charsToTokens(input.old_string ?? '', ctp);
      const lineDelta = ((input.new_string ?? '').match(/\n/g) || []).length
                      - ((input.old_string ?? '').match(/\n/g) || []).length;
      const spent = charsToTokens(input.old_string ?? '', ctp) + charsToTokens(input.new_string ?? '', ctp) + TOOL_OVERHEAD.Edit;
      return { type: 'editDelta', value: tokenDelta + lineDelta * (4 / ctp.ascii), spent };
    },
  },
  {
    name: 'Grep',
    match: (name) => name === 'Grep',
    extractPath: () => null, // multi-file: handled inside computeUpdate
    computeUpdate: (_input, result, cwd, ctp) => {
      const files = {};
      for (const line of result.split('\n')) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        const [, rawPath, lineNum, content] = m;
        const canon = canonicalizePath(rawPath, cwd);
        (files[canon] ||= []).push([parseInt(lineNum, 10), charsToTokens(String(lineNum) + '\t' + content, ctp)]);
      }
      let spent = TOOL_OVERHEAD.Grep;
      for (const entries of Object.values(files)) spent += entries.reduce((s, [, t]) => s + t, 0);
      return { type: 'grepMultiFile', files, overhead: TOOL_OVERHEAD.Grep, spent };
    },
  },
  {
    name: 'Bash',
    match: (name) => name === 'Bash',
    extractPath: (input, cwd) => {
      const parsed = parseBashFileRead(input.command);
      if (!parsed) return null;
      // Resolve effectiveCwd relative to the session's cwd (not process.cwd()) — a relative
      // effectiveCwd like 'src' must anchor to the transcript's working directory.
      const base = parsed.effectiveCwd
        ? canonicalizePath(parsed.effectiveCwd, cwd)
        : cwd;
      return canonicalizePath(parsed.path, base);
    },
    computeUpdate: (input, result, _cwd, ctp) => {
      const parsed = parseBashFileRead(input.command);
      if (!parsed) return null;
      const lines = result.split('\n');
      if (parsed.type === 'cat') {
        const lineEntries = lines.map((l, i) => [i + 1, charsToTokens(l, ctp)]);
        const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Bash;
        return { type: 'fullSet', lines: lineEntries, overhead: TOOL_OVERHEAD.Bash, spent };
      }
      if (parsed.type === 'head') {
        const lineEntries = lines.map((l, i) => [i + 1, charsToTokens(l, ctp)]);
        const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Bash;
        return { type: 'lineUpdate', lines: lineEntries, overhead: TOOL_OVERHEAD.Bash, spent };
      }
      if (parsed.type === 'grep-n') {
        const lineEntries = [];
        for (const line of lines) {
          const m = line.match(/^(\d+):(.*)$/);
          if (!m) continue;
          lineEntries.push([parseInt(m[1], 10), charsToTokens(m[2], ctp)]);
        }
        if (lineEntries.length === 0) return null; // multi-file output (file:line:content) or no matches → no phantom
        const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Bash;
        return { type: 'lineUpdate', lines: lineEntries, overhead: TOOL_OVERHEAD.Bash, spent };
      }
      if (parsed.type === 'cat-write') {
        // Heredoc write: content is in the command (parsed.heredocBody), not in tool_result.
        // Token flow identical to Write tool — use Write overhead.
        const bodyLines = parsed.heredocBody.split('\n');
        const lineEntries = bodyLines.map((l, i) => [i + 1, charsToTokens(String(i + 1) + '\t' + l, ctp)]);
        const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Write;
        return { type: 'write', lines: lineEntries, overhead: TOOL_OVERHEAD.Write, spent };
      }
      return null;
    },
  },
  {
    name: 'Skill',
    match: (name) => name === 'Skill',
    extractPath: (input) => 'skill:' + input.skill,
    computeUpdate: (_input, result, _cwd, ctp) => {
      const tokens = charsToTokens(result, ctp);
      return { type: 'fullSet', lines: [[1, tokens]], overhead: TOOL_OVERHEAD.Read, spent: tokens + TOOL_OVERHEAD.Read };
    },
  },
];

export function matchAdapter(toolName) {
  return BUILTIN_ADAPTERS.find(a => a.match(toolName)) || null;
}

// Sparse per-path B_rebuild map (spec §2.3). Observed lines have exact token values; unobserved lines
// are absent (contribute 0 → safe direction). Overlap = overwrite. Update is always O(1) per line.
export class BRebuild {
  constructor() {
    this.dead = 0;          // segment first-call anchor: max(cacheRead, cacheCreation, input); set by foldCall
    this.paths = new Map(); // canonPath → { lines: Map<lineNum,tokens>, total, editDelta, overhead, correction, lastActiveTurn }
    this._totalSpent = new Map();  // path → cumulative tokens injected into L by all ops (display/analysis only)
    this._totalSpentReasoning = new Map(); // §2.4 reasoning attribution (SEPARATE ledger — can be dropped wholesale on drift)
    this._touchSeqs = new Map();   // path → [{seq, mode}, …] for history-chart multi-marker (mode: 'r'|'w')
    this._readCount = new Map();   // path → # of read-like ops (fullSet/lineUpdate/grep)
    this._editCount = new Map();   // path → # of edit-like ops (editDelta / write)
    this._pureRereads = new Map();            // path → count of fullSet-without-intermediate-edit re-reads
    this._hasFullSnapshot = new Map();        // path → bool
    this._editedSinceFullSnapshot = new Map();// path → bool
  }

  setDead(v) { this.dead = v; }

  // §2.4 reasoning attribution (display-only, SEPARATE ledger so it can be dropped wholesale on drift).
  addReasoningSpent(path, tokens) {
    if (path == null || !(tokens > 0)) return;
    this._totalSpentReasoning.set(path, (this._totalSpentReasoning.get(path) || 0) + tokens);
  }

  // Reversible degrade (provider safety): zero the reasoning ledger entirely → content-only totals.
  dropReasoningSpent() { this._totalSpentReasoning.clear(); }

  // Sum of both ledgers for one path (used by snapshot).
  _spentFor(path) {
    return (this._totalSpent.get(path) || 0) + (this._totalSpentReasoning.get(path) || 0);
  }

  // Sum of _spentFor across all tracked paths (used by foldCall drift breaker).
  snapshotTotalSpentSum() {
    let s = 0;
    for (const path of this.paths.keys()) s += this._spentFor(path);
    return s;
  }

  // Sum of ONLY reasoning spend across all paths (§2.4 drift breaker comparator).
  // Reasoning tokens never enter L (physical invariant), so this sum alone — not content — is the
  // correct signal for drift detection. Content-spent is cumulative and legitimately exceeds
  // instantaneous L in any high-churn session.
  totalReasoningSpentSum() {
    let s = 0;
    for (const [, v] of this._totalSpentReasoning) s += v;
    return s;
  }

  _ensure(path) {
    let e = this.paths.get(path);
    if (!e) { e = { lines: new Map(), total: 0, editDelta: 0, overhead: 0, correction: 0, lastActiveTurn: 0, lastActiveCallSeq: 0 }; this.paths.set(path, e); }
    return e;
  }

  _setLine(e, lineNum, tokens) {
    const old = e.lines.get(lineNum) || 0;
    e.lines.set(lineNum, tokens);
    e.total += tokens - old; // incremental total maintenance
  }

  _pushTouch(path, callSeq, mode) {
    const arr = this._touchSeqs.get(path) || [];
    arr.push({ seq: callSeq, mode });
    if (arr.length > 128) arr.splice(0, arr.length - 64);
    this._touchSeqs.set(path, arr);
  }

  apply(update, path, turn, callSeq) {
    if (!update) return;
    if (update.type === 'grepMultiFile') {
      // Per-invocation framing overhead is charged ONCE across all files hit (not per-file),
      // preventing B inflation on broad greps. Distribute evenly so pathTotal sums correctly.
      const fileCount = Object.keys(update.files).length || 1;
      const perFileOverhead = update.overhead / fileCount;
      // §2.2 churn (display-only): distribute spent by each file's ACTUAL injected share.
      // perFileInjected = sum(file line tokens) + perFileOverhead. Even-split (spent/fileCount) is WRONG:
      // a 300-token file getting spent/2 could land below its own tokens → churn < 1 (invariant 3 break).
      const perFileInjected = {};
      let totalInjected = 0;
      for (const [p, entries] of Object.entries(update.files)) {
        const fileTokens = entries.reduce((s, [, t]) => s + t, 0) + perFileOverhead;
        perFileInjected[p] = fileTokens;
        totalInjected += fileTokens;
      }
      for (const [p, entries] of Object.entries(update.files)) {
        const e = this._ensure(p);
        for (const [ln, tok] of entries) this._setLine(e, ln, tok);
        e.overhead = perFileOverhead;
        e.lastActiveTurn = turn;
        if (callSeq != null) e.lastActiveCallSeq = callSeq;
        if (update.spent != null && update.spent > 0 && totalInjected > 0) {
          const share = update.spent * (perFileInjected[p] / totalInjected);
          this._totalSpent.set(p, (this._totalSpent.get(p) || 0) + share);
        }
        this._readCount.set(p, (this._readCount.get(p) || 0) + 1);
        if (callSeq != null) this._pushTouch(p, callSeq, 'r');
      }
      return;
    }
    if (path == null) return;
    const e = this._ensure(path);
    // §2.3 pure-reread detection (Task 6): edit-like ops set the edited flag; fullSet checks it BEFORE resetting.
    if (update.type === 'editDelta' || update.type === 'write') {
      this._editedSinceFullSnapshot.set(path, true);
    }
    if (update.type === 'fullSet') {
      const hasSnapshot = this._hasFullSnapshot.get(path);
      const editedSince = this._editedSinceFullSnapshot.get(path) === true;
      const contentTokens = update.lines.reduce((s, [, t]) => s + t, 0);
      if (hasSnapshot && !editedSince && contentTokens > 0) {
        this._pureRereads.set(path, (this._pureRereads.get(path) || 0) + 1);
      }
      this._hasFullSnapshot.set(path, true);
      this._editedSinceFullSnapshot.set(path, false);
    }
    if (update.type === 'write') {
      this._hasFullSnapshot.set(path, true);
      // editedSinceFullSnapshot already set to true above at line 357-358
    }
    if (update.type === 'fullSet' || update.type === 'write') {
      e.lines.clear(); e.total = 0; e.editDelta = 0; e.correction = 0; // full reset (spec §2.3): re-Read corrects drift; correction resets (new data, new opportunity)
      for (const [ln, tok] of update.lines) this._setLine(e, ln, tok);
      e.overhead = update.overhead;
    } else if (update.type === 'lineUpdate') {
      for (const [ln, tok] of update.lines) this._setLine(e, ln, tok);
      e.overhead = update.overhead;
    } else if (update.type === 'editDelta') {
      e.editDelta += update.value; // unlocalized; next Read/Write resets it (spec §2.3 Edit delta behavior)
    }
    e.lastActiveTurn = turn;
    if (callSeq != null) e.lastActiveCallSeq = callSeq;
    // §2.2 churn accumulation (display/analysis only — never affects B/g/ΔResidual).
    if (update.spent != null && update.spent > 0) {
      this._totalSpent.set(path, (this._totalSpent.get(path) || 0) + update.spent);
    }
    if (update.type === 'editDelta' || update.type === 'write') {
      this._editCount.set(path, (this._editCount.get(path) || 0) + 1);
    } else {
      this._readCount.set(path, (this._readCount.get(path) || 0) + 1);
    }
    if (callSeq != null) {
      const mode = (update.type === 'editDelta' || update.type === 'write') ? 'w' : 'r';
      this._pushTouch(path, callSeq, mode);
    }
  }

  pathTotal(path) {
    const e = this.paths.get(path);
    if (!e) return 0;
    return Math.max(0, e.total + e.editDelta + e.overhead - e.correction); // clamp: repeated deletes never drive B negative
  }

  // CTP overshoot correction (§2.5): when ΔB > ΔL, distribute the overshoot as a per-path
  // correction proportional to each path's contribution. Called by foldCall after detecting overshoot.
  addCorrection(path, amount) {
    const e = this.paths.get(path);
    if (e) e.correction += amount;
  }

  B() {
    let sum = this.dead;
    for (const path of this.paths.keys()) sum += this.pathTotal(path);
    return sum;
  }

  // Lightweight alternative to snapshot() for callers that only need path+tokens.
  // Skips churn/efficiency/readCount/editCount/touchSeqs/pureRereads computation entirely.
  pathTokenPairs() {
    const out = [];
    for (const [path, e] of this.paths) {
      const tokens = Math.max(0, e.total + e.editDelta + e.overhead - e.correction);
      if (tokens > 0) out.push({ path, tokens });
    }
    return out;
  }

  snapshot() {
    const out = [];
    for (const [path, e] of this.paths) {
      const tokens = Math.max(0, e.total + e.editDelta + e.overhead - e.correction);
      if (tokens > 0) {
        // Clamp totalSpent >= tokens (invariant 3: churn >= 1, efficiency <= 100). A first observation
        // (no accumulated spent yet) defaults to tokens → churn exactly 1. Rounding drift or an under-
        // reported spent can never drive churn below 1 or efficiency above 100.
        const totalSpent = Math.max(tokens, Math.round(this._spentFor(path) || tokens));
        const churn = totalSpent / tokens;                 // tokens > 0 guaranteed by the gate above
        const efficiency = Math.round(tokens / totalSpent * 100);
        out.push({
          path, tokens, lastActiveTurn: e.lastActiveTurn, lastActiveCallSeq: e.lastActiveCallSeq,
          totalSpent, churn, efficiency,
          readCount: this._readCount.get(path) || 0,
          editCount: this._editCount.get(path) || 0,
          touchSeqs: this._touchSeqs.get(path) || [],
          pureRereads: this._pureRereads.get(path) || 0,
        });
      }
    }
    return out;
  }

  clear() {
    this.paths.clear();
    this._totalSpent.clear();
    this._totalSpentReasoning.clear();
    this._touchSeqs.clear();
    this._readCount.clear();
    this._editCount.clear();
    this._pureRereads.clear();
    this._hasFullSnapshot.clear();
    this._editedSinceFullSnapshot.clear();
    // dead is intentionally preserved (domain contract) — do not reset it here.
  }
}

// ΔResidual = ΔL − ΔB (spec §2.4). ΔResidual<0 is physically impossible (B ⊆ L); a negative value is
// CTP estimation error (charsToTokens overestimated ΔB). Clamp to 0 (safe: g stays ≥ floor → no delayed
// warnings) and accumulate the overshoot for the dashboard calibration hint.
export function applyResidual(deltaL, deltaB) {
  const raw = deltaL - deltaB;
  return raw >= 0 ? { residual: raw, overshoot: 0 } : { residual: 0, overshoot: -raw };
}

// Smoothed EMA of ΔResidual (α=0.12, window ≈ 8 turns). Raw — the floor is applied at read time via gEffective.
export function emaStep(prevG, residual, alpha = ALPHA_EMA) {
  return alpha * residual + (1 - alpha) * prevG;
}

// g_effective = max(g_ema, G_FLOOR): prevents dhat=0 division and gives cold-start silence (spec §2.4).
export function gEffective(gEma, floor = G_FLOOR) {
  return Math.max(Number.isFinite(gEma) ? gEma : floor, floor);
}

// ─── Display-name extraction + redaction (Task 0b) ───────────────────────────

/**
 * Privacy scrubbing for display/clipboard. Applied as defense-in-depth over server extraction.
 * Masks: env secrets, CLI token flags, Bearer tokens, HTTP basic-auth, home paths, user@ip.
 */
export function redactCmd(cmd) {
  return String(cmd)
    .replace(/\b[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)\s*=\s*\S+/gi, (m) => m.split('=')[0] + '=***')
    .replace(/(--?(?:token|api[-_]?key|password|pass|secret)[=\s]+)\S+/gi, '$1***')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 ***')
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
    .replace(/\/(home|Users|root)\/[^/\s]+/g, '~')
    .replace(/\b\w+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***@<ip>');
}

/**
 * Prettify an MCP tool name for bucket-panel display.
 * mcp__serena__find_symbol → "serena find_symbol"
 * mcp__plugin_playwright_playwright__browser_evaluate → "playwright browser_evaluate"
 * Non-MCP names (e.g. "Read") pass through unchanged.
 */
export function mcpDisplay(toolName) {
  if (!toolName || !toolName.startsWith('mcp__')) return toolName;
  let name = toolName.slice(5); // strip leading "mcp__"
  // Drop "plugin_" prefix segment (e.g. "plugin_playwright_playwright__..." → "playwright_playwright__...")
  name = name.replace(/^plugin_/, '');
  // Split on __ to get segments
  const segments = name.split('__');
  // Deduplicate repeated first segment (e.g. "playwright_playwright" → "playwright")
  if (segments.length > 0) {
    const firstSeg = segments[0];
    // Find if the segment contains a repeated name (could be hyphenated)
    const halfLen = Math.floor(firstSeg.length / 2);
    for (let len = halfLen + 1; len >= 2; len--) {
      const candidate = firstSeg.slice(0, len);
      // Check if the rest starts with _ + candidate or is exactly _candidate
      const remainder = firstSeg.slice(len);
      if (remainder === '_' + candidate) {
        segments[0] = candidate;
        break;
      }
    }
  }
  return segments.join(' ');
}

// Matches one or more leading lines that are shell comments (including shebangs).
const LEADING_COMMENT_RE = /^(\s*#[^\n]*(\n|$))+/;

/**
 * Extract a safe display name from a raw Bash command.
 * Returns { name, detail } — both capped to 40 chars, secrets redacted.
 * The raw command with its args NEVER crosses the wire; only name+detail are sent to the client.
 */
export function bashFeature(command) {
  if (!command || !String(command).trim()) return { name: '(bash)', detail: '' };
  let cmd = String(command).trim();

  // Strip leading comment lines (LLMs sometimes emit `# description\nactual_command`)
  cmd = cmd.replace(LEADING_COMMENT_RE, '').trim();
  if (!cmd) return { name: '(bash)', detail: '' };

  // Take only first pipeline stage
  cmd = cmd.split('|')[0].trim();

  // Strip source preamble: "source ~/.bashrc; ..."
  cmd = cmd.replace(/^source\s+\S+\s*;\s*/i, '');

  // Strip cd preambles: "cd /path && ..."
  cmd = cmd.replace(/^(cd\s+\S+\s*&&\s*)+/g, '');

  // Strip fn\w+ && preambles: "fn22 && ..."
  cmd = cmd.replace(/^(fn\w+\s*&&\s*)+/g, '');

  // Strip all leading wrappers (nested: `sudo env time cmd` → `cmd`)
  while (/^(sudo|env|time|nohup)\s+/.test(cmd)) cmd = cmd.replace(/^(sudo|env|time|nohup)\s+/, '');

  // Strip ALL leading VAR=val env prefixes AFTER wrappers (so `env VAR=val cmd` works)
  cmd = cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');

  cmd = cmd.trim();
  if (!cmd) return { name: '(bash)', detail: '' };

  // Strip comment lines again (may be exposed after VAR=val removal: `VAR=x\n# desc\ncmd`)
  cmd = cmd.replace(LEADING_COMMENT_RE, '').trim();
  if (!cmd) return { name: '(bash)', detail: '' };

  // Split into tokens (respecting heredocs: only take the first line)
  const firstLine = cmd.split('\n')[0];
  const tokens = firstLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length === 0) return { name: '(bash)', detail: '' };

  const tool = tokens[0];

  // If tool contains / or = → fallback to (script)
  if (tool.includes('/') || tool.includes('=')) {
    return { name: '(script)', detail: '' };
  }

  // For git: skip -C flag+arg, then get subcommand
  let name;
  let argsStart;
  if (tool === 'git') {
    let i = 1;
    // skip flags like -C <arg>
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '-C' || tokens[i] === '-c') {
        i += 2; // skip flag and its argument
      } else {
        break;
      }
    }
    const sub = i < tokens.length ? tokens[i] : '';
    name = sub ? `git ${sub}` : 'git';
    argsStart = i + 1;
  } else if (tool === 'bash' || tool === 'sh') {
    // bash scripts/deploy.sh → bash deploy.sh (basename)
    const script = tokens[1] || '';
    const basename = script.includes('/') ? script.split('/').pop() : script;
    name = basename ? `${tool} ${basename}` : tool;
    argsStart = 2;
  } else if ((tool === 'npm' || tool === 'pnpm' || tool === 'yarn') && tokens.length > 1) {
    // npm run deploy → npm run; but include colon subcommands like test:client
    const sub = tokens[1] || '';
    if (sub.startsWith('-')) {
      name = tool;
      argsStart = 1;
    } else {
      name = `${tool} ${sub}`;
      argsStart = 2;
    }
  } else if (tool === 'docker' && tokens.length > 1 && !tokens[1].startsWith('-')) {
    name = `${tool} ${tokens[1]}`;
    argsStart = 2;
  } else {
    // Generic: tool + first non-flag token as subcommand (only for known multi-subcommand tools)
    // For most tools, just use the tool name
    name = tool;
    argsStart = 1;
  }

  // Cap name to 40 chars
  if (name.length > 40) name = name.slice(0, 40);

  // Extract detail: URL host or first bare positional arg
  let detail = '';
  const remaining = tokens.slice(argsStart);
  for (const arg of remaining) {
    // Skip flags
    if (arg.startsWith('-')) continue;
    // Check for URL
    const urlMatch = arg.match(/^https?:\/\/([^/\s:@]+)/);
    if (urlMatch) {
      detail = urlMatch[1];
      break;
    }
    // First bare positional
    if (!arg.startsWith('$') && !arg.startsWith('"') && !arg.startsWith("'")) {
      detail = arg;
      break;
    }
  }

  // Pass detail through redactCmd
  detail = redactCmd(detail);

  // Cap detail to 40 chars
  if (detail.length > 40) detail = detail.slice(0, 40);

  return { name, detail };
}
