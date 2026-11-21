// dsh/src/index.js — the Cordis plugin face of the session watcher: the one module that imports a DSH package, declaring the user's compaction settings as the plugin's Config and binding them, the production paths, `defineTool`, the `commandKit` values and the `innerKit` values into `applyHost`.
import { fileURLToPath } from 'node:url';
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { AssistantStreamAccumulator, BlockAssembler, HarnessError, assembleAssistantStream, createUserMessage, errorChain, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { loads } from 'ai-json-repair';

import carrierCachePackage from '../carrier-cache/package.json' with { type: 'json' };
import { defaultDbPath } from '../../lib/store.js';
import { loadIsIgnored } from '../../gitignore-loader.js';
import { applyHost, HOST_INJECT } from './host.js';
import { OFFICIAL_CARRIER_BUNDLE } from './carrier-cache-switch.js';
import { DSH_TURN_NOTES_ROOT } from './composition.js';
import { KAPPA_PRESETS } from '../../lib/inner-seal/quote.js';

// The official bundle is versioned on its own and released only when it changes, so the install target takes the version of its package.json (inlined at build time), never `PLUGIN_VERSION`.
const CARRIER_INSTALL_TARGET = { spec: `${OFFICIAL_CARRIER_BUNDLE}@${carrierCachePackage.version}`, version: carrierCachePackage.version };

export const name = 'session-watcher';
export const inject = HOST_INJECT;

/**
 * The user's settings, the one authority of their names, values and defaults: every field is volatile, so DSH's settings page and Loader write it in place and the running references answer the saved value at the next read, with no restart.
 * `showCompactionOption` is read by the settings page and the new-session switch alone; the host reads the other four.
 * A route is exactly `{ provider, model }`, null while none is chosen; a policy is one of the presets the quote prices.
 * `carrierResponsesBreakpoint` is the owner's switch for the OpenAI Responses breakpoint of the opt-in pi-ai entry (`pi-ai-index.js`), off until saved on; the host hands it to that entry at each request and the Settings page changes it only beside the carrier cache switch.
 */
export const Config = z.object({
  showCompactionOption: z.boolean().default(false).volatile(),
  compactionPreset: z.union(Object.keys(KAPPA_PRESETS).map(id => z.const(id))).default('M2').volatile(),
  summaryFallbackModel: z.object({ provider: z.string().min(1).required(), model: z.string().min(1).required() }).default(null).volatile(),
  subagentsInheritCompaction: z.boolean().default(false).volatile(),
  carrierResponsesBreakpoint: z.boolean().default(false).volatile(),
});

// Cordis collects `apply`'s return value as an effect and rejects a plain object, so `apply` discards `applyHost`'s table.
export function apply(ctx, config) {
  applyHost(ctx, {
    defineTool,
    commandKit: { CompactionId, compactCheckpointSource, createUserMessage },
    queryKit: { extractSessionEventText, HarnessError },
    innerKit: {
      appendPluginRecord, pluginRecordOf, AssistantStreamAccumulator, BlockAssembler, assembleAssistantStream, lastAssistantStreamChunk, errorChain,
      createUserMessage, toolPairingBalancedBefore, toolPairingBalancedAfter, loads,
    },
    // An unset route reads as undefined: the settings the host reads name no backup model then.
    readSettings: () => ({
      preset: config.compactionPreset.get(),
      fallbackModel: config.summaryFallbackModel.get() ?? null,
      inheritInSubagents: config.subagentsInheritCompaction.get(),
      carrierResponsesBreakpoint: config.carrierResponsesBreakpoint.get(),
    }),
    carrierInstallTarget: () => CARRIER_INSTALL_TARGET,
    storePath: defaultDbPath(),
    turnNotesRoot: DSH_TURN_NOTES_ROOT,
    loadIsIgnored,
    // The build copies `skills/` beside the bundle.
    skillsDir: fileURLToPath(new URL('./skills/', import.meta.url)),
  });
}
