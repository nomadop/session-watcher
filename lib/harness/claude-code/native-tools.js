// lib/harness/claude-code/native-tools.js — Claude Code native tool interpretation.
// The only place a native tool name, its input shape, and its result text become Measurement facts:
// resident-content effects, residual evidence candidates, and path telemetry. Everything it returns is
// numbers, opaque keys, and JSON-compatible metadata. The exception is the Projection-local
// correlation the Projection hands straight back here, which carries the native input object and the
// registry adapter this module selected for it.
//
// It reaches the filesystem only through the path capabilities its context supplies, so the module can be
// driven with any path implementation and holds no ambient directory of its own.

import { TOOL_OVERHEAD } from '../../constants.js';
import { charsToTokens } from '../../token-estimate.js';
import {
  isSerenaError,
  parseSerenaFindSymbol,
  parseSerenaReferencing,
  parseSerenaPlainText,
} from '../../serena-parse.js';

// Matches one or more leading lines that are shell comments (including shebangs).
const LEADING_COMMENT_RE = /^(\s*#[^\n]*(\n|$))+/;
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/;
const TASK_SUMMARY_RE = /<summary>([^<]*)<\/summary>/;
const AGENT_FINISHED_RE = /^Agent "(.+)" finished$/;
const TASK_ID_PREFIX_CHARS = 8;
const DISPLAY_CHARS = 40;

// ─── Path canonicalization ───────────────────────────────────────────────────

// One physical file reached under several spellings (./a.js, /cwd/a.js) must land on one resource key, or
// the resident total counts it twice. The capability comes from the context so this module imports no
// path or home-directory implementation of its own; a non-string target propagates its own TypeError,
// which the caller reads as a target-resolution failure.
function canonicalizerFor(context) {
  const ops = context && context.path;
  // With no path capability the keys are discarded after use — classification reads a result's shape, not
  // which files it names — so the raw spelling is its own key.
  if (!ops) return raw => String(raw);
  const homedir = context.homedir;
  return (raw, base) => {
    let value = raw;
    if (value === '~' || value.startsWith('~/')) value = ops.join(homedir(), value.slice(1));
    const abs = ops.isAbsolute(value) ? value : ops.resolve(base || '/', value);
    return ops.normalize(abs).split('\\').join('/');
  };
}

// Precedence: the row's own working directory, then the immutable session directory or project root, then
// the directory the transcript itself lives in. Resolved once, when the tool use arrives.
function baseDirFor(observation, context) {
  if (typeof observation.cwd === 'string' && observation.cwd.length > 0) return observation.cwd;
  if (typeof context.sessionCwd === 'string' && context.sessionCwd.length > 0) return context.sessionCwd;
  return context.transcriptDir ?? null;
}

// ─── Result text ─────────────────────────────────────────────────────────────

// A native result carries string content OR an array of parts. The array form must collapse to text
// before any adapter parses it, or every adapter sees the empty string and the resource stays unknown.
function resultTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

// ─── Bash command parsing ────────────────────────────────────────────────────

// Peels the leading segments that produce no locatable bytes of their own. A cd changes what the target
// resolves against; the last cd wins, resolved against the row's base path. A one-argument echo prints
// its argument as a line of its own ahead of the real command's output, so that line is known and can be
// dropped from the result. An echo with flags, several arguments, an argument spanning lines or an
// expandable argument is not a preamble — its output is unknowable — and stays part of the command.
const CD_PREAMBLE_RE = /^cd\s+(\S+)\s*(?:&&|;)\s*/;
const ECHO_PREAMBLE_RE = /^echo\s+("[^"$`\\\n]*"|'[^'\n]*'|[^\s"'$`;&|<>]+)\s*(?:&&|;)\s*/;
const FN_PREAMBLE_RE = /^fn\w+\s*&&\s*/;
function stripShellPreamble(command) {
  let rest = String(command || '').trim().replace(LEADING_COMMENT_RE, '').trim();
  let effectiveCwd = null;
  let headerLines = 0;
  for (;;) {
    let m = rest.match(CD_PREAMBLE_RE);
    if (m) { effectiveCwd = m[1]; rest = rest.slice(m[0].length); continue; }
    m = rest.match(ECHO_PREAMBLE_RE);
    if (m) { headerLines += 1; rest = rest.slice(m[0].length); continue; }
    m = rest.match(FN_PREAMBLE_RE);
    if (m) { rest = rest.slice(m[0].length); continue; }
    return { rest, effectiveCwd, headerLines };
  }
}

// A locatable read is the whole command. A further command after `;` or `&&`, or a further line, appends
// bytes the first command's shape does not describe, and a path token in that segment would be taken for
// the read's own — either way the content lands on a resource that never held it. Quoted text is removed
// first so a separator inside a pattern does not count.
function hasTrailingSegment(cmd) {
  if (cmd.includes('\n')) return true;
  return /;|&&/.test(stripQuotedStrings(cmd));
}

// A range read carries its own line numbers in the command: the spec's segments, taken in file order,
// name the source line of every line the read printed. The prefix form is what the compound path's width
// guard reads; the whole-command form additionally requires the path, and past the path admits one tail,
// `| cat -n`, which renumbers the lines it forwards and drops none. A `2>/dev/null` discard reaches the
// anchor too, removed by `STDERR_DISCARD_RE` ahead of the match. Any other tail computes over the bytes
// and any other redirect sends them where the result does not show them, so those the anchor still
// refuses. The separators the spec class admits are the branch's own business: it calls
// `hasTrailingSegment` as every other read shape does.
const SED_READ_RE = /^sed\s+-n\s+(?:-e\s+)?(['"]?)([\d,$p;\s]+)\1\s+([^\s|;><&'"]+)\s*(\|\s*cat\s+-n\s*)?$/;
const SED_SPEC_PREFIX_RE = /^sed\s+-n\s+(?:-e\s+)?(['"]?)([\d,$p;\s]+)\1\s/;
const SED_SEGMENT_RE = /^(\d+)(?:,(\d+|\$))?p$/;
// A `cat` source and a `sed -n` spec: every line sed received stands for one source line, in file order,
// so the spec still names the source line of each line sed printed. The flag class admits flags that
// change what a line holds while keeping that correspondence; `-s`, which squeezes runs of blank lines
// into one, breaks it and is carried in `BASH-READ-KEY-FIDELITY`.
const SED_CAT_PIPE_RE = /^cat\s+(?:-[A-Za-z]*\s*)*['"]?([^\s|;><'"]+)['"]?\s*\|\s*sed\s+-n\s+(?:-e\s+)?(['"]?)([\d,$p;\s]+)\2\s*$/;
// A discarded stderr adds nothing to stdout, so it changes nothing about the output's structure.
const STDERR_DISCARD_RE = /\s+2>\s*\/dev\/null$/;
// A `sed -n` range with no path only drops whole lines: every line that survives it is unchanged, so a
// stage that numbered its lines still describes where they came from.
const SED_LINE_DROP_RE = /^sed\s+-n\s+(?:-e\s+)?(['"]?)[\d,$p;\s]+\1$/;

// `a,bp;c,dp;ep` → [{ start, end }] in file order, `end` null for `$`. Null refuses the spec: a segment
// this rule cannot read, a range that ends before it starts, an open end beside any other segment — the
// overlap loop below compares `end` numerically, so this rule is what leaves it two numbers, a null end
// comparing false against an overlapping successor — or overlapping segments, whose shared lines sed
// prints once per matching `p`, so the output is not the segments joined. An open end alone keeps the
// tolerance the shipped anchor has.
function sedSegmentsOf(spec) {
  const parts = String(spec).split(';').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length === 0) return null;
  const segments = [];
  for (const part of parts) {
    const m = part.match(SED_SEGMENT_RE);
    if (!m) return null;
    const start = Number(m[1]);
    if (start < 1) return null;
    const end = m[2] === undefined ? start : m[2] === '$' ? null : Number(m[2]);
    if (end !== null && end < start) return null;
    segments.push({ start, end });
  }
  if (segments.length > 1 && segments.some(s => s.end === null)) return null;
  // sed streams the file once, so the output is in file order whatever order the spec names.
  segments.sort((a, b) => a.start - b.start);
  for (let i = 1; i < segments.length; i++) if (segments[i].start <= segments[i - 1].end) return null;
  return segments;
}

// The count the spec promises, null when a segment runs to end of file and the total is therefore
// unknowable from the command.
function sedPromisedWidth(segments) {
  let width = 0;
  for (const s of segments) { if (s.end === null) return null; width += s.end - s.start + 1; }
  return width;
}

// Output ordinal → source line. Past the last segment the keys continue from its end, which the shipped
// single-range behaviour does too. An open end only ever stands alone, so it consumes the whole count.
function sedLineKeys(segments, count) {
  const keys = [];
  for (const s of segments) {
    const end = s.end === null ? Infinity : s.end;
    for (let line = s.start; line <= end && keys.length < count; line++) keys.push(line);
    if (keys.length >= count) break;
  }
  let next = keys.length ? keys[keys.length - 1] + 1 : 1;
  while (keys.length < count) keys.push(next++);
  return keys;
}

// A multi-segment spec's keys are recoverable only from an output exactly as wide as the spec promised:
// nothing in a short result says which segment came up short, and a shortfall anywhere but the last shifts
// every key after it. Every segment of a multi-segment spec is closed, so the spec's promise is always a
// number to compare against. A single segment carries no such ambiguity, so it keeps the tolerance the
// shipped anchor has, open end included.
function sedKeysFor(segments, printed, count) {
  if (segments.length > 1 && printed !== sedPromisedWidth(segments)) return null;
  return sedLineKeys(segments, count);
}

// Detects the file-reading and heredoc-writing shapes whose output structure is known well enough
// to price a resource. Returns { type, path, effectiveCwd, headerLines, heredocBody?, segments?, numbered? }
// or null. Everything else — tail, grep without -n, a computation pipe, a compound command, a test
// run — answers null and becomes residual evidence, which is the safe direction: a resource is
// never credited with content nobody can locate.
function parseBashFileRead(command) {
  const preamble = stripShellPreamble(command);
  const effectiveCwd = preamble.effectiveCwd;
  const headerLines = preamble.headerLines;
  let cmd = preamble.rest;
  if (!cmd) return null;

  // Only the sed anchors read to end of string, so only they need the redirect removed.
  if (/^sed\s/.test(cmd)) cmd = cmd.replace(STDERR_DISCARD_RE, '');

  // Tried ahead of the cat branch, which reads a sed tail as a computation over the bytes and answers
  // null for the whole command.
  let m = cmd.match(SED_CAT_PIPE_RE);
  if (m && !hasShellExpansion(m[1]) && !hasTrailingSegment(cmd)) {
    const segments = sedSegmentsOf(m[3]);
    if (segments) return { type: 'sed', path: m[1], effectiveCwd, headerLines, segments, numbered: false };
  }

  m = cmd.match(/^cat\s+(?:-[A-Za-z]*\s*)*['"]?([^\s|;><'"]+)/);
  if (m && !hasShellExpansion(m[1])) {
    if (hasTrailingSegment(cmd)) return null;
    const pipeType = classifyPipe(cmd, 'cat');
    if (pipeType === null) return null;
    return { type: pipeType, path: m[1], effectiveCwd, headerLines };
  }

  m = cmd.match(/^head\s+(?:-[A-Za-z]*\s*\d*\s+)*['"]?([^\s|;><'"]+)/);
  if (m && !hasShellExpansion(m[1])) {
    if (hasTrailingSegment(cmd)) return null;
    const pipeType = classifyPipe(cmd, 'head');
    if (pipeType === null) return null;
    return { type: pipeType, path: m[1], effectiveCwd, headerLines };
  }

  m = cmd.match(SED_READ_RE);
  if (m && !hasShellExpansion(m[3])) {
    if (hasTrailingSegment(cmd)) return null;
    const segments = sedSegmentsOf(m[2]);
    if (segments) return { type: 'sed', path: m[3], effectiveCwd, headerLines, segments, numbered: m[4] != null };
  }

  // tail has no line numbers in its output, so the lines it returned cannot be located in the file.

  m = cmd.match(/^(grep|rg)\s+(.*)/);
  if (m) {
    const hasLineNum = /(?:^|\s)-[A-Za-z]*n/.test(m[2]) && !/(?:^|\s)-[A-Za-z]*[clL]/.test(m[2]);
    if (!hasLineNum) return null;
    // Quoted strings go first so an escaped pipe inside a pattern is not read as a pipe operator and a
    // pattern containing spaces or slashes does not pollute the path search.
    const bare = stripQuotedStrings(m[2]);
    const firstStage = bare.split('|')[0];
    const tokens = firstStage.replace(/\s*\d*>{1,2}.*$/, '').trim().split(/\s+/).filter(Boolean);
    let filePath = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.startsWith('-')) continue;
      if (/[./]/.test(t)) { filePath = t; break; }
      break; // the last non-flag token names no file
    }
    if (filePath && !isUnresolvablePath(filePath)) {
      if (hasTrailingSegment(cmd)) return null;
      const pipeType = classifyPipe(cmd, 'grep-n');
      if (pipeType === null) return null;
      return { type: pipeType, path: filePath, effectiveCwd, headerLines };
    }
  }

  // Heredoc write: the written content lives in the command, not in the result.
  const heredocMatch = cmd.split('\n')[0].match(/^cat\s+<<-?\s*['"]?([\w-]+)['"]?\s*>\s*['"]?([^\s'"]+)['"]?\s*$/);
  if (heredocMatch) {
    const marker = heredocMatch[1];
    const writePath = heredocMatch[2];
    if (hasShellExpansion(writePath)) return null;
    const allLines = String(command || '').split('\n');
    let startIdx = 0;
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].includes('<<') && allLines[i].includes(marker)) { startIdx = i; break; }
    }
    let endIdx = -1;
    for (let i = startIdx + 1; i < allLines.length; i++) {
      if (allLines[i].trim() === marker) { endIdx = i; break; }
    }
    if (endIdx < 0) return null; // unterminated: the body has no end, so its size is unknown
    return { type: 'cat-write', path: writePath, effectiveCwd, headerLines, heredocBody: allLines.slice(startIdx + 1, endIdx).join('\n') };
  }

  return null;
}

// ─── Compound Bash reads ─────────────────────────────────────────────────────

// A read chain joined by one-literal `echo` dividers: `sed -n '1,9p' a; echo "=== b ==="; sed -n '4,8p' b`.
// The divider text is known from the command, so the result splits at the lines that print it, and each
// block between dividers is priced only when it holds exactly one read that the single-command shape
// locates on its own. This section is shell syntax and would hold for any host that runs bash;
// `stripHarnessLines` below is the one step that is this host's.
const HEREDOC_RE = /<<-?\s*['"]?\w/;
const CD_SEGMENT_RE = /^cd\s+(\S+)$/;
const BLANK_ECHO_RE = /^echo(?:\s+(?:""|''))?$/;
const DIRECTORY_CHANGE_RE = /^(?:cd|pushd|popd)\b/;
const READ_DIAGNOSTIC_RE = /^(?:cat|head|sed|grep|rg): /;
const ECHO_LITERAL_RE = /^echo\s+(?:"([^"$`\\\n]*)"|'([^'\n]*)'|([^\s"'$`;&|<>]+))$/;
const HEAD_COUNT_RE = /^head\s+(?:-n\s*|-)(\d+)/;
const HEAD_DEFAULT_LINES = 10;

// Top-level split on `;`, `&&`, `||` and newline, quote-aware. A heredoc anywhere makes the command
// opaque: its body lines look like segments and are not.
function splitShellSegments(cmd) {
  if (HEREDOC_RE.test(cmd)) return null;
  const segments = [];
  let current = '';
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) { current += cmd.slice(i); break; }
      current += cmd.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') { if (cmd[j] === '\\') j++; j++; }
      current += cmd.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) { current += cmd.slice(i, i + 2); i += 2; continue; }
    if (ch === '\n' || ch === ';') { segments.push(current); current = ''; i++; continue; }
    if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) { segments.push(current); current = ''; i += 2; continue; }
    current += ch; i++;
  }
  segments.push(current);
  return segments.map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'));
}

// A block is the run of segments between two dividers. Its `command` is its one read segment with the cd
// in force prefixed, or null when the block holds no command or more than one; `lead` and `trail` count
// the bare `echo` segments around the read, each of which prints one known empty line.
function blockOf(items) {
  const commands = items.filter(item => item.kind === 'command');
  if (commands.length !== 1) return { command: null, lead: 0, trail: 0 };
  const at = items.indexOf(commands[0]);
  return { command: commands[0].text, lead: at, trail: items.length - at - 1 };
}

// { anchors: [literal…], blocks: [{ command, lead, trail }] }, or null when the command is not a chain
// with at least one divider.
function parseBashCompound(command) {
  const cmd = String(command || '').trim().replace(LEADING_COMMENT_RE, '').trim();
  const segments = splitShellSegments(cmd);
  if (!segments || segments.length < 2) return null;
  const items = [];
  let cwd = null;
  for (const text of segments) {
    let m;
    if ((m = text.match(CD_SEGMENT_RE))) { cwd = m[1]; continue; }
    // A directory change this rule cannot read would leave every later block keyed against the wrong base.
    if (DIRECTORY_CHANGE_RE.test(text)) return null;
    if (BLANK_ECHO_RE.test(text)) { items.push({ kind: 'blank' }); continue; }
    if ((m = text.match(ECHO_LITERAL_RE))) { items.push({ kind: 'anchor', literal: m[1] ?? m[2] ?? m[3] }); continue; }
    items.push({ kind: 'command', text: cwd ? `cd ${cwd} && ${text}` : text });
  }
  const anchors = items.filter(item => item.kind === 'anchor').map(item => item.literal);
  if (anchors.length === 0) return null;
  const blocks = [];
  let run = [];
  for (const item of items) {
    if (item.kind === 'anchor') { blocks.push(blockOf(run)); run = []; } else run.push(item);
  }
  blocks.push(blockOf(run));
  return { anchors, blocks };
}

// Which result lines the dividers occupy: every literal exactly once as a whole line, in command order.
// A literal seen twice may be a divider or a line of a file, and nothing in the result tells which, so
// the whole call stays residual.
function anchorLinesOf(anchors, lines) {
  const at = [];
  let from = 0;
  for (const literal of anchors) {
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== literal) continue;
      if (hit >= 0) return null;
      hit = i;
    }
    if (hit < from) return null;
    at.push(hit);
    from = hit + 1;
  }
  return at;
}

// The line count a read promises in its command; a block wider than that holds output the read did not
// print.
function promisedLineCount(command) {
  const read = stripShellPreamble(command).rest;
  let m = read.match(SED_SPEC_PREFIX_RE);
  if (m) {
    const segments = sedSegmentsOf(m[2]);
    if (segments) return sedPromisedWidth(segments);
  }
  // A single `|` is not a segment separator, so a `cat FILE | sed -n SPEC` pipeline arrives here as one
  // block. Its spec sits past the pipe rather than at the head of the command, and it promises exactly
  // what the same spec promises in the whole-command form.
  m = read.match(SED_CAT_PIPE_RE);
  if (m) {
    const segments = sedSegmentsOf(m[3]);
    if (segments) return sedPromisedWidth(segments);
  }
  m = read.match(HEAD_COUNT_RE);
  if (m) return Number(m[1]);
  if (/^head\s/.test(read)) return HEAD_DEFAULT_LINES;
  return null;
}

function blockPassesGuards(parsed, content, command) {
  // A chain reports only its last command's status, so an earlier read's failure arrives as that read's one
  // diagnostic line with the error flag unset.
  if (content.length === 1 && READ_DIAGNOSTIC_RE.test(content[0])) return false;
  const promised = promisedLineCount(command);
  if (promised != null && content.length > promised) return false;
  if (parsed.type === 'grep-n') return content.every(line => line === '' || /^\d+:/.test(line));
  return true;
}

// Claude Code's Bash tool writes lines of its own into a result: `Shell cwd was reset to …` last when the
// command changed directory, and a `<persisted-output>` preview in place of output it spilled to a file.
// They come from the harness rather than the shell, which is why this step is the one part of the compound
// path that belongs to this host. (The `Exit code N` first line of a failed command arrives with the error
// flag set, and an errored result is refused whole before any line is read.)
const CWD_RESET_LINE_RE = /^Shell cwd was reset to /;
const PERSISTED_OUTPUT_RE = /^<persisted-output>/;
function stripHarnessLines(lines) {
  if (lines.length && CWD_RESET_LINE_RE.test(lines[lines.length - 1])) lines.pop();
  return lines;
}

// Resolves each block's target when the tool use arrives, as a single read's is. A chain none of whose
// blocks locates a file is residual whole.
function compoundFor(input, base, canon, adapter) {
  const plan = parseBashCompound(input.command);
  if (!plan) return null;
  const blocks = plan.blocks.map(block => {
    let target = null;
    if (block.command !== null) {
      try { target = adapter.extractTarget({ command: block.command }, base, canon); } catch { target = null; }
    }
    return { ...block, target };
  });
  if (!blocks.some(block => block.target !== null)) return null;
  return { anchors: plan.anchors, blocks };
}

// Splits on real pipe operators, respecting quotes and escaped pipes. `null` reports a `||`, whose
// right-hand side may be what actually produced the output.
function splitByPipe(s) {
  const stages = [];
  let current = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      current += s[i++];
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') { current += s[i++]; if (i < s.length) current += s[i++]; continue; }
        current += s[i++];
      }
      if (i < s.length) current += s[i++];
    } else if (s[i] === "'") {
      current += s[i++];
      while (i < s.length && s[i] !== "'") current += s[i++];
      if (i < s.length) current += s[i++];
    } else if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      // Parity of the trailing backslash run decides whether this backslash escapes the pipe or is
      // itself already escaped, in which case the pipe is real.
      let trailingBS = 0;
      for (let k = current.length - 1; k >= 0 && current[k] === '\\'; k--) trailingBS++;
      if (trailingBS % 2 === 1) {
        i++;
        const trimmed = current.trim();
        if (trimmed) stages.push(trimmed);
        current = '';
        i++;
      } else {
        current += s[i++]; current += s[i++];
      }
    } else if (s[i] === '|' && i + 1 < s.length && s[i + 1] === '|') {
      return null;
    } else if (s[i] === '|') {
      const trimmed = current.trim();
      if (trimmed) stages.push(trimmed);
      current = '';
      i++;
    } else {
      current += s[i++];
    }
  }
  const trimmed = current.trim();
  if (trimmed) stages.push(trimmed);
  return stages;
}

// Does the pipeline preserve the source file's line structure? `head` only truncates, a pathless `sed -n`
// range only drops whole lines, and `grep -n` keeps the `N:content` form, so each leaves the read
// locatable where the surviving lines still say which source line they are; anything that computes over
// the bytes does not.
function classifyPipe(firstCmd, baseType) {
  const allStages = splitByPipe(firstCmd);
  if (allStages === null) return null;
  if (allStages.length < 2) return baseType;

  const pipeStages = allStages.slice(1);
  const pipeTools = pipeStages.map(s => s.trim().split(/\s+/)[0]);

  // `head` drops a tail and a pathless `sed -n` range drops whole lines out of the middle. Both leave the
  // survivors verbatim, so an upstream stage that numbered its lines still says where each one came from —
  // which is why only the `grep-n` outcomes admit it. A `cat`-shaped result is keyed positionally from one,
  // so a line dropped out of its middle would key every survivor to a line it does not occupy, and those
  // outcomes take truncation alone.
  const keepsLines = stage => {
    const trimmed = stage.trim();
    return trimmed.split(/\s+/)[0] === 'head' || SED_LINE_DROP_RE.test(trimmed);
  };

  if (baseType === 'cat') {
    if (pipeTools[0] === 'head' && pipeTools.slice(1).every(t => t === 'head')) return 'head';
    if ((pipeTools[0] === 'grep' || pipeTools[0] === 'rg')
        && /(?:^|\s)-[A-Za-z]*n/.test(pipeStages[0])
        && !/(?:^|\s)-[A-Za-z]*[clL]/.test(pipeStages[0])
        && pipeStages.slice(1).every(keepsLines)) return 'grep-n';
    return null;
  }
  if (baseType === 'head') return pipeTools.every(t => t === 'head') ? 'head' : null;
  if (baseType === 'grep-n') return pipeStages.every(keepsLines) ? 'grep-n' : null;
  return baseType;
}

// Removes quoted runs so pattern content — which may hold spaces, slashes and dots — cannot be mistaken
// for a path. An unterminated quote discards the remainder, the conservative direction.
function stripQuotedStrings(s) {
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) break;
      i = end + 1;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      if (j >= s.length) break;
      i = j + 1;
    } else {
      result += s[i];
      i++;
    }
  }
  return result;
}

// `~/x` is resolvable from the home directory; `~user` and `~+` are not, and a substitution or unexpanded
// glob names whatever the shell produced rather than a file.
function hasShellExpansion(p) {
  if (p === '~' || p.startsWith('~/')) {
    const rest = p.slice(1);
    if (/\$[({A-Za-z_]|`/.test(rest)) return true;
    return /[*?]/.test(rest);
  }
  if (/\$[({A-Za-z_]|`/.test(p) || p.startsWith('~')) return true;
  return /[*?]/.test(p);
}

// A grep path candidate that would create a resource nobody can read back.
function isUnresolvablePath(p) {
  if (p === '~' || p.startsWith('~/')) {
    const rest = p.slice(1);
    if (/\$[({A-Za-z_]|`/.test(rest)) return true;
    return /[*?]/.test(rest);
  }
  if (p.includes('$(') || p.includes('`') || p.startsWith('~')) return true;
  if (/[*?]/.test(p)) return true;
  if (p === '.' || p === '/') return true;   // a directory, not a specific file
  return p === '/dev/null';
}

// ─── Native adapters ─────────────────────────────────────────────────────────

// Ordered registry; first match wins, no match is residual evidence. `extractTarget` runs once when the
// tool use arrives; `computeUpdate` runs only after the result confirms success. Every token value is
// priced with the issuing step's own CTP, passed in rather than held here, so one registry serves any
// model. An update is an intermediate shape: `effectFor` turns it into the Engine's mutation vocabulary.
const NATIVE_ADAPTERS = [
  {
    name: 'Read',
    match: name => name === 'Read',
    extractTarget: (input, base, canon) => (input.file_path ? canon(input.file_path, base) : null),
    computeUpdate: (input, result, base, ctp) => {
      if (result.length < 100 && !result.includes('\n')) return null; // a harness hint, not file content
      const lineEntries = [];
      for (const physicalLine of result.split('\n')) {
        const m = physicalLine.match(/^(\d+)\t/); // the line number the harness printed, not a position
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
    match: name => name === 'Write',
    extractTarget: (input, base, canon) => (input.file_path ? canon(input.file_path, base) : null),
    computeUpdate: (input, _result, _base, ctp) => {
      // Written content is raw; a later Read returns it with an `N\t` prefix, so price the Read-equivalent
      // form now and the two observations of one file agree.
      const rawLines = String(input.content ?? '').split('\n');
      const lineEntries = rawLines.map((l, i) => [i + 1, charsToTokens(String(i + 1) + '\t' + l, ctp)]);
      const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Write;
      return { type: 'write', lines: lineEntries, overhead: TOOL_OVERHEAD.Write, spent };
    },
  },
  {
    name: 'Edit',
    match: name => name === 'Edit',
    extractTarget: (input, base, canon) => (input.file_path ? canon(input.file_path, base) : null),
    // An edit adjusts the total rather than replacing content: it observes no whole file. It charges no
    // framing overhead because the corrective Read that follows most edits charges its own, and charging
    // both would count one framing cost twice.
    computeUpdate: (input, _result, _base, ctp) => {
      const tokenDelta = charsToTokens(input.new_string ?? '', ctp) - charsToTokens(input.old_string ?? '', ctp);
      const lineDelta = ((input.new_string ?? '').match(/\n/g) || []).length
                      - ((input.old_string ?? '').match(/\n/g) || []).length;
      const spent = charsToTokens(input.old_string ?? '', ctp) + charsToTokens(input.new_string ?? '', ctp) + TOOL_OVERHEAD.Edit;
      return { type: 'editDelta', value: tokenDelta + lineDelta * (4 / ctp.ascii), spent };
    },
  },
  {
    name: 'Grep',
    match: name => name === 'Grep',
    extractTarget: () => null, // the files are named by the result, not by the input
    computeUpdate: (_input, result, base, ctp, canon) => {
      // Every key is a filename the result named, and a filename may be any legal string, so the
      // dictionary inherits no member such a key could name.
      const files = Object.create(null);
      for (const line of result.split('\n')) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        const [, rawPath, lineNum, content] = m;
        const key = canon(rawPath, base);
        (files[key] ||= []).push([parseInt(lineNum, 10), charsToTokens(String(lineNum) + '\t' + content, ctp)]);
      }
      let spent = TOOL_OVERHEAD.Grep;
      for (const entries of Object.values(files)) spent += entries.reduce((s, [, t]) => s + t, 0);
      return { type: 'grepMultiFile', files, overhead: TOOL_OVERHEAD.Grep, spent };
    },
  },
  {
    name: 'Bash',
    match: name => name === 'Bash',
    extractTarget: (input, base, canon) => {
      const parsed = parseBashFileRead(input.command);
      if (!parsed) return null;
      // A relative cd target anchors to the row's base path, never to the host process directory.
      const anchor = parsed.effectiveCwd ? canon(parsed.effectiveCwd, base) : base;
      return canon(parsed.path, anchor);
    },
    computeUpdate: (input, result, _base, ctp) => {
      const parsed = parseBashFileRead(input.command);
      if (!parsed) return null;
      const lines = result.split('\n').slice(parsed.headerLines);
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
      if (parsed.type === 'sed') {
        // A result ending in a newline yields a trailing empty line the command never promised, so the
        // width guard reads the printed count without it while the line itself is still keyed, as every
        // positional Bash shape keys it.
        const printed = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        // `cat -n` numbers the lines it forwards from one rather than from the file, so the keys still
        // come from the spec; the prefix it adds is bytes that arrived and is priced with its line. It
        // prefixes every line it forwards, so a printed line without the prefix says the tail did not run
        // over the read's own output. The count above is what separates the trailing empty line a final
        // newline yields — which `cat -n` never printed — from an empty line short of the end, which it
        // could not have printed.
        if (parsed.numbered && !lines.slice(0, printed).every(l => /^\s*\d+\t/.test(l))) return null;
        const keys = sedKeysFor(parsed.segments, printed, lines.length);
        if (!keys) return null;
        const lineEntries = lines.map((l, i) => [keys[i], charsToTokens(l, ctp)]);
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
        // A `file:line:content` output means the match set spans files the single resolved target does not
        // name, so crediting it to that target would invent content it never held.
        if (lineEntries.length === 0) return null;
        const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Bash;
        return { type: 'lineUpdate', lines: lineEntries, overhead: TOOL_OVERHEAD.Bash, spent };
      }
      if (parsed.type === 'cat-write') {
        // The heredoc body flows exactly as a Write's content does, so it carries Write framing.
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
    match: name => name === 'Skill',
    // A skill is a resource without a file: its key is its own namespace, so no base path applies.
    extractTarget: input => 'skill:' + input.skill,
    computeUpdate: (_input, result, _base, ctp) => {
      const tokens = charsToTokens(result, ctp);
      return { type: 'fullSet', lines: [[1, tokens]], overhead: TOOL_OVERHEAD.Read, spent: tokens + TOOL_OVERHEAD.Read };
    },
  },

  // ─── Serena read-like adapters ───────────────────────────────────────────
  {
    name: 'serena_find_symbol',
    match: name => name === 'mcp__serena__find_symbol',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    computeUpdate: (input, result, base, ctp, canon) => {
      if (isSerenaError(result)) return null;
      const parsed = parseSerenaFindSymbol(result);
      if (parsed.truncated || parsed.items.length === 0) return null;
      // Only an item carrying a body was actually shown as source; a name alone adds no resident content.
      const withBody = parsed.items.filter(item => item.body);
      if (withBody.length === 0) return null;

      if (input.relative_path) {
        const allLines = [];
        for (const item of withBody) {
          const lines = item.body.split('\n');
          for (let i = 0; i < lines.length; i++) {
            allLines.push([item.startLine + 1 + i, charsToTokens(lines[i], ctp)]);  // Serena counts from zero
          }
        }
        const spent = allLines.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Serena;
        return { type: 'lineUpdate', lines: allLines, overhead: TOOL_OVERHEAD.Serena, spent };
      }

      const files = Object.create(null);
      for (const item of withBody) {
        const key = canon(item.path, base);
        const lines = item.body.split('\n');
        (files[key] ||= []).push(...lines.map((l, i) => [item.startLine + 1 + i, charsToTokens(l, ctp)]));
      }
      let spent = TOOL_OVERHEAD.Serena;
      for (const entries of Object.values(files)) spent += entries.reduce((s, [, t]) => s + t, 0);
      return { type: 'grepMultiFile', files, overhead: TOOL_OVERHEAD.Serena, spent };
    },
  },
  {
    name: 'serena_get_symbols_overview',
    match: name => name === 'mcp__serena__get_symbols_overview',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    // An overview lists names without their source. Producing no update leaves whatever a real Read of
    // this file already established, where a name-only replacement would destroy it.
    computeUpdate: () => null,
  },
  {
    name: 'serena_find_referencing_symbols',
    match: name => name === 'mcp__serena__find_referencing_symbols',
    extractTarget: () => null, // the referencing files are named by the result
    computeUpdate: (_input, result, base, ctp, canon) => {
      if (isSerenaError(result)) return null;
      const parsed = parseSerenaReferencing(result);
      if (Object.keys(parsed.files).length === 0) return null;

      const files = Object.create(null);
      for (const [rawPath, entries] of Object.entries(parsed.files)) {
        const key = canon(rawPath, base);
        const lineEntries = [];
        for (const entry of entries) {
          if (!entry.context) continue;
          const lines = entry.context.split('\n');
          for (let i = 0; i < lines.length; i++) {
            lineEntries.push([entry.startLine + 1 + i, charsToTokens(lines[i], ctp)]);
          }
        }
        if (lineEntries.length > 0) files[key] = lineEntries;
      }
      if (Object.keys(files).length === 0) return null;
      let spent = TOOL_OVERHEAD.Serena;
      for (const entries of Object.values(files)) spent += entries.reduce((s, [, t]) => s + t, 0);
      return { type: 'grepMultiFile', files, overhead: TOOL_OVERHEAD.Serena, spent };
    },
  },
  {
    name: 'serena_read_memory',
    match: name => name === 'mcp__serena__read_memory',
    extractTarget: (input, base, canon) => {
      const name = input.memory_name || '';
      if (!name) return null;
      return canon('.serena/memories/' + (name.endsWith('.md') ? name : name + '.md'), base);
    },
    computeUpdate: (_input, result, _base, ctp) => {
      if (isSerenaError(result)) return null;
      const text = parseSerenaPlainText(result);
      if (!text) return null;
      const lineEntries = text.split('\n').map((l, i) => [i + 1, charsToTokens(l, ctp)]);
      const spent = lineEntries.reduce((s, [, t]) => s + t, 0) + TOOL_OVERHEAD.Serena;
      return { type: 'fullSet', lines: lineEntries, overhead: TOOL_OVERHEAD.Serena, spent };
    },
  },

  // ─── Serena write-like adapters ──────────────────────────────────────────
  {
    name: 'serena_replace_content',
    match: name => name === 'mcp__serena__replace_content',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    computeUpdate: (input, result, _base, ctp) => {
      if (isSerenaError(result)) return null;
      if (input.mode && input.mode !== 'literal') return null; // a pattern replacement's extent is unknown
      const needle = input.needle ?? '';
      const repl = input.repl ?? '';
      const tokenDelta = charsToTokens(repl, ctp) - charsToTokens(needle, ctp);
      const lineDelta = (repl.match(/\n/g) || []).length - (needle.match(/\n/g) || []).length;
      const spent = charsToTokens(needle, ctp) + charsToTokens(repl, ctp) + TOOL_OVERHEAD.Serena;
      return { type: 'editDelta', value: tokenDelta + lineDelta * (4 / ctp.ascii), spent };
    },
  },
  {
    name: 'serena_replace_symbol_body',
    match: name => name === 'mcp__serena__replace_symbol_body',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    // The replaced body is not in the input, so the size change is unknown: assume net zero and let the
    // next Read of this file correct it.
    computeUpdate: (input, result, _base, ctp) => {
      if (isSerenaError(result)) return null;
      const body = input.body ?? '';
      if (!body) return null;
      return { type: 'editDelta', value: 0, spent: charsToTokens(body, ctp) + TOOL_OVERHEAD.Serena };
    },
  },
  {
    name: 'serena_insert_after_symbol',
    match: name => name === 'mcp__serena__insert_after_symbol',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    computeUpdate: serenaInsert,
  },
  {
    name: 'serena_insert_before_symbol',
    match: name => name === 'mcp__serena__insert_before_symbol',
    extractTarget: (input, base, canon) => (input.relative_path ? canon(input.relative_path, base) : null),
    computeUpdate: serenaInsert,
  },
];

function serenaInsert(input, result, _base, ctp) {
  if (isSerenaError(result)) return null;
  const body = input.body ?? '';
  if (!body) return null;
  const bodyTokens = charsToTokens(body, ctp);
  return { type: 'editDelta', value: bodyTokens, spent: bodyTokens + TOOL_OVERHEAD.Serena };
}

function adapterFor(toolName) {
  return NATIVE_ADAPTERS.find(a => a.match(toolName)) || null;
}

// Would this update actually change what is known about a resource? Each shape has its own answer: a
// multi-file result needs at least one file, a fragment result needs both a target and observed lines, a
// total adjustment needs only a target.
function isEffectiveUpdate(update, target) {
  if (!update) return false;
  if (update.type === 'grepMultiFile') return Object.keys(update.files || {}).length > 0;
  if (update.type === 'fullSet' || update.type === 'lineUpdate') {
    return target != null && Array.isArray(update.lines) && update.lines.length > 0;
  }
  if (update.type === 'write' || update.type === 'editDelta') return target != null;
  return false;
}

// ─── Display naming and redaction ────────────────────────────────────────────

// Privacy scrubbing for anything derived from a raw command that reaches display or the clipboard.
// `public/lib/redaction.js` is the dashboard's independent implementation of the same masks; the two are
// held in parity by test/claude-code.native-tools.test.js `the dashboard copy produces identical output`.
export function redactCmd(cmd) {
  return String(cmd)
    .replace(/\b[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)\s*=\s*\S+/gi, (m) => m.split('=')[0] + '=***')
    .replace(/(--?(?:token|api[-_]?key|password|pass|secret)[=\s]+)\S+/gi, '$1***')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 ***')
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
    .replace(/\/(home|Users|root)\/[^/\s]+/g, '~')
    .replace(/\b\w+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***@<ip>');
}

// A readable name for an MCP tool: mcp__serena__find_symbol reads as "serena find_symbol". The tool-name
// set is a product of local plugin configuration, so this works from the naming convention alone.
function mcpDisplay(toolName) {
  if (!toolName || !toolName.startsWith('mcp__')) return toolName;
  let name = toolName.slice(5).replace(/^plugin_/, '');
  const segments = name.split('__');
  if (segments.length > 0) {
    // A plugin server often repeats its own name ("playwright_playwright"); collapse the repetition.
    const firstSeg = segments[0];
    const halfLen = Math.floor(firstSeg.length / 2);
    for (let len = halfLen + 1; len >= 2; len--) {
      const candidate = firstSeg.slice(0, len);
      if (firstSeg.slice(len) === '_' + candidate) { segments[0] = candidate; break; }
    }
  }
  return segments.join(' ');
}

// When a file read is piped into a stage that transforms its bytes, the informative name is the
// consuming tool rather than the `cat` that produced them: "cat file | python3" is a python3 call. A
// read that is residual only because a further segment follows keeps the reader's own name.
function pipeActorDisplay(cmd) {
  const stripped = stripShellPreamble(cmd).rest;
  const firstLine = stripped.split('\n')[0].split(';')[0];

  const catMatch = firstLine.match(/^cat\s+(?:-[A-Za-z]*\s*)*['"]?([^\s|;><'"]+)/);
  const headMatch = !catMatch && firstLine.match(/^head\s+(?:-[A-Za-z]*\s*\d*\s+)*['"]?([^\s|;><'"]+)/);
  const sourceMatch = catMatch || headMatch;
  if (!sourceMatch) return null;

  const allStages = splitByPipe(firstLine);
  if (allStages === null || allStages.length < 2) return null;
  // No pipe stage turned the bytes into something else, so the source reader is the informative name.
  if (classifyPipe(firstLine, catMatch ? 'cat' : 'head') !== null) return null;

  const filePath = sourceMatch[1];
  const actorTool = allStages[1].trim().split(/\s+/)[0];
  return {
    name: actorTool.length > DISPLAY_CHARS ? actorTool.slice(0, DISPLAY_CHARS) : actorTool,
    detail: filePath.length > DISPLAY_CHARS ? filePath.slice(-DISPLAY_CHARS) : filePath,
  };
}

// A safe display name for a raw Bash command. The raw command and its arguments never leave this
// function: only the bounded, redacted name and detail do.
function bashFeature(command) {
  if (!command || !String(command).trim()) return { name: '(bash)', detail: '' };
  let cmd = String(command).trim();

  cmd = cmd.replace(LEADING_COMMENT_RE, '').trim();
  if (!cmd) return { name: '(bash)', detail: '' };

  const pipeActorResult = pipeActorDisplay(cmd);
  if (pipeActorResult) return pipeActorResult;

  cmd = cmd.split('|')[0].trim();
  cmd = cmd.replace(/^source\s+\S+\s*;\s*/i, '');
  cmd = stripShellPreamble(cmd).rest;
  // Nested wrappers: `sudo env time cmd` names cmd.
  while (/^(sudo|env|time|nohup)\s+/.test(cmd)) cmd = cmd.replace(/^(sudo|env|time|nohup)\s+/, '');
  // Environment prefixes come off after the wrappers so `env VAR=val cmd` also reduces to cmd.
  cmd = cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');

  cmd = cmd.trim();
  if (!cmd) return { name: '(bash)', detail: '' };
  // Removing an environment prefix can expose a comment line that was not leading before.
  cmd = cmd.replace(LEADING_COMMENT_RE, '').trim();
  if (!cmd) return { name: '(bash)', detail: '' };

  const firstLine = cmd.split('\n')[0];   // a heredoc body is not part of the name
  const tokens = firstLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length === 0) return { name: '(bash)', detail: '' };

  const tool = tokens[0];
  if (tool.includes('/') || tool.includes('=')) return { name: '(script)', detail: '' };

  let name;
  let argsStart;
  if (tool === 'git') {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '-C' || tokens[i] === '-c') i += 2;   // these flags take an argument
      else break;
    }
    const sub = i < tokens.length ? tokens[i] : '';
    name = sub ? `git ${sub}` : 'git';
    argsStart = i + 1;
  } else if (tool === 'bash' || tool === 'sh') {
    const script = tokens[1] || '';
    const basename = script.includes('/') ? script.split('/').pop() : script;
    name = basename ? `${tool} ${basename}` : tool;
    argsStart = 2;
  } else if ((tool === 'npm' || tool === 'pnpm' || tool === 'yarn') && tokens.length > 1) {
    const sub = tokens[1] || '';
    if (sub.startsWith('-')) { name = tool; argsStart = 1; }
    else { name = `${tool} ${sub}`; argsStart = 2; }
  } else if (tool === 'docker' && tokens.length > 1 && !tokens[1].startsWith('-')) {
    name = `${tool} ${tokens[1]}`;
    argsStart = 2;
  } else {
    name = tool;
    argsStart = 1;
  }

  if (name.length > DISPLAY_CHARS) name = name.slice(0, DISPLAY_CHARS);

  let detail = '';
  for (const arg of tokens.slice(argsStart)) {
    if (arg.startsWith('-')) continue;
    const urlMatch = arg.match(/^https?:\/\/([^/\s:@]+)/);
    if (urlMatch) { detail = urlMatch[1]; break; }
    if (!arg.startsWith('$') && !arg.startsWith('"') && !arg.startsWith("'")) { detail = arg; break; }
  }
  detail = redactCmd(detail);
  if (detail.length > DISPLAY_CHARS) detail = detail.slice(0, DISPLAY_CHARS);

  return { name, detail };
}

// ─── Effects, residuals, and path telemetry ──────────────────────────────────

// One resource has ONE fragment key space: every fragment snapshot keys by source line number, so an
// observation that overlaps an earlier one OVERWRITES it instead of accumulating beside it. A whole-content
// snapshot is distinguished by its mutation KIND — `replace-fragments` supersedes the whole set — not by
// carrying a key of its own, which is what a second key space would have meant.
//
// Last write wins within one impact, because a line's own text may begin with a line-number cue and produce
// the same key twice. The Ledger treats a duplicate key inside one impact as an invariant failure, and an
// application invariant failure is owner-fatal — so ordinary file content would kill the owner. Deduping
// here is also what the baseline did: its `_setLine` was a plain `Map.set` per line.
function lineFragments(lines) {
  const byLine = new Map();
  for (const [line, tokens] of lines) byLine.set(line, tokens);
  return [...byLine].map(([key, tokens]) => ({ key, tokens }));
}

function effectFor(update, resourceKey) {
  const spentTokens = update.spent > 0 ? update.spent : 0;
  if (update.type === 'grepMultiFile') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: Object.entries(update.files).map(([key, entries]) => ({
        resourceKey: key,
        mutation: { kind: 'merge-fragments', fragments: lineFragments(entries) },
      })),
    };
  }
  if (update.type === 'fullSet') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  if (update.type === 'write') {
    return {
      access: 'write',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  if (update.type === 'lineUpdate') {
    return {
      access: 'read',
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: 'merge-fragments', fragments: lineFragments(update.lines) } }],
    };
  }
  // A total adjustment localizes nothing, so it allocates no framing overhead and stays single-impact.
  return {
    access: 'write',
    overheadTokens: 0,
    spentTokens,
    impacts: [{ resourceKey, mutation: { kind: 'adjust-total', deltaTokens: update.value } }],
  };
}

// A read of many files fans out one event per file, because the single resolved target is null there and
// one event would drop every touch. Its raw spelling is the canonical key: the tool argument was a
// pattern, not a path.
function pathEventsFor(update, resourceKey, rawPath, toolType) {
  if (update.type === 'grepMultiFile') {
    return Object.keys(update.files).map(key => ({ path: key, rawPath: key, toolType, isFullRead: 0 }));
  }
  if (resourceKey == null) return [];
  const isFullRead = update.type === 'fullSet' ? 1
    : update.type === 'lineUpdate' ? 0
    : null;   // a write is not a read
  return [{ path: resourceKey, rawPath, toolType, isFullRead }];
}

// Residual evidence exists for the two families whose context cost is real but whose content cannot be
// located: an arbitrary shell command and an MCP tool this module has no adapter for. Anything else that
// fails to produce an effect leaves no record at all.
function residualIdentityFor(toolName, input) {
  const isBash = toolName === 'Bash';
  const isMcp = typeof toolName === 'string' && toolName.startsWith('mcp__');
  if (!isBash && !isMcp) return null;
  if (isBash) {
    const feature = bashFeature(input.command);
    return {
      groupKey: feature.name || '(bash)',
      kind: 'bash',
      detail: feature.detail || '',
      // The serialized length is a weight component; the raw input itself is never stored.
      inputLength: JSON.stringify(input).length,
    };
  }
  return { groupKey: mcpDisplay(toolName), kind: 'mcp', detail: '', inputLength: JSON.stringify(input).length };
}

function isLoadHandoffTool(toolName) {
  return typeof toolName === 'string' && toolName.endsWith('load_handoff');
}

function resolvedLoadToken(resultText) {
  try {
    const parsed = JSON.parse(resultText);
    return typeof parsed?.load_token === 'string' ? parsed.load_token : null;
  } catch {
    return null;   // a partial or non-JSON result simply leaves the token unresolved
  }
}

function policyFor(context, modelId) {
  return context.resolveModelPolicy(modelId ?? null);
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Interpret one `tool-use` observation. Selects the adapter and resolves the native target and the issuing
 * step's policy once, here, and stores each of them in an opaque correlation the Projection hands back when
 * the result arrives — so completion eligibility is frozen at this moment and no later observation
 * reselects an adapter or a base path.
 *
 * @returns {{ pending: object|null, effects: [], residuals: [], telemetry: object }}
 */
export function interpretClaudeCodeToolUse(observation, context) {
  const toolUseId = observation.toolUseId;
  const issuingStepId = observation.messageId ?? null;
  const issuingPolicy = policyFor(context, observation.model);
  const input = observation.input || {};
  const explicitToken = isLoadHandoffTool(observation.name) && typeof input.load_token === 'string'
    ? input.load_token
    : null;
  // An auto-matched load carries no token in its input; the resolved one comes back in its result.
  const awaitLoadToken = isLoadHandoffTool(observation.name) && explicitToken === null;
  const telemetry = { toolUseId, issuingStepId, loadToken: explicitToken, pathEvents: [] };

  const adapter = adapterFor(observation.name);
  const base = baseDirFor(observation, context);
  const canon = canonicalizerFor(context);

  let target = null;
  let targetResolved = adapter !== null;
  if (adapter) {
    try { target = adapter.extractTarget(input, base, canon); }
    catch { targetResolved = false; }
  }

  // A shell command with no locatable file is residual evidence even though its adapter matched — unless
  // it is a chain whose blocks locate their own files.
  const isBash = adapter !== null && adapter.name === 'Bash';
  const effectEligible = targetResolved && !(isBash && target === null);
  const compound = isBash && targetResolved && target === null ? compoundFor(input, base, canon, adapter) : null;
  const residual = effectEligible || compound ? null : residualIdentityFor(observation.name, input);

  let correlation = null;
  if (effectEligible) {
    correlation = {
      kind: 'effect',
      toolUseId, issuingStepId, issuingPolicy, awaitLoadToken,
      adapter,
      input,
      target,
      rawPath: (input.file_path || input.path) || target,
      base,
      // A shell result its adapter cannot price is still evidence, so the shell identity rides along.
      residual: isBash ? residualIdentityFor(observation.name, input) : null,
    };
  } else if (compound) {
    correlation = {
      kind: 'compound',
      toolUseId, issuingStepId, issuingPolicy, awaitLoadToken,
      adapter,
      base,
      compound,
      residual: residualIdentityFor(observation.name, input),
    };
  } else if (residual) {
    correlation = { kind: 'residual', toolUseId, issuingStepId, issuingPolicy, awaitLoadToken, residual };
  } else if (awaitLoadToken) {
    correlation = { kind: 'load-token', toolUseId, issuingStepId, issuingPolicy, awaitLoadToken };
  }

  return {
    pending: correlation,
    effects: [],
    residuals: [],
    telemetry,
  };
}

/**
 * Complete a pending native tool use with its `tool-result` observation.
 *
 * @param {object} awaitResult - the correlation `interpretClaudeCodeToolUse` produced
 * @returns {{ effects: object[], residuals: object[], telemetry: object, skillContinuation: object|null }}
 */
// A failed shell or MCP call still consumed context, so it stays a selectable leaf rather than merging
// silently into the unattributed remainder.
function residualCompletion(residual, resultText, observation, telemetry) {
  const { groupKey, kind, detail, inputLength } = residual;
  return {
    effects: [],
    residuals: [{
      groupKey,
      weight: inputLength + resultText.length,
      hadError: observation.isError === true,
      meta: { kind, detail },
    }],
    telemetry,
    skillContinuation: null,
  };
}

// One effect per block the single-read adapter prices, so a `cat` block replaces and a range or grep block
// merges exactly as the same command alone would. The blocks nobody can price stay one residual weighted
// by their bytes, and a result whose dividers cannot be placed falls back to the whole-call residual.
function completeCompound(correlation, observation, resultText, context, telemetry) {
  const fallback = () => residualCompletion(correlation.residual, resultText, observation, telemetry);
  if (observation.isError === true || PERSISTED_OUTPUT_RE.test(resultText)) return fallback();
  const lines = resultText.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  stripHarnessLines(lines);
  const at = anchorLinesOf(correlation.compound.anchors, lines);
  if (!at) return fallback();

  const { adapter, base, issuingPolicy } = correlation;
  const canon = canonicalizerFor(context);
  const effects = [];
  let remainder = 0;
  let start = 0;
  correlation.compound.blocks.forEach((block, i) => {
    const end = i < at.length ? at[i] : lines.length;
    const content = lines.slice(start, end);
    start = end + 1;
    const chars = content.join('\n').length;
    if (block.target === null) { remainder += chars; return; }
    let lead = block.lead;
    let trail = block.trail;
    while (lead-- > 0 && content.length && content[0] === '') content.shift();
    while (trail-- > 0 && content.length && content[content.length - 1] === '') content.pop();
    if (content.length === 0) return;
    if (!blockPassesGuards(parseBashFileRead(block.command), content, block.command)) { remainder += chars; return; }
    let update;
    try { update = adapter.computeUpdate({ command: block.command }, content.join('\n'), base, issuingPolicy.ctp, canon); }
    catch { update = null; }
    if (!isEffectiveUpdate(update, block.target)) { remainder += chars; return; }
    const effect = effectFor(update, block.target);
    // One call carries one framing overhead; the blocks after the first inject their fragments alone.
    effects.push(effects.length === 0
      ? effect
      : { ...effect, overheadTokens: 0, spentTokens: Math.max(0, effect.spentTokens - effect.overheadTokens) });
    telemetry.pathEvents.push(...pathEventsFor(update, block.target, block.target, adapter.name));
  });
  if (effects.length === 0) return fallback();

  const residuals = [];
  if (remainder > 0) {
    const { groupKey, kind, detail, inputLength } = correlation.residual;
    residuals.push({ groupKey, weight: inputLength + remainder, hadError: false, meta: { kind, detail } });
  }
  return { effects, residuals, telemetry, skillContinuation: null };
}

export function completeClaudeCodeToolResult(awaitResult, observation, context) {
  const correlation = awaitResult;
  const resultText = resultTextOf(observation.content);
  const telemetry = {
    toolUseId: correlation.toolUseId,
    issuingStepId: correlation.issuingStepId,
    loadToken: correlation.awaitLoadToken ? resolvedLoadToken(resultText) : null,
    pathEvents: [],
  };
  const nothing = { effects: [], residuals: [], telemetry, skillContinuation: null };

  if (correlation.kind === 'residual') return residualCompletion(correlation.residual, resultText, observation, telemetry);
  if (correlation.kind === 'compound') return completeCompound(correlation, observation, resultText, context, telemetry);
  if (correlation.kind !== 'effect') return nothing;
  // An adapter that cannot price this result leaves the resource as it was; a shell correlation falls
  // back to its residual identity instead of leaving the call unaccounted for.
  const declined = () => (correlation.residual
    ? residualCompletion(correlation.residual, resultText, observation, telemetry)
    : nothing);
  if (observation.isError === true) return declined();

  const adapter = correlation.adapter;

  let update;
  try {
    update = adapter.computeUpdate(
      correlation.input, resultText, correlation.base, correlation.issuingPolicy.ctp, canonicalizerFor(context),
    );
  } catch {
    return declined();
  }
  if (!isEffectiveUpdate(update, correlation.target)) return declined();

  telemetry.pathEvents = pathEventsFor(update, correlation.target, correlation.rawPath, adapter.name);
  return {
    effects: [effectFor(update, correlation.target)],
    residuals: [],
    telemetry,
    // A Skill result carries only a launch confirmation; the payload arrives as its own harness row, so
    // the continuation is what lets that row replace this placeholder with the real content.
    skillContinuation: adapter.name === 'Skill'
      ? { resourceKey: correlation.target, issuingPolicy: correlation.issuingPolicy }
      : null,
  };
}

/**
 * Interpret the harness-injected Skill content row a successful Skill result promised. Empty text is a
 * payload of nothing and supersedes no belief, so it produces no effect.
 *
 * @param {{ resourceKey: string, issuingPolicy: object }} continuation
 * @returns {{ effects: object[], residuals: [], telemetry: null }}
 */
export function interpretClaudeCodeSkillPayload(continuation, observation) {
  const text = typeof observation.text === 'string' ? observation.text : '';
  if (!text) return { effects: [], residuals: [], telemetry: null };
  const tokens = charsToTokens(text, continuation.issuingPolicy.ctp);
  return {
    effects: [{
      access: 'read',
      overheadTokens: TOOL_OVERHEAD.Read,
      // The launch confirmation already carried this call's spend; the payload restates the same content
      // at its real size and buys nothing further.
      spentTokens: 0,
      impacts: [{
        resourceKey: continuation.resourceKey,
        mutation: { kind: 'replace-fragments', fragments: lineFragments([[1, tokens]]) },
      }],
    }],
    residuals: [],
    telemetry: null,
  };
}

/**
 * Interpret a Claude Code task-notification row: a sub-agent's completion notice, whose whole context
 * cost is its own text and whose content belongs to no resource.
 *
 * @returns {{ effects: [], residuals: object[], telemetry: null }}
 */
export function interpretClaudeCodeTaskNotification(observation) {
  const text = typeof observation.text === 'string' ? observation.text : '';
  const idMatch = text.match(TASK_ID_RE);
  const idPrefix = idMatch ? idMatch[1].slice(0, TASK_ID_PREFIX_CHARS) : '';
  const summaryMatch = text.match(TASK_SUMMARY_RE);
  const detail = summaryMatch ? summaryMatch[1].replace(AGENT_FINISHED_RE, '$1') : idPrefix;
  return {
    effects: [],
    residuals: [{
      groupKey: 'agent:' + idPrefix,
      weight: text.length,
      hadError: false,
      meta: { kind: 'agent', detail },
    }],
    telemetry: null,
  };
}

/**
 * Resolve one paired tool line's native target, once, with the same canonicalization both paths use. How
 * far down the precedence ladder a call walks is the caller's, because the ladder is only as long as the
 * context it is given: Measurement supplies a transcript directory and resolves through it, while Turn
 * History stops at the immutable session base the host supplies. A tool with no adapter, no locatable
 * target, or an adapter that throws on this input answers null: a target-resolution failure is a nullable
 * field here, not an exception.
 *
 * @param {{ name: string, input: object, cwd: string|null }} pair
 * @param {object} context - the path and homedir capabilities, plus whichever bases this caller holds
 * @returns {string|null}
 */
export function resolveClaudeCodeToolTarget(pair, context) {
  const adapter = adapterFor(pair.name);
  if (!adapter) return null;
  const base = baseDirFor(pair, context);
  try { return adapter.extractTarget(pair.input || {}, base, canonicalizerFor(context)) ?? null; }
  catch { return null; }
}

/**
 * Which bucket does one paired tool line fall in? Consumes the target Dialogue already resolved, so no
 * base path is selected here and the returned kind is all this seam reports — it sits below redaction and
 * the entity cap, letting each caller keep its own envelope policy.
 *
 * @param {{ name: string, input: object, result: *, isError: boolean|undefined, resourceKey: string|null }} pair
 * @param {{ ascii: number, cjk: number }} ctp
 * @returns {'path'|'skill'|'residual'}
 */
export function classifyToolPair(pair, ctp) {
  const adapter = adapterFor(pair.name);
  if (!adapter) return 'residual';
  if (pair.result == null) return 'residual';
  if (pair.isError === true) return 'residual';
  let update;
  try {
    update = adapter.computeUpdate(pair.input || {}, resultTextOf(pair.result), null, ctp, canonicalizerFor(null));
  } catch {
    return 'residual';
  }
  if (!isEffectiveUpdate(update, pair.resourceKey ?? null)) return 'residual';
  return adapter.name === 'Skill' ? 'skill' : 'path';
}
