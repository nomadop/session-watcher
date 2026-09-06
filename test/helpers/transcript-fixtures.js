// test/helpers/transcript-fixtures.js — Reusable raw transcript fixture builders for canonical-fold tests.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  model = 'claude-opus-4-8', extra = {},
}) {
  return {
    type: 'assistant', uuid, parentUuid, isSidechain: false, timestamp,
    message: { id: messageId, role: 'assistant', model, content: blocks },
    ...extra,
  };
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

export function assistantToolUse({ uuid, parentUuid, messageId, toolUseId, name, input, timestamp, text = null }) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  blocks.push({ type: 'tool_use', id: toolUseId, name, input });
  return assistantObservation({ uuid, parentUuid, messageId, blocks, timestamp });
}

export function compactSummary({ uuid, timestamp, text = 'summary' }) {
  return {
    type: 'user', uuid, parentUuid: null, isSidechain: false, timestamp,
    isCompactSummary: true, message: { role: 'user', content: text },
  };
}

export function writeTranscript(dir, entries) {
  const path = join(dir, `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const content = entries.map(e => JSON.stringify(e) + '\n').join('');
  writeFileSync(path, content);
  return path;
}
