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

// CJS→ESM shim: express and its deps use require() internally; esbuild's ESM
// output wraps them in a __require2 helper that fails at runtime unless a real
// `require` function exists.  We inject createRequire at the top of the bundle.
const REQUIRE_SHIM = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

// Shared esbuild options: bundle all deps, keep Node built-ins external
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:*'],
};

async function main() {
  // 1. Bundle index.js (MCP entry — invoked via "node <path>", shebang optional)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'index.js')],
    outfile: join(DIST, 'index.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 2. Bundle server.js (HTTP dashboard)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'server.js')],
    outfile: join(DIST, 'server.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 3. Bundle hooks/session-start.js
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'hooks', 'session-start.js')],
    outfile: join(DIST, 'hooks', 'session-start.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 4. Copy static assets
  cpSync(join(ROOT, 'public'), join(DIST, 'public'), { recursive: true });
  cpSync(join(ROOT, 'statusline.js'), join(DIST, 'statusline.js'));

  // 5. Ensure executables have +x
  chmodSync(join(DIST, 'index.js'), 0o755);
  chmodSync(join(DIST, 'hooks', 'session-start.js'), 0o755);
  chmodSync(join(DIST, 'statusline.js'), 0o755);

  console.log('Build complete → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
