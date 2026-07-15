import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

// Clean previous build (prevents stale files from lingering after source deletions)
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'hooks'), { recursive: true });

// Shared esbuild options: bundle all deps, keep Node built-ins external
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [
    'node:*', 'fs', 'path', 'os', 'http', 'url', 'child_process', 'crypto',
    'events', 'stream', 'util', 'net', 'tls', 'assert', 'buffer', 'string_decoder',
  ],
  // No banner here: CLI entry points (index.js, hooks/session-start.js) already carry
  // #!/usr/bin/env node on line 1 and esbuild preserves it; adding a banner would
  // produce a duplicate shebang (SyntaxError in Node). server.js overrides to '' below.
};

async function main() {
  // 1. Bundle index.js (MCP entry)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'index.js')],
    outfile: join(DIST, 'index.js'),
  });

  // 2. Bundle server.js (HTTP dashboard)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'server.js')],
    outfile: join(DIST, 'server.js'),
    banner: { js: '' }, // server.js is not a CLI entry
  });

  // 3. Bundle hooks/session-start.js
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'hooks', 'session-start.js')],
    outfile: join(DIST, 'hooks', 'session-start.js'),
    // No banner: source already has #!/usr/bin/env node and esbuild preserves it
  });

  // 4. Copy static assets
  cpSync(join(ROOT, 'hooks', 'warn.sh'), join(DIST, 'hooks', 'warn.sh'));
  cpSync(join(ROOT, 'public'), join(DIST, 'public'), { recursive: true });
  cpSync(join(ROOT, 'statusline.sh'), join(DIST, 'statusline.sh'));

  // 5. Ensure executables have +x
  chmodSync(join(DIST, 'index.js'), 0o755);
  chmodSync(join(DIST, 'hooks', 'session-start.js'), 0o755);
  chmodSync(join(DIST, 'hooks', 'warn.sh'), 0o755);
  chmodSync(join(DIST, 'statusline.sh'), 0o755);

  console.log('Build complete → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
