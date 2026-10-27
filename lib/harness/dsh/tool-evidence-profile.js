// lib/harness/dsh/tool-evidence-profile.js — DSH's part of tool evidence: how a call that attributes to no
// file is named, which tool loads a handoff, and which tool's resource is not a file. Matching, pricing and
// the record are the shared interpreter's (`lib/tool-evidence.js`).

import { bashFeature } from '../../bash-feature.js';

// DSH names a connected MCP server's tool `mcp__<server>__<tool>`, so the prefix is the MCP identity and the
// rest keeps the server beside the tool.
const MCP_PREFIX = 'mcp__';
const AGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'send_message']);

function residualIdentity(name, input) {
  if (name === 'bash') {
    const feature = bashFeature(input.command);
    return { groupKey: feature.name, kind: 'bash', detail: feature.detail };
  }
  if (name.startsWith(MCP_PREFIX)) {
    return { groupKey: name.slice(MCP_PREFIX.length), kind: 'mcp', detail: '' };
  }
  return { groupKey: name, kind: AGENT_TOOLS.has(name) ? 'agent' : 'tool', detail: '' };
}

function isLoadHandoffTool(name) {
  return name.endsWith('load_handoff');
}

// A skill is a resource without a file: its key is its own namespace, so no base path applies.
function nonFileResource({ name, input }) {
  return name === 'skill' && input.name ? { resourceKey: 'skill:' + input.name } : null;
}

export const dshToolEvidenceProfile = { residualIdentity, isLoadHandoffTool, nonFileResource };
