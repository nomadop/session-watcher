// lib/project-key.js
import { resolve } from 'node:path';

/**
 * Resolve a canonical project key from available environment signals.
 * Used by BOTH the hook (direct DB read) and the watcher/server to ensure
 * identity match on project_id queries.
 */
export function resolveProjectKey({ claudeProjectDir, cwd } = {}) {
  const raw = claudeProjectDir || cwd;
  if (!raw) return null;
  return resolve(raw); // canonical absolute, trailing slash stripped by path.resolve
}
