// Pure default-discard predicate (spec §2.1). Dependency-free (CLAUDE.md: lib/ stays zero-dep).
// The .gitignore matcher lives OUTSIDE lib/ (gitignore-loader.js, uses the `ignore` pkg) and is
// injected here as `isIgnored(rel) => boolean`. This file only decides discard given that callback.
import path from 'node:path';

// startsWith(cwd) is WRONG: '/repo/app2/x'.startsWith('/repo/app') === true. path.relative is the
// only correct containment test — a rel that escapes with '..' or is absolute is outside the tree.
export function outsideProject(cwd, filePath) {
  if (!cwd || !filePath) return false;
  const rel = path.relative(cwd, filePath);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

export function discardReason(rel, isIgnored, cwd, filePath) {
  if (outsideProject(cwd, filePath)) return 'outside-project';
  if (rel && typeof isIgnored === 'function' && isIgnored(rel)) return 'gitignore';
  return null;
}

export function isDefaultDiscard(rel, isIgnored, cwd, filePath) {
  return discardReason(rel, isIgnored, cwd, filePath) !== null;
}
