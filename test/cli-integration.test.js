// test/cli-integration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'session-watcher.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'decf0f2c-20260703.jsonl');

describe('CLI integration', () => {
  it('replay starts server and prints dashboard URL', async () => {
    const child = spawn('node', [BIN, 'replay', FIXTURE, '--speed', '100', '--no-open'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    });

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timed out. Got: ${stdout}`));
      }, 15000);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.includes('http://')) {
          clearTimeout(timeout);
          child.kill('SIGTERM');
          resolve(stdout);
        }
      });
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timeout);
        resolve(stdout);
      });
    });

    assert.match(output, /http:\/\/127\.0\.0\.1:\d+/);
    assert.match(output, /Session Watcher/);
  });

  it('--help prints usage', async () => {
    const child = spawn('node', [BIN, '--help'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = await new Promise((resolve) => {
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', () => resolve(stdout));
    });
    assert.match(output, /Usage:/);
    assert.match(output, /replay/);
    assert.match(output, /demo/);
  });

  it('--version prints version string', async () => {
    const child = spawn('node', [BIN, '--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = await new Promise((resolve) => {
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', () => resolve(stdout));
    });
    // In source mode this prints 'dev'; in dist mode it prints semver
    assert.ok(output.trim().length > 0);
  });

  it('replay with missing file exits with error', async () => {
    const child = spawn('node', [BIN, 'replay', '/nonexistent/path.jsonl', '--no-open'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { code, stderr } = await new Promise((resolve) => {
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (c) => resolve({ code: c, stderr }));
    });
    assert.equal(code, 1);
    assert.match(stderr, /File not found/);
  });
});
