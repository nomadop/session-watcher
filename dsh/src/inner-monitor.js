// dsh/src/inner-monitor.js — the monitor of the inner seal's attempts: the records an attempt leaves around its auxiliary call and the registry of the attempts still in flight.
// It knows no Cordis and imports no DSH package: the record appender and the publish reach it by parameter.
import { attemptRecordOf } from '../../lib/inner-seal/attempt-record.js';
import { endRecordOf } from '../../lib/inner-seal/end-record.js';
import { requestDisplayOf } from './inner-summary.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE, messageOf } from './inner-seal.js';
import { hostDiagnostic, writeDiagnostic } from './watcher-table.js';

/** The kinds of cause the agent loop aborts a turn with. */
const CANCEL_KINDS = ['user', 'parent', 'hook', 'disposed'];

// How an end record shows a cancel cause of the agent loop, its kind and a hook's reason, so the object is not flattened to `[object Object]`; `undefined` for any other value.
function causeText(cause) {
  if (!CANCEL_KINDS.includes(cause?.kind)) return undefined;
  return cause.kind === 'hook' && typeof cause.reason === 'string' ? `hook: ${cause.reason}` : cause.kind;
}

// Why an end record says the attempt ended: a cancel cause of the loop where the failure exit saw the abort in force, else the text of the error the seal throws.
const reasonOf = (error, { cancelled, cancelReason }) => (cancelled ? causeText(cancelReason) : undefined) ?? messageOf(error);

/**
 * The monitor of the inner seal's attempts.
 * `begin(session, { range, quote })` makes the attempt of one summary request of a seal over the seqs in `range`, triggered on `quote`, the `innerQuote` snapshot the seal took before the summary, each request the seal asks again having its own; it, the construction and `live` only allocate and read memory.
 * The attempt is the observer of `summarizeSlots` and the seal's handle on its end. `dispatch` appends the attempt record, which keeps `quote` as it was handed, takes the record's seq as `startSeq` and enters the generating entry; `chunk()` publishes the session's id as the entry's stream grows; `responded({ endedAt })` makes it validating with the call's end time; `committed` and `failed(error, { cancelled, cancelReason })`, which also appends the end record, take it. Every change publishes the session's id, a terminal one after the entry is gone.
 * No method throws: a projection, append or publish that fails is one `inner_monitor_*` line on stderr, never retried, and leaves no entry live. An attempt with no `startSeq`, because it never dispatched or its record could not be appended, has no record to end and writes, takes and publishes nothing at its end.
 * `live(sessionId)` answers a copy of each entry of that session in flight, `{ attempt, phase, endedAt, request, tools, stream }`, `tools` being the request's own array, kept in memory only, and `stream()` the accumulator's snapshot as it stands.
 *
 * @param {{ appendPluginRecord: (session: object, type: string, data: object) => number, publish: (sessionId: string) => void }} options
 */
export function createInnerMonitor({ appendPluginRecord, publish }) {
  // The attempts that dispatched and did not end: the session each belongs to and its entry.
  const active = new Set();

  return {
    begin(session, { range, quote }) {
      const sessionId = session.id;
      let owner = null;
      const guard = (code, body) => {
        try {
          body();
        } catch (error) {
          writeDiagnostic(sessionId, hostDiagnostic(code, error));
        }
      };
      const changed = () => guard('inner_monitor_publish_failed', () => publish(sessionId));
      const attempt = {
        startSeq: null,
        dispatch({ options, input, stream }) {
          guard('inner_monitor_start_failed', () => {
            const request = requestDisplayOf(options, input);
            const recorded = { first: range[0], last: range.at(-1), count: range.length };
            attempt.startSeq = appendPluginRecord(session, INNER_ATTEMPT_RECORD_TYPE, attemptRecordOf({ range: recorded, request, quote }));
            owner = { sessionId, entry: { attempt: attempt.startSeq, phase: 'generating', endedAt: null, request, tools: options.tools, stream } };
            active.add(owner);
          });
          if (owner !== null) changed();
        },
        chunk() {
          if (owner !== null) changed();
        },
        responded({ endedAt }) {
          if (owner === null) return;
          owner.entry.phase = 'validating';
          owner.entry.endedAt = endedAt;
          changed();
        },
        committed() {
          if (owner === null) return;
          active.delete(owner);
          changed();
        },
        failed(error, circumstances) {
          if (attempt.startSeq === null) return;
          guard('inner_monitor_end_failed', () => {
            appendPluginRecord(session, INNER_END_RECORD_TYPE, endRecordOf({
              attempt: attempt.startSeq, outcome: circumstances.cancelled ? 'cancelled' : 'failed', reason: reasonOf(error, circumstances),
            }));
          });
          active.delete(owner);
          changed();
        },
      };
      return attempt;
    },
    live: sessionId => [...active].filter(each => each.sessionId === sessionId).map(({ entry }) => ({ ...entry })),
  };
}
