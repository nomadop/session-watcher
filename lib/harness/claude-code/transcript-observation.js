// lib/harness/claude-code/transcript-observation.js — Claude Code Transcript Observation.
// The only implementation of native row decoding, content-block atomization, topology, canonical-path
// selection, and source identity. Byte offsets stay Source cursor state and never reach an observation;
// downstream Measurement and Dialogue consume normalized observation batches only.

const NATIVE_MESSAGE_NAMESPACE = 'cc:message:';
const ROW_MESSAGE_NAMESPACE = 'cc:row:';
const KNOWN_USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const TASK_NOTIFICATION_TAG = '<task-notification>';
const LF = 0x0a;
const CR = 0x0d;

// Transcripts carry ISO-8601 timestamps while every consumer compares and stores integers, so the
// epoch conversion happens once here. Unparseable input yields null, never NaN.
function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// --- Byte-safe row reader ---

// Locates LF in the Buffer and decodes only each complete row's byte slice, so a huge row is never
// string-converted twice. `baseOffset` is the absolute Source position of `buffer[0]`, making the
// returned cursor absolute. `maxBytes` is a hard bound: bytes beyond it are not scanned, so a budget
// that lands inside a multi-byte code point commits nothing rather than decoding a replacement
// character. `sourceOrdinal` seeds the physical row number the way `grep -n` numbers it, and every
// physical row consumes one whether or not it parses. `atEof` is the sealed-Source flag; only then does
// a trailing row without LF count as complete.
export function readClaudeCodeRows(buffer, {
  baseOffset = 0,
  sourceOrdinal = 1,
  maxBytes = buffer.length,
  atEof = false,
} = {}) {
  const rows = [];
  const limit = Math.min(buffer.length, maxBytes);
  let byte = 0;
  let ordinal = sourceOrdinal;

  while (byte < limit) {
    const lf = buffer.indexOf(LF, byte);
    if (lf === -1 || lf >= limit) break;
    let contentEnd = lf;
    if (contentEnd > byte && buffer[contentEnd - 1] === CR) contentEnd--; // CRLF
    const row = decodeRow(buffer, byte, contentEnd, lf + 1, baseOffset, ordinal);
    if (row) rows.push(row);
    ordinal++;
    byte = lf + 1;
  }

  if (atEof && byte < limit) {
    const row = decodeRow(buffer, byte, limit, limit, baseOffset, ordinal);
    if (row) rows.push(row);
    ordinal++;
    byte = limit;
  }

  return { rows, nextOffset: baseOffset + byte, nextSourceOrdinal: ordinal };
}

function decodeRow(buffer, contentStart, contentEnd, byteEnd, baseOffset, ordinal) {
  let entry;
  try { entry = JSON.parse(buffer.toString('utf8', contentStart, contentEnd)); }
  catch { return null; }
  // A row that is valid JSON but not an object carries no native fields; it consumes its ordinal and
  // committed bytes like any other unusable row.
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return {
    entry,
    sourceOrdinal: ordinal,
    sourceEntryId: typeof entry.uuid === 'string' ? entry.uuid : null,
    timestamp: normalizeTimestamp(entry.timestamp),
    byteStart: baseOffset + contentStart,
    byteEnd: baseOffset + byteEnd,
  };
}

// --- Native usage normalization ---

function cacheCreationTotal(usage) {
  const cc = usage.cache_creation;
  if (cc && typeof cc === 'object') {
    return (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
  }
  return usage.cache_creation_input_tokens || 0;
}

// The single field-reading layer for Claude Code token facts. Unknown members are tolerated; an
// explicitly null KNOWN member means the row's usage is not readable at all. A `<synthetic>` model or
// four zero buckets is an aborted-turn artifact rather than a measured call, and admitting it would
// report a context stock of zero. Zero cache read alone stays admissible: a cold start or resume
// legitimately carries its whole prompt as uncached input.
// Module-private: the observation Interface is the only way in, so no other layer can read a raw usage
// field without going through here.
function normalizeClaudeCodeUsage(entry) {
  if (!entry || entry.type !== 'assistant') return null;
  const message = entry.message;
  if (!message || !message.usage || typeof message.usage !== 'object') return null;
  const usage = message.usage;
  if (KNOWN_USAGE_FIELDS.some(field => usage[field] === null)) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = cacheCreationTotal(usage);
  if (message.model === '<synthetic>' || (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0)) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

// Concatenated text of a harness-injected Skill content row, in native block order.
function extractSkillText(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text || null;
}

function isTaskNotificationRow(entry) {
  return entry.type === 'user'
    && typeof entry.message?.content === 'string'
    && entry.message.content.trimStart().startsWith(TASK_NOTIFICATION_TAG);
}

// A main-chain human turn: a `user` row carrying a genuine human message. Every other `user` row is the
// harness feeding something back into the same turn, so each exclusion below names one such producer —
// a sub-agent conversation, injected Skill content, a native compact summary, a sub-agent completion
// notice, or a tool result the model's own turn is waiting on. Real human input is a string content or
// a content array with no tool result in it.
function isClaudeCodeUserTurnBoundary(entry) {
  if (!entry || entry.type !== 'user') return false;
  if (entry.isSidechain === true) return false;
  if (entry.isMeta === true) return false;
  if (entry.isCompactSummary === true) return false;
  const message = entry.message;
  if (!message) return false;
  const content = message.content;
  if (typeof content === 'string') return !isTaskNotificationRow(entry);
  if (Array.isArray(content)) return !content.some(block => block && block.type === 'tool_result');
  return false;
}

// --- Topology ---

// `writeOrder` is the physical order of the ids indexed here, and every leaf rule below reads it: the
// order a row was written in is the only evidence of which sibling continues the conversation.
function createTopology() {
  return {
    parentById: new Map(),
    childrenById: new Map(),
    roots: [],
    writeOrder: [],
    activeLeafId: null,
  };
}

function indexTopologyRow(topology, row) {
  const id = row.sourceEntryId;
  if (id === null) return;
  const parent = row.entry.parentUuid ?? null;
  topology.parentById.set(id, parent);
  if (parent) {
    let children = topology.childrenById.get(parent);
    if (!children) { children = new Set(); topology.childrenById.set(parent, children); }
    children.add(id);
  } else if (!topology.roots.includes(id)) {
    topology.roots.push(id);
  }
  topology.writeOrder.push(id);
}

// The newest write in one root's subtree. Append-only ordering guarantees a child follows its parent
// but says nothing about which SIBLING continues the conversation: a tool result is parented to the row
// carrying its tool use, so with parallel calls the last-added child of a fork is routinely a one-row
// stub while the continuation is an earlier sibling. Collecting the subtree and then taking its newest
// physical write lands on the live branch by construction.
function newestWriteInSubtree(topology, rootId) {
  const subtree = new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (subtree.has(id)) continue;
    subtree.add(id);
    const children = topology.childrenById.get(id);
    if (children) for (const child of children) stack.push(child);
  }
  let leaf = rootId;
  for (const id of topology.writeOrder) if (subtree.has(id)) leaf = id;
  return leaf;
}

// Root-to-leaf ids of one canonical branch. A reused id can make the parent edges cyclic, so the walk
// stops on revisiting an id and the path it returns may then omit its root.
function canonicalPath(topology, leafId) {
  const seen = new Set();
  const reversed = [];
  let current = leafId;
  while (current != null) {
    if (seen.has(current)) break;
    seen.add(current);
    reversed.push(current);
    current = topology.parentById.get(current) ?? null;
  }
  return reversed.reverse();
}

// One canonical branch per root up to the live one, in source order. The live root is the one whose
// subtree holds the Source's newest write; a root after it is one a rewind moved the conversation off, so
// its branch is history the live conversation abandoned and folding its calls would report steps nothing
// was spent on. The accepted ids are the union up to there, so a row on no accepted branch — an abandoned
// fork sibling, a rewound-away root's subtree, or an island whose parent was never written — is not
// observed. The newest write can be an island, in no root's subtree at all; locating then fails and the
// last root stands in, which is the behavior this rule replaces.
function resolveCanonical(topology) {
  const leafByRoot = topology.roots.map(rootId => newestWriteInSubtree(topology, rootId));
  const newestId = topology.writeOrder[topology.writeOrder.length - 1];
  let liveIndex = topology.roots.length - 1;
  for (let index = 0; index < leafByRoot.length; index++) {
    if (leafByRoot[index] === newestId) liveIndex = index;
  }

  const acceptedIds = new Set();
  let activeLeafId = null;
  let activePath = [];
  // The live root is the last root this loop reaches, so the branch left in hand when it ends is the active
  // one. That shared source is what `append`'s withdrawal test rests on: an active leaf resolved from any
  // other root would be absent from the union it is tested against and report a stale branch on every
  // advance. A Source with no root at all leaves both at their starting values.
  for (let index = 0; index <= liveIndex; index++) {
    activeLeafId = leafByRoot[index];
    activePath = canonicalPath(topology, activeLeafId);
    for (const id of activePath) acceptedIds.add(id);
  }
  return { acceptedIds, activeLeafId, activePath };
}

// --- Normalized observations ---

function messageIdFor(row) {
  const nativeId = row.entry.message?.id;
  // A row-local key names one row and creates no cross-entry relationship, so it lives in its own
  // namespace: a native id that happens to read like an ordinal must not collide with it. Legacy
  // request identity is ignored — it groups retries, not logical messages.
  return typeof nativeId === 'string' && nativeId.length > 0
    ? NATIVE_MESSAGE_NAMESPACE + nativeId
    : ROW_MESSAGE_NAMESPACE + row.sourceOrdinal;
}

function nativeModelOf(entry) {
  const model = entry.message?.model;
  return typeof model === 'string' ? model : null;
}

function contentObservations(row, base, messageId) {
  const entry = row.entry;
  // A native compact summary is the harness restating the replaced prefix, not a human message. It is
  // suppressed here because this is the last layer holding the native marker — downstream sees normalized
  // observations only, so a text observation from this row would be indistinguishable from dialogue. The
  // row still takes its ordinal, still links the parent chain, and still opens an epoch when it is a root
  // with a call behind it.
  if (entry.isCompactSummary === true) return [];
  // Injected Skill content is harness evidence for the Skill call that produced it, never dialogue.
  if (entry.isMeta === true) {
    if (typeof entry.sourceToolUseID !== 'string') return [];
    return [{
      type: 'skill-payload',
      toolUseId: entry.sourceToolUseID,
      text: extractSkillText(entry) ?? '',
      ...base,
      provenance: 'harness',
    }];
  }
  const role = entry.type === 'assistant' ? 'assistant' : entry.type === 'user' ? 'human' : null;
  if (role === null) return [];
  const content = entry.message?.content;
  if (typeof content === 'string') {
    if (isTaskNotificationRow(entry)) {
      return [{ type: 'task-notification', text: content, ...base, provenance: 'harness' }];
    }
    return [{ type: 'text', role, text: content, messageId, ...base, provenance: role }];
  }
  if (!Array.isArray(content)) return [];

  const observations = [];
  for (const block of content) {
    if (!block) continue;
    // A text block with nothing in it says nothing about the conversation, so it is not a fact worth
    // reporting: a row whose blocks are all empty then reaches Dialogue as a row that contributed no body,
    // which is what keeps it distinguishable from a row that spoke. The suppression is per BLOCK — a
    // string `content` is the whole row's text, and an empty one is still that row's body.
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text === '') continue;
      observations.push({ type: 'text', role, text: block.text, messageId, ...base, provenance: role });
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      observations.push({
        type: 'tool-use',
        messageId,
        model: nativeModelOf(entry),
        cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        ...base,
        provenance: 'assistant',
      });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      observations.push({
        type: 'tool-result',
        toolUseId: block.tool_use_id,
        content: block.content,
        // An absent is_error stays distinct from a present false: the wire reports the native field.
        isError: block.is_error === undefined ? undefined : block.is_error === true,
        // The harness's own annotation of this result row, carried through uninterpreted — the tool-name
        // set is a product of local plugin configuration, so this layer stays name-agnostic. Present with
        // an absent `annotation` when the row carried none, which a consumer tells from no paired result
        // at all; the row's time is the observation's own `timestamp`.
        resultMeta: { annotation: entry.toolUseResult },
        ...base,
        provenance: 'harness',
      });
    }
  }
  return observations;
}

function observationsForRow(row, { epoch }) {
  const base = {
    sourceOrdinal: row.sourceOrdinal,
    sourceEntryId: row.sourceEntryId,
    timestamp: row.timestamp,
  };
  const observations = [];
  if (epoch) observations.push({ type: 'epoch-boundary', ...base, provenance: 'harness' });
  if (isClaudeCodeUserTurnBoundary(row.entry)) {
    observations.push({ type: 'turn-boundary', ...base, provenance: 'human' });
  }
  const messageId = messageIdFor(row);
  observations.push(...contentObservations(row, base, messageId));
  const usage = normalizeClaudeCodeUsage(row.entry);
  if (usage) {
    observations.push({
      type: 'usage',
      messageId,
      model: nativeModelOf(row.entry),
      usage,
      ...base,
      provenance: 'assistant',
    });
  }
  return observations;
}

// A result is parented to its own call's row while the continuation hangs off whichever result of the batch
// landed last, so every other result of a parallel batch is a sibling leaf off the ancestor chain. Such a
// row is accepted with the row it hangs from. Result rows are the one kind admitted this way because a
// rewound branch begins at a human row, never at a result, so what a rewind puts at a fork stays out with
// its branch (test/claude-code.transcript-observation.test.js `stay out with its branch`). A result row has
// a parent, so it is never a root: the epoch and readmission judgments below see only chain rows.
function carriesToolResult(entry) {
  const content = entry.message?.content;
  return Array.isArray(content) && content.some(block => block?.type === 'tool_result');
}

// --- Reducer ---

// Incremental and fresh reconstruction share this implementation and differ only in mutable state.
// `append` reports a stale active branch instead of guessing: the caller rebuilds from the complete
// Source rather than patching a branch that is no longer canonical.
export function createClaudeCodeObservationReducer() {
  let topology = createTopology();
  let epochOpenedForRoot = new Set();
  let unobservedIds = new Set();
  let activePath = [];
  let firstUsageOrdinal = null;

  function append(rows) {
    const previousLeafId = topology.activeLeafId;
    const kept = [];
    for (const row of rows) {
      // A sidechain row is an independent sub-agent context: it produces no observation and its ids
      // must not reach topology, where they would move the active leaf off the main chain.
      if (row.entry.isSidechain === true) continue;
      indexTopologyRow(topology, row);
      kept.push(row);
    }

    const resolved = resolveCanonical(topology);
    topology.activeLeafId = resolved.activeLeafId;
    activePath = resolved.activePath;

    // The accepted union answers this the same way it answers which new rows are observed, and what it is
    // asked about is the previous ACTIVE leaf: that leaf still in the union is still on a canonical branch,
    // so a compact's own root is appended beside what the caller holds. That leaf fallen out of the union
    // was abandoned by this advance, whatever else the advance did, so the branch goes back.
    if (previousLeafId !== null && !resolved.acceptedIds.has(previousLeafId)) {
      return { batches: [], staleBranch: true };
    }
    // The union moves both ways, so the same question is asked of the rows this reducer withheld. One of them
    // back inside it is a row a whole-Source read observes and the caller never received, and its own row is
    // in no later advance to carry the epoch a readmitted root owes. Withholding is not undoable in place,
    // so readmission goes back for the same reason abandonment does.
    for (const id of unobservedIds) {
      if (resolved.acceptedIds.has(id)) return { batches: [], staleBranch: true };
    }

    const batches = [];
    for (const row of kept) {
      const id = row.sourceEntryId;
      // Carrying a call is a property of the ROW, so it is read ahead of the acceptance filter below: which
      // branch is canonical changes as the Source grows, and a judgment that depended on it would answer one
      // way for a Source read in chunks and another for the same Source read whole — which is also the answer
      // a rebuild takes.
      if (firstUsageOrdinal === null && normalizeClaudeCodeUsage(row.entry) !== null) {
        firstUsageOrdinal = row.sourceOrdinal;
      }
      if (id !== null && !resolved.acceptedIds.has(id)
        && !(carriesToolResult(row.entry) && resolved.acceptedIds.has(topology.parentById.get(id)))) {
        unobservedIds.add(id);
        continue;
      }
      const nonFirstRoot = id !== null && topology.roots.indexOf(id) > 0;
      // A root the harness writes before the Source's first call belongs to the session-start preamble, so it
      // starts nothing the origin did not already start. The first call's own row is not before itself, so a
      // root that carries it opens: a missed reset carries the anchor across a real reset, while a boundary
      // opened without one only misnumbers a segment.
      const atOrAfterFirstUsage = firstUsageOrdinal !== null && row.sourceOrdinal >= firstUsageOrdinal;
      const epoch = nonFirstRoot && atOrAfterFirstUsage && !epochOpenedForRoot.has(id);
      if (epoch) epochOpenedForRoot.add(id);
      const observations = observationsForRow(row, { epoch });
      if (observations.length > 0) batches.push(observations);
    }
    return { batches, staleBranch: false };
  }

  function snapshot() {
    return {
      activeLeafId: topology.activeLeafId,
      activePath: activePath.slice(),
      roots: topology.roots.slice(),
    };
  }

  return { append, snapshot };
}

// One complete canonical multi-epoch reduction of already-read rows. Same rows produce the same ordered
// batches here and through an incremental reducer.
export function reduceClaudeCodeSnapshot(rows) {
  const reducer = createClaudeCodeObservationReducer();
  const { batches } = reducer.append(rows);
  const { activeLeafId, activePath } = reducer.snapshot();
  return { batches, observations: batches.flat(), activeLeafId, activePath };
}
