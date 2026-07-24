// test/cli-e2e.test.js
// E2E smoke tests that exercise the BUNDLED dist artifact, not source files.
// These validate that `npx session-watcher` style invocation works end-to-end.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST_BIN = join(ROOT, 'dist', 'bin', 'session-watcher.js');

/** Spawn child, collect stdout, resolve when predicate returns truthy or on close. */
function waitForOutput(args, { env = {}, predicate, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [DIST_BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', CI: '1', ...env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Timed out after ${timeoutMs}ms. stdout: ${stdout}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (predicate && !settled) {
        Promise.resolve(predicate(stdout, stderr)).then((result) => {
          if (result) settle(result);
        }).catch(() => {});
      }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr, code });
    });
  });
}

/** Extract port from stdout matching http://127.0.0.1:PORT */
function extractPort(stdout) {
  const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

describe('CLI E2E (built dist)', () => {
  before(() => {
    if (!existsSync(DIST_BIN)) {
      execSync('node scripts/build.js', { cwd: ROOT, stdio: 'pipe' });
    }
  });

  it('--version prints the correct semver from package.json (not "dev")', async () => {
    const child = spawn('node', [DIST_BIN, '--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = await new Promise((resolve) => {
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', () => resolve(stdout.trim()));
    });
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(output, pkg.version, `Expected version ${pkg.version}, got: ${output}`);
    // Confirm it is not 'dev' (the source-mode fallback)
    assert.notEqual(output, 'dev');
  });

  it('demo starts server via dist bundle and dashboard returns HTTP 200', async () => {
    const result = await waitForOutput(
      ['demo', '--speed', '5000', '--no-open'],
      {
        timeoutMs: 20000,
        predicate: async (stdout) => {
          const port = extractPort(stdout);
          if (!port) return null;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            return { stdout, port, dashboardStatus: res.status };
          } catch {
            return null;
          }
        },
      },
    );

    assert.match(result.stdout, /Session Watcher/);
    assert.match(result.stdout, /Demo/);
    assert.equal(result.dashboardStatus, 200, 'Dashboard should return HTTP 200');
  });

  it('replay <fixture> serves /api/replay/status with active=true and total>0', async () => {
    const FIXTURE = join(ROOT, 'fixtures', 'decf0f2c-20260703.jsonl');
    if (!existsSync(FIXTURE)) {
      // Skip gracefully if fixture unavailable
      return;
    }

    const result = await waitForOutput(
      ['replay', FIXTURE, '--speed', '100', '--no-open'],
      {
        timeoutMs: 20000,
        predicate: async (stdout) => {
          const port = extractPort(stdout);
          if (!port) return null;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/replay/status`);
            if (!res.ok) return null;
            const body = await res.json();
            return { stdout, port, body };
          } catch {
            return null;
          }
        },
      },
    );

    assert.ok(result.body, 'Should receive replay status JSON');
    assert.equal(result.body.active, true, 'Replay should be active');
    assert.ok(result.body.total > 0, `total should be > 0, got: ${result.body.total}`);
  });

  it('missing transcript exits with code 1', async () => {
    const child = spawn('node', [DIST_BIN, 'replay', '/nonexistent/path.jsonl', '--no-open'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const code = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c));
    });
    assert.equal(code, 1, `Expected exit code 1, got: ${code}`);
  });
});
