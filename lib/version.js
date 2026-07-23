// Single source of the plugin release version. Imported as a JSON module so esbuild inlines the
// literal value at bundle time (package.json is NOT copied into dist/, so a runtime file read would
// fail in the deployed plugin). Node 22 supports JSON import attributes for the source-run path.
import pkg from '../package.json' with { type: 'json' };

export const PLUGIN_VERSION = pkg.version;
