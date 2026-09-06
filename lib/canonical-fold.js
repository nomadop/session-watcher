// lib/canonical-fold.js — Shared canonical transcript topology and byte reader.
// Single source of truth for branch indexing, active-leaf detection, and branch selection
// consumed by both the Measurement Projection (fold.js) and the Dialogue Projection
// (dialogue-fold.js). This file contains only shared primitives; no dialogue materialization.

// --- Byte-safe JSONL reader ---

// C4-1 (B8): Pure byte-layer JSONL line reader. Locates '\n' in the Buffer and decodes ONLY each
// complete line's byte slice — never string-converts the whole read span then splits (V8 may copy a
// huge line). `chunk` is the incremental read buffer filled FROM INDEX 0 (production: readSync(fd,
// chunk, 0, maxBytes, watcher._offset)). `baseOffset` is the ABSOLUTE file position of chunk[0] —
// used only to make nextOffset absolute: nextOffset = baseOffset + committedBytesWithinChunk.
// `maxBytes` is the HARD bound (R7): only bytes within chunk[0..maxBytes-1] are scanned.
// `atEof` (default false) is a SEALED-file flag: only when true does a trailing newline-less line
// count as complete (F5 — live tail path passes atEof:false UNCONDITIONALLY).
export function readCompleteJsonlEventsFromBuffer(chunk, { baseOffset = 0, maxBytes, atEof = false } = {}) {
  const limit = Math.min(chunk.length, maxBytes ?? chunk.length);
  const events = [];
  const observations = [];
  let pos = 0; // in-chunk cursor (bytes consumed so far)
  // Rows are numbered as `grep -n`, `sed -n` and Read number them, so an address minted here
  // reaches the file's own tools unconverted — `CONTEXT.md` Transcript Line Ordinal (T).
  let lineOrdinal = 1;

  while (pos < limit) {
    // Find the next newline within the budget
    let nlIdx = -1;
    for (let i = pos; i < limit; i++) {
      if (chunk[i] === 0x0a) { nlIdx = i; break; } // '\n'
    }
    if (nlIdx === -1) break; // no complete line within budget

    // The line is chunk[pos..nlIdx] (inclusive of \n). Handle \r\n: strip trailing \r from content.
    let lineEnd = nlIdx; // exclusive end of content (before \n)
    if (lineEnd > pos && chunk[lineEnd - 1] === 0x0d) lineEnd--; // strip \r

    const lineBytes = chunk.slice(pos, lineEnd);
    const lineStr = lineBytes.toString('utf8');
    const committedEnd = nlIdx + 1; // byte after the \n
    let parsed;
    try { parsed = JSON.parse(lineStr); } catch { /* skip malformed lines */ }
    if (parsed !== undefined) {
      events.push(parsed);
      observations.push({
        entry: parsed,
        raw: lineStr,
        sourceRef: {
          uuid: typeof parsed.uuid === 'string' ? parsed.uuid : null,
          lineOrdinal,
          byteStart: baseOffset + pos,
          byteEnd: baseOffset + committedEnd,
        },
      });
    }

    lineOrdinal++;
    pos = committedEnd; // advance past \n
  }

  // F5: atEof — if sealed and there's a trailing chunk with no newline, treat it as one final event
  if (atEof && pos < limit) {
    const trailing = chunk.slice(pos, limit);
    const trailingStr = trailing.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(trailingStr); } catch { /* skip malformed */ }
    if (parsed !== undefined) {
      events.push(parsed);
      observations.push({
        entry: parsed,
        raw: trailingStr,
        sourceRef: {
          uuid: typeof parsed.uuid === 'string' ? parsed.uuid : null,
          lineOrdinal,
          byteStart: baseOffset + pos,
          byteEnd: baseOffset + limit,
        },
      });
      pos = limit;
    }
  }

  const caughtUp = (pos >= chunk.length) && (maxBytes == null || maxBytes >= chunk.length);
  return { events, observations, nextOffset: baseOffset + pos, caughtUp };
}

// --- Topology state ---

export function createTopologyState() {
  return {
    uuidToParent: new Map(),
    uuidChildren: new Map(),
    latestUuid: null,
    activeLeafUuid: null,
    firstRootUuid: null,
    compactDetected: false,
  };
}

export function resetTopologyState(state) {
  state.uuidToParent.clear();
  state.uuidChildren.clear();
  state.latestUuid = null;
  state.activeLeafUuid = null;
  state.firstRootUuid = null;
  state.compactDetected = false;
}

export function indexTopologyEntry(state, entry) {
  if (!entry || !entry.uuid) return;
  if (entry.isSidechain) return; // sidechain rows must not influence active-leaf detection
  state.uuidToParent.set(entry.uuid, entry.parentUuid ?? null);
  if (entry.parentUuid) {
    if (!state.uuidChildren.has(entry.parentUuid)) state.uuidChildren.set(entry.parentUuid, new Set());
    state.uuidChildren.get(entry.parentUuid).add(entry.uuid);
  } else if (!state.firstRootUuid) {
    state.firstRootUuid = entry.uuid; // first null-parent uuid = session origin
  } else {
    // Non-first null-parent root = compact (topology signal).
    state.compactDetected = true;
  }
  state.latestUuid = entry.uuid;
}

// Active leaf over the whole scan: the newest write. This is activeLeafForRoot's rule at file
// scope, where no subtree scan is needed — the last-written uuid IS the answer. It used to descend
// from that uuid by last-added child, which an append-only file makes vacuous (the newest write has
// no children yet) except on the one shape that gives it children, a reused uuid — and there the
// descent walked off to a stale entry.
export function detectActiveLeaf(state) {
  return state.latestUuid;
}

// Active leaf per root: the NEWEST write in that root's subtree, found by physical order.
// Append-only guarantees a child is written after its parent, but says nothing about which SIBLING
// continues the conversation: a tool_result is parented to the entry carrying its own tool_use, so
// with parallel calls the last-written child of a fork is routinely a one-node stub while the
// continuation is the earlier sibling. Descending by last-added child lands on the stub and
// truncates the path; the newest write is on the live branch by construction.
// `uuidsInWriteOrder` MUST be the physical order of the same scan that built `state`; a partial or
// reordered list silently selects a different leaf.
// Descent collects the subtree (a reused uuid can make uuidToParent cyclic, so walking UP has no
// well-defined root); physical order then picks the newest write within it. That makes the LEAF
// well defined and the walk terminating — not the path: on a cyclic parent edge resolveActivePath
// still breaks at the cycle and can return a path that omits the root, dropping its user turn
// (test/dialogue-fold.characterization.test.js `keeps canonical order` builds such a transcript).
export function activeLeafForRoot(state, rootUuid, uuidsInWriteOrder) {
  const subtree = new Set();
  const stack = [rootUuid];
  while (stack.length > 0) {
    const uuid = stack.pop();
    if (subtree.has(uuid)) continue; // cycle guard
    subtree.add(uuid);
    const children = state.uuidChildren.get(uuid);
    if (children) for (const child of children) stack.push(child);
  }
  let leaf = rootUuid;
  for (const uuid of uuidsInWriteOrder) if (uuid && subtree.has(uuid)) leaf = uuid;
  return leaf;
}

export function resolveActivePath(state, leafUuid) {
  const path = new Set();
  let current = leafUuid;
  while (current != null) {
    if (path.has(current)) break; // cycle guard
    path.add(current);
    current = state.uuidToParent.get(current) ?? null;
  }
  return path;
}

// Ancestor check: returns true if `ancestor` is on the path from `descendant` to root.
export function isTopologyAncestor(state, ancestorUuid, descendantUuid) {
  const visited = new Set();
  let current = descendantUuid;
  while (current != null) {
    if (current === ancestorUuid) return true;
    if (visited.has(current)) return false; // cycle guard
    visited.add(current);
    current = state.uuidToParent.get(current) ?? null;
  }
  return false;
}

// --- Branch selection (pure) ---

// selectCanonicalBranchPaths: builds a temporary topology from raw observations and returns one
// entry per branch — the branch's observations AND the root-to-leaf path they were filtered by, so
// a caller needing the path takes it from here instead of deriving its own. The second derivation
// is what let the last-added-child rule outlive the fix to the shared one.
// This is a PURE function — no watcher state, no side effects.
//
// Rules:
// 1. Sidechain rows are ignored while building topology (Dialogue filters later).
// 2. All non-sidechain null-parent UUID roots are detected in physical order.
// 3. Leaf per root is the NEWEST WRITE in that root's subtree — neither the last-added child nor
//    the deepest descendant.
// 4. Path filter: observations with no UUID plus observations whose UUID is on root-to-leaf path.
// 5. No parent-child edges → one unfiltered branch with ALL observations (including sidechain), and
//    a null path: there is no tree to filter against.
// 6. Preserves physical order; never dedupes by message.id or tool_use_id.
// 7. Always returns at least one branch for non-empty input.
export function selectCanonicalBranchPaths(observations) {
  if (!observations || observations.length === 0) return [];

  // Build temporary topology
  const topo = createTopologyState();
  for (const obs of observations) {
    indexTopologyEntry(topo, obs.entry);
  }

  const unfiltered = () => [{ root: null, leaf: null, path: null, observations: observations.slice() }];

  // Rule 5: no parent-child edges → one unfiltered branch
  if (topo.uuidChildren.size === 0) {
    return unfiltered();
  }

  // Detect all null-parent roots in physical (observation) order
  const roots = [];
  for (const obs of observations) {
    const entry = obs.entry;
    if (entry.uuid && !entry.isSidechain && topo.uuidToParent.get(entry.uuid) === null) {
      // Only add if this is truly a root (null parent) and not already collected
      if (!roots.includes(entry.uuid)) roots.push(entry.uuid);
    }
  }

  // If compact (multiple roots), produce one branch per root
  const writeOrder = observations.map(o => o.sourceRef.uuid);
  const branches = [];
  for (const rootUuid of roots) {
    const leaf = activeLeafForRoot(topo, rootUuid, writeOrder);
    const path = resolveActivePath(topo, leaf);
    // Filter: include observations whose uuid is on the path, or that have no uuid
    const branch = [];
    for (const obs of observations) {
      const uuid = obs.sourceRef.uuid;
      if (!uuid || path.has(uuid)) {
        branch.push(obs);
      }
    }
    branches.push({ root: rootUuid, leaf, path, observations: branch });
  }

  // Rule 7: always at least one branch
  if (branches.length === 0) {
    return unfiltered();
  }

  return branches;
}

// Observations-only projection, for callers that do not need each branch's path.
export function selectCanonicalBranches(observations) {
  return selectCanonicalBranchPaths(observations).map(b => b.observations);
}


