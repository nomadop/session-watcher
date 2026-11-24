// test/helpers/dsh-read-guard-child.js — one read guard scenario of the shipped host entry over the real DSH loop (`dsh-shipped-loop.js`), run in a fresh Node process by `test/dsh.read-guard.integration.test.js`.
// The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made. A scenario that fails an assertion exits non-zero with it on stderr; what it writes to stdout is the evidence the case reports.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readBlockFeedback, READ_BLOCK_RECORD_TYPE } from '../../dsh/src/read-guard.js';
import { isReadBlockRecord } from '../../lib/inner-seal/read-block-record.js';
import { CARRIER_KIND, INNER_CALL_RECORD_TYPE, mountShippedLoop, REPLY_PADDING, SEAL_STEPS, SEAL_WAIT_TURNS, slotNotes, turnOf } from './dsh-shipped-loop.js';

const [scenario] = process.argv.slice(2);
const ROOT = realpathSync(process.env.TMPDIR);

// The lines the host writes to stderr from here on; its diagnostics arrive as `console.error` lines.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const lines = (label, count) => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`);
const textOf = rows => `${rows.join('\n')}\n`;

// A turn whose user text is `tool:<name> <json>` makes the model call that tool once, then answer; `tools:` makes it call each in one step; any other turn is answered with text.
const directive = (name, args) => `tool:${name} ${JSON.stringify(args)}`;
const inOneStep = (...calls) => `tools:${JSON.stringify(calls.map(([name, args]) => ({ name, args })))}`;
function reply(n, options) {
  const asked = options.messages.at(-1)?.role === 'user' ? options.messages.findLast(message => message.source?.kind === 'user') : undefined;
  const text = asked?.content?.find(block => block.type === 'text')?.text;
  const match = text === undefined ? null : /^tool:(\w+) (.*)$/s.exec(text);
  if (match !== null) return { toolCalls: [{ id: `call-${n}`, name: match[1], arguments: match[2] }] };
  const calls = text === undefined ? null : /^tools:(.*)$/s.exec(text);
  return calls === null ? `reply ${n}` : { toolCalls: JSON.parse(calls[1]).map(({ name, args }, index) => ({ id: `call-${n}-${index + 1}`, name, arguments: JSON.stringify(args) })) };
}

async function* summary(count) {
  const text = slotNotes(count, 'summary of slot');
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

const isCarrierEvent = event => event?.type === 'user/message' && event.data?.source?.kind === CARRIER_KIND;
const textsOf = content => content.filter(block => block.type === 'text').map(block => block.text).join('');

// The calls of `events` after `at`, each `{ name, arguments, result, record }`: the dispatched call, the error or answer it ended in and the read block record appended between them, if any.
function callsAfter(events, at) {
  const after = events.slice(at);
  const calls = after.filter(event => event.type === 'tool/call');
  return calls.map((call) => {
    const result = after.find(event => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.toolCallId === call.data.callId && event.data.step === call.data.step && event.data.turn === call.data.turn);
    const record = after.find(event => event.type === READ_BLOCK_RECORD_TYPE && event.data.callId === call.data.callId && event.data.turn === call.data.turn && event.data.step === call.data.step);
    return { name: call.data.name, arguments: JSON.parse(call.data.arguments), call, result, record };
  });
}

// Plain turns, each padded, until one seals; the carrier is on the surface when it returns.
async function untilSealed({ agent, llm, session }) {
  for (let index = 0; index < SEAL_WAIT_TURNS; index += 1) {
    const at = session.seq;
    await turnOf(agent, llm, `plain ${index + 1}`);
    if (session.snapshotEvents().slice(at).some(event => event.type === INNER_CALL_RECORD_TYPE)) {
      assert.ok(session.surface.nodes.some(seq => isCarrierEvent(session.snapshotEvents()[seq])), 'a carrier stands on the surface');
      return index + 1;
    }
  }
  throw new Error('no seal within the plain turns');
}

async function session({ enabled }) {
  const rig = await mountShippedLoop({ tools: true, persistence: true, padding: REPLY_PADDING, reply, summary });
  const { ctx, call, harness } = rig;
  const dir = join(ROOT, 'guard');
  mkdirSync(dir, { recursive: true });
  const files = { 'a.txt': lines('alpha', 20), 'b.txt': lines('bravo', 10) };
  for (const [file, rows] of Object.entries(files)) writeFileSync(join(dir, file), textOf(rows));
  const agent = await harness.create(`guard-${enabled ? 'on' : 'off'}-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: dir });
  assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled }), { ok: true, value: {} });
  return { ...rig, agent, session: agent.session, dir, files, at: file => join(dir, file) };
}

const SCENARIOS = {
  // Over a sealed session: the read of lines the carrier holds and the disk has not changed is answered with the error and recorded; the edit that follows it goes through on the read's own observation; a read of a file rewritten on disk, and one that also asks for lines not held, run as any read does; a relative path is the same file.
  async 'read-guard-sealed'() {
    const rig = await session({ enabled: true });
    const { agent, llm, session: log, at, dir } = rig;
    // One step that reads both files, so the first range holds every line of each.
    await turnOf(agent, llm, inOneStep(['read', { file_path: at('a.txt') }], ['read', { file_path: at('b.txt') }]));
    // Before the seal the context holds those results as they are, and a read of the same lines is held already.
    const early = log.seq;
    await turnOf(agent, llm, directive('read', { file_path: at('a.txt'), offset: 2, limit: 3 }));
    const [beforeSeal] = callsAfter(log.snapshotEvents(), early);
    assert.equal(beforeSeal.result.data.message.isError, true, 'an unsealed result is context as well');
    assert.equal(textsOf(beforeSeal.result.data.message.content), readBlockFeedback({ first: 2, last: 4, path: at('a.txt') }));
    const plain = await untilSealed({ agent, llm, session: log });
    assert.ok(plain >= 1);

    // The sealed read: every line is in the carrier's B, so the read is answered with the error.
    const sealedAt = log.seq;
    await turnOf(agent, llm, directive('read', { file_path: at('a.txt') }));
    const [blocked] = callsAfter(log.snapshotEvents(), sealedAt);
    assert.equal(blocked.name, 'read');
    assert.equal(blocked.result.data.message.isError, true, 'the read is an error');
    assert.equal(textsOf(blocked.result.data.message.content), readBlockFeedback({ first: 1, last: 20, path: at('a.txt') }), 'whose one text block states the lines and the path as the model named it');
    assert.equal(blocked.result.data.message.content.length, 1);
    assert.ok(blocked.record !== undefined, 'the block is recorded');
    assert.ok(isReadBlockRecord(blocked.record.data));
    assert.deepEqual(blocked.record.data, { v: 1, turn: blocked.call.data.turn, step: blocked.call.data.step, callId: blocked.call.data.callId, path: at('a.txt'), first: 1, last: 20 });
    assert.ok(blocked.call.seq < blocked.record.seq && blocked.record.seq < blocked.result.seq, 'the record stands between the call and its result');

    // The edit that follows needs no read of its own: the blocked read has observed the file.
    const editAt = log.seq;
    const old = 'alpha line 3\n';
    await turnOf(agent, llm, directive('edit', { file_path: at('a.txt'), old_string: old, new_string: 'alpha line three\n' }));
    const [edit] = callsAfter(log.snapshotEvents(), editAt);
    assert.equal(edit.name, 'edit');
    assert.equal(edit.result.data.message.isError, false, `the edit goes through: ${textsOf(edit.result.data.message.content)}`);
    assert.equal(readFileSync(at('a.txt'), 'utf8').split('\n')[2], 'alpha line three');

    // A relative path names the same file, and the lines the edit did not touch are still held.
    const relativeAt = log.seq;
    await turnOf(agent, llm, directive('read', { file_path: 'b.txt', offset: 2, limit: 5 }));
    const [relative] = callsAfter(log.snapshotEvents(), relativeAt);
    assert.equal(relative.result.data.message.isError, true);
    assert.equal(textsOf(relative.result.data.message.content), readBlockFeedback({ first: 2, last: 6, path: 'b.txt' }), 'the path is the model\'s own text');

    // A file rewritten on disk since it was held: the read runs, its lines are not the held ones.
    writeFileSync(at('b.txt'), textOf(rig.files['b.txt'].map((row, index) => (index === 3 ? 'bravo line 4, rewritten behind the agent' : row))));
    const changedAt = log.seq;
    await turnOf(agent, llm, directive('read', { file_path: at('b.txt') }));
    const [changed] = callsAfter(log.snapshotEvents(), changedAt);
    assert.equal(changed.result.data.message.isError, false, 'a rewritten file is read as any read is');
    assert.ok(textsOf(changed.result.data.message.content).includes('bravo line 4, rewritten behind the agent'));
    assert.equal(changed.record, undefined, 'and no block is recorded');

    // A read that asks for lines the context never held, beside lines it holds: the whole read runs.
    writeFileSync(join(dir, 'c.txt'), textOf(lines('charlie', 6)));
    const newAt = log.seq;
    await turnOf(agent, llm, directive('read', { file_path: at('c.txt') }));
    const [fresh] = callsAfter(log.snapshotEvents(), newAt);
    assert.equal(fresh.result.data.message.isError, false, 'a file never read is read');

    assert.deepEqual(stderrLines.filter(line => line.includes('read_guard') || line.includes('inner_')), [], 'no diagnostic of the guard or the seal');
    console.log(JSON.stringify({ blocked: blocked.record.data, plainTurns: plain, sealSteps: SEAL_STEPS }));
    await rig.ctx.fiber.dispose();
  },

  // The same script with the mode off: no read is answered with the error, whatever the context holds.
  async 'read-guard-off'() {
    const rig = await session({ enabled: false });
    const { agent, llm, session: log, at } = rig;
    for (let again = 0; again < 2; again += 1) {
      const from = log.seq;
      await turnOf(agent, llm, directive('read', { file_path: at('a.txt') }));
      const [read] = callsAfter(log.snapshotEvents(), from);
      assert.equal(read.result.data.message.isError, false, `read ${again + 1} of a held file runs`);
      assert.equal(read.record, undefined);
    }
    assert.deepEqual(log.snapshotEvents().filter(event => event.type === READ_BLOCK_RECORD_TYPE), []);
    assert.deepEqual(stderrLines.filter(line => line.includes('read_guard')), []);
    await rig.ctx.fiber.dispose();
  },
};

if (!Object.hasOwn(SCENARIOS, scenario)) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
try {
  await SCENARIOS[scenario]();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
