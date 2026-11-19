// test/helpers/dsh-mode-kit.js — the `dsh-session` values the session mode reaches through the kit (`appendPluginRecord`, `pluginRecordOf`) and the sessions they work on, the `dsh-llm` stream readers the monitor adds and the session query service's failure.
// With `SW_DSH_CHECKOUT` naming a built checkout the values are the real package's over its real detached `Session`; without one a recording double stands in, with the same grammar, envelope and `ignorable` mark.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SESSION_LIB = 'packages/core/session/lib/index.js';
const QUERY_LIB = 'packages/session-query/session-query/lib/index.js';
const LLM_LIB = 'packages/llm/llm/lib/index.js';

const real = CHECKOUT && existsSync(join(CHECKOUT, SESSION_LIB))
  ? await import(pathToFileURL(join(CHECKOUT, SESSION_LIB)).href)
  : null;
const query = CHECKOUT && existsSync(join(CHECKOUT, QUERY_LIB))
  ? await import(pathToFileURL(join(CHECKOUT, QUERY_LIB)).href)
  : null;
const llm = real !== null && existsSync(join(CHECKOUT, LLM_LIB))
  ? await import(pathToFileURL(join(CHECKOUT, LLM_LIB)).href)
  : null;

/** The compaction settings a deployment that never saved any reads: the Config's own defaults. */
export const DEFAULT_SETTINGS = Object.freeze({ preset: 'M2', fallbackModel: null, inheritInSubagents: false });

/** The settings of a user who asked their subagents to follow the compaction choice. */
export const INHERITING_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, inheritInSubagents: true });

/** Whether the kit and its sessions are the checkout's own. */
export const REAL_KIT = real !== null;

const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;

// A detached log with the members of `Session` the mode reads: `id`, `header`, `firstLiveSeq`, `eventAt`, `snapshotEvents` and `append`, which answers the event it appended as the real method does.
// As the real constructor does, a supplied seed is followed by the end-seed marker unless it ends in one, and `firstLiveSeq` is the log's length before that marker.
function doubleSession({ id, header, seed }) {
  const log = (seed ?? []).map(event => structuredClone(event));
  const firstLiveSeq = log.length;
  if (seed !== undefined && log.at(-1)?.type !== 'session/end-seed') {
    log.push({ type: 'session/end-seed', seq: log.length, time: Date.now(), data: header.isSeeded ? { inherited: true } : {} });
  }
  return {
    id,
    header,
    firstLiveSeq,
    eventAt: seq => log[seq],
    snapshotEvents: () => [...log],
    append(type, data) {
      const event = { type, seq: log.length, time: Date.now(), data: structuredClone(data) };
      log.push(event);
      return event;
    },
  };
}

const doubleKit = {
  appendPluginRecord(session, type, data) {
    if (!PLUGIN_RECORD_TYPE.test(type)) throw new Error(`plugin record type "${type}" is outside the grammar`);
    const event = session.append(type, data);
    event.ignorable = true;
    return event.seq;
  },
  pluginRecordOf(event) {
    if (event.ignorable !== true || !PLUGIN_RECORD_TYPE.test(event.type)) return undefined;
    return { type: event.type, seq: event.seq, time: event.time, data: event.data };
  },
};

/** The failure the session-query service rejects `readSession` with, `code` one of its closed taxonomy: the checkout's own `SessionQueryError` where there is one, else an `Error` of the same name and `code`. */
export function sessionQueryError(message, code) {
  return query === null ? Object.assign(new Error(message), { name: 'SessionQueryError', code }) : new query.SessionQueryError(message, code);
}

/** The kit `createInnerMode…` functions take: `{ appendPluginRecord, pluginRecordOf }`. */
export const modeKit = real === null ? doubleKit : { appendPluginRecord: real.appendPluginRecord, pluginRecordOf: real.pluginRecordOf };

/** The kit the monitor reads, the mode's values and the stream readers of `dsh-llm`; null without a checkout that has them. */
export const monitorKit = llm === null ? null : { ...modeKit, assembleAssistantStream: llm.assembleAssistantStream, lastAssistantStreamChunk: llm.lastAssistantStreamChunk };

/** The compact stream the checkout's accumulator keeps of `chunks`, a tick apart; needs the checkout's `dsh-llm`. */
export function compactStreamOf(chunks) {
  const accumulator = new llm.AssistantStreamAccumulator();
  chunks.forEach((chunk, tick) => accumulator.push({ time: 1_700_000_000_000 + tick, chunk }));
  return accumulator.snapshot();
}

/** `session` as it is under a DSH that has dropped the deprecated `Session.eventAt`: a read of it throws. */
export function withoutEventAt(session) {
  Object.defineProperty(session, 'eventAt', { value() { throw new Error('Session.eventAt is no longer available'); } });
  return session;
}

/** A session header in the log's current shape. */
export const sessionHeader = (id, extra = {}) => ({ version: 4, id, createdAt: 1, isSeeded: false, ...extra });

/**
 * A detached session of `id`; `header` adds to the header (`origin`, `parentSession`, `isSeeded`), `seed` and `inheritedEventCount` seed the log as a fork's child is seeded.
 * `seed` is an array of events whose seqs are their indexes.
 */
export function newSession(id, { header = {}, seed, inheritedEventCount } = {}) {
  const full = sessionHeader(id, header);
  if (real !== null) return real.Session.create(id, seed, full, inheritedEventCount);
  return doubleSession({ id, header: full, seed });
}

/** The inclusive prefix `through` of `session` as a fork's child is seeded with it: the events, the inherited cut and the closers of an open tail. */
export function forkSeedOf(session, through) {
  if (real !== null) return real.buildForkSeed(session.snapshotEvents(), through);
  const prefix = session.snapshotEvents().slice(0, through + 1);
  return [...prefix, { type: 'session/end-seed', seq: through + 1, time: prefix[through].time, data: { inherited: true } }];
}

/** The turn boundary `agents.turnBoundaryOf` states for `session`: the last turn started and the open turn's start, null when every started turn has ended. */
export function turnBoundaryOf(session) {
  let openTurnStartSeq = null;
  let lastTurn = 0;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') {
      openTurnStartSeq = event.seq;
      lastTurn = event.data.turn;
    } else if (event.type === 'turn/end') openTurnStartSeq = null;
  }
  return { openTurnStartSeq, lastStepStartSeq: null, lastStepBoundary: null, lastTurn };
}

/** An `agents` service answering `turnBoundaryOf` as the real method does, on the service alone. */
export function fakeAgents() {
  const agents = {
    turnBoundaryOf(session) {
      if (this !== agents) throw new TypeError('turnBoundaryOf called without its service');
      return turnBoundaryOf(session);
    },
  };
  return agents;
}
