#!/usr/bin/env node
/**
 * synthesize-working-tree.mjs — the working tree a real transcript can be attributed against. Development only:
 * nothing bundles it, and what it writes (paths and file text, all taken from the transcript) belongs to the
 * machine that ran it, so its output goes under the ignored `fixtures/working-trees/` and is never committed.
 *
 * A transcript shows lines of the files it worked on, not the files. For each path it reads or writes, this derives
 * the least content that lets the transcript's own evidence match: a line a result or a written text shows is placed
 * at the line number it names (a whole file's text from line 1), the newest evidence for a line wins, an edit
 * replaces its old text where the file shows it, and a line nothing names is empty. The knowledge of result formats
 * lives here and not in `lib/`: the DSH `read` envelope, numbered reads (Claude Code's `Read`, `cat -n`), grep hits
 * by path prefix and by section, `Write` content and `Edit` text, and from a shell command the `cat`, `head` and
 * `sed -n 'A,Bp'` of one file and a heredoc written to one. A result of any other shape adds nothing.
 *
 * Sessions are read the way `scripts/attribution-lab.mjs` reads them: through the source decoders, then paired
 * by `projectDialogue`.
 *
 * Usage:
 *   node scripts/synthesize-working-tree.mjs <session log> [--out FILE]
 *
 * `<session log>` is a DSH session log (zstd, gzip or plain) or a Claude Code `.jsonl`. The tree is
 * `{ "<absolute path>": "<content>" }` as JSON, written to FILE (by convention `fixtures/working-trees/<name>.json`)
 * or to standard output; the counts it was derived from go to standard error.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sideTextOf } from '../lib/resource-attribution.js';
import { createMemoryWorkingTree } from '../lib/working-tree.js';
import { projectDialogue } from '../lib/dialogue-fold.js';
import { decodeDshLog } from '../lib/harness/dsh/log-frames.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';

// A line number beyond this is taken for a misread: the blank lines before it would be the file's size.
const MAX_LINE = 100_000;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;
const SHELL_WORD = String.raw`('[^']*'|"[^"]*"|[^\s|;&<>]+)`;

/**
 * The path module of the namespace a directory belongs to: a Windows drive path is Windows', anything else POSIX.
 * A tree synthesized from a transcript is read back through the same choice.
 * @param {?string} directory a session's working directory, or a path in its tree
 */
export const pathFlavorOf = directory => (typeof directory === 'string' && WINDOWS_ROOT.test(directory) ? path.win32 : path.posix);

// ── Reading a session ────────────────────────────────────────────────────────

/**
 * A session log as `{ harness, cwd, observations }`: the working directory is the DSH header's, or the first one a
 * Claude Code tool use names.
 * @param {Buffer} buffer a DSH session log or a Claude Code transcript
 */
export function readSession(buffer) {
  const log = decodeDshLog(buffer);
  if (log !== null) {
    return { harness: 'dsh', cwd: log.header.cwd ?? null, observations: reduceDshSnapshot(log.events).observations };
  }
  const { observations } = reduceClaudeCodeSnapshot(readClaudeCodeRows(buffer, { atEof: true }).rows);
  const cwd = observations.find(o => o.type === 'tool-use' && typeof o.cwd === 'string' && o.cwd !== '')?.cwd ?? null;
  return { harness: 'claude-code', cwd, observations };
}

// ── Lines ────────────────────────────────────────────────────────────────────

// The lines of a text; the terminator of the last one is not a line of its own.
function linesOfText(text) {
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const unquote = word => (/^(['"]).*\1$/.test(word) ? word.slice(1, -1) : word);

const stringOf = (input, names) => {
  for (const name of names) {
    if (typeof input?.[name] === 'string' && input[name] !== '') return input[name];
  }
  return null;
};

// ── Result formats ───────────────────────────────────────────────────────────
// Each recognizer answers the groups `{ raw, lines: [[number, text]] }` a text holds, or null when it is not of
// that format. `raw` is the path as the result spells it; null in a group means the call's own target.

// DSH's `read`: `<path>…</path>`, `<type>file</type>`, and a `<content>` of `N: text` rows with a footer.
function dshReadEnvelope(text) {
  const head = /^<path>(.*)<\/path>\n<type>file<\/type>\n<content>\n/.exec(text);
  if (head === null) return null;
  const lines = [];
  for (const row of text.slice(head[0].length).split('\n')) {
    const hit = /^(\d+):(?: (.*))?$/.exec(row);
    if (hit !== null) lines.push([Number(hit[1]), hit[2] ?? '']);
  }
  return [{ raw: head[1], lines }];
}

// Claude Code's `Read` and `cat -n`: `N<TAB>text` rows, the number padded on the left.
function numberedRead(text) {
  const lines = [];
  for (const row of text.split('\n')) {
    const hit = /^\s*(\d+)\t(.*)$/.exec(row);
    if (hit !== null) lines.push([Number(hit[1]), hit[2]]);
  }
  return lines.length > 0 ? [{ raw: null, lines }] : null;
}

const grouped = () => {
  const groups = new Map();
  return {
    add(raw, number, text) {
      if (!groups.has(raw)) groups.set(raw, []);
      groups.get(raw).push([number, text]);
    },
    result: () => (groups.size > 0 ? [...groups].map(([raw, lines]) => ({ raw, lines })) : null),
  };
};

// A grep hit with its path in front: `path:12:text`.
function prefixedHits(text) {
  const hits = grouped();
  for (const row of text.split('\n')) {
    const hit = /^(.+?):(\d+):(.*)$/.exec(row);
    if (hit !== null && /[\\/]|\.[A-Za-z0-9]+$/.test(hit[1])) hits.add(hit[1], Number(hit[2]), hit[3]);
  }
  return hits.result();
}

// A grep result in sections: a line with a path, then its hits as `Line 12: text`.
function sectionHits(text) {
  const hits = grouped();
  let current = null;
  for (const row of text.split('\n')) {
    const hit = /^Line (\d+):(?: (.*))?$/.exec(row);
    if (hit !== null) {
      if (current !== null) hits.add(current, Number(hit[1]), hit[2] ?? '');
    } else if (row !== '' && !/^Found \d+ /.test(row)) {
      current = row;
    }
  }
  return hits.result();
}

const RESULT_FORMATS = [
  ['dsh read', dshReadEnvelope],
  ['numbered read', numberedRead],
  ['path-prefixed hits', prefixedHits],
  ['sectioned hits', sectionHits],
];

// ── Shell commands ───────────────────────────────────────────────────────────
// A command that shows or writes one file, whatever the tool is called. Anything compound is left alone.

function shellFiles(command) {
  const cat = new RegExp(String.raw`^\s*cat\s+(-n\s+)?(?:--\s+)?${SHELL_WORD}\s*$`).exec(command);
  if (cat !== null) return { shows: { raw: unquote(cat[2]), from: 1, whole: cat[1] === undefined, numbered: cat[1] !== undefined } };
  const head = new RegExp(String.raw`^\s*head\s+(?:-n\s*\d+|-\d+)\s+${SHELL_WORD}\s*$`).exec(command);
  if (head !== null) return { shows: { raw: unquote(head[1]), from: 1, whole: false, numbered: false } };
  const sed = new RegExp(String.raw`^\s*sed\s+-n\s+'(\d+)(?:,\d+)?p'\s+${SHELL_WORD}\s*$`).exec(command);
  if (sed !== null) return { shows: { raw: unquote(sed[2]), from: Number(sed[1]), whole: false, numbered: false } };
  const into = new RegExp(String.raw`^\s*(?:cat\s*>>?\s*|tee\s+(?:-a\s+)?)${SHELL_WORD}\s*<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\3\s*$`)
    .exec(command);
  if (into !== null) return { writes: { raw: unquote(into[1]), text: into[4] } };
  const from = new RegExp(String.raw`^\s*cat\s*<<-?\s*(['"]?)(\w+)\1\s*>>?\s*${SHELL_WORD}\s*\n([\s\S]*?)\n\2\s*$`).exec(command);
  if (from !== null) return { writes: { raw: unquote(from[3]), text: from[4] } };
  return {};
}

// ── Operations ───────────────────────────────────────────────────────────────
// What one call says about files, in the order it says it: `place` puts lines at their numbers, `whole` is a file's
// whole text, `edit` replaces text.

function operationsOf(pair) {
  const input = pair.input ?? {};
  const name = String(pair.name ?? '').toLowerCase();
  const target = stringOf(input, ['file_path', 'path', 'filePath']);
  const operations = [];
  const formats = [];

  // Written text. A failed call wrote nothing.
  if (pair.isError !== true) {
    if (name === 'write' && typeof input.content === 'string' && target !== null) {
      operations.push({ kind: 'whole', raw: target, lines: linesOfText(input.content) });
    } else if (name === 'edit' && typeof input.new_string === 'string' && target !== null) {
      operations.push({ kind: 'edit', raw: target, oldString: input.old_string, newString: input.new_string });
    } else if (name === 'multiedit' && Array.isArray(input.edits) && target !== null) {
      for (const edit of input.edits) {
        if (typeof edit?.new_string === 'string') {
          operations.push({ kind: 'edit', raw: target, oldString: edit.old_string, newString: edit.new_string });
        }
      }
    } else if (typeof input.command === 'string') {
      const { writes } = shellFiles(input.command);
      if (writes) operations.push({ kind: 'whole', raw: writes.raw, lines: linesOfText(writes.text) });
    }
  }

  // Shown text.
  const text = pair.isError === true ? '' : sideTextOf(pair.result);
  const shell = typeof input.command === 'string' ? shellFiles(input.command) : {};
  if (shell.shows) {
    const rows = linesOfText(text);
    const numbered = shell.shows.numbered ? numberedRead(text) : null;
    if (numbered) {
      operations.push({ kind: 'place', raw: shell.shows.raw, lines: numbered[0].lines });
      formats.push('numbered read');
    } else if (rows.length > 0) {
      const from = shell.shows.from;
      const lines = rows.map((row, index) => [from + index, row]);
      operations.push(shell.shows.whole
        ? { kind: 'whole', raw: shell.shows.raw, lines: rows }
        : { kind: 'place', raw: shell.shows.raw, lines });
      formats.push('shell show');
    }
  } else {
    for (const [label, recognize] of RESULT_FORMATS) {
      const groups = recognize(text);
      if (groups === null) continue;
      for (const group of groups) {
        const raw = group.raw ?? target;
        if (raw !== null) operations.push({ kind: 'place', raw, lines: group.lines });
      }
      formats.push(label);
      break;
    }
  }
  return { operations, formats };
}

// ── One file ─────────────────────────────────────────────────────────────────

// The lines of a file as the transcript has shown them: `null` is a line nothing named.
function createSketch() {
  let lines = [];
  return {
    place(number, text) {
      while (lines.length < number) lines.push(null);
      lines[number - 1] = text;
    },
    whole(next) {
      lines = [...next];
    },
    // The old text where the file shows it as lines, or inside one line; else the new text is appended, because the
    // transcript has not shown where it went.
    edit(oldString, newString) {
      const oldLines = typeof oldString === 'string' && oldString !== '' ? linesOfText(oldString) : [];
      const newLines = newString === '' ? [] : linesOfText(newString);
      for (let at = 0; oldLines.length > 0 && at + oldLines.length <= lines.length; at++) {
        if (oldLines.every((line, offset) => lines[at + offset] === line)) {
          lines.splice(at, oldLines.length, ...newLines);
          return;
        }
      }
      if (oldLines.length === 1) {
        const at = lines.findIndex(line => line !== null && line.includes(oldString));
        if (at !== -1) {
          lines.splice(at, 1, ...linesOfText(lines[at].replace(oldString, newString)));
          return;
        }
      }
      lines.push(...newLines);
    },
    text: () => `${lines.map(line => line ?? '').join('\n')}\n`,
    size: () => lines.filter(line => line !== null).length,
    isEmpty: () => lines.length === 0,
  };
}

// ── The tree ─────────────────────────────────────────────────────────────────

/**
 * The tree a session's own evidence matches: `{ files, stats }`, `files` as `{ <absolute path>: <content> }` in path
 * order, `stats` the counts the tree came from.
 * @param {{ harness: string, cwd: ?string, observations: object[] }} session as `readSession` answers
 */
export function synthesizeWorkingTree({ harness, cwd, observations }) {
  const { resolve } = createMemoryWorkingTree({ files: {}, path: pathFlavorOf(cwd), homeDir: null });
  const sketches = new Map();
  const stats = { pairs: 0, contributing: 0, formats: {}, skipped: { homeRelative: 0, unresolved: 0, lineBeyondLimit: 0 } };

  for (const fold of projectDialogue(observations).folds) {
    for (const pair of fold.toolPairs) {
      stats.pairs++;
      const base = typeof pair.cwd === 'string' && pair.cwd !== '' ? pair.cwd : cwd;
      const { operations, formats } = operationsOf(pair);
      let applied = false;
      for (const operation of operations) {
        // The recorder's home directory is not this machine's, so a path under it names no file here. DSH's `~` is
        // an ordinary directory name, which resolves like any other.
        if (harness === 'claude-code' && (operation.raw === '~' || operation.raw.startsWith('~/'))) {
          stats.skipped.homeRelative++;
          continue;
        }
        const key = resolve(base, operation.raw);
        if (key === null) {
          stats.skipped.unresolved++;
          continue;
        }
        if (!sketches.has(key)) sketches.set(key, createSketch());
        const sketch = sketches.get(key);
        if (operation.kind === 'whole') sketch.whole(operation.lines);
        else if (operation.kind === 'edit') sketch.edit(operation.oldString, operation.newString);
        else {
          for (const [number, text] of operation.lines) {
            if (number < 1 || number > MAX_LINE) stats.skipped.lineBeyondLimit++;
            else sketch.place(number, text);
          }
        }
        applied = true;
      }
      if (applied) stats.contributing++;
      for (const format of formats) stats.formats[format] = (stats.formats[format] ?? 0) + 1;
    }
  }

  const files = {};
  for (const key of [...sketches.keys()].sort()) {
    const sketch = sketches.get(key);
    if (!sketch.isEmpty()) files[key] = sketch.text();
  }
  const lines = [...sketches.values()].reduce((sum, sketch) => sum + sketch.size(), 0);
  return { files, stats: { harness, files: Object.keys(files).length, lines, ...stats } };
}

// ── Command line ─────────────────────────────────────────────────────────────

const USAGE = 'usage: node scripts/synthesize-working-tree.mjs <session log> [--out FILE]';

function parseArgs(argv) {
  const options = { log: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      options.out = argv[++i];
      if (options.out === undefined) throw new Error('--out needs a value');
    } else if (argv[i].startsWith('-') || options.log !== null) {
      throw new Error(`unexpected argument ${argv[i]}`);
    } else {
      options.log = argv[i];
    }
  }
  if (options.log === null) throw new Error('no session log given');
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const { files, stats } = synthesizeWorkingTree(readSession(readFileSync(options.log)));
  const body = `${JSON.stringify(files, null, 2)}\n`;
  if (options.out === null) {
    process.stdout.write(body);
  } else {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, body);
  }
  console.error(JSON.stringify(stats));
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
