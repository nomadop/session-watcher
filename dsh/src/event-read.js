// dsh/src/event-read.js — the `sw_event_read` tool: one event of a session's log read back as the text it holds, over the session query service's own reads.
// It reads neither the watcher table nor the log files, so it answers for any session the caller's directory holds, whether or not the host measures it.
import { EVENT_READ_TOOL, formatEventRead } from '../../lib/harness/dsh/event-read.js';
import { hostDiagnostic, writeDiagnostic } from './watcher-table.js';

const UNTITLED = 'untitled';
const UNAUTHORIZED = 'SESSION_QUERY_TOOL_UNAUTHORIZED';
const FAILED = 'SESSION_QUERY_TOOL_FAILED';
const CARRIED = 'SW_EVENT_CARRIED';

// What the model is told of a service failure by its code; a failure of any other code is told as the generic one.
const SAFE_FAILURES = {
  SESSION_QUERY_ABORTED: 'session query was cancelled',
  SESSION_QUERY_EVENT_NOT_FOUND: 'session event was not found',
  SESSION_QUERY_INVALID_WINDOW: 'session event window is invalid',
  SESSION_QUERY_SESSION_NOT_FOUND: 'session was not found',
};


/**
 * The tool definition over the context's `sessionQuery` service, read at each call.
 * A target other than the caller's own session must be listed with the caller's directory before it is read, and the header of what was read, and of its title, must be the requested id in that directory again; a caller with no directory reads its own session alone.
 * A service failure, or a title that cannot be read, never reaches the model as the service wrote it: the failure is a message fixed by its code and a stderr line holds the original, and a title that cannot be read is `untitled`. A cancellation is the signal's own reason.
 * An event of the caller's own session that `heldInContext(sessionId, seq)` answers is in its context whole is refused before any read, whatever window the call asks for, the neighbors included; a check that throws is a stderr line and refuses nothing.
 *
 * The failures are `HarnessError`s, the one error class whose code the tool runtime records with a failed result.
 *
 * @param {{ defineTool: Function, ctx: { sessionQuery: object }, extractSessionEventText: (event: object) => string, HarnessError: new (message: string, code: string) => Error, heldInContext?: (sessionId: string, seq: number) => boolean }} options
 */
export function createEventReadTool({ defineTool, ctx, extractSessionEventText, HarnessError, heldInContext = () => false }) {
  const failure = (message, code) => new HarnessError(message, code);
  const unauthorized = () => failure('session target is outside the caller workspace', UNAUTHORIZED);
  const assertCount = (name, value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw failure(`${name} must be a non-negative safe integer`, 'SESSION_QUERY_INVALID_WINDOW');
  };

  // The refusal is a nudge the read can do without: a check that throws refuses nothing.
  const isHeld = (sessionId, seq) => {
    try {
      return heldInContext(sessionId, seq);
    } catch (error) {
      writeDiagnostic(sessionId, hostDiagnostic('event_read_held_failed', error));
      return false;
    }
  };

  // A service call that a cancellation ends with the signal's reason, and any other failure with the fixed message of its code.
  const guarded = async (sessionId, signal, call) => {
    signal.throwIfAborted();
    try {
      const value = await call();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      writeDiagnostic(sessionId, hostDiagnostic('event_read_failed', error));
      const message = typeof error?.code === 'string' && Object.hasOwn(SAFE_FAILURES, error.code) ? SAFE_FAILURES[error.code] : undefined;
      throw message === undefined ? failure('session query operation failed', FAILED) : failure(message, error.code);
    }
  };

  return defineTool({
    name: EVENT_READ_TOOL,
    description: 'Read the full unabridged text of one event and optional neighboring raw-event summaries from an authorized session.',
    parameters: {
      session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
      before: { type: 'integer', description: 'Number of preceding raw events to summarize. Omit for none.' },
      after: { type: 'integer', description: 'Number of following raw events to summarize. Omit for none.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute({ session_id: requested, seq, before, after }, { agent, signal }) {
      assertCount('seq', seq);
      if (before !== undefined) assertCount('before', before);
      if (after !== undefined) assertCount('after', after);
      const { id: callerId, header } = agent.session;
      const sessionId = requested ?? callerId;
      if (sessionId === callerId && isHeld(callerId, seq)) {
        throw failure(`Event seq ${seq} is already in your context word for word; reading it gives the same text. Use it.`, CARRIED);
      }
      const run = call => guarded(callerId, signal, call);
      // The id and the directory the caller's own are exactly the ones the read must observe.
      const assertObserved = (observed) => {
        if (observed?.id !== sessionId || observed.cwd !== header.cwd) throw unauthorized();
      };
      if (sessionId !== callerId) {
        if (header.cwd === undefined) throw unauthorized();
        const records = await run(() => ctx.sessionQuery.filterSessions([{ kind: 'id', values: [sessionId] }, { kind: 'cwd', values: [header.cwd] }], signal));
        if (records.length !== 1) throw unauthorized();
      }
      const window = await run(() => ctx.sessionQuery.readEvent({
        sessionId, seq, ...before === undefined ? {} : { before }, ...after === undefined ? {} : { after },
      }, signal));
      assertObserved(window.session);

      let title = UNTITLED;
      try {
        const [observation] = await run(() => ctx.sessionQuery.readTitleSnapshots([sessionId], signal));
        if (observation?.status === 'fulfilled') {
          assertObserved(observation.value.session);
          title = observation.value.title?.title ?? UNTITLED;
        } else {
          writeDiagnostic(callerId, hostDiagnostic('event_read_title_failed', observation?.reason));
        }
      } catch (error) {
        if (error.code === UNAUTHORIZED) throw error;
        signal.throwIfAborted();
      }
      return formatEventRead({ sessionId, title, window, textOf: extractSessionEventText });
    },
  });
}
