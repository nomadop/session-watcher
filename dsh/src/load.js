// dsh/src/load.js — the load of a handoff into a session: the delivery, the `read` calls its keep list plans, the one message that hands both to the model, the hand-over that queues it with the follow-up, and the `/sw-load` command around them.
// It knows no Cordis: the delivery, the tool runtime, the working directory and the DSH message factory (`kit`) reach it by parameter.
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { formatAge } from '../../lib/handoff-discovery.js';
import { loadMessageInput } from '../../lib/harness/dsh/load-message.js';

/** The longest window one planned read asks for: the `read` tool's default `readLimit`, which a larger `limit` exceeds and the tool refuses. */
export const READ_LINE_CAP = 2000;

/** The window read from an entry that names no lines. */
const HEAD_LINES = 40;

const RANGED = /\(lines (\d+)-(\d+)\)/;

const NO_ROUTE = 'No model route is known for this session yet.';
const messageOf = error => (error instanceof Error ? error.message : String(error));

// The first regular file among the candidates of `path`: itself when absolute, else under `cwd`, then `projectDir`.
function locate(path, cwd, projectDir) {
  const candidates = isAbsolute(path) ? [path] : [resolve(cwd, path), ...(projectDir ? [resolve(projectDir, path)] : [])];
  return candidates.find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile()) ?? null;
}

// The `[offset, end]` windows of one kept entry, by the first row that applies: its line ranges, the ranges its resolved symbols carry, or the file's head.
function windowsOf(entry) {
  if (entry.lines?.length) return entry.lines.map(([from, to]) => [from, to]);
  const ranged = (entry.resolvedSymbols ?? []).map(text => RANGED.exec(text)).filter(Boolean)
    .map(([, from, to]) => [Number(from), Number(to)]);
  return ranged.length > 0 ? ranged : null;
}

/**
 * The reads a delivered keep list plans, in entry order: `reads` each `{ file_path, offset, limit, end }` with `file_path` absolute, `limit` at most `READ_LINE_CAP` and `end` the last line of the range before that cut; `skipped` each `{ path, reason }` for a path no candidate resolves to a regular file; `toPlace` each `{ path, names }` for an entry read from its head whose `symbols` name what to find in it.
 * A relative path resolves against `cwd`, then the payload's `project_dir`.
 */
export function planReads({ paths_to_keep: entries = [], project_dir: projectDir }, { cwd }) {
  const reads = [];
  const skipped = [];
  const toPlace = [];
  for (const entry of entries) {
    const file = locate(entry.path, cwd, projectDir);
    if (file === null) {
      skipped.push({ path: entry.path, reason: 'no regular file at this path under the working directory or the project directory' });
      continue;
    }
    const windows = windowsOf(entry);
    if (windows === null && entry.symbols?.length) toPlace.push({ path: file, names: entry.symbols });
    for (const [offset, end] of windows ?? [[1, HEAD_LINES]]) {
      reads.push({ file_path: file, offset, limit: Math.min(end - offset + 1, READ_LINE_CAP), end });
    }
  }
  return { reads, skipped, toPlace };
}

const textOf = content => (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');

function routeOf(agent) {
  const selection = agent.model.current();
  return selection ? { provider: selection.provider, model: selection.model } : null;
}

function ambiguityText(candidates) {
  const lines = candidates.map(({ load_token: token, created_at: createdAt, next_task_preview: preview }) => (
    `- ${token} (${formatAge(createdAt)})${preview ? ` — ${preview}` : ''}`));
  return ['Several handoffs are pending for this project; run /sw-load <token> with one of them:', ...lines].join('\n');
}

// The reason a delivery's answer is not a loaded handoff, or null when it is one.
function refusalOf(payload, token) {
  if (payload.error !== undefined) return `Loading failed: ${payload.error}`;
  if (payload.ambiguous) return ambiguityText(payload.candidates);
  if (!payload.found) return `No handoff found${token ? ` for ${token}; it may have expired` : ' pending for this project'}`;
  return null;
}

const failed = reason => ({ failed: { reason } });

/**
 * Load the handoff `token` names, or the one pending for the project without one, into `session`, the session of `agent`, as the body of a maintenance task.
 * The route is the provider and model of `agent.model.current()`, the selection the next request starts from; with none nothing is delivered. `deliver({ agent, signal, args })` is `createHandoffDelivery`'s, `args` being `{ load_token }` or `{}`. Each planned read runs as a batch of one `read` call through `tools.execute` with `agent`, `signal` and its own call id and no model-step `log`, one after another. A read whose batch rejects or whose result is `isError`, the skip result of an aborted signal included, is skipped with the message and joins no call of the load message; the tail of a range a read did not reach, short of the file's end, is unread; the `additionalContexts` of every batch, an `isError` result's included as in the loop, are collected in plan order from the batch alone. `cwdOf(session)` is the session's working directory.
 * The message is `kit.createUserMessage` over `loadMessageInput`: the delivery as the `load_handoff` call with its payload's JSON, then each read that succeeded, each call's `arguments` the JSON of its logical argument object.
 * Nothing is handed to the agent and no session event is appended here.
 *
 * @returns {Promise<{ loaded: { token: string, reads: number, files: number, skipped: { path: string, reason: string }[],
 *   unread: { path: string, range: [number, number] }[], toPlace: { path: string, names: string[] }[], skills: string[],
 *   empty: boolean, message: object, contexts: object[] } } | { failed: { reason: string } }>}
 */
export async function loadHandoffInto({ agent, session, tools, deliver, kit, signal, token, cwdOf }) {
  const route = routeOf(agent);
  if (route === null) return failed(NO_ROUTE);
  const args = token ? { load_token: token } : {};
  let payload;
  try {
    payload = await deliver({ agent, signal, args });
  } catch (error) {
    return failed(`Loading failed: ${messageOf(error)}`);
  }
  const refusal = refusalOf(payload, token);
  if (refusal !== null) return failed(refusal);

  const plan = planReads(payload, { cwd: cwdOf(session) });
  const idPrefix = `sw-load-${randomUUID().slice(0, 8)}`;
  const calls = [{ id: `${idPrefix}-0`, name: 'load_handoff', arguments: JSON.stringify(args), text: JSON.stringify(payload) }];
  const skipped = [...plan.skipped];
  const unread = [];
  const contexts = [];
  for (const [index, { file_path, offset, limit, end }] of plan.reads.entries()) {
    const id = `${idPrefix}-${index + 1}`;
    const readArgs = { file_path, offset, limit };
    let batch;
    try {
      batch = await tools.execute({ calls: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify(readArgs) }], signal, agent });
    } catch (error) {
      skipped.push({ path: file_path, reason: messageOf(error) });
      continue;
    }
    // The batch repeats each result's contexts on the result itself; reading both would inject them twice.
    contexts.push(...batch.additionalContexts);
    const { result } = batch.results[0];
    if (result.isError) {
      skipped.push({ path: file_path, reason: result.error.message });
      continue;
    }
    calls.push({ id, name: 'read', arguments: JSON.stringify(readArgs), text: textOf(result.content) });
    const { lines = [], totalLines = 0 } = result.meta ?? {};
    const last = lines.at(-1)?.number ?? offset - 1;
    if (last < end && last < totalLines) unread.push({ path: file_path, range: [last + 1, end] });
  }

  let message;
  try {
    message = kit.createUserMessage(loadMessageInput({ route, calls }));
  } catch (error) {
    return failed(`Loading did not finish: ${messageOf(error)}`);
  }
  const readCalls = calls.slice(1);
  return {
    loaded: {
      token: payload.load_token,
      reads: readCalls.length,
      files: new Set(readCalls.map(call => JSON.parse(call.arguments).file_path)).size,
      skipped,
      unread,
      toPlace: plan.toPlace,
      skills: payload.skills_to_keep ?? [],
      empty: (payload.paths_to_keep ?? []).length === 0,
      message,
      contexts,
    },
  };
}

// A value as a JSON string, so it reads back whole, with each slash that follows whitespace escaped (`\/` is `/` in JSON): inside such a string only that slash can begin a whitespace-bounded `/name` token.
const quoted = value => JSON.stringify(value).replace(/(?<=\s)\//g, '\\/');

const lineageStepOf = (listing, closing) => `1. Place the summary in its lineage. \`lineage\` in the payload runs oldest to newest. The sessions the budget left out are collapsed into runs marked \`omitted\`, ahead of the newest sessions' headlines, and the budget may keep none. When the next task or what is already in context needs the headlines of an omitted run, \`lineage_headlines\` with that run's numbers as \`k\` (\`S2-S5\` is \`2-5\`) reads them; read a run for that need only, not by default. The payload's turn page holds the newest turns. From the page, ${listing}. When a headline bears on the next task and the page does not reach that member, call \`turn_page\` with that member's label as \`before\`; a session inside an omitted run is \`S{k}\`, \`k\` being its own number.${closing}`;

const presentStep = '3. Present, then hold. Run `git status --short && git log -1 --oneline` once, then write, from the kept paths and that output: the objective, in one line; the working state, each claim the summary makes about the current state set against what the kept paths and the git output show (matches, differs and how, or reaches neither and so unverified); the next task and its entry points, with where the names to place below sit and the turns step 1 named; blockers and risks; the kept paths now in context and the load token. Then stop and wait for the user to confirm or correct it. The next task\'s first act begins after the reply.';

const resumeStep = '3. Resume. Run `git status --short && git log -1 --oneline` once and set each claim the summary makes about the current state against the kept paths and that output; a claim they do not reach counts as a deviation when your next step depends on it. Before your first step on the task, say in one sentence which task you are resuming and your next step, adding a deviation or risk only when it changes that step. Then carry the task on in this turn from the summary and the history, within what it was already authorized to do. A question, approval or permission the task left open still stands: ask it and wait. When a deviation from the summary leaves the task\'s direction or authorization, or a safe next step, undecided, ask one specific question about it and wait; otherwise carry on.';

/**
 * The follow-up that wakes the model on a loaded handoff: what the harness already ran and where its results are, the remaining steps of the load, and the `skipped`, `unread` and `toPlace` entries.
 * By default the steps end in a report the user confirms; with `resume`, the `/sw-continue` variant, they end in a one-sentence note and the task carried on.
 * Every value goes through `quoted`, so none forms the whitespace-bounded `/name` token by which DSH's scan of a user message (`SKILL_GESTURE` in the DSH checkout's `packages/skill/tool-skill/src/index.ts`) injects a skill without a `skill` call.
 */
export function loadedText({ token, skipped, unread, toPlace, skills, empty }, { resume = false } = {}) {
  const summaryOnly = resume ? 'when the task calls for it' : 'after the user agrees';
  const skillStep = skills.length > 0
    ? `2. Load the kept skills: invoke ${skills.map(quoted).join(', ')} through the skill tool. A skill named only in the summary is invoked ${summaryOnly}.`
    : `2. The handoff keeps no skills; a skill named only in the summary is invoked through the skill tool ${summaryOnly}.`;
  const lineageStep = resume
    ? lineageStepOf('read the turns whose `A:` note bears on the next task', '')
    : lineageStepOf('list the turns whose `A:` note bears on the next task, by their `S{k}:{T}` address', ' That list is what step 3 reports.');
  const sections = [
    `Handoff ${quoted(token)} is loaded. The harness has run its delivery, recorded as the \`load_handoff\` call, and the \`read\` calls for the kept ranges, except those listed as skipped below. Their results are in the message the harness placed before this one, in that order and as returned: the delivery's payload, then each read result, which opens with its \`<path>\` line. Do not repeat any of those calls; where a result says part of it was cut or failed, complete it as that result says.`,
    ['Then:', lineageStep, skillStep, resume ? resumeStep : presentStep].join('\n'),
  ];
  if (skipped.length > 0) {
    sections.push(['Skipped, not read:', ...skipped.map(({ path, reason }) => `- ${quoted(path)}: ${quoted(reason)}`)].join('\n'));
  }
  if (unread.length > 0) {
    sections.push(['Not reached by its read; read the rest of the range:', ...unread.map(({ path, range: [from, to] }) => `- ${quoted(path)} lines ${from}-${to}`)].join('\n'));
  }
  if (toPlace.length > 0) {
    sections.push(['Names to place with a `grep -n` in the file:', ...toPlace.map(({ path, names }) => `- ${quoted(path)}: ${names.map(quoted).join(', ')}`)].join('\n'));
  }
  if (empty) sections.push(resume ? 'The handoff keeps no paths: resume from the summary and the history.' : 'The handoff keeps no paths: ask the user what they are working on.');
  return sections.join('\n\n');
}

/**
 * Hand a loaded handoff to `agent`: `agent.inject` takes the message, then the additional contexts the reads returned, in plan order, and `agent.followup` queues the follow-up user message of `loadedText` (with `resume` its resuming variant), which wakes the agent. A throw propagates and retracts nothing injected before it.
 */
export function handOver({ agent, loaded, resume }) {
  // The message and the contexts are injected and the follow-up queued back to back after the maintenance task has settled, because `cancel()` clears the inbox; and the plugin appends no session event itself, because a lifecycle-valid assistant and tool exchange cannot be written while the agent is idle.
  agent.inject(loaded.message);
  for (const context of loaded.contexts) agent.inject(context);
  agent.followup({
    id: randomUUID(), role: 'user', content: [{ type: 'text', text: loadedText(loaded, { resume }) }], source: { kind: 'user' },
  });
}

const COMMAND_NAME = 'sw-load';
const COMMAND_DESCRIPTION = 'Load a handoff into the session';
const COMMAND_INPUT = { hint: 'handoff token (optional)' };

const USAGE = 'Usage: /sw-load [token]';
const NOT_IDLE = '/sw-load runs only while the agent is idle.';

const failure = text => ({ kind: 'error', text });
const success = text => ({ kind: 'success', text });

/**
 * The `/sw-load` command definition: a blank input loads the one handoff pending for the session's project, a single whitespace-free word is the token, and anything else answers the usage.
 * `loadHandoffInto` runs as one `agent.runMaintenance` task under the invocation's signal; only `runMaintenance` refusing the agent throws synchronously, and answers the idle text. A failed load answers its reason; a loaded handoff is handed over (`handOver`) once the task has settled, and the command answers the counts. The command appends no session event and flushes nothing: the loop flushes before its next step.
 * A rejection of the task and a throw of the hand-over reach the caller unchanged.
 * `deliver`, `tools`, `kit` and `cwdOf` are `loadHandoffInto`'s.
 *
 * @returns {{ name: string, description: string, input: { hint: string }, handler: Function }} the definition the command registry takes
 */
export function createLoadCommand({ deliver, tools, kit, cwdOf }) {
  async function handler({ agent, rawInput, signal }) {
    const token = rawInput.trim();
    if (/\s/.test(token)) return failure(USAGE);
    let maintenance;
    try {
      maintenance = agent.runMaintenance(() => loadHandoffInto({
        agent, session: agent.session, tools, deliver, kit, signal, token, cwdOf,
      }));
    } catch {
      return failure(NOT_IDLE);
    }
    const outcome = await maintenance;
    if (outcome.failed) return failure(outcome.failed.reason);
    const { loaded } = outcome;
    handOver({ agent, loaded });
    return success(`Loaded handoff ${loaded.token}: ${loaded.reads} reads over ${loaded.files} files, ${loaded.skipped.length} skipped.`);
  }
  return { name: COMMAND_NAME, description: COMMAND_DESCRIPTION, input: COMMAND_INPUT, handler };
}
