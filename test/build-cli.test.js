import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

describe('build produces CLI artifacts', () => {
  before(() => {
    // Only rebuild if dist/bin/session-watcher.js is missing — avoids race with
    // plugin.manifest.test.js which reads dist/ in parallel.
    if (!existsSync(join(DIST, 'bin', 'session-watcher.js'))) {
      execSync('node scripts/build.js', { cwd: ROOT, stdio: 'pipe' });
    }
  });

  it('dist/bin/session-watcher.js exists and is executable', () => {
    const p = join(DIST, 'bin', 'session-watcher.js');
    assert.ok(existsSync(p));
    const mode = statSync(p).mode;
    assert.ok((mode & 0o111) !== 0, 'should be executable');
  });

  it('dist/bin/session-watcher.js has shebang as first line', () => {
    const content = readFileSync(join(DIST, 'bin', 'session-watcher.js'), 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'must start with shebang');
  });

  it('dist/bin/session-watcher.js contains injected version (not "dev")', () => {
    const content = readFileSync(join(DIST, 'bin', 'session-watcher.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(content.includes(pkg.version), `should contain version ${pkg.version}`);
  });

  it('dist/bin/session-watcher.js does NOT contain server.js isMain block', () => {
    const content = readFileSync(join(DIST, 'bin', 'session-watcher.js'), 'utf8');
    // D2: __CLI_BUNDLE__ define causes esbuild to dead-code-eliminate server.js's isMain
    // The server's parseArgs call or its PORT= output should not appear in the CLI bundle.
    assert.ok(!content.includes('PORT='), 'server.js CLI entry should be eliminated');
  });

  it('dist/fixtures/demo.jsonl.gz exists', () => {
    assert.ok(existsSync(join(DIST, 'fixtures', 'demo.jsonl.gz')));
  });

  it('no dist/lib/cli.js exists (bundled into single file)', () => {
    assert.ok(!existsSync(join(DIST, 'lib', 'cli.js')));
  });
});
