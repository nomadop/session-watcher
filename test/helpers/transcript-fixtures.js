// test/helpers/transcript-fixtures.js — Reusable raw transcript fixture builders for canonical-fold tests.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeDialogueSource } from '../../lib/harness/claude-code/dialogue-source.js';

export function ts(second) {
  return `2026-07-01T00:00:${String(second).padStart(2, '0')}Z`;
}

export function userMessage({ uuid, parentUuid = null, text, timestamp, extra = {} }) {
  return {
    type: 'user', uuid, parentUuid, isSidechain: false, timestamp,
    message: { role: 'user', content: text },
    ...extra,
  };
}

export function assistantObservation({
  uuid, parentUuid = null, messageId, blocks, timestamp,
  model = 'claude-opus-4-8', usage = null, extra = {},
}) {
  const message = { id: messageId, role: 'assistant', model, content: blocks };
  // A row without `usage` is a real shape — a snapshot of a logical message whose token counts arrive on a
  // later row — and it is the shape that separates a tool use from the step it belongs to.
  if (usage) message.usage = usage;
  return {
    type: 'assistant', uuid, parentUuid, isSidechain: false, timestamp,
    message,
    ...extra,
  };
}

// Native token counts under the wire names, including the flat `cache_creation_input_tokens` form.
export function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

// The harness-injected Skill content row a successful Skill result promises: a meta row naming the tool use
// it belongs to, whose text blocks are the payload.
export function skillPayloadRow({ uuid, parentUuid, sourceToolUseID, text, timestamp }) {
  return {
    type: 'user', uuid, parentUuid, isSidechain: false, isMeta: true, sourceToolUseID, timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

// A deliberate topology root: `chain` leaves its null parent alone. A null-parent root with a call behind it
// is a compact epoch, so an entry that means to open one says so in the fixture's own vocabulary rather than
// by being spread across two `chain` calls. The marker is a symbol, so it never reaches the written row.
const TOPOLOGY_ROOT = Symbol('topologyRoot');

export function topologyRoot(entry) {
  entry[TOPOLOGY_ROOT] = true;
  return entry;
}

// Links a run of entries into one parent chain, which is the shape a real transcript has: every row of one
// logical message, and every tool result between them, names the row physically before it. A null parent is
// a topology root, and a root with a call behind it is a compact epoch — so a run assembled from the
// builders' own defaults is all roots and opens an epoch on every row after the first call. Each entry after
// the first inherits its predecessor's uuid unless it already names a parent or declares itself a root.
export function chain(entries) {
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][TOPOLOGY_ROOT]) continue;
    if (entries[i].parentUuid == null) entries[i].parentUuid = entries[i - 1].uuid;
  }
  return entries;
}

// Omitting isError leaves is_error off the block entirely, the way a real successful tool result
// arrives — the wire distinguishes that from a present is_error:false. Same for timestamp and
// toolUseResult: a fixture that omits them produces a row that genuinely lacks the field.
export function toolResult({ uuid, parentUuid, toolUseId, content, isError, timestamp, toolUseResult }) {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content };
  if (isError !== undefined) block.is_error = isError;
  const entry = {
    type: 'user', uuid, parentUuid, isSidechain: false,
    message: { role: 'user', content: [block] },
  };
  if (timestamp !== undefined) entry.timestamp = timestamp;
  if (toolUseResult !== undefined) entry.toolUseResult = toolUseResult;
  return entry;
}

export function assistantToolUse({
  uuid, parentUuid, messageId, toolUseId, name, input, timestamp, text = null, model, usage,
}) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  blocks.push({ type: 'tool_use', id: toolUseId, name, input });
  return assistantObservation({ uuid, parentUuid, messageId, blocks, timestamp, model, usage });
}

export function compactSummary({ uuid, timestamp, text = 'summary' }) {
  return topologyRoot({
    type: 'user', uuid, parentUuid: null, isSidechain: false, timestamp,
    isCompactSummary: true, message: { role: 'user', content: text },
  });
}

// One sealed line of JSONL per entry — the bytes a Source holds.
export function transcriptBytes(entries) {
  return Buffer.from(entries.map(e => JSON.stringify(e) + '\n').join(''));
}

// One complete canonical observation snapshot of a set of fixture entries, read through the Claude Code
// DialogueSource so a shared Dialogue test consumes exactly what production hands it. Nothing is written
// to disk: the Adapter's read capability is supplied directly.
export function observationsOf(entries) {
  const source = createClaudeCodeDialogueSource({ readFile: () => transcriptBytes(entries) });
  return source.read('fixture-locator').observations;
}

export function writeTranscript(dir, entries) {
  const path = join(dir, `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const content = entries.map(e => JSON.stringify(e) + '\n').join('');
  writeFileSync(path, content);
  return path;
}
