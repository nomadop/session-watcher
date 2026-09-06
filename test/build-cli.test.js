import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

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

  it('dist/bin/session-watcher.js is directly executable and emits injected version', () => {
    // Executes the binary directly (without `node`), which exercises both the shebang and
    // the esbuild __PKG_VERSION__ define injection in one shot.
    const binary = join(DIST, 'bin', 'session-watcher.js');
    const out = execSync(binary + ' --version', { encoding: 'utf8' });
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(out.trim(), pkg.version, 'version output must equal package.json version');
  });


  it('CLI with no args exits cleanly without starting a server', () => {
    // If server.js's isMain block leaked into the CLI bundle via failed DCE,
    // the process would bind a TCP port, print PORT=<n>, and hang until killed.
    // A correctly-built CLI prints usage and exits 0 when invoked without arguments.
    const result = spawnSync(join(DIST, 'bin', 'session-watcher.js'), [], {
      timeout: 4000,
      encoding: 'utf8',
    });
    // signal non-null → process was SIGTERM'd (hung as a server); result.status is null in that case.
    assert.equal(result.signal, null, 'CLI must exit on its own — a non-null signal means it hung (server leaked)');
    assert.equal(result.status, 0, 'CLI must exit 0 for a no-args (help) invocation');
  });

  it('no dist/lib/cli.js exists (bundled into single file)', () => {
    assert.ok(!existsSync(join(DIST, 'lib', 'cli.js')));
  });
});
