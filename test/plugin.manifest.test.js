import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('plugin: .claude-plugin/plugin.json has required fields', () => {
  const p = join(ROOT, '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(p), '.claude-plugin/plugin.json exists');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(m.name, 'session-watcher');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 10, 'description is meaningful');
  assert.equal(m.repository, 'https://github.com/nomadop/session-watcher');
});

test('plugin: .claude-plugin/marketplace.json declares this plugin', () => {
  const p = join(ROOT, '.claude-plugin', 'marketplace.json');
  assert.ok(existsSync(p), '.claude-plugin/marketplace.json exists');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(typeof m.name, 'string');
  assert.ok(Array.isArray(m.plugins), 'plugins array exists');
  const entry = m.plugins.find(pl => pl.name === 'session-watcher');
  assert.ok(entry, 'session-watcher listed in plugins');
});

test('plugin: plugin.json declares session-watcher MCP server with exec form', () => {
  const p = join(ROOT, '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(p), 'plugin.json exists');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  const srv = m.mcpServers?.['session-watcher'];
  assert.ok(srv, 'session-watcher server declared');
  assert.equal(srv.command, 'node');
  assert.ok(Array.isArray(srv.args), 'args is an array');
  assert.ok(srv.args[0].includes('dist/index.js'), 'args[0] points to dist/index.js');
});

test('plugin: hooks/hooks.json uses exec form for SessionStart', () => {
  const p = join(ROOT, 'hooks', 'hooks.json');
  assert.ok(existsSync(p), 'hooks/hooks.json exists');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  // SessionStart
  const ss = m.hooks.SessionStart[0].hooks[0];
  assert.equal(ss.type, 'command');
  assert.equal(ss.command, 'node');
  assert.ok(Array.isArray(ss.args), 'SessionStart hook uses exec form (args array)');
  assert.ok(ss.args[0].includes('dist/hooks/session-start.js'));
  // Stop hook retired (2026-07-18) — gate + backstop now run in reader path
  assert.equal(m.hooks.Stop, undefined, 'Stop hook must not be registered');
});

test('plugin: version consistency across plugin.json and package.json', () => {
  const pluginV = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const pkgV = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(pluginV, pkgV, 'plugin.json version must equal package.json version');
});

test('plugin: dist/ contains bundled entry points', () => {
  assert.ok(existsSync(join(ROOT, 'dist', 'index.js')), 'dist/index.js exists');
  assert.ok(existsSync(join(ROOT, 'dist', 'server.js')), 'dist/server.js exists');
  assert.ok(existsSync(join(ROOT, 'dist', 'hooks', 'session-start.js')), 'dist/hooks/session-start.js exists');
  // warn.js retired (2026-07-18) — Stop hook removed
  assert.ok(existsSync(join(ROOT, 'dist', 'public', 'index.html')), 'dist/public/index.html exists');
  assert.ok(existsSync(join(ROOT, 'dist', 'statusline.js')), 'dist/statusline.js exists');
});

test('plugin: dist bundles have no external package imports', () => {
  // Matches actual ESM import statements at line start — ignores occurrences
  // inside block comments (JSDoc @example lines start with " * ", not bare import)
  const externalImport = /^\s*import\s.+\sfrom\s+['"](?:express|@modelcontextprotocol|zod)['"]/m;
  const externalRequire = /\brequire\s*\(\s*['"](?:express|@modelcontextprotocol|zod)['"]\s*\)/;

  for (const entry of ['dist/index.js', 'dist/server.js', 'dist/hooks/session-start.js']) {
    const src = readFileSync(join(ROOT, entry), 'utf8');
    assert.ok(!externalImport.test(src), `${entry}: no external ESM import`);
    assert.ok(!externalRequire.test(src), `${entry}: no external require()`);
  }
});
