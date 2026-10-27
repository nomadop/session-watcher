// lib/working-tree.js — the Working Tree port: the only way Resource Attribution reads the files a
// session worked on. A tree answers three synchronous questions — `resolve(base, raw)`, `stat(path)` and
// `readText(path)` — and owns the path namespace: which path operations apply and whether a leading `~`
// is the home directory or a directory named `~`.
//
// Both adapters share one `resolve`, so a path spelled the same way gets the same key in the Dialogue and
// the Measurement halves. Keys are normalized absolute paths whose separators are all `/`: a Windows host's
// `C:\repo` becomes `C:/repo`, and a Windows-spelled relative path on a POSIX host (WSL) names the file its
// POSIX spelling names. The port is synchronous because DSH folds live frames inside a synchronous event
// callback.
//
// `stat` and `readText` never throw: a path they cannot answer, whatever the reason, is `null`, so a
// `readText` of `null` only means "not readable". Size, regular-file and binary checks belong to the caller.
import { statSync, readFileSync } from 'node:fs';

function requireBound(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Working Tree ${name} must be a finite positive number`);
  }
}

function slashed(text) {
  return text.replaceAll('\\', '/');
}

function createResolver({ path, homeDir }) {
  if (!path || typeof path.isAbsolute !== 'function' || typeof path.resolve !== 'function'
    || typeof path.normalize !== 'function') {
    throw new TypeError('Working Tree path must provide isAbsolute, resolve and normalize');
  }
  // `undefined` would silently put every `~` in the other namespace, so it is not a spelling of `null`.
  if (homeDir !== null && typeof homeDir !== 'string') {
    throw new TypeError('Working Tree homeDir must be a string or null');
  }
  return function resolve(base, raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Tilde is read from the raw spelling: `~\x` is not a home-relative path in DSH.
    let value = raw;
    if (homeDir !== null && raw === '~') value = homeDir;
    else if (homeDir !== null && raw.startsWith('~/')) value = `${homeDir}/${raw.slice(2)}`;
    // Slashes first, so `..` segments of a Windows spelling collapse on a POSIX host too.
    value = slashed(value);
    if (!path.isAbsolute(value)) {
      if (typeof base !== 'string' || base.length === 0) return null;
      const root = slashed(base);
      // A relative base would anchor to the process's working directory, which is no part of the key.
      if (!path.isAbsolute(root)) return null;
      value = path.resolve(root, value);
    }
    return slashed(path.normalize(value));
  };
}

// The cache is keyed by path and validated by `size` and `mtimeMs` (private to this adapter; no caller
// sees them). Eviction is by insertion order, oldest first, until both bounds hold.
export function createNodeWorkingTree({ path, homeDir, cacheEntries, cacheChars } = {}) {
  const resolve = createResolver({ path, homeDir });
  requireBound('cacheEntries', cacheEntries);
  requireBound('cacheChars', cacheChars);

  const cache = new Map();
  let cachedChars = 0;

  const orNull = attempt => {
    try {
      return attempt();
    } catch {
      return null;
    }
  };

  function remember(file, st, text) {
    const old = cache.get(file);
    if (old) {
      cachedChars -= old.text.length;
      cache.delete(file);
    }
    // A text over the bound would empty the cache and still not fit.
    if (text.length > cacheChars) return;
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, text });
    cachedChars += text.length;
    for (const [key, entry] of cache) {
      if (cache.size <= cacheEntries && cachedChars <= cacheChars) break;
      cache.delete(key);
      cachedChars -= entry.text.length;
    }
  }

  return {
    resolve,
    stat: file => orNull(() => {
      const st = statSync(file);
      return { size: st.size, isFile: st.isFile() };
    }),
    readText: file => orNull(() => {
      const st = statSync(file);
      if (!st.isFile()) return null;
      const hit = cache.get(file);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;
      const text = readFileSync(file, 'utf8');
      remember(file, st, text);
      return text;
    }),
  };
}

// `files` is `{ path: content }`. A path that is the directory prefix of some file answers `stat` with
// `isFile: false`, as a real directory does.
export function createMemoryWorkingTree({ files, path, homeDir } = {}) {
  const resolve = createResolver({ path, homeDir });
  const contents = new Map();
  const directories = new Set();
  for (const [spelled, content] of Object.entries(files ?? {})) {
    const key = resolve(null, spelled);
    if (key === null) throw new TypeError(`Working Tree file path is not absolute: ${spelled}`);
    if (typeof content !== 'string') throw new TypeError(`Working Tree file content is not text: ${spelled}`);
    contents.set(key, content);
    for (let at = key.indexOf('/'); at !== -1; at = key.indexOf('/', at + 1)) directories.add(key.slice(0, at) || '/');
  }

  return {
    resolve,
    stat(file) {
      if (contents.has(file)) return { size: Buffer.byteLength(contents.get(file)), isFile: true };
      if (directories.has(file)) return { size: 0, isFile: false };
      return null;
    },
    readText: file => contents.get(file) ?? null,
  };
}
