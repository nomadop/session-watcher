// test/stop-watcher-identity.test.js
// #7 — stopWatcher must verify process IDENTITY (health handshake), never SIGTERM a bare/recycled pid.
//
// The core regression (MISMATCH → does NOT stop) FAILS on pre-fix code: pre-fix stopWatcher does
// `process.kill(st.pid, 0)` (existence only) then `process.kill(st.pid, 'SIGTERM')`, so a foreign
// server answering on st.port (or a recycled pid) would get the innocent sleeper killed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopWatcher } from '../lib/launcher.js';

const PORT_DIR = join(homedir(), '.session-watcher');
const stateFileFor = (sid) => join(PORT_DIR, `${sid}.json`);

// Spawn a trivial detached-ish sleeper. No SIGTERM handler → dies on SIGTERM by default.
function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', () => resolve()));
  return { child, exited };
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Fake /api/health server returning a caller-supplied body (simulates our server, or a foreign one).
function fakeHealthServer(body) {
  return new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }
      else { res.statusCode = 404; res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function writeState(sid, st) {
  mkdirSync(PORT_DIR, { recursive: true });
  writeFileSync(stateFileFor(sid), JSON.stringify(st));
}
function cleanupState(sid) { try { rmSync(stateFileFor(sid), { force: true }); } catch {} }

// 1) IDENTITY MATCH → the real spawned sleeper receives SIGTERM and exits; returns {stopped:true}.
test('stopWatcher: identity MATCH → SIGTERMs our server (sleeper exits), {stopped:true}', async () => {
  const sid = `sw-id-match-${randomUUID()}`;
  const { child, exited } = spawnSleeper();
  const startedAt = Date.now();
  const { srv, port } = await fakeHealthServer({ ok: true, pid: child.pid, startedAt });
  writeState(sid, { port, pid: child.pid, startedAt, sessionId: sid });
  try {
    const res = await stopWatcher({ CLAUDE_CODE_SESSION_ID: sid });
    assert.deepEqual(res, { stopped: true });
    // SIGTERM is genuine — wait for the child to actually die (bounded by the runner default timeout).
    await exited;
    assert.equal(isAlive(child.pid), false, 'matched server was terminated');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await new Promise(r => srv.close(r));
    cleanupState(sid);
  }
});

// 2) IDENTITY MISMATCH → foreign server answered on st.port with a DIFFERENT pid/startedAt.
//    stopWatcher must NOT signal st.pid. The sleeper at st.pid stays ALIVE. {stopped:false}.
//    ***This is the core regression that FAILS on pre-fix kill(pid,0)+SIGTERM code.***
test('stopWatcher: identity MISMATCH → does NOT signal, sleeper STILL ALIVE, {stopped:false}', async () => {
  const sid = `sw-id-mismatch-${randomUUID()}`;
  const { child, exited } = spawnSleeper();
  const stateStartedAt = 1111111111111;
  // Health answers with a different pid AND different startedAt (recycled-pid / foreign-server case).
  const { srv, port } = await fakeHealthServer({ ok: true, pid: child.pid + 1, startedAt: 2222222222222 });
  writeState(sid, { port, pid: child.pid, startedAt: stateStartedAt, sessionId: sid });
  try {
    const res = await stopWatcher({ CLAUDE_CODE_SESSION_ID: sid });
    assert.deepEqual(res, { stopped: false });
    // Prove no SIGTERM reached the innocent sleeper: it must still be alive shortly after.
    await new Promise(r => setTimeout(r, 200));
    assert.equal(isAlive(child.pid), true, 'innocent sleeper at st.pid was NOT signalled');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await exited.catch(() => {});
    await new Promise(r => srv.close(r));
    cleanupState(sid);
  }
});

// 3) NO HEALTH RESPONSE (server down) → {stopped:false}, NO blind SIGTERM to a bare pid,
//    and the stale state file is unlinked so status is clean next time.
test('stopWatcher: NO health response → no blind kill, sleeper alive, {stopped:false}, stale state unlinked', async () => {
  const sid = `sw-id-down-${randomUUID()}`;
  const { child, exited } = spawnSleeper();
  // Bind+immediately-release a port so it is (almost surely) not answering, simulating a down server.
  const { srv, port } = await fakeHealthServer({ ok: true });
  await new Promise(r => srv.close(r)); // port now closed → probe gets ECONNREFUSED
  const stateStartedAt = Date.now();
  writeState(sid, { port, pid: child.pid, startedAt: stateStartedAt, sessionId: sid });
  try {
    const res = await stopWatcher({ CLAUDE_CODE_SESSION_ID: sid });
    assert.deepEqual(res, { stopped: false });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(isAlive(child.pid), true, 'bare pid NOT blind-killed when health did not answer');
    assert.equal(existsSync(stateFileFor(sid)), false, 'stale state file unlinked on no-response');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await exited.catch(() => {});
    cleanupState(sid);
  }
});
