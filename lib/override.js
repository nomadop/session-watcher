/**
 * Infer override for a new file based on unanimous sibling state.
 * "Sibling" = same direct parent directory, leaf-only, present in bRebuildKeys.
 *
 * @param {string} newPath
 * @param {string[]} bRebuildKeys - all paths currently in _bRebuild
 * @param {Map<string, 'include'|'exclude'>} userOverrides
 * @param {function(string): string|null} discardReasonFn - returns null if auto-included
 * @param {string} [projectRoot] - cwd; direct children of this dir skip inference (C12)
 * @returns {'include'|'exclude'|null}
 */
export function inferOverride(newPath, bRebuildKeys, userOverrides, discardReasonFn, projectRoot) {
  const lastSlash = newPath.lastIndexOf('/');
  if (lastSlash < 0) return null; // no slash at all
  const parentDir = newPath.slice(0, lastSlash + 1); // include trailing slash
  // C12 fix: project-root files (direct children of cwd) are too heterogeneous for inference
  if (projectRoot && parentDir === projectRoot.replace(/\/$/, '') + '/') return null;

  // Collect siblings: same parent, different from newPath, currently in bRebuild
  const siblings = [];
  for (const key of bRebuildKeys) {
    if (key === newPath) continue;
    const ks = key.lastIndexOf('/');
    if (ks < 0) continue;
    if (key.slice(0, ks + 1) === parentDir) siblings.push(key);
  }
  if (siblings.length === 0) return null;

  // Determine effective state for each sibling
  let unanimousState = null;
  for (const sib of siblings) {
    const override = userOverrides.get(sib);
    const effective = override || (discardReasonFn(sib) === null ? 'include' : 'exclude');
    if (unanimousState === null) {
      unanimousState = effective;
    } else if (effective !== unanimousState) {
      return null; // mixed
    }
  }

  // Determine new file's default state
  const newDefault = discardReasonFn(newPath) === null ? 'include' : 'exclude';

  // Only infer if unanimous state differs from the new file's default
  if (unanimousState === newDefault) return null;
  return unanimousState;
}
