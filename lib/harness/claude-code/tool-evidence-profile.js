// lib/harness/claude-code/tool-evidence-profile.js — Claude Code's part of tool evidence: how a call that
// attributes to no file is named, which tool loads a handoff, which tool's resource is not a file, and the two
// rows only this harness has, the skill payload a Skill result promises and a sub-agent's completion notice.
// Matching, pricing and the record are the shared interpreter's (`lib/tool-evidence.js`).

import { SKILL_FRAMING_TOKENS } from '../../constants.js';
import { bashFeature } from '../../bash-feature.js';
import { charsToTokens } from '../../token-estimate.js';

const MCP_PREFIX = 'mcp__';
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/;
const TASK_SUMMARY_RE = /<summary>([^<]*)<\/summary>/;
const AGENT_FINISHED_RE = /^Agent "(.+)" finished$/;
const TASK_ID_PREFIX_CHARS = 8;

// A readable name for an MCP tool: mcp__serena__find_symbol reads as "serena find_symbol". The tool-name
// set is a product of local plugin configuration, so this works from the naming convention alone.
function mcpDisplay(toolName) {
  const segments = toolName.slice(MCP_PREFIX.length).replace(/^plugin_/, '').split('__');
  // A plugin server often repeats its own name ("playwright_playwright"); collapse the repetition.
  const firstSeg = segments[0];
  const halfLen = Math.floor(firstSeg.length / 2);
  for (let len = halfLen + 1; len >= 2; len--) {
    const candidate = firstSeg.slice(0, len);
    if (firstSeg.slice(len) === '_' + candidate) { segments[0] = candidate; break; }
  }
  return segments.join(' ');
}

function residualIdentity(name, input) {
  if (name === 'Bash') {
    const feature = bashFeature(input.command);
    return { groupKey: feature.name, kind: 'bash', detail: feature.detail };
  }
  if (name.startsWith(MCP_PREFIX)) {
    return { groupKey: mcpDisplay(name), kind: 'mcp', detail: '' };
  }
  return { groupKey: name, kind: 'tool', detail: '' };
}

function isLoadHandoffTool(name) {
  return name.endsWith('load_handoff');
}

// A skill is a resource without a file: its key is its own namespace, so no base path applies.
function nonFileResource({ name, input }) {
  return name === 'Skill' && input.skill ? { resourceKey: 'skill:' + input.skill } : null;
}

/**
 * Interpret the harness-injected Skill content row a successful Skill result promised. Empty text is a
 * payload of nothing and supersedes no belief, so it produces no effect.
 *
 * @param {{ resourceKey: string, issuingPolicy: object }} continuation
 * @param {{ text?: string }} observation
 * @returns {{ effects: object[], residuals: [], telemetry: null }}
 */
function interpretSkillPayload(continuation, observation) {
  const text = typeof observation.text === 'string' ? observation.text : '';
  if (!text) return { effects: [], residuals: [], telemetry: null };
  const tokens = charsToTokens(text, continuation.issuingPolicy.ctp);
  return {
    effects: [{
      access: 'read',
      overheadTokens: SKILL_FRAMING_TOKENS,
      // The launch confirmation already carried this call's spend; the payload restates the same content
      // at its real size and buys nothing further.
      spentTokens: 0,
      impacts: [{
        resourceKey: continuation.resourceKey,
        mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens }] },
      }],
    }],
    residuals: [],
    telemetry: null,
  };
}

/**
 * Interpret a Claude Code task-notification row: a sub-agent's completion notice, whose whole context cost is
 * its own text and whose content belongs to no resource.
 *
 * @param {{ text?: string }} observation
 * @returns {{ effects: [], residuals: object[], telemetry: null }}
 */
function interpretTaskNotification(observation) {
  const text = typeof observation.text === 'string' ? observation.text : '';
  const idMatch = text.match(TASK_ID_RE);
  const idPrefix = idMatch ? idMatch[1].slice(0, TASK_ID_PREFIX_CHARS) : '';
  const summaryMatch = text.match(TASK_SUMMARY_RE);
  const detail = summaryMatch ? summaryMatch[1].replace(AGENT_FINISHED_RE, '$1') : idPrefix;
  return {
    effects: [],
    residuals: [{
      groupKey: 'agent:' + idPrefix,
      weight: text.length,
      hadError: false,
      meta: { kind: 'agent', detail },
    }],
    telemetry: null,
  };
}

export const claudeCodeToolEvidenceProfile = {
  residualIdentity, isLoadHandoffTool, nonFileResource, interpretSkillPayload, interpretTaskNotification,
};
