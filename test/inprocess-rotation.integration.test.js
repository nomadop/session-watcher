import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import { createServer, createWatcherComposition } from '../server.js';
import { strictWatcherFacade } from './helpers/server-boot.js';
import { assistantToolUse, chain, toolResult, ts, usage } from './helpers/transcript-fixtures.js';
import { discoverServerByClientPid } from '../hooks/session-start.js';

// One measured step and its result, as its own chain root: a null-parent row is a topology root, so a run
// assembled without a chain would open a compact epoch on every row.
let rowSeq = 0;
function usageRows(cacheRead) {
  const tag = `ir${++rowSeq}`;
  return chain([
    assistantToolUse({
      uuid: `u-${tag}`, parentUuid: null, messageId: `m-${tag}`, toolUseId: `t-${tag}`, name: 'Bash',
      input: { command: `echo ${tag}` }, timestamp: ts(1), model: 'claude-sonnet-4-20250514',
      usage: usage({ input: 100, output: 10, cacheRead }),
    }),
    toolResult({ uuid: `r-${tag}`, toolUseId: `t-${tag}`, content: `out ${tag}` }),
  ]);
}
const usageJsonl = (cacheRead) => usageRows(cacheRead).map(r => JSON.stringify(r) + '\n').join('');

// The post-cutover composition, wired the way every host path wires it.
const stores = [];
function composeOwner({ sessionId, sourceLocator, projectsRoot, stateDir, dir }) {
  const store = openStore(join(dir, `store-${sessionId}.sqlite`));
  stores.push(store);
  const watcher = createWatcherComposition({
    sessionId, sourceLocator, projectId: null, projectRoot: dir, stateDir, store, isIgnored: null,
  });
  return createServer({
    watcher: strictWatcherFacade(watcher), pollIntervalMs: 0, sessionId, onIdleShutdown: null,
    sourceLocator, projectsRoot, projectRoot: dir, stateDir, store, disableTelemetrySweep: true,
  });
}
process.on('exit', () => { for (const store of stores) { try { closeStore(store); } catch { /* closed */ } } });

test('integration: full rotation lifecycle (discover → POST /api/rotate → verify)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-integ-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'enc');
  mkdirSync(projRoot, { recursive: true });

  const oldSessionId = 'sess-old-integ';
  const newSessionId = 'sess-new-integ';
  const oldPath = join(projRoot, `${oldSessionId}.jsonl`);
  const newPath = join(projRoot, `${newSessionId}.jsonl`);
  writeFileSync(oldPath, usageJsonl(1000));
  writeFileSync(newPath, usageJsonl(2000));

  const { server, stopTimers, doRotation, currentSessionId, sseClients } = composeOwner({
    sessionId: oldSessionId, sourceLocator: oldPath, projectsRoot: join(dir, 'projects'), stateDir, dir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Write state file with clientPid (simulating what MCP startup does)
  const clientPid = process.pid;
  writeFileSync(join(stateDir, `${oldSessionId}.json`), JSON.stringify({
    port, pid: process.pid, clientPid, sessionId: oldSessionId, transcriptPath: oldPath,
  }));

  try {
    // 1. Hook discovers server via clientPid
    const discovery = discoverServerByClientPid(clientPid, stateDir);
    assert.ok(discovery, 'should discover server');
    assert.equal(discovery.sessionId, oldSessionId);

    // 2. Session ID mismatch detected
    assert.notEqual(discovery.sessionId, newSessionId);

    // 3. Hook POSTs /api/rotate
    const resp = await fetch(`${discovery.url}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: newSessionId, transcript_path: newPath }),
    });
    const result = await resp.json();
    assert.equal(result.ok, true);
    assert.equal(result.old_session_id, oldSessionId);
    assert.equal(result.new_session_id, newSessionId);

    // 4. Verify the owner switched. The locator lives on the discovery record and on the status wire, which
    // are the two places a consumer can actually see it — the application's own copy is not readable.
    assert.equal(currentSessionId(), newSessionId);
    const rotated = JSON.parse(readFileSync(join(stateDir, `${newSessionId}.json`), 'utf8'));
    assert.equal(rotated.transcriptPath, newPath, 'discovery names the rotated-in Source');
    assert.equal(rotated.sessionId, newSessionId);

    // 5. State file: new exists, old deleted
    assert.ok(existsSync(join(stateDir, `${newSessionId}.json`)));
    assert.ok(!existsSync(join(stateDir, `${oldSessionId}.json`)));

    // 6. Health still responds
    const healthResp = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal((await healthResp.json()).ok, true);
  } finally {
    stopTimers();
    for (const c of sseClients) { try { c.end(); } catch {} }
    await new Promise(r => server.close(r));
  }
});

test('integration: rotation is idempotent (same session_id = noop)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-integ-noop-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'enc');
  mkdirSync(projRoot, { recursive: true });
  const sessionId = 'sess-idem';
  const path = join(projRoot, `${sessionId}.jsonl`);
  writeFileSync(path, usageJsonl(1000));

  const owner = composeOwner({
    sessionId, sourceLocator: path, projectsRoot: join(dir, 'projects'), stateDir, dir,
  });
  const { server, stopTimers } = owner;

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  owner.publishDiscovery();   // listen-time creation, as the real owners do it

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const result = await resp.json();
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    // A duplicate-session notification changes nothing, so the record still names the original Source.
    assert.equal(JSON.parse(readFileSync(join(stateDir, `${sessionId}.json`), 'utf8')).transcriptPath, path);
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});
