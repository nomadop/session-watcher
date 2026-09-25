// lib/handoff.js — Handoff Composition: the application helper that turns one measurement snapshot plus a
// producer's keep list into the payload a handoff row stores, and one stored row back into the package a
// consumer reads.
//
// It owns kept-to-bucket identity binding, line injection, selected-line counts, bucket snapshot assembly,
// search terms, stored payload projection, and the wording a handoff answers with. Every filesystem, hash,
// clock and token-randomness capability is injected, so the composition is drivable without a real project
// tree and reads nothing else from the process.
import { posix, isAbsolute, join, normalize, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomInt as cryptoRandomInt } from 'node:crypto';
import { nucleus } from './landmarks.js';
import { computeMovableFrac, computeBr, computePp } from './bill-regret.js';
import { charsToTokens } from './token-estimate.js';
import {
  HANDOFF_MAX_PATHS, HANDOFF_MAX_SUMMARY_CHARS, HANDOFF_MAX_NEXT_TASK_CHARS,
  HANDOFF_TOKEN_MAX_RETRIES, HANDOFF_HOOK_TASK_PREVIEW_CHARS, DEFAULT_CTP,
} from './constants.js';

export const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can','need','must','let','to',
  'of','in','for','on','with','at','by','from','as','into','through','during','before','after',
  'above','below','between','under','over','out','up','down','off','then','once','here','there',
  'when','where','why','how','all','each','every','both','few','more','most','other','some','such',
  'no','not','only','own','same','so','than','too','very','just','because','but','and','or','if',
  'while','about','this','that','these','those','it','its','i','we','they','them','my','our','your',
  'his','her','what','which','implement','add','fix','update','refactor','create','make','use',
  'using','new','file','code','function','method',
]);

// 256 short concrete nouns — memorable, distinct, pronounceable, non-offensive.
export const SUFFIX_WORDS = [
  // animals (40)
  'fox','owl','elk','hare','wren','lynx','seal','moth','crab','toad',
  'hawk','deer','bass','crow','dove','frog','goat','lark','mule','newt',
  'puma','slug','swan','wasp','wolf','bear','colt','duck','finch','heron',
  'orca','pike','robin','stoat','crane','grebe','egret','bison','raven','shark',
  // colors (24)
  'blue','jade','rust','teal','plum','gold','ruby','sage','amber','coral',
  'ivory','peach','blush','azure','cedar','onyx','opal','mauve','wine','lilac',
  'mocha','khaki','cream','ebony',
  // materials (24)
  'iron','oak','clay','silk','tin','wax','jute','lime','flint','steel',
  'brass','hemp','linen','glass','stone','slate','pine','birch','maple','ash',
  'wool','suede','tweed','balsa',
  // weather & sky (24)
  'rain','mist','dusk','dawn','snow','hail','gale','frost','storm','sleet',
  'fog','cloud','dew','blaze','lunar','solar','comet','flare','wind','north',
  'south','east','west','gust',
  // nature & terrain (40)
  'reef','dune','moss','fern','peak','cove','glen','bay','cliff','ridge',
  'creek','lake','pond','marsh','brook','grove','vale','knoll','bluff','ledge',
  'shoal','delta','gorge','field','trail','basin','heath','scrub','peat','ford',
  'cape','isle','spur','mesa','falls','inlet','shore','gully','atoll','fjord',
  // food & plants (24)
  'mint','fig','plumb','seed','root','herb','grain','berry','olive','mango',
  'basil','thyme','pecan','cocoa','clove','acorn','gourd','kelp','lotus','tulip',
  'poppy','daisy','ivy','palm',
  // tools & objects (24)
  'axle','gear','reel','bell','lens','flag','coin','rope','knot','ring',
  'lamp','nail','hook','arch','hinge','lever','wheel','valve','gauge','lathe',
  'anvil','wedge','clamp','prism',
  // shapes & concepts (24)
  'cube','node','grid','mesh','link','loop','dome','arc','span','tier',
  'slab','core','edge','axis','plane','helix','facet','nexus','orbit','pulse',
  'surge','flux','drift','spark',
  // music & sound (16)
  'harp','lute','flute','horn','chime','tempo','chord','fife','lyric','hymn',
  'tune','note','gong','viola','cello','oboe',
  // misc (16)
  'latch','quill','torch','flask','pouch','staff','crown','badge','crest','manor',
  'forge','vault','haven','guild','helm','craft',
];

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /^[A-Z_]{2,}=[^\s]{4,}$/gm,
];

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

export function generateLoadToken(summary, nextTask, randomInt) {
  const source = (nextTask && nextTask.trim()) || String(summary || '').split('\n')[0] || '';
  const words = (source.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])
    .filter(w => !STOP_WORDS.has(w) && w.length > 3)
    .slice(0, 2);
  // R1-G: pad to exactly 2 leading words
  while (words.length < 2) words.push(SUFFIX_WORDS[randomInt(SUFFIX_WORDS.length)]);
  const suffix = SUFFIX_WORDS[randomInt(SUFFIX_WORDS.length)];
  return [...words, suffix].join('-').toLowerCase();
}

export function normalizeKeepPath(p, projectDir) {
  const raw = String(p || '').replace(/\\/g, '/');
  const norm = posix.normalize(raw);
  if (norm.startsWith('..') || norm.split('/').includes('..'))
    return { path: norm, invalid: true };
  // Absolute path under projectDir → relativize
  if (projectDir && norm.startsWith('/')) {
    const pd = projectDir.replace(/\/+$/, '');
    if (norm === pd || norm.startsWith(pd + '/'))
      return { path: norm.slice(pd.length + 1) || '.', invalid: false };
    // Absolute but outside project → keep as-is, mark external
    return { path: norm, invalid: false, external: true };
  }
  // Absolute path, no projectDir to compare → external
  if (norm.startsWith('/'))
    return { path: norm, invalid: false, external: true };
  // Already relative — strip any leading / that survived (shouldn't, but defensive)
  return { path: norm.replace(/^\/+/, ''), invalid: false };
}

const isCjk = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x3400 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF);
};

export function cjkBigrams(text) {
  const out = [];
  const s = String(text || '');
  let run = '';
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of s) { if (isCjk(ch)) run += ch; else flush(); }
  flush();
  return out.join(' ');
}

export function buildFtsMatch(query, mode = 'plain') {
  const q = String(query || '');
  if (mode === 'advanced') return q;
  const terms = q.split(/\s+/).filter(Boolean);
  const parts = [];
  for (const t of terms) {
    // Split t into maximal same-script segments so every segment contributes tokens. Without
    // segmentation a mixed-script term would take the CJK branch whole and its non-CJK run would be
    // dropped in silence — the expression would match on CJK bigrams alone, leaving the Latin half
    // with no constraint against the index.
    let seg = '', segCjk = null;
    const emit = (s, isCjkSeg) => {
      const bg = isCjkSeg && cjkBigrams(s);
      if (bg) parts.push(...bg.split(' ').map(b => `"${b.replace(/"/g, '')}"`));
      // A segment that yields no bigrams — a non-CJK segment, or a CJK segment too short to pair —
      // falls back to its quoted text, because an empty FTS5 MATCH expression is a syntax error rather
      // than an empty result: a query made only of such segments has to come back a miss, not a throw.
      else parts.push(`"${s.replace(/"/g, '')}"`);
    };
    for (const ch of t) {
      const c = isCjk(ch);
      if (segCjk === null) { seg = ch; segCjk = c; }
      else if (c !== segCjk) { emit(seg, segCjk); seg = ch; segCjk = c; }
      else seg += ch;
    }
    if (seg) emit(seg, segCjk);
  }
  return parts.join(' ');
}

// Max bytes hashFileContent will read. Carried paths come from the agent's own prepare call, and
// normalizeKeepPath lets ABSOLUTE external paths through (only `..` is rejected) — so without a guard
// a kept `/dev/zero` or a multi-GB/binary file would make readFileSync buffer unboundedly and OOM the
// MCP process (which also hosts the dashboard). 8 MB comfortably covers real source files.
export const HASH_MAX_BYTES = 8 * 1024 * 1024;

// sha256 hex of a file's bytes. Returns null on ANY fs error (ENOENT, permission), on a NON-REGULAR
// file (device/fifo/dir — never read it), or on a file over HASH_MAX_BYTES — so a missing/unreadable/
// pathological carried path never aborts prepare/load and never hangs the process. The caller treats
// null as "not-comparable" telemetry (spec decision 6 degradation). The statSync gate runs BEFORE any
// read, so an over-cap or special file is never buffered. (Chunked/streaming hashing of huge files is
// deliberately out of scope — ≤50 source-file carries; see §Considered & rejected.)
export function hashFileContent(absPath) {
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return null;
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

// ── Handoff Composition ──────────────────────────────────────────────────────

// The agent sees only what it needs to reload a file. Every per-entry telemetry key stays server-side —
// the stored row keeps the full record, and projection is RESPONSE-only.
const AGENT_ENTRY_KEYS = ['path', 'symbols', 'lines', 'symbolRanges', 'resolvedSymbols'];

function projectEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = {};
  for (const key of AGENT_ENTRY_KEYS) if (entry[key] !== undefined) out[key] = entry[key];
  return out;
}

// The absolute, forward-slashed form of one resource path. A bucket key is already in this form, so applying
// it again is idempotent; a project-relative kept path becomes comparable to one.
function canonicalResourcePath(rawPath, base) {
  let p = rawPath;
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
  const abs = isAbsolute(p) ? p : resolvePath(base || '/', p);
  return normalize(abs).split('\\').join('/');
}

// Sorted inclusive [start, end] runs over a line-number set.
function collapseLineRanges(lineNumbers) {
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= end + 1) { end = sorted[i]; continue; }
    ranges.push([start, end]);
    start = sorted[i];
    end = sorted[i];
  }
  ranges.push([start, end]);
  return ranges;
}

const flatRanges = (ranges) => ranges.map(([a, b]) => `${a}-${b}`).join(', ');

/**
 * Handoff Composition.
 *
 * @param {{ readBytes?: function, statFile?: function, hashFile?: function,
 *           now?: function, randomInt?: function }} capabilities
 */
export function createHandoffComposition({
  readBytes = (absPath) => readFileSync(absPath),
  statFile = statSync,
  hashFile = hashFileContent,
  now = Date.now,
  randomInt = (bound) => cryptoRandomInt(bound),
} = {}) {

  // Logical line count without allocating a UTF-8 string or array, gated on the same cap hashing uses so a
  // binary, huge or special file is never buffered. A file ending in a newline is not inflated by it.
  function countFileLinesBounded(absPath) {
    try {
      const stat = statFile(absPath);
      if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return null;
      if (stat.size === 0) return 0;
      const buffer = readBytes(absPath);
      let newlines = 0;
      for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0A) newlines++;
      return buffer[buffer.length - 1] === 0x0A ? newlines : newlines + 1;
    } catch { return null; }
  }

  /**
   * One prepared handoff: the row a Store write takes and the response the producer reads.
   *
   * @param {{ input: object, measurement: object, filePaths: object[], ctp: object,
   *           projectRoot: string|null, symbolRangesFor: function, rateForKept: function }} request
   *   `rateForKept(keptKeys)` answers the growth rate of the scenario that carries exactly the kept file
   *   resources, or 0 when no such scenario can be read.
   * @returns {{ status: 'error', error: string }
   *          | { row: object, response: object, resolvedPaths: object[], tokenSeed: object }}
   */
  function composePrepared({ input, measurement, filePaths, ctp, projectRoot, symbolRangesFor, rateForKept }) {
    const { pathsToKeep = [], skillsToKeep, summary = '', nextTask = null } = input ?? {};
    if (!Array.isArray(pathsToKeep)) return { status: 'error', error: 'invalid_paths_to_keep' };
    if (pathsToKeep.length > HANDOFF_MAX_PATHS) {
      return { status: 'error', error: 'too_many_paths', max_paths: HANDOFF_MAX_PATHS, actual_paths: pathsToKeep.length };
    }
    if (typeof summary !== 'string' || summary.length === 0) return { status: 'error', error: 'summary_required' };
    if (summary.length > HANDOFF_MAX_SUMMARY_CHARS) {
      return {
        status: 'error', error: 'summary_too_long', max_chars: HANDOFF_MAX_SUMMARY_CHARS,
        actual_chars: summary.length, instruction: 'Compress the summary and call prepare_handoff again.',
      };
    }
    if (nextTask != null && String(nextTask).length > HANDOFF_MAX_NEXT_TASK_CHARS) {
      return {
        status: 'error', error: 'next_task_too_long', max_chars: HANDOFF_MAX_NEXT_TASK_CHARS,
        actual_chars: String(nextTask).length,
      };
    }

    // Redact FIRST: a secret must never reach the token, the search terms, or the stored row.
    const redSummary = redactSecrets(summary);
    const redNext = nextTask != null ? redactSecrets(String(nextTask)) : null;

    // The candidate universe, frozen server-side. Every candidate is persisted un-truncated because a
    // truncated set would leave a stored `bucket_id` dangling; only a candidate a kept path resolves to pays
    // for canonicalization and a stat, which bounds the cost by the kept-path count.
    const snapshotPaths = filePaths.map((row, index) => ({
      id: 'b' + index,
      raw_path: row.path,
      canonical_path: null,
      whole_ctp: row.tokens,     // a scope-labelled estimate, not a bound
      whole_bytes: null,
      lastTurn: row.lastTurn ?? null,
    }));

    const invalidPaths = [];
    const unknownPaths = [];
    const keptEntries = [];
    const seenPaths = new Set();
    for (const raw of pathsToKeep) {
      if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') { invalidPaths.push(raw); continue; }
      const { path, invalid } = normalizeKeepPath(raw.path, projectRoot);
      if (invalid) { invalidPaths.push(raw); continue; }
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      const symbols = Array.isArray(raw.symbols) ? raw.symbols.filter(name => typeof name === 'string') : undefined;
      keptEntries.push({ path, symbols: symbols && symbols.length ? symbols : undefined });
    }

    // Kept↔bucket identity is bound ONCE, here, and never re-guessed by suffix offline. An exact match wins
    // outright, so a path that exact-matches one candidate and suffix-matches another is not ambiguous.
    const canonicalBase = projectRoot || process.cwd();
    const keptCanon = (relative) => canonicalResourcePath(relative, canonicalBase);
    for (const entry of keptEntries) {
      const absolute = keptCanon(entry.path);
      const exact = snapshotPaths.filter(candidate =>
        candidate.canonical_path === absolute || candidate.raw_path === absolute || candidate.raw_path === entry.path);
      const suffix = snapshotPaths.filter(candidate =>
        (candidate.canonical_path && candidate.canonical_path.endsWith('/' + entry.path))
        || candidate.raw_path.endsWith('/' + entry.path));
      const matches = exact.length ? exact : suffix;
      // Hash the MATCHED candidate's physical file, never a rebuilt `projectRoot/entry.path`: on a unique
      // suffix match the file to hash is that candidate, and a rebuilt path may name a third file.
      let hashTarget = null;
      if (matches.length === 1) {
        entry.bucket_id = matches[0].id;
        entry.match_status = 'exact';
        if (matches[0].canonical_path == null) matches[0].canonical_path = keptCanon(matches[0].raw_path);
        if (matches[0].whole_bytes == null) {
          try { const stat = statFile(matches[0].canonical_path); if (stat.isFile()) matches[0].whole_bytes = stat.size; }
          catch { /* leave null */ }
        }
        hashTarget = matches[0].canonical_path;
      } else if (matches.length > 1) {
        entry.bucket_id = null;
        entry.match_status = 'ambiguous';
        entry.candidate_bucket_ids = matches.map(candidate => candidate.id);
        // No single physical file is authoritative, and a guessed one would be a valid-looking hash of the
        // WRONG identity. Offline comparison uses each candidate's own `whole_bytes` instead.
      } else {
        entry.bucket_id = null;
        entry.match_status = 'unmatched';
      }
      entry.hp = hashTarget ? hashFile(hashTarget) : null;
      entry.total_line_count = hashTarget ? countFileLinesBounded(hashTarget) : null;
    }

    // Kept tokens against the resident file rows, resolving a suffix collision to the most recently active.
    const known = new Map(filePaths.map(row => [row.path, { tokens: row.tokens, lastTurn: row.lastTurn }]));
    const resolvedPaths = [];
    const keptKeys = [];
    let keptTokens = 0;
    for (const entry of keptEntries) {
      const matches = [];
      for (const [key, info] of known) {
        if (key === entry.path || key.endsWith('/' + entry.path)) matches.push({ key, ...info });
      }
      if (matches.length > 1) {
        matches.sort((a, b) => b.lastTurn - a.lastTurn);
        keptTokens += matches[0].tokens;
        keptKeys.push(matches[0].key);
        resolvedPaths.push({ from: entry.path, to: matches[0].key });
      } else if (matches.length === 1) {
        keptTokens += matches[0].tokens;
        keptKeys.push(matches[0].key);
      } else {
        unknownPaths.push(entry.path);
      }
    }

    // Line ranges and symbol ranges, both from the resource's OWN coverage. Symbol ranges take one
    // unconditional route — a whole-content resource holds every line it was read with, so its coverage is
    // the lines the READ saw, and the ranges are computed against those rather than against whatever the file
    // has grown to since. The file's TEXT is read now while the coverage is from then: code from now,
    // coverage from then. Only the `entry.lines` injection is gated on the whole-content flag.
    for (const entry of keptEntries) {
      const row = filePaths.find(candidate => candidate.path === entry.path)
        ?? filePaths.find(candidate => candidate.path.endsWith('/' + entry.path));
      if (!row) continue;
      const lineNumbers = Array.isArray(row.lineNumbers) ? row.lineNumbers : [];
      if (!row.fullSnapshot && lineNumbers.length > 0) entry.lines = collapseLineRanges(lineNumbers);
      if (entry.symbols && entry.symbols.length > 0) {
        const ranges = symbolRangesFor({ path: row.path, symbols: entry.symbols, lineNumbers });
        if (ranges && Object.keys(ranges).length > 0) {
          entry.symbolRanges = ranges;
          delete entry.symbols;      // replaced by the richer form
        }
      }
    }

    for (const entry of keptEntries) {
      if (Array.isArray(entry.lines) && entry.lines.length > 0) {
        // The ranges are already disjoint and sorted, so summing the inclusive spans double-counts nothing.
        entry.selected_line_count = entry.lines.reduce((n, [a, b]) => n + (b - a + 1), 0);
      } else if (entry.symbolRanges && typeof entry.symbolRanges === 'object') {
        const allRanges = Object.values(entry.symbolRanges).flat().sort((a, b) => a[0] - b[0]);
        let count = 0;
        let prevEnd = -1;
        for (const [a, b] of allRanges) {
          const start = Math.max(a, prevEnd + 1);
          if (start <= b) count += b - start + 1;
          prevEnd = Math.max(prevEnd, b);
        }
        entry.selected_line_count = count;
      } else {
        entry.selected_line_count = entry.total_line_count ?? null;   // a whole-file carry
      }
    }

    // Serialized only now: the identity loop above lazily filled `canonical_path` and `whole_bytes` on the
    // kept-matched candidates, and those must be inside the JSON.
    const bucketSnapshot = JSON.stringify({
      v: 1, ctp_version: ctp.version, root: projectRoot || null,
      total_candidates: snapshotPaths.length, paths: snapshotPaths,
    });

    let allPathTokens = 0;
    for (const row of filePaths) allPathTokens += row.tokens || 0;
    const discardedTokens = Math.max(0, allPathTokens - keptTokens);

    const m = measurement.measurement;
    const summaryTokens = Math.round(charsToTokens(redSummary, ctp || DEFAULT_CTP));
    const bDefault = (m.B > 0 && m.cRatio > 0) ? m.bDefault : m.B;
    const dead = m.dead;
    const sessionFloor = m.sessionFloor || dead;
    const previousStats = {
      b_full: m.B, b_default: bDefault, g: m.gBar, mf: m.mf, br_exit: m.br,
      pp_exit: m.pp, turns: measurement.turnSeq, total_l: m.L,
      dead, session_floor: sessionFloor, residual: Math.max(0, m.L - m.B),
    };
    // An instantaneous-position what-if over the KEPT bucket: x is L over the kept baseline and dhat, br and
    // pp follow from that single endpoint, so these are not comparable with `previousStats`' `br_exit`/
    // `pp_exit`, which the fold accumulated along the path the segment actually travelled. The rate is the
    // scenario that carries the kept files and leaves every other file as excess; skills stay at their default
    // selection there, so their growth is not excess even though the kept baseline counts no skill tokens.
    // The session floor is the next segment's always-present overhead. It coincides with `dead` now that the
    // anchor takes the whole first-step stock; the fallback reads a measurement written before it did.
    const bKept = keptTokens > 0 ? keptTokens + sessionFloor : null;
    const preparedStats = (bKept && m.cRatio > 0) ? (() => {
      const gKept = rateForKept(keptKeys);
      const dhatKept = nucleus(m.cRatio, gKept, bKept);
      const mfKept = computeMovableFrac(m.cRatio, bKept, gKept);
      const xKept = m.L / bKept;
      const brKept = (dhatKept > 0 && Number.isFinite(mfKept)) ? computeBr(xKept, dhatKept, mfKept) : null;
      return { b_kept: bKept, dead, session_floor: sessionFloor, g: gKept, mf: mfKept, br: brKept, pp: computePp(xKept, dhatKept), dhat: dhatKept, x: xKept };
    })() : null;

    const searchTerms = [cjkBigrams(redSummary), redNext ? cjkBigrams(redNext) : ''].filter(Boolean).join(' ');
    const keptSkills = Array.isArray(skillsToKeep)
      ? [...new Set(skillsToKeep.filter(name => typeof name === 'string' && name.length > 0))]
      : [];
    const pathsPayload = JSON.stringify(keptSkills.length ? { paths: keptEntries, skills: keptSkills } : keptEntries);

    return {
      row: {
        pathsToKeep: pathsPayload, summary: redSummary, nextTask: redNext,
        summaryTokens, keptTokens, discardedTokens, preparedAtTurn: measurement.turnSeq,
        previousStats: JSON.stringify(previousStats),
        preparedStats: preparedStats ? JSON.stringify(preparedStats) : null,
        searchTerms, bucketSnapshot,
      },
      response: {
        kept_paths: keptEntries.length, kept_tokens: keptTokens, discarded_tokens: discardedTokens,
        summary_tokens: summaryTokens, unknown_paths: unknownPaths, invalid_paths: invalidPaths,
      },
      resolvedPaths,
      tokenSeed: { summary: redSummary, nextTask: redNext },
    };
  }

  // Every token the insert path may try, in order. A UNIQUE collision is the only reason a later one is
  // reached, so the sequence is finite and the caller reports exhaustion rather than looping.
  function* candidateTokens(tokenSeed) {
    for (let attempt = 0; attempt < HANDOFF_TOKEN_MAX_RETRIES; attempt++) {
      yield generateLoadToken(tokenSeed.summary, tokenSeed.nextTask, randomInt);
    }
  }

  const instructionFor = (loadToken) => `Handoff prepared. Token: ${loadToken}. Please /clear when ready.`;

  const searchExpression = (query, queryMode) => buildFtsMatch(String(query ?? ''), queryMode === 'advanced' ? 'advanced' : 'plain');

  function searchResponse(results) {
    if (!results.length) return { found: false };
    return {
      found: true, mode: 'search',
      results: results.map(row => ({
        load_token: row.loadToken, created_at: row.createdAt, next_task: row.nextTask,
        summary_preview: row.summaryPreview,
      })),
      instruction: 'Multiple matches. Call load_handoff with the desired load_token for the full package.',
    };
  }

  // The auto-match ambiguity list: this project has more than one undelivered handoff, so none of them may
  // be stamped and the caller names one instead.
  function ambiguityResponse(rows) {
    return {
      found: false, ambiguous: true,
      candidates: rows.map(row => ({
        load_token: row.loadToken, created_at: row.createdAt,
        next_task_preview: row.nextTask ? row.nextTask.slice(0, HANDOFF_HOOK_TASK_PREVIEW_CHARS) : null,
      })),
    };
  }

  // Where each stored symbol range sits now, as the lines a consumer reads. A stale name keeps the lines it
  // was stored under, so the consumer can still find what moved.
  function renderResolution(storedRanges, facts) {
    const stored = Object.entries(storedRanges);
    if (!facts.parsed) {
      return stored.map(([name, ranges]) => `${name} — parser not ready; originally at lines ${flatRanges(ranges)}`);
    }
    if (!facts.readable) {
      return stored.map(([name, ranges]) => `${name} — file removed; originally at lines ${flatRanges(ranges)}`);
    }
    if (facts.resolved.length === 0 && facts.stale.length > 0) {
      const allNames = facts.stale.map(entry => entry.name).join(', ');
      return [`⚠️ all symbols stale (${allNames}) — file may have been refactored`].concat(
        facts.stale.map(({ name, storedRanges: ranges }) => `${name} — symbol not found; originally at lines ${flatRanges(ranges)}`));
    }
    const output = [];
    for (const { name, startLine, endLine } of facts.resolved) output.push(`${name} (lines ${startLine}-${endLine})`);
    for (const { name, storedRanges: ranges } of facts.stale) {
      output.push(`${name} — symbol not found in current file; originally at lines ${flatRanges(ranges)}`);
    }
    return output;
  }

  /**
   * One stored handoff row as the package a consumer reads.
   *
   * @param {object} row detached handoff row
   * @param {{ resolveSymbols: function }} capabilities
   * @returns {Promise<object>}
   */
  async function projectDelivered(row, { resolveSymbols }) {
    let parsed;
    // A single corrupt row must not take the whole operation down.
    try { parsed = JSON.parse(row.pathsToKeep || '{}'); }
    catch { return { found: false, status: 'error', error: 'corrupt_handoff' }; }
    const rawPaths = Array.isArray(parsed) ? parsed : (parsed.paths || []);
    const paths = [];
    for (const entry of Array.isArray(rawPaths) ? rawPaths : []) {
      const projected = projectEntry(entry);
      if (entry.symbolRanges && typeof entry.symbolRanges === 'object') {
        const facts = entry.path
          ? await resolveSymbols({ path: entry.path, symbolRanges: entry.symbolRanges, projectDir: row.projectId })
          : null;
        projected.resolvedSymbols = facts ? renderResolution(entry.symbolRanges, facts) : [];
        delete projected.symbolRanges;   // the agent sees resolved output, not raw ranges
      }
      paths.push(projected);
    }
    const skills = Array.isArray(parsed) ? undefined : (parsed.skills?.length ? parsed.skills : undefined);
    const out = {
      found: true, handoff_id: row.handoffId, load_token: row.loadToken, created_at: row.createdAt,
      summary: row.summary, paths_to_keep: paths,
    };
    if (row.projectId) out.project_dir = row.projectId;
    if (skills) out.skills_to_keep = skills;
    return out;
  }

  /**
   * The stored payload with each kept path re-hashed on THIS machine, or null when nothing needs stamping.
   *
   * A `hl` already present — the legitimate null of an unreadable file included — counts as stamped, so a
   * retry never re-hashes what was already judged not-comparable.
   *
   * @param {object} row detached handoff row
   * @param {{ projectRoot: string|null, force: boolean }} options
   * @returns {string|null} the JSON to store
   */
  function stampLoadHashes(row, { projectRoot, force }) {
    let payload;
    try { payload = JSON.parse(row.pathsToKeep || 'null'); } catch { return null; }
    const entries = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.paths) ? payload.paths : null);
    if (!entries) return null;
    const missing = entries.some(entry => entry && typeof entry.path === 'string' && !('hl' in entry));
    if (!force && !missing) return null;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string') continue;
      entry.hl = hashFile(resolvePath(projectRoot || process.cwd(), entry.path));
    }
    return JSON.stringify(payload);
  }

  return {
    composePrepared,
    candidateTokens,
    createdAt: () => now(),
    instructionFor,
    searchExpression,
    searchResponse,
    ambiguityResponse,
    projectDelivered,
    stampLoadHashes,
    countFileLinesBounded,
  };
}
