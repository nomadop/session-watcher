import { readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { extractUsage, isUserTurnBoundary } from './extract.js';
import { classifyMiss } from './l-measure.js';
import { PRECHECK_LONG_LINE_BYTES, PRECHECK_HEAD_CAP_BYTES } from './constants.js';

// Loose, ReDoS-immune boundary precheck (spec §4.3). Double includes on head-resident markers ONLY.
// ALLOWS false positives (an extra JSON.parse); NEVER a false negative on pretty JSON or a giant payload.
// HEAD-CAP ASSUMPTION: PRECHECK_HEAD_CAP_BYTES (8192) must be >= the max byte offset of a boundary marker
// (`"type"`/`"user"`), which for CC transcripts is the line's first field (base64/tool payloads are in the
// tail). If a real transcript ever violates this, raise the cap — do NOT add a "fall through to parse on
// cap" fallback (that would re-parse the exact >1MB lines the precheck exists to skip). The A25 test pins it.
export function boundaryPrecheck(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const scan = raw.length > PRECHECK_LONG_LINE_BYTES
    ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES) // head-first: markers are in the line head, base64 is tail
    : raw;
  return scan.includes('"user"') && scan.includes('"type"');
}

// JSONL ingest + fold + segmentation, extracted from SessionWatcher (spec §3). These are the
// measurement-layer functions that turn raw transcript bytes into the folded `w._calls` records the
// baseline/latch/status/history layers consume. They take the watcher instance `w` and mutate its
// private state exactly as the original methods did — SessionWatcher keeps thin delegators so `this`
// dispatch and every test's `w._calls/_segment/_foldRev` access are byte-identical. No behavior change.

export function readNewText(w) {
  let fd;
  try { fd = openSync(w.path, 'r'); } catch { return ''; }
  w._transcriptSeen = true; // openSync succeeded → path is (was) readable, even if the file is empty (#13)
  try {
    const st = fstatSync(fd);
    const size = st.size;
    // Rotation/truncation guard: reset if the file shrank OR the inode changed (new file at same path).
    if (size < w._offset || (w._ino != null && st.ino !== w._ino)) {
      // I/O-layer reset (not in resetFoldState — these are read-level, not fold-level)
      w._offset = 0; w._partial = '';
      if (w._decoder) w._decoder = new StringDecoder('utf8');
      // Fold + branch state reset (unified helper — single source of truth).
      // clearCalls:false — rotation preserves old-segment calls for getHistory.
      resetFoldState(w, { bumpSegment: true, clearCalls: false });
    }
    w._ino = st.ino;
    if (size === w._offset) return '';
    const len = size - w._offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, w._offset);
    w._offset += read;
    // H3: use StringDecoder to handle multi-byte codepoints split across read boundaries.
    // StringDecoder buffers incomplete trailing bytes and emits them on the next write().
    if (!w._decoder) w._decoder = new StringDecoder('utf8');
    return w._decoder.write(buf.slice(0, read));
  } finally { closeSync(fd); }
}

export function foldCall(w, u) {
  // Dedup key: message.id is PREFERRED; requestId is a FALLBACK used ONLY for id-less streaming
  // snapshots (a provider that emits multiple snapshots of one call without a message.id).
  // Defensive path — real Claude/DeepSeek transcripts always set message.id, so foldKey === messageId
  // there → zero behavior change on real data. Accepted tradeoff: if a single request ever
  // legitimately carried multiple DISTINCT id-less assistant messages, they would fold into one —
  // acceptable because the trigger is "no message.id at all", i.e. exactly the id-less path.
  const foldKey = u.messageId ?? u.requestId ?? null;

  // Snapshot folding FIRST: a late-arriving snapshot of an existing call (lower cacheRead)
  // must NOT be mistaken for an L-drop segment boundary. Only genuinely NEW calls drive segmentation.
  if (foldKey != null && w._byId.has(foldKey)) {
    const idx = w._byId.get(foldKey);
    const totalTok = u.input + u.output + u.cacheRead + u.cacheCreation;
    let changed = false;
    if (totalTok >= w._calls[idx]._total) {
      const prev = w._calls[idx];
      const crCcChanged = u.cacheRead !== prev.cacheRead || u.cacheCreation !== prev.cacheCreation;
      // Re-run miss classification from the record's STORED peaks-before (unchanged by its own
      // cr/cc revision) so the mutated record's miss/L reflect the new raw values. In real
      // transcripts only `output` grows (cr/cc immutable per message.id), so crCcChanged is
      // effectively a defensive path (spec §3.6.1) — but honoring it keeps getStatus/getHistory
      // reading identical records (QF1). Task 5 additionally clears the affected latch here.
      // Provider-agnostic (spec §3.7 revised): no provider gate — same structural criteria as the
      // new-call path, so a model-less snapshot is handled identically (no vendor inheritance issue).
      const miss = crCcChanged
        ? classifyMiss({ cacheRead: u.cacheRead, cacheCreation: u.cacheCreation,
            peakTotalBefore: prev._peakTotalBefore, peakReadBefore: prev._peakReadBefore })
        : prev.miss;
      const L = miss ? (u.cacheRead + u.cacheCreation) : u.cacheRead;
      w._calls[idx] = { ...prev, cacheRead: u.cacheRead, output: u.output,
        input: u.input, cacheCreation: u.cacheCreation, gField: u.gField, ts: u.ts,
        _total: totalTok, miss, L };
      changed = true;
      w._foldRev++; // H1 hazard #1: in-place mutation with unchanged length → force cache rebuild.
      // ER-1: _foldRev++ makes getHistory re-scan latchBySeg on the (possibly gField-perturbed)
      // sequence, so the getStatus instance store MUST re-scan the same sequence — else the two
      // stores can freeze DIFFERENT prefixes → QF1 (statusline L* == chart last point) breaks. This
      // holds for crCcChanged (spec §3.6.1 data revision, not no-release-protected) AND for an
      // output-only fold (gField is rewritten → the metricsReliable sequence getHistory rebuilds on
      // changes). Clear this segment and any later one on ANY accepted in-place fold; getStatus then
      // re-scans the earliest passing prefix, matching getHistory's rebuild. (crCcChanged is still
      // read above for the miss recompute.)
      const mutatedSeg = w._calls[idx].segment;
      for (const segId of [...w._latchedBaseline.keys()]) {
        if (segId >= mutatedSeg) w._latchedBaseline.delete(segId);
      }
    }
    return { isNew: false, changed };
  }

  // New unique call → now it may open a new segment on a genuine context DROP. Segment on the
  // TOTAL context stock (cacheRead + cacheCreation), NOT cacheRead alone: a cache-expiry row
  // (cacheRead≈0, cacheCreation≈full context) keeps total ≈ unchanged → no false segment; a real
  // /clear|/compact that shrinks the context below the prior peak total → total drops → segment.
  // (input/output are per-turn transients, not carried context, so they're excluded from the stock.)
  // RESIDUAL (inverse of the cache-expiry case; accepted tradeoff of approach B): a /clear whose
  // FRESH context EXCEEDS the prior segment's peak total (e.g. clearing a barely-grown session then
  // loading a large file) does NOT drop total → boundary missed. Token-indistinguishable from a
  // cache-expiry, so inherent to B; low impact (typical clears shrink total). See round2-T1 ledger.
  const total = u.cacheRead + u.cacheCreation;
  // Read the OLD peaks BEFORE this row updates them (spec §3.1 / GPT#4): the current row must not
  // write itself into the peak and then compare against it.
  const peakTotalBefore = w._segmentMaxTotal;
  const peakReadBefore = w._segmentMaxRead;
  // Provider-agnostic miss detection (spec §3.7 revised): NO isClaude/provider gate — miss is a
  // structural signature (criteria 1–3), not a vendor fact. DeepSeek (cc≡0) is a structural no-op via
  // criterion 1; a renamed/rehosted Claude is no longer lost to a name-regex miss.
  const miss = classifyMiss({ cacheRead: u.cacheRead, cacheCreation: u.cacheCreation, peakTotalBefore, peakReadBefore });

  // Segment on a genuine total-stock DROP, but a miss row (read collapsed, stock preserved) must
  // NOT be mistaken for a boundary — exclude isMiss explicitly (spec §3.1 order).
  const startsNewSegment = !miss && w._segmentMaxTotal > 0 && total < w._segmentMaxTotal;
  if (startsNewSegment) {
    w._segment++; w._byId.clear();
    w._segmentModel = u.model; // lock model/ratio at segment creation
    // I1 (spec §3.1 / §10.14): reset BOTH peaks to the CURRENT row — never Math.max(oldPeak, cur),
    // else the new segment inherits the old peak and criteria 2/3 are poisoned.
    w._segmentMaxTotal = total;
    w._segmentMaxRead = u.cacheRead;
  } else {
    if (w._segmentMaxTotal === 0) w._segmentModel = w._segmentModel || u.model;
    w._segmentMaxTotal = Math.max(w._segmentMaxTotal, total);
    w._segmentMaxRead = Math.max(w._segmentMaxRead, u.cacheRead);
  }

  // Authoritative L: reconstruct stock on a miss, else raw cacheRead (the L=cacheRead rule).
  const L = miss ? total : u.cacheRead;
  const totalTok = u.input + u.output + u.cacheRead + u.cacheCreation;
  const rec = {
    messageId: u.messageId, cacheRead: u.cacheRead, output: u.output, input: u.input,
    cacheCreation: u.cacheCreation, gField: u.gField, model: u.model, ts: u.ts,
    segment: w._segment, _total: totalTok,
    L, miss,
    // Peaks-before are stored so an in-place fold that later rewrites cr/cc can re-run classifyMiss
    // for THIS record deterministically (spec §3.6; used by Task 5's scoped invalidation).
    _peakTotalBefore: peakTotalBefore, _peakReadBefore: peakReadBefore,
  };
  // RV-C7: open a new turn at the FIRST new assistant call following a user boundary. On the very first
  // call of the session (_turnSeq===0) also start turn 1. Snapshot re-folds never reach here → they
  // neither advance _foldedCallSeq nor _turnSeq (idempotency preserved).
  if (w._pendingTurnBump || w._turnSeq === 0) { w._turnSeq++; w._pendingTurnBump = false; }
  if (foldKey != null) w._byId.set(foldKey, w._calls.length);
  w._foldedCallSeq++;
  rec.foldedSeq = w._foldedCallSeq;   // ledger idempotency key (stamped on the record)
  rec.turnSeq = w._turnSeq;           // RV-C7: the REAL transcript turn this call belongs to
  w._calls.push(rec);
  return { isNew: true, changed: true };
}

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
  let pos = 0; // in-chunk cursor (bytes consumed so far)

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
    let parsed;
    try { parsed = JSON.parse(lineStr); } catch { /* skip malformed lines */ }
    if (parsed !== undefined) events.push(parsed);

    pos = nlIdx + 1; // advance past \n
  }

  // F5: atEof — if sealed and there's a trailing chunk with no newline, treat it as one final event
  if (atEof && pos < limit) {
    const trailing = chunk.slice(pos, limit);
    const trailingStr = trailing.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(trailingStr); } catch { /* skip malformed */ }
    if (parsed !== undefined) { events.push(parsed); pos = limit; }
  }

  const caughtUp = (pos >= chunk.length) && (maxBytes == null || maxBytes >= chunk.length);
  return { events, nextOffset: baseOffset + pos, caughtUp };
}

// --- Branch indexer (M9) ---

function indexRow(w, entry) {
  if (!entry || !entry.uuid) return;
  if (entry.isSidechain) return; // sidechain rows must not influence active-leaf detection
  w._uuidToParent.set(entry.uuid, entry.parentUuid ?? null);
  if (entry.parentUuid) {
    if (!w._uuidChildren.has(entry.parentUuid)) w._uuidChildren.set(entry.parentUuid, new Set());
    w._uuidChildren.get(entry.parentUuid).add(entry.uuid);
  }
  w._latestUuid = entry.uuid;
}

// Active leaf: the last-written uuid is always on the active branch (CC writes linearly).
// Follow its children downward to find the deepest leaf.
function detectActiveLeaf(w) {
  const visited = new Set(); // cycle guard (defense-in-depth)
  let leaf = w._latestUuid;
  while (leaf && w._uuidChildren.has(leaf)) {
    if (visited.has(leaf)) break;
    visited.add(leaf);
    const children = w._uuidChildren.get(leaf);
    leaf = [...children].pop(); // last-added child = most recent write
  }
  return leaf;
}

function resolveActivePath(w, leafUuid) {
  const path = new Set();
  let current = leafUuid;
  while (current != null) {
    if (path.has(current)) break; // cycle guard — should never happen in valid JSONL
    path.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return path;
}

// Ancestor check: returns true if `ancestor` is on the path from `descendant` to root.
// Used to distinguish linear append (old leaf is ancestor of new leaf) from fork/rewind.
function isAncestorOf(w, ancestor, descendant) {
  const visited = new Set();
  let current = descendant;
  while (current != null) {
    if (current === ancestor) return true;
    if (visited.has(current)) return false; // cycle guard
    visited.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return false;
}

// Unified reset helper — rotation/fork/replay paths go through this.
// Prevents state field drift by centralizing the reset list.
// `clearCalls`: true for full replay (fork/rewind — re-fold from file); false for rotation
//   (rotation keeps old-segment calls for getHistory, only clears per-segment state).
function resetFoldState(w, { bumpSegment = false, bumpFoldRev = true, clearCalls = true } = {}) {
  if (clearCalls) w._calls.length = 0;
  w._byId.clear();
  if (bumpSegment) w._segment++;
  else w._segment = 0;
  w._segmentMaxTotal = 0;
  w._segmentMaxRead = 0;
  w._segmentModel = null;
  if (clearCalls) { w._foldedCallSeq = 0; w._turnSeq = 0; w._pendingTurnBump = false; }
  if (bumpFoldRev) w._foldRev++;
  w._latchedBaseline.clear();
  // M9 branch state
  w._uuidToParent.clear();
  w._uuidChildren.clear();
  w._latestUuid = null;
  w._activeLeafUuid = null;
}

function replayActivePath(w) {
  // Re-read and re-index the full file, then fold only active-path rows
  let fd;
  try { fd = openSync(w.path, 'r'); } catch { return; }
  // Reset AFTER successful open — if open fails, preserve existing state (#1 review fix)
  resetFoldState(w);
  try {
    const st = fstatSync(fd);
    const buf = Buffer.allocUnsafe(st.size);
    const bytesRead = readSync(fd, buf, 0, st.size, 0);
    const safeBuf = buf.subarray(0, bytesRead);
    const { events } = readCompleteJsonlEventsFromBuffer(safeBuf, { atEof: true });

    // Rebuild branch index from scratch
    for (const entry of events) indexRow(w, entry);
    w._activeLeafUuid = detectActiveLeaf(w);

    // Resolve active path AFTER full index is built
    const activePath = w._uuidChildren.size > 0
      ? resolveActivePath(w, w._activeLeafUuid)
      : null;

    // Fold only active-path records
    for (const entry of events) {
      if (activePath && entry.uuid && !activePath.has(entry.uuid)) continue;
      if (isUserTurnBoundary(entry)) { w._pendingTurnBump = true; continue; }
      const u = extractUsage(entry);
      if (!u || u.isSidechain) continue;
      foldCall(w, u);
    }
  } finally { closeSync(fd); }
}

export function poll(w) {
  // IMPORTANT: call readNewText FIRST, then read w._partial. If readNewText detects
  // rotation/truncate it clears w._partial — reading _partial before the call would
  // capture the stale value and prepend old-session garbage to new-session content.
  const chunk = readNewText(w);
  const text = w._partial + chunk;
  const nl = text.lastIndexOf('\n');
  if (nl < 0) { w._partial = text; return { newCalls: 0, changed: false }; }
  w._partial = text.slice(nl + 1);
  const complete = text.slice(0, nl);

  // --- Phase A: parse batch, build branch index ---
  const batch = [];
  for (const raw of complete.split('\n')) {
    if (!raw) continue;
    let entry = null;
    // Parse rows that contain uuid (branch tracking) or usage/boundary (fold).
    // Head-cap the "uuid" check: CC writes uuid as a top-level field early in the JSON,
    // so it's always in the first PRECHECK_HEAD_CAP_BYTES — avoids triggering JSON.parse
    // on multi-MB tool_use/base64 lines that happen to contain "uuid" deep in payload.
    const head = raw.length > PRECHECK_LONG_LINE_BYTES
      ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES)
      : raw;
    if (head.includes('"uuid"') || raw.includes('"usage"') || boundaryPrecheck(raw)) {
      try { entry = JSON.parse(raw); } catch { continue; }
    }
    if (!entry) continue;
    indexRow(w, entry);
    batch.push(entry);
  }

  if (batch.length === 0) return { newCalls: 0, changed: false };

  // --- Phase B: determine active leaf, decide fast-path vs replay ---
  // Active-path filtering is only meaningful when a connected tree exists (at least one
  // parent-child edge). Legacy/test JSONL with uuid but no parentUuid forms disconnected roots
  // — no branching to filter, fold everything (graceful degradation).
  const hasTree = w._uuidChildren.size > 0;
  const prevLeaf = w._activeLeafUuid;
  const currentLeaf = hasTree ? detectActiveLeaf(w) : null;
  w._activeLeafUuid = currentLeaf;

  // Fork/rewind detection: old leaf is NOT an ancestor of new leaf.
  // Linear append: old leaf IS an ancestor (or null on first poll) → fast path.
  const needsReplay = hasTree && prevLeaf && currentLeaf && !isAncestorOf(w, prevLeaf, currentLeaf);

  if (needsReplay) {
    replayActivePath(w);
    return { newCalls: w._calls.length, changed: true };
  }

  // Fast path: fold only new batch rows that are on the active path
  const activePath = (hasTree && currentLeaf) ? resolveActivePath(w, currentLeaf) : null;
  let newCalls = 0, changed = false;

  for (const entry of batch) {
    // M9: skip rows not on active path (filter BEFORE boundary processing).
    // Only applies when a connected tree exists (hasTree).
    if (activePath && entry.uuid && !activePath.has(entry.uuid)) continue;

    if (isUserTurnBoundary(entry)) { w._pendingTurnBump = true; continue; }
    const u = extractUsage(entry);
    if (!u || u.isSidechain) continue;
    const r = foldCall(w, u);
    if (r.isNew) newCalls++;
    if (r.changed) changed = true;
  }

  return { newCalls, changed };
}
