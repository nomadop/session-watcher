// test/helpers/attribution-fixtures.js — what a test assembles to run tool evidence end to end over a working
// tree it authors: the in-memory tree (and `writeFilesUnder`, the same files on disk, for a composition that reads
// the real tree), the matcher over it, the interpreter, the Measurement Projection that carries the interpreter, and
// the session log a composed watcher is fed. The DSH half comes first and the Claude Code half after it; the tree,
// the limits, the models and the Engine are shared. Every path and line a test puts in a tree or a log is authored;
// nothing here reads a session log, a home directory or a real working tree.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createMemoryWorkingTree } from '../../lib/working-tree.js';
import { createResourceAttribution } from '../../lib/resource-attribution.js';
import { createToolEvidenceInterpreter } from '../../lib/tool-evidence.js';
import { dshToolEvidenceProfile } from '../../lib/harness/dsh/tool-evidence-profile.js';
import { claudeCodeToolEvidenceProfile } from '../../lib/harness/claude-code/tool-evidence-profile.js';
import { createDshMeasurementProjection } from '../../lib/harness/dsh/measurement-projection.js';
import { createClaudeCodeMeasurementProjection } from '../../lib/harness/claude-code/measurement-projection.js';
import { createMeasurementEngine } from '../../lib/measurement/engine.js';
import { reduceDshEvent } from '../../lib/harness/dsh/transcript-observation.js';
import {
  assistantMessage, sessionLog, stepEnd, stepStart, toolResult, turnEnd, turnStart, userMessage,
} from './dsh-events.js';
import * as transcript from './transcript-fixtures.js';

/** The session directory a relative path resolves against. */
export const CWD = '/repo';

export const MODEL = 'model-a';
export const OTHER_MODEL = 'model-b';
// Divisors that are powers of two, so every token count a test computes is exact and no sum depends on its order.
export const CTP_BY_MODEL = new Map([
  [MODEL, { ascii: 4, cjk: 2 }],
  [OTHER_MODEL, { ascii: 2, cjk: 0.5 }],
]);
const FALLBACK_CTP = { ascii: 8, cjk: 8 };

/** The model policy resolver of a Projection context: a distinct CTP per model. */
export const resolveModelPolicy = modelId => ({ ctp: CTP_BY_MODEL.get(modelId) ?? FALLBACK_CTP });

/** The text of a file whose lines are `lines`: each ends in a line terminator, the last one included. */
export const linesText = lines => `${lines.join('\n')}\n`;

/** The files of a tree from `{ <path relative to root>: lines }`: `{ <root>/<path>: text }`. */
export const filesUnder = (root, linesByPath) => Object.fromEntries(
  Object.entries(linesByPath).map(([relative, lines]) => [`${root}/${relative}`, linesText(lines)]),
);

/** The files `filesUnder` describes, written under the directory `root`, with the directories between. */
export function writeFilesUnder(root, linesByPath) {
  for (const [file, text] of Object.entries(filesUnder(root, linesByPath))) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** The limits a test builds the matcher and the interpreter with; the constant `ATTRIBUTION_LIMITS` is never read. */
export const LIMITS = {
  candidates: 8,
  fileBytes: 10_000,
  sideChars: 100_000,
  decodeDepth: 4,
  alignCells: 100_000,
  evidenceFloor: 2,
};

/** The home directory of the Claude Code namespace the memory trees below stand in for. */
export const CC_HOME = '/home/dev';

/**
 * A memory working tree over POSIX paths. With no `homeDir` it is the DSH namespace, where `~` is an ordinary
 * directory name; given one, the Claude Code namespace, where `~` is that directory.
 */
export const treeOf = (files, homeDir = null) => createMemoryWorkingTree({ files, path: path.posix, homeDir });

/**
 * A working tree whose files a test replaces between calls, as an edit on disk would: `set(files)` swaps the whole
 * file set, and what the tree answers afterwards is the new set.
 * @param {Object<string, string>} files absolute path → text
 * @param {string|null} [homeDir] the namespace's home directory, as `treeOf` takes it
 * @returns {{ workingTree: object, set: function }}
 */
export function editableTree(files, homeDir = null) {
  let tree = treeOf(files, homeDir);
  return {
    workingTree: {
      resolve: (...args) => tree.resolve(...args),
      stat: (...args) => tree.stat(...args),
      readText: (...args) => tree.readText(...args),
    },
    set: (next) => { tree = treeOf(next, homeDir); },
  };
}

/**
 * An `editableTree` that counts the calls made on it, by port method, so a test can show that nothing was
 * asked of the tree.
 * @param {Object<string, string>} files absolute path → text
 * @param {string|null} [homeDir] the namespace's home directory, as `treeOf` takes it
 * @returns {{ workingTree: object, set: function, calls: { resolve: number, stat: number, readText: number } }}
 */
export function watchedTree(files, homeDir = null) {
  const inner = editableTree(files, homeDir);
  const calls = { resolve: 0, stat: 0, readText: 0 };
  const counted = method => (...args) => {
    calls[method] += 1;
    return inner.workingTree[method](...args);
  };
  return {
    workingTree: { resolve: counted('resolve'), stat: counted('stat'), readText: counted('readText') },
    calls,
    set: inner.set,
  };
}

/** A working tree that answers nothing: no path resolves, no file exists. */
export const SILENT_TREE = { resolve: () => null, stat: () => null, readText: () => null };

/**
 * A DSH rig over an in-memory working tree.
 * @param {object} [options]
 * @param {Object<string, string>} [options.files] absolute path → text; the tree the matcher reads. Default empty.
 * @param {object} [options.workingTree] the tree itself, in place of one built from `files`.
 * @param {string|null} [options.cwd] the session directory the Projection hands the interpreter. Default `CWD`.
 * @param {function} [options.attribute] stands in for the matcher: `attribute({ base, input, output })` answering
 *   the matcher's shape. Default is the real matcher over `files`.
 * @param {object} [options.profile] replaces the DSH profile.
 * @param {object} [options.limits] replaces `LIMITS`.
 * @returns {{ workingTree: object, attribution: object, interpreter: object, interpreters: object,
 *   projection: object, context: object }} `interpreters` is what a Projection factory takes of them, to spread into
 *   a Projection a test builds itself; `context` is what the Projection hands the interpreter's two functions.
 */
export function dshRig({
  files = {}, workingTree = treeOf(files), cwd = CWD, attribute, profile = dshToolEvidenceProfile, limits = LIMITS,
} = {}) {
  const attribution = attribute ? { attribute } : createResourceAttribution({ workingTree, limits });
  const interpreter = createToolEvidenceInterpreter({ attribution, profile, limits });
  const interpreters = {
    interpretToolUse: interpreter.interpretToolUse,
    completeToolResult: interpreter.completeToolResult,
  };
  const projection = createDshMeasurementProjection({ cwd, resolveModelPolicy, ...interpreters });
  return {
    workingTree, attribution, interpreter, interpreters, projection,
    context: { sessionCwd: cwd, resolveModelPolicy },
  };
}

/**
 * The tool-use and tool-result observations of one DSH call, reduced from DSH session events the way the host
 * log reduces them.
 * @param {object} call
 * @param {string} call.name the tool name
 * @param {object|string} [call.args] the arguments: a value is sent as its JSON, a string as the raw argument text
 * @param {string} [call.text] the result text
 * @param {boolean} [call.isError]
 * @param {string} [call.model] the model of the issuing step. Default `MODEL`.
 * @param {string} [call.callId]
 */
export function dshObservations({ name, args = {}, text = '', isError = false, model = MODEL, callId = 'call_1' }) {
  const issued = reduceDshEvent(assistantMessage({
    model,
    toolCalls: [{ id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }],
  })).observations;
  const answered = reduceDshEvent(toolResult({ callId, text, isError })).observations;
  return { use: issued.find(observation => observation.type === 'tool-use'), result: answered[0] };
}

/** A real Engine with fixed policies: a cache ratio of ten, every resource selected by default. */
export function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: () => ({ cRatio: 10, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

/** A step record carrying `cacheRead` tokens of stock, which the effects ingested after it are measured against. */
export const stepOf = (id, cacheRead) => ({
  type: 'step', id, model: MODEL, timestamp: 1, usage: { input: 0, output: 0, cacheRead, cacheWrite: 0 },
});

/** The Engine's bucket row of one path, or undefined while the path holds no tokens. */
export const rowOf = (engine, path) => engine.getBucketData().paths.find(row => row.path === path);

// ── Scripted DSH logs ────────────────────────────────────────────────────────

// The prompt grows by `STOCK_GROWTH` a step above a first step that writes `STOCK_BASE`, so every step has a
// stock for the effects ingested after it to be measured against.
const STOCK_BASE = 50_000;
const STOCK_GROWTH = 2_000;

function usageOf(step) {
  const usage = step === 1
    ? { inputTokens: 3, outputTokens: 40, cacheWriteTokens: STOCK_BASE }
    : {
      inputTokens: 2, outputTokens: 40, cacheReadTokens: STOCK_BASE + (step - 2) * STOCK_GROWTH,
      cacheWriteTokens: STOCK_GROWTH,
    };
  return { ...usage, totalTokens: Object.values(usage).reduce((sum, count) => sum + count, 0) };
}

/** The tool-use id the DSH reducer gives the call in step `step` of the first turn of a `dshCallLog`. */
export const toolUseIdOf = step => `1:${step}:call_${step}`;

/**
 * DSH's `read` result for lines `from` to `to` of `lines` (all of them by default) as the model sees it: the
 * envelope, each line numbered, and the footer that says whether the window reached the end of the file.
 */
export function readResultText(filePath, lines, { from = 1, to = lines.length } = {}) {
  const shown = lines.slice(from - 1, to).map((text, index) => `${from + index}: ${text}`);
  const footer = to >= lines.length
    ? `(End of file - total ${lines.length} lines)`
    : `(Showing lines ${from}-${to} of ${lines.length}. Use offset=${to + 1} to continue.)`;
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${shown.join('\n')}\n\n${footer}\n</content>`;
}

/**
 * A DSH session log of scripted tool calls: the first turn asks `question`, answers it with one call per step
 * and closes with a text-only step; `asking` adds a second turn, the one that asks for the Turn skeleton, which
 * Turn History leaves out of its capture.
 * @param {object[]} calls `{ name, args, text, isError, error, meta }` per call; `args` as in `dshObservations`.
 * @param {object} [options]
 * @param {string} [options.question]
 * @param {boolean} [options.asking]
 * @returns {{ events: object[], cuts: number[] }} `cuts[k - 1]` is the number of events up to and including the
 *   end of call `k`'s step, so `events.slice(0, cuts[k - 1])` is the Source as it stood after that call.
 */
export function dshCallLog(calls, { question = 'Work on the module.', asking = false } = {}) {
  const events = [turnStart(), userMessage({ text: question })];
  const cuts = [];
  calls.forEach(({ name, args = {}, text = '', isError = false, error, meta }, index) => {
    const step = index + 1;
    const id = `call_${step}`;
    events.push(
      stepStart({ step }),
      assistantMessage({
        step,
        toolCalls: [{ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }],
        usage: usageOf(step),
      }),
      toolResult({ step, callId: id, text, isError, error, meta }),
      stepEnd({ step }),
    );
    cuts.push(events.length);
  });
  const closing = calls.length + 1;
  events.push(
    stepStart({ step: closing }),
    assistantMessage({ step: closing, text: 'That is done.', usage: usageOf(closing) }),
    stepEnd({ step: closing }),
    turnEnd(),
  );
  if (asking) {
    events.push(
      turnStart({ turn: 2 }), userMessage({ text: 'Prepare the handoff.' }), stepStart({ turn: 2 }),
      assistantMessage({ turn: 2, text: 'Preparing it.', usage: usageOf(closing + 1) }),
      stepEnd({ turn: 2 }), turnEnd({ turn: 2 }),
    );
  }
  return { events: sessionLog(events), cuts };
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/**
 * A Claude Code rig over an in-memory working tree in the Claude Code namespace: the DSH rig's pieces with this
 * harness's profile, and a Projection that also takes the profile's two hooks, the skill payload and the task
 * notification.
 * @param {object} [options]
 * @param {Object<string, string>} [options.files] absolute path → text; the tree the matcher reads. Default empty.
 * @param {object} [options.workingTree] the tree itself, in place of one built from `files`.
 * @param {string|null} [options.cwd] the session directory the Projection hands the interpreter. Default `CWD`.
 * @param {function} [options.attribute] stands in for the matcher: `attribute({ base, input, output })` answering
 *   the matcher's shape. Default is the real matcher over `files`.
 * @param {object} [options.profile] replaces the Claude Code profile.
 * @param {object} [options.limits] replaces `LIMITS`.
 * @returns {{ workingTree: object, attribution: object, interpreter: object, interpreters: object,
 *   projection: object, context: object }} `interpreters` is what a Projection factory takes of them, to spread into
 *   a Projection a test builds itself; `context` is what the Projection hands the interpreter's two functions.
 */
export function ccRig({
  files = {}, workingTree = treeOf(files, CC_HOME), cwd = CWD, attribute, profile = claudeCodeToolEvidenceProfile,
  limits = LIMITS,
} = {}) {
  const attribution = attribute ? { attribute } : createResourceAttribution({ workingTree, limits });
  const interpreter = createToolEvidenceInterpreter({ attribution, profile, limits });
  const interpreters = {
    interpretToolUse: interpreter.interpretToolUse,
    completeToolResult: interpreter.completeToolResult,
    interpretSkillPayload: profile.interpretSkillPayload,
    interpretTaskNotification: profile.interpretTaskNotification,
  };
  const projection = createClaudeCodeMeasurementProjection({
    cwd, projectRoot: cwd, resolveModelPolicy, ...interpreters,
  });
  return {
    workingTree, attribution, interpreter, interpreters, projection,
    context: { sessionCwd: cwd, resolveModelPolicy },
  };
}

/**
 * The tool-use, tool-result and skill-payload observations of one Claude Code call, reduced from transcript rows
 * the way the Source reduces them.
 * @param {object} call
 * @param {string} [call.name] the tool name; omitted, the row names none
 * @param {object} [call.input]
 * @param {*} [call.content] the result: a string, or an array of content blocks
 * @param {boolean} [call.isError]
 * @param {string} [call.model] the model of the issuing step. Default `MODEL`.
 * @param {string} [call.toolUseId]
 * @param {string} [call.cwd] the working directory the call's row names; omitted, the row names none
 * @param {string} [call.payload] the text of the harness row a Skill result promises; omitted, there is no such row
 * @returns {{ use: object, result: object, payload: (object|undefined) }}
 */
export function ccObservations({
  name, input = {}, content = '', isError, model = MODEL, toolUseId = 'toolu_1', cwd, payload,
} = {}) {
  const use = transcript.assistantToolUse({
    uuid: 'a-1', parentUuid: 'u-1', messageId: 'm-1', toolUseId, name, input, timestamp: transcript.ts(2), model,
  });
  if (cwd !== undefined) use.cwd = cwd;
  const rows = [
    transcript.userMessage({ uuid: 'u-1', text: 'Work on the module.', timestamp: transcript.ts(1) }),
    use,
    transcript.toolResult({ uuid: 'r-1', parentUuid: 'a-1', toolUseId, content, isError, timestamp: transcript.ts(3) }),
  ];
  if (payload !== undefined) {
    rows.push(transcript.skillPayloadRow({
      uuid: 'p-1', parentUuid: 'r-1', sourceToolUseID: toolUseId, text: payload, timestamp: transcript.ts(4),
    }));
  }
  const observations = transcript.observationsOf(transcript.chain(rows));
  const find = type => observations.find(observation => observation.type === type);
  return { use: find('tool-use'), result: find('tool-result'), payload: find('skill-payload') };
}

/** The tool-use id of the call in step `step` of a `ccCallLog`. */
export const ccToolUseIdOf = step => `toolu_${step}`;

const ccUsageOf = step => (step === 1
  ? transcript.usage({ input: 3, output: 40, cacheWrite: STOCK_BASE })
  : transcript.usage({
    input: 2, output: 40, cacheRead: STOCK_BASE + (step - 2) * STOCK_GROWTH, cacheWrite: STOCK_GROWTH,
  }));

/** Claude Code's `Read` result for `lines` as the model sees it: each line numbered from `from`, a tab after the number. */
export const ccReadResultText = (lines, from = 1) => lines.map((text, index) => `${from + index}\t${text}`).join('\n');

/**
 * A Claude Code transcript of scripted tool calls: the first turn asks `question`, answers it with one call per step
 * and closes with a text-only step; `asking` adds a second turn, the one that asks for the Turn skeleton, which Turn
 * History leaves out of its capture. A step's usage is the DSH log's, so the stock grows the same way.
 * @param {object[]} calls `{ name, input, content, isError, cwd, payload }` per call; `payload` is the text of the
 *   harness row a Skill result promises, written after the result.
 * @param {object} [options]
 * @param {string} [options.question]
 * @param {boolean} [options.asking]
 * @returns {{ entries: object[], cuts: number[] }} `cuts[k - 1]` is the number of rows up to and including the end of
 *   call `k`, so `entries.slice(0, cuts[k - 1])` is the Source as it stood after that call.
 */
export function ccCallLog(calls, { question = 'Work on the module.', asking = false } = {}) {
  let second = 0;
  const stamp = () => transcript.ts(++second);
  const entries = [transcript.userMessage({ uuid: 'u-q', text: question, timestamp: stamp() })];
  const cuts = [];
  let last = 'u-q';
  const push = (entry) => {
    entries.push(entry);
    last = entry.uuid;
  };
  calls.forEach(({ name, input = {}, content = '', isError, cwd, payload }, index) => {
    const step = index + 1;
    const use = transcript.assistantToolUse({
      uuid: `a-${step}`, parentUuid: last, messageId: `m-${step}`, toolUseId: ccToolUseIdOf(step), name, input,
      timestamp: stamp(), usage: ccUsageOf(step),
    });
    if (cwd !== undefined) use.cwd = cwd;
    push(use);
    push(transcript.toolResult({
      uuid: `r-${step}`, parentUuid: last, toolUseId: ccToolUseIdOf(step), content, isError, timestamp: stamp(),
    }));
    if (payload !== undefined) {
      push(transcript.skillPayloadRow({
        uuid: `p-${step}`, parentUuid: last, sourceToolUseID: ccToolUseIdOf(step), text: payload, timestamp: stamp(),
      }));
    }
    cuts.push(entries.length);
  });
  const closing = calls.length + 1;
  push(transcript.assistantObservation({
    uuid: `a-${closing}`, parentUuid: last, messageId: `m-${closing}`, blocks: [{ type: 'text', text: 'That is done.' }],
    timestamp: stamp(), usage: ccUsageOf(closing),
  }));
  if (asking) {
    push(transcript.userMessage({ uuid: 'u-ask', parentUuid: last, text: 'Prepare the handoff.', timestamp: stamp() }));
    push(transcript.assistantObservation({
      uuid: `a-${closing + 1}`, parentUuid: last, messageId: `m-${closing + 1}`,
      blocks: [{ type: 'text', text: 'Preparing it.' }], timestamp: stamp(), usage: ccUsageOf(closing + 1),
    }));
  }
  return { entries, cuts };
}
