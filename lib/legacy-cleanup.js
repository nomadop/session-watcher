import { readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LEGACY_DIRS = ['rate-lamp', 'rate-lamp-state', 'gate', 'gate-state', 'pricing'];

export function cleanupLegacyJson(baseDir) {
  for (const name of LEGACY_DIRS) {
    const dir = join(baseDir, name);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    // Remove only .json files
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try { unlinkSync(join(dir, f)); } catch { /* skip */ }
    }
    // Try to remove dir (only succeeds if empty — safe)
    try { rmdirSync(dir); } catch { /* non-empty or error — leave it */ }
  }
}

export function defaultBaseDir() {
  return process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.session-watcher');
}
