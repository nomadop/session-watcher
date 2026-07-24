import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
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
  // __CLI_BUNDLE__ = true → server.js's CLI entry guard is dead-code-eliminated,
  // preventing the standalone-server path from firing inside the MCP plugin process.
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'index.js')],
    outfile: join(DIST, 'index.js'),
    banner: { js: REQUIRE_SHIM },
    define: {
      '__CLI_BUNDLE__': 'true',
    },
  });

  // 2. Bundle server.js (HTTP dashboard)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'server.js')],
    outfile: join(DIST, 'server.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 3. Bundle hooks/session-start.js (core logic — loaded dynamically by the entry shim)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'hooks', 'session-start.js')],
    outfile: join(DIST, 'hooks', 'session-start.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 3b. Copy the entry shim (must NOT be bundled — it relies on zero node:sqlite
  //     static imports so the ESM linker doesn't fail on older Node versions)
  cpSync(
    join(ROOT, 'hooks', 'session-start-entry.js'),
    join(DIST, 'hooks', 'session-start-entry.js'),
  );

  // 4. Bundle statusline.js (thin client — previously just copied, now bundled for lib/probe.js)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'statusline.js')],
    outfile: join(DIST, 'statusline.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 5. Copy static assets
  cpSync(join(ROOT, 'public'), join(DIST, 'public'), { recursive: true });

  // 7. Bundle bin/session-watcher.js (CLI — single file, includes cli.js + replay-server.js)
  // esbuild inlines the dynamic import('lib/cli.js') → one self-contained bundle.
  // __PKG_VERSION__ injected at build time — no runtime package.json read.
  // __CLI_BUNDLE__ = true → server.js's isMain guard is dead-code-eliminated (D2 fix).
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'bin', 'session-watcher.js')],
    outfile: join(DIST, 'bin', 'session-watcher.js'),
    banner: { js: '#!/usr/bin/env node\n' + REQUIRE_SHIM },
    minifySyntax: true,
    define: {
      '__PKG_VERSION__': JSON.stringify(pkg.version),
      '__CLI_BUNDLE__': 'true',
    },
  });


  // 6. Ensure executables have +x
  chmodSync(join(DIST, 'index.js'), 0o755);
  chmodSync(join(DIST, 'hooks', 'session-start-entry.js'), 0o755);
  chmodSync(join(DIST, 'hooks', 'session-start.js'), 0o755);
  chmodSync(join(DIST, 'statusline.js'), 0o755);
  chmodSync(join(DIST, 'bin', 'session-watcher.js'), 0o755);

  console.log('Build complete → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
