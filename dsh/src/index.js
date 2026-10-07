// dsh/src/index.js — the Cordis plugin face of the session watcher: the one module that imports a DSH package, binding the production paths and `defineTool` into `applyHost`.
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { defaultDbPath } from '../../lib/store.js';
import { loadIsIgnored } from '../../gitignore-loader.js';
import { applyHost, HOST_INJECT } from './host.js';
import { DSH_TURN_NOTES_ROOT } from './composition.js';

export const name = 'session-watcher';
export const inject = HOST_INJECT;

// Cordis collects `apply`'s return value as an effect and rejects a plain object, so `apply` discards `applyHost`'s table.
export function apply(ctx) {
  applyHost(ctx, {
    defineTool,
    storePath: defaultDbPath(),
    turnNotesRoot: DSH_TURN_NOTES_ROOT,
    loadIsIgnored,
    // The build copies `skills/` beside the bundle.
    skillsDir: fileURLToPath(new URL('./skills/', import.meta.url)),
  });
}
