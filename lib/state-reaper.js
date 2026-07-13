import { readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; } // EPERM = alive but no permission; ESRCH = dead
}

export function sweepStaleState(dirs, { now = Date.now(), portDir = null } = {}) {
  const normalizedPortDir = portDir ? resolve(portDir) : null;
  let removed = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    const isPortDir = normalizedPortDir && resolve(dir) === normalizedPortDir;
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > MAX_AGE_MS) {
          if (isPortDir) {
            try {
              const record = JSON.parse(readFileSync(p, 'utf8'));
              if (record.pid && isPidAlive(record.pid)) continue;
            } catch { /* unreadable → treat as dead */ }
          }
          unlinkSync(p); removed++;
        }
      } catch { /* skip unreadable */ }
    }
  }
  return removed;
}
