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

  // 2. Bundle hooks/session-start.js (core logic — loaded dynamically by the entry shim)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'hooks', 'session-start.js')],
    outfile: join(DIST, 'hooks', 'session-start.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 2b. Copy the entry shim (must NOT be bundled — it relies on zero node:sqlite
  //     static imports so the ESM linker doesn't fail on older Node versions)
  cpSync(
    join(ROOT, 'hooks', 'session-start-entry.js'),
    join(DIST, 'hooks', 'session-start-entry.js'),
  );

  // 3. Bundle statusline.js (thin client — previously just copied, now bundled for lib/probe.js)
  await build({
    ...shared,
    entryPoints: [join(ROOT, 'statusline.js')],
    outfile: join(DIST, 'statusline.js'),
    banner: { js: REQUIRE_SHIM },
  });

  // 4. Copy static assets
  cpSync(join(ROOT, 'public'), join(DIST, 'public'), { recursive: true });

  // 4b. Copy tree-sitter WASM files (not bundleable by esbuild)
  const WASM_SOURCES = [
    ['web-tree-sitter/web-tree-sitter.wasm', 'web-tree-sitter.wasm'],
    ['tree-sitter-javascript/tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
    ['tree-sitter-typescript/tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
    ['tree-sitter-typescript/tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
    ['tree-sitter-python/tree-sitter-python.wasm', 'tree-sitter-python.wasm'],
  ];
  for (const [src, dest] of WASM_SOURCES)
    cpSync(join(ROOT, 'node_modules', src), join(DIST, dest));

  // 5. Bundle bin/session-watcher.js (CLI — single file, includes cli.js + replay-server.js)
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

  // 7. Bundle the DSH host plugin beside the Claude Code plugin (dsh/dist/).
  // The DSH packages stay external: the profile's runtime resolution supplies them to a linked directory by peer name.
  const DSH_DIST = join(ROOT, 'dsh', 'dist');
  rmSync(DSH_DIST, { recursive: true, force: true });
  await build({
    ...shared,
    external: ['node:*', '@deepseek-ai/*'],
    entryPoints: [join(ROOT, 'dsh', 'src', 'index.js')],
    outfile: join(DSH_DIST, 'index.js'),
    banner: { js: REQUIRE_SHIM },
  });
  // lib/symbol-outline.js loads the WASM files relative to the bundle
  for (const [src, dest] of WASM_SOURCES)
    cpSync(join(ROOT, 'node_modules', src), join(DSH_DIST, dest));
  cpSync(join(ROOT, 'skills'), join(DSH_DIST, 'skills'), { recursive: true });

  // 8. Bundle the DSH client half (dsh/dist/client.js), the Web UI's view.
  // The browser loads the artifact as a classic script, so it is CJS inside the loader call: the factory's `require`
  // is bound to the Web UI's seed table, which supplies React, react-dom and the UI primitives; the sheets enter as text.
  // The elements' Chart seam is the page global on the dashboard; here its body becomes the bundled `chart.js/auto`.
  const dshPkg = JSON.parse(readFileSync(join(ROOT, 'dsh', 'package.json'), 'utf8'));
  const redirectChart = {
    name: 'redirect-chart',
    setup(b) {
      // onLoad filters match the resolved path; onResolve would see the importer's relative specifier.
      b.onLoad({ filter: /[\\/]public[\\/]lib[\\/]chart\.js$/ }, () => ({
        contents: "export { default } from 'chart.js/auto';", loader: 'js',
      }));
    },
  };
  await build({
    entryPoints: [join(ROOT, 'dsh', 'src', 'client', 'index.js')],
    outfile: join(DSH_DIST, 'client.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
    loader: { '.css': 'text' },
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(dshPkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; } });' },
    plugins: [redirectChart],
  });

  console.log('Build complete → dist/, dsh/dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
