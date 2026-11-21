// dsh/src/inner-mode.js — the host adapter of the inner compaction session mode: the record a selection appends, the classification of the events the shared fold (`lib/inner-seal/mode.js`) takes, the selection, the plain subagent's inheritance and the access the channel reads.
// It knows no Cordis and imports no DSH package: the `dsh-session` record functions reach it by parameter.
import { writeDiagnostic, hostDiagnostic } from './watcher-table.js';
import { foldMode, INITIAL_MODE, modeStateOf } from '../../lib/inner-seal/mode.js';

/** The plugin record a selection appends: the SW namespace the log keeps beside the events the model sees. */
export const MODE_RECORD_TYPE = 'plugin:session-watcher/inner-mode';
/** The projection key the registry keeps the mode under. */
export const MODE_PROJECTION_KEY = 'session-watcher/inner-mode';

const messageOf = error => (error instanceof Error ? error.message : String(error));

/** Whether a committed event is an input of the mode's projection, a mode record or a `turn/start`. */
export const isModeInput = event => event.type === 'turn/start' || event.type === MODE_RECORD_TYPE;

// The persisted state seeds a fold only when it is one of the six states; any other value is refused with an error.
const stateSchema = {
  parse(value) {
    const state = modeStateOf(value);
    if (state === null) throw new Error('the inner mode state is not { mode, locked }');
    return state;
  },
};

/**
 * The host-only projection of the session mode: the classification of the events the fold takes.
 * `turn/start` is the fold's turn input and a plugin record of `MODE_RECORD_TYPE` its record input; any other event leaves the state as it was.
 * The fold is pure and writes nothing: an invalid mode's diagnostic belongs to the seal listener.
 *
 * @param {{ pluginRecordOf: (event: object) => ({ type: string, data: unknown } | undefined) }} kit
 */
export function innerModeProjection({ pluginRecordOf }) {
  return {
    key: MODE_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => INITIAL_MODE,
    apply(state, event) {
      if (event.type === 'turn/start') return foldMode(state, { turnStarted: true });
      const record = pluginRecordOf(event);
      if (record?.type !== MODE_RECORD_TYPE) return state;
      return foldMode(state, { record: record.data });
    },
  };
}

/**
 * The selection of a mode: `select(session, enabled)` appends the mode record to `session` and answers `'selected'`, or answers `'locked'` and appends nothing once a turn has started.
 * The lock is `agents.turnBoundaryOf(session)` read as the agent preset reads it, an open turn or a turn already begun, and it is read and the record appended in one synchronous stretch, so no event can come between them.
 * An append that throws propagates: no record was written.
 *
 * @param {{ agents: { turnBoundaryOf: (session: object) => { openTurnStartSeq: number|null, lastTurn: number } },
 *   appendPluginRecord: (session: object, type: string, data: unknown) => number }} options
 */
export function createModeSelection({ agents, appendPluginRecord }) {
  return (session, enabled) => {
    const boundary = agents.turnBoundaryOf(session);
    if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) return 'locked';
    appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled });
    return 'selected';
  };
}

/**
 * The `agent/created` listener that gives a plain subagent its parent's mode.
 * A plain subagent is `header.origin === 'subagent'` over an empty seed whose first event, read through `readSession`, is not the `session/end-seed` marker, which tells a new session from a resumed or seeded one; a fork's child inherits the records with its prefix and a resumed one holds its own.
 * The cheap checks come first, so only a child that holds no seed is read, and its log holds only what its creation wrote.
 * Whether to give the child anything is read from `readSettings()` as the child is created, before any await, so a save that lands while the child's first event is read changes nothing for this child; a child created while the settings do not ask for it gets no record and is off, and no other child is touched later.
 * The parent's valid mode, `on` or `off`, a blank parent's included, is appended to the child as its own record, `{ v: 1, enabled }`.
 * The listener answers a promise the serial `agent/created` dispatch awaits, so the record stands before the child's first turn.
 * A parent that is missing or `invalid`, a first event that cannot be read and an append that throws write one `inner_mode_not_inherited` diagnostic under the child and leave it off; nothing is retried or filled in later.
 *
 * @param {{ sessionOf: (id: string) => (object|undefined), readMode: (session: object) => { mode: string },
 *   readSettings: () => { inheritInSubagents: boolean },
 *   readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   appendPluginRecord: (session: object, type: string, data: unknown) => number }} options
 * @returns {(payload: { agent: { session: object } }) => Promise<void>}
 */
export function createModeInheritance({ sessionOf, readMode, readSettings, readSession, appendPluginRecord }) {
  return async ({ agent: { session } }) => {
    if (session.header.origin !== 'subagent' || session.firstLiveSeq !== 0 || !readSettings().inheritInSubagents) return;
    const refuse = reason => writeDiagnostic(session.id, hostDiagnostic('inner_mode_not_inherited', reason));
    let first;
    try {
      [first] = (await readSession(session.id)).events;
    } catch (error) {
      refuse(`the first event of the subagent could not be read (${messageOf(error)}), so it is not known whether the subagent is new; this subagent stays off`);
      return;
    }
    if (first?.type === 'session/end-seed') return;
    const parent = sessionOf(session.header.parentSession);
    if (parent === undefined) {
      refuse(`the parent session ${session.header.parentSession} is not live, so its inner mode is unknown; this subagent stays off`);
      return;
    }
    const { mode } = readMode(parent);
    if (mode === 'invalid') {
      refuse(`the parent session ${parent.id} has an invalid inner mode record; this subagent stays off`);
      return;
    }
    try {
      appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled: mode === 'on' });
    } catch (error) {
      refuse(error);
    }
  };
}

/**
 * The mode as the RPC channel reads and writes it by session id.
 * `read(sessionId)` answers the projection's state and `select(sessionId, enabled)` the selection's outcome, and both answer `undefined` and `'unknown'` for a session the host does not hold live; both are synchronous, which the measurement's frames and the selection's lock check rely on.
 * `display(sessionId)` is what a page reads: a promise of the held session's state or, for a session the host holds no instance of, of the state `readStored(sessionId)` folds from its stored log once a turn has started and so locked it, since a mode no selection can reach is not shown.
 * It answers `undefined` for a stored log that has started no turn and for a session that is not stored, and a failure of the stored read or fold rejects.
 *
 * @param {{ sessionOf: (id: string) => (object|undefined), readMode: (session: object) => { mode: string, locked: boolean },
 *   select: (session: object, enabled: boolean) => 'selected' | 'locked',
 *   readStored: (sessionId: string) => Promise<{ state: { mode: string, locked: boolean } }|undefined> }} options
 */
export function createModeAccess({ sessionOf, readMode, select, readStored }) {
  const access = {
    read(sessionId) {
      const session = sessionOf(sessionId);
      return session === undefined ? undefined : readMode(session);
    },
    async display(sessionId) {
      const held = access.read(sessionId);
      if (held !== undefined) return held;
      const stored = await readStored(sessionId);
      return stored?.state.locked === true ? stored.state : undefined;
    },
    select(sessionId, enabled) {
      const session = sessionOf(sessionId);
      return session === undefined ? 'unknown' : select(session, enabled);
    },
  };
  return access;
}
