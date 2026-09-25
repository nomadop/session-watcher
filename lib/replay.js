// Replay module (post-v3): progressive transcript feeding through the production pipeline.
// Architecture: a fresh watcher, and each step's frame drained through the shared rent reducer the live
// manager uses; the host's status branch merges that ledger the way it merges the live one.
// Replay only controls HOW MUCH of the file the watcher can read (byte-limit valve in readNewText).
// Zero re-derivation of metrics — everything comes from the same code path as live.

import { readFileSync } from 'node:fs';
import { freshLedger, drainFrame, stateKeyForStatus } from './rate-lamp-store.js';

/**
 * Pre-index a transcript: find byte offsets of usage rows (the lines that produce folded calls).
 * Returns [{byteEnd, ts}] — one entry per usage row.
 */
// The pacing index scans only this far into each row, and both `"timestamp"` and `"usage"` are written
// AFTER `message.content`, so a large enough payload pushes either past `INDEX_HEAD_BYTES`:
//   * `"timestamp"` — the dominant one, because `lastTs` CARRIES: a truncated row leaves the previous
//     row's time in place and every step from there on is stamped with a time that is not its own, so the
//     damage propagates forward rather than staying on the row that caused it;
//   * `"usage"` — the row is simply absent from the index, and Playback paces past that step.
// `"id"` is read only inside `"usage"` rows and sits before `message.content`, so it is not exposed.
// Live measurement does not share this gate: the Source read path parses every complete row in full at
// any size. The exposure is Playback pacing only, and it predates the harness/projection decoupling.
const INDEX_HEAD_BYTES = 8192;

export function indexTranscript(filePath) {
  const buf = readFileSync(filePath);
  const steps = [];
  let pos = 0;
  let lastTs = null;

  // First pass: collect all usage rows, tracking messageId for dedup.
  // A message may appear multiple times (streaming snapshots); only the LAST
  // occurrence carries the final token counts — keep that one, skip earlier ones.
  const idToIndex = new Map(); // messageId → index in steps[]

  while (pos < buf.length) {
    const nlIdx = buf.indexOf(0x0A, pos);
    // Only LF-terminated rows are indexed. A newline-less tail is an INCOMPLETE row: the source driver will
    // not commit it either, so indexing it would name a byte limit no advance can reach and an incomplete
    // usage tail would both add an entry and, on the dedup path below, revise an earlier one.
    if (nlIdx === -1) break;
    const lineEnd = nlIdx + 1;
    const head = buf.slice(pos, Math.min(pos + INDEX_HEAD_BYTES, lineEnd)).toString('utf8');

    // Extract timestamp
    const tsMatch = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (tsMatch) { const p = Date.parse(tsMatch[1]); if (!Number.isNaN(p)) lastTs = p; }

    // Usage rows are the measurement events
    if (head.includes('"usage"')) {
      // Extract messageId for dedup (always near the start of assistant entries)
      const idMatch = head.match(/"id"\s*:\s*"([^"]+)"/);
      const msgId = idMatch ? idMatch[1] : null;

      if (msgId && idToIndex.has(msgId)) {
        // Replace earlier snapshot with this later one (final tokens)
        const prevIdx = idToIndex.get(msgId);
        steps[prevIdx] = { byteEnd: lineEnd, ts: lastTs };
      } else {
        const idx = steps.length;
        steps.push({ byteEnd: lineEnd, ts: lastTs });
        if (msgId) idToIndex.set(msgId, idx);
      }
    }
    pos = lineEnd;
  }

  return steps;
}

/**
 * ReplayController: feeds the file to the watcher one usage-row at a time.
 * The watcher runs the full production fold/getStatus pipeline on each step.
 */
export class ReplayController {
  constructor(watcher, index, { speed = 4, onAdvance = null, driver = null } = {}) {
    this._watcher = watcher;
    // Playback advances its OWN source driver with absolute line-end byte limits; it never touches the live
    // Source cursor and holds no offset of its own. Each finite limit ends exactly one playback step.
    this._driver = driver;
    this._index = index;
    this._speed = Math.max(0.1, speed);
    this._cursor = 0;
    this._timer = null;
    this._onAdvance = onAdvance;
    this._paused = false;
    this._done = false;
    // The playback rent ledger: the same reducer path the live manager drains, keyed by segment.
    this._ledger = null;
  }

  /** The playback rent ledger, merged into the playback status by the host. */
  get ledger() { return this._ledger; }

  _drain() {
    const frame = this._watcher.readRateLampFrame(this._ledger ? this._ledger.lastAppliedFoldedCallSeq : 0);
    const key = stateKeyForStatus({ segment: frame.progress.segment });
    if (!this._ledger || this._ledger.stateKey !== key) this._ledger = freshLedger(key);
    drainFrame(this._ledger, frame);
  }

  get speed() { return this._speed; }
  set speed(v) { this._speed = Math.max(0.1, v); }

  get progress() {
    return { current: this._cursor, total: this._index.length, done: this._done, paused: this._paused, speed: this._speed };
  }

  start() {
    if (this._timer) return;
    this._paused = false;
    this._scheduleNext();
  }

  pause() {
    this._paused = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  stop() {
    this.pause();
    this._done = true;
  }

  _advance(byteLimit) {
    return this._driver.advance({ captureMode: 'replay', byteLimit });
  }

  _scheduleNext() {
    if (this._paused || this._done) return;

    if (this._cursor >= this._index.length) {
      // One final UNBOUNDED advance with live row-completeness semantics. It is the Source and the
      // application — not physical EOF and not the Source offset — that decide playback is finished: a
      // returned frame must apply successfully, and no frame at all completes playback normally. An
      // incomplete usage tail therefore leaves the tail pending and still completes.
      // The final advance can carry calls the pacing index missed, so the ledger follows the measurement to
      // its tail; an advance that returns no frame leaves the ledger where it stands.
      const frame = this._advance(Infinity);
      if (frame) { this._watcher.applyHarnessFrame(frame); this._drain(); }
      this._done = true;
      if (this._onAdvance) this._onAdvance();
      return;
    }

    // Advance to the absolute line end of the next indexed usage row. That bound ends this step.
    const step = this._index[this._cursor];
    this._cursor++;
    const frame = this._advance(step.byteEnd);
    if (frame) { this._watcher.applyHarnessFrame(frame); this._drain(); }

    if (this._onAdvance) this._onAdvance();

    // Schedule next step
    if (this._cursor < this._index.length) {
      const next = this._index[this._cursor];
      const rawGap = (next.ts && step.ts) ? Math.max(0, next.ts - step.ts) : 0;
      // Clamp: cut idle gaps over 10s before speed division
      const clampedGap = Math.min(10000, rawGap);
      // Minimum 50ms per step (at high speeds), 500ms floor only below speed 20.
      // This lets speed=100+ blow through quickly while keeping low speeds readable.
      const minDelay = this._speed >= 20 ? 50 : 500;
      const delay = Math.max(minDelay, clampedGap / this._speed);
      this._timer = setTimeout(() => { this._timer = null; this._scheduleNext(); }, delay).unref();
    } else {
      this._timer = setTimeout(() => { this._timer = null; this._scheduleNext(); }, 100).unref();
    }
  }
}
