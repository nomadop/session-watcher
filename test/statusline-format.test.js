import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderLB,
  formatLine,
  _resetRenderState,
} from "../lib/statusline-format.js";

const base = {
  model: "claude-opus-4-8",
  L: 168000,
  rateLamp: {
    reliable: true,
    billProgress: 0.42,
    currentTurnSeq: 5,
    lastStopEvent: null,
  },
};

test("D1: unreliable rateLamp renders measuring… line (v3 drops carousel/no_transcript branch)", () => {
  // v3: any !rl?.reliable state → single neutral "measuring…" line; no carousel, no no_transcript branch
  const s = { ...base, rateLamp: { reliable: false } };
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
      billProgress: 0.71,
      billCycleCount: 3,
      x_display: 2.1,
      dhat: 0.4167,
      currentTurnSeq: 5,
      mf: 0.3,
      rentMeter: { depthActive: true, depthProgress: 0.42 },
    },
  };
  const out = formatLine(s);
  // v3 layout has no [tag] prefix; uses ▮ bars; has 4 groups separated by ·
  assert.ok(!out.includes("["), "no [tag] prefix in v3");
  assert.ok(out.includes("▮") || out.includes("░"), "meter bar rendered");
  assert.ok(out.includes("42%"), "wallet phase percentage");
  assert.ok(!out.includes("71%"), "the sibling bill phase is not what the meter reads");
  assert.ok(out.includes("opus"), "model tag present");
  assert.ok(!out.includes(":38017"), "port not in formatLine (server appends URL)");
  assert.ok(out.includes(" · "), "groups separated by ·");
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
    L: 168000,
    B: 80000,
    rateLamp: {
      reliable: true,
      billProgress: 0.71,
      billCycleCount: 2,
      x_display: 2.1,
      dhat: 0.4167,
      br: 0.05,
      u: 2.1,
      mf: 0.3,
      L_read: 168000,
      L_cap: 960000,
      currentTurnSeq: 1,
      lastStopEvent: null,
      rentMeter: { depthActive: true, depthProgress: 0.42 },
    },
  };
  const out = formatLine(s);
  // v3 layout: 灯 bar %% ×N · ~Nt u · Δ L/b · model :port
  assert.ok(!out.includes("["), "no [tag] prefix");
  assert.ok(out.includes("🟢"), "sweet zone lamp");
  assert.ok(out.includes("42%"), "wallet phase percentage");
  assert.ok(!out.includes("71%"), "the sibling bill phase is not what the meter reads");
  assert.ok(out.includes("opus"), "model tag");
  assert.ok(!out.includes(":38017"), "port not in formatLine");
  assert.ok(out.includes("L168k"), "L value");
  assert.ok(out.includes("b80k"), "baseline value");
  assert.ok(!out.includes("\n"), "single line (no alert)");
});

test("A2: an amber br on the right arm shows 🟡 in v3 layout", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    L: 512000,
    B: 55000,
    rateLamp: {
      reliable: true,
      billProgress: 0.31,
      billCycleCount: 5,
      x_display: 9.3,
      dhat: 0.4,
      br: 0.15,
      u: 9.3,
      mf: 0.3,
      L_read: 512000,
      L_cap: 960000,
      currentTurnSeq: 1,
      rentMeter: { depthActive: true, depthProgress: 0.88 },
    },
  };
  const out = formatLine(s);
  assert.ok(out.includes("🟡"), "amber lamp");
  assert.ok(out.includes("88%"), "wallet phase percentage");
  assert.ok(!out.includes("31%"), "the sibling bill phase is not what the meter reads");
  assert.ok(out.includes("L512k"), "L value");
  assert.ok(out.includes("b55k"), "baseline value");
});

// An inactive rentMeter is the degraded frame: the merge found no matching ledger, so the wallet clock has
// no phase to show. The bill clock still has one, and the line holds the bar empty and blanks the percent
// slot rather than standing that sibling in.
test("A2: an inactive rentMeter blanks the percent slot instead of showing the bill clock", () => {
  _resetRenderState();
  const s = {
    model: "claude-opus-4-8",
    L: 168000,
    bDefault: 80000,
    rateLamp: {
      reliable: true,
      br: 0.05,
      u: 2.1,
      mf: 0.3,
      billProgress: 0.71,
      rentMeter: {
        cycleProgress: 0.71,
        depthActive: false,
        depthProgress: 0,
        backstopInterval: null,
        backstopLapCount: 0,
        depthHot: false,
      },
    },
  };
  const out = formatLine(s);
  assert.ok(out.includes("░░░░░░░░░░--%"), "the bar is held empty and the percent slot blanked");
  assert.ok(!out.includes("71%"), "the bill phase never stands in for the absent wallet phase");
});

test("A2: alert on the hook turn renders on second line (no verdict word)", () => {
  _resetRenderState();
  const s = {
    model: "opus",
    port: 38017,
    L: 512000,
    rateLamp: {
      reliable: true,
      billProgress: 0.5,
      billCycleCount: 1,
      x_display: 9,
      dhat: 0.4,
      L_read: 512000,
      L_cap: 960000,
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
    L: 168000,
    rateLamp: {
      reliable: true,
      billProgress: 0.42,
      billCycleCount: 2,
      x_display: 2.1,
      dhat: 0.4,
      L_read: 168000,
      L_cap: 960000,
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

test("formatLine uses s.bDefault for L/b display (§3.1 position basis)", () => {
  _resetRenderState();
  const s = {
    model: "claude-opus-4-8",
    L: 168000,
    B: 80000,
    bDefault: 50000,
    rateLamp: {
      reliable: true,
      billProgress: 0.42,
      br: 0.05,
      x_display: 2.1,
      dhat: 0.4167,
      xSweet: 1.4167,
      xBrAmberL: 1.05,
      mf: 0.3,
      gEma: 3000,
      lastStopEvent: null,
    },
  };
  const out = formatLine(s);
  assert.ok(out.includes("b50k"), "statusline shows bDefault (50k), not B (80k)");
  assert.ok(!out.includes("b80k"), "B_full (80k) must not appear when bDefault is set");
});
