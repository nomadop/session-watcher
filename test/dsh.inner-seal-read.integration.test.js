// The seal's read of its own session against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the real agent loop over the JSONL persistence, which buffers a live session's events behind a batch delay, and the real session-query engine. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

// Every file under `root`, read synchronously: what the persistence has written so far.
function writtenText(root) {
  const texts = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else texts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return texts.join('\n');
}

test('readSession on a live session answers the log as it stood at the call, events not yet written to persistence included, and leaves no session registered', { skip }, async (t) => {
  const [{ Context }, testkit, session, jsonl, { SessionQueryEngine }] = await Promise.all([
    CORDIS,
    'packages/test-support/agent-loop-testkit/lib/index.js',
    'packages/core/session/lib/index.js',
    'packages/session/session-persistence-jsonl/lib/index.js',
    'packages/session-query/session-query/lib/index.js',
  ].map(fromCheckout));

  class EmptySearchEngine extends SessionQueryEngine {
    searchSessions() { return Promise.resolve({ items: [] }); }
    async searchEvents(request) { return { session: (await this.readSurface(request.sessionId)).session, items: [] }; }
  }

  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-seal-read-')));
  const root = join(directory, 'sessions');
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  // Uncompressed, so the scan below reads the written lines as text.
  await ctx.plugin(jsonl, { root, compression: 'none' });
  await testkit.mountAgentLoopTestDependencies(ctx);
  const harness = await testkit.mountAgentLoopTestHarness(ctx);
  await ctx.plugin(EmptySearchEngine);
  const agent = await harness.create(session.SessionId('seal-read'), { provider: 'mock', model: 'opt-model' }, { cwd: directory });
  const live = agent.session;
  assert.equal(await ctx.sessions.flush(live), true, 'the persistence takes part in the flush');

  let created = 0;
  ctx.on('session/created', () => { created += 1; });
  const idsBefore = ctx.sessions.list().map(each => each.id);

  // One synchronous stretch: an event appended, the call, and an event appended after the call.
  const before = session.appendPluginRecord(live, 'plugin:session-watcher/g1-probe', { marker: 'g1-before-call' });
  const writtenAtCall = writtenText(root);
  const reading = ctx.sessionQuery.readSession(live.id);
  const after = session.appendPluginRecord(live, 'plugin:session-watcher/g1-probe', { marker: 'g1-after-call' });
  const seqAfterAppends = live.seq;

  assert.ok(!writtenAtCall.includes('g1-before-call'), 'the event before the call was not yet written when the call was made');
  const snapshot = await reading;
  assert.deepEqual(snapshot.events.map(event => event.seq), Array.from({ length: before + 1 }, (_, seq) => seq),
    'the answer is the contiguous log through the event appended before the call');
  assert.equal(snapshot.events.at(-1).data.marker, 'g1-before-call');
  assert.ok(!snapshot.events.some(event => event.seq === after), 'the event appended after the call is not in the answer');
  assert.deepEqual(snapshot.events, live.snapshotEvents(0, before + 1).map(event => structuredClone(event)),
    'the answer equals the live log through that event');

  assert.equal(created, 0, 'the read announced no session');
  assert.deepEqual(ctx.sessions.list().map(each => each.id), idsBefore, 'the read entered no session into the store');
  assert.equal(ctx.sessions.get(live.id), live, 'the live session stays the one registered under its id');
  assert.equal(live.seq, seqAfterAppends, 'the validation appended nothing to the live log');

  // The scan sees what the persistence writes, so the absence above was the buffer's and not the scan's.
  await ctx.sessions.flush(live);
  const flushed = writtenText(root);
  assert.ok(flushed.includes('g1-before-call') && flushed.includes('g1-after-call'), 'both events are written after the flush');
});
