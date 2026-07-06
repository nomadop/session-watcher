import { readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { extractUsage } from './extract.js';
import { classifyMiss } from './l-measure.js';

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
      w._offset = 0; w._partial = '';
      w._segment++; w._segmentMaxTotal = 0; w._segmentMaxRead = 0; w._byId.clear(); w._segmentModel = null;
      w._latchedBaseline.clear(); // v1.1: segment-scoped latch must not survive a session reset
    }
    w._ino = st.ino;
    if (size === w._offset) return '';
    const len = size - w._offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, w._offset);
    w._offset += read;
    return buf.toString('utf8', 0, read);
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
  if (foldKey != null) w._byId.set(foldKey, w._calls.length);
  w._calls.push(rec);
  return { isNew: true, changed: true };
}

export function poll(w) {
  const text = w._partial + readNewText(w);
  const nl = text.lastIndexOf('\n');
  if (nl < 0) { w._partial = text; return { newCalls: 0, changed: false }; }
  w._partial = text.slice(nl + 1);      // hold back trailing partial line
  const complete = text.slice(0, nl);
  let newCalls = 0, changed = false;
  for (const raw of complete.split('\n')) {
    if (!raw || !raw.includes('"usage"')) continue;  // cheap prefilter (loose: matches "usage": { too)
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const u = extractUsage(entry);
    if (!u || u.isSidechain) continue;
    const r = foldCall(w, u);
    if (r.isNew) newCalls++;
    if (r.changed) changed = true; // snapshot output growth counts as a visible change → SSE
  }
  return { newCalls, changed };
}
