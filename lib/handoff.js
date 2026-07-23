import { posix } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
    const bg = cjkBigrams(t);
    if (bg) parts.push(...bg.split(' ').map(b => `"${b.replace(/"/g, '')}"`));
    else parts.push(`"${t.replace(/"/g, '')}"`);
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
