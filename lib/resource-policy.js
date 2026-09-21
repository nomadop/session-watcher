// lib/resource-policy.js — the shared Resource Policy: project containment, ignore selection, Skill
// defaults, and sibling inference, as one pure value.
//
// Two owners read the same policy for the same resource key. The Engine asks `resolve` for a key's default
// selection the moment an accepted impact creates it; `SessionWatcher` asks `infer` once per Engine-epoch
// flush whether a newcomer should inherit its siblings' state. Because both answers come from this one
// module, the bucket panel's discard reason and the position basis cannot disagree about the same file.
//
// The `.gitignore` matcher itself is NOT here: composition injects `isIgnored(rel) -> boolean`, so this
// module answers containment and ignore questions without naming what implements the second one.
import path from 'node:path';

// A Skill's content has no file of its own, so its resource key is namespaced rather than a path. Both
// halves of this module and the application's bucket split read the prefix from here.
export const SKILL_RESOURCE_PREFIX = 'skill:';

export function createResourcePolicy({ projectRoot = null, isIgnored = null } = {}) {
  const root = projectRoot || null;
  const ignoreMatcher = typeof isIgnored === 'function' ? isIgnored : null;

  // `startsWith(root)` is the wrong containment test: '/repo/app2/x' starts with '/repo/app'. A relative
  // path that escapes with '..' or stays absolute is the only reliable statement that a key is outside.
  function outsideProject(absolute) {
    if (!root || !absolute) return false;
    const relative = path.relative(root, absolute);
    return relative.startsWith('..') || path.isAbsolute(relative);
  }

  function discardReasonFor(resourceKey) {
    if (typeof resourceKey !== 'string' || resourceKey.length === 0) return null;
    // A Skill is always carried: its content is what the session asked for, and it has no place in the
    // working tree for an ignore rule or a containment test to speak about.
    if (resourceKey.startsWith(SKILL_RESOURCE_PREFIX)) return null;
    const absolute = path.isAbsolute(resourceKey)
      ? resourceKey
      : (root ? path.resolve(root, resourceKey) : resourceKey);
    if (outsideProject(absolute)) return 'outside-project';
    const relative = root ? path.relative(root, absolute) : resourceKey;
    if (relative && ignoreMatcher && ignoreMatcher(relative)) return 'gitignore';
    return null;
  }

  function resolve(resourceKey) {
    const defaultDiscardReason = discardReasonFor(resourceKey);
    return { selectedByDefault: defaultDiscardReason === null, defaultDiscardReason };
  }

  const stateOf = (resourceKey, overrides) => overrides[resourceKey]
    || (discardReasonFor(resourceKey) === null ? 'include' : 'exclude');

  /**
   * The overrides a batch of newly created resources inherits from their siblings.
   *
   * A sibling is a leaf under the same direct parent that the snapshot already holds. Inference fires only
   * when every sibling agrees AND that agreement differs from the newcomer's own default, so it can only
   * ever move a resource off a default the surrounding directory contradicts. Direct children of the
   * project root are excluded: a repository's top level mixes configuration, documentation and sources, so
   * unanimity there says nothing about the next file to land in it.
   *
   * The whole batch is judged against ONE snapshot, so a newcomer sees its batch-mates. An earlier key's
   * inference is visible to a later one, which keeps a two-file batch from disagreeing with itself.
   *
   * @param {{ newResourceKeys: string[], resourceKeys: string[], overrides: Record<string, 'include'|'exclude'> }} input
   * @returns {Record<string, 'include'|'exclude'>} only the entries inference adds
   */
  function infer({ newResourceKeys = [], resourceKeys = [], overrides = {} } = {}) {
    const effective = { ...overrides };
    const inferred = {};
    for (const newKey of newResourceKeys) {
      if (typeof newKey !== 'string' || newKey.length === 0) continue;
      // Skill overrides stay manual: a Skill has no directory whose state could speak for it.
      if (newKey.startsWith(SKILL_RESOURCE_PREFIX)) continue;
      if (effective[newKey]) continue;
      const lastSlash = newKey.lastIndexOf('/');
      if (lastSlash < 0) continue;
      const parentDir = newKey.slice(0, lastSlash + 1);
      if (root && parentDir === root.replace(/\/$/, '') + '/') continue;

      let unanimous = null;
      let sawSibling = false;
      for (const key of resourceKeys) {
        if (key === newKey) continue;
        const keySlash = key.lastIndexOf('/');
        if (keySlash < 0 || key.slice(0, keySlash + 1) !== parentDir) continue;
        const state = stateOf(key, effective);
        if (!sawSibling) { unanimous = state; sawSibling = true; continue; }
        if (state !== unanimous) { unanimous = null; break; }
      }
      if (!sawSibling || unanimous === null) continue;
      if (unanimous === stateOf(newKey, effective)) continue;
      inferred[newKey] = unanimous;
      effective[newKey] = unanimous;
    }
    return inferred;
  }

  return { resolve, infer };
}
