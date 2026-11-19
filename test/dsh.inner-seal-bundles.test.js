// The built Claude Code bundles replay a sealed DSH session: the CLI bundle `dist/bin/session-watcher.js` and the MCP bundle `dist/index.js`, each started as a process in a fixture home, play an authored session whose carriers replace three ranges, and the history they report is the usages the log shows standing after them: the head, the call behind each carrier and the unsealed tail (`test/helpers/dsh-selection-oracle.js`).
// The DSH host bundle is held to the same by the shipped-entry cases of `test/dsh.inner-seal.integration.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';

import * as E from './helpers/dsh-events.js';
import { sealedSession } from './helpers/dsh-authored-seals.js';
import { standingUsages } from './helpers/dsh-selection-oracle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = { skip: existsSync(join(ROOT, 'dist', 'index.js')) && existsSync(join(ROOT, 'dist', 'bin', 'session-watcher.js')) ? false : 'dist/ is not built; run node scripts/build.js', timeout: 60_000 };

const splitOf = event => `${event.data.usage.cacheReadTokens}/${event.data.usage.cacheWriteTokens}`;

// The session as DSH writes it under its default compression: the header line as one checksummed zstd frame and the events as another.
function writeLog(dir, events) {
  const frame = records => zstdCompressSync(records.map(record => `${JSON.stringify(record)}\n`).join(''), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const path = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(path, Buffer.concat([frame([E.header({ id: 'session-bundle', cwd: dir })]), frame(events)]));
  return path;
}

const expectedHistory = log => standingUsages(log).map(seq => splitOf(log.events[seq]));

// A process of one of the bundles in a fixture home, killed when `stop` runs; `until(predicate)` resolves with the first answer the predicate gives over its output.
function start(args, { env, cwd }) {
  const child = spawn('node', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TERM: 'dumb', CI: '1', ...env } });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  return {
    output: () => output,
    stop: () => new Promise((resolve) => { child.once('close', resolve); child.kill('SIGTERM'); }),
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const answer = await read();
    if (answer) return answer;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function playedHistory(base) {
  await until(async () => (await (await fetch(`${base}/api/replay/status`)).json()).done === true, 'the replay to finish');
  return (await (await fetch(`${base}/api/history`)).json()).map(point => `${point.cacheRead}/${point.cacheCreation}`);
}

test('the CLI bundle replays a sealed DSH session and reports the head, the call behind each carrier and the unsealed tail', BUILT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-dsh-bundle-cli-'));
  const log = sealedSession();
  const path = writeLog(dir, log.events);
  mkdirSync(join(dir, 'home'));
  const bundle = start([join(ROOT, 'dist', 'bin', 'session-watcher.js'), 'replay', path, '--speed', '1000', '--port', '0', '--no-open'], { cwd: dir, env: { HOME: join(dir, 'home') } });
  try {
    const base = await until(() => /http:\/\/127\.0\.0\.1:\d+/.exec(bundle.output())?.[0], 'the replay server URL');
    assert.deepEqual(await playedHistory(base), expectedHistory(log));
  } finally {
    await bundle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP bundle plays a sealed DSH session through its replay route and reports the same history', BUILT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-dsh-bundle-mcp-'));
  const log = sealedSession();
  const path = writeLog(dir, log.events);
  const state = join(dir, 'state');
  mkdirSync(join(dir, 'home'));
  const bundle = start([join(ROOT, 'dist', 'index.js')], { cwd: dir, env: { HOME: join(dir, 'home'), SW_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: 'bundle-session' } });
  try {
    const base = await until(() => {
      if (!existsSync(state)) return false;
      const file = readdirSync(state).find(name => name.endsWith('.json'));
      const port = file === undefined ? undefined : JSON.parse(readFileSync(join(state, file), 'utf8')).port;
      return port === undefined ? false : `http://127.0.0.1:${port}`;
    }, 'the MCP bundle to publish its port');
    const started = await fetch(`${base}/api/replay/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript: path, speed: 1000 }) });
    assert.equal(started.status, 200, await started.text());
    assert.deepEqual(await playedHistory(base), expectedHistory(log));
  } finally {
    await bundle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
