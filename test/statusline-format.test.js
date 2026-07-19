import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderReliability,
  renderLB,
  formatLine,
  _resetRenderState,
} from "../lib/statusline-format.js";

const base = {
  model: "claude-opus-4-8",
  calibratingReason: null,
  metricsReliable: true,
  L: 168000,
  Lstar: 300000,
  Lthreshold: 300000,
  restart: false,
  restartReason: null,
  phi: 1.4,
  paybackP: 0.2,
  kAvg: 3000,
  rateLamp: {
    reliable: true,
    hBreak: 8,
    billProgress: 0.42,
    currentTurnSeq: 5,
    lastStopEvent: null,
    lastBillEvent: null,
  },
};

test("D1: unreliable rateLamp renders measuring… line (v3 drops carousel/no_transcript branch)", () => {
  // v3: any !rl?.reliable state → single neutral "measuring…" line; no carousel, no no_transcript branch
  const s = { ...base, calibratingReason: "no_transcript", rateLamp: { reliable: false } };
  const out = formatLine(s);
  assert.match(out, /measuring…/);
  assert.ok(out.includes("opus"), "model tag present");
});

test("D1→A2: reliable line composes the new v3 layout (lamp bar %% xN · countdown u · delta L/b · tag :port)", () => {
  _resetRenderState();
  // v3 layout: 灯 bar %% ×N · ~Nt u · Δ L/b · model :port
  const s = {
    ...base,
    port: 38017,
    rateLamp: {
      ...base.rateLamp,
      billProgress: 0.42,
      billCycleCount: 3,
      x_display: 2.1,
      dhat: 0.4167,
      band: "entry_to_sweet",
      lBase: 80000,
      deepWaterDisplayLatched: false,
      inDeepWater: false,
      targetL: 200000,
      kAvg: 3000,
      currentTurnSeq: 5,
    },
    baseline: { total: 80000 },
  };
  const out = formatLine(s);
  // v3 layout has no [tag] prefix; uses ▮ bars; has 4 groups separated by ·
  assert.ok(!out.includes("["), "no [tag] prefix in v3");
  assert.ok(out.includes("▮") || out.includes("░"), "meter bar rendered");
  assert.ok(out.includes("42%"), "billProgress percentage");
  assert.ok(out.includes("opus"), "model tag present");
  assert.ok(!out.includes(":38017"), "port not in formatLine (server appends URL)");
  assert.ok(out.includes(" · "), "groups separated by ·");
});

test("B1: latched + no calibratingReason → hardUnavailable false, reason null", () => {
  const r = renderReliability({
    metricsReliable: true,
    calibratingReason: null,
    rateLamp: { reliable: true, billProgress: 0.42 },
  });
  assert.equal(r.hardUnavailable, false);
  assert.equal(r.reason, null);
});

test("B1: un-latched → reason surfaced", () => {
  const r = renderReliability({
    metricsReliable: true,
    calibratingReason: "low_confidence",
    rateLamp: { reliable: false },
  });
  assert.equal(r.reason, "low_confidence");
  assert.equal(r.hardUnavailable, false);
});

test("B1: no_transcript → hardUnavailable true", () => {
  const r = renderReliability({
    metricsReliable: true,
    calibratingReason: "no_transcript",
    rateLamp: { reliable: false },
  });
  assert.equal(r.hardUnavailable, true);
  assert.equal(r.reason, "no_transcript");
});

test("B1: reliable but billProgress NaN → reason null (formatLine handles rendering)", () => {
  const r = renderReliability({
    metricsReliable: true,
    calibratingReason: null,
    rateLamp: { reliable: true, billProgress: NaN },
  });
  assert.equal(r.reason, null);
  assert.equal(r.hardUnavailable, false);
});

test("B1: no_transcript + STALE reliable ledger → hardUnavailable true", () => {
  // The gap the reliable:false no_transcript test above misses: transcript gone but the last frame's
  // ledger is still reliable with a finite (now-stale) billProgress. hardUnavailable forces calibrating path.
  const r = renderReliability({
    metricsReliable: true,
    calibratingReason: "no_transcript",
    rateLamp: { reliable: true, billProgress: 0.42 },
  });
  assert.equal(r.hardUnavailable, true);
  assert.equal(r.reason, "no_transcript");
});

test("B2: post-latch metricsReliable===false renders the v3 meter, not 校准中", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    metricsReliable: false,
    calibratingReason: null,
    L: 100000,
    Lstar: 200000,
    Lthreshold: 200000,
    restart: false,
    baseline: { total: 55000 },
    rateLamp: {
      reliable: true,
      billProgress: 0.5,
      billCycleCount: 1,
      hBreak: 8,
      band: "entry_to_sweet",
      x_display: 2.0,
      dhat: 0.4,
      lBase: 55000,
      L_read: 100000,
      L_cap: 960000,
      inDeepWater: false,
      deepWaterDisplayLatched: false,
      targetL: 150000,
      kAvg: 3000,
      currentTurnSeq: 1,
    },
  };
  const out = formatLine(s);
  assert.doesNotMatch(
    out,
    /指标校准中/,
    "FU-C3 fix: post-latch meter is not collapsed",
  );
  assert.ok(out.includes("▮") || out.includes("░"), "v3 meter bar renders");
});

// v3: without rateLamp.reliable, formatLine returns a single neutral "measuring…" line.
// No carousel, no progressive fill — any !rl?.reliable state collapses to measuring…
test("B2: an un-latched frame (no rateLamp) renders measuring…, not 校准中 (v3 neutral line)", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    L: 400000,
    // rateLamp absent ⟹ !rl?.reliable ⟹ measuring… path
  };
  const out = formatLine(s);
  assert.doesNotMatch(out, /指标校准中/, "v3 never produces the legacy 指标校准中 text");
  // v3: unlatched renders neutral measuring line
  assert.match(out, /measuring…/, "measuring… line");
  assert.ok(out.includes("opus"), "model tag present");
});

// ── A2: new statusline layout (meter cluster + position + bridge + alert) ───────────────────────

test("A2: full new v3 layout — lamp bar %% xN · countdown u · delta L/b · tag :port", () => {
  _resetRenderState();
  const s = {
    model: "claude-opus-4-8",
    port: 38017,
    metricsReliable: true,
    calibratingReason: null,
    L: 168000,
    B: 80000,
    baseline: { total: 80000 },
    rateLamp: {
      reliable: true,
      billProgress: 0.42,
      billCycleCount: 2,
      hBreak: 8,
      x_display: 2.1,
      dhat: 0.4167,
      br: 0.05,
      lBase: 80000,
      L_read: 168000,
      L_cap: 960000,
      inDeepWater: false,
      kAvg: 3000,
      currentTurnSeq: 1,
      lastStopEvent: null,
    },
  };
  const out = formatLine(s);
  // v3 layout: 灯 bar %% ×N · ~Nt u · Δ L/b · model :port
  assert.ok(!out.includes("["), "no [tag] prefix");
  assert.ok(out.includes("🟢"), "sweet zone lamp");
  assert.ok(out.includes("42%"), "billProgress");
  assert.ok(out.includes("opus"), "model tag");
  assert.ok(!out.includes(":38017"), "port not in formatLine");
  assert.ok(out.includes("L168k"), "L value");
  assert.ok(out.includes("b80k"), "baseline value");
  assert.ok(!out.includes("\n"), "single line (no alert)");
});

test("A2: deep band shows 🟡 in v3 layout", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    metricsReliable: true,
    calibratingReason: null,
    L: 512000,
    B: 55000,
    baseline: { total: 55000 },
    rateLamp: {
      reliable: true,
      billProgress: 0.88,
      billCycleCount: 5,
      hBreak: 2,
      x_display: 9.3,
      dhat: 0.4,
      br: 0.15,
      lBase: 55000,
      L_read: 512000,
      L_cap: 960000,
      inDeepWater: true,
      kAvg: 5000,
      currentTurnSeq: 1,
    },
  };
  const out = formatLine(s);
  assert.ok(out.includes("🟡"), "deep water lamp");
  assert.ok(out.includes("88%"), "billProgress");
  assert.ok(out.includes("L512k"), "L value");
  assert.ok(out.includes("b55k"), "baseline value");
});

test("A2: alert on the hook turn renders on second line (no verdict word)", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    metricsReliable: true,
    calibratingReason: null,
    L: 512000,
    baseline: { total: 55000 },
    rateLamp: {
      reliable: true,
      billProgress: 0.5,
      billCycleCount: 1,
      hBreak: 2,
      x_display: 9,
      dhat: 0.4,
      band: "above_exit",
      lBase: 55000,
      L_read: 512000,
      L_cap: 960000,
      inDeepWater: true,
      deepWaterDisplayLatched: true,
      targetL: 600000,
      kAvg: 5000,
      currentTurnSeq: 3,
      lastStopEvent: {
        message: "空烧一个重启周期",
        turnSeq: 3,
        delivery: "stop_hook",
      },
    },
  };
  const out = formatLine(s);
  // v3: alerts render on the SECOND line prefixed with ↻
  const lines = out.split("\n");
  assert.equal(lines.length, 2, "two-line output when alert fires");
  assert.match(lines[1], /↻ 空烧一个重启周期/, "second line has alert message");
  assert.doesNotMatch(
    out,
    /建议重启|OVERDUE|强烈建议/,
    "no verdict word (话术纪律)",
  );
});

test("A2/RV-C17: the new statusline layout never reads fitWindow (ER-2 retired the kFit eta)", () => {
  _resetRenderState();
  // formatLine + its render helpers accept only `s`/`s.rateLamp`; none takes a fitWindow arg.
  // Assert the rendered line is identical whether or not a fitWindow-shaped field is present on the status.
  const s = {
    model: "opus",
    port: 38017,
    metricsReliable: true,
    calibratingReason: null,
    L: 168000,
    baseline: { total: 80000 },
    rateLamp: {
      reliable: true,
      billProgress: 0.42,
      billCycleCount: 2,
      hBreak: 8,
      x_display: 2.1,
      dhat: 0.4,
      band: "entry_to_sweet",
      lBase: 80000,
      L_read: 168000,
      L_cap: 960000,
      inDeepWater: false,
      deepWaterDisplayLatched: false,
      targetL: 200000,
      kAvg: 3000,
      currentTurnSeq: 1,
    },
  };
  // Must reset between calls since renderDelta has module state
  _resetRenderState();
  const a = formatLine({ ...s, fitWindow: 10 });
  _resetRenderState();
  const b = formatLine({ ...s, fitWindow: 40 });
  assert.equal(a, b);
});

// ── renderLB: fixed-width L/b formatting ─────────────────────────────────────────────────────────

test("renderLB: both values >= 100k → 4-char each, no extra spaces", () => {
  assert.equal(renderLB(180000, 180000), "L180k/b180k");
});

test("renderLB: small L tight-coupled, right-padded to 11", () => {
  assert.equal(renderLB(1000, 180000), "L1k/b180k  ");
});

test("renderLB: sub-1000 token values tight-coupled", () => {
  assert.equal(renderLB(500, 80000), "L500/b80k  ");
});

test("renderLB: non-finite values render as em-dash, right-padded", () => {
  const out = renderLB(NaN, 80000);
  assert.ok(out.startsWith("L"), "starts with L");
  assert.ok(out.includes("—"), "em-dash for NaN");
  assert.equal(out, "L—/b80k    ");
});
