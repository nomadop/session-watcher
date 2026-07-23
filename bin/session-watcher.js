// bin/session-watcher.js
// NO SHEBANG — added by esbuild banner at build time.
import { pathToFileURL } from 'node:url';
import { parseCliArgs } from '../lib/parse-args.js';

// Re-export for any consumer that imports from bin/
export { parseCliArgs };

// __PKG_VERSION__ injected by esbuild define at build time.
// Falls back to 'dev' when running unbundled source directly.
const VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : 'dev';

// Main entry — uses import.meta.url for reliable isMain detection
// (works via symlinks, npx, global install, and direct `node` invocation).
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.command === 'help') {
    console.log(`Usage: session-watcher <command> [options]

Commands:
  demo                        Replay built-in demo transcript
  replay <path>               Replay a Claude Code transcript

Options:
  --speed N                   Replay speed multiplier (default: 20)
  --port N                    Server port, 0 = auto (default: 0)
  --no-open                   Don't auto-open browser
  --help, -h                  Show this help
  --version, -V               Show version`);
    process.exit(0);
  }

  if (args.command === 'version') {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.error) {
    console.error(`Error: ${args.error}`);
    process.exit(1);
  }

  // Dynamic import — only triggered when actually running as CLI.
  // esbuild inlines this for the bundle; in source-mode tests importing
  // only parseCliArgs, this code path is never reached.
  const { runCli } = await import('../lib/cli.js');
  await runCli({ ...args, version: VERSION });
}
