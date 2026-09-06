import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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
  assert.ok(ss.args[0].includes('dist/hooks/session-start-entry.js'));
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
  assert.ok(existsSync(join(ROOT, 'dist', 'hooks', 'session-start-entry.js')), 'dist/hooks/session-start-entry.js exists');
  assert.ok(existsSync(join(ROOT, 'dist', 'hooks', 'session-start.js')), 'dist/hooks/session-start.js exists');
  // warn.js retired (2026-07-18) — Stop hook removed
  assert.ok(existsSync(join(ROOT, 'dist', 'public', 'index.html')), 'dist/public/index.html exists');
  assert.ok(existsSync(join(ROOT, 'dist', 'statusline.js')), 'dist/statusline.js exists');
});

test('plugin: dist bundles are self-contained (no unbundled external imports)', () => {
  // Copy the entire dist/ tree to a temp dir outside the workspace so that Node's
  // ESM resolver cannot walk up to /workspace/node_modules.  An unbundled bare
  // import of express / @modelcontextprotocol / zod would then produce
  // ERR_MODULE_NOT_FOUND immediately on startup; a correctly-bundled one is silent.
  // WASM files live alongside the bundles, so relative URL references still resolve.
  // Bundles that start servers or wait on stdin are killed after 3 s — the
  // module-resolution check happens synchronously at module load, before any I/O.
  const tmp = mkdtempSync(join(tmpdir(), 'sw-bundle-'));
  try {
    cpSync(join(ROOT, 'dist'), join(tmp, 'dist'), { recursive: true });
    // index.js and server.js reach their entrypoint guard here and build a real store and state
    // file. Without a HOME and SW_STATE_DIR of their own they would land in the developer's live
    // ~/.session-watcher, and the SIGTERM below would run cleanup() and unlink the state file of
    // whichever session owns that id.
    const env = {
      PATH: process.env.PATH,
      HOME: join(tmp, 'home'),
      SW_STATE_DIR: join(tmp, 'state'),
      CLAUDE_CODE_SESSION_ID: 'bundle-probe',
      SW_NO_OPEN: '1',
    };
    for (const rel of ['index.js', 'server.js', 'hooks/session-start.js']) {
      const bundlePath = join(tmp, 'dist', rel);
      const result = spawnSync(process.execPath, [bundlePath], { timeout: 3000, encoding: 'utf8', env });
      // A spawn that never reached module load proves nothing, so an absent stderr must not pass by
      // default: the only tolerated failure is the timeout that killing a live server produces.
      assert.ok(
        !result.error || result.error.code === 'ETIMEDOUT',
        `dist/${rel}: probe did not reach module load — ${result.error?.message}`,
      );
      const stderr = result.stderr || '';
      assert.ok(
        !/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(stderr),
        `dist/${rel}: bundle must not fail with a module-resolution error\nstderr: ${stderr.slice(0, 500)}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
