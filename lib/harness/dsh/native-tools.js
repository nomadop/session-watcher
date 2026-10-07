// lib/harness/dsh/native-tools.js — DSH native tool interpretation.
// The only place a DSH tool name, its arguments and its result text become Measurement facts:
// resident-content effects for the file and skill tools, residual evidence for every other tool, and path
// telemetry. A result is read from its model-visible text alone: DSH trims a tool's private `meta`
// independently of that text, so the two can disagree about what the model saw.
//
// It resolves paths only through the capabilities its context supplies, so it holds no ambient directory of
// its own.

import { TOOL_OVERHEAD } from '../../constants.js';
import { charsToTokens } from '../../token-estimate.js';
import { bashFeature } from '../../bash-feature.js';
import { effectFor, pathEventsFor } from '../../tool-effects.js';

// ─── Path canonicalization ───────────────────────────────────────────────────

// One physical file reached under several spellings (./a.js, /cwd/a.js) must land on one resource
// key, or the resident total counts it twice. A non-string target propagates its own TypeError, which the
// caller reads as a target-resolution failure.
function canonicalizerFor(context) {
  const ops = context && context.path;
  // With no path capability the keys are discarded after use — classification reads a result's shape, not
  // which files it names — so the raw spelling is its own key.
  if (!ops) return raw => String(raw);
  return (raw, base) => {
    const abs = ops.isAbsolute(raw) ? raw : ops.resolve(base || '/', raw);
    return ops.normalize(abs).split('\\').join('/');
  };
}

function baseDirFor(row, context) {
  if (typeof row.cwd === 'string' && row.cwd.length > 0) return row.cwd;
  if (typeof context.sessionCwd === 'string' && context.sessionCwd.length > 0) return context.sessionCwd;
  return null;
}

// ─── Native adapters ─────────────────────────────────────────────────────────

// `formatReadOutput` shows each line as `N: text` and closes with one footer, which names the end of the
// file only when the window reached it.
const READ_LINE_RE = /^(\d+): /;
const END_OF_FILE_RE = /^\(End of file - total \d+ lines\)$/;
// `formatGrepOutput` parts its header, each file's section and its footer with a blank line, and names each
// file once, above that file's `Line N: text` rows.
const GREP_SECTION_SEPARATOR = '\n\n';
const GREP_ROW_RE = /^Line (\d+): /;

const sumTokens = lines => lines.reduce((sum, [, tokens]) => sum + tokens, 0);

const fileTarget = (input, base, canon) => (input.file_path ? canon(input.file_path, base) : null);

// Keyed by tool name; a tool with no entry is residual evidence. `extractTarget` runs once when the tool use
// arrives and `computeUpdate` only after the result confirms success, priced with the issuing step's CTP. An
// update is an intermediate shape: `effectFor` turns it into the Engine's mutation vocabulary.
const EFFECT_ADAPTERS = new Map([
  ['read', {
    toolType: 'read',
    extractTarget: fileTarget,
    computeUpdate: (_input, text, _base, ctp) => {
      const lines = [];
      let reachedEnd = false;
      for (const line of text.split('\n')) {
        const numbered = READ_LINE_RE.exec(line);
        if (numbered) lines.push([Number(numbered[1]), charsToTokens(line, ctp)]);
        else if (END_OF_FILE_RE.test(line)) reachedEnd = true;
      }
      const isFullRead = reachedEnd && lines.length > 0 && lines[0][0] === 1;
      const spent = sumTokens(lines) + TOOL_OVERHEAD.Read;
      return { type: isFullRead ? 'fullSet' : 'lineUpdate', lines, overhead: TOOL_OVERHEAD.Read, spent };
    },
  }],
  ['write', {
    toolType: 'write',
    extractTarget: fileTarget,
    // Written content is raw and a later read numbers it, so the write prices the read's form and the two
    // observations of one file agree. `buildWindow` counts a final unterminated line but no line after a
    // final newline, so neither does this.
    computeUpdate: (input, _text, _base, ctp) => {
      const rawLines = String(input.content ?? '').split('\n');
      if (rawLines.at(-1) === '') rawLines.pop();
      const lines = rawLines.map((line, index) => [index + 1, charsToTokens(`${index + 1}: ${line}`, ctp)]);
      return { type: 'write', lines, overhead: TOOL_OVERHEAD.Write, spent: sumTokens(lines) + TOOL_OVERHEAD.Write };
    },
  }],
  ['edit', {
    toolType: 'edit',
    extractTarget: fileTarget,
    // An edit adjusts the total rather than replacing content: it observes no whole file. It charges no
    // framing overhead because the corrective read that follows most edits charges its own. Each line it
    // adds or removes carries a line-number prefix in the read's form.
    computeUpdate: (input, _text, _base, ctp) => {
      const oldString = input.old_string ?? '';
      const newString = input.new_string ?? '';
      const oldTokens = charsToTokens(oldString, ctp);
      const newTokens = charsToTokens(newString, ctp);
      const lineDelta = (newString.match(/\n/g) || []).length - (oldString.match(/\n/g) || []).length;
      const value = newTokens - oldTokens + lineDelta * (4 / ctp.ascii);
      return { type: 'editDelta', value, spent: oldTokens + newTokens + TOOL_OVERHEAD.Edit };
    },
  }],
  ['grep', {
    toolType: 'grep',
    extractTarget: () => null, // the files are named by the result, not by the input
    computeUpdate: (_input, text, base, ctp, canon) => {
      // Every key is a path the result named, and a path may be any legal string, so the dictionary inherits
      // no member such a key could name.
      const files = Object.create(null);
      for (const section of text.split(GREP_SECTION_SEPARATOR)) {
        const [path, ...rows] = section.split('\n');
        // A section opening on a row lost its path to a spill cut, so its rows name no file the model saw.
        if (GREP_ROW_RE.test(path)) continue;
        const lines = [];
        for (const row of rows) {
          const numbered = GREP_ROW_RE.exec(row);
          if (!numbered) continue;
          // A row is priced in the read's `N: text` form, so a grep and a read of one line agree.
          const rendered = `${numbered[1]}: ${row.slice(numbered[0].length)}`;
          lines.push([Number(numbered[1]), charsToTokens(rendered, ctp)]);
        }
        // The header, the recovery footer and a spill notice are sections without rows.
        if (lines.length === 0) continue;
        files[canon(path, base)] = lines;
      }
      const spent = Object.values(files).reduce((sum, lines) => sum + sumTokens(lines), TOOL_OVERHEAD.Grep);
      return { type: 'grepMultiFile', files, overhead: TOOL_OVERHEAD.Grep, spent };
    },
  }],
  ['skill', {
    toolType: 'skill',
    // A skill is a resource without a file: its key is its own namespace, so no base path applies.
    extractTarget: input => (input.name ? 'skill:' + input.name : null),
    computeUpdate: (_input, text, _base, ctp) => {
      const tokens = charsToTokens(text, ctp);
      return { type: 'fullSet', lines: [[1, tokens]], overhead: TOOL_OVERHEAD.Read, spent: tokens + TOOL_OVERHEAD.Read };
    },
  }],
]);

// Would this update actually change what is known about a resource? A multi-file result needs at least one
// file, a fragment result needs both a target and observed lines, a write or an adjustment only a target.
function isEffectiveUpdate(update, target) {
  if (update.type === 'grepMultiFile') return Object.keys(update.files).length > 0;
  if (update.type === 'fullSet' || update.type === 'lineUpdate') return target != null && update.lines.length > 0;
  return target != null;
}

// ─── Effects, residuals, and path telemetry ──────────────────────────────────

// DSH names a connected MCP server's tool `mcp__<server>__<tool>`, so the prefix is the MCP identity and the
// rest keeps the server beside the tool.
const MCP_PREFIX = 'mcp__';
const AGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'send_message']);

function residualIdentityFor(name, input) {
  // The serialized length is a weight component; the raw input itself is never stored.
  const inputLength = JSON.stringify(input).length;
  if (name === 'bash') {
    const feature = bashFeature(input.command);
    return { groupKey: feature.name, kind: 'bash', detail: feature.detail, inputLength };
  }
  if (name.startsWith(MCP_PREFIX)) {
    return { groupKey: name.slice(MCP_PREFIX.length), kind: 'mcp', detail: '', inputLength };
  }
  return { groupKey: name, kind: AGENT_TOOLS.has(name) ? 'agent' : 'tool', detail: '', inputLength };
}

function isLoadHandoffTool(name) {
  return name.endsWith('load_handoff');
}

function resolvedLoadToken(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.load_token === 'string' ? parsed.load_token : null;
  } catch {
    return null;   // a partial or non-JSON result simply leaves the token unresolved
  }
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Interpret one DSH `tool-use` observation. Selects the tool's adapter or its residual identity and resolves
 * the target and the issuing step's policy once, here, into the correlation the Projection hands back with
 * the result — so no later observation reselects an adapter, a base path or a policy.
 *
 * @returns {{ pending: object|null, effects: [], residuals: [], telemetry: object }}
 */
export function interpretDshToolUse(observation, context) {
  const { toolUseId, name } = observation;
  const issuingStepId = observation.messageId ?? null;
  const issuingPolicy = context.resolveModelPolicy(observation.model ?? null);
  const input = observation.input ?? {};
  const explicitToken = isLoadHandoffTool(name) && typeof input.load_token === 'string' ? input.load_token : null;
  // An auto-matched load carries no token in its input; the resolved one comes back in its result.
  const awaitLoadToken = isLoadHandoffTool(name) && explicitToken === null;
  const telemetry = { toolUseId, issuingStepId, loadToken: explicitToken, pathEvents: [] };
  const call = { toolUseId, issuingStepId, issuingPolicy, awaitLoadToken };

  const adapter = EFFECT_ADAPTERS.get(name);
  let pending = null;
  if (adapter === undefined) {
    pending = { kind: 'residual', ...call, residual: residualIdentityFor(name, input) };
  } else {
    const base = baseDirFor(observation, context);
    try {
      const target = adapter.extractTarget(input, base, canonicalizerFor(context));
      pending = { kind: 'effect', ...call, adapter, input, base, target, rawPath: input.file_path || target };
    } catch {
      // An unresolvable target leaves the call nothing to complete.
    }
  }
  return { pending, effects: [], residuals: [], telemetry };
}

/**
 * Complete a pending DSH tool use with its `tool-result` observation. A DSH `skill` result carries the skill
 * body itself, so no completion arms a payload continuation.
 *
 * @param {object} pending - the correlation `interpretDshToolUse` produced
 * @returns {{ effects: object[], residuals: object[], telemetry: object, skillContinuation: null }}
 */
export function completeDshToolResult(pending, observation, context) {
  const text = observation.content;
  const telemetry = {
    toolUseId: pending.toolUseId,
    issuingStepId: pending.issuingStepId,
    loadToken: pending.awaitLoadToken ? resolvedLoadToken(text) : null,
    pathEvents: [],
  };
  const hadError = observation.isError === true;
  if (pending.kind === 'residual') {
    // A failed call still consumed context, so it stays a selectable leaf rather than merging silently into
    // the unattributed remainder.
    const { groupKey, kind, detail, inputLength } = pending.residual;
    return {
      effects: [],
      residuals: [{ groupKey, weight: inputLength + text.length, hadError, meta: { kind, detail } }],
      telemetry,
      skillContinuation: null,
    };
  }
  const nothing = { effects: [], residuals: [], telemetry, skillContinuation: null };
  if (hadError) return nothing;
  const { adapter, input, base, target, rawPath, issuingPolicy } = pending;
  let update;
  try {
    update = adapter.computeUpdate(input, text, base, issuingPolicy.ctp, canonicalizerFor(context));
  } catch {
    return nothing;
  }
  if (!isEffectiveUpdate(update, target)) return nothing;
  telemetry.pathEvents = pathEventsFor(update, target, rawPath, adapter.toolType);
  return { effects: [effectFor(update, target)], residuals: [], telemetry, skillContinuation: null };
}

/**
 * Resolve one paired tool line's target with the canonicalization Measurement uses: against the row's `cwd`,
 * else the session directory. DSH reads `~` as a directory name, and the key resolves it the same way. A tool
 * with no adapter, no locatable target, or an input its adapter cannot read answers null: a target-resolution
 * failure is a nullable field here, not an exception.
 *
 * @param {{ name: string, input: *, cwd: string|null }} pair
 * @param {object} context - the path capability and the session directory
 * @returns {string|null}
 */
export function resolveDshToolTarget(pair, context) {
  const adapter = EFFECT_ADAPTERS.get(pair.name);
  if (adapter === undefined) return null;
  try {
    return adapter.extractTarget(pair.input ?? {}, baseDirFor(pair, context), canonicalizerFor(context));
  } catch {
    return null;
  }
}

/**
 * Which bucket does one paired tool line fall in? Consumes the target Dialogue already resolved, so no base
 * path is selected here and the returned kind is all this seam reports.
 *
 * @param {{ name: string, input: *, result: ?string, isError: ?boolean, resourceKey: ?string }} pair
 * @param {{ ascii: number, cjk: number }} ctp
 * @returns {'path'|'skill'|'residual'}
 */
export function classifyDshToolPair(pair, ctp) {
  const adapter = EFFECT_ADAPTERS.get(pair.name);
  if (adapter === undefined || pair.result == null || pair.isError === true) return 'residual';
  let update;
  try {
    update = adapter.computeUpdate(pair.input ?? {}, pair.result, null, ctp, canonicalizerFor(null));
  } catch {
    return 'residual';
  }
  if (!isEffectiveUpdate(update, pair.resourceKey)) return 'residual';
  return pair.name === 'skill' ? 'skill' : 'path';
}
