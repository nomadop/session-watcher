// Replay module (post-v3): progressive transcript feeding through the production pipeline.
// Architecture: a fresh watcher + the full getStatus/mergeLedger chain run on each step.
// Replay only controls HOW MUCH of the file the watcher can read (byte-limit valve in readNewText).
// Zero re-derivation of metrics — everything comes from the same code path as live.

import { readFileSync } from 'node:fs';
import { advanceGateAndBackstop } from './rate-lamp-store.js';
import { isInDeepWater } from './bill-regret.js';

/**
 * Pre-index a transcript: find byte offsets of usage rows (the lines that produce folded calls).
 * Returns [{byteEnd, ts}] — one entry per usage row.
 */
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
    const lineEnd = nlIdx === -1 ? buf.length : nlIdx + 1;
    // Match production poll()'s PRECHECK_HEAD_CAP_BYTES (8192)
    const head = buf.slice(pos, Math.min(pos + 8192, lineEnd)).toString('utf8');

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
  constructor(watcher, index, { speed = 4, onAdvance = null } = {}) {
    this._watcher = watcher;
    this._index = index;
    this._speed = Math.max(0.1, speed);
    this._cursor = 0;
    this._timer = null;
    this._onAdvance = onAdvance;
    this._paused = false;
    this._done = false;
    // Trapezoidal billProgress accumulator (same math as rate-lamp-store applyFoldedCallSample)
    this._billProgress = 0;
    this._prevBurnRate = null;  // null = recovering (first frame anchors only, no integration)
    // Gate/backstop state (same shape as ledger fields used by advanceGateAndBackstop)
    this._gateDraft = {
      hasDeepWaterGateFired: false,
      dwBillsSinceLastAlert: 0,
      backstopLapCount: 0,
      deepWaterDwell: 0,
      deepWaterDwellCycled: 0,
    };
    this._lastNotify = null;  // { kind: 'gate'|'backstop' } when fired
    this._notifyTTL = 0;     // steps remaining before clearing lastNotify

    // Start with nothing revealed
    watcher._replayByteLimit = 0;
  }

  /** Current billProgress [0,1) for rentMeter cycleProgress */
  get billProgress() { return this._billProgress; }

  /** Gate/backstop state for depth meter */
  get gateState() { return this._gateDraft; }

  /** Last notification fired (or null) */
  get lastNotify() { return this._lastNotify; }

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
    delete this._watcher._replayByteLimit;
  }

  _scheduleNext() {
    if (this._paused || this._done) return;

    if (this._cursor >= this._index.length) {
      this._done = true;
      // Open the valve fully for any trailing data
      this._watcher._replayByteLimit = Infinity;
      this._watcher.poll();
      if (this._onAdvance) this._onAdvance();
      return;
    }

    // Advance: reveal up to the next usage row
    const step = this._index[this._cursor];
    this._watcher._replayByteLimit = step.byteEnd;
    this._cursor++;

    // Poll — watcher processes newly revealed bytes through the full production pipeline
    this._watcher.poll();

    // Trapezoidal integration of burnRate for rentMeter — matches production's
    // applyFoldedCallSample recovering logic: first reliable frame only anchors,
    // does not integrate (P0-5 no catch-up).
    const status = this._watcher.getStatus();
    const currBurnRate = Number.isFinite(status.burnRate) ? status.burnRate : 0;
    let billCycleIncrement = 0;
    if (this._prevBurnRate == null) {
      // Recovering: anchor only, no integration (matches production)
      this._prevBurnRate = currBurnRate;
    } else {
      const trap = 0.5 * (this._prevBurnRate + currBurnRate);
      this._billProgress += trap;
      while (this._billProgress >= 1) { this._billProgress -= 1; billCycleIncrement++; }
      this._billProgress = Math.floor(this._billProgress * 1e6) / 1e6;
      this._prevBurnRate = currBurnRate;
    }

    // Gate/backstop: same state machine as production (advanceGateAndBackstop)
    const rl = status.rateLamp;
    const deepWater = rl?.reliable ? isInDeepWater(rl.x_display, rl.xSweet, rl.br) : false;
    const { fired, kind } = advanceGateAndBackstop(this._gateDraft, {
      inDeepWater: deepWater,
      billCycleIncrement,
      mf: rl?.mf ?? 0,
    });
    if (fired) { this._lastNotify = { kind }; this._notifyTTL = 6; }
    else if (this._lastNotify) { this._notifyTTL--; if (this._notifyTTL <= 0) this._lastNotify = null; }

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
