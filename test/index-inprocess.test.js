import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, '..', 'index.js');

function usageLine(cacheRead) {
  return JSON.stringify({
    type: 'assistant', message: { id: `msg-${Math.random().toString(36).slice(2)}` },
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    model: 'claude-sonnet-4-20250514',
  });
}

function spawnMcp(env) {
  return spawn(process.execPath, [INDEX_JS], {
    env: { ...process.env, ...env, SW_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('SW_INPROCESS=1: MCP writes state file with clientPid on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-inproc-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  // resolveBySessionId looks at join(HOME, '.claude', 'projects')
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `test-inproc-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, usageLine(1000) + '\n');

  const child = spawnMcp({
    SW_STATE_DIR: stateDir,
    CLAUDE_CODE_SESSION_ID: sessionId,
    HOME: dir,
  });

  const stateFile = join(stateDir, `${sessionId}.json`);
  let attempts = 0;
  while (!existsSync(stateFile) && attempts < 30) {
    await sleep(100);
    attempts++;
  }

  try {
    assert.ok(existsSync(stateFile), 'state file should be written');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.sessionId, sessionId);
    // clientPid = process.ppid of the MCP child = our (test runner's) process.pid
    assert.equal(state.clientPid, process.pid);
    assert.ok(state.port > 0);
    assert.ok(state.transcriptPath.includes(sessionId));
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
});

test('SW_INPROCESS=1: state file removed on SIGTERM (exit cleanup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-inproc-cleanup-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `test-cleanup-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, usageLine(1000) + '\n');

  const child = spawnMcp({
    SW_STATE_DIR: stateDir,
    CLAUDE_CODE_SESSION_ID: sessionId,
    HOME: dir,
  });

  const stateFile = join(stateDir, `${sessionId}.json`);
  let attempts = 0;
  while (!existsSync(stateFile) && attempts < 30) {
    await sleep(100);
    attempts++;
  }
  assert.ok(existsSync(stateFile), 'state file written before kill');

  child.kill('SIGTERM');
  await sleep(500);
  assert.ok(!existsSync(stateFile), 'state file removed after SIGTERM');
});
