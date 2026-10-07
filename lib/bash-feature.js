// lib/bash-feature.js — a bash residual's identity is one extraction for every harness whose agent
// runs a shell, and the pipe classification that naming shares with Claude Code's read parsers lives
// beside it.

// Matches one or more leading lines that are shell comments (including shebangs).
export const LEADING_COMMENT_RE = /^(\s*#[^\n]*(\n|$))+/;
const DISPLAY_CHARS = 40;

// Peels the leading segments that produce no locatable bytes of their own. A cd changes what the target
// resolves against; the last cd wins, resolved against the row's base path. A one-argument echo prints
// its argument as a line of its own ahead of the real command's output, so that line is known and can be
// dropped from the result. An echo with flags, several arguments, an argument spanning lines or an
// expandable argument is not a preamble — its output is unknowable — and stays part of the command.
const CD_PREAMBLE_RE = /^cd\s+(\S+)\s*(?:&&|;)\s*/;
const ECHO_PREAMBLE_RE = /^echo\s+("[^"$`\\\n]*"|'[^'\n]*'|[^\s"'$`;&|<>]+)\s*(?:&&|;)\s*/;
const FN_PREAMBLE_RE = /^fn\w+\s*&&\s*/;
export function stripShellPreamble(command) {
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

// A `sed -n` range with no path only drops whole lines: every line that survives it is unchanged, so a
// stage that numbered its lines still describes where they came from.
const SED_LINE_DROP_RE = /^sed\s+-n\s+(?:-e\s+)?(['"]?)[\d,$p;\s]+\1$/;

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
export function classifyPipe(firstCmd, baseType) {
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
// function: only the name and the redacted detail do, each bounded.
export function bashFeature(command) {
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
  // Environment prefixes come off after the wrappers so `env VAR=val cmd` also reduces to cmd. An
  // assignment joined to what follows by a separator is a command of its own, not a prefix: peeling it
  // exposes the separator and the next command's own preamble, and the loop reaches past a chain of them.
  // The value class spans a quoted value whole — a fragment of one would become the name, where no mask
  // reaches it — and lets a quoted one meet its separator with no space between.
  for (;;) {
    const before = cmd;
    cmd = cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']*)(?:\s+|\s*(?:&&|;)\s*))+/, '');
    cmd = stripShellPreamble(cmd.replace(/^(?:&&|;)\s*/, '')).rest;
    if (cmd === before) break;
  }

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
    // Past a separator or a redirect the tokens are not this command's arguments.
    if (/^(?:&&|;|>>?|<<?|&)$/.test(arg)) break;
    if (arg.startsWith('-')) continue;
    const urlMatch = arg.match(/^https?:\/\/([^/\s:@]+)/);
    if (urlMatch) { detail = urlMatch[1]; break; }
    if (!arg.startsWith('$') && !arg.startsWith('"') && !arg.startsWith("'")) { detail = arg; break; }
  }
  detail = redactCmd(detail);
  if (detail.length > DISPLAY_CHARS) detail = detail.slice(0, DISPLAY_CHARS);

  return { name, detail };
}
