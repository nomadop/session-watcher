// test/index.mcp-wiring.test.js — the production MCP wiring, driven as a real stdio server.
//
// index.js registers every tool inside its realpath entrypoint guard, so the only way to observe that
// wiring is to run index.js as `process.argv[1]` and talk JSON-RPC to it. This file spawns it with the
// official StdioClientTransport (framing, id matching and buffering come from the SDK) and asserts on
// the replies rather than asserting source-file text.
//
// What each reply pins, and why a reply can only come from the real wiring:
//   * the tool list is exactly the set the guard registers — the three read tools are there only if the
//     guard actually CALLS registerTurnReadTools (its own exported definition repeats the parameter
//     list, so a source pattern could not tell the call from the definition);
//   * get_turn_skeleton renders this process's own seeded transcript, which only the turnService that
//     createServer handed over can read;
//   * submit_turn_notes accepts that same snapshot_id as current, so both capture tools are bound to one
//     service instance rather than to two independent captures;
//   * turn_page / turn_search / turn_locate answer no_handoff_loaded, which is turnReadService's own
//     precondition result;
//   * load_handoff's degradation reply carries a `recovery` sentence the HTTP route does not add —
//     withLoadRecovery lives in the index.js handler, and this file asserts both sides of that seam;
//   * a store read and a store write both answer over the in-process HTTP surface, so initStore() has
//     run by the time the server serves (a store that is not initialized makes the turn-page route
//     answer 503 from its own catch, and prepare_handoff could not commit at all);
//   * every reply that goes through the in-process HTTP surface proves inprocFetch is intact.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { userMessage, assistantObservation, ts } from './helpers/transcript-fixtures.js';

const INDEX_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

// Every wait is bounded, so a wiring regression that hangs a handler fails with a message instead of
// stalling the suite. The boot budget is the larger one: it covers spawn + store migrations + the
// startup fold poll.
const BOOT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

// One user turn with assistant activity, then the turn that is asking for the skeleton. Capture drops
// that last turn whole, so the epoch keeps exactly one NOTE slot — enough for submit_turn_notes to have
// a real slot set to disagree with.
const TRANSCRIPT_ENTRIES = [
  userMessage({ uuid: 'u-wire-1', parentUuid: null, text: 'first instruction', timestamp: ts(1) }),
  assistantObservation({
    uuid: 'a-wire-1', parentUuid: 'u-wire-1', messageId: 'm-wire-1', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'answered' }],
  }),
  userMessage({ uuid: 'u-wire-2', parentUuid: 'a-wire-1', text: 'prepare the handoff', timestamp: ts(3) }),
];

const EXPECTED_TOOLS = [
  'get_bucket_summary', 'get_turn_skeleton', 'load_handoff', 'prepare_handoff', 'rotate_session',
  'start_watcher', 'stop_watcher', 'submit_turn_notes', 'turn_locate', 'turn_page', 'turn_search',
  'watcher_status',
];

describe('index.js entrypoint wiring, over a real MCP stdio session', { timeout: 120_000 }, () => {
  let dir, sessionId, port, client, transport, dbPath;
  // Bounded tail of the child's stderr, so a boot that never completes reports the child's own reason
  // instead of only the timeout.
  let childStderr = '';

  const callTool = (name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });

  const decode = (result, what) => {
    const text = result?.content?.[0]?.text;
    assert.notEqual(result?.isError, true, `${what}: MCP error envelope — ${text}`);
    assert.equal(typeof text, 'string', `${what}: reply carried no text content`);
    try { return JSON.parse(text); } catch { return assert.fail(`${what}: reply is not JSON — ${text}`); }
  };

  const call = async (name, args, what = name) => decode(await callTool(name, args), what);

  // The dashboard port comes from the child's OWN state file under our temp SW_STATE_DIR, never from a
  // port discovered anywhere else.
  const childRequest = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: res.status, body: await res.json() };
  };

  const shutdown = async () => {
    // StdioClientTransport.close() ends stdin, then escalates SIGTERM → SIGKILL. SW_GRACE_MS below makes
    // the child's own stdin-EOF path exit immediately, so this returns in milliseconds.
    try { await client?.close(); } catch { /* transport already gone */ }
    try { await transport?.close(); } catch { /* already closed */ }
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sw-mcp-wiring-'));
    try {
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir, { recursive: true });
      // resolveBySessionId looks under join(HOME, '.claude', 'projects'); the store lands in
      // join(HOME, '.session-watcher'). Both are inside the temp dir, so nothing touches a real install.
      const projDir = join(dir, '.claude', 'projects', 'enc');
      mkdirSync(projDir, { recursive: true });
      const cwd = join(dir, 'work');
      mkdirSync(cwd, { recursive: true });
      dbPath = join(dir, '.session-watcher', 'store.sqlite');

      sessionId = `mcp-wiring-${process.pid}-${Date.now()}`;
      writeFileSync(join(projDir, `${sessionId}.jsonl`),
        TRANSCRIPT_ENTRIES.map(e => JSON.stringify(e) + '\n').join(''));

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [INDEX_JS],
        cwd,
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SW_STATE_DIR: stateDir,
          CLAUDE_CODE_SESSION_ID: sessionId,
          SW_NO_OPEN: '1',
          SW_GRACE_MS: '1',
        },
      });
      // Also drains the pipe, so a chatty child never blocks writing to it.
      transport.stderr?.on('data', (chunk) => { childStderr = (childStderr + chunk).slice(-4000); });
      client = new Client({ name: 'mcp-wiring-test-client', version: '0.0.0' });
      await client.connect(transport, { timeout: BOOT_TIMEOUT_MS });

      // server.listen precedes mcpServer.connect, so the state file is normally written before the
      // handshake completes; the bounded wait covers a slow scheduler rather than a missing write.
      const stateFile = join(stateDir, `${sessionId}.json`);
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (!existsSync(stateFile) && Date.now() < deadline) await sleep(50);
      assert.ok(existsSync(stateFile), `the child never wrote its state file — child stderr:\n${childStderr}`);
      port = JSON.parse(readFileSync(stateFile, 'utf8')).port;
      assert.ok(port > 0, 'the state file carried no dashboard port');
    } catch (err) {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
      err.message = `${err.message}\n--- child stderr ---\n${childStderr}`;
      throw err;
    }
  });

  after(async () => {
    await shutdown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the tool list is exactly the set the entrypoint guard registers', async () => {
    const { tools } = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    assert.deepEqual(tools.map(({ name }) => name).sort(), [...EXPECTED_TOOLS].sort());
    // get_turn_skeleton creates a directory and writes two files; submit_turn_notes writes the rows and then
    // rmSyncs that directory. The annotation a client reads before deciding whether to prompt has to say so,
    // and it travels ONLY in this reply — nothing else in the suite sees it, and get_turn_skeleton's already
    // flipped to readOnlyHint: true once without a single case noticing.
    for (const name of ['get_turn_skeleton', 'submit_turn_notes']) {
      assert.equal(tools.find((t) => t.name === name).annotations?.readOnlyHint, false, name);
    }
  });

  test('get_turn_skeleton writes this process\'s own transcript through the real turnService', async () => {
    const payload = await call('get_turn_skeleton', {});
    assert.deepEqual(Object.keys(payload).sort(), ['notes_path', 'protocol', 'skeleton_path', 'snapshot_id']);
    assert.ok(payload.snapshot_id.length > 0);
    assert.ok(payload.protocol.length > 0);
    // Both paths sit under the child's OWN SW_STATE_DIR, so the reply proves the server derived them
    // from its state dir rather than from anything a caller could have supplied.
    assert.ok(payload.skeleton_path.startsWith(join(dir, 'state')), payload.skeleton_path);
    assert.ok(payload.notes_path.startsWith(join(dir, 'state')), payload.notes_path);
    // Only a capture over the seeded transcript of THIS session can produce these: the session id the
    // guard passed to createServer, the fixture's own U text at its physical line, and the NOTE slot the
    // assistant turn earns.
    const skeleton = readFileSync(payload.skeleton_path, 'utf8');
    assert.ok(skeleton.includes(sessionId), 'skeleton does not name this session');
    assert.match(skeleton, /^T +1 \| U +: first instruction$/m);
    assert.match(skeleton, /\| NOTE\[\d+\]: ____$/m);
    assert.match(readFileSync(payload.notes_path, 'utf8'), /^## NOTE\[\d+\]$/m);
  });

  test('submit_turn_notes validates against the same capture get_turn_skeleton handed out', async () => {
    const { snapshot_id, notes_path } = await call('get_turn_skeleton', {});

    // Accepting this snapshot_id as CURRENT is the assertion: a stale_snapshot here would mean the two
    // handlers reached two different captures instead of one turnService. The notes file is left with
    // its heading and no body, which is the invalid_notes the same capture must report.
    const rejected = await call('submit_turn_notes', { snapshot_id });
    assert.equal(rejected.committed, false);
    assert.equal(rejected.error, 'invalid_notes');
    assert.ok(rejected.issues.length > 0);
    assert.ok(rejected.issues.every(i => typeof i.t === 'number'));

    // The file the server reads is the one it named — filling it makes the same call commit.
    const keys = [...readFileSync(notes_path, 'utf8').matchAll(/^## NOTE\[(\d+)\]$/gm)].map(m => m[1]);
    writeFileSync(notes_path, keys.map(k => `## NOTE[${k}]\n\nwiring note\n`).join('\n'));
    assert.deepEqual(await call('submit_turn_notes', { snapshot_id }), { committed: true });

    // And the digest check really runs, so the id is not being ignored.
    assert.deepEqual(await call('submit_turn_notes', { snapshot_id: 'not-a-digest' }),
      { committed: false, error: 'stale_snapshot' });
  });

  test('the three read tools answer turnReadService\'s no-handoff precondition', async () => {
    for (const [name, args] of [
      ['turn_page', {}],
      ['turn_search', { q: 'nothing-in-this-fixture' }],
      ['turn_locate', { q: 'nothing-in-this-fixture' }],
    ]) {
      const payload = await call(name, args, name);
      assert.equal(payload.error, 'no_handoff_loaded', name);
      assert.equal(typeof payload.recovery, 'string', name);
      assert.ok(payload.recovery.length > 0, name);
    }
  });

  test('the store answers a read and a write by the time the server serves', async () => {
    // A store read that completed: the route resolves the head through the store and answers 404 for an
    // absent one. An uninitialized store throws inside the same try and answers 503 instead.
    assert.deepEqual(await childRequest('/api/turn/page?lineage_head=999999'),
      { status: 404, body: { error: 'not_found' } });

    // A store write that committed, reached through the MCP handler's in-process HTTP surface.
    const prepared = await call('prepare_handoff', { paths_to_keep: [], summary: 'wiring probe summary' });
    assert.equal(prepared.status, 'ready');
    assert.equal(typeof prepared.load_token, 'string');
    assert.ok(prepared.load_token.length > 0);
  });

  test('load_handoff reaches the real load route and returns its own outcomes', async () => {
    // No token, no query, nothing delivered into this project: the auto-match path's own answer.
    assert.deepEqual(await call('load_handoff', {}), { found: false });

    const { load_token } = await call('prepare_handoff', { paths_to_keep: [], summary: 'wiring load summary' });
    const loaded = await call('load_handoff', { load_token });
    assert.equal(loaded.found, true);
    assert.equal(loaded.load_token, load_token);
    assert.equal(loaded.summary, 'wiring load summary');
    // A healthy load passes through withLoadRecovery untouched.
    assert.equal(loaded.recovery, undefined);
  });

  test('withLoadRecovery adds the delivery-failure sentence at the tool boundary, not in the route', async (t) => {
    const { load_token } = await call('prepare_handoff', { paths_to_keep: [], summary: 'wiring recovery summary' });

    // Out-of-process equivalent of the in-repo store-method injection: an ABORT trigger makes the
    // delivery insert fail for real, inside the child, on the same connection production uses. SQLite
    // re-prepares the store's statements against the new schema, so the child sees it without a restart.
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    t.after(() => {
      const drop = new DatabaseSync(dbPath, { timeout: 5000 });
      try { drop.exec('DROP TRIGGER IF EXISTS sw_wiring_block_delivery'); } finally { drop.close(); }
    });
    try {
      db.exec("CREATE TRIGGER sw_wiring_block_delivery BEFORE INSERT ON handoff_load "
        + "BEGIN SELECT RAISE(ABORT, 'wiring test: delivery write blocked'); END;");
    } finally { db.close(); }

    // The route's own body — no recovery field anywhere on the HTTP face.
    assert.deepEqual(await childRequest(`/api/handoff/load?load_token=${encodeURIComponent(load_token)}`),
      { status: 503, body: { error: 'handoff_delivery_unavailable', retryable: true } });

    // The same failure through the tool: identical error fields plus the sentence the handler's wrap
    // adds. Wording stays free to improve; its presence is the invariant.
    const wrapped = await call('load_handoff', { load_token });
    assert.equal(wrapped.error, 'handoff_delivery_unavailable');
    assert.equal(wrapped.retryable, true);
    assert.equal(typeof wrapped.recovery, 'string');
    assert.ok(wrapped.recovery.length > 0);
  });
});
