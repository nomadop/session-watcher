#!/usr/bin/env node
// Thin shim: version-gate before loading the real hook (which needs node:sqlite).
// This file MUST NOT have any static import that touches node:sqlite — otherwise
// the ESM linker will throw before our guard executes.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 16)) {
  process.stdout.write(JSON.stringify({
    systemMessage: `[Session Watcher] Node ${process.version} is below the minimum (>=22.16). Upgrade Node to enable context-cost monitoring and handoff discovery.`,
  }));
  process.exit(0);
}
// Rewrite argv[1] so isMainModule inside session-start.js sees itself as entry point.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
process.argv[1] = join(dirname(fileURLToPath(import.meta.url)), 'session-start.js');
await import('./session-start.js').catch((e) => {
  if (process.env.SW_PROBE === '1') process.stderr.write(`[SW entry] import failed: ${e.message}\n`);
  process.exit(0);
});
