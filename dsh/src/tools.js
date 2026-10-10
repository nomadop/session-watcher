// dsh/src/tools.js — the session watcher's agent tools on the DSH host: the Claude Code MCP tool set minus `rotate_session`, each answering for the calling agent's own session, `watcher_status` also for any session it names.
// Descriptions and the parameter descriptions `index.js` declares are `index.js`'s, word for word; `watcher_status`'s `sessionId` exists on this host alone. A returned value is the JSON the Claude Code tool's text encodes, `watcher_status`'s without its `url`, and a watcher method's throw propagates as the tool's error.
import { bucketsPayload, bucketSummaryPayload, loadedHandoffPayload, statusDigest, statusWireWithLedger } from '../../lib/wire.js';
import { getLiveLedger } from '../../lib/rate-lamp-manager.js';
import { buildTurnPage } from '../../lib/turn-page.js';
import { createTurnReadService } from '../../lib/turn-read-service.js';
import { withLoadRecovery } from '../../lib/turn-tool-recovery.js';
import { TURN_ADDRESS_RE, TURN_PAGE_BOUNDARY_RE } from '../../lib/turn.js';
import { HISTORY_EXCERPT_CHARS } from '../../lib/turn-history-budget.js';
import { DEFAULT_CTP } from '../../lib/constants.js';
import { createDshTurnRecovery } from '../../lib/harness/dsh/turn-recovery.js';
import { classifyDshToolPair } from '../../lib/harness/dsh/native-tools.js';

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

const includeToolEvidence = pair => classifyDshToolPair(pair, DEFAULT_CTP) === 'residual';

// The checks `index.js`'s zod schemas make and a DSH string parameter cannot declare.
function assertBefore(before) {
  if (before !== undefined && !TURN_PAGE_BOUNDARY_RE.test(before)) {
    throw new Error('before must be an S{k} session label or an S{k}:{T} cursor');
  }
}

function assertScope(scope) {
  if (scope !== undefined && !TURN_ADDRESS_RE.test(scope)) throw new Error('scope must be an S{k}:{T} turn address');
}

function assertQuery(q) {
  if (typeof q !== 'string' || q.trim() === '' || q.length > HISTORY_EXCERPT_CHARS) {
    throw new Error(`q must be a non-blank string of at most ${HISTORY_EXCERPT_CHARS} characters`);
  }
}

// The registry fails a value that is not lossless JSON, and the Claude Code text drops an `undefined` field and writes a non-finite number as `null`.
const lossless = value => JSON.parse(JSON.stringify(value));

/**
 * The tool definitions over `table`.
 * Each call waits for its target session's watcher to leave `bootstrapping` — the calling session's, or the one `watcher_status` names — and lets the wait's rejection — a failed watcher's diagnostic message, an abort, a missing entry — propagate as the tool's error.
 * A `sessionId` the table has not observed goes through `resolvePersisted(sessionId, signal)`, which ensures the persisted record it finds and answers it, or null when the host has no such session, which the tool reports as an error naming the id.
 * `store` is the store the deliveries and turn reads go through; `now` stamps `get_bucket_summary`.
 *
 * @param {{ defineTool: Function, table: { get: Function, waitLive: Function }, store: object, now?: () => number,
 *   resolvePersisted?: (sessionId: string, signal: AbortSignal) => Promise<object|null> }} options
 * @returns {object[]}
 */
export function createTools({ defineTool, table, store, now = Date.now, resolvePersisted = async () => null }) {
  const recovery = createDshTurnRecovery();

  const tool = ({ name, description, parameters = {}, check = () => {}, run }) => defineTool({
    name, description, parameters, output: OUTPUT,
    async execute(args, exec) {
      check(args);
      const sessionId = exec.agent.session.id;
      const entry = await table.waitLive(sessionId, exec.signal);
      return lossless(await run(args, { ...entry, sessionId }));
    },
  });

  const turnReads = ({ sessionId, dialogueSource, dialogueProjection }) => createTurnReadService({
    store: () => store, sessionId: () => sessionId, dialogueSource, dialogueProjection, includeToolEvidence, recovery,
  });

  async function loadHandoff({ watcher, dialogueSource, dialogueProjection }, { load_token, query, query_mode }) {
    if (!load_token && query) return watcher.searchHandoffs({ query: String(query), queryMode: query_mode });
    const delivered = await watcher.deliverHandoff(load_token ? { loadToken: String(load_token) } : {});
    if (delivered.ok === false) return { error: delivered.error, retryable: delivered.retryable === true };
    if (!delivered.found) return delivered;
    return loadedHandoffPayload(delivered, {
      store, turnPageBuilder: buildTurnPage, dialogueSource, dialogueProjection, notice: recovery.notice,
    });
  }

  return [
    defineTool({
      name: 'watcher_status',
      description: "Report whether the Session Watcher is running, the dashboard URL where the host serves one, and one session's current reading: lamp, phase (the wallet clock's), br, u, gEma (smoothed context growth, tokens per call), L, B, model and alert.",
      parameters: {
        sessionId: { type: 'string', description: 'Session to read. Defaults to the calling session; any session this host has run or persisted is readable, and one that has ended is reconstructed first.' },
      },
      output: OUTPUT,
      async execute({ sessionId }, exec) {
        const target = sessionId ?? exec.agent.session.id;
        if (sessionId !== undefined && table.get(sessionId).state === 'unobserved'
          && await resolvePersisted(sessionId, exec.signal) === null) {
          throw new Error(`session ${sessionId} is neither running nor persisted on this host`);
        }
        const { watcher } = await table.waitLive(target, exec.signal);
        return lossless({
          running: true, sessionId: target, reading: statusDigest(statusWireWithLedger(watcher.getStatus(), getLiveLedger(target))),
        });
      },
    }),
    tool({
      name: 'get_bucket_summary',
      description: "Return the current context bucket structure (files, skills) with each row's token size and the session's br, so the agent can decide what to carry over before the context reset the host offers.",
      run: (_args, { watcher, sessionId }) => bucketSummaryPayload(bucketsPayload({
        bucketData: watcher.getBucketData({ includeSymbols: true }), status: watcher.getStatus(), sessionId, now: now(),
      })),
    }),
    tool({
      name: 'prepare_handoff',
      description: 'Persist a keep/discard decision + structured summary before the context reset the host offers; returns a human-readable token to restore context in the next segment.',
      parameters: {
        paths_to_keep: {
          type: 'array',
          description: 'Files to carry over with optional symbol hints; lines are auto-populated from B_rebuild data',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string', required: true, description: 'File path (project-relative)' },
              symbols: { type: 'array', items: { type: 'string' }, description: 'Key symbols to focus on in this file (function/class names)' },
            },
          },
        },
        skills_to_keep: { type: 'array', items: { type: 'string' }, description: 'Skill names to carry over (e.g. "systematic-debugging", "brainstorming")' },
        load_token: { type: 'string', description: 'Existing token to revise. An undelivered handoff keeps its token and changes only the parameters passed — the others keep their stored values, and `skills_to_keep: []` or `next_task: ""` clears its own. A delivered handoff is immutable, so passing its token creates a new handoff from the parameters given, under a new token. Omit to create new' },
        summary: { type: 'string', description: 'Structured summary of current work state' },
        next_task: { type: 'string', description: 'What comes next' },
        observed_segment: { type: 'integer', description: 'Segment index from get_bucket_summary, for a consistency check' },
      },
      run: ({
        paths_to_keep, skills_to_keep, summary, next_task, observed_segment, load_token,
      }, { watcher }) => watcher.prepareHandoff({
        pathsToKeep: paths_to_keep, skillsToKeep: skills_to_keep, summary, nextTask: next_task,
        observedSegment: observed_segment, loadToken: load_token,
      }),
    }),
    tool({
      name: 'load_handoff',
      description: 'Retrieve a prepared handoff package by token, by free-text search, or — with neither given — by auto-match over undelivered handoffs of this project from other sessions. A retrieved package carries the lineage behind it as one headline per session, oldest to newest, beside the newest page of its turns.',
      parameters: {
        load_token: { type: 'string', description: 'Semantic token from prepare_handoff (exact match)' },
        query: { type: 'string', description: 'Free-text search when the token is unknown; returns top matches' },
        query_mode: { type: 'string', enum: ['plain', 'advanced'], description: 'plain (default) escapes input; advanced passes raw FTS5 syntax' },
      },
      run: async (args, entry) => withLoadRecovery(await loadHandoff(entry, args)),
    }),
    tool({
      name: 'get_turn_skeleton',
      description: 'Write the current context epoch to a turn skeleton file and a notes file whose `## NOTE[T]` headings are the slot set, and return both paths, the snapshot id to submit against, and the protocol for filling them.',
      run: (_args, { watcher }) => watcher.getTurnSkeleton(),
    }),
    tool({
      name: 'submit_turn_notes',
      description: 'Commit the notes file the latest get_turn_skeleton wrote. Session Watcher locates that file itself, so no note text crosses the wire. All-or-nothing: every NOTE slot must be covered — by a section in the notes file or by a row the store already holds for that turn — and the snapshot must still be current.',
      parameters: {
        snapshot_id: { type: 'string', required: true, description: 'snapshot_id from get_turn_skeleton' },
      },
      run: ({ snapshot_id }, { watcher }) => watcher.submitTurnNotes({ snapshot_id }),
    }),
    tool({
      name: 'turn_page',
      description: 'Read a page of the history turns carried by the handoff loaded into this session, newest first.',
      parameters: {
        before: { type: 'string', description: 'Where to read back from: an S{k}:{T} cursor from the next_before of the handoff load reply or of a previous page, which ends the page before that turn; or a bare S{k} session label from the load reply\'s lineage, which starts at that session\'s end. Omit for the newest page.' },
      },
      check: ({ before }) => assertBefore(before),
      run: (args, entry) => turnReads(entry).turnPage(args),
    }),
    tool({
      name: 'turn_search',
      description: 'Find a known literal in the transcripts behind the handoff loaded into this session: behaves as grep -F -i -n over them, limited to the active path. Returns one entry per turn the literal landed in, oldest to newest.',
      parameters: {
        q: { type: 'string', required: true, description: 'An exact literal, matched as a case-folded ASCII substring with no tokenization: spacing, punctuation and CJK must match the transcript exactly. A shorter literal reaches more turns, a longer one fewer. Use turn_locate when the wording is uncertain.' },
        scope: { type: 'string', description: 'An S{k}:{T} from turn_locate or from a search entry, narrowing the search to that one turn. Omit to cover the whole lineage.' },
      },
      check: ({ q, scope }) => {
        assertQuery(q);
        assertScope(scope);
      },
      run: (args, entry) => turnReads(entry).turnSearch(args),
    }),
    tool({
      name: 'turn_locate',
      description: 'Find which turns of the loaded handoff mention a remembered term, when the source wording is unknown. Returns entries oldest to newest, each carrying its turn\'s S{k}:{T} scope.',
      parameters: {
        q: { type: 'string', required: true, description: 'One distinctive term, a file path, or a note. Resolved through FTS5 — words are ANDed and CJK is split into bigrams, so a longer phrase narrows toward zero matches.' },
      },
      check: ({ q }) => assertQuery(q),
      run: (args, entry) => turnReads(entry).turnLocate(args),
    }),
  ];
}
