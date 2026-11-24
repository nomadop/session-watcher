// dsh/src/load.js — the load of a handoff into a session: the delivery, the reads its keep list plans, the payload message and the read message that hand them to the model, the hand-over that queues them with the follow-up, and the `/sw-load` command around them.
// The kept text is shown from the Working Tree as compact evidence, a file's path once over its ranges (`renderFileEvidence`), and the observation is recorded by the load itself (ADR 0030), so no tool is executed. It knows no Cordis: the delivery, the read, the working directory and the DSH message factory (`kit`) reach it by parameter.
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { ATTRIBUTION_LIMITS } from '../../lib/constants.js';
import { formatAge } from '../../lib/handoff-discovery.js';
import { carryChanges, foldCarried } from '../../lib/carried-evidence.js';
import { LOAD_PAYLOAD_CALL, loadMessageInput } from '../../lib/harness/dsh/load-message.js';
import { renderFileEvidence } from '../../lib/working-tree-text.js';
import { loadedLead, quoted } from './handoff-text.js';

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
 * The reads a delivered keep list plans, in entry order: `reads` each `{ file_path, offset, limit }` with `file_path` absolute and `limit` the length of the range; `skipped` each `{ path, reason }` for a path no candidate resolves to a regular file; `toPlace` each `{ path, names }` for an entry read from its head whose `symbols` name what to find in it.
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
      reads.push({ file_path: file, offset, limit: end - offset + 1 });
    }
  }
  return { reads, skipped, toPlace };
}

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
 * The route is the provider and model of `agent.model.current()`, the selection the next request starts from; with none nothing is delivered. `deliver({ agent, signal, args })` is `createHandoffDelivery`'s, `args` being `{ load_token }` or `{}`.
 * The planned windows are grouped by file, files in the order they first appear, and each file is read once, all its ranges together, by `readFile(agent, key, ranges, signal)`, which answers `{ read, displayPath }` as `readObserved` does over the shared Working Tree, recording the agent's observation of a readable read only when the backend maps the path and states its version; `key` is the Working Tree key and `displayPath` the path the block shows. A file the read finds unreadable is skipped with its reason, once however many ranges it was kept over, and a window wholly past the end of the file with the reason `past-end`. A file's windows are rendered as one block under `ATTRIBUTION_LIMITS.sideChars` less the newline that ends it: the windows take that room in order, one that does not fit is cut at its last whole line that does, the rest of it, short of the file's end, is unread, and a window of which no line fits is unread whole and has no row. An empty file read from its first line is rendered.
 * `cwdOf(session)` is the session's working directory.
 * The messages are `kit.createUserMessage` over `loadMessageInput`, both under the route: the payload message holds the delivery as the `load_handoff` call with its payload's JSON, and the read message, built only when a read was rendered, holds one call per rendered file, each call's `arguments` the JSON of its logical argument object `{ file_path, ranges: [{ offset, limit }] }` over the windows it shows and its text the rendering, ended by a newline so that blocks a route joins with nothing between them stay apart. The read message's source also holds `paths`, the evidence of the lines the blocks show: for each rendered file, under its key and the displayed path, the lines the rendering's `shown` counts name, never a requested or unread line, stated as `carryChanges` states them against nothing carried.
 * Nothing is handed to the agent and no session event is appended here.
 *
 * @returns {Promise<{ loaded: { token: string, reads: number, files: number, skipped: { path: string, reason: string }[],
 *   unread: { path: string, range: [number, number] }[], toPlace: { path: string, names: string[] }[], skills: string[],
 *   empty: boolean, messages: object[] } } | { failed: { reason: string } }>}
 */
export async function loadHandoffInto({ agent, session, deliver, kit, signal, token, cwdOf, readFile }) {
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
  const calls = [{ id: `${idPrefix}-0`, name: LOAD_PAYLOAD_CALL, arguments: JSON.stringify(args), text: JSON.stringify(payload) }];
  const skipped = [...plan.skipped];
  const unread = [];
  let reads = 0;
  const windowsByFile = new Map();
  // Each rendered file's lines as shown, by key: what its block holds, under the rendering's own `shown` counts.
  const shownByFile = new Map();
  for (const { file_path, offset, limit } of plan.reads) {
    windowsByFile.set(file_path, [...(windowsByFile.get(file_path) ?? []), { offset, limit }]);
  }
  for (const [file_path, ranges] of windowsByFile) {
    const { read, displayPath } = await readFile(agent, file_path, ranges, signal);
    if (read.status === 'unreadable') {
      skipped.push({ path: file_path, reason: read.reason });
      continue;
    }
    // The read answers a window for each range that holds a line, in the order asked.
    const asked = [];
    const runs = [];
    let at = 0;
    for (const range of ranges) {
      if (read.windows[at]?.offset !== range.offset) {
        skipped.push({ path: file_path, reason: 'past-end' });
        continue;
      }
      asked.push(range);
      runs.push(read.windows[at]);
      at += 1;
    }
    if (runs.length === 0) continue;
    // One character of the cap is the newline that ends the block.
    const rendered = renderFileEvidence(displayPath, { totalLines: read.totalLines, runs }, { maxChars: ATTRIBUTION_LIMITS.sideChars - 1 });
    const shown = rendered === null ? runs.map(() => 0) : rendered.shown;
    const reached = [];
    runs.forEach((run, index) => {
      const { offset, limit } = asked[index];
      if (shown[index] < run.lines.length) unread.push({ path: file_path, range: [offset + shown[index], offset + limit - 1] });
      if (rendered !== null && (shown[index] > 0 || run.lines.length === 0)) reached.push(asked[index]);
    });
    if (rendered === null) continue;
    shownByFile.set(file_path, {
      displayPath,
      read: { status: 'readable', totalLines: read.totalLines, windows: runs.map((run, index) => ({ offset: run.offset, lines: run.lines.slice(0, shown[index]) })) },
    });
    reads += reached.length;
    calls.push({ id: `${idPrefix}-${calls.length}`, name: 'read', arguments: JSON.stringify({ file_path, ranges: reached }), text: `${rendered.text}\n` });
  }

  const [deliveryCall, ...readCalls] = calls;
  let messages;
  try {
    messages = [kit.createUserMessage(loadMessageInput({ route, calls: [deliveryCall] }))];
    if (readCalls.length > 0) {
      // The shown lines are all new against nothing carried: the canonical evidence the seal's baseline reads back.
      const { paths } = carryChanges(foldCarried([]), { paths: shownByFile, skills: new Map() });
      messages.push(kit.createUserMessage(loadMessageInput({ route, calls: readCalls, paths })));
    }
  } catch (error) {
    return failed(`Loading did not finish: ${messageOf(error)}`);
  }
  return {
    loaded: {
      token: payload.load_token,
      reads,
      files: readCalls.length,
      skipped,
      unread,
      toPlace: plan.toPlace,
      skills: payload.skills_to_keep ?? [],
      empty: (payload.paths_to_keep ?? []).length === 0,
      messages,
    },
  };
}

const TURN_PAGE_CLAUSE = 'When a step needs a detail they leave out, `turn_page` reads older turns (an `S{k}:{T}` cursor or an `S{k}` label as `before`) and `lineage_headlines` the headlines of an omitted run (its numbers as `k`, `S2-S5` being `2-5`).';

// `invoke` is the sentence that has the kept skills invoked, or the empty text where there are none.
const presentBody = invoke => `Treat the summary, the kept files and the newest turns in the payload as the established current state of the task.${invoke} Then present, and hold: write the objective, in one line; the working state, as the summary states it; the next task and its entry points, with where the names to place below sit; blockers and risks; the kept paths now in context and the load token. Then stop and wait for the user to confirm or correct it. The next task's first act begins after the reply and builds on that state without checking or restating it. ${TURN_PAGE_CLAUSE}`;

const resumeBody = invoke => `Treat the summary, the kept files and the newest turns in the payload as the established current state of the task, and build on them without checking or restating them.${invoke} Then continue the task directly from its next step, within what it was already authorized to do; a question, approval or permission it left open is still open: ask it and wait. ${TURN_PAGE_CLAUSE}`;

/**
 * The follow-up that wakes the model on a loaded handoff: what the message before it holds, or the two before it when `reads` is positive, then one paragraph that treats the payload as the task's established state, and the `skipped`, `unread` and `toPlace` entries.
 * The paragraph names the kept `skills` to invoke first. By default it then has the model present the state and wait for the user to confirm it; with `resume`, the `/sw-continue` variant, it has the model continue the task directly from its next step.
 * Every value goes through `quoted`, so none forms the whitespace-bounded `/name` token by which DSH's scan of a user message (`SKILL_GESTURE` in the DSH checkout's `packages/skill/tool-skill/src/index.ts`) injects a skill without a `skill` call.
 */
export function loadedText({ token, skipped, unread, toPlace, skills, empty, reads }, { resume = false } = {}) {
  const placed = reads > 0
    ? `${loadedLead(token)} The two messages before this one are the handoff's \`load_handoff\` call with its payload, then the \`read\` calls of the kept files, one per file, each result the file's current text, except those listed as skipped below; a range listed below as not reached is shown in part or not at all. Do not repeat any of those calls; where a result says part of a range was cut, read the rest as that result says.`
    : `${loadedLead(token)} The message before this one is the handoff's \`load_handoff\` call with its payload. Do not repeat that call.`;
  const invoke = skills.length > 0 ? ` First invoke ${skills.map(quoted).join(', ')} through the skill tool.` : '';
  const sections = [placed, (resume ? resumeBody : presentBody)(invoke)];
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
 * Hand a loaded handoff to `agent`: `agent.inject` takes each of its messages in order, the payload message and then the read message when there is one, and `agent.followup` queues the follow-up user message of `loadedText` (with `resume` its resuming variant), which wakes the agent. A throw propagates and retracts nothing injected before it.
 */
export function handOver({ agent, loaded, resume }) {
  // The messages are injected and the follow-up queued back to back after the maintenance task has settled, because `cancel()` clears the inbox; and the plugin appends no session event itself, because a lifecycle-valid assistant and tool exchange cannot be written while the agent is idle.
  for (const message of loaded.messages) agent.inject(message);
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
 * `deliver`, `readFile`, `kit` and `cwdOf` are `loadHandoffInto`'s.
 *
 * @returns {{ name: string, description: string, input: { hint: string }, handler: Function }} the definition the command registry takes
 */
export function createLoadCommand({ deliver, readFile, kit, cwdOf }) {
  async function handler({ agent, rawInput, signal }) {
    const token = rawInput.trim();
    if (/\s/.test(token)) return failure(USAGE);
    let maintenance;
    try {
      maintenance = agent.runMaintenance(() => loadHandoffInto({
        agent, session: agent.session, readFile, deliver, kit, signal, token, cwdOf,
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
