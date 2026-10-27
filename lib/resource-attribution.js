// lib/resource-attribution.js — Resource Attribution: the text of one tool call, the input and the result,
// is attributed to the lines of the working tree's files by matching it against them, never by the tool's
// name. Every character of a side lands in one place: a matched line, or the side's `unmatched`.
//
// The matcher is stateless. The same evidence, working tree and limits give the same answer, and the files
// are read only through the Working Tree port, once per call, so `files` and `matches` come from one read.
// An internal failure answers like a call that matched nothing; it never throws.

import { splitLines, normalizeLine, fingerprintOf, stripLinePrefix } from './line-align.js';

const LIMIT_NAMES = ['candidates', 'fileBytes', 'sideChars', 'decodeDepth', 'alignCells', 'evidenceFloor'];
const SIDES = ['input', 'output'];

// A line this short, after trimming, may differ between the evidence and the file without parting two runs
// that are otherwise one.
const GAP_FILL_CHARS = 3;

// The fewest characters, after trimming, a line needs to be placed by its text alone.
const ANCHOR_CHARS = 24;

// The most characters the expansion of a word may have and still be a literal.
const PATH_CHARS = 4096;

// The fewest characters, after trimming, the lines of an aligned run hold in all, beside the evidence floor.
const EVIDENCE_CHARS = 12;

// ── Side text ────────────────────────────────────────────────────────────────

const isBlock = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof value.type === 'string';

// The pieces a side's text is joined from with a newline: the text blocks of a content-block array, the one
// serialization of any other JSON, the string itself. Total: a value that cannot be serialized has none.
function partsOf(value) {
  if (typeof value === 'string') return [value];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every(isBlock)) {
    return value.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text);
  }
  try {
    return [JSON.stringify(value) ?? ''];
  } catch {
    return [];
  }
}

/**
 * The text of one side of a tool call, whose `.length` is the side's character count: a string is itself, a
 * content-block array is its text blocks joined with `\n`, any other JSON is its `JSON.stringify`, and an
 * absent value is empty. Never throws.
 * @param {*} value the call's input or result
 * @returns {string}
 */
export function sideTextOf(value) {
  return partsOf(value).join('\n');
}

// ── JSON views ───────────────────────────────────────────────────────────────

const isJsonSpace = code => code === 32 || code === 9 || code === 10 || code === 13;

function newlinesIn(text) {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

// The string leaves, not the keys, of a JSON container text in document order, each with the number of
// containers around it (`baseDepth` already counts those the text itself sits in) and the line it starts
// on. Null for a text that is not a JSON container. The text parses, so the walk only has to tell structure
// from string content; a JSON string holds no raw newline, so every newline seen is a line break between
// tokens.
function scanLeaves(text, baseDepth) {
  if (!/^\s*[{[]/.test(text)) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const leaves = [];
  let depth = baseDepth;
  let deepest = baseDepth;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      let end = i + 1;
      while (text.charCodeAt(end) !== 34) end += text.charCodeAt(end) === 92 ? 2 : 1;
      let next = end + 1;
      while (isJsonSpace(text.charCodeAt(next))) next++;
      if (text.charCodeAt(next) !== 58) leaves.push({ value: JSON.parse(text.slice(i, end + 1)), depth, line });
      i = end;
    } else if (code === 123 || code === 91) {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (code === 125 || code === 93) {
      depth--;
    } else if (code === 10) {
      line++;
    }
  }
  return { leaves, deepest };
}

// The inner JSON view of a side: every string leaf of its parts, and of each leaf that is itself a JSON
// container text, one level of nesting deeper. A leaf is `{ value, line, parent }`: `line` indexes the
// lines of its parent leaf, or of the side's text when `parent` is null. `report.deepest` is the container
// depth the scan met, past the limit too; leaves at containers deeper than `maxDepth` are not decoded.
function collectLeaves(parts, maxDepth, report) {
  const leaves = [];
  const descend = (text, lineBase, baseDepth, parent) => {
    const layer = scanLeaves(text, baseDepth);
    if (layer === null) return;
    report.deepest = Math.max(report.deepest, layer.deepest);
    for (const leaf of layer.leaves) {
      if (leaf.depth > maxDepth) continue;
      const decoded = { value: leaf.value, line: lineBase + leaf.line, parent };
      leaves.push(decoded);
      descend(leaf.value, 0, leaf.depth, decoded);
    }
  };
  let lineBase = 0;
  for (const part of parts) {
    descend(part, lineBase, 0, null);
    lineBase += newlinesIn(part) + 1;
  }
  return leaves;
}

// ── Context lines ────────────────────────────────────────────────────────────

// Each view of a side is a segment of lines: the side's text, then every decoded leaf (`inner`). A line is what a
// match carries and prices: `raw`, the line as the evidence shows it, prefix included. `norm` is what is
// compared with a file's lines, past a line-number cue, which only a result's rows carry: an input is
// file text or a command, and a content line that looks like a cue is not one there. `ancestors` are the
// keys of the lines a decoded leaf sits inside, so a leaf and its enclosing line never both match.
function segmentOf(side, text, owner, counter) {
  const id = counter.segments++;
  const lines = splitLines(text).map((raw, index) => {
    const cue = side === 'output' ? stripLinePrefix(raw) : { text: raw, declaredLine: null, path: null };
    return {
      side,
      raw,
      norm: normalizeLine(cue.text),
      declared: cue.declaredLine,
      prefixPath: cue.path,
      restrict: null,
      list: false,
      seq: counter.lines++,
      key: `${id}:${index}`,
      ancestors: owner ? [owner.key, ...owner.ancestors] : [],
      pos: owner ? owner.pos : index,
    };
  });
  return { side, lines, inner: owner !== null };
}

function segmentsOf(side, maxDepth, report, counter) {
  const whole = segmentOf(side.name, side.text, null, counter);
  const segments = [whole];
  for (const leaf of collectLeaves(side.parts, maxDepth, report)) {
    const owner = (leaf.parent ? leaf.parent.segment : whole).lines[leaf.line];
    leaf.segment = segmentOf(side.name, leaf.value, owner, counter);
    segments.push(leaf.segment);
  }
  return segments;
}

// ── Path cues ────────────────────────────────────────────────────────────────

const TOKEN_BREAK = /[\s|;&<>]/;
const PATH_SHAPE = /[/\\.]/;
const UNCITED = Number.MAX_SAFE_INTEGER;   // a distance no output cue closes

// What a shell line holds besides words, in the order its tokens come.
const STATEMENT_END = Symbol('statement end');
const SUBSHELL_OPEN = Symbol('subshell open');
const SUBSHELL_CLOSE = Symbol('subshell close');
const MARKS = new Map([[';', STATEMENT_END], ['&', STATEMENT_END], ['(', SUBSHELL_OPEN], [')', SUBSHELL_CLOSE]]);

const VARIABLE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
const EXPANSION = /[$`]/;
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/;

// Whitespace and `| ; & < >` split a line into tokens, except inside a quote. A line of an input segment that holds a
// `cd` is read as a shell line (`shell`): `(` and `)` split it too, and the tokens carry marks where a statement ends
// (`;`, `&`, `||`) and where a subshell opens and closes. A lone `|` ends no statement.
function tokensOf(line, shell = false) {
  const tokens = [];
  let token = '';
  let quote = null;
  let open = false;
  let previous = '';
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === '\'') {
      quote = char;
      open = true;
    } else if (TOKEN_BREAK.test(char) || (shell && (char === '(' || char === ')'))) {
      if (open) tokens.push(token);
      token = '';
      open = false;
      if (shell) {
        const mark = char === '|' ? (previous === '|' ? STATEMENT_END : null) : MARKS.get(char);
        if (mark) tokens.push(mark);
      }
    } else {
      token += char;
      open = true;
    }
    previous = char;
  }
  if (open) tokens.push(token);
  return tokens;
}

// The word with each `$NAME` and `${NAME}` replaced by what the segment assigned it; null when the word is not a
// literal: a name nothing assigned, a command substitution, any other `$` or a backtick, or an expansion longer
// than PATH_CHARS. A reference that takes the word past that length leaves a `$` in place of its text, so the
// product of the references and the value length is never built.
function literalOf(word, names) {
  let length = word.length;
  const value = word.replace(VARIABLE, (match, braced, bare) => {
    const text = names.get(braced ?? bare);
    if (text === undefined) return match;
    length += text.length - match.length;
    return length > PATH_CHARS ? '$' : text;
  });
  return EXPANSION.test(value) ? null : value;
}

// The directory a `cd` to `target` reaches from `directory`: its key, without a trailing slash, when the tree has
// it as a directory. Null, not known, for a target that is absent, empty, not literal or an option.
function directoryOf(workingTree, directory, target) {
  if (target === null || target.startsWith('-')) return null;
  const resolved = workingTree.resolve(directory, target);
  if (resolved === null) return null;
  const key = resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
  return workingTree.stat(key)?.isFile === false ? key : null;
}

// Whether a statement of the lines starts with `cd`. Only a segment that holds one is read as a shell line; any
// other is read by `readCues`, which splits at no parenthesis and expands no name, so a `file_path` spelled with
// parentheses or `$` stays one word.
function holdsCd(lines) {
  for (const line of lines) {
    let head = true;
    for (const token of tokensOf(line.raw, true)) {
      if (typeof token === 'symbol') head = true;
      else if (head && token === 'cd') return true;
      else head = false;
    }
  }
  return false;
}

// One segment of the input that holds a `cd`, followed from `base` through `cd` and `NAME=literal` and nothing else
// of a command. `visit(directory, spelling, line)` gets each path-shaped literal word with the directory its statement
// began in; a directory that is not known is null, which resolves no relative word and never stands for `base`. A `)`
// restores the directory a `(` left, not the names: an assignment inside a subshell outlives it, and one whose
// value is not literal leaves its name expanding to a word that is not. Answers the directory its last statement
// began in.
function followCommand(lines, base, workingTree, visit) {
  const names = new Map();
  const outer = [];
  let directory = base;
  let began = base;
  let words = [];

  const settle = () => {
    const statement = words;
    words = [];
    if (statement[0] === 'cd') {
      directory = directoryOf(workingTree, directory, statement.length > 1 ? literalOf(statement[1], names) : null);
    } else {
      for (const word of statement.slice(statement[0] === 'export' ? 1 : 0)) {
        const assignment = ASSIGNMENT.exec(word);
        if (assignment === null) break;
        names.set(assignment[1], assignment[2]);
      }
    }
  };

  for (const line of lines) {
    for (const token of tokensOf(line.raw, true)) {
      if (token === STATEMENT_END) {
        settle();
      } else if (token === SUBSHELL_OPEN) {
        settle();
        outer.push(directory);
      } else if (token === SUBSHELL_CLOSE) {
        settle();
        if (outer.length > 0) directory = outer.pop();
      } else {
        began = directory;
        words.push(token);
        const word = literalOf(token, names);
        if (word !== null && PATH_SHAPE.test(word)) visit(directory, word, line);
      }
    }
    settle();
  }
  return began;
}

// The files the segments cite, in the order they are first cited: the input's cues, then the output's.
// A candidate is a regular file the tree resolves; `cited` is 0 when any input line names it. A word resolves from
// `base` (`readCues`) unless it sits in an input segment that holds a `cd`: that segment is followed
// (`followCommand`) and each word resolves from the directory its statement began in. A side
// with decoded leaves and a segment that holds a `cd` gives no input cues from its raw view: that is the JSON
// serialization, whose escaped quotes turn what the shell quoted into bare words. An output row's relative cue
// resolves from the directory the last statement of the last followed segment began in, else from `base`; where
// that directory is not known the cue has no candidate. A whole-line path in the output is a cue and a list line: it
// is never content, so a listing of files cannot match the file that happens to hold the listing. A row's `path:`
// prefix is both a cue and the only file the row may match.
function gatherCandidates(segments, base, workingTree) {
  const spelled = new Map();
  const candidates = new Map();
  const fileOf = (directory, spelling) => {
    const id = `${directory}\0${spelling}`;
    if (!spelled.has(id)) {
      const key = workingTree.resolve(directory, spelling);
      const stat = key === null ? null : workingTree.stat(key);
      spelled.set(id, stat?.isFile === true ? { key, size: stat.size } : null);
    }
    return spelled.get(id);
  };
  const cite = (file, line) => {
    let candidate = candidates.get(file.key);
    if (!candidate) {
      candidate = { key: file.key, size: file.size, order: candidates.size, cited: 1, outputAt: [] };
      candidates.set(file.key, candidate);
    }
    if (line.side === 'input') candidate.cited = 0;
    else candidate.outputAt.push(line.pos);
  };
  const readCues = (lines, directory) => {
    for (const line of lines) {
      const tokens = tokensOf(line.raw);
      const spellings = tokens.filter(token => PATH_SHAPE.test(token));
      if (line.prefixPath !== null) {
        spellings.push(line.prefixPath);
        line.restrict = fileOf(directory, line.prefixPath)?.key ?? '';
      }
      line.list = line.side === 'output' && tokens.length === 1 && PATH_SHAPE.test(tokens[0])
        && fileOf(directory, tokens[0]) !== null;
      for (const spelling of spellings) {
        const file = fileOf(directory, spelling);
        if (file !== null) cite(file, line);
      }
    }
  };

  const input = segments.filter(({ side }) => side === 'input');
  const followed = new Set(input.filter(({ lines }) => holdsCd(lines)));
  const dropsRawView = followed.size > 0 && input.some(({ inner }) => inner);
  let outputDirectory = base;
  for (const segment of input) {
    if (dropsRawView && !segment.inner) continue;
    if (followed.has(segment)) {
      outputDirectory = followCommand(segment.lines, base, workingTree, (directory, spelling, line) => {
        const file = fileOf(directory, spelling);
        if (file !== null) cite(file, line);
      });
    } else {
      readCues(segment.lines, base);
    }
  }
  for (const { side, lines } of segments) {
    if (side === 'output') readCues(lines, outputDirectory);
  }
  return [...candidates.values()];
}

// The candidates within the count limit whose text can be matched, each with its normalized lines. What a
// file's size, count or content excludes is still in `stats`, as the limit saw it.
function readCandidates(candidates, bound, workingTree, stats) {
  stats.candidates.observed.push(candidates.length);
  if (candidates.length > bound.candidates) stats.candidates.rejected.push(candidates.length);
  for (const { size } of candidates) {
    stats.fileBytes.observed.push(size);
    if (size > bound.fileBytes) stats.fileBytes.rejected.push(size);
  }
  const readable = [];
  for (const candidate of candidates.slice(0, bound.candidates)) {
    if (candidate.size > bound.fileBytes) continue;
    const text = workingTree.readText(candidate.key);
    if (text === null || text.includes('\u0000')) continue;
    candidate.norms = splitLines(text).map(normalizeLine);
    readable.push(candidate);
  }
  return readable;
}

// ── Runs and claims ──────────────────────────────────────────────────────────

// A run is consecutive lines of one segment that one candidate explains. `pairs` hold `{ line, file, tier }`
// with `file` the zero-based line of the candidate. Runs compete for lines; the best by `byPriority` takes
// the lines it can still have, and a line, with the lines it sits inside and those inside it, is taken once.
const distanceOf = (candidate, line) => (line.side === 'input'
  ? UNCITED
  : candidate.outputAt.reduce((nearest, at) => Math.min(nearest, Math.abs(at - line.pos)), UNCITED));

function runOf(candidate, pairs, declared) {
  const [first] = pairs;
  return {
    candidate,
    pairs,
    declared,
    cohesion: pairs.length,
    distance: distanceOf(candidate, first.line),
    start: first.file,
    seq: first.line.seq,
  };
}

// The longer run first, then a file the input cites before one only the output cites, then the one the
// output cites nearest the run, then the earlier cue, then the earlier position in the file. Runs of verified
// positions and runs of alignment are never ranked together: each kind is claimed in a pass of its own.
const byPriority = (a, b) => (b.cohesion - a.cohesion)
  || (a.candidate.cited - b.candidate.cited)
  || (a.distance - b.distance)
  || (a.candidate.order - b.candidate.order)
  || (a.start - b.start)
  || (a.seq - b.seq);

function createClaims() {
  const taken = [];
  const self = new Set();
  const under = new Set();
  return {
    taken,
    blocked: line => self.has(line.key) || under.has(line.key) || line.ancestors.some(key => self.has(key)),
    take(line, candidate, file, tier) {
      self.add(line.key);
      for (const key of line.ancestors) under.add(key);
      taken.push({ line, candidate, file, tier });
    },
  };
}

// Whether lines are evidence enough to place an aligned run: the evidence floor in lines, and EVIDENCE_CHARS
// in all. A line's `norm` has lost its line-number cue, so the number a row declares is not counted.
function holdsEvidence(lines, floor) {
  return lines.length >= floor && lines.reduce((chars, line) => chars + line.norm.trim().length, 0) >= EVIDENCE_CHARS;
}

// Takes each run's still-free lines in priority order. A declared line stands alone; any other run must
// hold the evidence in what it can still have.
function claimRuns(runs, claims, floor) {
  runs.sort(byPriority);
  for (const run of runs) {
    let part = [];
    const flush = () => {
      if (run.declared ? part.length > 0 : holdsEvidence(part.map(({ line }) => line), floor)) {
        for (const { line, file, tier } of part) claims.take(line, run.candidate, file, tier);
      }
      part = [];
    };
    for (const pair of run.pairs) {
      if (claims.blocked(pair.line)) flush();
      else part.push(pair);
    }
    flush();
  }
}

// A row that declares a line the candidate's text holds is verified there, whatever else the file holds.
// Leading whitespace is not compared here: `stripLinePrefix` gives up one space after `N:` even when the
// line itself starts with it. The other tiers compare whole normalized lines.
function declaredRuns(segments, candidates) {
  const runs = [];
  for (const candidate of candidates) {
    for (const { lines } of segments) {
      let pairs = [];
      const close = () => {
        if (pairs.length > 0) runs.push(runOf(candidate, pairs, true));
        pairs = [];
      };
      for (const line of lines) {
        const verified = line.declared !== null && !line.list
          && (line.restrict === null || line.restrict === candidate.key)
          && candidate.norms[line.declared - 1]?.trimStart() === line.norm.trimStart();
        if (verified) pairs.push({ line, file: line.declared - 1, tier: 'declared' });
        else close();
      }
      close();
    }
  }
  return runs;
}

// Where each distinct line of the candidate occurs, in order.
function positionsOf(candidate) {
  if (!candidate.positions) {
    candidate.positions = new Map();
    candidate.norms.forEach((norm, at) => {
      if (candidate.positions.has(norm)) candidate.positions.get(norm).push(at);
      else candidate.positions.set(norm, [at]);
    });
  }
  return candidate.positions;
}

// Whether the candidate's lines `start` to `start + length - 1` also occur together at another position: a
// run with a second home is placed at the one found first and marked `tied`. Each position visited, and each
// line compared there, is paid for from the call's budget, and a scan the budget cannot finish answers no.
function repeatsElsewhere(candidate, start, length, budget) {
  const { norms } = candidate;
  for (const at of positionsOf(candidate).get(norms[start])) {
    if (budget.cells <= 0) return false;
    let same = 0;
    if (at !== start && at + length <= norms.length) {
      while (same < length && norms[at + same] === norms[start + same]) same++;
      if (same === length) return true;
    }
    budget.cells = Math.max(0, budget.cells - 1 - same);
  }
  return false;
}

// The longest run of lines `a[alo..ahi)` and `b[blo..bhi)` have in common, the earliest in `a` among
// equals. One row of the table at a time, so memory is the width of `b`.
function longestRun(a, alo, ahi, b, blo, bhi) {
  let best = { file: 0, at: 0, length: 0 };
  let above = new Uint32Array(bhi - blo + 1);
  let row = new Uint32Array(bhi - blo + 1);
  for (let i = alo; i < ahi; i++) {
    for (let j = blo; j < bhi; j++) {
      const length = a[i] === b[j] ? above[j - blo] + 1 : 0;
      row[j - blo + 1] = length;
      if (length > best.length) best = { file: i - length + 1, at: j - length + 1, length };
    }
    [above, row] = [row, above];
  }
  return best;
}

// Whether the window lines `from` to `to`, those of a pinned head (`forward`) or tail of `length` lines, begin
// or end a run elsewhere in the file that beats it: a longer one at the head, one as long at the tail, where
// the earlier position takes the tie. Only runs through those window lines are looked for. What the budget
// cannot pay to look through counts as beaten.
function outrun(candidate, b, from, to, length, forward, budget) {
  const a = candidate.norms;
  const own = forward ? 0 : a.length - b.length;
  const step = forward ? 1 : -1;
  for (let p = from; p < to; p++) {
    for (const q of positionsOf(candidate).get(b[p]) ?? []) {
      if (q === p + own) continue;
      if (budget.cells <= 0) return true;
      let run = 1;
      while (a[q + step * run] !== undefined && a[q + step * run] === b[p + step * run]) run++;
      budget.cells = Math.max(0, budget.cells - run);
      if (forward ? run > length : run >= length) return true;
    }
  }
  return false;
}

// The runs of lines the candidate and the stretch `b` have in common, in the order of `b`. An equal head or
// tail of at least the floor is paired off position by position unless `outrun` finds, through the window
// lines of that run, a run elsewhere in the file that beats it. What lies between is searched for its
// longest common run, which is taken, and the two sides of it are searched in turn, until a longest run
// falls short of the floor. A search is a table of the two lengths and, like `outrun`, is drawn from the
// call's budget; one the budget cannot cover is not made.
function commonRuns(candidate, b, floor, budget, stats) {
  const a = candidate.norms;
  const shared = Math.min(a.length, b.length);
  let head = 0;
  while (head < shared && a[head] === b[head]) head++;
  if (head < floor || (head < shared && outrun(candidate, b, 0, head, head, true, budget))) head = 0;
  let tail = 0;
  while (tail < shared - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (tail < floor || (head + tail < shared && outrun(candidate, b, b.length - tail, b.length, tail, false, budget))) {
    tail = 0;
  }
  const runs = [];
  if (head > 0) runs.push({ file: 0, at: 0, length: head });
  if (tail > 0) runs.push({ file: a.length - tail, at: b.length - tail, length: tail });
  const middle = [head, a.length - tail, head, b.length - tail];
  if ((middle[1] - middle[0]) * (middle[3] - middle[2]) === 0) stats.alignCells.observed.push(0);
  const ranges = [middle];
  while (ranges.length > 0) {
    const [alo, ahi, blo, bhi] = ranges.pop();
    const cells = (ahi - alo) * (bhi - blo);
    if (cells === 0) continue;
    stats.alignCells.observed.push(cells);
    if (cells > budget.cells) {
      stats.alignCells.rejected.push(cells);
      continue;
    }
    budget.cells -= cells;
    const run = longestRun(a, alo, ahi, b, blo, bhi);
    if (run.length === 0) continue;
    runs.push(run);
    if (run.length >= floor) {
      ranges.push([run.file + run.length, ahi, run.at + run.length, bhi], [alo, run.file, blo, run.at]);
    }
  }
  return runs.sort((x, y) => x.at - y.at);
}

// The runs that hold the evidence, with a short differing line between two of them joined to both
// when as many lines separate them in the file as in the evidence.
function keepRuns(runs, stretch, floor, stats) {
  const kept = [];
  for (const run of runs) {
    stats.evidenceFloor.observed.push(run.length);
    if (!holdsEvidence(stretch.slice(run.at, run.at + run.length), floor)) {
      stats.evidenceFloor.rejected.push(run.length);
      continue;
    }
    const group = Array.from({ length: run.length }, (_, k) => ({ file: run.file + k, at: run.at + k }));
    const previous = kept.at(-1);
    const end = previous?.at(-1);
    const gap = end ? run.at - end.at - 1 : 0;
    if (gap > 0 && gap === run.file - end.file - 1
      && stretch.slice(end.at + 1, run.at).every(line => line.norm.trim().length <= GAP_FILL_CHARS)) {
      for (let k = 1; k <= gap; k++) previous.push({ file: end.file + k, at: end.at + k });
      previous.push(...group);
    } else {
      kept.push(group);
    }
  }
  return kept;
}

// A line that has no verified position is `drifted` when its row declared one the file does not bear.
const placedTier = line => (line.declared !== null ? 'drifted' : 'aligned');

// Lines without a verified position are matched to each candidate in order, one search per stretch of
// consecutive free lines; the runs the search yields compete for lines like any other.
function alignedRuns(segments, candidates, claims, bound, budget, stats) {
  const runs = [];
  const align = (candidate, stretch) => {
    const found = commonRuns(candidate, stretch.map(line => line.norm), bound.evidenceFloor, budget, stats);
    for (const group of keepRuns(found, stretch, bound.evidenceFloor, stats)) {
      const tied = repeatsElsewhere(candidate, group[0].file, group.length, budget);
      runs.push(runOf(candidate, group.map(({ file, at }) => ({
        line: stretch[at],
        file,
        tier: tied ? 'tied' : placedTier(stretch[at]),
      })), false));
    }
  };
  for (const candidate of candidates) {
    for (const { lines } of segments) {
      let stretch = [];
      const close = () => {
        if (stretch.length >= bound.evidenceFloor) align(candidate, stretch);
        stretch = [];
      };
      for (const line of lines) {
        if (!claims.blocked(line) && !line.list && (line.restrict === null || line.restrict === candidate.key)) {
          stretch.push(line);
        } else {
          close();
        }
      }
      close();
    }
  }
  return runs;
}

// ── Lines placed by their text ───────────────────────────────────────────────

// The lines no run took, placed by their text alone: a line of at least ANCHOR_CHARS that exactly one candidate
// holds, once, is that line, whatever the lines around it are. A row that names its file is held to that file,
// and a line two places hold is left unplaced. Neither a declared position nor a run that reaches the evidence
// floor is needed. One pass over the candidates' lines.
function anchoredLines(segments, candidates, claims) {
  const free = segments.flatMap(({ lines }) => lines
    .filter(line => !claims.blocked(line) && !line.list && line.norm.trim().length >= ANCHOR_CHARS));
  if (free.length === 0) return;
  const homes = new Map(free.map(line => [line.norm, []]));
  for (const candidate of candidates) {
    candidate.norms.forEach((norm, file) => homes.get(norm)?.push({ candidate, file }));
  }
  for (const line of free) {
    if (claims.blocked(line)) continue;
    const held = homes.get(line.norm);
    const mine = line.restrict === null ? held : held.filter(({ candidate }) => candidate.key === line.restrict);
    if (mine.length === 1) claims.take(line, mine[0].candidate, mine[0].file, placedTier(line));
  }
}

// ── Attribution ──────────────────────────────────────────────────────────────

function requireLimit(limits, name) {
  const value = limits?.[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Resource Attribution limit ${name} must be a finite positive number`);
  }
  return value;
}

const newStats = () => ({
  failed: false,
  ...Object.fromEntries(LIMIT_NAMES.map(name => [name, { observed: [], rejected: [] }])),
});

function answerOf(sides, taken, stats) {
  taken.sort((a, b) => a.line.seq - b.line.seq);
  const groups = new Map();
  const files = {};
  const matched = { input: 0, output: 0 };
  for (const { line, candidate, file, tier } of taken) {
    const id = `${line.side}\0${candidate.key}`;
    if (!groups.has(id)) groups.set(id, { resourceKey: candidate.key, side: line.side, lines: [] });
    groups.get(id).lines.push({ line: file + 1, text: line.raw, tier });
    matched[line.side] += line.raw.length;
    files[candidate.key] ??= candidate.norms.map(fingerprintOf);
  }
  return {
    matches: [...groups.values()],
    files,
    unmatched: Object.fromEntries(sides.map(side => [side.name, side.text.length - matched[side.name]])),
    stats,
  };
}

/**
 * The matcher over one working tree. `limits` carries every member named in `ATTRIBUTION_LIMITS`; each is
 * required, so a member that drifts from its constant fails where the matcher is built.
 * @param {{ workingTree: object, limits: object }} deps
 * @returns {{ attribute: function }}
 */
export function createResourceAttribution({ workingTree, limits } = {}) {
  const bound = Object.fromEntries(LIMIT_NAMES.map(name => [name, requireLimit(limits, name)]));
  for (const method of ['resolve', 'stat', 'readText']) {
    if (typeof workingTree?.[method] !== 'function') {
      throw new TypeError(`Resource Attribution workingTree must provide ${method}`);
    }
  }

  function attributeSides(sides, base) {
    const stats = newStats();
    const counter = { lines: 0, segments: 0 };
    const segments = [];
    for (const side of sides) {
      stats.sideChars.observed.push(side.text.length);
      if (side.text.length > bound.sideChars) {
        stats.sideChars.rejected.push(side.text.length);
        continue;
      }
      const report = { deepest: 0 };
      segments.push(...segmentsOf(side, bound.decodeDepth, report, counter));
      stats.decodeDepth.observed.push(report.deepest);
      if (report.deepest > bound.decodeDepth) stats.decodeDepth.rejected.push(report.deepest);
    }
    const candidates = readCandidates(gatherCandidates(segments, base, workingTree), bound, workingTree, stats);
    const claims = createClaims();
    claimRuns(declaredRuns(segments, candidates), claims, bound.evidenceFloor);
    const budget = { cells: bound.alignCells };
    claimRuns(alignedRuns(segments, candidates, claims, bound, budget, stats), claims, bound.evidenceFloor);
    anchoredLines(segments, candidates, claims);
    return answerOf(sides, claims.taken, stats);
  }

  function attribute({ base, input, output } = {}) {
    const values = { input, output };
    const sides = SIDES.map(name => {
      const parts = partsOf(values[name]);
      return { name, parts, text: parts.join('\n') };
    });
    try {
      return attributeSides(sides, base);
    } catch (error) {
      return {
        matches: [],
        files: {},
        unmatched: Object.fromEntries(sides.map(side => [side.name, side.text.length])),
        stats: { ...newStats(), failed: true, failure: String(error?.message ?? error) },
      };
    }
  }

  return { attribute };
}
