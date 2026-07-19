// NOT in lib/ — uses the `ignore` npm package (lib/ must stay dependency-free). Collects .gitignore
// files from the git root down to cwd (nested rules), returns an isIgnored(rel) => boolean callback.
// Fallback: no .gitignore anywhere / parse throws → returns null (all paths kept, no regression).
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

function findGitRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 64 && dir; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Directories from root → cwd inclusive, so nested .gitignore files layer on top of the root's.
function dirsRootToCwd(root, cwd) {
  const out = [];
  let dir = cwd;
  while (dir && dir.length >= root.length) {
    out.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function loadIsIgnored(cwd) {
  try {
    const root = findGitRoot(cwd) || cwd;
    const ig = ignore();
    let found = false;
    for (const dir of dirsRootToCwd(root, cwd)) {
      const gi = path.join(dir, '.gitignore');
      if (fs.existsSync(gi)) { ig.add(fs.readFileSync(gi, 'utf8')); found = true; }
    }
    // Also honor .git/info/exclude if present (Git's local-only ignore file).
    const exclude = path.join(root, '.git', 'info', 'exclude');
    if (fs.existsSync(exclude)) { ig.add(fs.readFileSync(exclude, 'utf8')); found = true; }
    if (!found) return null;      // no ignore rules anywhere → no regression
    // rel is relative to cwd; `ignore` expects POSIX paths relative to the .gitignore's dir (root).
    return (rel) => {
      const abs = path.resolve(cwd, rel);
      const relToRoot = path.relative(root, abs);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return false;
      const posix = relToRoot.split(path.sep).join('/');  // `ignore` requires forward slashes (Windows)
      return posix ? ig.ignores(posix) : false;
    };
  } catch {
    return null;   // exotic .gitignore syntax / IO error → fallback (spec §9 risk mitigation)
  }
}
