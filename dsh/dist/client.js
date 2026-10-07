window.__ModuleLoader__.load({ id: "@nomadop/session-watcher-dsh", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to2, from2, except, desc) => {
  if (from2 && typeof from2 === "object" || typeof from2 === "function") {
    for (let key of __getOwnPropNames(from2))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// dsh/src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_react_dom = require("react-dom");

// dsh/src/client/locales.js
var NS = "session-watcher";
function stateText(result, t) {
  if (result === null) return t("state.bootstrapping");
  if (result.kind === "unreachable") return t("state.unreachable", { message: result.message });
  if (result.state === "failed") return t("state.failed", { message: result.diagnostic.message });
  return t(`state.${result.state}`);
}
function resultSignalState(result) {
  return result === null || result.state === "bootstrapping" ? "reading" : result.kind === "unreachable" ? "unreachable" : result.state;
}
var en = {
  "view.label": "Session Watcher",
  "state.unobserved": "Session Watcher is not observing this session.",
  "state.bootstrapping": "Session Watcher is reading this session\u2026",
  "state.failed": "Session Watcher could not measure this session: {message}",
  "state.unreachable": "Session Watcher cannot be reached: {message}",
  "signal.connecting": "connecting",
  "signal.live": "live",
  "signal.disconnected": "disconnected",
  "signal.reading": "reading",
  "signal.unobserved": "unobserved",
  "signal.failed": "failed",
  "signal.unreachable": "unreachable",
  "dock.label": "Session Watcher readings",
  "dock.pill": "Session Watcher: {summary}",
  "dock.separator": ", ",
  "dock.calibrating": "Calibrating",
  "dock.br": "Bill premium",
  "dock.clock": "Alert clock",
  "dock.clockIdle": "idle",
  "dock.laps": "Alert clock laps: {count}",
  "dock.armLeft": "Left arm: bill premium falls as the session continues",
  "dock.armRight": "Right arm: bill premium rises as the session continues",
  "dock.insufficientData": "Not enough data yet for a reliable reading.",
  // The zone words are the labels the dashboard's aux bar draws (`buildLabelsHTML` in public/elements/depthAux.js): shallow at its left end, sweet across the middle, deep from where red begins. Amber, the stretch just before red, is where the bar turns from sweet to deep.
  "dock.zone.white": "Shallow",
  "dock.zone.green": "Sweet",
  "dock.zone.amber": "Deepening",
  "dock.zone.red": "Deep",
  "dock.u": "Normalized position",
  "dock.sweet": "Sweet spot",
  "dock.stock": "Context stock",
  "dock.baseline": "Rebuild baseline",
  "dock.effective": "Effective context",
  "dock.growth": "Growth per call"
};
var zh = {
  "view.label": "Session Watcher",
  "state.unobserved": "Session Watcher \u672A\u5728\u89C2\u6D4B\u6B64\u4F1A\u8BDD\u3002",
  "state.bootstrapping": "Session Watcher \u6B63\u5728\u8BFB\u53D6\u6B64\u4F1A\u8BDD\u2026",
  "state.failed": "Session Watcher \u65E0\u6CD5\u6D4B\u91CF\u6B64\u4F1A\u8BDD\uFF1A{message}",
  "state.unreachable": "\u65E0\u6CD5\u8FDE\u63A5 Session Watcher\uFF1A{message}",
  "signal.connecting": "\u8FDE\u63A5\u4E2D",
  "signal.live": "\u5B9E\u65F6",
  "signal.disconnected": "\u5DF2\u65AD\u5F00",
  "signal.reading": "\u8BFB\u53D6\u4E2D",
  "signal.unobserved": "\u672A\u89C2\u6D4B",
  "signal.failed": "\u5931\u8D25",
  "signal.unreachable": "\u65E0\u6CD5\u8FDE\u63A5",
  "dock.label": "Session Watcher \u8BFB\u6570",
  "dock.pill": "Session Watcher\uFF1A{summary}",
  "dock.separator": "\uFF0C",
  "dock.calibrating": "\u6821\u51C6\u4E2D",
  "dock.br": "\u8D26\u5355\u6EA2\u4EF7",
  "dock.clock": "\u63D0\u9192\u65F6\u949F",
  "dock.clockIdle": "\u672A\u542F\u52A8",
  "dock.laps": "\u63D0\u9192\u65F6\u949F\u5708\u6570\uFF1A{count}",
  "dock.armLeft": "\u5DE6\u81C2\uFF1A\u8D26\u5355\u6EA2\u4EF7\u968F\u4F1A\u8BDD\u63A8\u8FDB\u800C\u4E0B\u964D",
  "dock.armRight": "\u53F3\u81C2\uFF1A\u8D26\u5355\u6EA2\u4EF7\u968F\u4F1A\u8BDD\u63A8\u8FDB\u800C\u4E0A\u5347",
  "dock.insufficientData": "\u6570\u636E\u5C1A\u4E0D\u8DB3\u4EE5\u5F62\u6210\u53EF\u9760\u8BFB\u6570\u3002",
  "dock.zone.white": "\u504F\u6D45",
  "dock.zone.green": "\u751C\u70B9\u533A",
  "dock.zone.amber": "\u6E10\u6DF1",
  "dock.zone.red": "\u504F\u6DF1",
  "dock.u": "\u5F52\u4E00\u5316\u4F4D\u7F6E",
  "dock.sweet": "\u751C\u70B9",
  "dock.stock": "\u4E0A\u4E0B\u6587\u5B58\u91CF",
  "dock.baseline": "\u91CD\u5EFA\u57FA\u7EBF",
  "dock.effective": "\u6709\u6548\u4E0A\u4E0B\u6587",
  "dock.growth": "\u6BCF\u6B21\u8C03\u7528\u589E\u957F"
};

// dsh/src/client/tab.js
var import_react = __toESM(require("react"), 1);

// dsh/src/client/context.js
var ENDPOINTS = {
  "GET /api/pricing": "pricing",
  "POST /api/pricing": "pricing/save",
  "DELETE /api/pricing": "pricing/delete",
  "POST /api/user-overrides": "user-overrides",
  "POST /api/preview": "preview",
  "GET /api/turn/browse": "turn/browse"
};
var FAILURE_STATUS = { invalid_body: 400, invalid_input: 400, no_model: 409, unknown_endpoint: 404 };
var response = (ok, status, body) => ({ ok, status, json: async () => body });
function createTabContext({ call, root }) {
  async function request(path, init = {}) {
    const method = init.method ?? "GET";
    const envelope = await call(ENDPOINTS[`${method} ${path}`], init.body === void 0 ? {} : JSON.parse(init.body));
    if (envelope.ok !== true) {
      const { code, message } = envelope.error;
      return response(false, FAILURE_STATUS[code], { error: code, message });
    }
    const { state, payload, diagnostic } = envelope.value;
    if (state !== "live") return response(false, 503, { error: state, message: diagnostic?.message ?? state });
    return response(true, 200, payload);
  }
  return { request, bus: new EventTarget(), charts: { hero: null, history: null }, overlayRoot: root };
}

// public/lib/pricingHelpers.js
function resolveActivePresetId(effectiveSource, savedPresetId) {
  return effectiveSource === "preset" && savedPresetId ? savedPresetId : null;
}
function isDriftedFromPreset(inputRead, inputWrite, preset) {
  if (!preset) return true;
  const r = parseFloat(inputRead);
  const w = parseFloat(inputWrite);
  return !Number.isFinite(r) || !Number.isFinite(w) || Math.abs(r - preset.readPrice) > 1e-9 || Math.abs(w - preset.writePrice) > 1e-9;
}

// public/elements/pricingChip.js
var STATE = {
  PRISTINE: "pristine",
  DIRTY: "dirty",
  SAVING: "saving",
  SAVED: "saved",
  ERROR: "error"
};
function mount(root, ctx) {
  const { transport } = ctx;
  const wrapper = document.createElement("div");
  wrapper.className = "sw-pricing-wrapper";
  const chip = document.createElement("button");
  chip.className = "sw-pricing-chip";
  chip.setAttribute("aria-expanded", "false");
  chip.setAttribute("aria-haspopup", "dialog");
  const gearSpan = document.createElement("span");
  gearSpan.textContent = "\u2699";
  gearSpan.setAttribute("aria-hidden", "true");
  const chipLabel = document.createElement("span");
  chipLabel.className = "sw-pricing-chip-label";
  chipLabel.textContent = "\u2026";
  chip.appendChild(gearSpan);
  chip.appendChild(chipLabel);
  const popover = document.createElement("div");
  popover.className = "sw-pricing-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Edit pricing");
  popover.innerHTML = `
    <div class="pp-h">Pricing <span>config \xB7 takes effect on Save</span></div>
    <div class="sw-pricing-preset-row">
      <label>Preset</label>
      <select class="sw-pricing-preset-select">
        <option value="">Custom</option>
      </select>
    </div>
    <div class="sw-pricing-prow">
      <div class="sw-pricing-pf">
        <label>Read / 1M</label>
        <div class="sw-pricing-ib">
          <span>$</span>
          <input class="sw-pricing-read" type="number" min="0" step="0.01" placeholder="0.30" />
        </div>
      </div>
      <div class="sw-pricing-pf">
        <label>Write / 1M</label>
        <div class="sw-pricing-ib">
          <span>$</span>
          <input class="sw-pricing-write" type="number" min="0" step="0.01" placeholder="3.00" />
        </div>
      </div>
    </div>
    <div class="sw-pricing-pmid">
      <span class="sw-pricing-ratio-span">read <b class="sw-pricing-ratio-val">\u2014</b> write</span>
      <span class="sw-pricing-source-span">source <b class="sw-pricing-source-val">\u2014</b></span>
    </div>
    <div class="sw-pricing-notice" style="display:none;">Changes not applied until saved</div>
    <div class="sw-pricing-error" style="display:none;"></div>
    <div class="sw-pricing-pfoot">
      <span class="sw-pricing-save-note">Reaches statusline &amp; decision</span>
      <button class="sw-pricing-reset" style="display:none;">Reset</button>
      <button class="sw-pricing-save">Save</button>
    </div>
  `;
  wrapper.appendChild(chip);
  wrapper.appendChild(popover);
  root.appendChild(wrapper);
  const readInput = popover.querySelector(".sw-pricing-read");
  const writeInput = popover.querySelector(".sw-pricing-write");
  const ratioDisplay = popover.querySelector(".sw-pricing-ratio-val");
  const sourceDisplay = popover.querySelector(".sw-pricing-source-val");
  const noticeEl = popover.querySelector(".sw-pricing-notice");
  const errorEl = popover.querySelector(".sw-pricing-error");
  const saveBtn = popover.querySelector(".sw-pricing-save");
  const resetBtn = popover.querySelector(".sw-pricing-reset");
  const presetSelect = popover.querySelector(".sw-pricing-preset-select");
  let popoverOpen = false;
  let formState = STATE.PRISTINE;
  let effectiveReadPrice = null;
  let effectiveWritePrice = null;
  let effectiveSource = null;
  let effectiveRatio = null;
  let presets = [];
  let activePresetId = null;
  function updateChipLabel() {
    if (effectiveRatio == null) {
      chipLabel.innerHTML = "\u2026";
      return;
    }
    const readToWrite = 1 / effectiveRatio;
    const ratioStr = readToWrite < 0.01 ? readToWrite.toFixed(3) : readToWrite < 0.1 ? readToWrite.toFixed(2) : readToWrite.toFixed(1);
    chipLabel.innerHTML = `read <b>${ratioStr}\xD7</b> write \xB7 ${sourceLabel()}`;
  }
  function computeInputRatio() {
    const r = parseFloat(readInput.value);
    const w = parseFloat(writeInput.value);
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(w) || w <= 0) return null;
    return w / r;
  }
  function updateRatioDisplay() {
    const ratio = computeInputRatio() ?? effectiveRatio;
    if (ratio == null || ratio === 0) {
      ratioDisplay.textContent = "\u2014";
    } else {
      const readToWrite = 1 / ratio;
      ratioDisplay.textContent = `${readToWrite < 0.01 ? readToWrite.toFixed(3) : readToWrite < 0.1 ? readToWrite.toFixed(2) : readToWrite.toFixed(1)}\xD7`;
    }
  }
  function inputsMatchEffective() {
    const r = parseFloat(readInput.value);
    const w = parseFloat(writeInput.value);
    if (effectiveReadPrice == null || effectiveWritePrice == null) {
      return !(Number.isFinite(r) && r > 0 && Number.isFinite(w) && w > 0);
    }
    if (!Number.isFinite(r) || !Number.isFinite(w)) return false;
    return Math.abs(r - effectiveReadPrice) < 1e-9 && Math.abs(w - effectiveWritePrice) < 1e-9;
  }
  function applyFormState(state) {
    formState = state;
    noticeEl.style.display = "none";
    errorEl.style.display = "none";
    errorEl.textContent = "";
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
    readInput.readOnly = false;
    writeInput.readOnly = false;
    readInput.style.opacity = "";
    writeInput.style.opacity = "";
    switch (state) {
      case STATE.PRISTINE:
        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.5";
        break;
      case STATE.DIRTY:
        saveBtn.disabled = false;
        saveBtn.style.opacity = "";
        noticeEl.style.display = "";
        break;
      case STATE.SAVING:
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving\u2026";
        saveBtn.style.opacity = "0.7";
        readInput.readOnly = true;
        writeInput.readOnly = true;
        readInput.style.opacity = "0.6";
        writeInput.style.opacity = "0.6";
        break;
      case STATE.SAVED:
        saveBtn.disabled = true;
        saveBtn.textContent = "\u2713 Saved";
        saveBtn.style.opacity = "0.7";
        break;
      case STATE.ERROR:
        saveBtn.disabled = false;
        saveBtn.style.opacity = "";
        errorEl.style.display = "";
        break;
    }
  }
  function onInputChange() {
    if (activePresetId) {
      const drifted = isDriftedFromPreset(readInput.value, writeInput.value, presets.find((p) => p.id === activePresetId));
      if (drifted) {
        activePresetId = null;
        presetSelect.value = "";
      }
    }
    updateRatioDisplay();
    if (formState === STATE.SAVING) return;
    applyFormState(inputsMatchEffective() ? STATE.PRISTINE : STATE.DIRTY);
  }
  function populateInputsFromEffective() {
    if (effectiveReadPrice != null) {
      readInput.value = effectiveReadPrice.toFixed(4);
    } else {
      readInput.value = "";
    }
    if (effectiveWritePrice != null) {
      writeInput.value = effectiveWritePrice.toFixed(4);
    } else {
      writeInput.value = "";
    }
    sourceDisplay.textContent = sourceLabel();
    updateRatioDisplay();
  }
  function openPopover() {
    if (popoverOpen) return;
    popoverOpen = true;
    populateInputsFromEffective();
    applyFormState(STATE.PRISTINE);
    popover.style.display = "block";
    chip.setAttribute("aria-expanded", "true");
  }
  function closePopover() {
    if (!popoverOpen) return;
    popoverOpen = false;
    popover.style.display = "none";
    chip.setAttribute("aria-expanded", "false");
    errorEl.style.display = "none";
    errorEl.textContent = "";
    noticeEl.style.display = "none";
  }
  function onDocumentClick(e) {
    if (!popoverOpen) return;
    if (!wrapper.contains(e.target)) {
      closePopover();
    }
  }
  document.addEventListener("click", onDocumentClick, true);
  async function doSave() {
    const readPrice = parseFloat(readInput.value);
    const writePrice = parseFloat(writeInput.value);
    if (!Number.isFinite(readPrice) || readPrice <= 0 || !Number.isFinite(writePrice) || writePrice <= 0) {
      applyFormState(STATE.ERROR);
      errorEl.textContent = "Enter valid positive prices.";
      return;
    }
    applyFormState(STATE.SAVING);
    try {
      const res = await ctx.request("/api/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readPrice, writePrice, presetId: activePresetId })
      });
      if (res.ok) {
        const data = await res.json();
        applyPricingData(data);
        updateChipLabel();
        applyFormState(STATE.SAVED);
        transport.refresh();
        setTimeout(() => {
          if (formState === STATE.SAVED) {
            populateInputsFromEffective();
            applyFormState(STATE.PRISTINE);
          }
        }, 1200);
      } else {
        const data = await res.json().catch(() => ({}));
        applyFormState(STATE.ERROR);
        errorEl.textContent = data.message || "Save failed. Please try again.";
      }
    } catch (err) {
      applyFormState(STATE.ERROR);
      errorEl.textContent = "Network error. Please try again.";
    }
  }
  async function doReset() {
    resetBtn.disabled = true;
    resetBtn.textContent = "Resetting\u2026";
    try {
      const res = await ctx.request("/api/pricing", { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        applyPricingData(data);
        updateChipLabel();
        populateInputsFromEffective();
        applyFormState(STATE.PRISTINE);
        transport.refresh();
      }
    } catch (err) {
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = "Reset";
    }
  }
  let modelName = null;
  function populatePresetOptions() {
    presetSelect.innerHTML = '<option value="">Custom</option>';
    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      presetSelect.appendChild(opt);
    }
  }
  function applyPricingData(data) {
    const eff = data?.effective;
    if (!eff) return;
    effectiveReadPrice = eff.readPrice ?? null;
    effectiveWritePrice = eff.writePrice ?? null;
    effectiveSource = eff.source ?? null;
    effectiveRatio = eff.ratio ?? null;
    if (data.modelDefault?.model) modelName = data.modelDefault.model;
    if (Array.isArray(data.presets)) {
      presets = data.presets;
      populatePresetOptions();
    }
    activePresetId = resolveActivePresetId(effectiveSource, data.saved?.presetId);
    presetSelect.value = activePresetId || "";
    resetBtn.style.display = effectiveSource === "saved" || effectiveSource === "preset" ? "" : "none";
  }
  function sourceLabel() {
    if (effectiveSource === "model_default" && modelName) return modelName;
    return (effectiveSource || "\u2014").replace(/_/g, " ");
  }
  async function loadInitialPricing() {
    try {
      const res = await ctx.request("/api/pricing");
      if (res.ok) {
        const data = await res.json();
        applyPricingData(data);
        updateChipLabel();
        if (popoverOpen) populateInputsFromEffective();
      }
    } catch {
      chipLabel.textContent = "pricing unavailable";
    }
  }
  chip.addEventListener("click", () => {
    if (popoverOpen) closePopover();
    else openPopover();
  });
  readInput.addEventListener("input", onInputChange);
  writeInput.addEventListener("input", onInputChange);
  presetSelect.addEventListener("change", () => {
    const selectedId = presetSelect.value;
    if (!selectedId) {
      activePresetId = null;
      return;
    }
    const preset = presets.find((p) => p.id === selectedId);
    if (preset) {
      activePresetId = selectedId;
      readInput.value = preset.readPrice.toFixed(4);
      writeInput.value = preset.writePrice.toFixed(4);
      onInputChange();
    }
  });
  saveBtn.addEventListener("click", doSave);
  resetBtn.addEventListener("click", doReset);
  loadInitialPricing();
  function update(_snapshot) {
  }
  function destroy() {
    document.removeEventListener("click", onDocumentClick, true);
    wrapper.remove();
  }
  return { update, destroy };
}

// node_modules/@kurkle/color/dist/color.esm.js
function round(v) {
  return v + 0.5 | 0;
}
var lim = (v, l, h4) => Math.max(Math.min(v, h4), l);
function p2b(v) {
  return lim(round(v * 2.55), 0, 255);
}
function n2b(v) {
  return lim(round(v * 255), 0, 255);
}
function b2n(v) {
  return lim(round(v / 2.55) / 100, 0, 1);
}
function n2p(v) {
  return lim(round(v * 100), 0, 100);
}
var map$1 = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, a: 10, b: 11, c: 12, d: 13, e: 14, f: 15 };
var hex = [..."0123456789ABCDEF"];
var h1 = (b) => hex[b & 15];
var h2 = (b) => hex[(b & 240) >> 4] + hex[b & 15];
var eq = (b) => (b & 240) >> 4 === (b & 15);
var isShort = (v) => eq(v.r) && eq(v.g) && eq(v.b) && eq(v.a);
function hexParse(str) {
  var len = str.length;
  var ret;
  if (str[0] === "#") {
    if (len === 4 || len === 5) {
      ret = {
        r: 255 & map$1[str[1]] * 17,
        g: 255 & map$1[str[2]] * 17,
        b: 255 & map$1[str[3]] * 17,
        a: len === 5 ? map$1[str[4]] * 17 : 255
      };
    } else if (len === 7 || len === 9) {
      ret = {
        r: map$1[str[1]] << 4 | map$1[str[2]],
        g: map$1[str[3]] << 4 | map$1[str[4]],
        b: map$1[str[5]] << 4 | map$1[str[6]],
        a: len === 9 ? map$1[str[7]] << 4 | map$1[str[8]] : 255
      };
    }
  }
  return ret;
}
var alpha = (a, f) => a < 255 ? f(a) : "";
function hexString(v) {
  var f = isShort(v) ? h1 : h2;
  return v ? "#" + f(v.r) + f(v.g) + f(v.b) + alpha(v.a, f) : void 0;
}
var HUE_RE = /^(hsla?|hwb|hsv)\(\s*([-+.e\d]+)(?:deg)?[\s,]+([-+.e\d]+)%[\s,]+([-+.e\d]+)%(?:[\s,]+([-+.e\d]+)(%)?)?\s*\)$/;
function hsl2rgbn(h4, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n, k = (n + h4 / 30) % 12) => l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  return [f(0), f(8), f(4)];
}
function hsv2rgbn(h4, s, v) {
  const f = (n, k = (n + h4 / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return [f(5), f(3), f(1)];
}
function hwb2rgbn(h4, w, b) {
  const rgb = hsl2rgbn(h4, 1, 0.5);
  let i;
  if (w + b > 1) {
    i = 1 / (w + b);
    w *= i;
    b *= i;
  }
  for (i = 0; i < 3; i++) {
    rgb[i] *= 1 - w - b;
    rgb[i] += w;
  }
  return rgb;
}
function hueValue(r, g, b, d, max) {
  if (r === max) {
    return (g - b) / d + (g < b ? 6 : 0);
  }
  if (g === max) {
    return (b - r) / d + 2;
  }
  return (r - g) / d + 4;
}
function rgb2hsl(v) {
  const range = 255;
  const r = v.r / range;
  const g = v.g / range;
  const b = v.b / range;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h4, s, d;
  if (max !== min) {
    d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h4 = hueValue(r, g, b, d, max);
    h4 = h4 * 60 + 0.5;
  }
  return [h4 | 0, s || 0, l];
}
function calln(f, a, b, c) {
  return (Array.isArray(a) ? f(a[0], a[1], a[2]) : f(a, b, c)).map(n2b);
}
function hsl2rgb(h4, s, l) {
  return calln(hsl2rgbn, h4, s, l);
}
function hwb2rgb(h4, w, b) {
  return calln(hwb2rgbn, h4, w, b);
}
function hsv2rgb(h4, s, v) {
  return calln(hsv2rgbn, h4, s, v);
}
function hue(h4) {
  return (h4 % 360 + 360) % 360;
}
function hueParse(str) {
  const m = HUE_RE.exec(str);
  let a = 255;
  let v;
  if (!m) {
    return;
  }
  if (m[5] !== v) {
    a = m[6] ? p2b(+m[5]) : n2b(+m[5]);
  }
  const h4 = hue(+m[2]);
  const p1 = +m[3] / 100;
  const p2 = +m[4] / 100;
  if (m[1] === "hwb") {
    v = hwb2rgb(h4, p1, p2);
  } else if (m[1] === "hsv") {
    v = hsv2rgb(h4, p1, p2);
  } else {
    v = hsl2rgb(h4, p1, p2);
  }
  return {
    r: v[0],
    g: v[1],
    b: v[2],
    a
  };
}
function rotate(v, deg) {
  var h4 = rgb2hsl(v);
  h4[0] = hue(h4[0] + deg);
  h4 = hsl2rgb(h4);
  v.r = h4[0];
  v.g = h4[1];
  v.b = h4[2];
}
function hslString(v) {
  if (!v) {
    return;
  }
  const a = rgb2hsl(v);
  const h4 = a[0];
  const s = n2p(a[1]);
  const l = n2p(a[2]);
  return v.a < 255 ? `hsla(${h4}, ${s}%, ${l}%, ${b2n(v.a)})` : `hsl(${h4}, ${s}%, ${l}%)`;
}
var map = {
  x: "dark",
  Z: "light",
  Y: "re",
  X: "blu",
  W: "gr",
  V: "medium",
  U: "slate",
  A: "ee",
  T: "ol",
  S: "or",
  B: "ra",
  C: "lateg",
  D: "ights",
  R: "in",
  Q: "turquois",
  E: "hi",
  P: "ro",
  O: "al",
  N: "le",
  M: "de",
  L: "yello",
  F: "en",
  K: "ch",
  G: "arks",
  H: "ea",
  I: "ightg",
  J: "wh"
};
var names$1 = {
  OiceXe: "f0f8ff",
  antiquewEte: "faebd7",
  aqua: "ffff",
  aquamarRe: "7fffd4",
  azuY: "f0ffff",
  beige: "f5f5dc",
  bisque: "ffe4c4",
  black: "0",
  blanKedOmond: "ffebcd",
  Xe: "ff",
  XeviTet: "8a2be2",
  bPwn: "a52a2a",
  burlywood: "deb887",
  caMtXe: "5f9ea0",
  KartYuse: "7fff00",
  KocTate: "d2691e",
  cSO: "ff7f50",
  cSnflowerXe: "6495ed",
  cSnsilk: "fff8dc",
  crimson: "dc143c",
  cyan: "ffff",
  xXe: "8b",
  xcyan: "8b8b",
  xgTMnPd: "b8860b",
  xWay: "a9a9a9",
  xgYF: "6400",
  xgYy: "a9a9a9",
  xkhaki: "bdb76b",
  xmagFta: "8b008b",
  xTivegYF: "556b2f",
  xSange: "ff8c00",
  xScEd: "9932cc",
  xYd: "8b0000",
  xsOmon: "e9967a",
  xsHgYF: "8fbc8f",
  xUXe: "483d8b",
  xUWay: "2f4f4f",
  xUgYy: "2f4f4f",
  xQe: "ced1",
  xviTet: "9400d3",
  dAppRk: "ff1493",
  dApskyXe: "bfff",
  dimWay: "696969",
  dimgYy: "696969",
  dodgerXe: "1e90ff",
  fiYbrick: "b22222",
  flSOwEte: "fffaf0",
  foYstWAn: "228b22",
  fuKsia: "ff00ff",
  gaRsbSo: "dcdcdc",
  ghostwEte: "f8f8ff",
  gTd: "ffd700",
  gTMnPd: "daa520",
  Way: "808080",
  gYF: "8000",
  gYFLw: "adff2f",
  gYy: "808080",
  honeyMw: "f0fff0",
  hotpRk: "ff69b4",
  RdianYd: "cd5c5c",
  Rdigo: "4b0082",
  ivSy: "fffff0",
  khaki: "f0e68c",
  lavFMr: "e6e6fa",
  lavFMrXsh: "fff0f5",
  lawngYF: "7cfc00",
  NmoncEffon: "fffacd",
  ZXe: "add8e6",
  ZcSO: "f08080",
  Zcyan: "e0ffff",
  ZgTMnPdLw: "fafad2",
  ZWay: "d3d3d3",
  ZgYF: "90ee90",
  ZgYy: "d3d3d3",
  ZpRk: "ffb6c1",
  ZsOmon: "ffa07a",
  ZsHgYF: "20b2aa",
  ZskyXe: "87cefa",
  ZUWay: "778899",
  ZUgYy: "778899",
  ZstAlXe: "b0c4de",
  ZLw: "ffffe0",
  lime: "ff00",
  limegYF: "32cd32",
  lRF: "faf0e6",
  magFta: "ff00ff",
  maPon: "800000",
  VaquamarRe: "66cdaa",
  VXe: "cd",
  VScEd: "ba55d3",
  VpurpN: "9370db",
  VsHgYF: "3cb371",
  VUXe: "7b68ee",
  VsprRggYF: "fa9a",
  VQe: "48d1cc",
  VviTetYd: "c71585",
  midnightXe: "191970",
  mRtcYam: "f5fffa",
  mistyPse: "ffe4e1",
  moccasR: "ffe4b5",
  navajowEte: "ffdead",
  navy: "80",
  Tdlace: "fdf5e6",
  Tive: "808000",
  TivedBb: "6b8e23",
  Sange: "ffa500",
  SangeYd: "ff4500",
  ScEd: "da70d6",
  pOegTMnPd: "eee8aa",
  pOegYF: "98fb98",
  pOeQe: "afeeee",
  pOeviTetYd: "db7093",
  papayawEp: "ffefd5",
  pHKpuff: "ffdab9",
  peru: "cd853f",
  pRk: "ffc0cb",
  plum: "dda0dd",
  powMrXe: "b0e0e6",
  purpN: "800080",
  YbeccapurpN: "663399",
  Yd: "ff0000",
  Psybrown: "bc8f8f",
  PyOXe: "4169e1",
  saddNbPwn: "8b4513",
  sOmon: "fa8072",
  sandybPwn: "f4a460",
  sHgYF: "2e8b57",
  sHshell: "fff5ee",
  siFna: "a0522d",
  silver: "c0c0c0",
  skyXe: "87ceeb",
  UXe: "6a5acd",
  UWay: "708090",
  UgYy: "708090",
  snow: "fffafa",
  sprRggYF: "ff7f",
  stAlXe: "4682b4",
  tan: "d2b48c",
  teO: "8080",
  tEstN: "d8bfd8",
  tomato: "ff6347",
  Qe: "40e0d0",
  viTet: "ee82ee",
  JHt: "f5deb3",
  wEte: "ffffff",
  wEtesmoke: "f5f5f5",
  Lw: "ffff00",
  LwgYF: "9acd32"
};
function unpack() {
  const unpacked = {};
  const keys = Object.keys(names$1);
  const tkeys = Object.keys(map);
  let i, j, k, ok, nk;
  for (i = 0; i < keys.length; i++) {
    ok = nk = keys[i];
    for (j = 0; j < tkeys.length; j++) {
      k = tkeys[j];
      nk = nk.replace(k, map[k]);
    }
    k = parseInt(names$1[ok], 16);
    unpacked[nk] = [k >> 16 & 255, k >> 8 & 255, k & 255];
  }
  return unpacked;
}
var names;
function nameParse(str) {
  if (!names) {
    names = unpack();
    names.transparent = [0, 0, 0, 0];
  }
  const a = names[str.toLowerCase()];
  return a && {
    r: a[0],
    g: a[1],
    b: a[2],
    a: a.length === 4 ? a[3] : 255
  };
}
var RGB_RE = /^rgba?\(\s*([-+.\d]+)(%)?[\s,]+([-+.e\d]+)(%)?[\s,]+([-+.e\d]+)(%)?(?:[\s,/]+([-+.e\d]+)(%)?)?\s*\)$/;
function rgbParse(str) {
  const m = RGB_RE.exec(str);
  let a = 255;
  let r, g, b;
  if (!m) {
    return;
  }
  if (m[7] !== r) {
    const v = +m[7];
    a = m[8] ? p2b(v) : lim(v * 255, 0, 255);
  }
  r = +m[1];
  g = +m[3];
  b = +m[5];
  r = 255 & (m[2] ? p2b(r) : lim(r, 0, 255));
  g = 255 & (m[4] ? p2b(g) : lim(g, 0, 255));
  b = 255 & (m[6] ? p2b(b) : lim(b, 0, 255));
  return {
    r,
    g,
    b,
    a
  };
}
function rgbString(v) {
  return v && (v.a < 255 ? `rgba(${v.r}, ${v.g}, ${v.b}, ${b2n(v.a)})` : `rgb(${v.r}, ${v.g}, ${v.b})`);
}
var to = (v) => v <= 31308e-7 ? v * 12.92 : Math.pow(v, 1 / 2.4) * 1.055 - 0.055;
var from = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
function interpolate(rgb1, rgb2, t) {
  const r = from(b2n(rgb1.r));
  const g = from(b2n(rgb1.g));
  const b = from(b2n(rgb1.b));
  return {
    r: n2b(to(r + t * (from(b2n(rgb2.r)) - r))),
    g: n2b(to(g + t * (from(b2n(rgb2.g)) - g))),
    b: n2b(to(b + t * (from(b2n(rgb2.b)) - b))),
    a: rgb1.a + t * (rgb2.a - rgb1.a)
  };
}
function modHSL(v, i, ratio) {
  if (v) {
    let tmp = rgb2hsl(v);
    tmp[i] = Math.max(0, Math.min(tmp[i] + tmp[i] * ratio, i === 0 ? 360 : 1));
    tmp = hsl2rgb(tmp);
    v.r = tmp[0];
    v.g = tmp[1];
    v.b = tmp[2];
  }
}
function clone(v, proto) {
  return v ? Object.assign(proto || {}, v) : v;
}
function fromObject(input) {
  var v = { r: 0, g: 0, b: 0, a: 255 };
  if (Array.isArray(input)) {
    if (input.length >= 3) {
      v = { r: input[0], g: input[1], b: input[2], a: 255 };
      if (input.length > 3) {
        v.a = n2b(input[3]);
      }
    }
  } else {
    v = clone(input, { r: 0, g: 0, b: 0, a: 1 });
    v.a = n2b(v.a);
  }
  return v;
}
function functionParse(str) {
  if (str.charAt(0) === "r") {
    return rgbParse(str);
  }
  return hueParse(str);
}
var Color = class _Color {
  constructor(input) {
    if (input instanceof _Color) {
      return input;
    }
    const type = typeof input;
    let v;
    if (type === "object") {
      v = fromObject(input);
    } else if (type === "string") {
      v = hexParse(input) || nameParse(input) || functionParse(input);
    }
    this._rgb = v;
    this._valid = !!v;
  }
  get valid() {
    return this._valid;
  }
  get rgb() {
    var v = clone(this._rgb);
    if (v) {
      v.a = b2n(v.a);
    }
    return v;
  }
  set rgb(obj) {
    this._rgb = fromObject(obj);
  }
  rgbString() {
    return this._valid ? rgbString(this._rgb) : void 0;
  }
  hexString() {
    return this._valid ? hexString(this._rgb) : void 0;
  }
  hslString() {
    return this._valid ? hslString(this._rgb) : void 0;
  }
  mix(color2, weight) {
    if (color2) {
      const c1 = this.rgb;
      const c2 = color2.rgb;
      let w2;
      const p = weight === w2 ? 0.5 : weight;
      const w = 2 * p - 1;
      const a = c1.a - c2.a;
      const w1 = ((w * a === -1 ? w : (w + a) / (1 + w * a)) + 1) / 2;
      w2 = 1 - w1;
      c1.r = 255 & w1 * c1.r + w2 * c2.r + 0.5;
      c1.g = 255 & w1 * c1.g + w2 * c2.g + 0.5;
      c1.b = 255 & w1 * c1.b + w2 * c2.b + 0.5;
      c1.a = p * c1.a + (1 - p) * c2.a;
      this.rgb = c1;
    }
    return this;
  }
  interpolate(color2, t) {
    if (color2) {
      this._rgb = interpolate(this._rgb, color2._rgb, t);
    }
    return this;
  }
  clone() {
    return new _Color(this.rgb);
  }
  alpha(a) {
    this._rgb.a = n2b(a);
    return this;
  }
  clearer(ratio) {
    const rgb = this._rgb;
    rgb.a *= 1 - ratio;
    return this;
  }
  greyscale() {
    const rgb = this._rgb;
    const val = round(rgb.r * 0.3 + rgb.g * 0.59 + rgb.b * 0.11);
    rgb.r = rgb.g = rgb.b = val;
    return this;
  }
  opaquer(ratio) {
    const rgb = this._rgb;
    rgb.a *= 1 + ratio;
    return this;
  }
  negate() {
    const v = this._rgb;
    v.r = 255 - v.r;
    v.g = 255 - v.g;
    v.b = 255 - v.b;
    return this;
  }
  lighten(ratio) {
    modHSL(this._rgb, 2, ratio);
    return this;
  }
  darken(ratio) {
    modHSL(this._rgb, 2, -ratio);
    return this;
  }
  saturate(ratio) {
    modHSL(this._rgb, 1, ratio);
    return this;
  }
  desaturate(ratio) {
    modHSL(this._rgb, 1, -ratio);
    return this;
  }
  rotate(deg) {
    rotate(this._rgb, deg);
    return this;
  }
};

// node_modules/chart.js/dist/chunks/helpers.dataset.js
function noop() {
}
var uid = /* @__PURE__ */ (() => {
  let id = 0;
  return () => id++;
})();
function isNullOrUndef(value) {
  return value === null || value === void 0;
}
function isArray(value) {
  if (Array.isArray && Array.isArray(value)) {
    return true;
  }
  const type = Object.prototype.toString.call(value);
  if (type.slice(0, 7) === "[object" && type.slice(-6) === "Array]") {
    return true;
  }
  return false;
}
function isObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}
function isNumberFinite(value) {
  return (typeof value === "number" || value instanceof Number) && isFinite(+value);
}
function finiteOrDefault(value, defaultValue) {
  return isNumberFinite(value) ? value : defaultValue;
}
function valueOrDefault(value, defaultValue) {
  return typeof value === "undefined" ? defaultValue : value;
}
var toPercentage = (value, dimension) => typeof value === "string" && value.endsWith("%") ? parseFloat(value) / 100 : +value / dimension;
var toDimension = (value, dimension) => typeof value === "string" && value.endsWith("%") ? parseFloat(value) / 100 * dimension : +value;
function callback(fn, args, thisArg) {
  if (fn && typeof fn.call === "function") {
    return fn.apply(thisArg, args);
  }
}
function each(loopable, fn, thisArg, reverse) {
  let i, len, keys;
  if (isArray(loopable)) {
    len = loopable.length;
    if (reverse) {
      for (i = len - 1; i >= 0; i--) {
        fn.call(thisArg, loopable[i], i);
      }
    } else {
      for (i = 0; i < len; i++) {
        fn.call(thisArg, loopable[i], i);
      }
    }
  } else if (isObject(loopable)) {
    keys = Object.keys(loopable);
    len = keys.length;
    for (i = 0; i < len; i++) {
      fn.call(thisArg, loopable[keys[i]], keys[i]);
    }
  }
}
function _elementsEqual(a0, a1) {
  let i, ilen, v0, v1;
  if (!a0 || !a1 || a0.length !== a1.length) {
    return false;
  }
  for (i = 0, ilen = a0.length; i < ilen; ++i) {
    v0 = a0[i];
    v1 = a1[i];
    if (v0.datasetIndex !== v1.datasetIndex || v0.index !== v1.index) {
      return false;
    }
  }
  return true;
}
function clone2(source) {
  if (isArray(source)) {
    return source.map(clone2);
  }
  if (isObject(source)) {
    const target = /* @__PURE__ */ Object.create(null);
    const keys = Object.keys(source);
    const klen = keys.length;
    let k = 0;
    for (; k < klen; ++k) {
      target[keys[k]] = clone2(source[keys[k]]);
    }
    return target;
  }
  return source;
}
function isValidKey(key) {
  return [
    "__proto__",
    "prototype",
    "constructor"
  ].indexOf(key) === -1;
}
function _merger(key, target, source, options) {
  if (!isValidKey(key)) {
    return;
  }
  const tval = target[key];
  const sval = source[key];
  if (isObject(tval) && isObject(sval)) {
    merge(tval, sval, options);
  } else {
    target[key] = clone2(sval);
  }
}
function merge(target, source, options) {
  const sources = isArray(source) ? source : [
    source
  ];
  const ilen = sources.length;
  if (!isObject(target)) {
    return target;
  }
  options = options || {};
  const merger = options.merger || _merger;
  let current;
  for (let i = 0; i < ilen; ++i) {
    current = sources[i];
    if (!isObject(current)) {
      continue;
    }
    const keys = Object.keys(current);
    for (let k = 0, klen = keys.length; k < klen; ++k) {
      merger(keys[k], target, current, options);
    }
  }
  return target;
}
function mergeIf(target, source) {
  return merge(target, source, {
    merger: _mergerIf
  });
}
function _mergerIf(key, target, source) {
  if (!isValidKey(key)) {
    return;
  }
  const tval = target[key];
  const sval = source[key];
  if (isObject(tval) && isObject(sval)) {
    mergeIf(tval, sval);
  } else if (!Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = clone2(sval);
  }
}
var keyResolvers = {
  // Chart.helpers.core resolveObjectKey should resolve empty key to root object
  "": (v) => v,
  // default resolvers
  x: (o) => o.x,
  y: (o) => o.y
};
function _splitKey(key) {
  const parts = key.split(".");
  const keys = [];
  let tmp = "";
  for (const part of parts) {
    tmp += part;
    if (tmp.endsWith("\\")) {
      tmp = tmp.slice(0, -1) + ".";
    } else {
      keys.push(tmp);
      tmp = "";
    }
  }
  return keys;
}
function _getKeyResolver(key) {
  const keys = _splitKey(key);
  return (obj) => {
    for (const k of keys) {
      if (k === "") {
        break;
      }
      obj = obj && obj[k];
    }
    return obj;
  };
}
function resolveObjectKey(obj, key) {
  const resolver = keyResolvers[key] || (keyResolvers[key] = _getKeyResolver(key));
  return resolver(obj);
}
function _capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
var defined = (value) => typeof value !== "undefined";
var isFunction = (value) => typeof value === "function";
var setsEqual = (a, b) => {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
};
function _isClickEvent(e) {
  return e.type === "mouseup" || e.type === "click" || e.type === "contextmenu";
}
var PI = Math.PI;
var TAU = 2 * PI;
var PITAU = TAU + PI;
var INFINITY = Number.POSITIVE_INFINITY;
var RAD_PER_DEG = PI / 180;
var HALF_PI = PI / 2;
var QUARTER_PI = PI / 4;
var TWO_THIRDS_PI = PI * 2 / 3;
var log10 = Math.log10;
var sign = Math.sign;
function almostEquals(x, y, epsilon) {
  return Math.abs(x - y) < epsilon;
}
function niceNum(range) {
  const roundedRange = Math.round(range);
  range = almostEquals(range, roundedRange, range / 1e3) ? roundedRange : range;
  const niceRange = Math.pow(10, Math.floor(log10(range)));
  const fraction = range / niceRange;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * niceRange;
}
function _factorize(value) {
  const result = [];
  const sqrt = Math.sqrt(value);
  let i;
  for (i = 1; i < sqrt; i++) {
    if (value % i === 0) {
      result.push(i);
      result.push(value / i);
    }
  }
  if (sqrt === (sqrt | 0)) {
    result.push(sqrt);
  }
  result.sort((a, b) => a - b).pop();
  return result;
}
function isNonPrimitive(n) {
  return typeof n === "symbol" || typeof n === "object" && n !== null && !(Symbol.toPrimitive in n || "toString" in n || "valueOf" in n);
}
function isNumber(n) {
  return !isNonPrimitive(n) && !isNaN(parseFloat(n)) && isFinite(n);
}
function almostWhole(x, epsilon) {
  const rounded = Math.round(x);
  return rounded - epsilon <= x && rounded + epsilon >= x;
}
function _setMinAndMaxByKey(array, target, property) {
  let i, ilen, value;
  for (i = 0, ilen = array.length; i < ilen; i++) {
    value = array[i][property];
    if (!isNaN(value)) {
      target.min = Math.min(target.min, value);
      target.max = Math.max(target.max, value);
    }
  }
}
function toRadians(degrees) {
  return degrees * (PI / 180);
}
function toDegrees(radians) {
  return radians * (180 / PI);
}
function _decimalPlaces(x) {
  if (!isNumberFinite(x)) {
    return;
  }
  let e = 1;
  let p = 0;
  while (Math.round(x * e) / e !== x) {
    e *= 10;
    p++;
  }
  return p;
}
function getAngleFromPoint(centrePoint, anglePoint) {
  const distanceFromXCenter = anglePoint.x - centrePoint.x;
  const distanceFromYCenter = anglePoint.y - centrePoint.y;
  const radialDistanceFromCenter = Math.sqrt(distanceFromXCenter * distanceFromXCenter + distanceFromYCenter * distanceFromYCenter);
  let angle = Math.atan2(distanceFromYCenter, distanceFromXCenter);
  if (angle < -0.5 * PI) {
    angle += TAU;
  }
  return {
    angle,
    distance: radialDistanceFromCenter
  };
}
function distanceBetweenPoints(pt1, pt2) {
  return Math.sqrt(Math.pow(pt2.x - pt1.x, 2) + Math.pow(pt2.y - pt1.y, 2));
}
function _angleDiff(a, b) {
  return (a - b + PITAU) % TAU - PI;
}
function _normalizeAngle(a) {
  return (a % TAU + TAU) % TAU;
}
function _angleBetween(angle, start, end, sameAngleIsFullCircle) {
  const a = _normalizeAngle(angle);
  const s = _normalizeAngle(start);
  const e = _normalizeAngle(end);
  const angleToStart = _normalizeAngle(s - a);
  const angleToEnd = _normalizeAngle(e - a);
  const startToAngle = _normalizeAngle(a - s);
  const endToAngle = _normalizeAngle(a - e);
  return a === s || a === e || sameAngleIsFullCircle && s === e || angleToStart > angleToEnd && startToAngle < endToAngle;
}
function _limitValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function _int16Range(value) {
  return _limitValue(value, -32768, 32767);
}
function _isBetween(value, start, end, epsilon = 1e-6) {
  return value >= Math.min(start, end) - epsilon && value <= Math.max(start, end) + epsilon;
}
function _lookup(table, value, cmp) {
  cmp = cmp || ((index2) => table[index2] < value);
  let hi = table.length - 1;
  let lo = 0;
  let mid;
  while (hi - lo > 1) {
    mid = lo + hi >> 1;
    if (cmp(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return {
    lo,
    hi
  };
}
var _lookupByKey = (table, key, value, last) => _lookup(table, value, last ? (index2) => {
  const ti = table[index2][key];
  return ti < value || ti === value && table[index2 + 1][key] === value;
} : (index2) => table[index2][key] < value);
var _rlookupByKey = (table, key, value) => _lookup(table, value, (index2) => table[index2][key] >= value);
function _filterBetween(values, min, max) {
  let start = 0;
  let end = values.length;
  while (start < end && values[start] < min) {
    start++;
  }
  while (end > start && values[end - 1] > max) {
    end--;
  }
  return start > 0 || end < values.length ? values.slice(start, end) : values;
}
var arrayEvents = [
  "push",
  "pop",
  "shift",
  "splice",
  "unshift"
];
function listenArrayEvents(array, listener) {
  if (array._chartjs) {
    array._chartjs.listeners.push(listener);
    return;
  }
  Object.defineProperty(array, "_chartjs", {
    configurable: true,
    enumerable: false,
    value: {
      listeners: [
        listener
      ]
    }
  });
  arrayEvents.forEach((key) => {
    const method = "_onData" + _capitalize(key);
    const base = array[key];
    Object.defineProperty(array, key, {
      configurable: true,
      enumerable: false,
      value(...args) {
        const res = base.apply(this, args);
        array._chartjs.listeners.forEach((object) => {
          if (typeof object[method] === "function") {
            object[method](...args);
          }
        });
        return res;
      }
    });
  });
}
function unlistenArrayEvents(array, listener) {
  const stub = array._chartjs;
  if (!stub) {
    return;
  }
  const listeners = stub.listeners;
  const index2 = listeners.indexOf(listener);
  if (index2 !== -1) {
    listeners.splice(index2, 1);
  }
  if (listeners.length > 0) {
    return;
  }
  arrayEvents.forEach((key) => {
    delete array[key];
  });
  delete array._chartjs;
}
function _arrayUnique(items) {
  const set2 = new Set(items);
  if (set2.size === items.length) {
    return items;
  }
  return Array.from(set2);
}
var requestAnimFrame = (function() {
  if (typeof window === "undefined") {
    return function(callback2) {
      return callback2();
    };
  }
  return window.requestAnimationFrame;
})();
function throttled(fn, thisArg) {
  let argsToUse = [];
  let ticking = false;
  return function(...args) {
    argsToUse = args;
    if (!ticking) {
      ticking = true;
      requestAnimFrame.call(window, () => {
        ticking = false;
        fn.apply(thisArg, argsToUse);
      });
    }
  };
}
function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    if (delay) {
      clearTimeout(timeout);
      timeout = setTimeout(fn, delay, args);
    } else {
      fn.apply(this, args);
    }
    return delay;
  };
}
var _toLeftRightCenter = (align) => align === "start" ? "left" : align === "end" ? "right" : "center";
var _alignStartEnd = (align, start, end) => align === "start" ? start : align === "end" ? end : (start + end) / 2;
var _textX = (align, left, right, rtl) => {
  const check = rtl ? "left" : "right";
  return align === check ? right : align === "center" ? (left + right) / 2 : left;
};
function _getStartAndCountOfVisiblePoints(meta, points, animationsDisabled) {
  const pointCount = points.length;
  let start = 0;
  let count = pointCount;
  if (meta._sorted) {
    const { iScale, vScale, _parsed } = meta;
    const spanGaps = meta.dataset ? meta.dataset.options ? meta.dataset.options.spanGaps : null : null;
    const axis = iScale.axis;
    const { min, max, minDefined, maxDefined } = iScale.getUserBounds();
    if (minDefined) {
      start = Math.min(
        // @ts-expect-error Need to type _parsed
        _lookupByKey(_parsed, axis, min).lo,
        // @ts-expect-error Need to fix types on _lookupByKey
        animationsDisabled ? pointCount : _lookupByKey(points, axis, iScale.getPixelForValue(min)).lo
      );
      if (spanGaps) {
        const distanceToDefinedLo = _parsed.slice(0, start + 1).reverse().findIndex((point) => !isNullOrUndef(point[vScale.axis]));
        start -= Math.max(0, distanceToDefinedLo);
      }
      start = _limitValue(start, 0, pointCount - 1);
    }
    if (maxDefined) {
      let end = Math.max(
        // @ts-expect-error Need to type _parsed
        _lookupByKey(_parsed, iScale.axis, max, true).hi + 1,
        // @ts-expect-error Need to fix types on _lookupByKey
        animationsDisabled ? 0 : _lookupByKey(points, axis, iScale.getPixelForValue(max), true).hi + 1
      );
      if (spanGaps) {
        const distanceToDefinedHi = _parsed.slice(end - 1).findIndex((point) => !isNullOrUndef(point[vScale.axis]));
        end += Math.max(0, distanceToDefinedHi);
      }
      count = _limitValue(end, start, pointCount) - start;
    } else {
      count = pointCount - start;
    }
  }
  return {
    start,
    count
  };
}
function _scaleRangesChanged(meta) {
  const { xScale, yScale, _scaleRanges } = meta;
  const newRanges = {
    xmin: xScale.min,
    xmax: xScale.max,
    ymin: yScale.min,
    ymax: yScale.max
  };
  if (!_scaleRanges) {
    meta._scaleRanges = newRanges;
    return true;
  }
  const changed = _scaleRanges.xmin !== xScale.min || _scaleRanges.xmax !== xScale.max || _scaleRanges.ymin !== yScale.min || _scaleRanges.ymax !== yScale.max;
  Object.assign(_scaleRanges, newRanges);
  return changed;
}
var atEdge = (t) => t === 0 || t === 1;
var elasticIn = (t, s, p) => -(Math.pow(2, 10 * (t -= 1)) * Math.sin((t - s) * TAU / p));
var elasticOut = (t, s, p) => Math.pow(2, -10 * t) * Math.sin((t - s) * TAU / p) + 1;
var effects = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => -t * (t - 2),
  easeInOutQuad: (t) => (t /= 0.5) < 1 ? 0.5 * t * t : -0.5 * (--t * (t - 2) - 1),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => (t -= 1) * t * t + 1,
  easeInOutCubic: (t) => (t /= 0.5) < 1 ? 0.5 * t * t * t : 0.5 * ((t -= 2) * t * t + 2),
  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => -((t -= 1) * t * t * t - 1),
  easeInOutQuart: (t) => (t /= 0.5) < 1 ? 0.5 * t * t * t * t : -0.5 * ((t -= 2) * t * t * t - 2),
  easeInQuint: (t) => t * t * t * t * t,
  easeOutQuint: (t) => (t -= 1) * t * t * t * t + 1,
  easeInOutQuint: (t) => (t /= 0.5) < 1 ? 0.5 * t * t * t * t * t : 0.5 * ((t -= 2) * t * t * t * t + 2),
  easeInSine: (t) => -Math.cos(t * HALF_PI) + 1,
  easeOutSine: (t) => Math.sin(t * HALF_PI),
  easeInOutSine: (t) => -0.5 * (Math.cos(PI * t) - 1),
  easeInExpo: (t) => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
  easeOutExpo: (t) => t === 1 ? 1 : -Math.pow(2, -10 * t) + 1,
  easeInOutExpo: (t) => atEdge(t) ? t : t < 0.5 ? 0.5 * Math.pow(2, 10 * (t * 2 - 1)) : 0.5 * (-Math.pow(2, -10 * (t * 2 - 1)) + 2),
  easeInCirc: (t) => t >= 1 ? t : -(Math.sqrt(1 - t * t) - 1),
  easeOutCirc: (t) => Math.sqrt(1 - (t -= 1) * t),
  easeInOutCirc: (t) => (t /= 0.5) < 1 ? -0.5 * (Math.sqrt(1 - t * t) - 1) : 0.5 * (Math.sqrt(1 - (t -= 2) * t) + 1),
  easeInElastic: (t) => atEdge(t) ? t : elasticIn(t, 0.075, 0.3),
  easeOutElastic: (t) => atEdge(t) ? t : elasticOut(t, 0.075, 0.3),
  easeInOutElastic(t) {
    const s = 0.1125;
    const p = 0.45;
    return atEdge(t) ? t : t < 0.5 ? 0.5 * elasticIn(t * 2, s, p) : 0.5 + 0.5 * elasticOut(t * 2 - 1, s, p);
  },
  easeInBack(t) {
    const s = 1.70158;
    return t * t * ((s + 1) * t - s);
  },
  easeOutBack(t) {
    const s = 1.70158;
    return (t -= 1) * t * ((s + 1) * t + s) + 1;
  },
  easeInOutBack(t) {
    let s = 1.70158;
    if ((t /= 0.5) < 1) {
      return 0.5 * (t * t * (((s *= 1.525) + 1) * t - s));
    }
    return 0.5 * ((t -= 2) * t * (((s *= 1.525) + 1) * t + s) + 2);
  },
  easeInBounce: (t) => 1 - effects.easeOutBounce(1 - t),
  easeOutBounce(t) {
    const m = 7.5625;
    const d = 2.75;
    if (t < 1 / d) {
      return m * t * t;
    }
    if (t < 2 / d) {
      return m * (t -= 1.5 / d) * t + 0.75;
    }
    if (t < 2.5 / d) {
      return m * (t -= 2.25 / d) * t + 0.9375;
    }
    return m * (t -= 2.625 / d) * t + 0.984375;
  },
  easeInOutBounce: (t) => t < 0.5 ? effects.easeInBounce(t * 2) * 0.5 : effects.easeOutBounce(t * 2 - 1) * 0.5 + 0.5
};
function isPatternOrGradient(value) {
  if (value && typeof value === "object") {
    const type = value.toString();
    return type === "[object CanvasPattern]" || type === "[object CanvasGradient]";
  }
  return false;
}
function color(value) {
  return isPatternOrGradient(value) ? value : new Color(value);
}
function getHoverColor(value) {
  return isPatternOrGradient(value) ? value : new Color(value).saturate(0.5).darken(0.1).hexString();
}
var numbers = [
  "x",
  "y",
  "borderWidth",
  "radius",
  "tension"
];
var colors = [
  "color",
  "borderColor",
  "backgroundColor"
];
function applyAnimationsDefaults(defaults2) {
  defaults2.set("animation", {
    delay: void 0,
    duration: 1e3,
    easing: "easeOutQuart",
    fn: void 0,
    from: void 0,
    loop: void 0,
    to: void 0,
    type: void 0
  });
  defaults2.describe("animation", {
    _fallback: false,
    _indexable: false,
    _scriptable: (name) => name !== "onProgress" && name !== "onComplete" && name !== "fn"
  });
  defaults2.set("animations", {
    colors: {
      type: "color",
      properties: colors
    },
    numbers: {
      type: "number",
      properties: numbers
    }
  });
  defaults2.describe("animations", {
    _fallback: "animation"
  });
  defaults2.set("transitions", {
    active: {
      animation: {
        duration: 400
      }
    },
    resize: {
      animation: {
        duration: 0
      }
    },
    show: {
      animations: {
        colors: {
          from: "transparent"
        },
        visible: {
          type: "boolean",
          duration: 0
        }
      }
    },
    hide: {
      animations: {
        colors: {
          to: "transparent"
        },
        visible: {
          type: "boolean",
          easing: "linear",
          fn: (v) => v | 0
        }
      }
    }
  });
}
function applyLayoutsDefaults(defaults2) {
  defaults2.set("layout", {
    autoPadding: true,
    padding: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    }
  });
}
var intlCache = /* @__PURE__ */ new Map();
function getNumberFormat(locale, options) {
  options = options || {};
  const cacheKey = locale + JSON.stringify(options);
  let formatter = intlCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    intlCache.set(cacheKey, formatter);
  }
  return formatter;
}
function formatNumber(num, locale, options) {
  return getNumberFormat(locale, options).format(num);
}
var formatters = {
  values(value) {
    return isArray(value) ? value : "" + value;
  },
  numeric(tickValue, index2, ticks) {
    if (tickValue === 0) {
      return "0";
    }
    const locale = this.chart.options.locale;
    let notation;
    let delta = tickValue;
    if (ticks.length > 1) {
      const maxTick = Math.max(Math.abs(ticks[0].value), Math.abs(ticks[ticks.length - 1].value));
      if (maxTick < 1e-4 || maxTick > 1e15) {
        notation = "scientific";
      }
      delta = calculateDelta(tickValue, ticks);
    }
    const logDelta = log10(Math.abs(delta));
    const numDecimal = isNaN(logDelta) ? 1 : Math.max(Math.min(-1 * Math.floor(logDelta), 20), 0);
    const options = {
      notation,
      minimumFractionDigits: numDecimal,
      maximumFractionDigits: numDecimal
    };
    Object.assign(options, this.options.ticks.format);
    return formatNumber(tickValue, locale, options);
  },
  logarithmic(tickValue, index2, ticks) {
    if (tickValue === 0) {
      return "0";
    }
    const remain = ticks[index2].significand || tickValue / Math.pow(10, Math.floor(log10(tickValue)));
    if ([
      1,
      2,
      3,
      5,
      10,
      15
    ].includes(remain) || index2 > 0.8 * ticks.length) {
      return formatters.numeric.call(this, tickValue, index2, ticks);
    }
    return "";
  }
};
function calculateDelta(tickValue, ticks) {
  let delta = ticks.length > 3 ? ticks[2].value - ticks[1].value : ticks[1].value - ticks[0].value;
  if (Math.abs(delta) >= 1 && tickValue !== Math.floor(tickValue)) {
    delta = tickValue - Math.floor(tickValue);
  }
  return delta;
}
var Ticks = {
  formatters
};
function applyScaleDefaults(defaults2) {
  defaults2.set("scale", {
    display: true,
    offset: false,
    reverse: false,
    beginAtZero: false,
    bounds: "ticks",
    clip: true,
    grace: 0,
    grid: {
      display: true,
      lineWidth: 1,
      drawOnChartArea: true,
      drawTicks: true,
      tickLength: 8,
      tickWidth: (_ctx, options) => options.lineWidth,
      tickColor: (_ctx, options) => options.color,
      offset: false
    },
    border: {
      display: true,
      dash: [],
      dashOffset: 0,
      width: 1
    },
    title: {
      display: false,
      text: "",
      padding: {
        top: 4,
        bottom: 4
      }
    },
    ticks: {
      minRotation: 0,
      maxRotation: 50,
      mirror: false,
      textStrokeWidth: 0,
      textStrokeColor: "",
      padding: 3,
      display: true,
      autoSkip: true,
      autoSkipPadding: 3,
      labelOffset: 0,
      callback: Ticks.formatters.values,
      minor: {},
      major: {},
      align: "center",
      crossAlign: "near",
      showLabelBackdrop: false,
      backdropColor: "rgba(255, 255, 255, 0.75)",
      backdropPadding: 2
    }
  });
  defaults2.route("scale.ticks", "color", "", "color");
  defaults2.route("scale.grid", "color", "", "borderColor");
  defaults2.route("scale.border", "color", "", "borderColor");
  defaults2.route("scale.title", "color", "", "color");
  defaults2.describe("scale", {
    _fallback: false,
    _scriptable: (name) => !name.startsWith("before") && !name.startsWith("after") && name !== "callback" && name !== "parser",
    _indexable: (name) => name !== "borderDash" && name !== "tickBorderDash" && name !== "dash"
  });
  defaults2.describe("scales", {
    _fallback: "scale"
  });
  defaults2.describe("scale.ticks", {
    _scriptable: (name) => name !== "backdropPadding" && name !== "callback",
    _indexable: (name) => name !== "backdropPadding"
  });
}
var overrides = /* @__PURE__ */ Object.create(null);
var descriptors = /* @__PURE__ */ Object.create(null);
function getScope$1(node, key) {
  if (!key) {
    return node;
  }
  const keys = key.split(".");
  for (let i = 0, n = keys.length; i < n; ++i) {
    const k = keys[i];
    node = node[k] || (node[k] = /* @__PURE__ */ Object.create(null));
  }
  return node;
}
function set(root, scope, values) {
  if (typeof scope === "string") {
    return merge(getScope$1(root, scope), values);
  }
  return merge(getScope$1(root, ""), scope);
}
var Defaults = class {
  constructor(_descriptors2, _appliers) {
    this.animation = void 0;
    this.backgroundColor = "rgba(0,0,0,0.1)";
    this.borderColor = "rgba(0,0,0,0.1)";
    this.color = "#666";
    this.datasets = {};
    this.devicePixelRatio = (context) => context.chart.platform.getDevicePixelRatio();
    this.elements = {};
    this.events = [
      "mousemove",
      "mouseout",
      "click",
      "touchstart",
      "touchmove"
    ];
    this.font = {
      family: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
      size: 12,
      style: "normal",
      lineHeight: 1.2,
      weight: null
    };
    this.hover = {};
    this.hoverBackgroundColor = (ctx, options) => getHoverColor(options.backgroundColor);
    this.hoverBorderColor = (ctx, options) => getHoverColor(options.borderColor);
    this.hoverColor = (ctx, options) => getHoverColor(options.color);
    this.indexAxis = "x";
    this.interaction = {
      mode: "nearest",
      intersect: true,
      includeInvisible: false
    };
    this.maintainAspectRatio = true;
    this.onHover = null;
    this.onClick = null;
    this.parsing = true;
    this.plugins = {};
    this.responsive = true;
    this.scale = void 0;
    this.scales = {};
    this.showLine = true;
    this.drawActiveElementsOnTop = true;
    this.describe(_descriptors2);
    this.apply(_appliers);
  }
  set(scope, values) {
    return set(this, scope, values);
  }
  get(scope) {
    return getScope$1(this, scope);
  }
  describe(scope, values) {
    return set(descriptors, scope, values);
  }
  override(scope, values) {
    return set(overrides, scope, values);
  }
  route(scope, name, targetScope, targetName) {
    const scopeObject = getScope$1(this, scope);
    const targetScopeObject = getScope$1(this, targetScope);
    const privateName = "_" + name;
    Object.defineProperties(scopeObject, {
      [privateName]: {
        value: scopeObject[name],
        writable: true
      },
      [name]: {
        enumerable: true,
        get() {
          const local = this[privateName];
          const target = targetScopeObject[targetName];
          if (isObject(local)) {
            return Object.assign({}, target, local);
          }
          return valueOrDefault(local, target);
        },
        set(value) {
          this[privateName] = value;
        }
      }
    });
  }
  apply(appliers) {
    appliers.forEach((apply2) => apply2(this));
  }
};
var defaults = /* @__PURE__ */ new Defaults({
  _scriptable: (name) => !name.startsWith("on"),
  _indexable: (name) => name !== "events",
  hover: {
    _fallback: "interaction"
  },
  interaction: {
    _scriptable: false,
    _indexable: false
  }
}, [
  applyAnimationsDefaults,
  applyLayoutsDefaults,
  applyScaleDefaults
]);
function toFontString(font) {
  if (!font || isNullOrUndef(font.size) || isNullOrUndef(font.family)) {
    return null;
  }
  return (font.style ? font.style + " " : "") + (font.weight ? font.weight + " " : "") + font.size + "px " + font.family;
}
function _measureText(ctx, data, gc, longest, string) {
  let textWidth = data[string];
  if (!textWidth) {
    textWidth = data[string] = ctx.measureText(string).width;
    gc.push(string);
  }
  if (textWidth > longest) {
    longest = textWidth;
  }
  return longest;
}
function _longestText(ctx, font, arrayOfThings, cache) {
  cache = cache || {};
  let data = cache.data = cache.data || {};
  let gc = cache.garbageCollect = cache.garbageCollect || [];
  if (cache.font !== font) {
    data = cache.data = {};
    gc = cache.garbageCollect = [];
    cache.font = font;
  }
  ctx.save();
  ctx.font = font;
  let longest = 0;
  const ilen = arrayOfThings.length;
  let i, j, jlen, thing, nestedThing;
  for (i = 0; i < ilen; i++) {
    thing = arrayOfThings[i];
    if (thing !== void 0 && thing !== null && !isArray(thing)) {
      longest = _measureText(ctx, data, gc, longest, thing);
    } else if (isArray(thing)) {
      for (j = 0, jlen = thing.length; j < jlen; j++) {
        nestedThing = thing[j];
        if (nestedThing !== void 0 && nestedThing !== null && !isArray(nestedThing)) {
          longest = _measureText(ctx, data, gc, longest, nestedThing);
        }
      }
    }
  }
  ctx.restore();
  const gcLen = gc.length / 2;
  if (gcLen > arrayOfThings.length) {
    for (i = 0; i < gcLen; i++) {
      delete data[gc[i]];
    }
    gc.splice(0, gcLen);
  }
  return longest;
}
function _alignPixel(chart, pixel, width) {
  const devicePixelRatio = chart.currentDevicePixelRatio;
  const halfWidth = width !== 0 ? Math.max(width / 2, 0.5) : 0;
  return Math.round((pixel - halfWidth) * devicePixelRatio) / devicePixelRatio + halfWidth;
}
function clearCanvas(canvas, ctx) {
  if (!ctx && !canvas) {
    return;
  }
  ctx = ctx || canvas.getContext("2d");
  ctx.save();
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}
function drawPoint(ctx, options, x, y) {
  drawPointLegend(ctx, options, x, y, null);
}
function drawPointLegend(ctx, options, x, y, w) {
  let type, xOffset, yOffset, size, cornerRadius, width, xOffsetW, yOffsetW;
  const style = options.pointStyle;
  const rotation = options.rotation;
  const radius = options.radius;
  let rad = (rotation || 0) * RAD_PER_DEG;
  if (style && typeof style === "object") {
    type = style.toString();
    if (type === "[object HTMLImageElement]" || type === "[object HTMLCanvasElement]") {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rad);
      ctx.drawImage(style, -style.width / 2, -style.height / 2, style.width, style.height);
      ctx.restore();
      return;
    }
  }
  if (isNaN(radius) || radius <= 0) {
    return;
  }
  ctx.beginPath();
  switch (style) {
    // Default includes circle
    default:
      if (w) {
        ctx.ellipse(x, y, w / 2, radius, 0, 0, TAU);
      } else {
        ctx.arc(x, y, radius, 0, TAU);
      }
      ctx.closePath();
      break;
    case "triangle":
      width = w ? w / 2 : radius;
      ctx.moveTo(x + Math.sin(rad) * width, y - Math.cos(rad) * radius);
      rad += TWO_THIRDS_PI;
      ctx.lineTo(x + Math.sin(rad) * width, y - Math.cos(rad) * radius);
      rad += TWO_THIRDS_PI;
      ctx.lineTo(x + Math.sin(rad) * width, y - Math.cos(rad) * radius);
      ctx.closePath();
      break;
    case "rectRounded":
      cornerRadius = radius * 0.516;
      size = radius - cornerRadius;
      xOffset = Math.cos(rad + QUARTER_PI) * size;
      xOffsetW = Math.cos(rad + QUARTER_PI) * (w ? w / 2 - cornerRadius : size);
      yOffset = Math.sin(rad + QUARTER_PI) * size;
      yOffsetW = Math.sin(rad + QUARTER_PI) * (w ? w / 2 - cornerRadius : size);
      ctx.arc(x - xOffsetW, y - yOffset, cornerRadius, rad - PI, rad - HALF_PI);
      ctx.arc(x + yOffsetW, y - xOffset, cornerRadius, rad - HALF_PI, rad);
      ctx.arc(x + xOffsetW, y + yOffset, cornerRadius, rad, rad + HALF_PI);
      ctx.arc(x - yOffsetW, y + xOffset, cornerRadius, rad + HALF_PI, rad + PI);
      ctx.closePath();
      break;
    case "rect":
      if (!rotation) {
        size = Math.SQRT1_2 * radius;
        width = w ? w / 2 : size;
        ctx.rect(x - width, y - size, 2 * width, 2 * size);
        break;
      }
      rad += QUARTER_PI;
    /* falls through */
    case "rectRot":
      xOffsetW = Math.cos(rad) * (w ? w / 2 : radius);
      xOffset = Math.cos(rad) * radius;
      yOffset = Math.sin(rad) * radius;
      yOffsetW = Math.sin(rad) * (w ? w / 2 : radius);
      ctx.moveTo(x - xOffsetW, y - yOffset);
      ctx.lineTo(x + yOffsetW, y - xOffset);
      ctx.lineTo(x + xOffsetW, y + yOffset);
      ctx.lineTo(x - yOffsetW, y + xOffset);
      ctx.closePath();
      break;
    case "crossRot":
      rad += QUARTER_PI;
    /* falls through */
    case "cross":
      xOffsetW = Math.cos(rad) * (w ? w / 2 : radius);
      xOffset = Math.cos(rad) * radius;
      yOffset = Math.sin(rad) * radius;
      yOffsetW = Math.sin(rad) * (w ? w / 2 : radius);
      ctx.moveTo(x - xOffsetW, y - yOffset);
      ctx.lineTo(x + xOffsetW, y + yOffset);
      ctx.moveTo(x + yOffsetW, y - xOffset);
      ctx.lineTo(x - yOffsetW, y + xOffset);
      break;
    case "star":
      xOffsetW = Math.cos(rad) * (w ? w / 2 : radius);
      xOffset = Math.cos(rad) * radius;
      yOffset = Math.sin(rad) * radius;
      yOffsetW = Math.sin(rad) * (w ? w / 2 : radius);
      ctx.moveTo(x - xOffsetW, y - yOffset);
      ctx.lineTo(x + xOffsetW, y + yOffset);
      ctx.moveTo(x + yOffsetW, y - xOffset);
      ctx.lineTo(x - yOffsetW, y + xOffset);
      rad += QUARTER_PI;
      xOffsetW = Math.cos(rad) * (w ? w / 2 : radius);
      xOffset = Math.cos(rad) * radius;
      yOffset = Math.sin(rad) * radius;
      yOffsetW = Math.sin(rad) * (w ? w / 2 : radius);
      ctx.moveTo(x - xOffsetW, y - yOffset);
      ctx.lineTo(x + xOffsetW, y + yOffset);
      ctx.moveTo(x + yOffsetW, y - xOffset);
      ctx.lineTo(x - yOffsetW, y + xOffset);
      break;
    case "line":
      xOffset = w ? w / 2 : Math.cos(rad) * radius;
      yOffset = Math.sin(rad) * radius;
      ctx.moveTo(x - xOffset, y - yOffset);
      ctx.lineTo(x + xOffset, y + yOffset);
      break;
    case "dash":
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(rad) * (w ? w / 2 : radius), y + Math.sin(rad) * radius);
      break;
    case false:
      ctx.closePath();
      break;
  }
  ctx.fill();
  if (options.borderWidth > 0) {
    ctx.stroke();
  }
}
function _isPointInArea(point, area, margin) {
  margin = margin || 0.5;
  return !area || point && point.x > area.left - margin && point.x < area.right + margin && point.y > area.top - margin && point.y < area.bottom + margin;
}
function clipArea(ctx, area) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
}
function unclipArea(ctx) {
  ctx.restore();
}
function _steppedLineTo(ctx, previous, target, flip, mode) {
  if (!previous) {
    return ctx.lineTo(target.x, target.y);
  }
  if (mode === "middle") {
    const midpoint = (previous.x + target.x) / 2;
    ctx.lineTo(midpoint, previous.y);
    ctx.lineTo(midpoint, target.y);
  } else if (mode === "after" !== !!flip) {
    ctx.lineTo(previous.x, target.y);
  } else {
    ctx.lineTo(target.x, previous.y);
  }
  ctx.lineTo(target.x, target.y);
}
function _bezierCurveTo(ctx, previous, target, flip) {
  if (!previous) {
    return ctx.lineTo(target.x, target.y);
  }
  ctx.bezierCurveTo(flip ? previous.cp1x : previous.cp2x, flip ? previous.cp1y : previous.cp2y, flip ? target.cp2x : target.cp1x, flip ? target.cp2y : target.cp1y, target.x, target.y);
}
function setRenderOpts(ctx, opts) {
  if (opts.translation) {
    ctx.translate(opts.translation[0], opts.translation[1]);
  }
  if (!isNullOrUndef(opts.rotation)) {
    ctx.rotate(opts.rotation);
  }
  if (opts.color) {
    ctx.fillStyle = opts.color;
  }
  if (opts.textAlign) {
    ctx.textAlign = opts.textAlign;
  }
  if (opts.textBaseline) {
    ctx.textBaseline = opts.textBaseline;
  }
}
function decorateText(ctx, x, y, line, opts) {
  if (opts.strikethrough || opts.underline) {
    const metrics = ctx.measureText(line);
    const left = x - metrics.actualBoundingBoxLeft;
    const right = x + metrics.actualBoundingBoxRight;
    const top = y - metrics.actualBoundingBoxAscent;
    const bottom = y + metrics.actualBoundingBoxDescent;
    const yDecoration = opts.strikethrough ? (top + bottom) / 2 : bottom;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    ctx.lineWidth = opts.decorationWidth || 2;
    ctx.moveTo(left, yDecoration);
    ctx.lineTo(right, yDecoration);
    ctx.stroke();
  }
}
function drawBackdrop(ctx, opts) {
  const oldColor = ctx.fillStyle;
  ctx.fillStyle = opts.color;
  ctx.fillRect(opts.left, opts.top, opts.width, opts.height);
  ctx.fillStyle = oldColor;
}
function renderText(ctx, text, x, y, font, opts = {}) {
  const lines = isArray(text) ? text : [
    text
  ];
  const stroke = opts.strokeWidth > 0 && opts.strokeColor !== "";
  let i, line;
  ctx.save();
  ctx.font = font.string;
  setRenderOpts(ctx, opts);
  for (i = 0; i < lines.length; ++i) {
    line = lines[i];
    if (opts.backdrop) {
      drawBackdrop(ctx, opts.backdrop);
    }
    if (stroke) {
      if (opts.strokeColor) {
        ctx.strokeStyle = opts.strokeColor;
      }
      if (!isNullOrUndef(opts.strokeWidth)) {
        ctx.lineWidth = opts.strokeWidth;
      }
      ctx.strokeText(line, x, y, opts.maxWidth);
    }
    ctx.fillText(line, x, y, opts.maxWidth);
    decorateText(ctx, x, y, line, opts);
    y += Number(font.lineHeight);
  }
  ctx.restore();
}
function addRoundedRectPath(ctx, rect) {
  const { x, y, w, h: h4, radius } = rect;
  ctx.arc(x + radius.topLeft, y + radius.topLeft, radius.topLeft, 1.5 * PI, PI, true);
  ctx.lineTo(x, y + h4 - radius.bottomLeft);
  ctx.arc(x + radius.bottomLeft, y + h4 - radius.bottomLeft, radius.bottomLeft, PI, HALF_PI, true);
  ctx.lineTo(x + w - radius.bottomRight, y + h4);
  ctx.arc(x + w - radius.bottomRight, y + h4 - radius.bottomRight, radius.bottomRight, HALF_PI, 0, true);
  ctx.lineTo(x + w, y + radius.topRight);
  ctx.arc(x + w - radius.topRight, y + radius.topRight, radius.topRight, 0, -HALF_PI, true);
  ctx.lineTo(x + radius.topLeft, y);
}
var LINE_HEIGHT = /^(normal|(\d+(?:\.\d+)?)(px|em|%)?)$/;
var FONT_STYLE = /^(normal|italic|initial|inherit|unset|(oblique( -?[0-9]?[0-9]deg)?))$/;
function toLineHeight(value, size) {
  const matches = ("" + value).match(LINE_HEIGHT);
  if (!matches || matches[1] === "normal") {
    return size * 1.2;
  }
  value = +matches[2];
  switch (matches[3]) {
    case "px":
      return value;
    case "%":
      value /= 100;
      break;
  }
  return size * value;
}
var numberOrZero = (v) => +v || 0;
function _readValueToProps(value, props) {
  const ret = {};
  const objProps = isObject(props);
  const keys = objProps ? Object.keys(props) : props;
  const read = isObject(value) ? objProps ? (prop) => valueOrDefault(value[prop], value[props[prop]]) : (prop) => value[prop] : () => value;
  for (const prop of keys) {
    ret[prop] = numberOrZero(read(prop));
  }
  return ret;
}
function toTRBL(value) {
  return _readValueToProps(value, {
    top: "y",
    right: "x",
    bottom: "y",
    left: "x"
  });
}
function toTRBLCorners(value) {
  return _readValueToProps(value, [
    "topLeft",
    "topRight",
    "bottomLeft",
    "bottomRight"
  ]);
}
function toPadding(value) {
  const obj = toTRBL(value);
  obj.width = obj.left + obj.right;
  obj.height = obj.top + obj.bottom;
  return obj;
}
function toFont(options, fallback) {
  options = options || {};
  fallback = fallback || defaults.font;
  let size = valueOrDefault(options.size, fallback.size);
  if (typeof size === "string") {
    size = parseInt(size, 10);
  }
  let style = valueOrDefault(options.style, fallback.style);
  if (style && !("" + style).match(FONT_STYLE)) {
    console.warn('Invalid font style specified: "' + style + '"');
    style = void 0;
  }
  const font = {
    family: valueOrDefault(options.family, fallback.family),
    lineHeight: toLineHeight(valueOrDefault(options.lineHeight, fallback.lineHeight), size),
    size,
    style,
    weight: valueOrDefault(options.weight, fallback.weight),
    string: ""
  };
  font.string = toFontString(font);
  return font;
}
function resolve(inputs, context, index2, info) {
  let cacheable = true;
  let i, ilen, value;
  for (i = 0, ilen = inputs.length; i < ilen; ++i) {
    value = inputs[i];
    if (value === void 0) {
      continue;
    }
    if (context !== void 0 && typeof value === "function") {
      value = value(context);
      cacheable = false;
    }
    if (index2 !== void 0 && isArray(value)) {
      value = value[index2 % value.length];
      cacheable = false;
    }
    if (value !== void 0) {
      if (info && !cacheable) {
        info.cacheable = false;
      }
      return value;
    }
  }
}
function _addGrace(minmax, grace, beginAtZero) {
  const { min, max } = minmax;
  const change = toDimension(grace, (max - min) / 2);
  const keepZero = (value, add) => beginAtZero && value === 0 ? 0 : value + add;
  return {
    min: keepZero(min, -Math.abs(change)),
    max: keepZero(max, change)
  };
}
function createContext(parentContext, context) {
  return Object.assign(Object.create(parentContext), context);
}
function _createResolver(scopes, prefixes = [
  ""
], rootScopes, fallback, getTarget = () => scopes[0]) {
  const finalRootScopes = rootScopes || scopes;
  if (typeof fallback === "undefined") {
    fallback = _resolve("_fallback", scopes);
  }
  const cache = {
    [Symbol.toStringTag]: "Object",
    _cacheable: true,
    _scopes: scopes,
    _rootScopes: finalRootScopes,
    _fallback: fallback,
    _getTarget: getTarget,
    override: (scope) => _createResolver([
      scope,
      ...scopes
    ], prefixes, finalRootScopes, fallback)
  };
  return new Proxy(cache, {
    /**
    * A trap for the delete operator.
    */
    deleteProperty(target, prop) {
      delete target[prop];
      delete target._keys;
      delete scopes[0][prop];
      return true;
    },
    /**
    * A trap for getting property values.
    */
    get(target, prop) {
      return _cached(target, prop, () => _resolveWithPrefixes(prop, prefixes, scopes, target));
    },
    /**
    * A trap for Object.getOwnPropertyDescriptor.
    * Also used by Object.hasOwnProperty.
    */
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target._scopes[0], prop);
    },
    /**
    * A trap for Object.getPrototypeOf.
    */
    getPrototypeOf() {
      return Reflect.getPrototypeOf(scopes[0]);
    },
    /**
    * A trap for the in operator.
    */
    has(target, prop) {
      return getKeysFromAllScopes(target).includes(prop);
    },
    /**
    * A trap for Object.getOwnPropertyNames and Object.getOwnPropertySymbols.
    */
    ownKeys(target) {
      return getKeysFromAllScopes(target);
    },
    /**
    * A trap for setting property values.
    */
    set(target, prop, value) {
      const storage = target._storage || (target._storage = getTarget());
      target[prop] = storage[prop] = value;
      delete target._keys;
      return true;
    }
  });
}
function _attachContext(proxy, context, subProxy, descriptorDefaults) {
  const cache = {
    _cacheable: false,
    _proxy: proxy,
    _context: context,
    _subProxy: subProxy,
    _stack: /* @__PURE__ */ new Set(),
    _descriptors: _descriptors(proxy, descriptorDefaults),
    setContext: (ctx) => _attachContext(proxy, ctx, subProxy, descriptorDefaults),
    override: (scope) => _attachContext(proxy.override(scope), context, subProxy, descriptorDefaults)
  };
  return new Proxy(cache, {
    /**
    * A trap for the delete operator.
    */
    deleteProperty(target, prop) {
      delete target[prop];
      delete proxy[prop];
      return true;
    },
    /**
    * A trap for getting property values.
    */
    get(target, prop, receiver) {
      return _cached(target, prop, () => _resolveWithContext(target, prop, receiver));
    },
    /**
    * A trap for Object.getOwnPropertyDescriptor.
    * Also used by Object.hasOwnProperty.
    */
    getOwnPropertyDescriptor(target, prop) {
      return target._descriptors.allKeys ? Reflect.has(proxy, prop) ? {
        enumerable: true,
        configurable: true
      } : void 0 : Reflect.getOwnPropertyDescriptor(proxy, prop);
    },
    /**
    * A trap for Object.getPrototypeOf.
    */
    getPrototypeOf() {
      return Reflect.getPrototypeOf(proxy);
    },
    /**
    * A trap for the in operator.
    */
    has(target, prop) {
      return Reflect.has(proxy, prop);
    },
    /**
    * A trap for Object.getOwnPropertyNames and Object.getOwnPropertySymbols.
    */
    ownKeys() {
      return Reflect.ownKeys(proxy);
    },
    /**
    * A trap for setting property values.
    */
    set(target, prop, value) {
      proxy[prop] = value;
      delete target[prop];
      return true;
    }
  });
}
function _descriptors(proxy, defaults2 = {
  scriptable: true,
  indexable: true
}) {
  const { _scriptable = defaults2.scriptable, _indexable = defaults2.indexable, _allKeys = defaults2.allKeys } = proxy;
  return {
    allKeys: _allKeys,
    scriptable: _scriptable,
    indexable: _indexable,
    isScriptable: isFunction(_scriptable) ? _scriptable : () => _scriptable,
    isIndexable: isFunction(_indexable) ? _indexable : () => _indexable
  };
}
var readKey = (prefix, name) => prefix ? prefix + _capitalize(name) : name;
var needsSubResolver = (prop, value) => isObject(value) && prop !== "adapters" && (Object.getPrototypeOf(value) === null || value.constructor === Object);
function _cached(target, prop, resolve2) {
  if (Object.prototype.hasOwnProperty.call(target, prop) || prop === "constructor") {
    return target[prop];
  }
  const value = resolve2();
  target[prop] = value;
  return value;
}
function _resolveWithContext(target, prop, receiver) {
  const { _proxy, _context, _subProxy, _descriptors: descriptors2 } = target;
  let value = _proxy[prop];
  if (isFunction(value) && descriptors2.isScriptable(prop)) {
    value = _resolveScriptable(prop, value, target, receiver);
  }
  if (isArray(value) && value.length) {
    value = _resolveArray(prop, value, target, descriptors2.isIndexable);
  }
  if (needsSubResolver(prop, value)) {
    value = _attachContext(value, _context, _subProxy && _subProxy[prop], descriptors2);
  }
  return value;
}
function _resolveScriptable(prop, getValue, target, receiver) {
  const { _proxy, _context, _subProxy, _stack } = target;
  if (_stack.has(prop)) {
    throw new Error("Recursion detected: " + Array.from(_stack).join("->") + "->" + prop);
  }
  _stack.add(prop);
  let value = getValue(_context, _subProxy || receiver);
  _stack.delete(prop);
  if (needsSubResolver(prop, value)) {
    value = createSubResolver(_proxy._scopes, _proxy, prop, value);
  }
  return value;
}
function _resolveArray(prop, value, target, isIndexable) {
  const { _proxy, _context, _subProxy, _descriptors: descriptors2 } = target;
  if (typeof _context.index !== "undefined" && isIndexable(prop)) {
    return value[_context.index % value.length];
  } else if (isObject(value[0])) {
    const arr = value;
    const scopes = _proxy._scopes.filter((s) => s !== arr);
    value = [];
    for (const item of arr) {
      const resolver = createSubResolver(scopes, _proxy, prop, item);
      value.push(_attachContext(resolver, _context, _subProxy && _subProxy[prop], descriptors2));
    }
  }
  return value;
}
function resolveFallback(fallback, prop, value) {
  return isFunction(fallback) ? fallback(prop, value) : fallback;
}
var getScope = (key, parent) => key === true ? parent : typeof key === "string" ? resolveObjectKey(parent, key) : void 0;
function addScopes(set2, parentScopes, key, parentFallback, value) {
  for (const parent of parentScopes) {
    const scope = getScope(key, parent);
    if (scope) {
      set2.add(scope);
      const fallback = resolveFallback(scope._fallback, key, value);
      if (typeof fallback !== "undefined" && fallback !== key && fallback !== parentFallback) {
        return fallback;
      }
    } else if (scope === false && typeof parentFallback !== "undefined" && key !== parentFallback) {
      return null;
    }
  }
  return false;
}
function createSubResolver(parentScopes, resolver, prop, value) {
  const rootScopes = resolver._rootScopes;
  const fallback = resolveFallback(resolver._fallback, prop, value);
  const allScopes = [
    ...parentScopes,
    ...rootScopes
  ];
  const set2 = /* @__PURE__ */ new Set();
  set2.add(value);
  let key = addScopesFromKey(set2, allScopes, prop, fallback || prop, value);
  if (key === null) {
    return false;
  }
  if (typeof fallback !== "undefined" && fallback !== prop) {
    key = addScopesFromKey(set2, allScopes, fallback, key, value);
    if (key === null) {
      return false;
    }
  }
  return _createResolver(Array.from(set2), [
    ""
  ], rootScopes, fallback, () => subGetTarget(resolver, prop, value));
}
function addScopesFromKey(set2, allScopes, key, fallback, item) {
  while (key) {
    key = addScopes(set2, allScopes, key, fallback, item);
  }
  return key;
}
function subGetTarget(resolver, prop, value) {
  const parent = resolver._getTarget();
  if (!(prop in parent)) {
    parent[prop] = {};
  }
  const target = parent[prop];
  if (isArray(target) && isObject(value)) {
    return value;
  }
  return target || {};
}
function _resolveWithPrefixes(prop, prefixes, scopes, proxy) {
  let value;
  for (const prefix of prefixes) {
    value = _resolve(readKey(prefix, prop), scopes);
    if (typeof value !== "undefined") {
      return needsSubResolver(prop, value) ? createSubResolver(scopes, proxy, prop, value) : value;
    }
  }
}
function _resolve(key, scopes) {
  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    const value = scope[key];
    if (typeof value !== "undefined") {
      return value;
    }
  }
}
function getKeysFromAllScopes(target) {
  let keys = target._keys;
  if (!keys) {
    keys = target._keys = resolveKeysFromAllScopes(target._scopes);
  }
  return keys;
}
function resolveKeysFromAllScopes(scopes) {
  const set2 = /* @__PURE__ */ new Set();
  for (const scope of scopes) {
    for (const key of Object.keys(scope).filter((k) => !k.startsWith("_"))) {
      set2.add(key);
    }
  }
  return Array.from(set2);
}
function _parseObjectDataRadialScale(meta, data, start, count) {
  const { iScale } = meta;
  const { key = "r" } = this._parsing;
  const parsed = new Array(count);
  let i, ilen, index2, item;
  for (i = 0, ilen = count; i < ilen; ++i) {
    index2 = i + start;
    item = data[index2];
    parsed[i] = {
      r: iScale.parse(resolveObjectKey(item, key), index2)
    };
  }
  return parsed;
}
var EPSILON = Number.EPSILON || 1e-14;
var getPoint = (points, i) => i < points.length && !points[i].skip && points[i];
var getValueAxis = (indexAxis) => indexAxis === "x" ? "y" : "x";
function splineCurve(firstPoint, middlePoint, afterPoint, t) {
  const previous = firstPoint.skip ? middlePoint : firstPoint;
  const current = middlePoint;
  const next = afterPoint.skip ? middlePoint : afterPoint;
  const d01 = distanceBetweenPoints(current, previous);
  const d12 = distanceBetweenPoints(next, current);
  let s01 = d01 / (d01 + d12);
  let s12 = d12 / (d01 + d12);
  s01 = isNaN(s01) ? 0 : s01;
  s12 = isNaN(s12) ? 0 : s12;
  const fa = t * s01;
  const fb = t * s12;
  return {
    previous: {
      x: current.x - fa * (next.x - previous.x),
      y: current.y - fa * (next.y - previous.y)
    },
    next: {
      x: current.x + fb * (next.x - previous.x),
      y: current.y + fb * (next.y - previous.y)
    }
  };
}
function monotoneAdjust(points, deltaK, mK) {
  const pointsLen = points.length;
  let alphaK, betaK, tauK, squaredMagnitude, pointCurrent;
  let pointAfter = getPoint(points, 0);
  for (let i = 0; i < pointsLen - 1; ++i) {
    pointCurrent = pointAfter;
    pointAfter = getPoint(points, i + 1);
    if (!pointCurrent || !pointAfter) {
      continue;
    }
    if (almostEquals(deltaK[i], 0, EPSILON)) {
      mK[i] = mK[i + 1] = 0;
      continue;
    }
    alphaK = mK[i] / deltaK[i];
    betaK = mK[i + 1] / deltaK[i];
    squaredMagnitude = Math.pow(alphaK, 2) + Math.pow(betaK, 2);
    if (squaredMagnitude <= 9) {
      continue;
    }
    tauK = 3 / Math.sqrt(squaredMagnitude);
    mK[i] = alphaK * tauK * deltaK[i];
    mK[i + 1] = betaK * tauK * deltaK[i];
  }
}
function monotoneCompute(points, mK, indexAxis = "x") {
  const valueAxis = getValueAxis(indexAxis);
  const pointsLen = points.length;
  let delta, pointBefore, pointCurrent;
  let pointAfter = getPoint(points, 0);
  for (let i = 0; i < pointsLen; ++i) {
    pointBefore = pointCurrent;
    pointCurrent = pointAfter;
    pointAfter = getPoint(points, i + 1);
    if (!pointCurrent) {
      continue;
    }
    const iPixel = pointCurrent[indexAxis];
    const vPixel = pointCurrent[valueAxis];
    if (pointBefore) {
      delta = (iPixel - pointBefore[indexAxis]) / 3;
      pointCurrent[`cp1${indexAxis}`] = iPixel - delta;
      pointCurrent[`cp1${valueAxis}`] = vPixel - delta * mK[i];
    }
    if (pointAfter) {
      delta = (pointAfter[indexAxis] - iPixel) / 3;
      pointCurrent[`cp2${indexAxis}`] = iPixel + delta;
      pointCurrent[`cp2${valueAxis}`] = vPixel + delta * mK[i];
    }
  }
}
function splineCurveMonotone(points, indexAxis = "x") {
  const valueAxis = getValueAxis(indexAxis);
  const pointsLen = points.length;
  const deltaK = Array(pointsLen).fill(0);
  const mK = Array(pointsLen);
  let i, pointBefore, pointCurrent;
  let pointAfter = getPoint(points, 0);
  for (i = 0; i < pointsLen; ++i) {
    pointBefore = pointCurrent;
    pointCurrent = pointAfter;
    pointAfter = getPoint(points, i + 1);
    if (!pointCurrent) {
      continue;
    }
    if (pointAfter) {
      const slopeDelta = pointAfter[indexAxis] - pointCurrent[indexAxis];
      deltaK[i] = slopeDelta !== 0 ? (pointAfter[valueAxis] - pointCurrent[valueAxis]) / slopeDelta : 0;
    }
    mK[i] = !pointBefore ? deltaK[i] : !pointAfter ? deltaK[i - 1] : sign(deltaK[i - 1]) !== sign(deltaK[i]) ? 0 : (deltaK[i - 1] + deltaK[i]) / 2;
  }
  monotoneAdjust(points, deltaK, mK);
  monotoneCompute(points, mK, indexAxis);
}
function capControlPoint(pt, min, max) {
  return Math.max(Math.min(pt, max), min);
}
function capBezierPoints(points, area) {
  let i, ilen, point, inArea, inAreaPrev;
  let inAreaNext = _isPointInArea(points[0], area);
  for (i = 0, ilen = points.length; i < ilen; ++i) {
    inAreaPrev = inArea;
    inArea = inAreaNext;
    inAreaNext = i < ilen - 1 && _isPointInArea(points[i + 1], area);
    if (!inArea) {
      continue;
    }
    point = points[i];
    if (inAreaPrev) {
      point.cp1x = capControlPoint(point.cp1x, area.left, area.right);
      point.cp1y = capControlPoint(point.cp1y, area.top, area.bottom);
    }
    if (inAreaNext) {
      point.cp2x = capControlPoint(point.cp2x, area.left, area.right);
      point.cp2y = capControlPoint(point.cp2y, area.top, area.bottom);
    }
  }
}
function _updateBezierControlPoints(points, options, area, loop, indexAxis) {
  let i, ilen, point, controlPoints;
  if (options.spanGaps) {
    points = points.filter((pt) => !pt.skip);
  }
  if (options.cubicInterpolationMode === "monotone") {
    splineCurveMonotone(points, indexAxis);
  } else {
    let prev = loop ? points[points.length - 1] : points[0];
    for (i = 0, ilen = points.length; i < ilen; ++i) {
      point = points[i];
      controlPoints = splineCurve(prev, point, points[Math.min(i + 1, ilen - (loop ? 0 : 1)) % ilen], options.tension);
      point.cp1x = controlPoints.previous.x;
      point.cp1y = controlPoints.previous.y;
      point.cp2x = controlPoints.next.x;
      point.cp2y = controlPoints.next.y;
      prev = point;
    }
  }
  if (options.capBezierPoints) {
    capBezierPoints(points, area);
  }
}
function _isDomSupported() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
function _getParentNode(domNode) {
  let parent = domNode.parentNode;
  if (parent && parent.toString() === "[object ShadowRoot]") {
    parent = parent.host;
  }
  return parent;
}
function parseMaxStyle(styleValue, node, parentProperty) {
  let valueInPixels;
  if (typeof styleValue === "string") {
    valueInPixels = parseInt(styleValue, 10);
    if (styleValue.indexOf("%") !== -1) {
      valueInPixels = valueInPixels / 100 * node.parentNode[parentProperty];
    }
  } else {
    valueInPixels = styleValue;
  }
  return valueInPixels;
}
var getComputedStyle2 = (element) => element.ownerDocument.defaultView.getComputedStyle(element, null);
function getStyle(el, property) {
  return getComputedStyle2(el).getPropertyValue(property);
}
var positions = [
  "top",
  "right",
  "bottom",
  "left"
];
function getPositionedStyle(styles, style, suffix) {
  const result = {};
  suffix = suffix ? "-" + suffix : "";
  for (let i = 0; i < 4; i++) {
    const pos = positions[i];
    result[pos] = parseFloat(styles[style + "-" + pos + suffix]) || 0;
  }
  result.width = result.left + result.right;
  result.height = result.top + result.bottom;
  return result;
}
var useOffsetPos = (x, y, target) => (x > 0 || y > 0) && (!target || !target.shadowRoot);
function getCanvasPosition(e, canvas) {
  const touches = e.touches;
  const source = touches && touches.length ? touches[0] : e;
  const { offsetX, offsetY } = source;
  let box = false;
  let x, y;
  if (useOffsetPos(offsetX, offsetY, e.target)) {
    x = offsetX;
    y = offsetY;
  } else {
    const rect = canvas.getBoundingClientRect();
    x = source.clientX - rect.left;
    y = source.clientY - rect.top;
    box = true;
  }
  return {
    x,
    y,
    box
  };
}
function getRelativePosition(event, chart) {
  if ("native" in event) {
    return event;
  }
  const { canvas, currentDevicePixelRatio } = chart;
  const style = getComputedStyle2(canvas);
  const borderBox = style.boxSizing === "border-box";
  const paddings = getPositionedStyle(style, "padding");
  const borders = getPositionedStyle(style, "border", "width");
  const { x, y, box } = getCanvasPosition(event, canvas);
  const xOffset = paddings.left + (box && borders.left);
  const yOffset = paddings.top + (box && borders.top);
  let { width, height } = chart;
  if (borderBox) {
    width -= paddings.width + borders.width;
    height -= paddings.height + borders.height;
  }
  return {
    x: Math.round((x - xOffset) / width * canvas.width / currentDevicePixelRatio),
    y: Math.round((y - yOffset) / height * canvas.height / currentDevicePixelRatio)
  };
}
function getContainerSize(canvas, width, height) {
  let maxWidth, maxHeight;
  if (width === void 0 || height === void 0) {
    const container = canvas && _getParentNode(canvas);
    if (!container) {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    } else {
      const rect = container.getBoundingClientRect();
      const containerStyle = getComputedStyle2(container);
      const containerBorder = getPositionedStyle(containerStyle, "border", "width");
      const containerPadding = getPositionedStyle(containerStyle, "padding");
      width = rect.width - containerPadding.width - containerBorder.width;
      height = rect.height - containerPadding.height - containerBorder.height;
      maxWidth = parseMaxStyle(containerStyle.maxWidth, container, "clientWidth");
      maxHeight = parseMaxStyle(containerStyle.maxHeight, container, "clientHeight");
    }
  }
  return {
    width,
    height,
    maxWidth: maxWidth || INFINITY,
    maxHeight: maxHeight || INFINITY
  };
}
var round1 = (v) => Math.round(v * 10) / 10;
function getMaximumSize(canvas, bbWidth, bbHeight, aspectRatio) {
  const style = getComputedStyle2(canvas);
  const margins = getPositionedStyle(style, "margin");
  const maxWidth = parseMaxStyle(style.maxWidth, canvas, "clientWidth") || INFINITY;
  const maxHeight = parseMaxStyle(style.maxHeight, canvas, "clientHeight") || INFINITY;
  const containerSize = getContainerSize(canvas, bbWidth, bbHeight);
  let { width, height } = containerSize;
  if (style.boxSizing === "content-box") {
    const borders = getPositionedStyle(style, "border", "width");
    const paddings = getPositionedStyle(style, "padding");
    width -= paddings.width + borders.width;
    height -= paddings.height + borders.height;
  }
  width = Math.max(0, width - margins.width);
  height = Math.max(0, aspectRatio ? width / aspectRatio : height - margins.height);
  width = round1(Math.min(width, maxWidth, containerSize.maxWidth));
  height = round1(Math.min(height, maxHeight, containerSize.maxHeight));
  if (width && !height) {
    height = round1(width / 2);
  }
  const maintainHeight = bbWidth !== void 0 || bbHeight !== void 0;
  if (maintainHeight && aspectRatio && containerSize.height && height > containerSize.height) {
    height = containerSize.height;
    width = round1(Math.floor(height * aspectRatio));
  }
  return {
    width,
    height
  };
}
function retinaScale(chart, forceRatio, forceStyle) {
  const pixelRatio = forceRatio || 1;
  const deviceHeight = round1(chart.height * pixelRatio);
  const deviceWidth = round1(chart.width * pixelRatio);
  chart.height = round1(chart.height);
  chart.width = round1(chart.width);
  const canvas = chart.canvas;
  if (canvas.style && (forceStyle || !canvas.style.height && !canvas.style.width)) {
    canvas.style.height = `${chart.height}px`;
    canvas.style.width = `${chart.width}px`;
  }
  if (chart.currentDevicePixelRatio !== pixelRatio || canvas.height !== deviceHeight || canvas.width !== deviceWidth) {
    chart.currentDevicePixelRatio = pixelRatio;
    canvas.height = deviceHeight;
    canvas.width = deviceWidth;
    chart.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return true;
  }
  return false;
}
var supportsEventListenerOptions = (function() {
  let passiveSupported = false;
  try {
    const options = {
      get passive() {
        passiveSupported = true;
        return false;
      }
    };
    if (_isDomSupported()) {
      window.addEventListener("test", null, options);
      window.removeEventListener("test", null, options);
    }
  } catch (e) {
  }
  return passiveSupported;
})();
function readUsedSize(element, property) {
  const value = getStyle(element, property);
  const matches = value && value.match(/^(\d+)(\.\d+)?px$/);
  return matches ? +matches[1] : void 0;
}
function _pointInLine(p1, p2, t, mode) {
  return {
    x: p1.x + t * (p2.x - p1.x),
    y: p1.y + t * (p2.y - p1.y)
  };
}
function _steppedInterpolation(p1, p2, t, mode) {
  return {
    x: p1.x + t * (p2.x - p1.x),
    y: mode === "middle" ? t < 0.5 ? p1.y : p2.y : mode === "after" ? t < 1 ? p1.y : p2.y : t > 0 ? p2.y : p1.y
  };
}
function _bezierInterpolation(p1, p2, t, mode) {
  const cp1 = {
    x: p1.cp2x,
    y: p1.cp2y
  };
  const cp2 = {
    x: p2.cp1x,
    y: p2.cp1y
  };
  const a = _pointInLine(p1, cp1, t);
  const b = _pointInLine(cp1, cp2, t);
  const c = _pointInLine(cp2, p2, t);
  const d = _pointInLine(a, b, t);
  const e = _pointInLine(b, c, t);
  return _pointInLine(d, e, t);
}
var getRightToLeftAdapter = function(rectX, width) {
  return {
    x(x) {
      return rectX + rectX + width - x;
    },
    setWidth(w) {
      width = w;
    },
    textAlign(align) {
      if (align === "center") {
        return align;
      }
      return align === "right" ? "left" : "right";
    },
    xPlus(x, value) {
      return x - value;
    },
    leftForLtr(x, itemWidth) {
      return x - itemWidth;
    }
  };
};
var getLeftToRightAdapter = function() {
  return {
    x(x) {
      return x;
    },
    setWidth(w) {
    },
    textAlign(align) {
      return align;
    },
    xPlus(x, value) {
      return x + value;
    },
    leftForLtr(x, _itemWidth) {
      return x;
    }
  };
};
function getRtlAdapter(rtl, rectX, width) {
  return rtl ? getRightToLeftAdapter(rectX, width) : getLeftToRightAdapter();
}
function overrideTextDirection(ctx, direction) {
  let style, original;
  if (direction === "ltr" || direction === "rtl") {
    style = ctx.canvas.style;
    original = [
      style.getPropertyValue("direction"),
      style.getPropertyPriority("direction")
    ];
    style.setProperty("direction", direction, "important");
    ctx.prevTextDirection = original;
  }
}
function restoreTextDirection(ctx, original) {
  if (original !== void 0) {
    delete ctx.prevTextDirection;
    ctx.canvas.style.setProperty("direction", original[0], original[1]);
  }
}
function propertyFn(property) {
  if (property === "angle") {
    return {
      between: _angleBetween,
      compare: _angleDiff,
      normalize: _normalizeAngle
    };
  }
  return {
    between: _isBetween,
    compare: (a, b) => a - b,
    normalize: (x) => x
  };
}
function normalizeSegment({ start, end, count, loop, style }) {
  return {
    start: start % count,
    end: end % count,
    loop: loop && (end - start + 1) % count === 0,
    style
  };
}
function getSegment(segment, points, bounds) {
  const { property, start: startBound, end: endBound } = bounds;
  const { between, normalize } = propertyFn(property);
  const count = points.length;
  let { start, end, loop } = segment;
  let i, ilen;
  if (loop) {
    start += count;
    end += count;
    for (i = 0, ilen = count; i < ilen; ++i) {
      if (!between(normalize(points[start % count][property]), startBound, endBound)) {
        break;
      }
      start--;
      end--;
    }
    start %= count;
    end %= count;
  }
  if (end < start) {
    end += count;
  }
  return {
    start,
    end,
    loop,
    style: segment.style
  };
}
function _boundSegment(segment, points, bounds) {
  if (!bounds) {
    return [
      segment
    ];
  }
  const { property, start: startBound, end: endBound } = bounds;
  const count = points.length;
  const { compare, between, normalize } = propertyFn(property);
  const { start, end, loop, style } = getSegment(segment, points, bounds);
  const result = [];
  let inside = false;
  let subStart = null;
  let value, point, prevValue;
  const startIsBefore = () => between(startBound, prevValue, value) && compare(startBound, prevValue) !== 0;
  const endIsBefore = () => compare(endBound, value) === 0 || between(endBound, prevValue, value);
  const shouldStart = () => inside || startIsBefore();
  const shouldStop = () => !inside || endIsBefore();
  for (let i = start, prev = start; i <= end; ++i) {
    point = points[i % count];
    if (point.skip) {
      continue;
    }
    value = normalize(point[property]);
    if (value === prevValue) {
      continue;
    }
    inside = between(value, startBound, endBound);
    if (subStart === null && shouldStart()) {
      subStart = compare(value, startBound) === 0 ? i : prev;
    }
    if (subStart !== null && shouldStop()) {
      result.push(normalizeSegment({
        start: subStart,
        end: i,
        loop,
        count,
        style
      }));
      subStart = null;
    }
    prev = i;
    prevValue = value;
  }
  if (subStart !== null) {
    result.push(normalizeSegment({
      start: subStart,
      end,
      loop,
      count,
      style
    }));
  }
  return result;
}
function _boundSegments(line, bounds) {
  const result = [];
  const segments = line.segments;
  for (let i = 0; i < segments.length; i++) {
    const sub = _boundSegment(segments[i], line.points, bounds);
    if (sub.length) {
      result.push(...sub);
    }
  }
  return result;
}
function findStartAndEnd(points, count, loop, spanGaps) {
  let start = 0;
  let end = count - 1;
  if (loop && !spanGaps) {
    while (start < count && !points[start].skip) {
      start++;
    }
  }
  while (start < count && points[start].skip) {
    start++;
  }
  start %= count;
  if (loop) {
    end += start;
  }
  while (end > start && points[end % count].skip) {
    end--;
  }
  end %= count;
  return {
    start,
    end
  };
}
function solidSegments(points, start, max, loop) {
  const count = points.length;
  const result = [];
  let last = start;
  let prev = points[start];
  let end;
  for (end = start + 1; end <= max; ++end) {
    const cur = points[end % count];
    if (cur.skip || cur.stop) {
      if (!prev.skip) {
        loop = false;
        result.push({
          start: start % count,
          end: (end - 1) % count,
          loop
        });
        start = last = cur.stop ? end : null;
      }
    } else {
      last = end;
      if (prev.skip) {
        start = end;
      }
    }
    prev = cur;
  }
  if (last !== null) {
    result.push({
      start: start % count,
      end: last % count,
      loop
    });
  }
  return result;
}
function _computeSegments(line, segmentOptions) {
  const points = line.points;
  const spanGaps = line.options.spanGaps;
  const count = points.length;
  if (!count) {
    return [];
  }
  const loop = !!line._loop;
  const { start, end } = findStartAndEnd(points, count, loop, spanGaps);
  if (spanGaps === true) {
    return splitByStyles(line, [
      {
        start,
        end,
        loop
      }
    ], points, segmentOptions);
  }
  const max = end < start ? end + count : end;
  const completeLoop = !!line._fullLoop && start === 0 && end === count - 1;
  return splitByStyles(line, solidSegments(points, start, max, completeLoop), points, segmentOptions);
}
function splitByStyles(line, segments, points, segmentOptions) {
  if (!segmentOptions || !segmentOptions.setContext || !points) {
    return segments;
  }
  return doSplitByStyles(line, segments, points, segmentOptions);
}
function doSplitByStyles(line, segments, points, segmentOptions) {
  const chartContext = line._chart.getContext();
  const baseStyle = readStyle(line.options);
  const { _datasetIndex: datasetIndex, options: { spanGaps } } = line;
  const count = points.length;
  const result = [];
  let prevStyle = baseStyle;
  let start = segments[0].start;
  let i = start;
  function addStyle(s, e, l, st) {
    const dir = spanGaps ? -1 : 1;
    if (s === e) {
      return;
    }
    s += count;
    while (points[s % count].skip) {
      s -= dir;
    }
    while (points[e % count].skip) {
      e += dir;
    }
    if (s % count !== e % count) {
      result.push({
        start: s % count,
        end: e % count,
        loop: l,
        style: st
      });
      prevStyle = st;
      start = e % count;
    }
  }
  for (const segment of segments) {
    start = spanGaps ? start : segment.start;
    let prev = points[start % count];
    let style;
    for (i = start + 1; i <= segment.end; i++) {
      const pt = points[i % count];
      style = readStyle(segmentOptions.setContext(createContext(chartContext, {
        type: "segment",
        p0: prev,
        p1: pt,
        p0DataIndex: (i - 1) % count,
        p1DataIndex: i % count,
        datasetIndex
      })));
      if (styleChanged(style, prevStyle)) {
        addStyle(start, i - 1, segment.loop, prevStyle);
      }
      prev = pt;
      prevStyle = style;
    }
    if (start < i - 1) {
      addStyle(start, i - 1, segment.loop, prevStyle);
    }
  }
  return result;
}
function readStyle(options) {
  return {
    backgroundColor: options.backgroundColor,
    borderCapStyle: options.borderCapStyle,
    borderDash: options.borderDash,
    borderDashOffset: options.borderDashOffset,
    borderJoinStyle: options.borderJoinStyle,
    borderWidth: options.borderWidth,
    borderColor: options.borderColor
  };
}
function styleChanged(style, prevStyle) {
  if (!prevStyle) {
    return false;
  }
  const cache = [];
  const replacer = function(key, value) {
    if (!isPatternOrGradient(value)) {
      return value;
    }
    if (!cache.includes(value)) {
      cache.push(value);
    }
    return cache.indexOf(value);
  };
  return JSON.stringify(style, replacer) !== JSON.stringify(prevStyle, replacer);
}
function getSizeForArea(scale, chartArea, field) {
  return scale.options.clip ? scale[field] : chartArea[field];
}
function getDatasetArea(meta, chartArea) {
  const { xScale, yScale } = meta;
  if (xScale && yScale) {
    return {
      left: getSizeForArea(xScale, chartArea, "left"),
      right: getSizeForArea(xScale, chartArea, "right"),
      top: getSizeForArea(yScale, chartArea, "top"),
      bottom: getSizeForArea(yScale, chartArea, "bottom")
    };
  }
  return chartArea;
}
function getDatasetClipArea(chart, meta) {
  const clip = meta._clip;
  if (clip.disabled) {
    return false;
  }
  const area = getDatasetArea(meta, chart.chartArea);
  return {
    left: clip.left === false ? 0 : area.left - (clip.left === true ? 0 : clip.left),
    right: clip.right === false ? chart.width : area.right + (clip.right === true ? 0 : clip.right),
    top: clip.top === false ? 0 : area.top - (clip.top === true ? 0 : clip.top),
    bottom: clip.bottom === false ? chart.height : area.bottom + (clip.bottom === true ? 0 : clip.bottom)
  };
}

// node_modules/chart.js/dist/chart.js
var Animator = class {
  constructor() {
    this._request = null;
    this._charts = /* @__PURE__ */ new Map();
    this._running = false;
    this._lastDate = void 0;
  }
  _notify(chart, anims, date, type) {
    const callbacks = anims.listeners[type];
    const numSteps = anims.duration;
    callbacks.forEach((fn) => fn({
      chart,
      initial: anims.initial,
      numSteps,
      currentStep: Math.min(date - anims.start, numSteps)
    }));
  }
  _refresh() {
    if (this._request) {
      return;
    }
    this._running = true;
    this._request = requestAnimFrame.call(window, () => {
      this._update();
      this._request = null;
      if (this._running) {
        this._refresh();
      }
    });
  }
  _update(date = Date.now()) {
    let remaining = 0;
    this._charts.forEach((anims, chart) => {
      if (!anims.running || !anims.items.length) {
        return;
      }
      const items = anims.items;
      let i = items.length - 1;
      let draw2 = false;
      let item;
      for (; i >= 0; --i) {
        item = items[i];
        if (item._active) {
          if (item._total > anims.duration) {
            anims.duration = item._total;
          }
          item.tick(date);
          draw2 = true;
        } else {
          items[i] = items[items.length - 1];
          items.pop();
        }
      }
      if (draw2) {
        chart.draw();
        this._notify(chart, anims, date, "progress");
      }
      if (!items.length) {
        anims.running = false;
        this._notify(chart, anims, date, "complete");
        anims.initial = false;
      }
      remaining += items.length;
    });
    this._lastDate = date;
    if (remaining === 0) {
      this._running = false;
    }
  }
  _getAnims(chart) {
    const charts = this._charts;
    let anims = charts.get(chart);
    if (!anims) {
      anims = {
        running: false,
        initial: true,
        items: [],
        listeners: {
          complete: [],
          progress: []
        }
      };
      charts.set(chart, anims);
    }
    return anims;
  }
  listen(chart, event, cb) {
    this._getAnims(chart).listeners[event].push(cb);
  }
  add(chart, items) {
    if (!items || !items.length) {
      return;
    }
    this._getAnims(chart).items.push(...items);
  }
  has(chart) {
    return this._getAnims(chart).items.length > 0;
  }
  start(chart) {
    const anims = this._charts.get(chart);
    if (!anims) {
      return;
    }
    anims.running = true;
    anims.start = Date.now();
    anims.duration = anims.items.reduce((acc, cur) => Math.max(acc, cur._duration), 0);
    this._refresh();
  }
  running(chart) {
    if (!this._running) {
      return false;
    }
    const anims = this._charts.get(chart);
    if (!anims || !anims.running || !anims.items.length) {
      return false;
    }
    return true;
  }
  stop(chart) {
    const anims = this._charts.get(chart);
    if (!anims || !anims.items.length) {
      return;
    }
    const items = anims.items;
    let i = items.length - 1;
    for (; i >= 0; --i) {
      items[i].cancel();
    }
    anims.items = [];
    this._notify(chart, anims, Date.now(), "complete");
  }
  remove(chart) {
    return this._charts.delete(chart);
  }
};
var animator = /* @__PURE__ */ new Animator();
var transparent = "transparent";
var interpolators = {
  boolean(from2, to2, factor) {
    return factor > 0.5 ? to2 : from2;
  },
  color(from2, to2, factor) {
    const c0 = color(from2 || transparent);
    const c1 = c0.valid && color(to2 || transparent);
    return c1 && c1.valid ? c1.mix(c0, factor).hexString() : to2;
  },
  number(from2, to2, factor) {
    return from2 + (to2 - from2) * factor;
  }
};
var Animation = class {
  constructor(cfg, target, prop, to2) {
    const currentValue = target[prop];
    to2 = resolve([
      cfg.to,
      to2,
      currentValue,
      cfg.from
    ]);
    const from2 = resolve([
      cfg.from,
      currentValue,
      to2
    ]);
    this._active = true;
    this._fn = cfg.fn || interpolators[cfg.type || typeof from2];
    this._easing = effects[cfg.easing] || effects.linear;
    this._start = Math.floor(Date.now() + (cfg.delay || 0));
    this._duration = this._total = Math.floor(cfg.duration);
    this._loop = !!cfg.loop;
    this._target = target;
    this._prop = prop;
    this._from = from2;
    this._to = to2;
    this._promises = void 0;
  }
  active() {
    return this._active;
  }
  update(cfg, to2, date) {
    if (this._active) {
      this._notify(false);
      const currentValue = this._target[this._prop];
      const elapsed = date - this._start;
      const remain = this._duration - elapsed;
      this._start = date;
      this._duration = Math.floor(Math.max(remain, cfg.duration));
      this._total += elapsed;
      this._loop = !!cfg.loop;
      this._to = resolve([
        cfg.to,
        to2,
        currentValue,
        cfg.from
      ]);
      this._from = resolve([
        cfg.from,
        currentValue,
        to2
      ]);
    }
  }
  cancel() {
    if (this._active) {
      this.tick(Date.now());
      this._active = false;
      this._notify(false);
    }
  }
  tick(date) {
    const elapsed = date - this._start;
    const duration = this._duration;
    const prop = this._prop;
    const from2 = this._from;
    const loop = this._loop;
    const to2 = this._to;
    let factor;
    this._active = from2 !== to2 && (loop || elapsed < duration);
    if (!this._active) {
      this._target[prop] = to2;
      this._notify(true);
      return;
    }
    if (elapsed < 0) {
      this._target[prop] = from2;
      return;
    }
    factor = elapsed / duration % 2;
    factor = loop && factor > 1 ? 2 - factor : factor;
    factor = this._easing(Math.min(1, Math.max(0, factor)));
    this._target[prop] = this._fn(from2, to2, factor);
  }
  wait() {
    const promises = this._promises || (this._promises = []);
    return new Promise((res, rej) => {
      promises.push({
        res,
        rej
      });
    });
  }
  _notify(resolved) {
    const method = resolved ? "res" : "rej";
    const promises = this._promises || [];
    for (let i = 0; i < promises.length; i++) {
      promises[i][method]();
    }
  }
};
var Animations = class {
  constructor(chart, config) {
    this._chart = chart;
    this._properties = /* @__PURE__ */ new Map();
    this.configure(config);
  }
  configure(config) {
    if (!isObject(config)) {
      return;
    }
    const animationOptions = Object.keys(defaults.animation);
    const animatedProps = this._properties;
    Object.getOwnPropertyNames(config).forEach((key) => {
      const cfg = config[key];
      if (!isObject(cfg)) {
        return;
      }
      const resolved = {};
      for (const option of animationOptions) {
        resolved[option] = cfg[option];
      }
      (isArray(cfg.properties) && cfg.properties || [
        key
      ]).forEach((prop) => {
        if (prop === key || !animatedProps.has(prop)) {
          animatedProps.set(prop, resolved);
        }
      });
    });
  }
  _animateOptions(target, values) {
    const newOptions = values.options;
    const options = resolveTargetOptions(target, newOptions);
    if (!options) {
      return [];
    }
    const animations = this._createAnimations(options, newOptions);
    if (newOptions.$shared) {
      awaitAll(target.options.$animations, newOptions).then(() => {
        target.options = newOptions;
      }, () => {
      });
    }
    return animations;
  }
  _createAnimations(target, values) {
    const animatedProps = this._properties;
    const animations = [];
    const running = target.$animations || (target.$animations = {});
    const props = Object.keys(values);
    const date = Date.now();
    let i;
    for (i = props.length - 1; i >= 0; --i) {
      const prop = props[i];
      if (prop.charAt(0) === "$") {
        continue;
      }
      if (prop === "options") {
        animations.push(...this._animateOptions(target, values));
        continue;
      }
      const value = values[prop];
      let animation = running[prop];
      const cfg = animatedProps.get(prop);
      if (animation) {
        if (cfg && animation.active()) {
          animation.update(cfg, value, date);
          continue;
        } else {
          animation.cancel();
        }
      }
      if (!cfg || !cfg.duration) {
        target[prop] = value;
        continue;
      }
      running[prop] = animation = new Animation(cfg, target, prop, value);
      animations.push(animation);
    }
    return animations;
  }
  update(target, values) {
    if (this._properties.size === 0) {
      Object.assign(target, values);
      return;
    }
    const animations = this._createAnimations(target, values);
    if (animations.length) {
      animator.add(this._chart, animations);
      return true;
    }
  }
};
function awaitAll(animations, properties) {
  const running = [];
  const keys = Object.keys(properties);
  for (let i = 0; i < keys.length; i++) {
    const anim = animations[keys[i]];
    if (anim && anim.active()) {
      running.push(anim.wait());
    }
  }
  return Promise.all(running);
}
function resolveTargetOptions(target, newOptions) {
  if (!newOptions) {
    return;
  }
  let options = target.options;
  if (!options) {
    target.options = newOptions;
    return;
  }
  if (options.$shared) {
    target.options = options = Object.assign({}, options, {
      $shared: false,
      $animations: {}
    });
  }
  return options;
}
function scaleClip(scale, allowedOverflow) {
  const opts = scale && scale.options || {};
  const reverse = opts.reverse;
  const min = opts.min === void 0 ? allowedOverflow : 0;
  const max = opts.max === void 0 ? allowedOverflow : 0;
  return {
    start: reverse ? max : min,
    end: reverse ? min : max
  };
}
function defaultClip(xScale, yScale, allowedOverflow) {
  if (allowedOverflow === false) {
    return false;
  }
  const x = scaleClip(xScale, allowedOverflow);
  const y = scaleClip(yScale, allowedOverflow);
  return {
    top: y.end,
    right: x.end,
    bottom: y.start,
    left: x.start
  };
}
function toClip(value) {
  let t, r, b, l;
  if (isObject(value)) {
    t = value.top;
    r = value.right;
    b = value.bottom;
    l = value.left;
  } else {
    t = r = b = l = value;
  }
  return {
    top: t,
    right: r,
    bottom: b,
    left: l,
    disabled: value === false
  };
}
function getSortedDatasetIndices(chart, filterVisible) {
  const keys = [];
  const metasets = chart._getSortedDatasetMetas(filterVisible);
  let i, ilen;
  for (i = 0, ilen = metasets.length; i < ilen; ++i) {
    keys.push(metasets[i].index);
  }
  return keys;
}
function applyStack(stack, value, dsIndex, options = {}) {
  const keys = stack.keys;
  const singleMode = options.mode === "single";
  let i, ilen, datasetIndex, otherValue;
  if (value === null) {
    return;
  }
  let found = false;
  for (i = 0, ilen = keys.length; i < ilen; ++i) {
    datasetIndex = +keys[i];
    if (datasetIndex === dsIndex) {
      found = true;
      if (options.all) {
        continue;
      }
      break;
    }
    otherValue = stack.values[datasetIndex];
    if (isNumberFinite(otherValue) && (singleMode || value === 0 || sign(value) === sign(otherValue))) {
      value += otherValue;
    }
  }
  if (!found && !options.all) {
    return 0;
  }
  return value;
}
function convertObjectDataToArray(data, meta) {
  const { iScale, vScale } = meta;
  const iAxisKey = iScale.axis === "x" ? "x" : "y";
  const vAxisKey = vScale.axis === "x" ? "x" : "y";
  const keys = Object.keys(data);
  const adata = new Array(keys.length);
  let i, ilen, key;
  for (i = 0, ilen = keys.length; i < ilen; ++i) {
    key = keys[i];
    adata[i] = {
      [iAxisKey]: key,
      [vAxisKey]: data[key]
    };
  }
  return adata;
}
function isStacked(scale, meta) {
  const stacked = scale && scale.options.stacked;
  return stacked || stacked === void 0 && meta.stack !== void 0;
}
function getStackKey(indexScale, valueScale, meta) {
  return `${indexScale.id}.${valueScale.id}.${meta.stack || meta.type}`;
}
function getUserBounds(scale) {
  const { min, max, minDefined, maxDefined } = scale.getUserBounds();
  return {
    min: minDefined ? min : Number.NEGATIVE_INFINITY,
    max: maxDefined ? max : Number.POSITIVE_INFINITY
  };
}
function getOrCreateStack(stacks, stackKey, indexValue) {
  const subStack = stacks[stackKey] || (stacks[stackKey] = {});
  return subStack[indexValue] || (subStack[indexValue] = {});
}
function getLastIndexInStack(stack, vScale, positive, type) {
  for (const meta of vScale.getMatchingVisibleMetas(type).reverse()) {
    const value = stack[meta.index];
    if (positive && value > 0 || !positive && value < 0) {
      return meta.index;
    }
  }
  return null;
}
function updateStacks(controller, parsed) {
  const { chart, _cachedMeta: meta } = controller;
  const stacks = chart._stacks || (chart._stacks = {});
  const { iScale, vScale, index: datasetIndex } = meta;
  const iAxis = iScale.axis;
  const vAxis = vScale.axis;
  const key = getStackKey(iScale, vScale, meta);
  const ilen = parsed.length;
  let stack;
  for (let i = 0; i < ilen; ++i) {
    const item = parsed[i];
    const { [iAxis]: index2, [vAxis]: value } = item;
    const itemStacks = item._stacks || (item._stacks = {});
    stack = itemStacks[vAxis] = getOrCreateStack(stacks, key, index2);
    stack[datasetIndex] = value;
    stack._top = getLastIndexInStack(stack, vScale, true, meta.type);
    stack._bottom = getLastIndexInStack(stack, vScale, false, meta.type);
    const visualValues = stack._visualValues || (stack._visualValues = {});
    visualValues[datasetIndex] = value;
  }
}
function getFirstScaleId(chart, axis) {
  const scales2 = chart.scales;
  return Object.keys(scales2).filter((key) => scales2[key].axis === axis).shift();
}
function createDatasetContext(parent, index2) {
  return createContext(parent, {
    active: false,
    dataset: void 0,
    datasetIndex: index2,
    index: index2,
    mode: "default",
    type: "dataset"
  });
}
function createDataContext(parent, index2, element) {
  return createContext(parent, {
    active: false,
    dataIndex: index2,
    parsed: void 0,
    raw: void 0,
    element,
    index: index2,
    mode: "default",
    type: "data"
  });
}
function clearStacks(meta, items) {
  const datasetIndex = meta.controller.index;
  const axis = meta.vScale && meta.vScale.axis;
  if (!axis) {
    return;
  }
  items = items || meta._parsed;
  for (const parsed of items) {
    const stacks = parsed._stacks;
    if (!stacks || stacks[axis] === void 0 || stacks[axis][datasetIndex] === void 0) {
      return;
    }
    delete stacks[axis][datasetIndex];
    if (stacks[axis]._visualValues !== void 0 && stacks[axis]._visualValues[datasetIndex] !== void 0) {
      delete stacks[axis]._visualValues[datasetIndex];
    }
  }
}
var isDirectUpdateMode = (mode) => mode === "reset" || mode === "none";
var cloneIfNotShared = (cached, shared) => shared ? cached : Object.assign({}, cached);
var createStack = (canStack, meta, chart) => canStack && !meta.hidden && meta._stacked && {
  keys: getSortedDatasetIndices(chart, true),
  values: null
};
var DatasetController = class {
  static defaults = {};
  static datasetElementType = null;
  static dataElementType = null;
  constructor(chart, datasetIndex) {
    this.chart = chart;
    this._ctx = chart.ctx;
    this.index = datasetIndex;
    this._cachedDataOpts = {};
    this._cachedMeta = this.getMeta();
    this._type = this._cachedMeta.type;
    this.options = void 0;
    this._parsing = false;
    this._data = void 0;
    this._objectData = void 0;
    this._sharedOptions = void 0;
    this._drawStart = void 0;
    this._drawCount = void 0;
    this.enableOptionSharing = false;
    this.supportsDecimation = false;
    this.$context = void 0;
    this._syncList = [];
    this.datasetElementType = new.target.datasetElementType;
    this.dataElementType = new.target.dataElementType;
    this.initialize();
  }
  initialize() {
    const meta = this._cachedMeta;
    this.configure();
    this.linkScales();
    meta._stacked = isStacked(meta.vScale, meta);
    this.addElements();
    if (this.options.fill && !this.chart.isPluginEnabled("filler")) {
      console.warn("Tried to use the 'fill' option without the 'Filler' plugin enabled. Please import and register the 'Filler' plugin and make sure it is not disabled in the options");
    }
  }
  updateIndex(datasetIndex) {
    if (this.index !== datasetIndex) {
      clearStacks(this._cachedMeta);
    }
    this.index = datasetIndex;
  }
  linkScales() {
    const chart = this.chart;
    const meta = this._cachedMeta;
    const dataset = this.getDataset();
    const chooseId = (axis, x, y, r) => axis === "x" ? x : axis === "r" ? r : y;
    const xid = meta.xAxisID = valueOrDefault(dataset.xAxisID, getFirstScaleId(chart, "x"));
    const yid = meta.yAxisID = valueOrDefault(dataset.yAxisID, getFirstScaleId(chart, "y"));
    const rid = meta.rAxisID = valueOrDefault(dataset.rAxisID, getFirstScaleId(chart, "r"));
    const indexAxis = meta.indexAxis;
    const iid = meta.iAxisID = chooseId(indexAxis, xid, yid, rid);
    const vid = meta.vAxisID = chooseId(indexAxis, yid, xid, rid);
    meta.xScale = this.getScaleForId(xid);
    meta.yScale = this.getScaleForId(yid);
    meta.rScale = this.getScaleForId(rid);
    meta.iScale = this.getScaleForId(iid);
    meta.vScale = this.getScaleForId(vid);
  }
  getDataset() {
    return this.chart.data.datasets[this.index];
  }
  getMeta() {
    return this.chart.getDatasetMeta(this.index);
  }
  getScaleForId(scaleID) {
    return this.chart.scales[scaleID];
  }
  _getOtherScale(scale) {
    const meta = this._cachedMeta;
    return scale === meta.iScale ? meta.vScale : meta.iScale;
  }
  reset() {
    this._update("reset");
  }
  _destroy() {
    const meta = this._cachedMeta;
    if (this._data) {
      unlistenArrayEvents(this._data, this);
    }
    if (meta._stacked) {
      clearStacks(meta);
    }
  }
  _dataCheck() {
    const dataset = this.getDataset();
    const data = dataset.data || (dataset.data = []);
    const _data = this._data;
    if (isObject(data)) {
      const meta = this._cachedMeta;
      this._data = convertObjectDataToArray(data, meta);
    } else if (_data !== data) {
      if (_data) {
        unlistenArrayEvents(_data, this);
        const meta = this._cachedMeta;
        clearStacks(meta);
        meta._parsed = [];
      }
      if (data && Object.isExtensible(data)) {
        listenArrayEvents(data, this);
      }
      this._syncList = [];
      this._data = data;
    }
  }
  addElements() {
    const meta = this._cachedMeta;
    this._dataCheck();
    if (this.datasetElementType) {
      meta.dataset = new this.datasetElementType();
    }
  }
  buildOrUpdateElements(resetNewElements) {
    const meta = this._cachedMeta;
    const dataset = this.getDataset();
    let stackChanged = false;
    this._dataCheck();
    const oldStacked = meta._stacked;
    meta._stacked = isStacked(meta.vScale, meta);
    if (meta.stack !== dataset.stack) {
      stackChanged = true;
      clearStacks(meta);
      meta.stack = dataset.stack;
    }
    this._resyncElements(resetNewElements);
    if (stackChanged || oldStacked !== meta._stacked) {
      updateStacks(this, meta._parsed);
      meta._stacked = isStacked(meta.vScale, meta);
    }
  }
  configure() {
    const config = this.chart.config;
    const scopeKeys = config.datasetScopeKeys(this._type);
    const scopes = config.getOptionScopes(this.getDataset(), scopeKeys, true);
    this.options = config.createResolver(scopes, this.getContext());
    this._parsing = this.options.parsing;
    this._cachedDataOpts = {};
  }
  parse(start, count) {
    const { _cachedMeta: meta, _data: data } = this;
    const { iScale, _stacked } = meta;
    const iAxis = iScale.axis;
    let sorted = start === 0 && count === data.length ? true : meta._sorted;
    let prev = start > 0 && meta._parsed[start - 1];
    let i, cur, parsed;
    if (this._parsing === false) {
      meta._parsed = data;
      meta._sorted = true;
      parsed = data;
    } else {
      if (isArray(data[start])) {
        parsed = this.parseArrayData(meta, data, start, count);
      } else if (isObject(data[start])) {
        parsed = this.parseObjectData(meta, data, start, count);
      } else {
        parsed = this.parsePrimitiveData(meta, data, start, count);
      }
      const isNotInOrderComparedToPrev = () => cur[iAxis] === null || prev && cur[iAxis] < prev[iAxis];
      for (i = 0; i < count; ++i) {
        meta._parsed[i + start] = cur = parsed[i];
        if (sorted) {
          if (isNotInOrderComparedToPrev()) {
            sorted = false;
          }
          prev = cur;
        }
      }
      meta._sorted = sorted;
    }
    if (_stacked) {
      updateStacks(this, parsed);
    }
  }
  parsePrimitiveData(meta, data, start, count) {
    const { iScale, vScale } = meta;
    const iAxis = iScale.axis;
    const vAxis = vScale.axis;
    const labels = iScale.getLabels();
    const singleScale = iScale === vScale;
    const parsed = new Array(count);
    let i, ilen, index2;
    for (i = 0, ilen = count; i < ilen; ++i) {
      index2 = i + start;
      parsed[i] = {
        [iAxis]: singleScale || iScale.parse(labels[index2], index2),
        [vAxis]: vScale.parse(data[index2], index2)
      };
    }
    return parsed;
  }
  parseArrayData(meta, data, start, count) {
    const { xScale, yScale } = meta;
    const parsed = new Array(count);
    let i, ilen, index2, item;
    for (i = 0, ilen = count; i < ilen; ++i) {
      index2 = i + start;
      item = data[index2];
      parsed[i] = {
        x: xScale.parse(item[0], index2),
        y: yScale.parse(item[1], index2)
      };
    }
    return parsed;
  }
  parseObjectData(meta, data, start, count) {
    const { xScale, yScale } = meta;
    const { xAxisKey = "x", yAxisKey = "y" } = this._parsing;
    const parsed = new Array(count);
    let i, ilen, index2, item;
    for (i = 0, ilen = count; i < ilen; ++i) {
      index2 = i + start;
      item = data[index2];
      parsed[i] = {
        x: xScale.parse(resolveObjectKey(item, xAxisKey), index2),
        y: yScale.parse(resolveObjectKey(item, yAxisKey), index2)
      };
    }
    return parsed;
  }
  getParsed(index2) {
    return this._cachedMeta._parsed[index2];
  }
  getDataElement(index2) {
    return this._cachedMeta.data[index2];
  }
  applyStack(scale, parsed, mode) {
    const chart = this.chart;
    const meta = this._cachedMeta;
    const value = parsed[scale.axis];
    const stack = {
      keys: getSortedDatasetIndices(chart, true),
      values: parsed._stacks[scale.axis]._visualValues
    };
    return applyStack(stack, value, meta.index, {
      mode
    });
  }
  updateRangeFromParsed(range, scale, parsed, stack) {
    const parsedValue = parsed[scale.axis];
    let value = parsedValue === null ? NaN : parsedValue;
    const values = stack && parsed._stacks[scale.axis];
    if (stack && values) {
      stack.values = values;
      value = applyStack(stack, parsedValue, this._cachedMeta.index);
    }
    range.min = Math.min(range.min, value);
    range.max = Math.max(range.max, value);
  }
  getMinMax(scale, canStack) {
    const meta = this._cachedMeta;
    const _parsed = meta._parsed;
    const sorted = meta._sorted && scale === meta.iScale;
    const ilen = _parsed.length;
    const otherScale = this._getOtherScale(scale);
    const stack = createStack(canStack, meta, this.chart);
    const range = {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY
    };
    const { min: otherMin, max: otherMax } = getUserBounds(otherScale);
    let i, parsed;
    function _skip() {
      parsed = _parsed[i];
      const otherValue = parsed[otherScale.axis];
      return !isNumberFinite(parsed[scale.axis]) || otherMin > otherValue || otherMax < otherValue;
    }
    for (i = 0; i < ilen; ++i) {
      if (_skip()) {
        continue;
      }
      this.updateRangeFromParsed(range, scale, parsed, stack);
      if (sorted) {
        break;
      }
    }
    if (sorted) {
      for (i = ilen - 1; i >= 0; --i) {
        if (_skip()) {
          continue;
        }
        this.updateRangeFromParsed(range, scale, parsed, stack);
        break;
      }
    }
    return range;
  }
  getAllParsedValues(scale) {
    const parsed = this._cachedMeta._parsed;
    const values = [];
    let i, ilen, value;
    for (i = 0, ilen = parsed.length; i < ilen; ++i) {
      value = parsed[i][scale.axis];
      if (isNumberFinite(value)) {
        values.push(value);
      }
    }
    return values;
  }
  getMaxOverflow() {
    return false;
  }
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const iScale = meta.iScale;
    const vScale = meta.vScale;
    const parsed = this.getParsed(index2);
    return {
      label: iScale ? "" + iScale.getLabelForValue(parsed[iScale.axis]) : "",
      value: vScale ? "" + vScale.getLabelForValue(parsed[vScale.axis]) : ""
    };
  }
  _update(mode) {
    const meta = this._cachedMeta;
    this.update(mode || "default");
    meta._clip = toClip(valueOrDefault(this.options.clip, defaultClip(meta.xScale, meta.yScale, this.getMaxOverflow())));
  }
  update(mode) {
  }
  draw() {
    const ctx = this._ctx;
    const chart = this.chart;
    const meta = this._cachedMeta;
    const elements2 = meta.data || [];
    const area = chart.chartArea;
    const active = [];
    const start = this._drawStart || 0;
    const count = this._drawCount || elements2.length - start;
    const drawActiveElementsOnTop = this.options.drawActiveElementsOnTop;
    let i;
    if (meta.dataset) {
      meta.dataset.draw(ctx, area, start, count);
    }
    for (i = start; i < start + count; ++i) {
      const element = elements2[i];
      if (element.hidden) {
        continue;
      }
      if (element.active && drawActiveElementsOnTop) {
        active.push(element);
      } else {
        element.draw(ctx, area);
      }
    }
    for (i = 0; i < active.length; ++i) {
      active[i].draw(ctx, area);
    }
  }
  getStyle(index2, active) {
    const mode = active ? "active" : "default";
    return index2 === void 0 && this._cachedMeta.dataset ? this.resolveDatasetElementOptions(mode) : this.resolveDataElementOptions(index2 || 0, mode);
  }
  getContext(index2, active, mode) {
    const dataset = this.getDataset();
    let context;
    if (index2 >= 0 && index2 < this._cachedMeta.data.length) {
      const element = this._cachedMeta.data[index2];
      context = element.$context || (element.$context = createDataContext(this.getContext(), index2, element));
      context.parsed = this.getParsed(index2);
      context.raw = dataset.data[index2];
      context.index = context.dataIndex = index2;
    } else {
      context = this.$context || (this.$context = createDatasetContext(this.chart.getContext(), this.index));
      context.dataset = dataset;
      context.index = context.datasetIndex = this.index;
    }
    context.active = !!active;
    context.mode = mode;
    return context;
  }
  resolveDatasetElementOptions(mode) {
    return this._resolveElementOptions(this.datasetElementType.id, mode);
  }
  resolveDataElementOptions(index2, mode) {
    return this._resolveElementOptions(this.dataElementType.id, mode, index2);
  }
  _resolveElementOptions(elementType, mode = "default", index2) {
    const active = mode === "active";
    const cache = this._cachedDataOpts;
    const cacheKey = elementType + "-" + mode;
    const cached = cache[cacheKey];
    const sharing = this.enableOptionSharing && defined(index2);
    if (cached) {
      return cloneIfNotShared(cached, sharing);
    }
    const config = this.chart.config;
    const scopeKeys = config.datasetElementScopeKeys(this._type, elementType);
    const prefixes = active ? [
      `${elementType}Hover`,
      "hover",
      elementType,
      ""
    ] : [
      elementType,
      ""
    ];
    const scopes = config.getOptionScopes(this.getDataset(), scopeKeys);
    const names2 = Object.keys(defaults.elements[elementType]);
    const context = () => this.getContext(index2, active, mode);
    const values = config.resolveNamedOptions(scopes, names2, context, prefixes);
    if (values.$shared) {
      values.$shared = sharing;
      cache[cacheKey] = Object.freeze(cloneIfNotShared(values, sharing));
    }
    return values;
  }
  _resolveAnimations(index2, transition, active) {
    const chart = this.chart;
    const cache = this._cachedDataOpts;
    const cacheKey = `animation-${transition}`;
    const cached = cache[cacheKey];
    if (cached) {
      return cached;
    }
    let options;
    if (chart.options.animation !== false) {
      const config = this.chart.config;
      const scopeKeys = config.datasetAnimationScopeKeys(this._type, transition);
      const scopes = config.getOptionScopes(this.getDataset(), scopeKeys);
      options = config.createResolver(scopes, this.getContext(index2, active, transition));
    }
    const animations = new Animations(chart, options && options.animations);
    if (options && options._cacheable) {
      cache[cacheKey] = Object.freeze(animations);
    }
    return animations;
  }
  getSharedOptions(options) {
    if (!options.$shared) {
      return;
    }
    return this._sharedOptions || (this._sharedOptions = Object.assign({}, options));
  }
  includeOptions(mode, sharedOptions) {
    return !sharedOptions || isDirectUpdateMode(mode) || this.chart._animationsDisabled;
  }
  _getSharedOptions(start, mode) {
    const firstOpts = this.resolveDataElementOptions(start, mode);
    const previouslySharedOptions = this._sharedOptions;
    const sharedOptions = this.getSharedOptions(firstOpts);
    const includeOptions = this.includeOptions(mode, sharedOptions) || sharedOptions !== previouslySharedOptions;
    this.updateSharedOptions(sharedOptions, mode, firstOpts);
    return {
      sharedOptions,
      includeOptions
    };
  }
  updateElement(element, index2, properties, mode) {
    if (isDirectUpdateMode(mode)) {
      Object.assign(element, properties);
    } else {
      this._resolveAnimations(index2, mode).update(element, properties);
    }
  }
  updateSharedOptions(sharedOptions, mode, newOptions) {
    if (sharedOptions && !isDirectUpdateMode(mode)) {
      this._resolveAnimations(void 0, mode).update(sharedOptions, newOptions);
    }
  }
  _setStyle(element, index2, mode, active) {
    element.active = active;
    const options = this.getStyle(index2, active);
    this._resolveAnimations(index2, mode, active).update(element, {
      options: !active && this.getSharedOptions(options) || options
    });
  }
  removeHoverStyle(element, datasetIndex, index2) {
    this._setStyle(element, index2, "active", false);
  }
  setHoverStyle(element, datasetIndex, index2) {
    this._setStyle(element, index2, "active", true);
  }
  _removeDatasetHoverStyle() {
    const element = this._cachedMeta.dataset;
    if (element) {
      this._setStyle(element, void 0, "active", false);
    }
  }
  _setDatasetHoverStyle() {
    const element = this._cachedMeta.dataset;
    if (element) {
      this._setStyle(element, void 0, "active", true);
    }
  }
  _resyncElements(resetNewElements) {
    const data = this._data;
    const elements2 = this._cachedMeta.data;
    for (const [method, arg1, arg2] of this._syncList) {
      this[method](arg1, arg2);
    }
    this._syncList = [];
    const numMeta = elements2.length;
    const numData = data.length;
    const count = Math.min(numData, numMeta);
    if (count) {
      this.parse(0, count);
    }
    if (numData > numMeta) {
      this._insertElements(numMeta, numData - numMeta, resetNewElements);
    } else if (numData < numMeta) {
      this._removeElements(numData, numMeta - numData);
    }
  }
  _insertElements(start, count, resetNewElements = true) {
    const meta = this._cachedMeta;
    const data = meta.data;
    const end = start + count;
    let i;
    const move = (arr) => {
      arr.length += count;
      for (i = arr.length - 1; i >= end; i--) {
        arr[i] = arr[i - count];
      }
    };
    move(data);
    for (i = start; i < end; ++i) {
      data[i] = new this.dataElementType();
    }
    if (this._parsing) {
      move(meta._parsed);
    }
    this.parse(start, count);
    if (resetNewElements) {
      this.updateElements(data, start, count, "reset");
    }
  }
  updateElements(element, start, count, mode) {
  }
  _removeElements(start, count) {
    const meta = this._cachedMeta;
    if (this._parsing) {
      const removed = meta._parsed.splice(start, count);
      if (meta._stacked) {
        clearStacks(meta, removed);
      }
    }
    meta.data.splice(start, count);
  }
  _sync(args) {
    if (this._parsing) {
      this._syncList.push(args);
    } else {
      const [method, arg1, arg2] = args;
      this[method](arg1, arg2);
    }
    this.chart._dataChanges.push([
      this.index,
      ...args
    ]);
  }
  _onDataPush() {
    const count = arguments.length;
    this._sync([
      "_insertElements",
      this.getDataset().data.length - count,
      count
    ]);
  }
  _onDataPop() {
    this._sync([
      "_removeElements",
      this._cachedMeta.data.length - 1,
      1
    ]);
  }
  _onDataShift() {
    this._sync([
      "_removeElements",
      0,
      1
    ]);
  }
  _onDataSplice(start, count) {
    if (count) {
      this._sync([
        "_removeElements",
        start,
        count
      ]);
    }
    const newCount = arguments.length - 2;
    if (newCount) {
      this._sync([
        "_insertElements",
        start,
        newCount
      ]);
    }
  }
  _onDataUnshift() {
    this._sync([
      "_insertElements",
      0,
      arguments.length
    ]);
  }
};
function getAllScaleValues(scale, type) {
  if (!scale._cache.$bar) {
    const visibleMetas = scale.getMatchingVisibleMetas(type);
    let values = [];
    for (let i = 0, ilen = visibleMetas.length; i < ilen; i++) {
      values = values.concat(visibleMetas[i].controller.getAllParsedValues(scale));
    }
    scale._cache.$bar = _arrayUnique(values.sort((a, b) => a - b));
  }
  return scale._cache.$bar;
}
function computeMinSampleSize(meta) {
  const scale = meta.iScale;
  const values = getAllScaleValues(scale, meta.type);
  let min = scale._length;
  let i, ilen, curr, prev;
  const updateMinAndPrev = () => {
    if (curr === 32767 || curr === -32768) {
      return;
    }
    if (defined(prev)) {
      min = Math.min(min, Math.abs(curr - prev) || min);
    }
    prev = curr;
  };
  for (i = 0, ilen = values.length; i < ilen; ++i) {
    curr = scale.getPixelForValue(values[i]);
    updateMinAndPrev();
  }
  prev = void 0;
  for (i = 0, ilen = scale.ticks.length; i < ilen; ++i) {
    curr = scale.getPixelForTick(i);
    updateMinAndPrev();
  }
  return min;
}
function computeFitCategoryTraits(index2, ruler, options, stackCount) {
  const thickness = options.barThickness;
  let size, ratio;
  if (isNullOrUndef(thickness)) {
    size = ruler.min * options.categoryPercentage;
    ratio = options.barPercentage;
  } else {
    size = thickness * stackCount;
    ratio = 1;
  }
  return {
    chunk: size / stackCount,
    ratio,
    start: ruler.pixels[index2] - size / 2
  };
}
function computeFlexCategoryTraits(index2, ruler, options, stackCount) {
  const pixels = ruler.pixels;
  const curr = pixels[index2];
  let prev = index2 > 0 ? pixels[index2 - 1] : null;
  let next = index2 < pixels.length - 1 ? pixels[index2 + 1] : null;
  const percent = options.categoryPercentage;
  if (prev === null) {
    prev = curr - (next === null ? ruler.end - ruler.start : next - curr);
  }
  if (next === null) {
    next = curr + curr - prev;
  }
  const start = curr - (curr - Math.min(prev, next)) / 2 * percent;
  const size = Math.abs(next - prev) / 2 * percent;
  return {
    chunk: size / stackCount,
    ratio: options.barPercentage,
    start
  };
}
function parseFloatBar(entry, item, vScale, i) {
  const startValue = vScale.parse(entry[0], i);
  const endValue = vScale.parse(entry[1], i);
  const min = Math.min(startValue, endValue);
  const max = Math.max(startValue, endValue);
  let barStart = min;
  let barEnd = max;
  if (Math.abs(min) > Math.abs(max)) {
    barStart = max;
    barEnd = min;
  }
  item[vScale.axis] = barEnd;
  item._custom = {
    barStart,
    barEnd,
    start: startValue,
    end: endValue,
    min,
    max
  };
}
function parseValue(entry, item, vScale, i) {
  if (isArray(entry)) {
    parseFloatBar(entry, item, vScale, i);
  } else {
    item[vScale.axis] = vScale.parse(entry, i);
  }
  return item;
}
function parseArrayOrPrimitive(meta, data, start, count) {
  const iScale = meta.iScale;
  const vScale = meta.vScale;
  const labels = iScale.getLabels();
  const singleScale = iScale === vScale;
  const parsed = [];
  let i, ilen, item, entry;
  for (i = start, ilen = start + count; i < ilen; ++i) {
    entry = data[i];
    item = {};
    item[iScale.axis] = singleScale || iScale.parse(labels[i], i);
    parsed.push(parseValue(entry, item, vScale, i));
  }
  return parsed;
}
function isFloatBar(custom) {
  return custom && custom.barStart !== void 0 && custom.barEnd !== void 0;
}
function barSign(size, vScale, actualBase) {
  if (size !== 0) {
    return sign(size);
  }
  return (vScale.isHorizontal() ? 1 : -1) * (vScale.min >= actualBase ? 1 : -1);
}
function borderProps(properties) {
  let reverse, start, end, top, bottom;
  if (properties.horizontal) {
    reverse = properties.base > properties.x;
    start = "left";
    end = "right";
  } else {
    reverse = properties.base < properties.y;
    start = "bottom";
    end = "top";
  }
  if (reverse) {
    top = "end";
    bottom = "start";
  } else {
    top = "start";
    bottom = "end";
  }
  return {
    start,
    end,
    reverse,
    top,
    bottom
  };
}
function setBorderSkipped(properties, options, stack, index2) {
  let edge = options.borderSkipped;
  const res = {};
  if (!edge) {
    properties.borderSkipped = res;
    return;
  }
  if (edge === true) {
    properties.borderSkipped = {
      top: true,
      right: true,
      bottom: true,
      left: true
    };
    return;
  }
  const { start, end, reverse, top, bottom } = borderProps(properties);
  if (edge === "middle" && stack) {
    properties.enableBorderRadius = true;
    if ((stack._top || 0) === index2) {
      edge = top;
    } else if ((stack._bottom || 0) === index2) {
      edge = bottom;
    } else {
      res[parseEdge(bottom, start, end, reverse)] = true;
      edge = top;
    }
  }
  res[parseEdge(edge, start, end, reverse)] = true;
  properties.borderSkipped = res;
}
function parseEdge(edge, a, b, reverse) {
  if (reverse) {
    edge = swap(edge, a, b);
    edge = startEnd(edge, b, a);
  } else {
    edge = startEnd(edge, a, b);
  }
  return edge;
}
function swap(orig, v1, v2) {
  return orig === v1 ? v2 : orig === v2 ? v1 : orig;
}
function startEnd(v, start, end) {
  return v === "start" ? start : v === "end" ? end : v;
}
function setInflateAmount(properties, { inflateAmount }, ratio) {
  properties.inflateAmount = inflateAmount === "auto" ? ratio === 1 ? 0.33 : 0 : inflateAmount;
}
var BarController = class extends DatasetController {
  static id = "bar";
  static defaults = {
    datasetElementType: false,
    dataElementType: "bar",
    categoryPercentage: 0.8,
    barPercentage: 0.9,
    grouped: true,
    animations: {
      numbers: {
        type: "number",
        properties: [
          "x",
          "y",
          "base",
          "width",
          "height"
        ]
      }
    }
  };
  static overrides = {
    scales: {
      _index_: {
        type: "category",
        offset: true,
        grid: {
          offset: true
        }
      },
      _value_: {
        type: "linear",
        beginAtZero: true
      }
    }
  };
  parsePrimitiveData(meta, data, start, count) {
    return parseArrayOrPrimitive(meta, data, start, count);
  }
  parseArrayData(meta, data, start, count) {
    return parseArrayOrPrimitive(meta, data, start, count);
  }
  parseObjectData(meta, data, start, count) {
    const { iScale, vScale } = meta;
    const { xAxisKey = "x", yAxisKey = "y" } = this._parsing;
    const iAxisKey = iScale.axis === "x" ? xAxisKey : yAxisKey;
    const vAxisKey = vScale.axis === "x" ? xAxisKey : yAxisKey;
    const parsed = [];
    let i, ilen, item, obj;
    for (i = start, ilen = start + count; i < ilen; ++i) {
      obj = data[i];
      item = {};
      item[iScale.axis] = iScale.parse(resolveObjectKey(obj, iAxisKey), i);
      parsed.push(parseValue(resolveObjectKey(obj, vAxisKey), item, vScale, i));
    }
    return parsed;
  }
  updateRangeFromParsed(range, scale, parsed, stack) {
    super.updateRangeFromParsed(range, scale, parsed, stack);
    const custom = parsed._custom;
    if (custom && scale === this._cachedMeta.vScale) {
      range.min = Math.min(range.min, custom.min);
      range.max = Math.max(range.max, custom.max);
    }
  }
  getMaxOverflow() {
    return 0;
  }
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const { iScale, vScale } = meta;
    const parsed = this.getParsed(index2);
    const custom = parsed._custom;
    const value = isFloatBar(custom) ? "[" + custom.start + ", " + custom.end + "]" : "" + vScale.getLabelForValue(parsed[vScale.axis]);
    return {
      label: "" + iScale.getLabelForValue(parsed[iScale.axis]),
      value
    };
  }
  initialize() {
    this.enableOptionSharing = true;
    super.initialize();
    const meta = this._cachedMeta;
    meta.stack = this.getDataset().stack;
  }
  update(mode) {
    const meta = this._cachedMeta;
    this.updateElements(meta.data, 0, meta.data.length, mode);
  }
  updateElements(bars, start, count, mode) {
    const reset = mode === "reset";
    const { index: index2, _cachedMeta: { vScale } } = this;
    const base = vScale.getBasePixel();
    const horizontal = vScale.isHorizontal();
    const ruler = this._getRuler();
    const { sharedOptions, includeOptions } = this._getSharedOptions(start, mode);
    for (let i = start; i < start + count; i++) {
      const parsed = this.getParsed(i);
      const vpixels = reset || isNullOrUndef(parsed[vScale.axis]) ? {
        base,
        head: base
      } : this._calculateBarValuePixels(i);
      const ipixels = this._calculateBarIndexPixels(i, ruler);
      const stack = (parsed._stacks || {})[vScale.axis];
      const properties = {
        horizontal,
        base: vpixels.base,
        enableBorderRadius: !stack || isFloatBar(parsed._custom) || index2 === stack._top || index2 === stack._bottom,
        x: horizontal ? vpixels.head : ipixels.center,
        y: horizontal ? ipixels.center : vpixels.head,
        height: horizontal ? ipixels.size : Math.abs(vpixels.size),
        width: horizontal ? Math.abs(vpixels.size) : ipixels.size
      };
      if (includeOptions) {
        properties.options = sharedOptions || this.resolveDataElementOptions(i, bars[i].active ? "active" : mode);
      }
      const options = properties.options || bars[i].options;
      setBorderSkipped(properties, options, stack, index2);
      setInflateAmount(properties, options, ruler.ratio);
      this.updateElement(bars[i], i, properties, mode);
    }
  }
  _getStacks(last, dataIndex) {
    const { iScale } = this._cachedMeta;
    const metasets = iScale.getMatchingVisibleMetas(this._type).filter((meta) => meta.controller.options.grouped);
    const stacked = iScale.options.stacked;
    const stacks = [];
    const currentParsed = this._cachedMeta.controller.getParsed(dataIndex);
    const iScaleValue = currentParsed && currentParsed[iScale.axis];
    const skipNull = (meta) => {
      const parsed = meta._parsed.find((item) => item[iScale.axis] === iScaleValue);
      const val = parsed && parsed[meta.vScale.axis];
      if (isNullOrUndef(val) || isNaN(val)) {
        return true;
      }
    };
    for (const meta of metasets) {
      if (dataIndex !== void 0 && skipNull(meta)) {
        continue;
      }
      if (stacked === false || stacks.indexOf(meta.stack) === -1 || stacked === void 0 && meta.stack === void 0) {
        stacks.push(meta.stack);
      }
      if (meta.index === last) {
        break;
      }
    }
    if (!stacks.length) {
      stacks.push(void 0);
    }
    return stacks;
  }
  _getStackCount(index2) {
    return this._getStacks(void 0, index2).length;
  }
  _getAxisCount() {
    return this._getAxis().length;
  }
  getFirstScaleIdForIndexAxis() {
    const scales2 = this.chart.scales;
    const indexScaleId = this.chart.options.indexAxis;
    return Object.keys(scales2).filter((key) => scales2[key].axis === indexScaleId).shift();
  }
  _getAxis() {
    const axis = {};
    const firstScaleAxisId = this.getFirstScaleIdForIndexAxis();
    for (const dataset of this.chart.data.datasets) {
      axis[valueOrDefault(this.chart.options.indexAxis === "x" ? dataset.xAxisID : dataset.yAxisID, firstScaleAxisId)] = true;
    }
    return Object.keys(axis);
  }
  _getStackIndex(datasetIndex, name, dataIndex) {
    const stacks = this._getStacks(datasetIndex, dataIndex);
    const index2 = name !== void 0 ? stacks.indexOf(name) : -1;
    return index2 === -1 ? stacks.length - 1 : index2;
  }
  _getRuler() {
    const opts = this.options;
    const meta = this._cachedMeta;
    const iScale = meta.iScale;
    const pixels = [];
    let i, ilen;
    for (i = 0, ilen = meta.data.length; i < ilen; ++i) {
      pixels.push(iScale.getPixelForValue(this.getParsed(i)[iScale.axis], i));
    }
    const barThickness = opts.barThickness;
    const min = barThickness || computeMinSampleSize(meta);
    return {
      min,
      pixels,
      start: iScale._startPixel,
      end: iScale._endPixel,
      stackCount: this._getStackCount(),
      scale: iScale,
      grouped: opts.grouped,
      ratio: barThickness ? 1 : opts.categoryPercentage * opts.barPercentage
    };
  }
  _calculateBarValuePixels(index2) {
    const { _cachedMeta: { vScale, _stacked, index: datasetIndex }, options: { base: baseValue, minBarLength } } = this;
    const actualBase = baseValue || 0;
    const parsed = this.getParsed(index2);
    const custom = parsed._custom;
    const floating = isFloatBar(custom);
    let value = parsed[vScale.axis];
    let start = 0;
    let length = _stacked ? this.applyStack(vScale, parsed, _stacked) : value;
    let head, size;
    if (length !== value) {
      start = length - value;
      length = value;
    }
    if (floating) {
      value = custom.barStart;
      length = custom.barEnd - custom.barStart;
      if (value !== 0 && sign(value) !== sign(custom.barEnd)) {
        start = 0;
      }
      start += value;
    }
    const startValue = !isNullOrUndef(baseValue) && !floating ? baseValue : start;
    let base = vScale.getPixelForValue(startValue);
    if (this.chart.getDataVisibility(index2)) {
      head = vScale.getPixelForValue(start + length);
    } else {
      head = base;
    }
    size = head - base;
    if (Math.abs(size) < minBarLength) {
      size = barSign(size, vScale, actualBase) * minBarLength;
      if (value === actualBase) {
        base -= size / 2;
      }
      const startPixel = vScale.getPixelForDecimal(0);
      const endPixel = vScale.getPixelForDecimal(1);
      const min = Math.min(startPixel, endPixel);
      const max = Math.max(startPixel, endPixel);
      base = Math.max(Math.min(base, max), min);
      head = base + size;
      if (_stacked && !floating) {
        parsed._stacks[vScale.axis]._visualValues[datasetIndex] = vScale.getValueForPixel(head) - vScale.getValueForPixel(base);
      }
    }
    if (base === vScale.getPixelForValue(actualBase)) {
      const halfGrid = sign(size) * vScale.getLineWidthForValue(actualBase) / 2;
      base += halfGrid;
      size -= halfGrid;
    }
    return {
      size,
      base,
      head,
      center: head + size / 2
    };
  }
  _calculateBarIndexPixels(index2, ruler) {
    const scale = ruler.scale;
    const options = this.options;
    const skipNull = options.skipNull;
    const maxBarThickness = valueOrDefault(options.maxBarThickness, Infinity);
    let center, size;
    const axisCount = this._getAxisCount();
    if (ruler.grouped) {
      const stackCount = skipNull ? this._getStackCount(index2) : ruler.stackCount;
      const range = options.barThickness === "flex" ? computeFlexCategoryTraits(index2, ruler, options, stackCount * axisCount) : computeFitCategoryTraits(index2, ruler, options, stackCount * axisCount);
      const axisID = this.chart.options.indexAxis === "x" ? this.getDataset().xAxisID : this.getDataset().yAxisID;
      const axisNumber = this._getAxis().indexOf(valueOrDefault(axisID, this.getFirstScaleIdForIndexAxis()));
      const stackIndex = this._getStackIndex(this.index, this._cachedMeta.stack, skipNull ? index2 : void 0) + axisNumber;
      center = range.start + range.chunk * stackIndex + range.chunk / 2;
      size = Math.min(maxBarThickness, range.chunk * range.ratio);
    } else {
      center = scale.getPixelForValue(this.getParsed(index2)[scale.axis], index2);
      size = Math.min(maxBarThickness, ruler.min * ruler.ratio);
    }
    return {
      base: center - size / 2,
      head: center + size / 2,
      center,
      size
    };
  }
  draw() {
    const meta = this._cachedMeta;
    const vScale = meta.vScale;
    const rects = meta.data;
    const ilen = rects.length;
    let i = 0;
    for (; i < ilen; ++i) {
      if (this.getParsed(i)[vScale.axis] !== null && !rects[i].hidden) {
        rects[i].draw(this._ctx);
      }
    }
  }
};
var BubbleController = class extends DatasetController {
  static id = "bubble";
  static defaults = {
    datasetElementType: false,
    dataElementType: "point",
    animations: {
      numbers: {
        type: "number",
        properties: [
          "x",
          "y",
          "borderWidth",
          "radius"
        ]
      }
    }
  };
  static overrides = {
    scales: {
      x: {
        type: "linear"
      },
      y: {
        type: "linear"
      }
    }
  };
  initialize() {
    this.enableOptionSharing = true;
    super.initialize();
  }
  parsePrimitiveData(meta, data, start, count) {
    const parsed = super.parsePrimitiveData(meta, data, start, count);
    for (let i = 0; i < parsed.length; i++) {
      parsed[i]._custom = this.resolveDataElementOptions(i + start).radius;
    }
    return parsed;
  }
  parseArrayData(meta, data, start, count) {
    const parsed = super.parseArrayData(meta, data, start, count);
    for (let i = 0; i < parsed.length; i++) {
      const item = data[start + i];
      parsed[i]._custom = valueOrDefault(item[2], this.resolveDataElementOptions(i + start).radius);
    }
    return parsed;
  }
  parseObjectData(meta, data, start, count) {
    const parsed = super.parseObjectData(meta, data, start, count);
    for (let i = 0; i < parsed.length; i++) {
      const item = data[start + i];
      parsed[i]._custom = valueOrDefault(item && item.r && +item.r, this.resolveDataElementOptions(i + start).radius);
    }
    return parsed;
  }
  getMaxOverflow() {
    const data = this._cachedMeta.data;
    let max = 0;
    for (let i = data.length - 1; i >= 0; --i) {
      max = Math.max(max, data[i].size(this.resolveDataElementOptions(i)) / 2);
    }
    return max > 0 && max;
  }
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const labels = this.chart.data.labels || [];
    const { xScale, yScale } = meta;
    const parsed = this.getParsed(index2);
    const x = xScale.getLabelForValue(parsed.x);
    const y = yScale.getLabelForValue(parsed.y);
    const r = parsed._custom;
    return {
      label: labels[index2] || "",
      value: "(" + x + ", " + y + (r ? ", " + r : "") + ")"
    };
  }
  update(mode) {
    const points = this._cachedMeta.data;
    this.updateElements(points, 0, points.length, mode);
  }
  updateElements(points, start, count, mode) {
    const reset = mode === "reset";
    const { iScale, vScale } = this._cachedMeta;
    const { sharedOptions, includeOptions } = this._getSharedOptions(start, mode);
    const iAxis = iScale.axis;
    const vAxis = vScale.axis;
    for (let i = start; i < start + count; i++) {
      const point = points[i];
      const parsed = !reset && this.getParsed(i);
      const properties = {};
      const iPixel = properties[iAxis] = reset ? iScale.getPixelForDecimal(0.5) : iScale.getPixelForValue(parsed[iAxis]);
      const vPixel = properties[vAxis] = reset ? vScale.getBasePixel() : vScale.getPixelForValue(parsed[vAxis]);
      properties.skip = isNaN(iPixel) || isNaN(vPixel);
      if (includeOptions) {
        properties.options = sharedOptions || this.resolveDataElementOptions(i, point.active ? "active" : mode);
        if (reset) {
          properties.options.radius = 0;
        }
      }
      this.updateElement(point, i, properties, mode);
    }
  }
  resolveDataElementOptions(index2, mode) {
    const parsed = this.getParsed(index2);
    let values = super.resolveDataElementOptions(index2, mode);
    if (values.$shared) {
      values = Object.assign({}, values, {
        $shared: false
      });
    }
    const radius = values.radius;
    if (mode !== "active") {
      values.radius = 0;
    }
    values.radius += valueOrDefault(parsed && parsed._custom, radius);
    return values;
  }
};
function getRatioAndOffset(rotation, circumference, cutout) {
  let ratioX = 1;
  let ratioY = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (circumference < TAU) {
    const startAngle = rotation;
    const endAngle = startAngle + circumference;
    const startX = Math.cos(startAngle);
    const startY = Math.sin(startAngle);
    const endX = Math.cos(endAngle);
    const endY = Math.sin(endAngle);
    const calcMax = (angle, a, b) => _angleBetween(angle, startAngle, endAngle, true) ? 1 : Math.max(a, a * cutout, b, b * cutout);
    const calcMin = (angle, a, b) => _angleBetween(angle, startAngle, endAngle, true) ? -1 : Math.min(a, a * cutout, b, b * cutout);
    const maxX = calcMax(0, startX, endX);
    const maxY = calcMax(HALF_PI, startY, endY);
    const minX = calcMin(PI, startX, endX);
    const minY = calcMin(PI + HALF_PI, startY, endY);
    ratioX = (maxX - minX) / 2;
    ratioY = (maxY - minY) / 2;
    offsetX = -(maxX + minX) / 2;
    offsetY = -(maxY + minY) / 2;
  }
  return {
    ratioX,
    ratioY,
    offsetX,
    offsetY
  };
}
var DoughnutController = class extends DatasetController {
  static id = "doughnut";
  static defaults = {
    datasetElementType: false,
    dataElementType: "arc",
    animation: {
      animateRotate: true,
      animateScale: false
    },
    animations: {
      numbers: {
        type: "number",
        properties: [
          "circumference",
          "endAngle",
          "innerRadius",
          "outerRadius",
          "startAngle",
          "x",
          "y",
          "offset",
          "borderWidth",
          "spacing"
        ]
      }
    },
    cutout: "50%",
    rotation: 0,
    circumference: 360,
    radius: "100%",
    spacing: 0,
    indexAxis: "r"
  };
  static descriptors = {
    _scriptable: (name) => name !== "spacing",
    _indexable: (name) => name !== "spacing" && !name.startsWith("borderDash") && !name.startsWith("hoverBorderDash")
  };
  static overrides = {
    aspectRatio: 1,
    plugins: {
      legend: {
        labels: {
          generateLabels(chart) {
            const data = chart.data;
            const { labels: { pointStyle, textAlign, color: color2, useBorderRadius, borderRadius } } = chart.legend.options;
            if (data.labels.length && data.datasets.length) {
              return data.labels.map((label, i) => {
                const meta = chart.getDatasetMeta(0);
                const style = meta.controller.getStyle(i);
                return {
                  text: label,
                  fillStyle: style.backgroundColor,
                  fontColor: color2,
                  hidden: !chart.getDataVisibility(i),
                  lineDash: style.borderDash,
                  lineDashOffset: style.borderDashOffset,
                  lineJoin: style.borderJoinStyle,
                  lineWidth: style.borderWidth,
                  strokeStyle: style.borderColor,
                  textAlign,
                  pointStyle,
                  borderRadius: useBorderRadius && (borderRadius || style.borderRadius),
                  index: i
                };
              });
            }
            return [];
          }
        },
        onClick(e, legendItem, legend) {
          legend.chart.toggleDataVisibility(legendItem.index);
          legend.chart.update();
        }
      }
    }
  };
  constructor(chart, datasetIndex) {
    super(chart, datasetIndex);
    this.enableOptionSharing = true;
    this.innerRadius = void 0;
    this.outerRadius = void 0;
    this.offsetX = void 0;
    this.offsetY = void 0;
  }
  linkScales() {
  }
  parse(start, count) {
    const data = this.getDataset().data;
    const meta = this._cachedMeta;
    if (this._parsing === false) {
      meta._parsed = data;
    } else {
      let getter = (i2) => +data[i2];
      if (isObject(data[start])) {
        const { key = "value" } = this._parsing;
        getter = (i2) => +resolveObjectKey(data[i2], key);
      }
      let i, ilen;
      for (i = start, ilen = start + count; i < ilen; ++i) {
        meta._parsed[i] = getter(i);
      }
    }
  }
  _getRotation() {
    return toRadians(this.options.rotation - 90);
  }
  _getCircumference() {
    return toRadians(this.options.circumference);
  }
  _getRotationExtents() {
    let min = TAU;
    let max = -TAU;
    for (let i = 0; i < this.chart.data.datasets.length; ++i) {
      if (this.chart.isDatasetVisible(i) && this.chart.getDatasetMeta(i).type === this._type) {
        const controller = this.chart.getDatasetMeta(i).controller;
        const rotation = controller._getRotation();
        const circumference = controller._getCircumference();
        min = Math.min(min, rotation);
        max = Math.max(max, rotation + circumference);
      }
    }
    return {
      rotation: min,
      circumference: max - min
    };
  }
  update(mode) {
    const chart = this.chart;
    const { chartArea } = chart;
    const meta = this._cachedMeta;
    const arcs = meta.data;
    const spacing = this.getMaxBorderWidth() + this.getMaxOffset(arcs) + this.options.spacing;
    const maxSize = Math.max((Math.min(chartArea.width, chartArea.height) - spacing) / 2, 0);
    const cutout = Math.min(toPercentage(this.options.cutout, maxSize), 1);
    const chartWeight = this._getRingWeight(this.index);
    const { circumference, rotation } = this._getRotationExtents();
    const { ratioX, ratioY, offsetX, offsetY } = getRatioAndOffset(rotation, circumference, cutout);
    const maxWidth = (chartArea.width - spacing) / ratioX;
    const maxHeight = (chartArea.height - spacing) / ratioY;
    const maxRadius = Math.max(Math.min(maxWidth, maxHeight) / 2, 0);
    const outerRadius = toDimension(this.options.radius, maxRadius);
    const innerRadius = Math.max(outerRadius * cutout, 0);
    const radiusLength = (outerRadius - innerRadius) / this._getVisibleDatasetWeightTotal();
    this.offsetX = offsetX * outerRadius;
    this.offsetY = offsetY * outerRadius;
    meta.total = this.calculateTotal();
    this.outerRadius = outerRadius - radiusLength * this._getRingWeightOffset(this.index);
    this.innerRadius = Math.max(this.outerRadius - radiusLength * chartWeight, 0);
    this.updateElements(arcs, 0, arcs.length, mode);
  }
  _circumference(i, reset) {
    const opts = this.options;
    const meta = this._cachedMeta;
    const circumference = this._getCircumference();
    if (reset && opts.animation.animateRotate || !this.chart.getDataVisibility(i) || meta._parsed[i] === null || meta.data[i].hidden) {
      return 0;
    }
    return this.calculateCircumference(meta._parsed[i] * circumference / TAU);
  }
  updateElements(arcs, start, count, mode) {
    const reset = mode === "reset";
    const chart = this.chart;
    const chartArea = chart.chartArea;
    const opts = chart.options;
    const animationOpts = opts.animation;
    const centerX = (chartArea.left + chartArea.right) / 2;
    const centerY = (chartArea.top + chartArea.bottom) / 2;
    const animateScale = reset && animationOpts.animateScale;
    const innerRadius = animateScale ? 0 : this.innerRadius;
    const outerRadius = animateScale ? 0 : this.outerRadius;
    const { sharedOptions, includeOptions } = this._getSharedOptions(start, mode);
    let startAngle = this._getRotation();
    let i;
    for (i = 0; i < start; ++i) {
      startAngle += this._circumference(i, reset);
    }
    for (i = start; i < start + count; ++i) {
      const circumference = this._circumference(i, reset);
      const arc = arcs[i];
      const properties = {
        x: centerX + this.offsetX,
        y: centerY + this.offsetY,
        startAngle,
        endAngle: startAngle + circumference,
        circumference,
        outerRadius,
        innerRadius
      };
      if (includeOptions) {
        properties.options = sharedOptions || this.resolveDataElementOptions(i, arc.active ? "active" : mode);
      }
      startAngle += circumference;
      this.updateElement(arc, i, properties, mode);
    }
  }
  calculateTotal() {
    const meta = this._cachedMeta;
    const metaData = meta.data;
    let total = 0;
    let i;
    for (i = 0; i < metaData.length; i++) {
      const value = meta._parsed[i];
      if (value !== null && !isNaN(value) && this.chart.getDataVisibility(i) && !metaData[i].hidden) {
        total += Math.abs(value);
      }
    }
    return total;
  }
  calculateCircumference(value) {
    const total = this._cachedMeta.total;
    if (total > 0 && !isNaN(value)) {
      return TAU * (Math.abs(value) / total);
    }
    return 0;
  }
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const chart = this.chart;
    const labels = chart.data.labels || [];
    const value = formatNumber(meta._parsed[index2], chart.options.locale);
    return {
      label: labels[index2] || "",
      value
    };
  }
  getMaxBorderWidth(arcs) {
    let max = 0;
    const chart = this.chart;
    let i, ilen, meta, controller, options;
    if (!arcs) {
      for (i = 0, ilen = chart.data.datasets.length; i < ilen; ++i) {
        if (chart.isDatasetVisible(i)) {
          meta = chart.getDatasetMeta(i);
          arcs = meta.data;
          controller = meta.controller;
          break;
        }
      }
    }
    if (!arcs) {
      return 0;
    }
    for (i = 0, ilen = arcs.length; i < ilen; ++i) {
      options = controller.resolveDataElementOptions(i);
      if (options.borderAlign !== "inner") {
        max = Math.max(max, options.borderWidth || 0, options.hoverBorderWidth || 0);
      }
    }
    return max;
  }
  getMaxOffset(arcs) {
    let max = 0;
    for (let i = 0, ilen = arcs.length; i < ilen; ++i) {
      const options = this.resolveDataElementOptions(i);
      max = Math.max(max, options.offset || 0, options.hoverOffset || 0);
    }
    return max;
  }
  _getRingWeightOffset(datasetIndex) {
    let ringWeightOffset = 0;
    for (let i = 0; i < datasetIndex; ++i) {
      if (this.chart.isDatasetVisible(i)) {
        ringWeightOffset += this._getRingWeight(i);
      }
    }
    return ringWeightOffset;
  }
  _getRingWeight(datasetIndex) {
    return Math.max(valueOrDefault(this.chart.data.datasets[datasetIndex].weight, 1), 0);
  }
  _getVisibleDatasetWeightTotal() {
    return this._getRingWeightOffset(this.chart.data.datasets.length) || 1;
  }
};
var LineController = class extends DatasetController {
  static id = "line";
  static defaults = {
    datasetElementType: "line",
    dataElementType: "point",
    showLine: true,
    spanGaps: false
  };
  static overrides = {
    scales: {
      _index_: {
        type: "category"
      },
      _value_: {
        type: "linear"
      }
    }
  };
  initialize() {
    this.enableOptionSharing = true;
    this.supportsDecimation = true;
    super.initialize();
  }
  update(mode) {
    const meta = this._cachedMeta;
    const { dataset: line, data: points = [], _dataset } = meta;
    const animationsDisabled = this.chart._animationsDisabled;
    let { start, count } = _getStartAndCountOfVisiblePoints(meta, points, animationsDisabled);
    this._drawStart = start;
    this._drawCount = count;
    if (_scaleRangesChanged(meta)) {
      start = 0;
      count = points.length;
    }
    line._chart = this.chart;
    line._datasetIndex = this.index;
    line._decimated = !!_dataset._decimated;
    line.points = points;
    const options = this.resolveDatasetElementOptions(mode);
    if (!this.options.showLine) {
      options.borderWidth = 0;
    }
    options.segment = this.options.segment;
    this.updateElement(line, void 0, {
      animated: !animationsDisabled,
      options
    }, mode);
    this.updateElements(points, start, count, mode);
  }
  updateElements(points, start, count, mode) {
    const reset = mode === "reset";
    const { iScale, vScale, _stacked, _dataset } = this._cachedMeta;
    const { sharedOptions, includeOptions } = this._getSharedOptions(start, mode);
    const iAxis = iScale.axis;
    const vAxis = vScale.axis;
    const { spanGaps, segment } = this.options;
    const maxGapLength = isNumber(spanGaps) ? spanGaps : Number.POSITIVE_INFINITY;
    const directUpdate = this.chart._animationsDisabled || reset || mode === "none";
    const end = start + count;
    const pointsCount = points.length;
    let prevParsed = start > 0 && this.getParsed(start - 1);
    for (let i = 0; i < pointsCount; ++i) {
      const point = points[i];
      const properties = directUpdate ? point : {};
      if (i < start || i >= end) {
        properties.skip = true;
        continue;
      }
      const parsed = this.getParsed(i);
      const nullData = isNullOrUndef(parsed[vAxis]);
      const iPixel = properties[iAxis] = iScale.getPixelForValue(parsed[iAxis], i);
      const vPixel = properties[vAxis] = reset || nullData ? vScale.getBasePixel() : vScale.getPixelForValue(_stacked ? this.applyStack(vScale, parsed, _stacked) : parsed[vAxis], i);
      properties.skip = isNaN(iPixel) || isNaN(vPixel) || nullData;
      properties.stop = i > 0 && Math.abs(parsed[iAxis] - prevParsed[iAxis]) > maxGapLength;
      if (segment) {
        properties.parsed = parsed;
        properties.raw = _dataset.data[i];
      }
      if (includeOptions) {
        properties.options = sharedOptions || this.resolveDataElementOptions(i, point.active ? "active" : mode);
      }
      if (!directUpdate) {
        this.updateElement(point, i, properties, mode);
      }
      prevParsed = parsed;
    }
  }
  getMaxOverflow() {
    const meta = this._cachedMeta;
    const dataset = meta.dataset;
    const border = dataset.options && dataset.options.borderWidth || 0;
    const data = meta.data || [];
    if (!data.length) {
      return border;
    }
    const firstPoint = data[0].size(this.resolveDataElementOptions(0));
    const lastPoint = data[data.length - 1].size(this.resolveDataElementOptions(data.length - 1));
    return Math.max(border, firstPoint, lastPoint) / 2;
  }
  draw() {
    const meta = this._cachedMeta;
    meta.dataset.updateControlPoints(this.chart.chartArea, meta.iScale.axis);
    super.draw();
  }
};
var PolarAreaController = class extends DatasetController {
  static id = "polarArea";
  static defaults = {
    dataElementType: "arc",
    animation: {
      animateRotate: true,
      animateScale: true
    },
    animations: {
      numbers: {
        type: "number",
        properties: [
          "x",
          "y",
          "startAngle",
          "endAngle",
          "innerRadius",
          "outerRadius"
        ]
      }
    },
    indexAxis: "r",
    startAngle: 0
  };
  static overrides = {
    aspectRatio: 1,
    plugins: {
      legend: {
        labels: {
          generateLabels(chart) {
            const data = chart.data;
            if (data.labels.length && data.datasets.length) {
              const { labels: { pointStyle, color: color2 } } = chart.legend.options;
              return data.labels.map((label, i) => {
                const meta = chart.getDatasetMeta(0);
                const style = meta.controller.getStyle(i);
                return {
                  text: label,
                  fillStyle: style.backgroundColor,
                  strokeStyle: style.borderColor,
                  fontColor: color2,
                  lineWidth: style.borderWidth,
                  pointStyle,
                  hidden: !chart.getDataVisibility(i),
                  index: i
                };
              });
            }
            return [];
          }
        },
        onClick(e, legendItem, legend) {
          legend.chart.toggleDataVisibility(legendItem.index);
          legend.chart.update();
        }
      }
    },
    scales: {
      r: {
        type: "radialLinear",
        angleLines: {
          display: false
        },
        beginAtZero: true,
        grid: {
          circular: true
        },
        pointLabels: {
          display: false
        },
        startAngle: 0
      }
    }
  };
  constructor(chart, datasetIndex) {
    super(chart, datasetIndex);
    this.innerRadius = void 0;
    this.outerRadius = void 0;
  }
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const chart = this.chart;
    const labels = chart.data.labels || [];
    const value = formatNumber(meta._parsed[index2].r, chart.options.locale);
    return {
      label: labels[index2] || "",
      value
    };
  }
  parseObjectData(meta, data, start, count) {
    return _parseObjectDataRadialScale.bind(this)(meta, data, start, count);
  }
  update(mode) {
    const arcs = this._cachedMeta.data;
    this._updateRadius();
    this.updateElements(arcs, 0, arcs.length, mode);
  }
  getMinMax() {
    const meta = this._cachedMeta;
    const range = {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY
    };
    meta.data.forEach((element, index2) => {
      const parsed = this.getParsed(index2).r;
      if (!isNaN(parsed) && this.chart.getDataVisibility(index2)) {
        if (parsed < range.min) {
          range.min = parsed;
        }
        if (parsed > range.max) {
          range.max = parsed;
        }
      }
    });
    return range;
  }
  _updateRadius() {
    const chart = this.chart;
    const chartArea = chart.chartArea;
    const opts = chart.options;
    const minSize = Math.min(chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    const outerRadius = Math.max(minSize / 2, 0);
    const innerRadius = Math.max(opts.cutoutPercentage ? outerRadius / 100 * opts.cutoutPercentage : 1, 0);
    const radiusLength = (outerRadius - innerRadius) / chart.getVisibleDatasetCount();
    this.outerRadius = outerRadius - radiusLength * this.index;
    this.innerRadius = this.outerRadius - radiusLength;
  }
  updateElements(arcs, start, count, mode) {
    const reset = mode === "reset";
    const chart = this.chart;
    const opts = chart.options;
    const animationOpts = opts.animation;
    const scale = this._cachedMeta.rScale;
    const centerX = scale.xCenter;
    const centerY = scale.yCenter;
    const datasetStartAngle = scale.getIndexAngle(0) - 0.5 * PI;
    let angle = datasetStartAngle;
    let i;
    const defaultAngle = 360 / this.countVisibleElements();
    for (i = 0; i < start; ++i) {
      angle += this._computeAngle(i, mode, defaultAngle);
    }
    for (i = start; i < start + count; i++) {
      const arc = arcs[i];
      let startAngle = angle;
      let endAngle = angle + this._computeAngle(i, mode, defaultAngle);
      let outerRadius = chart.getDataVisibility(i) ? scale.getDistanceFromCenterForValue(this.getParsed(i).r) : 0;
      angle = endAngle;
      if (reset) {
        if (animationOpts.animateScale) {
          outerRadius = 0;
        }
        if (animationOpts.animateRotate) {
          startAngle = endAngle = datasetStartAngle;
        }
      }
      const properties = {
        x: centerX,
        y: centerY,
        innerRadius: 0,
        outerRadius,
        startAngle,
        endAngle,
        options: this.resolveDataElementOptions(i, arc.active ? "active" : mode)
      };
      this.updateElement(arc, i, properties, mode);
    }
  }
  countVisibleElements() {
    const meta = this._cachedMeta;
    let count = 0;
    meta.data.forEach((element, index2) => {
      if (!isNaN(this.getParsed(index2).r) && this.chart.getDataVisibility(index2)) {
        count++;
      }
    });
    return count;
  }
  _computeAngle(index2, mode, defaultAngle) {
    return this.chart.getDataVisibility(index2) ? toRadians(this.resolveDataElementOptions(index2, mode).angle || defaultAngle) : 0;
  }
};
var PieController = class extends DoughnutController {
  static id = "pie";
  static defaults = {
    cutout: 0,
    rotation: 0,
    circumference: 360,
    radius: "100%"
  };
};
var RadarController = class extends DatasetController {
  static id = "radar";
  static defaults = {
    datasetElementType: "line",
    dataElementType: "point",
    indexAxis: "r",
    showLine: true,
    elements: {
      line: {
        fill: "start"
      }
    }
  };
  static overrides = {
    aspectRatio: 1,
    scales: {
      r: {
        type: "radialLinear"
      }
    }
  };
  getLabelAndValue(index2) {
    const vScale = this._cachedMeta.vScale;
    const parsed = this.getParsed(index2);
    return {
      label: vScale.getLabels()[index2],
      value: "" + vScale.getLabelForValue(parsed[vScale.axis])
    };
  }
  parseObjectData(meta, data, start, count) {
    return _parseObjectDataRadialScale.bind(this)(meta, data, start, count);
  }
  update(mode) {
    const meta = this._cachedMeta;
    const line = meta.dataset;
    const points = meta.data || [];
    const labels = meta.iScale.getLabels();
    line.points = points;
    if (mode !== "resize") {
      const options = this.resolveDatasetElementOptions(mode);
      if (!this.options.showLine) {
        options.borderWidth = 0;
      }
      const properties = {
        _loop: true,
        _fullLoop: labels.length === points.length,
        options
      };
      this.updateElement(line, void 0, properties, mode);
    }
    this.updateElements(points, 0, points.length, mode);
  }
  updateElements(points, start, count, mode) {
    const scale = this._cachedMeta.rScale;
    const reset = mode === "reset";
    for (let i = start; i < start + count; i++) {
      const point = points[i];
      const options = this.resolveDataElementOptions(i, point.active ? "active" : mode);
      const pointPosition = scale.getPointPositionForValue(i, this.getParsed(i).r);
      const x = reset ? scale.xCenter : pointPosition.x;
      const y = reset ? scale.yCenter : pointPosition.y;
      const properties = {
        x,
        y,
        angle: pointPosition.angle,
        skip: isNaN(x) || isNaN(y),
        options
      };
      this.updateElement(point, i, properties, mode);
    }
  }
};
var ScatterController = class extends DatasetController {
  static id = "scatter";
  static defaults = {
    datasetElementType: false,
    dataElementType: "point",
    showLine: false,
    fill: false
  };
  static overrides = {
    interaction: {
      mode: "point"
    },
    scales: {
      x: {
        type: "linear"
      },
      y: {
        type: "linear"
      }
    }
  };
  getLabelAndValue(index2) {
    const meta = this._cachedMeta;
    const labels = this.chart.data.labels || [];
    const { xScale, yScale } = meta;
    const parsed = this.getParsed(index2);
    const x = xScale.getLabelForValue(parsed.x);
    const y = yScale.getLabelForValue(parsed.y);
    return {
      label: labels[index2] || "",
      value: "(" + x + ", " + y + ")"
    };
  }
  update(mode) {
    const meta = this._cachedMeta;
    const { data: points = [] } = meta;
    const animationsDisabled = this.chart._animationsDisabled;
    let { start, count } = _getStartAndCountOfVisiblePoints(meta, points, animationsDisabled);
    this._drawStart = start;
    this._drawCount = count;
    if (_scaleRangesChanged(meta)) {
      start = 0;
      count = points.length;
    }
    if (this.options.showLine) {
      if (!this.datasetElementType) {
        this.addElements();
      }
      const { dataset: line, _dataset } = meta;
      line._chart = this.chart;
      line._datasetIndex = this.index;
      line._decimated = !!_dataset._decimated;
      line.points = points;
      const options = this.resolveDatasetElementOptions(mode);
      options.segment = this.options.segment;
      this.updateElement(line, void 0, {
        animated: !animationsDisabled,
        options
      }, mode);
    } else if (this.datasetElementType) {
      delete meta.dataset;
      this.datasetElementType = false;
    }
    this.updateElements(points, start, count, mode);
  }
  addElements() {
    const { showLine } = this.options;
    if (!this.datasetElementType && showLine) {
      this.datasetElementType = this.chart.registry.getElement("line");
    }
    super.addElements();
  }
  updateElements(points, start, count, mode) {
    const reset = mode === "reset";
    const { iScale, vScale, _stacked, _dataset } = this._cachedMeta;
    const firstOpts = this.resolveDataElementOptions(start, mode);
    const sharedOptions = this.getSharedOptions(firstOpts);
    const includeOptions = this.includeOptions(mode, sharedOptions);
    const iAxis = iScale.axis;
    const vAxis = vScale.axis;
    const { spanGaps, segment } = this.options;
    const maxGapLength = isNumber(spanGaps) ? spanGaps : Number.POSITIVE_INFINITY;
    const directUpdate = this.chart._animationsDisabled || reset || mode === "none";
    let prevParsed = start > 0 && this.getParsed(start - 1);
    for (let i = start; i < start + count; ++i) {
      const point = points[i];
      const parsed = this.getParsed(i);
      const properties = directUpdate ? point : {};
      const nullData = isNullOrUndef(parsed[vAxis]);
      const iPixel = properties[iAxis] = iScale.getPixelForValue(parsed[iAxis], i);
      const vPixel = properties[vAxis] = reset || nullData ? vScale.getBasePixel() : vScale.getPixelForValue(_stacked ? this.applyStack(vScale, parsed, _stacked) : parsed[vAxis], i);
      properties.skip = isNaN(iPixel) || isNaN(vPixel) || nullData;
      properties.stop = i > 0 && Math.abs(parsed[iAxis] - prevParsed[iAxis]) > maxGapLength;
      if (segment) {
        properties.parsed = parsed;
        properties.raw = _dataset.data[i];
      }
      if (includeOptions) {
        properties.options = sharedOptions || this.resolveDataElementOptions(i, point.active ? "active" : mode);
      }
      if (!directUpdate) {
        this.updateElement(point, i, properties, mode);
      }
      prevParsed = parsed;
    }
    this.updateSharedOptions(sharedOptions, mode, firstOpts);
  }
  getMaxOverflow() {
    const meta = this._cachedMeta;
    const data = meta.data || [];
    if (!this.options.showLine) {
      let max = 0;
      for (let i = data.length - 1; i >= 0; --i) {
        max = Math.max(max, data[i].size(this.resolveDataElementOptions(i)) / 2);
      }
      return max > 0 && max;
    }
    const dataset = meta.dataset;
    const border = dataset.options && dataset.options.borderWidth || 0;
    if (!data.length) {
      return border;
    }
    const firstPoint = data[0].size(this.resolveDataElementOptions(0));
    const lastPoint = data[data.length - 1].size(this.resolveDataElementOptions(data.length - 1));
    return Math.max(border, firstPoint, lastPoint) / 2;
  }
};
var controllers = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  BarController,
  BubbleController,
  DoughnutController,
  LineController,
  PieController,
  PolarAreaController,
  RadarController,
  ScatterController
});
function abstract() {
  throw new Error("This method is not implemented: Check that a complete date adapter is provided.");
}
var DateAdapterBase = class _DateAdapterBase {
  /**
  * Override default date adapter methods.
  * Accepts type parameter to define options type.
  * @example
  * Chart._adapters._date.override<{myAdapterOption: string}>({
  *   init() {
  *     console.log(this.options.myAdapterOption);
  *   }
  * })
  */
  static override(members) {
    Object.assign(_DateAdapterBase.prototype, members);
  }
  options;
  constructor(options) {
    this.options = options || {};
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  init() {
  }
  formats() {
    return abstract();
  }
  parse() {
    return abstract();
  }
  format() {
    return abstract();
  }
  add() {
    return abstract();
  }
  diff() {
    return abstract();
  }
  startOf() {
    return abstract();
  }
  endOf() {
    return abstract();
  }
};
var adapters = {
  _date: DateAdapterBase
};
function binarySearch(metaset, axis, value, intersect) {
  const { controller, data, _sorted } = metaset;
  const iScale = controller._cachedMeta.iScale;
  const spanGaps = metaset.dataset ? metaset.dataset.options ? metaset.dataset.options.spanGaps : null : null;
  if (iScale && axis === iScale.axis && axis !== "r" && _sorted && data.length) {
    const lookupMethod = iScale._reversePixels ? _rlookupByKey : _lookupByKey;
    if (!intersect) {
      const result = lookupMethod(data, axis, value);
      if (spanGaps) {
        const { vScale } = controller._cachedMeta;
        const { _parsed } = metaset;
        const distanceToDefinedLo = _parsed.slice(0, result.lo + 1).reverse().findIndex((point) => !isNullOrUndef(point[vScale.axis]));
        result.lo -= Math.max(0, distanceToDefinedLo);
        const distanceToDefinedHi = _parsed.slice(result.hi).findIndex((point) => !isNullOrUndef(point[vScale.axis]));
        result.hi += Math.max(0, distanceToDefinedHi);
      }
      return result;
    } else if (controller._sharedOptions) {
      const el = data[0];
      const range = typeof el.getRange === "function" && el.getRange(axis);
      if (range) {
        const start = lookupMethod(data, axis, value - range);
        const end = lookupMethod(data, axis, value + range);
        return {
          lo: start.lo,
          hi: end.hi
        };
      }
    }
  }
  return {
    lo: 0,
    hi: data.length - 1
  };
}
function evaluateInteractionItems(chart, axis, position, handler, intersect) {
  const metasets = chart.getSortedVisibleDatasetMetas();
  const value = position[axis];
  for (let i = 0, ilen = metasets.length; i < ilen; ++i) {
    const { index: index2, data } = metasets[i];
    const { lo, hi } = binarySearch(metasets[i], axis, value, intersect);
    for (let j = lo; j <= hi; ++j) {
      const element = data[j];
      if (!element.skip) {
        handler(element, index2, j);
      }
    }
  }
}
function getDistanceMetricForAxis(axis) {
  const useX = axis.indexOf("x") !== -1;
  const useY = axis.indexOf("y") !== -1;
  return function(pt1, pt2) {
    const deltaX = useX ? Math.abs(pt1.x - pt2.x) : 0;
    const deltaY = useY ? Math.abs(pt1.y - pt2.y) : 0;
    return Math.sqrt(Math.pow(deltaX, 2) + Math.pow(deltaY, 2));
  };
}
function getIntersectItems(chart, position, axis, useFinalPosition, includeInvisible) {
  const items = [];
  if (!includeInvisible && !chart.isPointInArea(position)) {
    return items;
  }
  const evaluationFunc = function(element, datasetIndex, index2) {
    if (!includeInvisible && !_isPointInArea(element, chart.chartArea, 0)) {
      return;
    }
    if (element.inRange(position.x, position.y, useFinalPosition)) {
      items.push({
        element,
        datasetIndex,
        index: index2
      });
    }
  };
  evaluateInteractionItems(chart, axis, position, evaluationFunc, true);
  return items;
}
function getNearestRadialItems(chart, position, axis, useFinalPosition) {
  let items = [];
  function evaluationFunc(element, datasetIndex, index2) {
    const { startAngle, endAngle } = element.getProps([
      "startAngle",
      "endAngle"
    ], useFinalPosition);
    const { angle } = getAngleFromPoint(element, {
      x: position.x,
      y: position.y
    });
    if (_angleBetween(angle, startAngle, endAngle)) {
      items.push({
        element,
        datasetIndex,
        index: index2
      });
    }
  }
  evaluateInteractionItems(chart, axis, position, evaluationFunc);
  return items;
}
function getNearestCartesianItems(chart, position, axis, intersect, useFinalPosition, includeInvisible) {
  let items = [];
  const distanceMetric = getDistanceMetricForAxis(axis);
  let minDistance = Number.POSITIVE_INFINITY;
  function evaluationFunc(element, datasetIndex, index2) {
    const inRange2 = element.inRange(position.x, position.y, useFinalPosition);
    if (intersect && !inRange2) {
      return;
    }
    const center = element.getCenterPoint(useFinalPosition);
    const pointInArea = !!includeInvisible || chart.isPointInArea(center);
    if (!pointInArea && !inRange2) {
      return;
    }
    const distance = distanceMetric(position, center);
    if (distance < minDistance) {
      items = [
        {
          element,
          datasetIndex,
          index: index2
        }
      ];
      minDistance = distance;
    } else if (distance === minDistance) {
      items.push({
        element,
        datasetIndex,
        index: index2
      });
    }
  }
  evaluateInteractionItems(chart, axis, position, evaluationFunc);
  return items;
}
function getNearestItems(chart, position, axis, intersect, useFinalPosition, includeInvisible) {
  if (!includeInvisible && !chart.isPointInArea(position)) {
    return [];
  }
  return axis === "r" && !intersect ? getNearestRadialItems(chart, position, axis, useFinalPosition) : getNearestCartesianItems(chart, position, axis, intersect, useFinalPosition, includeInvisible);
}
function getAxisItems(chart, position, axis, intersect, useFinalPosition) {
  const items = [];
  const rangeMethod = axis === "x" ? "inXRange" : "inYRange";
  let intersectsItem = false;
  evaluateInteractionItems(chart, axis, position, (element, datasetIndex, index2) => {
    if (element[rangeMethod] && element[rangeMethod](position[axis], useFinalPosition)) {
      items.push({
        element,
        datasetIndex,
        index: index2
      });
      intersectsItem = intersectsItem || element.inRange(position.x, position.y, useFinalPosition);
    }
  });
  if (intersect && !intersectsItem) {
    return [];
  }
  return items;
}
var Interaction = {
  evaluateInteractionItems,
  modes: {
    index(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      const axis = options.axis || "x";
      const includeInvisible = options.includeInvisible || false;
      const items = options.intersect ? getIntersectItems(chart, position, axis, useFinalPosition, includeInvisible) : getNearestItems(chart, position, axis, false, useFinalPosition, includeInvisible);
      const elements2 = [];
      if (!items.length) {
        return [];
      }
      chart.getSortedVisibleDatasetMetas().forEach((meta) => {
        const index2 = items[0].index;
        const element = meta.data[index2];
        if (element && !element.skip) {
          elements2.push({
            element,
            datasetIndex: meta.index,
            index: index2
          });
        }
      });
      return elements2;
    },
    dataset(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      const axis = options.axis || "xy";
      const includeInvisible = options.includeInvisible || false;
      let items = options.intersect ? getIntersectItems(chart, position, axis, useFinalPosition, includeInvisible) : getNearestItems(chart, position, axis, false, useFinalPosition, includeInvisible);
      if (items.length > 0) {
        const datasetIndex = items[0].datasetIndex;
        const data = chart.getDatasetMeta(datasetIndex).data;
        items = [];
        for (let i = 0; i < data.length; ++i) {
          items.push({
            element: data[i],
            datasetIndex,
            index: i
          });
        }
      }
      return items;
    },
    point(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      const axis = options.axis || "xy";
      const includeInvisible = options.includeInvisible || false;
      return getIntersectItems(chart, position, axis, useFinalPosition, includeInvisible);
    },
    nearest(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      const axis = options.axis || "xy";
      const includeInvisible = options.includeInvisible || false;
      return getNearestItems(chart, position, axis, options.intersect, useFinalPosition, includeInvisible);
    },
    x(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      return getAxisItems(chart, position, "x", options.intersect, useFinalPosition);
    },
    y(chart, e, options, useFinalPosition) {
      const position = getRelativePosition(e, chart);
      return getAxisItems(chart, position, "y", options.intersect, useFinalPosition);
    }
  }
};
var STATIC_POSITIONS = [
  "left",
  "top",
  "right",
  "bottom"
];
function filterByPosition(array, position) {
  return array.filter((v) => v.pos === position);
}
function filterDynamicPositionByAxis(array, axis) {
  return array.filter((v) => STATIC_POSITIONS.indexOf(v.pos) === -1 && v.box.axis === axis);
}
function sortByWeight(array, reverse) {
  return array.sort((a, b) => {
    const v0 = reverse ? b : a;
    const v1 = reverse ? a : b;
    return v0.weight === v1.weight ? v0.index - v1.index : v0.weight - v1.weight;
  });
}
function wrapBoxes(boxes) {
  const layoutBoxes = [];
  let i, ilen, box, pos, stack, stackWeight;
  for (i = 0, ilen = (boxes || []).length; i < ilen; ++i) {
    box = boxes[i];
    ({ position: pos, options: { stack, stackWeight = 1 } } = box);
    layoutBoxes.push({
      index: i,
      box,
      pos,
      horizontal: box.isHorizontal(),
      weight: box.weight,
      stack: stack && pos + stack,
      stackWeight
    });
  }
  return layoutBoxes;
}
function buildStacks(layouts2) {
  const stacks = {};
  for (const wrap of layouts2) {
    const { stack, pos, stackWeight } = wrap;
    if (!stack || !STATIC_POSITIONS.includes(pos)) {
      continue;
    }
    const _stack = stacks[stack] || (stacks[stack] = {
      count: 0,
      placed: 0,
      weight: 0,
      size: 0
    });
    _stack.count++;
    _stack.weight += stackWeight;
  }
  return stacks;
}
function setLayoutDims(layouts2, params) {
  const stacks = buildStacks(layouts2);
  const { vBoxMaxWidth, hBoxMaxHeight } = params;
  let i, ilen, layout;
  for (i = 0, ilen = layouts2.length; i < ilen; ++i) {
    layout = layouts2[i];
    const { fullSize } = layout.box;
    const stack = stacks[layout.stack];
    const factor = stack && layout.stackWeight / stack.weight;
    if (layout.horizontal) {
      layout.width = factor ? factor * vBoxMaxWidth : fullSize && params.availableWidth;
      layout.height = hBoxMaxHeight;
    } else {
      layout.width = vBoxMaxWidth;
      layout.height = factor ? factor * hBoxMaxHeight : fullSize && params.availableHeight;
    }
  }
  return stacks;
}
function buildLayoutBoxes(boxes) {
  const layoutBoxes = wrapBoxes(boxes);
  const fullSize = sortByWeight(layoutBoxes.filter((wrap) => wrap.box.fullSize), true);
  const left = sortByWeight(filterByPosition(layoutBoxes, "left"), true);
  const right = sortByWeight(filterByPosition(layoutBoxes, "right"));
  const top = sortByWeight(filterByPosition(layoutBoxes, "top"), true);
  const bottom = sortByWeight(filterByPosition(layoutBoxes, "bottom"));
  const centerHorizontal = filterDynamicPositionByAxis(layoutBoxes, "x");
  const centerVertical = filterDynamicPositionByAxis(layoutBoxes, "y");
  return {
    fullSize,
    leftAndTop: left.concat(top),
    rightAndBottom: right.concat(centerVertical).concat(bottom).concat(centerHorizontal),
    chartArea: filterByPosition(layoutBoxes, "chartArea"),
    vertical: left.concat(right).concat(centerVertical),
    horizontal: top.concat(bottom).concat(centerHorizontal)
  };
}
function getCombinedMax(maxPadding, chartArea, a, b) {
  return Math.max(maxPadding[a], chartArea[a]) + Math.max(maxPadding[b], chartArea[b]);
}
function updateMaxPadding(maxPadding, boxPadding) {
  maxPadding.top = Math.max(maxPadding.top, boxPadding.top);
  maxPadding.left = Math.max(maxPadding.left, boxPadding.left);
  maxPadding.bottom = Math.max(maxPadding.bottom, boxPadding.bottom);
  maxPadding.right = Math.max(maxPadding.right, boxPadding.right);
}
function updateDims(chartArea, params, layout, stacks) {
  const { pos, box } = layout;
  const maxPadding = chartArea.maxPadding;
  if (!isObject(pos)) {
    if (layout.size) {
      chartArea[pos] -= layout.size;
    }
    const stack = stacks[layout.stack] || {
      size: 0,
      count: 1
    };
    stack.size = Math.max(stack.size, layout.horizontal ? box.height : box.width);
    layout.size = stack.size / stack.count;
    chartArea[pos] += layout.size;
  }
  if (box.getPadding) {
    updateMaxPadding(maxPadding, box.getPadding());
  }
  const newWidth = Math.max(0, params.outerWidth - getCombinedMax(maxPadding, chartArea, "left", "right"));
  const newHeight = Math.max(0, params.outerHeight - getCombinedMax(maxPadding, chartArea, "top", "bottom"));
  const widthChanged = newWidth !== chartArea.w;
  const heightChanged = newHeight !== chartArea.h;
  chartArea.w = newWidth;
  chartArea.h = newHeight;
  return layout.horizontal ? {
    same: widthChanged,
    other: heightChanged
  } : {
    same: heightChanged,
    other: widthChanged
  };
}
function handleMaxPadding(chartArea) {
  const maxPadding = chartArea.maxPadding;
  function updatePos(pos) {
    const change = Math.max(maxPadding[pos] - chartArea[pos], 0);
    chartArea[pos] += change;
    return change;
  }
  chartArea.y += updatePos("top");
  chartArea.x += updatePos("left");
  updatePos("right");
  updatePos("bottom");
}
function getMargins(horizontal, chartArea) {
  const maxPadding = chartArea.maxPadding;
  function marginForPositions(positions2) {
    const margin = {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0
    };
    positions2.forEach((pos) => {
      margin[pos] = Math.max(chartArea[pos], maxPadding[pos]);
    });
    return margin;
  }
  return horizontal ? marginForPositions([
    "left",
    "right"
  ]) : marginForPositions([
    "top",
    "bottom"
  ]);
}
function fitBoxes(boxes, chartArea, params, stacks) {
  const refitBoxes = [];
  let i, ilen, layout, box, refit, changed;
  for (i = 0, ilen = boxes.length, refit = 0; i < ilen; ++i) {
    layout = boxes[i];
    box = layout.box;
    box.update(layout.width || chartArea.w, layout.height || chartArea.h, getMargins(layout.horizontal, chartArea));
    const { same, other } = updateDims(chartArea, params, layout, stacks);
    refit |= same && refitBoxes.length;
    changed = changed || other;
    if (!box.fullSize) {
      refitBoxes.push(layout);
    }
  }
  return refit && fitBoxes(refitBoxes, chartArea, params, stacks) || changed;
}
function setBoxDims(box, left, top, width, height) {
  box.top = top;
  box.left = left;
  box.right = left + width;
  box.bottom = top + height;
  box.width = width;
  box.height = height;
}
function placeBoxes(boxes, chartArea, params, stacks) {
  const userPadding = params.padding;
  let { x, y } = chartArea;
  for (const layout of boxes) {
    const box = layout.box;
    const stack = stacks[layout.stack] || {
      count: 1,
      placed: 0,
      weight: 1
    };
    const weight = layout.stackWeight / stack.weight || 1;
    if (layout.horizontal) {
      const width = chartArea.w * weight;
      const height = stack.size || box.height;
      if (defined(stack.start)) {
        y = stack.start;
      }
      if (box.fullSize) {
        setBoxDims(box, userPadding.left, y, params.outerWidth - userPadding.right - userPadding.left, height);
      } else {
        setBoxDims(box, chartArea.left + stack.placed, y, width, height);
      }
      stack.start = y;
      stack.placed += width;
      y = box.bottom;
    } else {
      const height = chartArea.h * weight;
      const width = stack.size || box.width;
      if (defined(stack.start)) {
        x = stack.start;
      }
      if (box.fullSize) {
        setBoxDims(box, x, userPadding.top, width, params.outerHeight - userPadding.bottom - userPadding.top);
      } else {
        setBoxDims(box, x, chartArea.top + stack.placed, width, height);
      }
      stack.start = x;
      stack.placed += height;
      x = box.right;
    }
  }
  chartArea.x = x;
  chartArea.y = y;
}
var layouts = {
  addBox(chart, item) {
    if (!chart.boxes) {
      chart.boxes = [];
    }
    item.fullSize = item.fullSize || false;
    item.position = item.position || "top";
    item.weight = item.weight || 0;
    item._layers = item._layers || function() {
      return [
        {
          z: 0,
          draw(chartArea) {
            item.draw(chartArea);
          }
        }
      ];
    };
    chart.boxes.push(item);
  },
  removeBox(chart, layoutItem) {
    const index2 = chart.boxes ? chart.boxes.indexOf(layoutItem) : -1;
    if (index2 !== -1) {
      chart.boxes.splice(index2, 1);
    }
  },
  configure(chart, item, options) {
    item.fullSize = options.fullSize;
    item.position = options.position;
    item.weight = options.weight;
  },
  update(chart, width, height, minPadding) {
    if (!chart) {
      return;
    }
    const padding = toPadding(chart.options.layout.padding);
    const availableWidth = Math.max(width - padding.width, 0);
    const availableHeight = Math.max(height - padding.height, 0);
    const boxes = buildLayoutBoxes(chart.boxes);
    const verticalBoxes = boxes.vertical;
    const horizontalBoxes = boxes.horizontal;
    each(chart.boxes, (box) => {
      if (typeof box.beforeLayout === "function") {
        box.beforeLayout();
      }
    });
    const visibleVerticalBoxCount = verticalBoxes.reduce((total, wrap) => wrap.box.options && wrap.box.options.display === false ? total : total + 1, 0) || 1;
    const params = Object.freeze({
      outerWidth: width,
      outerHeight: height,
      padding,
      availableWidth,
      availableHeight,
      vBoxMaxWidth: availableWidth / 2 / visibleVerticalBoxCount,
      hBoxMaxHeight: availableHeight / 2
    });
    const maxPadding = Object.assign({}, padding);
    updateMaxPadding(maxPadding, toPadding(minPadding));
    const chartArea = Object.assign({
      maxPadding,
      w: availableWidth,
      h: availableHeight,
      x: padding.left,
      y: padding.top
    }, padding);
    const stacks = setLayoutDims(verticalBoxes.concat(horizontalBoxes), params);
    fitBoxes(boxes.fullSize, chartArea, params, stacks);
    fitBoxes(verticalBoxes, chartArea, params, stacks);
    if (fitBoxes(horizontalBoxes, chartArea, params, stacks)) {
      fitBoxes(verticalBoxes, chartArea, params, stacks);
    }
    handleMaxPadding(chartArea);
    placeBoxes(boxes.leftAndTop, chartArea, params, stacks);
    chartArea.x += chartArea.w;
    chartArea.y += chartArea.h;
    placeBoxes(boxes.rightAndBottom, chartArea, params, stacks);
    chart.chartArea = {
      left: chartArea.left,
      top: chartArea.top,
      right: chartArea.left + chartArea.w,
      bottom: chartArea.top + chartArea.h,
      height: chartArea.h,
      width: chartArea.w
    };
    each(boxes.chartArea, (layout) => {
      const box = layout.box;
      Object.assign(box, chart.chartArea);
      box.update(chartArea.w, chartArea.h, {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0
      });
    });
  }
};
var BasePlatform = class {
  acquireContext(canvas, aspectRatio) {
  }
  releaseContext(context) {
    return false;
  }
  addEventListener(chart, type, listener) {
  }
  removeEventListener(chart, type, listener) {
  }
  getDevicePixelRatio() {
    return 1;
  }
  getMaximumSize(element, width, height, aspectRatio) {
    width = Math.max(0, width || element.width);
    height = height || element.height;
    return {
      width,
      height: Math.max(0, aspectRatio ? Math.floor(width / aspectRatio) : height)
    };
  }
  isAttached(canvas) {
    return true;
  }
  updateConfig(config) {
  }
};
var BasicPlatform = class extends BasePlatform {
  acquireContext(item) {
    return item && item.getContext && item.getContext("2d") || null;
  }
  updateConfig(config) {
    config.options.animation = false;
  }
};
var EXPANDO_KEY = "$chartjs";
var EVENT_TYPES = {
  touchstart: "mousedown",
  touchmove: "mousemove",
  touchend: "mouseup",
  pointerenter: "mouseenter",
  pointerdown: "mousedown",
  pointermove: "mousemove",
  pointerup: "mouseup",
  pointerleave: "mouseout",
  pointerout: "mouseout"
};
var isNullOrEmpty = (value) => value === null || value === "";
function initCanvas(canvas, aspectRatio) {
  const style = canvas.style;
  const renderHeight = canvas.getAttribute("height");
  const renderWidth = canvas.getAttribute("width");
  canvas[EXPANDO_KEY] = {
    initial: {
      height: renderHeight,
      width: renderWidth,
      style: {
        display: style.display,
        height: style.height,
        width: style.width
      }
    }
  };
  style.display = style.display || "block";
  style.boxSizing = style.boxSizing || "border-box";
  if (isNullOrEmpty(renderWidth)) {
    const displayWidth = readUsedSize(canvas, "width");
    if (displayWidth !== void 0) {
      canvas.width = displayWidth;
    }
  }
  if (isNullOrEmpty(renderHeight)) {
    if (canvas.style.height === "") {
      canvas.height = canvas.width / (aspectRatio || 2);
    } else {
      const displayHeight = readUsedSize(canvas, "height");
      if (displayHeight !== void 0) {
        canvas.height = displayHeight;
      }
    }
  }
  return canvas;
}
var eventListenerOptions = supportsEventListenerOptions ? {
  passive: true
} : false;
function addListener(node, type, listener) {
  if (node) {
    node.addEventListener(type, listener, eventListenerOptions);
  }
}
function removeListener(chart, type, listener) {
  if (chart && chart.canvas) {
    chart.canvas.removeEventListener(type, listener, eventListenerOptions);
  }
}
function fromNativeEvent(event, chart) {
  const type = EVENT_TYPES[event.type] || event.type;
  const { x, y } = getRelativePosition(event, chart);
  return {
    type,
    chart,
    native: event,
    x: x !== void 0 ? x : null,
    y: y !== void 0 ? y : null
  };
}
function nodeListContains(nodeList, canvas) {
  for (const node of nodeList) {
    if (node === canvas || node.contains(canvas)) {
      return true;
    }
  }
}
function createAttachObserver(chart, type, listener) {
  const canvas = chart.canvas;
  const observer = new MutationObserver((entries) => {
    let trigger = false;
    for (const entry of entries) {
      trigger = trigger || nodeListContains(entry.addedNodes, canvas);
      trigger = trigger && !nodeListContains(entry.removedNodes, canvas);
    }
    if (trigger) {
      listener();
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true
  });
  return observer;
}
function createDetachObserver(chart, type, listener) {
  const canvas = chart.canvas;
  const observer = new MutationObserver((entries) => {
    let trigger = false;
    for (const entry of entries) {
      trigger = trigger || nodeListContains(entry.removedNodes, canvas);
      trigger = trigger && !nodeListContains(entry.addedNodes, canvas);
    }
    if (trigger) {
      listener();
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true
  });
  return observer;
}
var drpListeningCharts = /* @__PURE__ */ new Map();
var oldDevicePixelRatio = 0;
function onWindowResize() {
  const dpr = window.devicePixelRatio;
  if (dpr === oldDevicePixelRatio) {
    return;
  }
  oldDevicePixelRatio = dpr;
  drpListeningCharts.forEach((resize, chart) => {
    if (chart.currentDevicePixelRatio !== dpr) {
      resize();
    }
  });
}
function listenDevicePixelRatioChanges(chart, resize) {
  if (!drpListeningCharts.size) {
    window.addEventListener("resize", onWindowResize);
  }
  drpListeningCharts.set(chart, resize);
}
function unlistenDevicePixelRatioChanges(chart) {
  drpListeningCharts.delete(chart);
  if (!drpListeningCharts.size) {
    window.removeEventListener("resize", onWindowResize);
  }
}
function createResizeObserver(chart, type, listener) {
  const canvas = chart.canvas;
  const container = canvas && _getParentNode(canvas);
  if (!container) {
    return;
  }
  const resize = throttled((width, height) => {
    const w = container.clientWidth;
    listener(width, height);
    if (w < container.clientWidth) {
      listener();
    }
  }, window);
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    const width = entry.contentRect.width;
    const height = entry.contentRect.height;
    if (width === 0 && height === 0) {
      return;
    }
    resize(width, height);
  });
  observer.observe(container);
  listenDevicePixelRatioChanges(chart, resize);
  return observer;
}
function releaseObserver(chart, type, observer) {
  if (observer) {
    observer.disconnect();
  }
  if (type === "resize") {
    unlistenDevicePixelRatioChanges(chart);
  }
}
function createProxyAndListen(chart, type, listener) {
  const canvas = chart.canvas;
  const proxy = throttled((event) => {
    if (chart.ctx !== null) {
      listener(fromNativeEvent(event, chart));
    }
  }, chart);
  addListener(canvas, type, proxy);
  return proxy;
}
var DomPlatform = class extends BasePlatform {
  acquireContext(canvas, aspectRatio) {
    const context = canvas && canvas.getContext && canvas.getContext("2d");
    if (context && context.canvas === canvas) {
      initCanvas(canvas, aspectRatio);
      return context;
    }
    return null;
  }
  releaseContext(context) {
    const canvas = context.canvas;
    if (!canvas[EXPANDO_KEY]) {
      return false;
    }
    const initial = canvas[EXPANDO_KEY].initial;
    [
      "height",
      "width"
    ].forEach((prop) => {
      const value = initial[prop];
      if (isNullOrUndef(value)) {
        canvas.removeAttribute(prop);
      } else {
        canvas.setAttribute(prop, value);
      }
    });
    const style = initial.style || {};
    Object.keys(style).forEach((key) => {
      canvas.style[key] = style[key];
    });
    canvas.width = canvas.width;
    delete canvas[EXPANDO_KEY];
    return true;
  }
  addEventListener(chart, type, listener) {
    this.removeEventListener(chart, type);
    const proxies = chart.$proxies || (chart.$proxies = {});
    const handlers = {
      attach: createAttachObserver,
      detach: createDetachObserver,
      resize: createResizeObserver
    };
    const handler = handlers[type] || createProxyAndListen;
    proxies[type] = handler(chart, type, listener);
  }
  removeEventListener(chart, type) {
    const proxies = chart.$proxies || (chart.$proxies = {});
    const proxy = proxies[type];
    if (!proxy) {
      return;
    }
    const handlers = {
      attach: releaseObserver,
      detach: releaseObserver,
      resize: releaseObserver
    };
    const handler = handlers[type] || removeListener;
    handler(chart, type, proxy);
    proxies[type] = void 0;
  }
  getDevicePixelRatio() {
    return window.devicePixelRatio;
  }
  getMaximumSize(canvas, width, height, aspectRatio) {
    return getMaximumSize(canvas, width, height, aspectRatio);
  }
  isAttached(canvas) {
    const container = canvas && _getParentNode(canvas);
    return !!(container && container.isConnected);
  }
};
function _detectPlatform(canvas) {
  if (!_isDomSupported() || typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return BasicPlatform;
  }
  return DomPlatform;
}
var Element = class {
  static defaults = {};
  static defaultRoutes = void 0;
  x;
  y;
  active = false;
  options;
  $animations;
  tooltipPosition(useFinalPosition) {
    const { x, y } = this.getProps([
      "x",
      "y"
    ], useFinalPosition);
    return {
      x,
      y
    };
  }
  hasValue() {
    return isNumber(this.x) && isNumber(this.y);
  }
  getProps(props, final) {
    const anims = this.$animations;
    if (!final || !anims) {
      return this;
    }
    const ret = {};
    props.forEach((prop) => {
      ret[prop] = anims[prop] && anims[prop].active() ? anims[prop]._to : this[prop];
    });
    return ret;
  }
};
function autoSkip(scale, ticks) {
  const tickOpts = scale.options.ticks;
  const determinedMaxTicks = determineMaxTicks(scale);
  const ticksLimit = Math.min(tickOpts.maxTicksLimit || determinedMaxTicks, determinedMaxTicks);
  const majorIndices = tickOpts.major.enabled ? getMajorIndices(ticks) : [];
  const numMajorIndices = majorIndices.length;
  const first = majorIndices[0];
  const last = majorIndices[numMajorIndices - 1];
  const newTicks = [];
  if (numMajorIndices > ticksLimit) {
    skipMajors(ticks, newTicks, majorIndices, numMajorIndices / ticksLimit);
    return newTicks;
  }
  const spacing = calculateSpacing(majorIndices, ticks, ticksLimit);
  if (numMajorIndices > 0) {
    let i, ilen;
    const avgMajorSpacing = numMajorIndices > 1 ? Math.round((last - first) / (numMajorIndices - 1)) : null;
    skip(ticks, newTicks, spacing, isNullOrUndef(avgMajorSpacing) ? 0 : first - avgMajorSpacing, first);
    for (i = 0, ilen = numMajorIndices - 1; i < ilen; i++) {
      skip(ticks, newTicks, spacing, majorIndices[i], majorIndices[i + 1]);
    }
    skip(ticks, newTicks, spacing, last, isNullOrUndef(avgMajorSpacing) ? ticks.length : last + avgMajorSpacing);
    return newTicks;
  }
  skip(ticks, newTicks, spacing);
  return newTicks;
}
function determineMaxTicks(scale) {
  const offset = scale.options.offset;
  const tickLength = scale._tickSize();
  const maxScale = scale._length / tickLength + (offset ? 0 : 1);
  const maxChart = scale._maxLength / tickLength;
  return Math.floor(Math.min(maxScale, maxChart));
}
function calculateSpacing(majorIndices, ticks, ticksLimit) {
  const evenMajorSpacing = getEvenSpacing(majorIndices);
  const spacing = ticks.length / ticksLimit;
  if (!evenMajorSpacing) {
    return Math.max(spacing, 1);
  }
  const factors = _factorize(evenMajorSpacing);
  for (let i = 0, ilen = factors.length - 1; i < ilen; i++) {
    const factor = factors[i];
    if (factor > spacing) {
      return factor;
    }
  }
  return Math.max(spacing, 1);
}
function getMajorIndices(ticks) {
  const result = [];
  let i, ilen;
  for (i = 0, ilen = ticks.length; i < ilen; i++) {
    if (ticks[i].major) {
      result.push(i);
    }
  }
  return result;
}
function skipMajors(ticks, newTicks, majorIndices, spacing) {
  let count = 0;
  let next = majorIndices[0];
  let i;
  spacing = Math.ceil(spacing);
  for (i = 0; i < ticks.length; i++) {
    if (i === next) {
      newTicks.push(ticks[i]);
      count++;
      next = majorIndices[count * spacing];
    }
  }
}
function skip(ticks, newTicks, spacing, majorStart, majorEnd) {
  const start = valueOrDefault(majorStart, 0);
  const end = Math.min(valueOrDefault(majorEnd, ticks.length), ticks.length);
  let count = 0;
  let length, i, next;
  spacing = Math.ceil(spacing);
  if (majorEnd) {
    length = majorEnd - majorStart;
    spacing = length / Math.floor(length / spacing);
  }
  next = start;
  while (next < 0) {
    count++;
    next = Math.round(start + count * spacing);
  }
  for (i = Math.max(start, 0); i < end; i++) {
    if (i === next) {
      newTicks.push(ticks[i]);
      count++;
      next = Math.round(start + count * spacing);
    }
  }
}
function getEvenSpacing(arr) {
  const len = arr.length;
  let i, diff;
  if (len < 2) {
    return false;
  }
  for (diff = arr[0], i = 1; i < len; ++i) {
    if (arr[i] - arr[i - 1] !== diff) {
      return false;
    }
  }
  return diff;
}
var reverseAlign = (align) => align === "left" ? "right" : align === "right" ? "left" : align;
var offsetFromEdge = (scale, edge, offset) => edge === "top" || edge === "left" ? scale[edge] + offset : scale[edge] - offset;
var getTicksLimit = (ticksLength, maxTicksLimit) => Math.min(maxTicksLimit || ticksLength, ticksLength);
function sample(arr, numItems) {
  const result = [];
  const increment = arr.length / numItems;
  const len = arr.length;
  let i = 0;
  for (; i < len; i += increment) {
    result.push(arr[Math.floor(i)]);
  }
  return result;
}
function getPixelForGridLine(scale, index2, offsetGridLines) {
  const length = scale.ticks.length;
  const validIndex2 = Math.min(index2, length - 1);
  const start = scale._startPixel;
  const end = scale._endPixel;
  const epsilon = 1e-6;
  let lineValue = scale.getPixelForTick(validIndex2);
  let offset;
  if (offsetGridLines) {
    if (length === 1) {
      offset = Math.max(lineValue - start, end - lineValue);
    } else if (index2 === 0) {
      offset = (scale.getPixelForTick(1) - lineValue) / 2;
    } else {
      offset = (lineValue - scale.getPixelForTick(validIndex2 - 1)) / 2;
    }
    lineValue += validIndex2 < index2 ? offset : -offset;
    if (lineValue < start - epsilon || lineValue > end + epsilon) {
      return;
    }
  }
  return lineValue;
}
function garbageCollect(caches, length) {
  each(caches, (cache) => {
    const gc = cache.gc;
    const gcLen = gc.length / 2;
    let i;
    if (gcLen > length) {
      for (i = 0; i < gcLen; ++i) {
        delete cache.data[gc[i]];
      }
      gc.splice(0, gcLen);
    }
  });
}
function getTickMarkLength(options) {
  return options.drawTicks ? options.tickLength : 0;
}
function getTitleHeight(options, fallback) {
  if (!options.display) {
    return 0;
  }
  const font = toFont(options.font, fallback);
  const padding = toPadding(options.padding);
  const lines = isArray(options.text) ? options.text.length : 1;
  return lines * font.lineHeight + padding.height;
}
function createScaleContext(parent, scale) {
  return createContext(parent, {
    scale,
    type: "scale"
  });
}
function createTickContext(parent, index2, tick) {
  return createContext(parent, {
    tick,
    index: index2,
    type: "tick"
  });
}
function titleAlign(align, position, reverse) {
  let ret = _toLeftRightCenter(align);
  if (reverse && position !== "right" || !reverse && position === "right") {
    ret = reverseAlign(ret);
  }
  return ret;
}
function titleArgs(scale, offset, position, align) {
  const { top, left, bottom, right, chart } = scale;
  const { chartArea, scales: scales2 } = chart;
  let rotation = 0;
  let maxWidth, titleX, titleY;
  const height = bottom - top;
  const width = right - left;
  if (scale.isHorizontal()) {
    titleX = _alignStartEnd(align, left, right);
    if (isObject(position)) {
      const positionAxisID = Object.keys(position)[0];
      const value = position[positionAxisID];
      titleY = scales2[positionAxisID].getPixelForValue(value) + height - offset;
    } else if (position === "center") {
      titleY = (chartArea.bottom + chartArea.top) / 2 + height - offset;
    } else {
      titleY = offsetFromEdge(scale, position, offset);
    }
    maxWidth = right - left;
  } else {
    if (isObject(position)) {
      const positionAxisID = Object.keys(position)[0];
      const value = position[positionAxisID];
      titleX = scales2[positionAxisID].getPixelForValue(value) - width + offset;
    } else if (position === "center") {
      titleX = (chartArea.left + chartArea.right) / 2 - width + offset;
    } else {
      titleX = offsetFromEdge(scale, position, offset);
    }
    titleY = _alignStartEnd(align, bottom, top);
    rotation = position === "left" ? -HALF_PI : HALF_PI;
  }
  return {
    titleX,
    titleY,
    maxWidth,
    rotation
  };
}
var Scale = class _Scale extends Element {
  constructor(cfg) {
    super();
    this.id = cfg.id;
    this.type = cfg.type;
    this.options = void 0;
    this.ctx = cfg.ctx;
    this.chart = cfg.chart;
    this.top = void 0;
    this.bottom = void 0;
    this.left = void 0;
    this.right = void 0;
    this.width = void 0;
    this.height = void 0;
    this._margins = {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0
    };
    this.maxWidth = void 0;
    this.maxHeight = void 0;
    this.paddingTop = void 0;
    this.paddingBottom = void 0;
    this.paddingLeft = void 0;
    this.paddingRight = void 0;
    this.axis = void 0;
    this.labelRotation = void 0;
    this.min = void 0;
    this.max = void 0;
    this._range = void 0;
    this.ticks = [];
    this._gridLineItems = null;
    this._labelItems = null;
    this._labelSizes = null;
    this._length = 0;
    this._maxLength = 0;
    this._longestTextCache = {};
    this._startPixel = void 0;
    this._endPixel = void 0;
    this._reversePixels = false;
    this._userMax = void 0;
    this._userMin = void 0;
    this._suggestedMax = void 0;
    this._suggestedMin = void 0;
    this._ticksLength = 0;
    this._borderValue = 0;
    this._cache = {};
    this._dataLimitsCached = false;
    this.$context = void 0;
  }
  init(options) {
    this.options = options.setContext(this.getContext());
    this.axis = options.axis;
    this._userMin = this.parse(options.min);
    this._userMax = this.parse(options.max);
    this._suggestedMin = this.parse(options.suggestedMin);
    this._suggestedMax = this.parse(options.suggestedMax);
  }
  parse(raw, index2) {
    return raw;
  }
  getUserBounds() {
    let { _userMin, _userMax, _suggestedMin, _suggestedMax } = this;
    _userMin = finiteOrDefault(_userMin, Number.POSITIVE_INFINITY);
    _userMax = finiteOrDefault(_userMax, Number.NEGATIVE_INFINITY);
    _suggestedMin = finiteOrDefault(_suggestedMin, Number.POSITIVE_INFINITY);
    _suggestedMax = finiteOrDefault(_suggestedMax, Number.NEGATIVE_INFINITY);
    return {
      min: finiteOrDefault(_userMin, _suggestedMin),
      max: finiteOrDefault(_userMax, _suggestedMax),
      minDefined: isNumberFinite(_userMin),
      maxDefined: isNumberFinite(_userMax)
    };
  }
  getMinMax(canStack) {
    let { min, max, minDefined, maxDefined } = this.getUserBounds();
    let range;
    if (minDefined && maxDefined) {
      return {
        min,
        max
      };
    }
    const metas = this.getMatchingVisibleMetas();
    for (let i = 0, ilen = metas.length; i < ilen; ++i) {
      range = metas[i].controller.getMinMax(this, canStack);
      if (!minDefined) {
        min = Math.min(min, range.min);
      }
      if (!maxDefined) {
        max = Math.max(max, range.max);
      }
    }
    min = maxDefined && min > max ? max : min;
    max = minDefined && min > max ? min : max;
    return {
      min: finiteOrDefault(min, finiteOrDefault(max, min)),
      max: finiteOrDefault(max, finiteOrDefault(min, max))
    };
  }
  getPadding() {
    return {
      left: this.paddingLeft || 0,
      top: this.paddingTop || 0,
      right: this.paddingRight || 0,
      bottom: this.paddingBottom || 0
    };
  }
  getTicks() {
    return this.ticks;
  }
  getLabels() {
    const data = this.chart.data;
    return this.options.labels || (this.isHorizontal() ? data.xLabels : data.yLabels) || data.labels || [];
  }
  getLabelItems(chartArea = this.chart.chartArea) {
    const items = this._labelItems || (this._labelItems = this._computeLabelItems(chartArea));
    return items;
  }
  beforeLayout() {
    this._cache = {};
    this._dataLimitsCached = false;
  }
  beforeUpdate() {
    callback(this.options.beforeUpdate, [
      this
    ]);
  }
  update(maxWidth, maxHeight, margins) {
    const { beginAtZero, grace, ticks: tickOpts } = this.options;
    const sampleSize = tickOpts.sampleSize;
    this.beforeUpdate();
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this._margins = margins = Object.assign({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0
    }, margins);
    this.ticks = null;
    this._labelSizes = null;
    this._gridLineItems = null;
    this._labelItems = null;
    this.beforeSetDimensions();
    this.setDimensions();
    this.afterSetDimensions();
    this._maxLength = this.isHorizontal() ? this.width + margins.left + margins.right : this.height + margins.top + margins.bottom;
    if (!this._dataLimitsCached) {
      this.beforeDataLimits();
      this.determineDataLimits();
      this.afterDataLimits();
      this._range = _addGrace(this, grace, beginAtZero);
      this._dataLimitsCached = true;
    }
    this.beforeBuildTicks();
    this.ticks = this.buildTicks() || [];
    this.afterBuildTicks();
    const samplingEnabled = sampleSize < this.ticks.length;
    this._convertTicksToLabels(samplingEnabled ? sample(this.ticks, sampleSize) : this.ticks);
    this.configure();
    this.beforeCalculateLabelRotation();
    this.calculateLabelRotation();
    this.afterCalculateLabelRotation();
    if (tickOpts.display && (tickOpts.autoSkip || tickOpts.source === "auto")) {
      this.ticks = autoSkip(this, this.ticks);
      this._labelSizes = null;
      this.afterAutoSkip();
    }
    if (samplingEnabled) {
      this._convertTicksToLabels(this.ticks);
    }
    this.beforeFit();
    this.fit();
    this.afterFit();
    this.afterUpdate();
  }
  configure() {
    let reversePixels = this.options.reverse;
    let startPixel, endPixel;
    if (this.isHorizontal()) {
      startPixel = this.left;
      endPixel = this.right;
    } else {
      startPixel = this.top;
      endPixel = this.bottom;
      reversePixels = !reversePixels;
    }
    this._startPixel = startPixel;
    this._endPixel = endPixel;
    this._reversePixels = reversePixels;
    this._length = endPixel - startPixel;
    this._alignToPixels = this.options.alignToPixels;
  }
  afterUpdate() {
    callback(this.options.afterUpdate, [
      this
    ]);
  }
  beforeSetDimensions() {
    callback(this.options.beforeSetDimensions, [
      this
    ]);
  }
  setDimensions() {
    if (this.isHorizontal()) {
      this.width = this.maxWidth;
      this.left = 0;
      this.right = this.width;
    } else {
      this.height = this.maxHeight;
      this.top = 0;
      this.bottom = this.height;
    }
    this.paddingLeft = 0;
    this.paddingTop = 0;
    this.paddingRight = 0;
    this.paddingBottom = 0;
  }
  afterSetDimensions() {
    callback(this.options.afterSetDimensions, [
      this
    ]);
  }
  _callHooks(name) {
    this.chart.notifyPlugins(name, this.getContext());
    callback(this.options[name], [
      this
    ]);
  }
  beforeDataLimits() {
    this._callHooks("beforeDataLimits");
  }
  determineDataLimits() {
  }
  afterDataLimits() {
    this._callHooks("afterDataLimits");
  }
  beforeBuildTicks() {
    this._callHooks("beforeBuildTicks");
  }
  buildTicks() {
    return [];
  }
  afterBuildTicks() {
    this._callHooks("afterBuildTicks");
  }
  beforeTickToLabelConversion() {
    callback(this.options.beforeTickToLabelConversion, [
      this
    ]);
  }
  generateTickLabels(ticks) {
    const tickOpts = this.options.ticks;
    let i, ilen, tick;
    for (i = 0, ilen = ticks.length; i < ilen; i++) {
      tick = ticks[i];
      tick.label = callback(tickOpts.callback, [
        tick.value,
        i,
        ticks
      ], this);
    }
  }
  afterTickToLabelConversion() {
    callback(this.options.afterTickToLabelConversion, [
      this
    ]);
  }
  beforeCalculateLabelRotation() {
    callback(this.options.beforeCalculateLabelRotation, [
      this
    ]);
  }
  calculateLabelRotation() {
    const options = this.options;
    const tickOpts = options.ticks;
    const numTicks = getTicksLimit(this.ticks.length, options.ticks.maxTicksLimit);
    const minRotation = tickOpts.minRotation || 0;
    const maxRotation = tickOpts.maxRotation;
    let labelRotation = minRotation;
    let tickWidth, maxHeight, maxLabelDiagonal;
    if (!this._isVisible() || !tickOpts.display || minRotation >= maxRotation || numTicks <= 1 || !this.isHorizontal()) {
      this.labelRotation = minRotation;
      return;
    }
    const labelSizes = this._getLabelSizes();
    const maxLabelWidth = labelSizes.widest.width;
    const maxLabelHeight = labelSizes.highest.height;
    const maxWidth = _limitValue(this.chart.width - maxLabelWidth, 0, this.maxWidth);
    tickWidth = options.offset ? this.maxWidth / numTicks : maxWidth / (numTicks - 1);
    if (maxLabelWidth + 6 > tickWidth) {
      tickWidth = maxWidth / (numTicks - (options.offset ? 0.5 : 1));
      maxHeight = this.maxHeight - getTickMarkLength(options.grid) - tickOpts.padding - getTitleHeight(options.title, this.chart.options.font);
      maxLabelDiagonal = Math.sqrt(maxLabelWidth * maxLabelWidth + maxLabelHeight * maxLabelHeight);
      labelRotation = toDegrees(Math.min(Math.asin(_limitValue((labelSizes.highest.height + 6) / tickWidth, -1, 1)), Math.asin(_limitValue(maxHeight / maxLabelDiagonal, -1, 1)) - Math.asin(_limitValue(maxLabelHeight / maxLabelDiagonal, -1, 1))));
      labelRotation = Math.max(minRotation, Math.min(maxRotation, labelRotation));
    }
    this.labelRotation = labelRotation;
  }
  afterCalculateLabelRotation() {
    callback(this.options.afterCalculateLabelRotation, [
      this
    ]);
  }
  afterAutoSkip() {
  }
  beforeFit() {
    callback(this.options.beforeFit, [
      this
    ]);
  }
  fit() {
    const minSize = {
      width: 0,
      height: 0
    };
    const { chart, options: { ticks: tickOpts, title: titleOpts, grid: gridOpts } } = this;
    const display = this._isVisible();
    const isHorizontal = this.isHorizontal();
    if (display) {
      const titleHeight = getTitleHeight(titleOpts, chart.options.font);
      if (isHorizontal) {
        minSize.width = this.maxWidth;
        minSize.height = getTickMarkLength(gridOpts) + titleHeight;
      } else {
        minSize.height = this.maxHeight;
        minSize.width = getTickMarkLength(gridOpts) + titleHeight;
      }
      if (tickOpts.display && this.ticks.length) {
        const { first, last, widest, highest } = this._getLabelSizes();
        const tickPadding = tickOpts.padding * 2;
        const angleRadians = toRadians(this.labelRotation);
        const cos = Math.cos(angleRadians);
        const sin = Math.sin(angleRadians);
        if (isHorizontal) {
          const labelHeight = tickOpts.mirror ? 0 : sin * widest.width + cos * highest.height;
          minSize.height = Math.min(this.maxHeight, minSize.height + labelHeight + tickPadding);
        } else {
          const labelWidth = tickOpts.mirror ? 0 : cos * widest.width + sin * highest.height;
          minSize.width = Math.min(this.maxWidth, minSize.width + labelWidth + tickPadding);
        }
        this._calculatePadding(first, last, sin, cos);
      }
    }
    this._handleMargins();
    if (isHorizontal) {
      this.width = this._length = chart.width - this._margins.left - this._margins.right;
      this.height = minSize.height;
    } else {
      this.width = minSize.width;
      this.height = this._length = chart.height - this._margins.top - this._margins.bottom;
    }
  }
  _calculatePadding(first, last, sin, cos) {
    const { ticks: { align, padding }, position } = this.options;
    const isRotated = this.labelRotation !== 0;
    const labelsBelowTicks = position !== "top" && this.axis === "x";
    if (this.isHorizontal()) {
      const offsetLeft = this.getPixelForTick(0) - this.left;
      const offsetRight = this.right - this.getPixelForTick(this.ticks.length - 1);
      let paddingLeft = 0;
      let paddingRight = 0;
      if (isRotated) {
        if (labelsBelowTicks) {
          paddingLeft = cos * first.width;
          paddingRight = sin * last.height;
        } else {
          paddingLeft = sin * first.height;
          paddingRight = cos * last.width;
        }
      } else if (align === "start") {
        paddingRight = last.width;
      } else if (align === "end") {
        paddingLeft = first.width;
      } else if (align !== "inner") {
        paddingLeft = first.width / 2;
        paddingRight = last.width / 2;
      }
      this.paddingLeft = Math.max((paddingLeft - offsetLeft + padding) * this.width / (this.width - offsetLeft), 0);
      this.paddingRight = Math.max((paddingRight - offsetRight + padding) * this.width / (this.width - offsetRight), 0);
    } else {
      let paddingTop = last.height / 2;
      let paddingBottom = first.height / 2;
      if (align === "start") {
        paddingTop = 0;
        paddingBottom = first.height;
      } else if (align === "end") {
        paddingTop = last.height;
        paddingBottom = 0;
      }
      this.paddingTop = paddingTop + padding;
      this.paddingBottom = paddingBottom + padding;
    }
  }
  _handleMargins() {
    if (this._margins) {
      this._margins.left = Math.max(this.paddingLeft, this._margins.left);
      this._margins.top = Math.max(this.paddingTop, this._margins.top);
      this._margins.right = Math.max(this.paddingRight, this._margins.right);
      this._margins.bottom = Math.max(this.paddingBottom, this._margins.bottom);
    }
  }
  afterFit() {
    callback(this.options.afterFit, [
      this
    ]);
  }
  isHorizontal() {
    const { axis, position } = this.options;
    return position === "top" || position === "bottom" || axis === "x";
  }
  isFullSize() {
    return this.options.fullSize;
  }
  _convertTicksToLabels(ticks) {
    this.beforeTickToLabelConversion();
    this.generateTickLabels(ticks);
    let i, ilen;
    for (i = 0, ilen = ticks.length; i < ilen; i++) {
      if (isNullOrUndef(ticks[i].label)) {
        ticks.splice(i, 1);
        ilen--;
        i--;
      }
    }
    this.afterTickToLabelConversion();
  }
  _getLabelSizes() {
    let labelSizes = this._labelSizes;
    if (!labelSizes) {
      const sampleSize = this.options.ticks.sampleSize;
      let ticks = this.ticks;
      if (sampleSize < ticks.length) {
        ticks = sample(ticks, sampleSize);
      }
      this._labelSizes = labelSizes = this._computeLabelSizes(ticks, ticks.length, this.options.ticks.maxTicksLimit);
    }
    return labelSizes;
  }
  _computeLabelSizes(ticks, length, maxTicksLimit) {
    const { ctx, _longestTextCache: caches } = this;
    const widths = [];
    const heights = [];
    const increment = Math.floor(length / getTicksLimit(length, maxTicksLimit));
    let widestLabelSize = 0;
    let highestLabelSize = 0;
    let i, j, jlen, label, tickFont, fontString, cache, lineHeight, width, height, nestedLabel;
    for (i = 0; i < length; i += increment) {
      label = ticks[i].label;
      tickFont = this._resolveTickFontOptions(i);
      ctx.font = fontString = tickFont.string;
      cache = caches[fontString] = caches[fontString] || {
        data: {},
        gc: []
      };
      lineHeight = tickFont.lineHeight;
      width = height = 0;
      if (!isNullOrUndef(label) && !isArray(label)) {
        width = _measureText(ctx, cache.data, cache.gc, width, label);
        height = lineHeight;
      } else if (isArray(label)) {
        for (j = 0, jlen = label.length; j < jlen; ++j) {
          nestedLabel = label[j];
          if (!isNullOrUndef(nestedLabel) && !isArray(nestedLabel)) {
            width = _measureText(ctx, cache.data, cache.gc, width, nestedLabel);
            height += lineHeight;
          }
        }
      }
      widths.push(width);
      heights.push(height);
      widestLabelSize = Math.max(width, widestLabelSize);
      highestLabelSize = Math.max(height, highestLabelSize);
    }
    garbageCollect(caches, length);
    const widest = widths.indexOf(widestLabelSize);
    const highest = heights.indexOf(highestLabelSize);
    const valueAt = (idx) => ({
      width: widths[idx] || 0,
      height: heights[idx] || 0
    });
    return {
      first: valueAt(0),
      last: valueAt(length - 1),
      widest: valueAt(widest),
      highest: valueAt(highest),
      widths,
      heights
    };
  }
  getLabelForValue(value) {
    return value;
  }
  getPixelForValue(value, index2) {
    return NaN;
  }
  getValueForPixel(pixel) {
  }
  getPixelForTick(index2) {
    const ticks = this.ticks;
    if (index2 < 0 || index2 > ticks.length - 1) {
      return null;
    }
    return this.getPixelForValue(ticks[index2].value);
  }
  getPixelForDecimal(decimal) {
    if (this._reversePixels) {
      decimal = 1 - decimal;
    }
    const pixel = this._startPixel + decimal * this._length;
    return _int16Range(this._alignToPixels ? _alignPixel(this.chart, pixel, 0) : pixel);
  }
  getDecimalForPixel(pixel) {
    const decimal = (pixel - this._startPixel) / this._length;
    return this._reversePixels ? 1 - decimal : decimal;
  }
  getBasePixel() {
    return this.getPixelForValue(this.getBaseValue());
  }
  getBaseValue() {
    const { min, max } = this;
    return min < 0 && max < 0 ? max : min > 0 && max > 0 ? min : 0;
  }
  getContext(index2) {
    const ticks = this.ticks || [];
    if (index2 >= 0 && index2 < ticks.length) {
      const tick = ticks[index2];
      return tick.$context || (tick.$context = createTickContext(this.getContext(), index2, tick));
    }
    return this.$context || (this.$context = createScaleContext(this.chart.getContext(), this));
  }
  _tickSize() {
    const optionTicks = this.options.ticks;
    const rot = toRadians(this.labelRotation);
    const cos = Math.abs(Math.cos(rot));
    const sin = Math.abs(Math.sin(rot));
    const labelSizes = this._getLabelSizes();
    const padding = optionTicks.autoSkipPadding || 0;
    const w = labelSizes ? labelSizes.widest.width + padding : 0;
    const h4 = labelSizes ? labelSizes.highest.height + padding : 0;
    return this.isHorizontal() ? h4 * cos > w * sin ? w / cos : h4 / sin : h4 * sin < w * cos ? h4 / cos : w / sin;
  }
  _isVisible() {
    const display = this.options.display;
    if (display !== "auto") {
      return !!display;
    }
    return this.getMatchingVisibleMetas().length > 0;
  }
  _computeGridLineItems(chartArea) {
    const axis = this.axis;
    const chart = this.chart;
    const options = this.options;
    const { grid, position, border } = options;
    const offset = grid.offset;
    const isHorizontal = this.isHorizontal();
    const ticks = this.ticks;
    const ticksLength = ticks.length + (offset ? 1 : 0);
    const tl = getTickMarkLength(grid);
    const items = [];
    const borderOpts = border.setContext(this.getContext());
    const axisWidth = borderOpts.display ? borderOpts.width : 0;
    const axisHalfWidth = axisWidth / 2;
    const alignBorderValue = function(pixel) {
      return _alignPixel(chart, pixel, axisWidth);
    };
    let borderValue, i, lineValue, alignedLineValue;
    let tx1, ty1, tx2, ty2, x1, y1, x2, y2;
    if (position === "top") {
      borderValue = alignBorderValue(this.bottom);
      ty1 = this.bottom - tl;
      ty2 = borderValue - axisHalfWidth;
      y1 = alignBorderValue(chartArea.top) + axisHalfWidth;
      y2 = chartArea.bottom;
    } else if (position === "bottom") {
      borderValue = alignBorderValue(this.top);
      y1 = chartArea.top;
      y2 = alignBorderValue(chartArea.bottom) - axisHalfWidth;
      ty1 = borderValue + axisHalfWidth;
      ty2 = this.top + tl;
    } else if (position === "left") {
      borderValue = alignBorderValue(this.right);
      tx1 = this.right - tl;
      tx2 = borderValue - axisHalfWidth;
      x1 = alignBorderValue(chartArea.left) + axisHalfWidth;
      x2 = chartArea.right;
    } else if (position === "right") {
      borderValue = alignBorderValue(this.left);
      x1 = chartArea.left;
      x2 = alignBorderValue(chartArea.right) - axisHalfWidth;
      tx1 = borderValue + axisHalfWidth;
      tx2 = this.left + tl;
    } else if (axis === "x") {
      if (position === "center") {
        borderValue = alignBorderValue((chartArea.top + chartArea.bottom) / 2 + 0.5);
      } else if (isObject(position)) {
        const positionAxisID = Object.keys(position)[0];
        const value = position[positionAxisID];
        borderValue = alignBorderValue(this.chart.scales[positionAxisID].getPixelForValue(value));
      }
      y1 = chartArea.top;
      y2 = chartArea.bottom;
      ty1 = borderValue + axisHalfWidth;
      ty2 = ty1 + tl;
    } else if (axis === "y") {
      if (position === "center") {
        borderValue = alignBorderValue((chartArea.left + chartArea.right) / 2);
      } else if (isObject(position)) {
        const positionAxisID = Object.keys(position)[0];
        const value = position[positionAxisID];
        borderValue = alignBorderValue(this.chart.scales[positionAxisID].getPixelForValue(value));
      }
      tx1 = borderValue - axisHalfWidth;
      tx2 = tx1 - tl;
      x1 = chartArea.left;
      x2 = chartArea.right;
    }
    const limit = valueOrDefault(options.ticks.maxTicksLimit, ticksLength);
    const step = Math.max(1, Math.ceil(ticksLength / limit));
    for (i = 0; i < ticksLength; i += step) {
      const context = this.getContext(i);
      const optsAtIndex = grid.setContext(context);
      const optsAtIndexBorder = border.setContext(context);
      const lineWidth = optsAtIndex.lineWidth;
      const lineColor = optsAtIndex.color;
      const borderDash = optsAtIndexBorder.dash || [];
      const borderDashOffset = optsAtIndexBorder.dashOffset;
      const tickWidth = optsAtIndex.tickWidth;
      const tickColor = optsAtIndex.tickColor;
      const tickBorderDash = optsAtIndex.tickBorderDash || [];
      const tickBorderDashOffset = optsAtIndex.tickBorderDashOffset;
      lineValue = getPixelForGridLine(this, i, offset);
      if (lineValue === void 0) {
        continue;
      }
      alignedLineValue = _alignPixel(chart, lineValue, lineWidth);
      if (isHorizontal) {
        tx1 = tx2 = x1 = x2 = alignedLineValue;
      } else {
        ty1 = ty2 = y1 = y2 = alignedLineValue;
      }
      items.push({
        tx1,
        ty1,
        tx2,
        ty2,
        x1,
        y1,
        x2,
        y2,
        width: lineWidth,
        color: lineColor,
        borderDash,
        borderDashOffset,
        tickWidth,
        tickColor,
        tickBorderDash,
        tickBorderDashOffset
      });
    }
    this._ticksLength = ticksLength;
    this._borderValue = borderValue;
    return items;
  }
  _computeLabelItems(chartArea) {
    const axis = this.axis;
    const options = this.options;
    const { position, ticks: optionTicks } = options;
    const isHorizontal = this.isHorizontal();
    const ticks = this.ticks;
    const { align, crossAlign, padding, mirror } = optionTicks;
    const tl = getTickMarkLength(options.grid);
    const tickAndPadding = tl + padding;
    const hTickAndPadding = mirror ? -padding : tickAndPadding;
    const rotation = -toRadians(this.labelRotation);
    const items = [];
    let i, ilen, tick, label, x, y, textAlign, pixel, font, lineHeight, lineCount, textOffset;
    let textBaseline = "middle";
    if (position === "top") {
      y = this.bottom - hTickAndPadding;
      textAlign = this._getXAxisLabelAlignment();
    } else if (position === "bottom") {
      y = this.top + hTickAndPadding;
      textAlign = this._getXAxisLabelAlignment();
    } else if (position === "left") {
      const ret = this._getYAxisLabelAlignment(tl);
      textAlign = ret.textAlign;
      x = ret.x;
    } else if (position === "right") {
      const ret = this._getYAxisLabelAlignment(tl);
      textAlign = ret.textAlign;
      x = ret.x;
    } else if (axis === "x") {
      if (position === "center") {
        y = (chartArea.top + chartArea.bottom) / 2 + tickAndPadding;
      } else if (isObject(position)) {
        const positionAxisID = Object.keys(position)[0];
        const value = position[positionAxisID];
        y = this.chart.scales[positionAxisID].getPixelForValue(value) + tickAndPadding;
      }
      textAlign = this._getXAxisLabelAlignment();
    } else if (axis === "y") {
      if (position === "center") {
        x = (chartArea.left + chartArea.right) / 2 - tickAndPadding;
      } else if (isObject(position)) {
        const positionAxisID = Object.keys(position)[0];
        const value = position[positionAxisID];
        x = this.chart.scales[positionAxisID].getPixelForValue(value);
      }
      textAlign = this._getYAxisLabelAlignment(tl).textAlign;
    }
    if (axis === "y") {
      if (align === "start") {
        textBaseline = "top";
      } else if (align === "end") {
        textBaseline = "bottom";
      }
    }
    const labelSizes = this._getLabelSizes();
    for (i = 0, ilen = ticks.length; i < ilen; ++i) {
      tick = ticks[i];
      label = tick.label;
      const optsAtIndex = optionTicks.setContext(this.getContext(i));
      pixel = this.getPixelForTick(i) + optionTicks.labelOffset;
      font = this._resolveTickFontOptions(i);
      lineHeight = font.lineHeight;
      lineCount = isArray(label) ? label.length : 1;
      const halfCount = lineCount / 2;
      const color2 = optsAtIndex.color;
      const strokeColor = optsAtIndex.textStrokeColor;
      const strokeWidth = optsAtIndex.textStrokeWidth;
      let tickTextAlign = textAlign;
      if (isHorizontal) {
        x = pixel;
        if (textAlign === "inner") {
          if (i === ilen - 1) {
            tickTextAlign = !this.options.reverse ? "right" : "left";
          } else if (i === 0) {
            tickTextAlign = !this.options.reverse ? "left" : "right";
          } else {
            tickTextAlign = "center";
          }
        }
        if (position === "top") {
          if (crossAlign === "near" || rotation !== 0) {
            textOffset = -lineCount * lineHeight + lineHeight / 2;
          } else if (crossAlign === "center") {
            textOffset = -labelSizes.highest.height / 2 - halfCount * lineHeight + lineHeight;
          } else {
            textOffset = -labelSizes.highest.height + lineHeight / 2;
          }
        } else {
          if (crossAlign === "near" || rotation !== 0) {
            textOffset = lineHeight / 2;
          } else if (crossAlign === "center") {
            textOffset = labelSizes.highest.height / 2 - halfCount * lineHeight;
          } else {
            textOffset = labelSizes.highest.height - lineCount * lineHeight;
          }
        }
        if (mirror) {
          textOffset *= -1;
        }
        if (rotation !== 0 && !optsAtIndex.showLabelBackdrop) {
          x += lineHeight / 2 * Math.sin(rotation);
        }
      } else {
        y = pixel;
        textOffset = (1 - lineCount) * lineHeight / 2;
      }
      let backdrop;
      if (optsAtIndex.showLabelBackdrop) {
        const labelPadding = toPadding(optsAtIndex.backdropPadding);
        const height = labelSizes.heights[i];
        const width = labelSizes.widths[i];
        let top = textOffset - labelPadding.top;
        let left = 0 - labelPadding.left;
        switch (textBaseline) {
          case "middle":
            top -= height / 2;
            break;
          case "bottom":
            top -= height;
            break;
        }
        switch (textAlign) {
          case "center":
            left -= width / 2;
            break;
          case "right":
            left -= width;
            break;
          case "inner":
            if (i === ilen - 1) {
              left -= width;
            } else if (i > 0) {
              left -= width / 2;
            }
            break;
        }
        backdrop = {
          left,
          top,
          width: width + labelPadding.width,
          height: height + labelPadding.height,
          color: optsAtIndex.backdropColor
        };
      }
      items.push({
        label,
        font,
        textOffset,
        options: {
          rotation,
          color: color2,
          strokeColor,
          strokeWidth,
          textAlign: tickTextAlign,
          textBaseline,
          translation: [
            x,
            y
          ],
          backdrop
        }
      });
    }
    return items;
  }
  _getXAxisLabelAlignment() {
    const { position, ticks } = this.options;
    const rotation = -toRadians(this.labelRotation);
    if (rotation) {
      return position === "top" ? "left" : "right";
    }
    let align = "center";
    if (ticks.align === "start") {
      align = "left";
    } else if (ticks.align === "end") {
      align = "right";
    } else if (ticks.align === "inner") {
      align = "inner";
    }
    return align;
  }
  _getYAxisLabelAlignment(tl) {
    const { position, ticks: { crossAlign, mirror, padding } } = this.options;
    const labelSizes = this._getLabelSizes();
    const tickAndPadding = tl + padding;
    const widest = labelSizes.widest.width;
    let textAlign;
    let x;
    if (position === "left") {
      if (mirror) {
        x = this.right + padding;
        if (crossAlign === "near") {
          textAlign = "left";
        } else if (crossAlign === "center") {
          textAlign = "center";
          x += widest / 2;
        } else {
          textAlign = "right";
          x += widest;
        }
      } else {
        x = this.right - tickAndPadding;
        if (crossAlign === "near") {
          textAlign = "right";
        } else if (crossAlign === "center") {
          textAlign = "center";
          x -= widest / 2;
        } else {
          textAlign = "left";
          x = this.left;
        }
      }
    } else if (position === "right") {
      if (mirror) {
        x = this.left + padding;
        if (crossAlign === "near") {
          textAlign = "right";
        } else if (crossAlign === "center") {
          textAlign = "center";
          x -= widest / 2;
        } else {
          textAlign = "left";
          x -= widest;
        }
      } else {
        x = this.left + tickAndPadding;
        if (crossAlign === "near") {
          textAlign = "left";
        } else if (crossAlign === "center") {
          textAlign = "center";
          x += widest / 2;
        } else {
          textAlign = "right";
          x = this.right;
        }
      }
    } else {
      textAlign = "right";
    }
    return {
      textAlign,
      x
    };
  }
  _computeLabelArea() {
    if (this.options.ticks.mirror) {
      return;
    }
    const chart = this.chart;
    const position = this.options.position;
    if (position === "left" || position === "right") {
      return {
        top: 0,
        left: this.left,
        bottom: chart.height,
        right: this.right
      };
    }
    if (position === "top" || position === "bottom") {
      return {
        top: this.top,
        left: 0,
        bottom: this.bottom,
        right: chart.width
      };
    }
  }
  drawBackground() {
    const { ctx, options: { backgroundColor }, left, top, width, height } = this;
    if (backgroundColor) {
      ctx.save();
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(left, top, width, height);
      ctx.restore();
    }
  }
  getLineWidthForValue(value) {
    const grid = this.options.grid;
    if (!this._isVisible() || !grid.display) {
      return 0;
    }
    const ticks = this.ticks;
    const index2 = ticks.findIndex((t) => t.value === value);
    if (index2 >= 0) {
      const opts = grid.setContext(this.getContext(index2));
      return opts.lineWidth;
    }
    return 0;
  }
  drawGrid(chartArea) {
    const grid = this.options.grid;
    const ctx = this.ctx;
    const items = this._gridLineItems || (this._gridLineItems = this._computeGridLineItems(chartArea));
    let i, ilen;
    const drawLine = (p1, p2, style) => {
      if (!style.width || !style.color) {
        return;
      }
      ctx.save();
      ctx.lineWidth = style.width;
      ctx.strokeStyle = style.color;
      ctx.setLineDash(style.borderDash || []);
      ctx.lineDashOffset = style.borderDashOffset;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    };
    if (grid.display) {
      for (i = 0, ilen = items.length; i < ilen; ++i) {
        const item = items[i];
        if (grid.drawOnChartArea) {
          drawLine({
            x: item.x1,
            y: item.y1
          }, {
            x: item.x2,
            y: item.y2
          }, item);
        }
        if (grid.drawTicks) {
          drawLine({
            x: item.tx1,
            y: item.ty1
          }, {
            x: item.tx2,
            y: item.ty2
          }, {
            color: item.tickColor,
            width: item.tickWidth,
            borderDash: item.tickBorderDash,
            borderDashOffset: item.tickBorderDashOffset
          });
        }
      }
    }
  }
  drawBorder() {
    const { chart, ctx, options: { border, grid } } = this;
    const borderOpts = border.setContext(this.getContext());
    const axisWidth = border.display ? borderOpts.width : 0;
    if (!axisWidth) {
      return;
    }
    const lastLineWidth = grid.setContext(this.getContext(0)).lineWidth;
    const borderValue = this._borderValue;
    let x1, x2, y1, y2;
    if (this.isHorizontal()) {
      x1 = _alignPixel(chart, this.left, axisWidth) - axisWidth / 2;
      x2 = _alignPixel(chart, this.right, lastLineWidth) + lastLineWidth / 2;
      y1 = y2 = borderValue;
    } else {
      y1 = _alignPixel(chart, this.top, axisWidth) - axisWidth / 2;
      y2 = _alignPixel(chart, this.bottom, lastLineWidth) + lastLineWidth / 2;
      x1 = x2 = borderValue;
    }
    ctx.save();
    ctx.lineWidth = borderOpts.width;
    ctx.strokeStyle = borderOpts.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
  drawLabels(chartArea) {
    const optionTicks = this.options.ticks;
    if (!optionTicks.display) {
      return;
    }
    const ctx = this.ctx;
    const area = this._computeLabelArea();
    if (area) {
      clipArea(ctx, area);
    }
    const items = this.getLabelItems(chartArea);
    for (const item of items) {
      const renderTextOptions = item.options;
      const tickFont = item.font;
      const label = item.label;
      const y = item.textOffset;
      renderText(ctx, label, 0, y, tickFont, renderTextOptions);
    }
    if (area) {
      unclipArea(ctx);
    }
  }
  drawTitle() {
    const { ctx, options: { position, title, reverse } } = this;
    if (!title.display) {
      return;
    }
    const font = toFont(title.font);
    const padding = toPadding(title.padding);
    const align = title.align;
    let offset = font.lineHeight / 2;
    if (position === "bottom" || position === "center" || isObject(position)) {
      offset += padding.bottom;
      if (isArray(title.text)) {
        offset += font.lineHeight * (title.text.length - 1);
      }
    } else {
      offset += padding.top;
    }
    const { titleX, titleY, maxWidth, rotation } = titleArgs(this, offset, position, align);
    renderText(ctx, title.text, 0, 0, font, {
      color: title.color,
      maxWidth,
      rotation,
      textAlign: titleAlign(align, position, reverse),
      textBaseline: "middle",
      translation: [
        titleX,
        titleY
      ]
    });
  }
  draw(chartArea) {
    if (!this._isVisible()) {
      return;
    }
    this.drawBackground();
    this.drawGrid(chartArea);
    this.drawBorder();
    this.drawTitle();
    this.drawLabels(chartArea);
  }
  _layers() {
    const opts = this.options;
    const tz = opts.ticks && opts.ticks.z || 0;
    const gz = valueOrDefault(opts.grid && opts.grid.z, -1);
    const bz = valueOrDefault(opts.border && opts.border.z, 0);
    if (!this._isVisible() || this.draw !== _Scale.prototype.draw) {
      return [
        {
          z: tz,
          draw: (chartArea) => {
            this.draw(chartArea);
          }
        }
      ];
    }
    return [
      {
        z: gz,
        draw: (chartArea) => {
          this.drawBackground();
          this.drawGrid(chartArea);
          this.drawTitle();
        }
      },
      {
        z: bz,
        draw: () => {
          this.drawBorder();
        }
      },
      {
        z: tz,
        draw: (chartArea) => {
          this.drawLabels(chartArea);
        }
      }
    ];
  }
  getMatchingVisibleMetas(type) {
    const metas = this.chart.getSortedVisibleDatasetMetas();
    const axisID = this.axis + "AxisID";
    const result = [];
    let i, ilen;
    for (i = 0, ilen = metas.length; i < ilen; ++i) {
      const meta = metas[i];
      if (meta[axisID] === this.id && (!type || meta.type === type)) {
        result.push(meta);
      }
    }
    return result;
  }
  _resolveTickFontOptions(index2) {
    const opts = this.options.ticks.setContext(this.getContext(index2));
    return toFont(opts.font);
  }
  _maxDigits() {
    const fontSize = this._resolveTickFontOptions(0).lineHeight;
    return (this.isHorizontal() ? this.width : this.height) / fontSize;
  }
};
var TypedRegistry = class {
  constructor(type, scope, override) {
    this.type = type;
    this.scope = scope;
    this.override = override;
    this.items = /* @__PURE__ */ Object.create(null);
  }
  isForType(type) {
    return Object.prototype.isPrototypeOf.call(this.type.prototype, type.prototype);
  }
  register(item) {
    const proto = Object.getPrototypeOf(item);
    let parentScope;
    if (isIChartComponent(proto)) {
      parentScope = this.register(proto);
    }
    const items = this.items;
    const id = item.id;
    const scope = this.scope + "." + id;
    if (!id) {
      throw new Error("class does not have id: " + item);
    }
    if (id in items) {
      return scope;
    }
    items[id] = item;
    registerDefaults(item, scope, parentScope);
    if (this.override) {
      defaults.override(item.id, item.overrides);
    }
    return scope;
  }
  get(id) {
    return this.items[id];
  }
  unregister(item) {
    const items = this.items;
    const id = item.id;
    const scope = this.scope;
    if (id in items) {
      delete items[id];
    }
    if (scope && id in defaults[scope]) {
      delete defaults[scope][id];
      if (this.override) {
        delete overrides[id];
      }
    }
  }
};
function registerDefaults(item, scope, parentScope) {
  const itemDefaults = merge(/* @__PURE__ */ Object.create(null), [
    parentScope ? defaults.get(parentScope) : {},
    defaults.get(scope),
    item.defaults
  ]);
  defaults.set(scope, itemDefaults);
  if (item.defaultRoutes) {
    routeDefaults(scope, item.defaultRoutes);
  }
  if (item.descriptors) {
    defaults.describe(scope, item.descriptors);
  }
}
function routeDefaults(scope, routes) {
  Object.keys(routes).forEach((property) => {
    const propertyParts = property.split(".");
    const sourceName = propertyParts.pop();
    const sourceScope = [
      scope
    ].concat(propertyParts).join(".");
    const parts = routes[property].split(".");
    const targetName = parts.pop();
    const targetScope = parts.join(".");
    defaults.route(sourceScope, sourceName, targetScope, targetName);
  });
}
function isIChartComponent(proto) {
  return "id" in proto && "defaults" in proto;
}
var Registry = class {
  constructor() {
    this.controllers = new TypedRegistry(DatasetController, "datasets", true);
    this.elements = new TypedRegistry(Element, "elements");
    this.plugins = new TypedRegistry(Object, "plugins");
    this.scales = new TypedRegistry(Scale, "scales");
    this._typedRegistries = [
      this.controllers,
      this.scales,
      this.elements
    ];
  }
  add(...args) {
    this._each("register", args);
  }
  remove(...args) {
    this._each("unregister", args);
  }
  addControllers(...args) {
    this._each("register", args, this.controllers);
  }
  addElements(...args) {
    this._each("register", args, this.elements);
  }
  addPlugins(...args) {
    this._each("register", args, this.plugins);
  }
  addScales(...args) {
    this._each("register", args, this.scales);
  }
  getController(id) {
    return this._get(id, this.controllers, "controller");
  }
  getElement(id) {
    return this._get(id, this.elements, "element");
  }
  getPlugin(id) {
    return this._get(id, this.plugins, "plugin");
  }
  getScale(id) {
    return this._get(id, this.scales, "scale");
  }
  removeControllers(...args) {
    this._each("unregister", args, this.controllers);
  }
  removeElements(...args) {
    this._each("unregister", args, this.elements);
  }
  removePlugins(...args) {
    this._each("unregister", args, this.plugins);
  }
  removeScales(...args) {
    this._each("unregister", args, this.scales);
  }
  _each(method, args, typedRegistry) {
    [
      ...args
    ].forEach((arg) => {
      const reg = typedRegistry || this._getRegistryForType(arg);
      if (typedRegistry || reg.isForType(arg) || reg === this.plugins && arg.id) {
        this._exec(method, reg, arg);
      } else {
        each(arg, (item) => {
          const itemReg = typedRegistry || this._getRegistryForType(item);
          this._exec(method, itemReg, item);
        });
      }
    });
  }
  _exec(method, registry2, component) {
    const camelMethod = _capitalize(method);
    callback(component["before" + camelMethod], [], component);
    registry2[method](component);
    callback(component["after" + camelMethod], [], component);
  }
  _getRegistryForType(type) {
    for (let i = 0; i < this._typedRegistries.length; i++) {
      const reg = this._typedRegistries[i];
      if (reg.isForType(type)) {
        return reg;
      }
    }
    return this.plugins;
  }
  _get(id, typedRegistry, type) {
    const item = typedRegistry.get(id);
    if (item === void 0) {
      throw new Error('"' + id + '" is not a registered ' + type + ".");
    }
    return item;
  }
};
var registry = /* @__PURE__ */ new Registry();
var PluginService = class {
  constructor() {
    this._init = void 0;
  }
  notify(chart, hook, args, filter) {
    if (hook === "beforeInit") {
      this._init = this._createDescriptors(chart, true);
      this._notify(this._init, chart, "install");
    }
    if (this._init === void 0) {
      return;
    }
    const descriptors2 = filter ? this._descriptors(chart).filter(filter) : this._descriptors(chart);
    const result = this._notify(descriptors2, chart, hook, args);
    if (hook === "afterDestroy") {
      this._notify(descriptors2, chart, "stop");
      this._notify(this._init, chart, "uninstall");
      this._init = void 0;
    }
    return result;
  }
  _notify(descriptors2, chart, hook, args) {
    args = args || {};
    for (const descriptor of descriptors2) {
      const plugin = descriptor.plugin;
      const method = plugin[hook];
      const params = [
        chart,
        args,
        descriptor.options
      ];
      if (callback(method, params, plugin) === false && args.cancelable) {
        return false;
      }
    }
    return true;
  }
  invalidate() {
    if (!isNullOrUndef(this._cache)) {
      this._oldCache = this._cache;
      this._cache = void 0;
    }
  }
  _descriptors(chart) {
    if (this._cache) {
      return this._cache;
    }
    const descriptors2 = this._cache = this._createDescriptors(chart);
    this._notifyStateChanges(chart);
    return descriptors2;
  }
  _createDescriptors(chart, all) {
    const config = chart && chart.config;
    const options = valueOrDefault(config.options && config.options.plugins, {});
    const plugins2 = allPlugins(config);
    return options === false && !all ? [] : createDescriptors(chart, plugins2, options, all);
  }
  _notifyStateChanges(chart) {
    const previousDescriptors = this._oldCache || [];
    const descriptors2 = this._cache;
    const diff = (a, b) => a.filter((x) => !b.some((y) => x.plugin.id === y.plugin.id));
    this._notify(diff(previousDescriptors, descriptors2), chart, "stop");
    this._notify(diff(descriptors2, previousDescriptors), chart, "start");
  }
};
function allPlugins(config) {
  const localIds = {};
  const plugins2 = [];
  const keys = Object.keys(registry.plugins.items);
  for (let i = 0; i < keys.length; i++) {
    plugins2.push(registry.getPlugin(keys[i]));
  }
  const local = config.plugins || [];
  for (let i = 0; i < local.length; i++) {
    const plugin = local[i];
    if (plugins2.indexOf(plugin) === -1) {
      plugins2.push(plugin);
      localIds[plugin.id] = true;
    }
  }
  return {
    plugins: plugins2,
    localIds
  };
}
function getOpts(options, all) {
  if (!all && options === false) {
    return null;
  }
  if (options === true) {
    return {};
  }
  return options;
}
function createDescriptors(chart, { plugins: plugins2, localIds }, options, all) {
  const result = [];
  const context = chart.getContext();
  for (const plugin of plugins2) {
    const id = plugin.id;
    const opts = getOpts(options[id], all);
    if (opts === null) {
      continue;
    }
    result.push({
      plugin,
      options: pluginOpts(chart.config, {
        plugin,
        local: localIds[id]
      }, opts, context)
    });
  }
  return result;
}
function pluginOpts(config, { plugin, local }, opts, context) {
  const keys = config.pluginScopeKeys(plugin);
  const scopes = config.getOptionScopes(opts, keys);
  if (local && plugin.defaults) {
    scopes.push(plugin.defaults);
  }
  return config.createResolver(scopes, context, [
    ""
  ], {
    scriptable: false,
    indexable: false,
    allKeys: true
  });
}
function getIndexAxis(type, options) {
  const datasetDefaults = defaults.datasets[type] || {};
  const datasetOptions = (options.datasets || {})[type] || {};
  return datasetOptions.indexAxis || options.indexAxis || datasetDefaults.indexAxis || "x";
}
function getAxisFromDefaultScaleID(id, indexAxis) {
  let axis = id;
  if (id === "_index_") {
    axis = indexAxis;
  } else if (id === "_value_") {
    axis = indexAxis === "x" ? "y" : "x";
  }
  return axis;
}
function getDefaultScaleIDFromAxis(axis, indexAxis) {
  return axis === indexAxis ? "_index_" : "_value_";
}
function idMatchesAxis(id) {
  if (id === "x" || id === "y" || id === "r") {
    return id;
  }
}
function axisFromPosition(position) {
  if (position === "top" || position === "bottom") {
    return "x";
  }
  if (position === "left" || position === "right") {
    return "y";
  }
}
function determineAxis(id, ...scaleOptions) {
  if (idMatchesAxis(id)) {
    return id;
  }
  for (const opts of scaleOptions) {
    const axis = opts.axis || axisFromPosition(opts.position) || id.length > 1 && idMatchesAxis(id[0].toLowerCase());
    if (axis) {
      return axis;
    }
  }
  throw new Error(`Cannot determine type of '${id}' axis. Please provide 'axis' or 'position' option.`);
}
function getAxisFromDataset(id, axis, dataset) {
  if (dataset[axis + "AxisID"] === id) {
    return {
      axis
    };
  }
}
function retrieveAxisFromDatasets(id, config) {
  if (config.data && config.data.datasets) {
    const boundDs = config.data.datasets.filter((d) => d.xAxisID === id || d.yAxisID === id);
    if (boundDs.length) {
      return getAxisFromDataset(id, "x", boundDs[0]) || getAxisFromDataset(id, "y", boundDs[0]);
    }
  }
  return {};
}
function mergeScaleConfig(config, options) {
  const chartDefaults = overrides[config.type] || {
    scales: {}
  };
  const configScales = options.scales || {};
  const chartIndexAxis = getIndexAxis(config.type, options);
  const scales2 = /* @__PURE__ */ Object.create(null);
  Object.keys(configScales).forEach((id) => {
    const scaleConf = configScales[id];
    if (!isObject(scaleConf)) {
      return console.error(`Invalid scale configuration for scale: ${id}`);
    }
    if (scaleConf._proxy) {
      return console.warn(`Ignoring resolver passed as options for scale: ${id}`);
    }
    const axis = determineAxis(id, scaleConf, retrieveAxisFromDatasets(id, config), defaults.scales[scaleConf.type]);
    const defaultId = getDefaultScaleIDFromAxis(axis, chartIndexAxis);
    const defaultScaleOptions = chartDefaults.scales || {};
    scales2[id] = mergeIf(/* @__PURE__ */ Object.create(null), [
      {
        axis
      },
      scaleConf,
      defaultScaleOptions[axis],
      defaultScaleOptions[defaultId]
    ]);
  });
  config.data.datasets.forEach((dataset) => {
    const type = dataset.type || config.type;
    const indexAxis = dataset.indexAxis || getIndexAxis(type, options);
    const datasetDefaults = overrides[type] || {};
    const defaultScaleOptions = datasetDefaults.scales || {};
    Object.keys(defaultScaleOptions).forEach((defaultID) => {
      const axis = getAxisFromDefaultScaleID(defaultID, indexAxis);
      const id = dataset[axis + "AxisID"] || axis;
      scales2[id] = scales2[id] || /* @__PURE__ */ Object.create(null);
      mergeIf(scales2[id], [
        {
          axis
        },
        configScales[id],
        defaultScaleOptions[defaultID]
      ]);
    });
  });
  Object.keys(scales2).forEach((key) => {
    const scale = scales2[key];
    mergeIf(scale, [
      defaults.scales[scale.type],
      defaults.scale
    ]);
  });
  return scales2;
}
function initOptions(config) {
  const options = config.options || (config.options = {});
  options.plugins = valueOrDefault(options.plugins, {});
  options.scales = mergeScaleConfig(config, options);
}
function initData(data) {
  data = data || {};
  data.datasets = data.datasets || [];
  data.labels = data.labels || [];
  return data;
}
function initConfig(config) {
  config = config || {};
  config.data = initData(config.data);
  initOptions(config);
  return config;
}
var keyCache = /* @__PURE__ */ new Map();
var keysCached = /* @__PURE__ */ new Set();
function cachedKeys(cacheKey, generate) {
  let keys = keyCache.get(cacheKey);
  if (!keys) {
    keys = generate();
    keyCache.set(cacheKey, keys);
    keysCached.add(keys);
  }
  return keys;
}
var addIfFound = (set2, obj, key) => {
  const opts = resolveObjectKey(obj, key);
  if (opts !== void 0) {
    set2.add(opts);
  }
};
var Config = class {
  constructor(config) {
    this._config = initConfig(config);
    this._scopeCache = /* @__PURE__ */ new Map();
    this._resolverCache = /* @__PURE__ */ new Map();
  }
  get platform() {
    return this._config.platform;
  }
  get type() {
    return this._config.type;
  }
  set type(type) {
    this._config.type = type;
  }
  get data() {
    return this._config.data;
  }
  set data(data) {
    this._config.data = initData(data);
  }
  get options() {
    return this._config.options;
  }
  set options(options) {
    this._config.options = options;
  }
  get plugins() {
    return this._config.plugins;
  }
  update() {
    const config = this._config;
    this.clearCache();
    initOptions(config);
  }
  clearCache() {
    this._scopeCache.clear();
    this._resolverCache.clear();
  }
  datasetScopeKeys(datasetType) {
    return cachedKeys(datasetType, () => [
      [
        `datasets.${datasetType}`,
        ""
      ]
    ]);
  }
  datasetAnimationScopeKeys(datasetType, transition) {
    return cachedKeys(`${datasetType}.transition.${transition}`, () => [
      [
        `datasets.${datasetType}.transitions.${transition}`,
        `transitions.${transition}`
      ],
      [
        `datasets.${datasetType}`,
        ""
      ]
    ]);
  }
  datasetElementScopeKeys(datasetType, elementType) {
    return cachedKeys(`${datasetType}-${elementType}`, () => [
      [
        `datasets.${datasetType}.elements.${elementType}`,
        `datasets.${datasetType}`,
        `elements.${elementType}`,
        ""
      ]
    ]);
  }
  pluginScopeKeys(plugin) {
    const id = plugin.id;
    const type = this.type;
    return cachedKeys(`${type}-plugin-${id}`, () => [
      [
        `plugins.${id}`,
        ...plugin.additionalOptionScopes || []
      ]
    ]);
  }
  _cachedScopes(mainScope, resetCache) {
    const _scopeCache = this._scopeCache;
    let cache = _scopeCache.get(mainScope);
    if (!cache || resetCache) {
      cache = /* @__PURE__ */ new Map();
      _scopeCache.set(mainScope, cache);
    }
    return cache;
  }
  getOptionScopes(mainScope, keyLists, resetCache) {
    const { options, type } = this;
    const cache = this._cachedScopes(mainScope, resetCache);
    const cached = cache.get(keyLists);
    if (cached) {
      return cached;
    }
    const scopes = /* @__PURE__ */ new Set();
    keyLists.forEach((keys) => {
      if (mainScope) {
        scopes.add(mainScope);
        keys.forEach((key) => addIfFound(scopes, mainScope, key));
      }
      keys.forEach((key) => addIfFound(scopes, options, key));
      keys.forEach((key) => addIfFound(scopes, overrides[type] || {}, key));
      keys.forEach((key) => addIfFound(scopes, defaults, key));
      keys.forEach((key) => addIfFound(scopes, descriptors, key));
    });
    const array = Array.from(scopes);
    if (array.length === 0) {
      array.push(/* @__PURE__ */ Object.create(null));
    }
    if (keysCached.has(keyLists)) {
      cache.set(keyLists, array);
    }
    return array;
  }
  chartOptionScopes() {
    const { options, type } = this;
    return [
      options,
      overrides[type] || {},
      defaults.datasets[type] || {},
      {
        type
      },
      defaults,
      descriptors
    ];
  }
  resolveNamedOptions(scopes, names2, context, prefixes = [
    ""
  ]) {
    const result = {
      $shared: true
    };
    const { resolver, subPrefixes } = getResolver(this._resolverCache, scopes, prefixes);
    let options = resolver;
    if (needContext(resolver, names2)) {
      result.$shared = false;
      context = isFunction(context) ? context() : context;
      const subResolver = this.createResolver(scopes, context, subPrefixes);
      options = _attachContext(resolver, context, subResolver);
    }
    for (const prop of names2) {
      result[prop] = options[prop];
    }
    return result;
  }
  createResolver(scopes, context, prefixes = [
    ""
  ], descriptorDefaults) {
    const { resolver } = getResolver(this._resolverCache, scopes, prefixes);
    return isObject(context) ? _attachContext(resolver, context, void 0, descriptorDefaults) : resolver;
  }
};
function getResolver(resolverCache, scopes, prefixes) {
  let cache = resolverCache.get(scopes);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    resolverCache.set(scopes, cache);
  }
  const cacheKey = prefixes.join();
  let cached = cache.get(cacheKey);
  if (!cached) {
    const resolver = _createResolver(scopes, prefixes);
    cached = {
      resolver,
      subPrefixes: prefixes.filter((p) => !p.toLowerCase().includes("hover"))
    };
    cache.set(cacheKey, cached);
  }
  return cached;
}
var hasFunction = (value) => isObject(value) && Object.getOwnPropertyNames(value).some((key) => isFunction(value[key]));
function needContext(proxy, names2) {
  const { isScriptable, isIndexable } = _descriptors(proxy);
  for (const prop of names2) {
    const scriptable = isScriptable(prop);
    const indexable = isIndexable(prop);
    const value = (indexable || scriptable) && proxy[prop];
    if (scriptable && (isFunction(value) || hasFunction(value)) || indexable && isArray(value)) {
      return true;
    }
  }
  return false;
}
var version = "4.5.1";
var KNOWN_POSITIONS = [
  "top",
  "bottom",
  "left",
  "right",
  "chartArea"
];
function positionIsHorizontal(position, axis) {
  return position === "top" || position === "bottom" || KNOWN_POSITIONS.indexOf(position) === -1 && axis === "x";
}
function compare2Level(l1, l2) {
  return function(a, b) {
    return a[l1] === b[l1] ? a[l2] - b[l2] : a[l1] - b[l1];
  };
}
function onAnimationsComplete(context) {
  const chart = context.chart;
  const animationOptions = chart.options.animation;
  chart.notifyPlugins("afterRender");
  callback(animationOptions && animationOptions.onComplete, [
    context
  ], chart);
}
function onAnimationProgress(context) {
  const chart = context.chart;
  const animationOptions = chart.options.animation;
  callback(animationOptions && animationOptions.onProgress, [
    context
  ], chart);
}
function getCanvas(item) {
  if (_isDomSupported() && typeof item === "string") {
    item = document.getElementById(item);
  } else if (item && item.length) {
    item = item[0];
  }
  if (item && item.canvas) {
    item = item.canvas;
  }
  return item;
}
var instances = {};
var getChart = (key) => {
  const canvas = getCanvas(key);
  return Object.values(instances).filter((c) => c.canvas === canvas).pop();
};
function moveNumericKeys(obj, start, move) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    const intKey = +key;
    if (intKey >= start) {
      const value = obj[key];
      delete obj[key];
      if (move > 0 || intKey > start) {
        obj[intKey + move] = value;
      }
    }
  }
}
function determineLastEvent(e, lastEvent, inChartArea, isClick) {
  if (!inChartArea || e.type === "mouseout") {
    return null;
  }
  if (isClick) {
    return lastEvent;
  }
  return e;
}
var Chart = class {
  static defaults = defaults;
  static instances = instances;
  static overrides = overrides;
  static registry = registry;
  static version = version;
  static getChart = getChart;
  static register(...items) {
    registry.add(...items);
    invalidatePlugins();
  }
  static unregister(...items) {
    registry.remove(...items);
    invalidatePlugins();
  }
  constructor(item, userConfig) {
    const config = this.config = new Config(userConfig);
    const initialCanvas = getCanvas(item);
    const existingChart = getChart(initialCanvas);
    if (existingChart) {
      throw new Error("Canvas is already in use. Chart with ID '" + existingChart.id + "' must be destroyed before the canvas with ID '" + existingChart.canvas.id + "' can be reused.");
    }
    const options = config.createResolver(config.chartOptionScopes(), this.getContext());
    this.platform = new (config.platform || _detectPlatform(initialCanvas))();
    this.platform.updateConfig(config);
    const context = this.platform.acquireContext(initialCanvas, options.aspectRatio);
    const canvas = context && context.canvas;
    const height = canvas && canvas.height;
    const width = canvas && canvas.width;
    this.id = uid();
    this.ctx = context;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this._options = options;
    this._aspectRatio = this.aspectRatio;
    this._layers = [];
    this._metasets = [];
    this._stacks = void 0;
    this.boxes = [];
    this.currentDevicePixelRatio = void 0;
    this.chartArea = void 0;
    this._active = [];
    this._lastEvent = void 0;
    this._listeners = {};
    this._responsiveListeners = void 0;
    this._sortedMetasets = [];
    this.scales = {};
    this._plugins = new PluginService();
    this.$proxies = {};
    this._hiddenIndices = {};
    this.attached = false;
    this._animationsDisabled = void 0;
    this.$context = void 0;
    this._doResize = debounce((mode) => this.update(mode), options.resizeDelay || 0);
    this._dataChanges = [];
    instances[this.id] = this;
    if (!context || !canvas) {
      console.error("Failed to create chart: can't acquire context from the given item");
      return;
    }
    animator.listen(this, "complete", onAnimationsComplete);
    animator.listen(this, "progress", onAnimationProgress);
    this._initialize();
    if (this.attached) {
      this.update();
    }
  }
  get aspectRatio() {
    const { options: { aspectRatio, maintainAspectRatio }, width, height, _aspectRatio } = this;
    if (!isNullOrUndef(aspectRatio)) {
      return aspectRatio;
    }
    if (maintainAspectRatio && _aspectRatio) {
      return _aspectRatio;
    }
    return height ? width / height : null;
  }
  get data() {
    return this.config.data;
  }
  set data(data) {
    this.config.data = data;
  }
  get options() {
    return this._options;
  }
  set options(options) {
    this.config.options = options;
  }
  get registry() {
    return registry;
  }
  _initialize() {
    this.notifyPlugins("beforeInit");
    if (this.options.responsive) {
      this.resize();
    } else {
      retinaScale(this, this.options.devicePixelRatio);
    }
    this.bindEvents();
    this.notifyPlugins("afterInit");
    return this;
  }
  clear() {
    clearCanvas(this.canvas, this.ctx);
    return this;
  }
  stop() {
    animator.stop(this);
    return this;
  }
  resize(width, height) {
    if (!animator.running(this)) {
      this._resize(width, height);
    } else {
      this._resizeBeforeDraw = {
        width,
        height
      };
    }
  }
  _resize(width, height) {
    const options = this.options;
    const canvas = this.canvas;
    const aspectRatio = options.maintainAspectRatio && this.aspectRatio;
    const newSize = this.platform.getMaximumSize(canvas, width, height, aspectRatio);
    const newRatio = options.devicePixelRatio || this.platform.getDevicePixelRatio();
    const mode = this.width ? "resize" : "attach";
    this.width = newSize.width;
    this.height = newSize.height;
    this._aspectRatio = this.aspectRatio;
    if (!retinaScale(this, newRatio, true)) {
      return;
    }
    this.notifyPlugins("resize", {
      size: newSize
    });
    callback(options.onResize, [
      this,
      newSize
    ], this);
    if (this.attached) {
      if (this._doResize(mode)) {
        this.render();
      }
    }
  }
  ensureScalesHaveIDs() {
    const options = this.options;
    const scalesOptions = options.scales || {};
    each(scalesOptions, (axisOptions, axisID) => {
      axisOptions.id = axisID;
    });
  }
  buildOrUpdateScales() {
    const options = this.options;
    const scaleOpts = options.scales;
    const scales2 = this.scales;
    const updated = Object.keys(scales2).reduce((obj, id) => {
      obj[id] = false;
      return obj;
    }, {});
    let items = [];
    if (scaleOpts) {
      items = items.concat(Object.keys(scaleOpts).map((id) => {
        const scaleOptions = scaleOpts[id];
        const axis = determineAxis(id, scaleOptions);
        const isRadial = axis === "r";
        const isHorizontal = axis === "x";
        return {
          options: scaleOptions,
          dposition: isRadial ? "chartArea" : isHorizontal ? "bottom" : "left",
          dtype: isRadial ? "radialLinear" : isHorizontal ? "category" : "linear"
        };
      }));
    }
    each(items, (item) => {
      const scaleOptions = item.options;
      const id = scaleOptions.id;
      const axis = determineAxis(id, scaleOptions);
      const scaleType = valueOrDefault(scaleOptions.type, item.dtype);
      if (scaleOptions.position === void 0 || positionIsHorizontal(scaleOptions.position, axis) !== positionIsHorizontal(item.dposition)) {
        scaleOptions.position = item.dposition;
      }
      updated[id] = true;
      let scale = null;
      if (id in scales2 && scales2[id].type === scaleType) {
        scale = scales2[id];
      } else {
        const scaleClass = registry.getScale(scaleType);
        scale = new scaleClass({
          id,
          type: scaleType,
          ctx: this.ctx,
          chart: this
        });
        scales2[scale.id] = scale;
      }
      scale.init(scaleOptions, options);
    });
    each(updated, (hasUpdated, id) => {
      if (!hasUpdated) {
        delete scales2[id];
      }
    });
    each(scales2, (scale) => {
      layouts.configure(this, scale, scale.options);
      layouts.addBox(this, scale);
    });
  }
  _updateMetasets() {
    const metasets = this._metasets;
    const numData = this.data.datasets.length;
    const numMeta = metasets.length;
    metasets.sort((a, b) => a.index - b.index);
    if (numMeta > numData) {
      for (let i = numData; i < numMeta; ++i) {
        this._destroyDatasetMeta(i);
      }
      metasets.splice(numData, numMeta - numData);
    }
    this._sortedMetasets = metasets.slice(0).sort(compare2Level("order", "index"));
  }
  _removeUnreferencedMetasets() {
    const { _metasets: metasets, data: { datasets } } = this;
    if (metasets.length > datasets.length) {
      delete this._stacks;
    }
    metasets.forEach((meta, index2) => {
      if (datasets.filter((x) => x === meta._dataset).length === 0) {
        this._destroyDatasetMeta(index2);
      }
    });
  }
  buildOrUpdateControllers() {
    const newControllers = [];
    const datasets = this.data.datasets;
    let i, ilen;
    this._removeUnreferencedMetasets();
    for (i = 0, ilen = datasets.length; i < ilen; i++) {
      const dataset = datasets[i];
      let meta = this.getDatasetMeta(i);
      const type = dataset.type || this.config.type;
      if (meta.type && meta.type !== type) {
        this._destroyDatasetMeta(i);
        meta = this.getDatasetMeta(i);
      }
      meta.type = type;
      meta.indexAxis = dataset.indexAxis || getIndexAxis(type, this.options);
      meta.order = dataset.order || 0;
      meta.index = i;
      meta.label = "" + dataset.label;
      meta.visible = this.isDatasetVisible(i);
      if (meta.controller) {
        meta.controller.updateIndex(i);
        meta.controller.linkScales();
      } else {
        const ControllerClass = registry.getController(type);
        const { datasetElementType, dataElementType } = defaults.datasets[type];
        Object.assign(ControllerClass, {
          dataElementType: registry.getElement(dataElementType),
          datasetElementType: datasetElementType && registry.getElement(datasetElementType)
        });
        meta.controller = new ControllerClass(this, i);
        newControllers.push(meta.controller);
      }
    }
    this._updateMetasets();
    return newControllers;
  }
  _resetElements() {
    each(this.data.datasets, (dataset, datasetIndex) => {
      this.getDatasetMeta(datasetIndex).controller.reset();
    }, this);
  }
  reset() {
    this._resetElements();
    this.notifyPlugins("reset");
  }
  update(mode) {
    const config = this.config;
    config.update();
    const options = this._options = config.createResolver(config.chartOptionScopes(), this.getContext());
    const animsDisabled = this._animationsDisabled = !options.animation;
    this._updateScales();
    this._checkEventBindings();
    this._updateHiddenIndices();
    this._plugins.invalidate();
    if (this.notifyPlugins("beforeUpdate", {
      mode,
      cancelable: true
    }) === false) {
      return;
    }
    const newControllers = this.buildOrUpdateControllers();
    this.notifyPlugins("beforeElementsUpdate");
    let minPadding = 0;
    for (let i = 0, ilen = this.data.datasets.length; i < ilen; i++) {
      const { controller } = this.getDatasetMeta(i);
      const reset = !animsDisabled && newControllers.indexOf(controller) === -1;
      controller.buildOrUpdateElements(reset);
      minPadding = Math.max(+controller.getMaxOverflow(), minPadding);
    }
    minPadding = this._minPadding = options.layout.autoPadding ? minPadding : 0;
    this._updateLayout(minPadding);
    if (!animsDisabled) {
      each(newControllers, (controller) => {
        controller.reset();
      });
    }
    this._updateDatasets(mode);
    this.notifyPlugins("afterUpdate", {
      mode
    });
    this._layers.sort(compare2Level("z", "_idx"));
    const { _active, _lastEvent } = this;
    if (_lastEvent) {
      this._eventHandler(_lastEvent, true);
    } else if (_active.length) {
      this._updateHoverStyles(_active, _active, true);
    }
    this.render();
  }
  _updateScales() {
    each(this.scales, (scale) => {
      layouts.removeBox(this, scale);
    });
    this.ensureScalesHaveIDs();
    this.buildOrUpdateScales();
  }
  _checkEventBindings() {
    const options = this.options;
    const existingEvents = new Set(Object.keys(this._listeners));
    const newEvents = new Set(options.events);
    if (!setsEqual(existingEvents, newEvents) || !!this._responsiveListeners !== options.responsive) {
      this.unbindEvents();
      this.bindEvents();
    }
  }
  _updateHiddenIndices() {
    const { _hiddenIndices } = this;
    const changes = this._getUniformDataChanges() || [];
    for (const { method, start, count } of changes) {
      const move = method === "_removeElements" ? -count : count;
      moveNumericKeys(_hiddenIndices, start, move);
    }
  }
  _getUniformDataChanges() {
    const _dataChanges = this._dataChanges;
    if (!_dataChanges || !_dataChanges.length) {
      return;
    }
    this._dataChanges = [];
    const datasetCount = this.data.datasets.length;
    const makeSet = (idx) => new Set(_dataChanges.filter((c) => c[0] === idx).map((c, i) => i + "," + c.splice(1).join(",")));
    const changeSet = makeSet(0);
    for (let i = 1; i < datasetCount; i++) {
      if (!setsEqual(changeSet, makeSet(i))) {
        return;
      }
    }
    return Array.from(changeSet).map((c) => c.split(",")).map((a) => ({
      method: a[1],
      start: +a[2],
      count: +a[3]
    }));
  }
  _updateLayout(minPadding) {
    if (this.notifyPlugins("beforeLayout", {
      cancelable: true
    }) === false) {
      return;
    }
    layouts.update(this, this.width, this.height, minPadding);
    const area = this.chartArea;
    const noArea = area.width <= 0 || area.height <= 0;
    this._layers = [];
    each(this.boxes, (box) => {
      if (noArea && box.position === "chartArea") {
        return;
      }
      if (box.configure) {
        box.configure();
      }
      this._layers.push(...box._layers());
    }, this);
    this._layers.forEach((item, index2) => {
      item._idx = index2;
    });
    this.notifyPlugins("afterLayout");
  }
  _updateDatasets(mode) {
    if (this.notifyPlugins("beforeDatasetsUpdate", {
      mode,
      cancelable: true
    }) === false) {
      return;
    }
    for (let i = 0, ilen = this.data.datasets.length; i < ilen; ++i) {
      this.getDatasetMeta(i).controller.configure();
    }
    for (let i = 0, ilen = this.data.datasets.length; i < ilen; ++i) {
      this._updateDataset(i, isFunction(mode) ? mode({
        datasetIndex: i
      }) : mode);
    }
    this.notifyPlugins("afterDatasetsUpdate", {
      mode
    });
  }
  _updateDataset(index2, mode) {
    const meta = this.getDatasetMeta(index2);
    const args = {
      meta,
      index: index2,
      mode,
      cancelable: true
    };
    if (this.notifyPlugins("beforeDatasetUpdate", args) === false) {
      return;
    }
    meta.controller._update(mode);
    args.cancelable = false;
    this.notifyPlugins("afterDatasetUpdate", args);
  }
  render() {
    if (this.notifyPlugins("beforeRender", {
      cancelable: true
    }) === false) {
      return;
    }
    if (animator.has(this)) {
      if (this.attached && !animator.running(this)) {
        animator.start(this);
      }
    } else {
      this.draw();
      onAnimationsComplete({
        chart: this
      });
    }
  }
  draw() {
    let i;
    if (this._resizeBeforeDraw) {
      const { width, height } = this._resizeBeforeDraw;
      this._resizeBeforeDraw = null;
      this._resize(width, height);
    }
    this.clear();
    if (this.width <= 0 || this.height <= 0) {
      return;
    }
    if (this.notifyPlugins("beforeDraw", {
      cancelable: true
    }) === false) {
      return;
    }
    const layers = this._layers;
    for (i = 0; i < layers.length && layers[i].z <= 0; ++i) {
      layers[i].draw(this.chartArea);
    }
    this._drawDatasets();
    for (; i < layers.length; ++i) {
      layers[i].draw(this.chartArea);
    }
    this.notifyPlugins("afterDraw");
  }
  _getSortedDatasetMetas(filterVisible) {
    const metasets = this._sortedMetasets;
    const result = [];
    let i, ilen;
    for (i = 0, ilen = metasets.length; i < ilen; ++i) {
      const meta = metasets[i];
      if (!filterVisible || meta.visible) {
        result.push(meta);
      }
    }
    return result;
  }
  getSortedVisibleDatasetMetas() {
    return this._getSortedDatasetMetas(true);
  }
  _drawDatasets() {
    if (this.notifyPlugins("beforeDatasetsDraw", {
      cancelable: true
    }) === false) {
      return;
    }
    const metasets = this.getSortedVisibleDatasetMetas();
    for (let i = metasets.length - 1; i >= 0; --i) {
      this._drawDataset(metasets[i]);
    }
    this.notifyPlugins("afterDatasetsDraw");
  }
  _drawDataset(meta) {
    const ctx = this.ctx;
    const args = {
      meta,
      index: meta.index,
      cancelable: true
    };
    const clip = getDatasetClipArea(this, meta);
    if (this.notifyPlugins("beforeDatasetDraw", args) === false) {
      return;
    }
    if (clip) {
      clipArea(ctx, clip);
    }
    meta.controller.draw();
    if (clip) {
      unclipArea(ctx);
    }
    args.cancelable = false;
    this.notifyPlugins("afterDatasetDraw", args);
  }
  isPointInArea(point) {
    return _isPointInArea(point, this.chartArea, this._minPadding);
  }
  getElementsAtEventForMode(e, mode, options, useFinalPosition) {
    const method = Interaction.modes[mode];
    if (typeof method === "function") {
      return method(this, e, options, useFinalPosition);
    }
    return [];
  }
  getDatasetMeta(datasetIndex) {
    const dataset = this.data.datasets[datasetIndex];
    const metasets = this._metasets;
    let meta = metasets.filter((x) => x && x._dataset === dataset).pop();
    if (!meta) {
      meta = {
        type: null,
        data: [],
        dataset: null,
        controller: null,
        hidden: null,
        xAxisID: null,
        yAxisID: null,
        order: dataset && dataset.order || 0,
        index: datasetIndex,
        _dataset: dataset,
        _parsed: [],
        _sorted: false
      };
      metasets.push(meta);
    }
    return meta;
  }
  getContext() {
    return this.$context || (this.$context = createContext(null, {
      chart: this,
      type: "chart"
    }));
  }
  getVisibleDatasetCount() {
    return this.getSortedVisibleDatasetMetas().length;
  }
  isDatasetVisible(datasetIndex) {
    const dataset = this.data.datasets[datasetIndex];
    if (!dataset) {
      return false;
    }
    const meta = this.getDatasetMeta(datasetIndex);
    return typeof meta.hidden === "boolean" ? !meta.hidden : !dataset.hidden;
  }
  setDatasetVisibility(datasetIndex, visible) {
    const meta = this.getDatasetMeta(datasetIndex);
    meta.hidden = !visible;
  }
  toggleDataVisibility(index2) {
    this._hiddenIndices[index2] = !this._hiddenIndices[index2];
  }
  getDataVisibility(index2) {
    return !this._hiddenIndices[index2];
  }
  _updateVisibility(datasetIndex, dataIndex, visible) {
    const mode = visible ? "show" : "hide";
    const meta = this.getDatasetMeta(datasetIndex);
    const anims = meta.controller._resolveAnimations(void 0, mode);
    if (defined(dataIndex)) {
      meta.data[dataIndex].hidden = !visible;
      this.update();
    } else {
      this.setDatasetVisibility(datasetIndex, visible);
      anims.update(meta, {
        visible
      });
      this.update((ctx) => ctx.datasetIndex === datasetIndex ? mode : void 0);
    }
  }
  hide(datasetIndex, dataIndex) {
    this._updateVisibility(datasetIndex, dataIndex, false);
  }
  show(datasetIndex, dataIndex) {
    this._updateVisibility(datasetIndex, dataIndex, true);
  }
  _destroyDatasetMeta(datasetIndex) {
    const meta = this._metasets[datasetIndex];
    if (meta && meta.controller) {
      meta.controller._destroy();
    }
    delete this._metasets[datasetIndex];
  }
  _stop() {
    let i, ilen;
    this.stop();
    animator.remove(this);
    for (i = 0, ilen = this.data.datasets.length; i < ilen; ++i) {
      this._destroyDatasetMeta(i);
    }
  }
  destroy() {
    this.notifyPlugins("beforeDestroy");
    const { canvas, ctx } = this;
    this._stop();
    this.config.clearCache();
    if (canvas) {
      this.unbindEvents();
      clearCanvas(canvas, ctx);
      this.platform.releaseContext(ctx);
      this.canvas = null;
      this.ctx = null;
    }
    delete instances[this.id];
    this.notifyPlugins("afterDestroy");
  }
  toBase64Image(...args) {
    return this.canvas.toDataURL(...args);
  }
  bindEvents() {
    this.bindUserEvents();
    if (this.options.responsive) {
      this.bindResponsiveEvents();
    } else {
      this.attached = true;
    }
  }
  bindUserEvents() {
    const listeners = this._listeners;
    const platform = this.platform;
    const _add = (type, listener2) => {
      platform.addEventListener(this, type, listener2);
      listeners[type] = listener2;
    };
    const listener = (e, x, y) => {
      e.offsetX = x;
      e.offsetY = y;
      this._eventHandler(e);
    };
    each(this.options.events, (type) => _add(type, listener));
  }
  bindResponsiveEvents() {
    if (!this._responsiveListeners) {
      this._responsiveListeners = {};
    }
    const listeners = this._responsiveListeners;
    const platform = this.platform;
    const _add = (type, listener2) => {
      platform.addEventListener(this, type, listener2);
      listeners[type] = listener2;
    };
    const _remove = (type, listener2) => {
      if (listeners[type]) {
        platform.removeEventListener(this, type, listener2);
        delete listeners[type];
      }
    };
    const listener = (width, height) => {
      if (this.canvas) {
        this.resize(width, height);
      }
    };
    let detached;
    const attached = () => {
      _remove("attach", attached);
      this.attached = true;
      this.resize();
      _add("resize", listener);
      _add("detach", detached);
    };
    detached = () => {
      this.attached = false;
      _remove("resize", listener);
      this._stop();
      this._resize(0, 0);
      _add("attach", attached);
    };
    if (platform.isAttached(this.canvas)) {
      attached();
    } else {
      detached();
    }
  }
  unbindEvents() {
    each(this._listeners, (listener, type) => {
      this.platform.removeEventListener(this, type, listener);
    });
    this._listeners = {};
    each(this._responsiveListeners, (listener, type) => {
      this.platform.removeEventListener(this, type, listener);
    });
    this._responsiveListeners = void 0;
  }
  updateHoverStyle(items, mode, enabled) {
    const prefix = enabled ? "set" : "remove";
    let meta, item, i, ilen;
    if (mode === "dataset") {
      meta = this.getDatasetMeta(items[0].datasetIndex);
      meta.controller["_" + prefix + "DatasetHoverStyle"]();
    }
    for (i = 0, ilen = items.length; i < ilen; ++i) {
      item = items[i];
      const controller = item && this.getDatasetMeta(item.datasetIndex).controller;
      if (controller) {
        controller[prefix + "HoverStyle"](item.element, item.datasetIndex, item.index);
      }
    }
  }
  getActiveElements() {
    return this._active || [];
  }
  setActiveElements(activeElements) {
    const lastActive = this._active || [];
    const active = activeElements.map(({ datasetIndex, index: index2 }) => {
      const meta = this.getDatasetMeta(datasetIndex);
      if (!meta) {
        throw new Error("No dataset found at index " + datasetIndex);
      }
      return {
        datasetIndex,
        element: meta.data[index2],
        index: index2
      };
    });
    const changed = !_elementsEqual(active, lastActive);
    if (changed) {
      this._active = active;
      this._lastEvent = null;
      this._updateHoverStyles(active, lastActive);
    }
  }
  notifyPlugins(hook, args, filter) {
    return this._plugins.notify(this, hook, args, filter);
  }
  isPluginEnabled(pluginId) {
    return this._plugins._cache.filter((p) => p.plugin.id === pluginId).length === 1;
  }
  _updateHoverStyles(active, lastActive, replay) {
    const hoverOptions = this.options.hover;
    const diff = (a, b) => a.filter((x) => !b.some((y) => x.datasetIndex === y.datasetIndex && x.index === y.index));
    const deactivated = diff(lastActive, active);
    const activated = replay ? active : diff(active, lastActive);
    if (deactivated.length) {
      this.updateHoverStyle(deactivated, hoverOptions.mode, false);
    }
    if (activated.length && hoverOptions.mode) {
      this.updateHoverStyle(activated, hoverOptions.mode, true);
    }
  }
  _eventHandler(e, replay) {
    const args = {
      event: e,
      replay,
      cancelable: true,
      inChartArea: this.isPointInArea(e)
    };
    const eventFilter = (plugin) => (plugin.options.events || this.options.events).includes(e.native.type);
    if (this.notifyPlugins("beforeEvent", args, eventFilter) === false) {
      return;
    }
    const changed = this._handleEvent(e, replay, args.inChartArea);
    args.cancelable = false;
    this.notifyPlugins("afterEvent", args, eventFilter);
    if (changed || args.changed) {
      this.render();
    }
    return this;
  }
  _handleEvent(e, replay, inChartArea) {
    const { _active: lastActive = [], options } = this;
    const useFinalPosition = replay;
    const active = this._getActiveElements(e, lastActive, inChartArea, useFinalPosition);
    const isClick = _isClickEvent(e);
    const lastEvent = determineLastEvent(e, this._lastEvent, inChartArea, isClick);
    if (inChartArea) {
      this._lastEvent = null;
      callback(options.onHover, [
        e,
        active,
        this
      ], this);
      if (isClick) {
        callback(options.onClick, [
          e,
          active,
          this
        ], this);
      }
    }
    const changed = !_elementsEqual(active, lastActive);
    if (changed || replay) {
      this._active = active;
      this._updateHoverStyles(active, lastActive, replay);
    }
    this._lastEvent = lastEvent;
    return changed;
  }
  _getActiveElements(e, lastActive, inChartArea, useFinalPosition) {
    if (e.type === "mouseout") {
      return [];
    }
    if (!inChartArea) {
      return lastActive;
    }
    const hoverOptions = this.options.hover;
    return this.getElementsAtEventForMode(e, hoverOptions.mode, hoverOptions, useFinalPosition);
  }
};
function invalidatePlugins() {
  return each(Chart.instances, (chart) => chart._plugins.invalidate());
}
function clipSelf(ctx, element, endAngle) {
  const { startAngle, x, y, outerRadius, innerRadius, options } = element;
  const { borderWidth, borderJoinStyle } = options;
  const outerAngleClip = Math.min(borderWidth / outerRadius, _normalizeAngle(startAngle - endAngle));
  ctx.beginPath();
  ctx.arc(x, y, outerRadius - borderWidth / 2, startAngle + outerAngleClip / 2, endAngle - outerAngleClip / 2);
  if (innerRadius > 0) {
    const innerAngleClip = Math.min(borderWidth / innerRadius, _normalizeAngle(startAngle - endAngle));
    ctx.arc(x, y, innerRadius + borderWidth / 2, endAngle - innerAngleClip / 2, startAngle + innerAngleClip / 2, true);
  } else {
    const clipWidth = Math.min(borderWidth / 2, outerRadius * _normalizeAngle(startAngle - endAngle));
    if (borderJoinStyle === "round") {
      ctx.arc(x, y, clipWidth, endAngle - PI / 2, startAngle + PI / 2, true);
    } else if (borderJoinStyle === "bevel") {
      const r = 2 * clipWidth * clipWidth;
      const endX = -r * Math.cos(endAngle + PI / 2) + x;
      const endY = -r * Math.sin(endAngle + PI / 2) + y;
      const startX = r * Math.cos(startAngle + PI / 2) + x;
      const startY = r * Math.sin(startAngle + PI / 2) + y;
      ctx.lineTo(endX, endY);
      ctx.lineTo(startX, startY);
    }
  }
  ctx.closePath();
  ctx.moveTo(0, 0);
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.clip("evenodd");
}
function clipArc(ctx, element, endAngle) {
  const { startAngle, pixelMargin, x, y, outerRadius, innerRadius } = element;
  let angleMargin = pixelMargin / outerRadius;
  ctx.beginPath();
  ctx.arc(x, y, outerRadius, startAngle - angleMargin, endAngle + angleMargin);
  if (innerRadius > pixelMargin) {
    angleMargin = pixelMargin / innerRadius;
    ctx.arc(x, y, innerRadius, endAngle + angleMargin, startAngle - angleMargin, true);
  } else {
    ctx.arc(x, y, pixelMargin, endAngle + HALF_PI, startAngle - HALF_PI);
  }
  ctx.closePath();
  ctx.clip();
}
function toRadiusCorners(value) {
  return _readValueToProps(value, [
    "outerStart",
    "outerEnd",
    "innerStart",
    "innerEnd"
  ]);
}
function parseBorderRadius$1(arc, innerRadius, outerRadius, angleDelta) {
  const o = toRadiusCorners(arc.options.borderRadius);
  const halfThickness = (outerRadius - innerRadius) / 2;
  const innerLimit = Math.min(halfThickness, angleDelta * innerRadius / 2);
  const computeOuterLimit = (val) => {
    const outerArcLimit = (outerRadius - Math.min(halfThickness, val)) * angleDelta / 2;
    return _limitValue(val, 0, Math.min(halfThickness, outerArcLimit));
  };
  return {
    outerStart: computeOuterLimit(o.outerStart),
    outerEnd: computeOuterLimit(o.outerEnd),
    innerStart: _limitValue(o.innerStart, 0, innerLimit),
    innerEnd: _limitValue(o.innerEnd, 0, innerLimit)
  };
}
function rThetaToXY(r, theta, x, y) {
  return {
    x: x + r * Math.cos(theta),
    y: y + r * Math.sin(theta)
  };
}
function pathArc(ctx, element, offset, spacing, end, circular) {
  const { x, y, startAngle: start, pixelMargin, innerRadius: innerR } = element;
  const outerRadius = Math.max(element.outerRadius + spacing + offset - pixelMargin, 0);
  const innerRadius = innerR > 0 ? innerR + spacing + offset + pixelMargin : 0;
  let spacingOffset = 0;
  const alpha2 = end - start;
  if (spacing) {
    const noSpacingInnerRadius = innerR > 0 ? innerR - spacing : 0;
    const noSpacingOuterRadius = outerRadius > 0 ? outerRadius - spacing : 0;
    const avNogSpacingRadius = (noSpacingInnerRadius + noSpacingOuterRadius) / 2;
    const adjustedAngle = avNogSpacingRadius !== 0 ? alpha2 * avNogSpacingRadius / (avNogSpacingRadius + spacing) : alpha2;
    spacingOffset = (alpha2 - adjustedAngle) / 2;
  }
  const beta = Math.max(1e-3, alpha2 * outerRadius - offset / PI) / outerRadius;
  const angleOffset = (alpha2 - beta) / 2;
  const startAngle = start + angleOffset + spacingOffset;
  const endAngle = end - angleOffset - spacingOffset;
  const { outerStart, outerEnd, innerStart, innerEnd } = parseBorderRadius$1(element, innerRadius, outerRadius, endAngle - startAngle);
  const outerStartAdjustedRadius = outerRadius - outerStart;
  const outerEndAdjustedRadius = outerRadius - outerEnd;
  const outerStartAdjustedAngle = startAngle + outerStart / outerStartAdjustedRadius;
  const outerEndAdjustedAngle = endAngle - outerEnd / outerEndAdjustedRadius;
  const innerStartAdjustedRadius = innerRadius + innerStart;
  const innerEndAdjustedRadius = innerRadius + innerEnd;
  const innerStartAdjustedAngle = startAngle + innerStart / innerStartAdjustedRadius;
  const innerEndAdjustedAngle = endAngle - innerEnd / innerEndAdjustedRadius;
  ctx.beginPath();
  if (circular) {
    const outerMidAdjustedAngle = (outerStartAdjustedAngle + outerEndAdjustedAngle) / 2;
    ctx.arc(x, y, outerRadius, outerStartAdjustedAngle, outerMidAdjustedAngle);
    ctx.arc(x, y, outerRadius, outerMidAdjustedAngle, outerEndAdjustedAngle);
    if (outerEnd > 0) {
      const pCenter = rThetaToXY(outerEndAdjustedRadius, outerEndAdjustedAngle, x, y);
      ctx.arc(pCenter.x, pCenter.y, outerEnd, outerEndAdjustedAngle, endAngle + HALF_PI);
    }
    const p4 = rThetaToXY(innerEndAdjustedRadius, endAngle, x, y);
    ctx.lineTo(p4.x, p4.y);
    if (innerEnd > 0) {
      const pCenter = rThetaToXY(innerEndAdjustedRadius, innerEndAdjustedAngle, x, y);
      ctx.arc(pCenter.x, pCenter.y, innerEnd, endAngle + HALF_PI, innerEndAdjustedAngle + Math.PI);
    }
    const innerMidAdjustedAngle = (endAngle - innerEnd / innerRadius + (startAngle + innerStart / innerRadius)) / 2;
    ctx.arc(x, y, innerRadius, endAngle - innerEnd / innerRadius, innerMidAdjustedAngle, true);
    ctx.arc(x, y, innerRadius, innerMidAdjustedAngle, startAngle + innerStart / innerRadius, true);
    if (innerStart > 0) {
      const pCenter = rThetaToXY(innerStartAdjustedRadius, innerStartAdjustedAngle, x, y);
      ctx.arc(pCenter.x, pCenter.y, innerStart, innerStartAdjustedAngle + Math.PI, startAngle - HALF_PI);
    }
    const p8 = rThetaToXY(outerStartAdjustedRadius, startAngle, x, y);
    ctx.lineTo(p8.x, p8.y);
    if (outerStart > 0) {
      const pCenter = rThetaToXY(outerStartAdjustedRadius, outerStartAdjustedAngle, x, y);
      ctx.arc(pCenter.x, pCenter.y, outerStart, startAngle - HALF_PI, outerStartAdjustedAngle);
    }
  } else {
    ctx.moveTo(x, y);
    const outerStartX = Math.cos(outerStartAdjustedAngle) * outerRadius + x;
    const outerStartY = Math.sin(outerStartAdjustedAngle) * outerRadius + y;
    ctx.lineTo(outerStartX, outerStartY);
    const outerEndX = Math.cos(outerEndAdjustedAngle) * outerRadius + x;
    const outerEndY = Math.sin(outerEndAdjustedAngle) * outerRadius + y;
    ctx.lineTo(outerEndX, outerEndY);
  }
  ctx.closePath();
}
function drawArc(ctx, element, offset, spacing, circular) {
  const { fullCircles, startAngle, circumference } = element;
  let endAngle = element.endAngle;
  if (fullCircles) {
    pathArc(ctx, element, offset, spacing, endAngle, circular);
    for (let i = 0; i < fullCircles; ++i) {
      ctx.fill();
    }
    if (!isNaN(circumference)) {
      endAngle = startAngle + (circumference % TAU || TAU);
    }
  }
  pathArc(ctx, element, offset, spacing, endAngle, circular);
  ctx.fill();
  return endAngle;
}
function drawBorder(ctx, element, offset, spacing, circular) {
  const { fullCircles, startAngle, circumference, options } = element;
  const { borderWidth, borderJoinStyle, borderDash, borderDashOffset, borderRadius } = options;
  const inner = options.borderAlign === "inner";
  if (!borderWidth) {
    return;
  }
  ctx.setLineDash(borderDash || []);
  ctx.lineDashOffset = borderDashOffset;
  if (inner) {
    ctx.lineWidth = borderWidth * 2;
    ctx.lineJoin = borderJoinStyle || "round";
  } else {
    ctx.lineWidth = borderWidth;
    ctx.lineJoin = borderJoinStyle || "bevel";
  }
  let endAngle = element.endAngle;
  if (fullCircles) {
    pathArc(ctx, element, offset, spacing, endAngle, circular);
    for (let i = 0; i < fullCircles; ++i) {
      ctx.stroke();
    }
    if (!isNaN(circumference)) {
      endAngle = startAngle + (circumference % TAU || TAU);
    }
  }
  if (inner) {
    clipArc(ctx, element, endAngle);
  }
  if (options.selfJoin && endAngle - startAngle >= PI && borderRadius === 0 && borderJoinStyle !== "miter") {
    clipSelf(ctx, element, endAngle);
  }
  if (!fullCircles) {
    pathArc(ctx, element, offset, spacing, endAngle, circular);
    ctx.stroke();
  }
}
var ArcElement = class extends Element {
  static id = "arc";
  static defaults = {
    borderAlign: "center",
    borderColor: "#fff",
    borderDash: [],
    borderDashOffset: 0,
    borderJoinStyle: void 0,
    borderRadius: 0,
    borderWidth: 2,
    offset: 0,
    spacing: 0,
    angle: void 0,
    circular: true,
    selfJoin: false
  };
  static defaultRoutes = {
    backgroundColor: "backgroundColor"
  };
  static descriptors = {
    _scriptable: true,
    _indexable: (name) => name !== "borderDash"
  };
  circumference;
  endAngle;
  fullCircles;
  innerRadius;
  outerRadius;
  pixelMargin;
  startAngle;
  constructor(cfg) {
    super();
    this.options = void 0;
    this.circumference = void 0;
    this.startAngle = void 0;
    this.endAngle = void 0;
    this.innerRadius = void 0;
    this.outerRadius = void 0;
    this.pixelMargin = 0;
    this.fullCircles = 0;
    if (cfg) {
      Object.assign(this, cfg);
    }
  }
  inRange(chartX, chartY, useFinalPosition) {
    const point = this.getProps([
      "x",
      "y"
    ], useFinalPosition);
    const { angle, distance } = getAngleFromPoint(point, {
      x: chartX,
      y: chartY
    });
    const { startAngle, endAngle, innerRadius, outerRadius, circumference } = this.getProps([
      "startAngle",
      "endAngle",
      "innerRadius",
      "outerRadius",
      "circumference"
    ], useFinalPosition);
    const rAdjust = (this.options.spacing + this.options.borderWidth) / 2;
    const _circumference = valueOrDefault(circumference, endAngle - startAngle);
    const nonZeroBetween = _angleBetween(angle, startAngle, endAngle) && startAngle !== endAngle;
    const betweenAngles = _circumference >= TAU || nonZeroBetween;
    const withinRadius = _isBetween(distance, innerRadius + rAdjust, outerRadius + rAdjust);
    return betweenAngles && withinRadius;
  }
  getCenterPoint(useFinalPosition) {
    const { x, y, startAngle, endAngle, innerRadius, outerRadius } = this.getProps([
      "x",
      "y",
      "startAngle",
      "endAngle",
      "innerRadius",
      "outerRadius"
    ], useFinalPosition);
    const { offset, spacing } = this.options;
    const halfAngle = (startAngle + endAngle) / 2;
    const halfRadius = (innerRadius + outerRadius + spacing + offset) / 2;
    return {
      x: x + Math.cos(halfAngle) * halfRadius,
      y: y + Math.sin(halfAngle) * halfRadius
    };
  }
  tooltipPosition(useFinalPosition) {
    return this.getCenterPoint(useFinalPosition);
  }
  draw(ctx) {
    const { options, circumference } = this;
    const offset = (options.offset || 0) / 4;
    const spacing = (options.spacing || 0) / 2;
    const circular = options.circular;
    this.pixelMargin = options.borderAlign === "inner" ? 0.33 : 0;
    this.fullCircles = circumference > TAU ? Math.floor(circumference / TAU) : 0;
    if (circumference === 0 || this.innerRadius < 0 || this.outerRadius < 0) {
      return;
    }
    ctx.save();
    const halfAngle = (this.startAngle + this.endAngle) / 2;
    ctx.translate(Math.cos(halfAngle) * offset, Math.sin(halfAngle) * offset);
    const fix = 1 - Math.sin(Math.min(PI, circumference || 0));
    const radiusOffset = offset * fix;
    ctx.fillStyle = options.backgroundColor;
    ctx.strokeStyle = options.borderColor;
    drawArc(ctx, this, radiusOffset, spacing, circular);
    drawBorder(ctx, this, radiusOffset, spacing, circular);
    ctx.restore();
  }
};
function setStyle(ctx, options, style = options) {
  ctx.lineCap = valueOrDefault(style.borderCapStyle, options.borderCapStyle);
  ctx.setLineDash(valueOrDefault(style.borderDash, options.borderDash));
  ctx.lineDashOffset = valueOrDefault(style.borderDashOffset, options.borderDashOffset);
  ctx.lineJoin = valueOrDefault(style.borderJoinStyle, options.borderJoinStyle);
  ctx.lineWidth = valueOrDefault(style.borderWidth, options.borderWidth);
  ctx.strokeStyle = valueOrDefault(style.borderColor, options.borderColor);
}
function lineTo(ctx, previous, target) {
  ctx.lineTo(target.x, target.y);
}
function getLineMethod(options) {
  if (options.stepped) {
    return _steppedLineTo;
  }
  if (options.tension || options.cubicInterpolationMode === "monotone") {
    return _bezierCurveTo;
  }
  return lineTo;
}
function pathVars(points, segment, params = {}) {
  const count = points.length;
  const { start: paramsStart = 0, end: paramsEnd = count - 1 } = params;
  const { start: segmentStart, end: segmentEnd } = segment;
  const start = Math.max(paramsStart, segmentStart);
  const end = Math.min(paramsEnd, segmentEnd);
  const outside = paramsStart < segmentStart && paramsEnd < segmentStart || paramsStart > segmentEnd && paramsEnd > segmentEnd;
  return {
    count,
    start,
    loop: segment.loop,
    ilen: end < start && !outside ? count + end - start : end - start
  };
}
function pathSegment(ctx, line, segment, params) {
  const { points, options } = line;
  const { count, start, loop, ilen } = pathVars(points, segment, params);
  const lineMethod = getLineMethod(options);
  let { move = true, reverse } = params || {};
  let i, point, prev;
  for (i = 0; i <= ilen; ++i) {
    point = points[(start + (reverse ? ilen - i : i)) % count];
    if (point.skip) {
      continue;
    } else if (move) {
      ctx.moveTo(point.x, point.y);
      move = false;
    } else {
      lineMethod(ctx, prev, point, reverse, options.stepped);
    }
    prev = point;
  }
  if (loop) {
    point = points[(start + (reverse ? ilen : 0)) % count];
    lineMethod(ctx, prev, point, reverse, options.stepped);
  }
  return !!loop;
}
function fastPathSegment(ctx, line, segment, params) {
  const points = line.points;
  const { count, start, ilen } = pathVars(points, segment, params);
  const { move = true, reverse } = params || {};
  let avgX = 0;
  let countX = 0;
  let i, point, prevX, minY, maxY, lastY;
  const pointIndex = (index2) => (start + (reverse ? ilen - index2 : index2)) % count;
  const drawX = () => {
    if (minY !== maxY) {
      ctx.lineTo(avgX, maxY);
      ctx.lineTo(avgX, minY);
      ctx.lineTo(avgX, lastY);
    }
  };
  if (move) {
    point = points[pointIndex(0)];
    ctx.moveTo(point.x, point.y);
  }
  for (i = 0; i <= ilen; ++i) {
    point = points[pointIndex(i)];
    if (point.skip) {
      continue;
    }
    const x = point.x;
    const y = point.y;
    const truncX = x | 0;
    if (truncX === prevX) {
      if (y < minY) {
        minY = y;
      } else if (y > maxY) {
        maxY = y;
      }
      avgX = (countX * avgX + x) / ++countX;
    } else {
      drawX();
      ctx.lineTo(x, y);
      prevX = truncX;
      countX = 0;
      minY = maxY = y;
    }
    lastY = y;
  }
  drawX();
}
function _getSegmentMethod(line) {
  const opts = line.options;
  const borderDash = opts.borderDash && opts.borderDash.length;
  const useFastPath = !line._decimated && !line._loop && !opts.tension && opts.cubicInterpolationMode !== "monotone" && !opts.stepped && !borderDash;
  return useFastPath ? fastPathSegment : pathSegment;
}
function _getInterpolationMethod(options) {
  if (options.stepped) {
    return _steppedInterpolation;
  }
  if (options.tension || options.cubicInterpolationMode === "monotone") {
    return _bezierInterpolation;
  }
  return _pointInLine;
}
function strokePathWithCache(ctx, line, start, count) {
  let path = line._path;
  if (!path) {
    path = line._path = new Path2D();
    if (line.path(path, start, count)) {
      path.closePath();
    }
  }
  setStyle(ctx, line.options);
  ctx.stroke(path);
}
function strokePathDirect(ctx, line, start, count) {
  const { segments, options } = line;
  const segmentMethod = _getSegmentMethod(line);
  for (const segment of segments) {
    setStyle(ctx, options, segment.style);
    ctx.beginPath();
    if (segmentMethod(ctx, line, segment, {
      start,
      end: start + count - 1
    })) {
      ctx.closePath();
    }
    ctx.stroke();
  }
}
var usePath2D = typeof Path2D === "function";
function draw(ctx, line, start, count) {
  if (usePath2D && !line.options.segment) {
    strokePathWithCache(ctx, line, start, count);
  } else {
    strokePathDirect(ctx, line, start, count);
  }
}
var LineElement = class extends Element {
  static id = "line";
  static defaults = {
    borderCapStyle: "butt",
    borderDash: [],
    borderDashOffset: 0,
    borderJoinStyle: "miter",
    borderWidth: 3,
    capBezierPoints: true,
    cubicInterpolationMode: "default",
    fill: false,
    spanGaps: false,
    stepped: false,
    tension: 0
  };
  static defaultRoutes = {
    backgroundColor: "backgroundColor",
    borderColor: "borderColor"
  };
  static descriptors = {
    _scriptable: true,
    _indexable: (name) => name !== "borderDash" && name !== "fill"
  };
  constructor(cfg) {
    super();
    this.animated = true;
    this.options = void 0;
    this._chart = void 0;
    this._loop = void 0;
    this._fullLoop = void 0;
    this._path = void 0;
    this._points = void 0;
    this._segments = void 0;
    this._decimated = false;
    this._pointsUpdated = false;
    this._datasetIndex = void 0;
    if (cfg) {
      Object.assign(this, cfg);
    }
  }
  updateControlPoints(chartArea, indexAxis) {
    const options = this.options;
    if ((options.tension || options.cubicInterpolationMode === "monotone") && !options.stepped && !this._pointsUpdated) {
      const loop = options.spanGaps ? this._loop : this._fullLoop;
      _updateBezierControlPoints(this._points, options, chartArea, loop, indexAxis);
      this._pointsUpdated = true;
    }
  }
  set points(points) {
    this._points = points;
    delete this._segments;
    delete this._path;
    this._pointsUpdated = false;
  }
  get points() {
    return this._points;
  }
  get segments() {
    return this._segments || (this._segments = _computeSegments(this, this.options.segment));
  }
  first() {
    const segments = this.segments;
    const points = this.points;
    return segments.length && points[segments[0].start];
  }
  last() {
    const segments = this.segments;
    const points = this.points;
    const count = segments.length;
    return count && points[segments[count - 1].end];
  }
  interpolate(point, property) {
    const options = this.options;
    const value = point[property];
    const points = this.points;
    const segments = _boundSegments(this, {
      property,
      start: value,
      end: value
    });
    if (!segments.length) {
      return;
    }
    const result = [];
    const _interpolate = _getInterpolationMethod(options);
    let i, ilen;
    for (i = 0, ilen = segments.length; i < ilen; ++i) {
      const { start, end } = segments[i];
      const p1 = points[start];
      const p2 = points[end];
      if (p1 === p2) {
        result.push(p1);
        continue;
      }
      const t = Math.abs((value - p1[property]) / (p2[property] - p1[property]));
      const interpolated = _interpolate(p1, p2, t, options.stepped);
      interpolated[property] = point[property];
      result.push(interpolated);
    }
    return result.length === 1 ? result[0] : result;
  }
  pathSegment(ctx, segment, params) {
    const segmentMethod = _getSegmentMethod(this);
    return segmentMethod(ctx, this, segment, params);
  }
  path(ctx, start, count) {
    const segments = this.segments;
    const segmentMethod = _getSegmentMethod(this);
    let loop = this._loop;
    start = start || 0;
    count = count || this.points.length - start;
    for (const segment of segments) {
      loop &= segmentMethod(ctx, this, segment, {
        start,
        end: start + count - 1
      });
    }
    return !!loop;
  }
  draw(ctx, chartArea, start, count) {
    const options = this.options || {};
    const points = this.points || [];
    if (points.length && options.borderWidth) {
      ctx.save();
      draw(ctx, this, start, count);
      ctx.restore();
    }
    if (this.animated) {
      this._pointsUpdated = false;
      this._path = void 0;
    }
  }
};
function inRange$1(el, pos, axis, useFinalPosition) {
  const options = el.options;
  const { [axis]: value } = el.getProps([
    axis
  ], useFinalPosition);
  return Math.abs(pos - value) < options.radius + options.hitRadius;
}
var PointElement = class extends Element {
  static id = "point";
  parsed;
  skip;
  stop;
  /**
  * @type {any}
  */
  static defaults = {
    borderWidth: 1,
    hitRadius: 1,
    hoverBorderWidth: 1,
    hoverRadius: 4,
    pointStyle: "circle",
    radius: 3,
    rotation: 0
  };
  /**
  * @type {any}
  */
  static defaultRoutes = {
    backgroundColor: "backgroundColor",
    borderColor: "borderColor"
  };
  constructor(cfg) {
    super();
    this.options = void 0;
    this.parsed = void 0;
    this.skip = void 0;
    this.stop = void 0;
    if (cfg) {
      Object.assign(this, cfg);
    }
  }
  inRange(mouseX, mouseY, useFinalPosition) {
    const options = this.options;
    const { x, y } = this.getProps([
      "x",
      "y"
    ], useFinalPosition);
    return Math.pow(mouseX - x, 2) + Math.pow(mouseY - y, 2) < Math.pow(options.hitRadius + options.radius, 2);
  }
  inXRange(mouseX, useFinalPosition) {
    return inRange$1(this, mouseX, "x", useFinalPosition);
  }
  inYRange(mouseY, useFinalPosition) {
    return inRange$1(this, mouseY, "y", useFinalPosition);
  }
  getCenterPoint(useFinalPosition) {
    const { x, y } = this.getProps([
      "x",
      "y"
    ], useFinalPosition);
    return {
      x,
      y
    };
  }
  size(options) {
    options = options || this.options || {};
    let radius = options.radius || 0;
    radius = Math.max(radius, radius && options.hoverRadius || 0);
    const borderWidth = radius && options.borderWidth || 0;
    return (radius + borderWidth) * 2;
  }
  draw(ctx, area) {
    const options = this.options;
    if (this.skip || options.radius < 0.1 || !_isPointInArea(this, area, this.size(options) / 2)) {
      return;
    }
    ctx.strokeStyle = options.borderColor;
    ctx.lineWidth = options.borderWidth;
    ctx.fillStyle = options.backgroundColor;
    drawPoint(ctx, options, this.x, this.y);
  }
  getRange() {
    const options = this.options || {};
    return options.radius + options.hitRadius;
  }
};
function getBarBounds(bar, useFinalPosition) {
  const { x, y, base, width, height } = bar.getProps([
    "x",
    "y",
    "base",
    "width",
    "height"
  ], useFinalPosition);
  let left, right, top, bottom, half;
  if (bar.horizontal) {
    half = height / 2;
    left = Math.min(x, base);
    right = Math.max(x, base);
    top = y - half;
    bottom = y + half;
  } else {
    half = width / 2;
    left = x - half;
    right = x + half;
    top = Math.min(y, base);
    bottom = Math.max(y, base);
  }
  return {
    left,
    top,
    right,
    bottom
  };
}
function skipOrLimit(skip2, value, min, max) {
  return skip2 ? 0 : _limitValue(value, min, max);
}
function parseBorderWidth(bar, maxW, maxH) {
  const value = bar.options.borderWidth;
  const skip2 = bar.borderSkipped;
  const o = toTRBL(value);
  return {
    t: skipOrLimit(skip2.top, o.top, 0, maxH),
    r: skipOrLimit(skip2.right, o.right, 0, maxW),
    b: skipOrLimit(skip2.bottom, o.bottom, 0, maxH),
    l: skipOrLimit(skip2.left, o.left, 0, maxW)
  };
}
function parseBorderRadius(bar, maxW, maxH) {
  const { enableBorderRadius } = bar.getProps([
    "enableBorderRadius"
  ]);
  const value = bar.options.borderRadius;
  const o = toTRBLCorners(value);
  const maxR = Math.min(maxW, maxH);
  const skip2 = bar.borderSkipped;
  const enableBorder = enableBorderRadius || isObject(value);
  return {
    topLeft: skipOrLimit(!enableBorder || skip2.top || skip2.left, o.topLeft, 0, maxR),
    topRight: skipOrLimit(!enableBorder || skip2.top || skip2.right, o.topRight, 0, maxR),
    bottomLeft: skipOrLimit(!enableBorder || skip2.bottom || skip2.left, o.bottomLeft, 0, maxR),
    bottomRight: skipOrLimit(!enableBorder || skip2.bottom || skip2.right, o.bottomRight, 0, maxR)
  };
}
function boundingRects(bar) {
  const bounds = getBarBounds(bar);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const border = parseBorderWidth(bar, width / 2, height / 2);
  const radius = parseBorderRadius(bar, width / 2, height / 2);
  return {
    outer: {
      x: bounds.left,
      y: bounds.top,
      w: width,
      h: height,
      radius
    },
    inner: {
      x: bounds.left + border.l,
      y: bounds.top + border.t,
      w: width - border.l - border.r,
      h: height - border.t - border.b,
      radius: {
        topLeft: Math.max(0, radius.topLeft - Math.max(border.t, border.l)),
        topRight: Math.max(0, radius.topRight - Math.max(border.t, border.r)),
        bottomLeft: Math.max(0, radius.bottomLeft - Math.max(border.b, border.l)),
        bottomRight: Math.max(0, radius.bottomRight - Math.max(border.b, border.r))
      }
    }
  };
}
function inRange(bar, x, y, useFinalPosition) {
  const skipX = x === null;
  const skipY = y === null;
  const skipBoth = skipX && skipY;
  const bounds = bar && !skipBoth && getBarBounds(bar, useFinalPosition);
  return bounds && (skipX || _isBetween(x, bounds.left, bounds.right)) && (skipY || _isBetween(y, bounds.top, bounds.bottom));
}
function hasRadius(radius) {
  return radius.topLeft || radius.topRight || radius.bottomLeft || radius.bottomRight;
}
function addNormalRectPath(ctx, rect) {
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
}
function inflateRect(rect, amount, refRect = {}) {
  const x = rect.x !== refRect.x ? -amount : 0;
  const y = rect.y !== refRect.y ? -amount : 0;
  const w = (rect.x + rect.w !== refRect.x + refRect.w ? amount : 0) - x;
  const h4 = (rect.y + rect.h !== refRect.y + refRect.h ? amount : 0) - y;
  return {
    x: rect.x + x,
    y: rect.y + y,
    w: rect.w + w,
    h: rect.h + h4,
    radius: rect.radius
  };
}
var BarElement = class extends Element {
  static id = "bar";
  static defaults = {
    borderSkipped: "start",
    borderWidth: 0,
    borderRadius: 0,
    inflateAmount: "auto",
    pointStyle: void 0
  };
  static defaultRoutes = {
    backgroundColor: "backgroundColor",
    borderColor: "borderColor"
  };
  constructor(cfg) {
    super();
    this.options = void 0;
    this.horizontal = void 0;
    this.base = void 0;
    this.width = void 0;
    this.height = void 0;
    this.inflateAmount = void 0;
    if (cfg) {
      Object.assign(this, cfg);
    }
  }
  draw(ctx) {
    const { inflateAmount, options: { borderColor, backgroundColor } } = this;
    const { inner, outer } = boundingRects(this);
    const addRectPath = hasRadius(outer.radius) ? addRoundedRectPath : addNormalRectPath;
    ctx.save();
    if (outer.w !== inner.w || outer.h !== inner.h) {
      ctx.beginPath();
      addRectPath(ctx, inflateRect(outer, inflateAmount, inner));
      ctx.clip();
      addRectPath(ctx, inflateRect(inner, -inflateAmount, outer));
      ctx.fillStyle = borderColor;
      ctx.fill("evenodd");
    }
    ctx.beginPath();
    addRectPath(ctx, inflateRect(inner, inflateAmount));
    ctx.fillStyle = backgroundColor;
    ctx.fill();
    ctx.restore();
  }
  inRange(mouseX, mouseY, useFinalPosition) {
    return inRange(this, mouseX, mouseY, useFinalPosition);
  }
  inXRange(mouseX, useFinalPosition) {
    return inRange(this, mouseX, null, useFinalPosition);
  }
  inYRange(mouseY, useFinalPosition) {
    return inRange(this, null, mouseY, useFinalPosition);
  }
  getCenterPoint(useFinalPosition) {
    const { x, y, base, horizontal } = this.getProps([
      "x",
      "y",
      "base",
      "horizontal"
    ], useFinalPosition);
    return {
      x: horizontal ? (x + base) / 2 : x,
      y: horizontal ? y : (y + base) / 2
    };
  }
  getRange(axis) {
    return axis === "x" ? this.width / 2 : this.height / 2;
  }
};
var elements = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  ArcElement,
  BarElement,
  LineElement,
  PointElement
});
var BORDER_COLORS = [
  "rgb(54, 162, 235)",
  "rgb(255, 99, 132)",
  "rgb(255, 159, 64)",
  "rgb(255, 205, 86)",
  "rgb(75, 192, 192)",
  "rgb(153, 102, 255)",
  "rgb(201, 203, 207)"
  // grey
];
var BACKGROUND_COLORS = /* @__PURE__ */ BORDER_COLORS.map((color2) => color2.replace("rgb(", "rgba(").replace(")", ", 0.5)"));
function getBorderColor(i) {
  return BORDER_COLORS[i % BORDER_COLORS.length];
}
function getBackgroundColor(i) {
  return BACKGROUND_COLORS[i % BACKGROUND_COLORS.length];
}
function colorizeDefaultDataset(dataset, i) {
  dataset.borderColor = getBorderColor(i);
  dataset.backgroundColor = getBackgroundColor(i);
  return ++i;
}
function colorizeDoughnutDataset(dataset, i) {
  dataset.backgroundColor = dataset.data.map(() => getBorderColor(i++));
  return i;
}
function colorizePolarAreaDataset(dataset, i) {
  dataset.backgroundColor = dataset.data.map(() => getBackgroundColor(i++));
  return i;
}
function getColorizer(chart) {
  let i = 0;
  return (dataset, datasetIndex) => {
    const controller = chart.getDatasetMeta(datasetIndex).controller;
    if (controller instanceof DoughnutController) {
      i = colorizeDoughnutDataset(dataset, i);
    } else if (controller instanceof PolarAreaController) {
      i = colorizePolarAreaDataset(dataset, i);
    } else if (controller) {
      i = colorizeDefaultDataset(dataset, i);
    }
  };
}
function containsColorsDefinitions(descriptors2) {
  let k;
  for (k in descriptors2) {
    if (descriptors2[k].borderColor || descriptors2[k].backgroundColor) {
      return true;
    }
  }
  return false;
}
function containsColorsDefinition(descriptor) {
  return descriptor && (descriptor.borderColor || descriptor.backgroundColor);
}
function containsDefaultColorsDefenitions() {
  return defaults.borderColor !== "rgba(0,0,0,0.1)" || defaults.backgroundColor !== "rgba(0,0,0,0.1)";
}
var plugin_colors = {
  id: "colors",
  defaults: {
    enabled: true,
    forceOverride: false
  },
  beforeLayout(chart, _args, options) {
    if (!options.enabled) {
      return;
    }
    const { data: { datasets }, options: chartOptions } = chart.config;
    const { elements: elements2 } = chartOptions;
    const containsColorDefenition = containsColorsDefinitions(datasets) || containsColorsDefinition(chartOptions) || elements2 && containsColorsDefinitions(elements2) || containsDefaultColorsDefenitions();
    if (!options.forceOverride && containsColorDefenition) {
      return;
    }
    const colorizer = getColorizer(chart);
    datasets.forEach(colorizer);
  }
};
function lttbDecimation(data, start, count, availableWidth, options) {
  const samples = options.samples || availableWidth;
  if (samples >= count) {
    return data.slice(start, start + count);
  }
  const decimated = [];
  const bucketWidth = (count - 2) / (samples - 2);
  let sampledIndex = 0;
  const endIndex = start + count - 1;
  let a = start;
  let i, maxAreaPoint, maxArea, area, nextA;
  decimated[sampledIndex++] = data[a];
  for (i = 0; i < samples - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    let j;
    const avgRangeStart = Math.floor((i + 1) * bucketWidth) + 1 + start;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketWidth) + 1, count) + start;
    const avgRangeLength = avgRangeEnd - avgRangeStart;
    for (j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;
    const rangeOffs = Math.floor(i * bucketWidth) + 1 + start;
    const rangeTo = Math.min(Math.floor((i + 1) * bucketWidth) + 1, count) + start;
    const { x: pointAx, y: pointAy } = data[a];
    maxArea = area = -1;
    for (j = rangeOffs; j < rangeTo; j++) {
      area = 0.5 * Math.abs((pointAx - avgX) * (data[j].y - pointAy) - (pointAx - data[j].x) * (avgY - pointAy));
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j;
      }
    }
    decimated[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }
  decimated[sampledIndex++] = data[endIndex];
  return decimated;
}
function minMaxDecimation(data, start, count, availableWidth) {
  let avgX = 0;
  let countX = 0;
  let i, point, x, y, prevX, minIndex, maxIndex, startIndex, minY, maxY;
  const decimated = [];
  const endIndex = start + count - 1;
  const xMin = data[start].x;
  const xMax = data[endIndex].x;
  const dx = xMax - xMin;
  for (i = start; i < start + count; ++i) {
    point = data[i];
    x = (point.x - xMin) / dx * availableWidth;
    y = point.y;
    const truncX = x | 0;
    if (truncX === prevX) {
      if (y < minY) {
        minY = y;
        minIndex = i;
      } else if (y > maxY) {
        maxY = y;
        maxIndex = i;
      }
      avgX = (countX * avgX + point.x) / ++countX;
    } else {
      const lastIndex = i - 1;
      if (!isNullOrUndef(minIndex) && !isNullOrUndef(maxIndex)) {
        const intermediateIndex1 = Math.min(minIndex, maxIndex);
        const intermediateIndex2 = Math.max(minIndex, maxIndex);
        if (intermediateIndex1 !== startIndex && intermediateIndex1 !== lastIndex) {
          decimated.push({
            ...data[intermediateIndex1],
            x: avgX
          });
        }
        if (intermediateIndex2 !== startIndex && intermediateIndex2 !== lastIndex) {
          decimated.push({
            ...data[intermediateIndex2],
            x: avgX
          });
        }
      }
      if (i > 0 && lastIndex !== startIndex) {
        decimated.push(data[lastIndex]);
      }
      decimated.push(point);
      prevX = truncX;
      countX = 0;
      minY = maxY = y;
      minIndex = maxIndex = startIndex = i;
    }
  }
  return decimated;
}
function cleanDecimatedDataset(dataset) {
  if (dataset._decimated) {
    const data = dataset._data;
    delete dataset._decimated;
    delete dataset._data;
    Object.defineProperty(dataset, "data", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: data
    });
  }
}
function cleanDecimatedData(chart) {
  chart.data.datasets.forEach((dataset) => {
    cleanDecimatedDataset(dataset);
  });
}
function getStartAndCountOfVisiblePointsSimplified(meta, points) {
  const pointCount = points.length;
  let start = 0;
  let count;
  const { iScale } = meta;
  const { min, max, minDefined, maxDefined } = iScale.getUserBounds();
  if (minDefined) {
    start = _limitValue(_lookupByKey(points, iScale.axis, min).lo, 0, pointCount - 1);
  }
  if (maxDefined) {
    count = _limitValue(_lookupByKey(points, iScale.axis, max).hi + 1, start, pointCount) - start;
  } else {
    count = pointCount - start;
  }
  return {
    start,
    count
  };
}
var plugin_decimation = {
  id: "decimation",
  defaults: {
    algorithm: "min-max",
    enabled: false
  },
  beforeElementsUpdate: (chart, args, options) => {
    if (!options.enabled) {
      cleanDecimatedData(chart);
      return;
    }
    const availableWidth = chart.width;
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const { _data, indexAxis } = dataset;
      const meta = chart.getDatasetMeta(datasetIndex);
      const data = _data || dataset.data;
      if (resolve([
        indexAxis,
        chart.options.indexAxis
      ]) === "y") {
        return;
      }
      if (!meta.controller.supportsDecimation) {
        return;
      }
      const xAxis = chart.scales[meta.xAxisID];
      if (xAxis.type !== "linear" && xAxis.type !== "time") {
        return;
      }
      if (chart.options.parsing) {
        return;
      }
      let { start, count } = getStartAndCountOfVisiblePointsSimplified(meta, data);
      const threshold = options.threshold || 4 * availableWidth;
      if (count <= threshold) {
        cleanDecimatedDataset(dataset);
        return;
      }
      if (isNullOrUndef(_data)) {
        dataset._data = data;
        delete dataset.data;
        Object.defineProperty(dataset, "data", {
          configurable: true,
          enumerable: true,
          get: function() {
            return this._decimated;
          },
          set: function(d) {
            this._data = d;
          }
        });
      }
      let decimated;
      switch (options.algorithm) {
        case "lttb":
          decimated = lttbDecimation(data, start, count, availableWidth, options);
          break;
        case "min-max":
          decimated = minMaxDecimation(data, start, count, availableWidth);
          break;
        default:
          throw new Error(`Unsupported decimation algorithm '${options.algorithm}'`);
      }
      dataset._decimated = decimated;
    });
  },
  destroy(chart) {
    cleanDecimatedData(chart);
  }
};
function _segments(line, target, property) {
  const segments = line.segments;
  const points = line.points;
  const tpoints = target.points;
  const parts = [];
  for (const segment of segments) {
    let { start, end } = segment;
    end = _findSegmentEnd(start, end, points);
    const bounds = _getBounds(property, points[start], points[end], segment.loop);
    if (!target.segments) {
      parts.push({
        source: segment,
        target: bounds,
        start: points[start],
        end: points[end]
      });
      continue;
    }
    const targetSegments = _boundSegments(target, bounds);
    for (const tgt of targetSegments) {
      const subBounds = _getBounds(property, tpoints[tgt.start], tpoints[tgt.end], tgt.loop);
      const fillSources = _boundSegment(segment, points, subBounds);
      for (const fillSource of fillSources) {
        parts.push({
          source: fillSource,
          target: tgt,
          start: {
            [property]: _getEdge(bounds, subBounds, "start", Math.max)
          },
          end: {
            [property]: _getEdge(bounds, subBounds, "end", Math.min)
          }
        });
      }
    }
  }
  return parts;
}
function _getBounds(property, first, last, loop) {
  if (loop) {
    return;
  }
  let start = first[property];
  let end = last[property];
  if (property === "angle") {
    start = _normalizeAngle(start);
    end = _normalizeAngle(end);
  }
  return {
    property,
    start,
    end
  };
}
function _pointsFromSegments(boundary, line) {
  const { x = null, y = null } = boundary || {};
  const linePoints = line.points;
  const points = [];
  line.segments.forEach(({ start, end }) => {
    end = _findSegmentEnd(start, end, linePoints);
    const first = linePoints[start];
    const last = linePoints[end];
    if (y !== null) {
      points.push({
        x: first.x,
        y
      });
      points.push({
        x: last.x,
        y
      });
    } else if (x !== null) {
      points.push({
        x,
        y: first.y
      });
      points.push({
        x,
        y: last.y
      });
    }
  });
  return points;
}
function _findSegmentEnd(start, end, points) {
  for (; end > start; end--) {
    const point = points[end];
    if (!isNaN(point.x) && !isNaN(point.y)) {
      break;
    }
  }
  return end;
}
function _getEdge(a, b, prop, fn) {
  if (a && b) {
    return fn(a[prop], b[prop]);
  }
  return a ? a[prop] : b ? b[prop] : 0;
}
function _createBoundaryLine(boundary, line) {
  let points = [];
  let _loop = false;
  if (isArray(boundary)) {
    _loop = true;
    points = boundary;
  } else {
    points = _pointsFromSegments(boundary, line);
  }
  return points.length ? new LineElement({
    points,
    options: {
      tension: 0
    },
    _loop,
    _fullLoop: _loop
  }) : null;
}
function _shouldApplyFill(source) {
  return source && source.fill !== false;
}
function _resolveTarget(sources, index2, propagate) {
  const source = sources[index2];
  let fill2 = source.fill;
  const visited = [
    index2
  ];
  let target;
  if (!propagate) {
    return fill2;
  }
  while (fill2 !== false && visited.indexOf(fill2) === -1) {
    if (!isNumberFinite(fill2)) {
      return fill2;
    }
    target = sources[fill2];
    if (!target) {
      return false;
    }
    if (target.visible) {
      return fill2;
    }
    visited.push(fill2);
    fill2 = target.fill;
  }
  return false;
}
function _decodeFill(line, index2, count) {
  const fill2 = parseFillOption(line);
  if (isObject(fill2)) {
    return isNaN(fill2.value) ? false : fill2;
  }
  let target = parseFloat(fill2);
  if (isNumberFinite(target) && Math.floor(target) === target) {
    return decodeTargetIndex(fill2[0], index2, target, count);
  }
  return [
    "origin",
    "start",
    "end",
    "stack",
    "shape"
  ].indexOf(fill2) >= 0 && fill2;
}
function decodeTargetIndex(firstCh, index2, target, count) {
  if (firstCh === "-" || firstCh === "+") {
    target = index2 + target;
  }
  if (target === index2 || target < 0 || target >= count) {
    return false;
  }
  return target;
}
function _getTargetPixel(fill2, scale) {
  let pixel = null;
  if (fill2 === "start") {
    pixel = scale.bottom;
  } else if (fill2 === "end") {
    pixel = scale.top;
  } else if (isObject(fill2)) {
    pixel = scale.getPixelForValue(fill2.value);
  } else if (scale.getBasePixel) {
    pixel = scale.getBasePixel();
  }
  return pixel;
}
function _getTargetValue(fill2, scale, startValue) {
  let value;
  if (fill2 === "start") {
    value = startValue;
  } else if (fill2 === "end") {
    value = scale.options.reverse ? scale.min : scale.max;
  } else if (isObject(fill2)) {
    value = fill2.value;
  } else {
    value = scale.getBaseValue();
  }
  return value;
}
function parseFillOption(line) {
  const options = line.options;
  const fillOption = options.fill;
  let fill2 = valueOrDefault(fillOption && fillOption.target, fillOption);
  if (fill2 === void 0) {
    fill2 = !!options.backgroundColor;
  }
  if (fill2 === false || fill2 === null) {
    return false;
  }
  if (fill2 === true) {
    return "origin";
  }
  return fill2;
}
function _buildStackLine(source) {
  const { scale, index: index2, line } = source;
  const points = [];
  const segments = line.segments;
  const sourcePoints = line.points;
  const linesBelow = getLinesBelow(scale, index2);
  linesBelow.push(_createBoundaryLine({
    x: null,
    y: scale.bottom
  }, line));
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    for (let j = segment.start; j <= segment.end; j++) {
      addPointsBelow(points, sourcePoints[j], linesBelow);
    }
  }
  return new LineElement({
    points,
    options: {}
  });
}
function getLinesBelow(scale, index2) {
  const below = [];
  const metas = scale.getMatchingVisibleMetas("line");
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    if (meta.index === index2) {
      break;
    }
    if (!meta.hidden) {
      below.unshift(meta.dataset);
    }
  }
  return below;
}
function addPointsBelow(points, sourcePoint, linesBelow) {
  const postponed = [];
  for (let j = 0; j < linesBelow.length; j++) {
    const line = linesBelow[j];
    const { first, last, point } = findPoint(line, sourcePoint, "x");
    if (!point || first && last) {
      continue;
    }
    if (first) {
      postponed.unshift(point);
    } else {
      points.push(point);
      if (!last) {
        break;
      }
    }
  }
  points.push(...postponed);
}
function findPoint(line, sourcePoint, property) {
  const point = line.interpolate(sourcePoint, property);
  if (!point) {
    return {};
  }
  const pointValue = point[property];
  const segments = line.segments;
  const linePoints = line.points;
  let first = false;
  let last = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const firstValue = linePoints[segment.start][property];
    const lastValue = linePoints[segment.end][property];
    if (_isBetween(pointValue, firstValue, lastValue)) {
      first = pointValue === firstValue;
      last = pointValue === lastValue;
      break;
    }
  }
  return {
    first,
    last,
    point
  };
}
var simpleArc = class {
  constructor(opts) {
    this.x = opts.x;
    this.y = opts.y;
    this.radius = opts.radius;
  }
  pathSegment(ctx, bounds, opts) {
    const { x, y, radius } = this;
    bounds = bounds || {
      start: 0,
      end: TAU
    };
    ctx.arc(x, y, radius, bounds.end, bounds.start, true);
    return !opts.bounds;
  }
  interpolate(point) {
    const { x, y, radius } = this;
    const angle = point.angle;
    return {
      x: x + Math.cos(angle) * radius,
      y: y + Math.sin(angle) * radius,
      angle
    };
  }
};
function _getTarget(source) {
  const { chart, fill: fill2, line } = source;
  if (isNumberFinite(fill2)) {
    return getLineByIndex(chart, fill2);
  }
  if (fill2 === "stack") {
    return _buildStackLine(source);
  }
  if (fill2 === "shape") {
    return true;
  }
  const boundary = computeBoundary(source);
  if (boundary instanceof simpleArc) {
    return boundary;
  }
  return _createBoundaryLine(boundary, line);
}
function getLineByIndex(chart, index2) {
  const meta = chart.getDatasetMeta(index2);
  const visible = meta && chart.isDatasetVisible(index2);
  return visible ? meta.dataset : null;
}
function computeBoundary(source) {
  const scale = source.scale || {};
  if (scale.getPointPositionForValue) {
    return computeCircularBoundary(source);
  }
  return computeLinearBoundary(source);
}
function computeLinearBoundary(source) {
  const { scale = {}, fill: fill2 } = source;
  const pixel = _getTargetPixel(fill2, scale);
  if (isNumberFinite(pixel)) {
    const horizontal = scale.isHorizontal();
    return {
      x: horizontal ? pixel : null,
      y: horizontal ? null : pixel
    };
  }
  return null;
}
function computeCircularBoundary(source) {
  const { scale, fill: fill2 } = source;
  const options = scale.options;
  const length = scale.getLabels().length;
  const start = options.reverse ? scale.max : scale.min;
  const value = _getTargetValue(fill2, scale, start);
  const target = [];
  if (options.grid.circular) {
    const center = scale.getPointPositionForValue(0, start);
    return new simpleArc({
      x: center.x,
      y: center.y,
      radius: scale.getDistanceFromCenterForValue(value)
    });
  }
  for (let i = 0; i < length; ++i) {
    target.push(scale.getPointPositionForValue(i, value));
  }
  return target;
}
function _drawfill(ctx, source, area) {
  const target = _getTarget(source);
  const { chart, index: index2, line, scale, axis } = source;
  const lineOpts = line.options;
  const fillOption = lineOpts.fill;
  const color2 = lineOpts.backgroundColor;
  const { above = color2, below = color2 } = fillOption || {};
  const meta = chart.getDatasetMeta(index2);
  const clip = getDatasetClipArea(chart, meta);
  if (target && line.points.length) {
    clipArea(ctx, area);
    doFill(ctx, {
      line,
      target,
      above,
      below,
      area,
      scale,
      axis,
      clip
    });
    unclipArea(ctx);
  }
}
function doFill(ctx, cfg) {
  const { line, target, above, below, area, scale, clip } = cfg;
  const property = line._loop ? "angle" : cfg.axis;
  ctx.save();
  let fillColor = below;
  if (below !== above) {
    if (property === "x") {
      clipVertical(ctx, target, area.top);
      fill(ctx, {
        line,
        target,
        color: above,
        scale,
        property,
        clip
      });
      ctx.restore();
      ctx.save();
      clipVertical(ctx, target, area.bottom);
    } else if (property === "y") {
      clipHorizontal(ctx, target, area.left);
      fill(ctx, {
        line,
        target,
        color: below,
        scale,
        property,
        clip
      });
      ctx.restore();
      ctx.save();
      clipHorizontal(ctx, target, area.right);
      fillColor = above;
    }
  }
  fill(ctx, {
    line,
    target,
    color: fillColor,
    scale,
    property,
    clip
  });
  ctx.restore();
}
function clipVertical(ctx, target, clipY) {
  const { segments, points } = target;
  let first = true;
  let lineLoop = false;
  ctx.beginPath();
  for (const segment of segments) {
    const { start, end } = segment;
    const firstPoint = points[start];
    const lastPoint = points[_findSegmentEnd(start, end, points)];
    if (first) {
      ctx.moveTo(firstPoint.x, firstPoint.y);
      first = false;
    } else {
      ctx.lineTo(firstPoint.x, clipY);
      ctx.lineTo(firstPoint.x, firstPoint.y);
    }
    lineLoop = !!target.pathSegment(ctx, segment, {
      move: lineLoop
    });
    if (lineLoop) {
      ctx.closePath();
    } else {
      ctx.lineTo(lastPoint.x, clipY);
    }
  }
  ctx.lineTo(target.first().x, clipY);
  ctx.closePath();
  ctx.clip();
}
function clipHorizontal(ctx, target, clipX) {
  const { segments, points } = target;
  let first = true;
  let lineLoop = false;
  ctx.beginPath();
  for (const segment of segments) {
    const { start, end } = segment;
    const firstPoint = points[start];
    const lastPoint = points[_findSegmentEnd(start, end, points)];
    if (first) {
      ctx.moveTo(firstPoint.x, firstPoint.y);
      first = false;
    } else {
      ctx.lineTo(clipX, firstPoint.y);
      ctx.lineTo(firstPoint.x, firstPoint.y);
    }
    lineLoop = !!target.pathSegment(ctx, segment, {
      move: lineLoop
    });
    if (lineLoop) {
      ctx.closePath();
    } else {
      ctx.lineTo(clipX, lastPoint.y);
    }
  }
  ctx.lineTo(clipX, target.first().y);
  ctx.closePath();
  ctx.clip();
}
function fill(ctx, cfg) {
  const { line, target, property, color: color2, scale, clip } = cfg;
  const segments = _segments(line, target, property);
  for (const { source: src, target: tgt, start, end } of segments) {
    const { style: { backgroundColor = color2 } = {} } = src;
    const notShape = target !== true;
    ctx.save();
    ctx.fillStyle = backgroundColor;
    clipBounds(ctx, scale, clip, notShape && _getBounds(property, start, end));
    ctx.beginPath();
    const lineLoop = !!line.pathSegment(ctx, src);
    let loop;
    if (notShape) {
      if (lineLoop) {
        ctx.closePath();
      } else {
        interpolatedLineTo(ctx, target, end, property);
      }
      const targetLoop = !!target.pathSegment(ctx, tgt, {
        move: lineLoop,
        reverse: true
      });
      loop = lineLoop && targetLoop;
      if (!loop) {
        interpolatedLineTo(ctx, target, start, property);
      }
    }
    ctx.closePath();
    ctx.fill(loop ? "evenodd" : "nonzero");
    ctx.restore();
  }
}
function clipBounds(ctx, scale, clip, bounds) {
  const chartArea = scale.chart.chartArea;
  const { property, start, end } = bounds || {};
  if (property === "x" || property === "y") {
    let left, top, right, bottom;
    if (property === "x") {
      left = start;
      top = chartArea.top;
      right = end;
      bottom = chartArea.bottom;
    } else {
      left = chartArea.left;
      top = start;
      right = chartArea.right;
      bottom = end;
    }
    ctx.beginPath();
    if (clip) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
  }
}
function interpolatedLineTo(ctx, target, point, property) {
  const interpolatedPoint = target.interpolate(point, property);
  if (interpolatedPoint) {
    ctx.lineTo(interpolatedPoint.x, interpolatedPoint.y);
  }
}
var index = {
  id: "filler",
  afterDatasetsUpdate(chart, _args, options) {
    const count = (chart.data.datasets || []).length;
    const sources = [];
    let meta, i, line, source;
    for (i = 0; i < count; ++i) {
      meta = chart.getDatasetMeta(i);
      line = meta.dataset;
      source = null;
      if (line && line.options && line instanceof LineElement) {
        source = {
          visible: chart.isDatasetVisible(i),
          index: i,
          fill: _decodeFill(line, i, count),
          chart,
          axis: meta.controller.options.indexAxis,
          scale: meta.vScale,
          line
        };
      }
      meta.$filler = source;
      sources.push(source);
    }
    for (i = 0; i < count; ++i) {
      source = sources[i];
      if (!source || source.fill === false) {
        continue;
      }
      source.fill = _resolveTarget(sources, i, options.propagate);
    }
  },
  beforeDraw(chart, _args, options) {
    const draw2 = options.drawTime === "beforeDraw";
    const metasets = chart.getSortedVisibleDatasetMetas();
    const area = chart.chartArea;
    for (let i = metasets.length - 1; i >= 0; --i) {
      const source = metasets[i].$filler;
      if (!source) {
        continue;
      }
      source.line.updateControlPoints(area, source.axis);
      if (draw2 && source.fill) {
        _drawfill(chart.ctx, source, area);
      }
    }
  },
  beforeDatasetsDraw(chart, _args, options) {
    if (options.drawTime !== "beforeDatasetsDraw") {
      return;
    }
    const metasets = chart.getSortedVisibleDatasetMetas();
    for (let i = metasets.length - 1; i >= 0; --i) {
      const source = metasets[i].$filler;
      if (_shouldApplyFill(source)) {
        _drawfill(chart.ctx, source, chart.chartArea);
      }
    }
  },
  beforeDatasetDraw(chart, args, options) {
    const source = args.meta.$filler;
    if (!_shouldApplyFill(source) || options.drawTime !== "beforeDatasetDraw") {
      return;
    }
    _drawfill(chart.ctx, source, chart.chartArea);
  },
  defaults: {
    propagate: true,
    drawTime: "beforeDatasetDraw"
  }
};
var getBoxSize = (labelOpts, fontSize) => {
  let { boxHeight = fontSize, boxWidth = fontSize } = labelOpts;
  if (labelOpts.usePointStyle) {
    boxHeight = Math.min(boxHeight, fontSize);
    boxWidth = labelOpts.pointStyleWidth || Math.min(boxWidth, fontSize);
  }
  return {
    boxWidth,
    boxHeight,
    itemHeight: Math.max(fontSize, boxHeight)
  };
};
var itemsEqual = (a, b) => a !== null && b !== null && a.datasetIndex === b.datasetIndex && a.index === b.index;
var Legend = class extends Element {
  constructor(config) {
    super();
    this._added = false;
    this.legendHitBoxes = [];
    this._hoveredItem = null;
    this.doughnutMode = false;
    this.chart = config.chart;
    this.options = config.options;
    this.ctx = config.ctx;
    this.legendItems = void 0;
    this.columnSizes = void 0;
    this.lineWidths = void 0;
    this.maxHeight = void 0;
    this.maxWidth = void 0;
    this.top = void 0;
    this.bottom = void 0;
    this.left = void 0;
    this.right = void 0;
    this.height = void 0;
    this.width = void 0;
    this._margins = void 0;
    this.position = void 0;
    this.weight = void 0;
    this.fullSize = void 0;
  }
  update(maxWidth, maxHeight, margins) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this._margins = margins;
    this.setDimensions();
    this.buildLabels();
    this.fit();
  }
  setDimensions() {
    if (this.isHorizontal()) {
      this.width = this.maxWidth;
      this.left = this._margins.left;
      this.right = this.width;
    } else {
      this.height = this.maxHeight;
      this.top = this._margins.top;
      this.bottom = this.height;
    }
  }
  buildLabels() {
    const labelOpts = this.options.labels || {};
    let legendItems = callback(labelOpts.generateLabels, [
      this.chart
    ], this) || [];
    if (labelOpts.filter) {
      legendItems = legendItems.filter((item) => labelOpts.filter(item, this.chart.data));
    }
    if (labelOpts.sort) {
      legendItems = legendItems.sort((a, b) => labelOpts.sort(a, b, this.chart.data));
    }
    if (this.options.reverse) {
      legendItems.reverse();
    }
    this.legendItems = legendItems;
  }
  fit() {
    const { options, ctx } = this;
    if (!options.display) {
      this.width = this.height = 0;
      return;
    }
    const labelOpts = options.labels;
    const labelFont = toFont(labelOpts.font);
    const fontSize = labelFont.size;
    const titleHeight = this._computeTitleHeight();
    const { boxWidth, itemHeight } = getBoxSize(labelOpts, fontSize);
    let width, height;
    ctx.font = labelFont.string;
    if (this.isHorizontal()) {
      width = this.maxWidth;
      height = this._fitRows(titleHeight, fontSize, boxWidth, itemHeight) + 10;
    } else {
      height = this.maxHeight;
      width = this._fitCols(titleHeight, labelFont, boxWidth, itemHeight) + 10;
    }
    this.width = Math.min(width, options.maxWidth || this.maxWidth);
    this.height = Math.min(height, options.maxHeight || this.maxHeight);
  }
  _fitRows(titleHeight, fontSize, boxWidth, itemHeight) {
    const { ctx, maxWidth, options: { labels: { padding } } } = this;
    const hitboxes = this.legendHitBoxes = [];
    const lineWidths = this.lineWidths = [
      0
    ];
    const lineHeight = itemHeight + padding;
    let totalHeight = titleHeight;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let row2 = -1;
    let top = -lineHeight;
    this.legendItems.forEach((legendItem, i) => {
      const itemWidth = boxWidth + fontSize / 2 + ctx.measureText(legendItem.text).width;
      if (i === 0 || lineWidths[lineWidths.length - 1] + itemWidth + 2 * padding > maxWidth) {
        totalHeight += lineHeight;
        lineWidths[lineWidths.length - (i > 0 ? 0 : 1)] = 0;
        top += lineHeight;
        row2++;
      }
      hitboxes[i] = {
        left: 0,
        top,
        row: row2,
        width: itemWidth,
        height: itemHeight
      };
      lineWidths[lineWidths.length - 1] += itemWidth + padding;
    });
    return totalHeight;
  }
  _fitCols(titleHeight, labelFont, boxWidth, _itemHeight) {
    const { ctx, maxHeight, options: { labels: { padding } } } = this;
    const hitboxes = this.legendHitBoxes = [];
    const columnSizes = this.columnSizes = [];
    const heightLimit = maxHeight - titleHeight;
    let totalWidth = padding;
    let currentColWidth = 0;
    let currentColHeight = 0;
    let left = 0;
    let col = 0;
    this.legendItems.forEach((legendItem, i) => {
      const { itemWidth, itemHeight } = calculateItemSize(boxWidth, labelFont, ctx, legendItem, _itemHeight);
      if (i > 0 && currentColHeight + itemHeight + 2 * padding > heightLimit) {
        totalWidth += currentColWidth + padding;
        columnSizes.push({
          width: currentColWidth,
          height: currentColHeight
        });
        left += currentColWidth + padding;
        col++;
        currentColWidth = currentColHeight = 0;
      }
      hitboxes[i] = {
        left,
        top: currentColHeight,
        col,
        width: itemWidth,
        height: itemHeight
      };
      currentColWidth = Math.max(currentColWidth, itemWidth);
      currentColHeight += itemHeight + padding;
    });
    totalWidth += currentColWidth;
    columnSizes.push({
      width: currentColWidth,
      height: currentColHeight
    });
    return totalWidth;
  }
  adjustHitBoxes() {
    if (!this.options.display) {
      return;
    }
    const titleHeight = this._computeTitleHeight();
    const { legendHitBoxes: hitboxes, options: { align, labels: { padding }, rtl } } = this;
    const rtlHelper = getRtlAdapter(rtl, this.left, this.width);
    if (this.isHorizontal()) {
      let row2 = 0;
      let left = _alignStartEnd(align, this.left + padding, this.right - this.lineWidths[row2]);
      for (const hitbox of hitboxes) {
        if (row2 !== hitbox.row) {
          row2 = hitbox.row;
          left = _alignStartEnd(align, this.left + padding, this.right - this.lineWidths[row2]);
        }
        hitbox.top += this.top + titleHeight + padding;
        hitbox.left = rtlHelper.leftForLtr(rtlHelper.x(left), hitbox.width);
        left += hitbox.width + padding;
      }
    } else {
      let col = 0;
      let top = _alignStartEnd(align, this.top + titleHeight + padding, this.bottom - this.columnSizes[col].height);
      for (const hitbox of hitboxes) {
        if (hitbox.col !== col) {
          col = hitbox.col;
          top = _alignStartEnd(align, this.top + titleHeight + padding, this.bottom - this.columnSizes[col].height);
        }
        hitbox.top = top;
        hitbox.left += this.left + padding;
        hitbox.left = rtlHelper.leftForLtr(rtlHelper.x(hitbox.left), hitbox.width);
        top += hitbox.height + padding;
      }
    }
  }
  isHorizontal() {
    return this.options.position === "top" || this.options.position === "bottom";
  }
  draw() {
    if (this.options.display) {
      const ctx = this.ctx;
      clipArea(ctx, this);
      this._draw();
      unclipArea(ctx);
    }
  }
  _draw() {
    const { options: opts, columnSizes, lineWidths, ctx } = this;
    const { align, labels: labelOpts } = opts;
    const defaultColor = defaults.color;
    const rtlHelper = getRtlAdapter(opts.rtl, this.left, this.width);
    const labelFont = toFont(labelOpts.font);
    const { padding } = labelOpts;
    const fontSize = labelFont.size;
    const halfFontSize = fontSize / 2;
    let cursor;
    this.drawTitle();
    ctx.textAlign = rtlHelper.textAlign("left");
    ctx.textBaseline = "middle";
    ctx.lineWidth = 0.5;
    ctx.font = labelFont.string;
    const { boxWidth, boxHeight, itemHeight } = getBoxSize(labelOpts, fontSize);
    const drawLegendBox = function(x, y, legendItem) {
      if (isNaN(boxWidth) || boxWidth <= 0 || isNaN(boxHeight) || boxHeight < 0) {
        return;
      }
      ctx.save();
      const lineWidth = valueOrDefault(legendItem.lineWidth, 1);
      ctx.fillStyle = valueOrDefault(legendItem.fillStyle, defaultColor);
      ctx.lineCap = valueOrDefault(legendItem.lineCap, "butt");
      ctx.lineDashOffset = valueOrDefault(legendItem.lineDashOffset, 0);
      ctx.lineJoin = valueOrDefault(legendItem.lineJoin, "miter");
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = valueOrDefault(legendItem.strokeStyle, defaultColor);
      ctx.setLineDash(valueOrDefault(legendItem.lineDash, []));
      if (labelOpts.usePointStyle) {
        const drawOptions = {
          radius: boxHeight * Math.SQRT2 / 2,
          pointStyle: legendItem.pointStyle,
          rotation: legendItem.rotation,
          borderWidth: lineWidth
        };
        const centerX = rtlHelper.xPlus(x, boxWidth / 2);
        const centerY = y + halfFontSize;
        drawPointLegend(ctx, drawOptions, centerX, centerY, labelOpts.pointStyleWidth && boxWidth);
      } else {
        const yBoxTop = y + Math.max((fontSize - boxHeight) / 2, 0);
        const xBoxLeft = rtlHelper.leftForLtr(x, boxWidth);
        const borderRadius = toTRBLCorners(legendItem.borderRadius);
        ctx.beginPath();
        if (Object.values(borderRadius).some((v) => v !== 0)) {
          addRoundedRectPath(ctx, {
            x: xBoxLeft,
            y: yBoxTop,
            w: boxWidth,
            h: boxHeight,
            radius: borderRadius
          });
        } else {
          ctx.rect(xBoxLeft, yBoxTop, boxWidth, boxHeight);
        }
        ctx.fill();
        if (lineWidth !== 0) {
          ctx.stroke();
        }
      }
      ctx.restore();
    };
    const fillText = function(x, y, legendItem) {
      renderText(ctx, legendItem.text, x, y + itemHeight / 2, labelFont, {
        strikethrough: legendItem.hidden,
        textAlign: rtlHelper.textAlign(legendItem.textAlign)
      });
    };
    const isHorizontal = this.isHorizontal();
    const titleHeight = this._computeTitleHeight();
    if (isHorizontal) {
      cursor = {
        x: _alignStartEnd(align, this.left + padding, this.right - lineWidths[0]),
        y: this.top + padding + titleHeight,
        line: 0
      };
    } else {
      cursor = {
        x: this.left + padding,
        y: _alignStartEnd(align, this.top + titleHeight + padding, this.bottom - columnSizes[0].height),
        line: 0
      };
    }
    overrideTextDirection(this.ctx, opts.textDirection);
    const lineHeight = itemHeight + padding;
    this.legendItems.forEach((legendItem, i) => {
      ctx.strokeStyle = legendItem.fontColor;
      ctx.fillStyle = legendItem.fontColor;
      const textWidth = ctx.measureText(legendItem.text).width;
      const textAlign = rtlHelper.textAlign(legendItem.textAlign || (legendItem.textAlign = labelOpts.textAlign));
      const width = boxWidth + halfFontSize + textWidth;
      let x = cursor.x;
      let y = cursor.y;
      rtlHelper.setWidth(this.width);
      if (isHorizontal) {
        if (i > 0 && x + width + padding > this.right) {
          y = cursor.y += lineHeight;
          cursor.line++;
          x = cursor.x = _alignStartEnd(align, this.left + padding, this.right - lineWidths[cursor.line]);
        }
      } else if (i > 0 && y + lineHeight > this.bottom) {
        x = cursor.x = x + columnSizes[cursor.line].width + padding;
        cursor.line++;
        y = cursor.y = _alignStartEnd(align, this.top + titleHeight + padding, this.bottom - columnSizes[cursor.line].height);
      }
      const realX = rtlHelper.x(x);
      drawLegendBox(realX, y, legendItem);
      x = _textX(textAlign, x + boxWidth + halfFontSize, isHorizontal ? x + width : this.right, opts.rtl);
      fillText(rtlHelper.x(x), y, legendItem);
      if (isHorizontal) {
        cursor.x += width + padding;
      } else if (typeof legendItem.text !== "string") {
        const fontLineHeight = labelFont.lineHeight;
        cursor.y += calculateLegendItemHeight(legendItem, fontLineHeight) + padding;
      } else {
        cursor.y += lineHeight;
      }
    });
    restoreTextDirection(this.ctx, opts.textDirection);
  }
  drawTitle() {
    const opts = this.options;
    const titleOpts = opts.title;
    const titleFont = toFont(titleOpts.font);
    const titlePadding = toPadding(titleOpts.padding);
    if (!titleOpts.display) {
      return;
    }
    const rtlHelper = getRtlAdapter(opts.rtl, this.left, this.width);
    const ctx = this.ctx;
    const position = titleOpts.position;
    const halfFontSize = titleFont.size / 2;
    const topPaddingPlusHalfFontSize = titlePadding.top + halfFontSize;
    let y;
    let left = this.left;
    let maxWidth = this.width;
    if (this.isHorizontal()) {
      maxWidth = Math.max(...this.lineWidths);
      y = this.top + topPaddingPlusHalfFontSize;
      left = _alignStartEnd(opts.align, left, this.right - maxWidth);
    } else {
      const maxHeight = this.columnSizes.reduce((acc, size) => Math.max(acc, size.height), 0);
      y = topPaddingPlusHalfFontSize + _alignStartEnd(opts.align, this.top, this.bottom - maxHeight - opts.labels.padding - this._computeTitleHeight());
    }
    const x = _alignStartEnd(position, left, left + maxWidth);
    ctx.textAlign = rtlHelper.textAlign(_toLeftRightCenter(position));
    ctx.textBaseline = "middle";
    ctx.strokeStyle = titleOpts.color;
    ctx.fillStyle = titleOpts.color;
    ctx.font = titleFont.string;
    renderText(ctx, titleOpts.text, x, y, titleFont);
  }
  _computeTitleHeight() {
    const titleOpts = this.options.title;
    const titleFont = toFont(titleOpts.font);
    const titlePadding = toPadding(titleOpts.padding);
    return titleOpts.display ? titleFont.lineHeight + titlePadding.height : 0;
  }
  _getLegendItemAt(x, y) {
    let i, hitBox, lh;
    if (_isBetween(x, this.left, this.right) && _isBetween(y, this.top, this.bottom)) {
      lh = this.legendHitBoxes;
      for (i = 0; i < lh.length; ++i) {
        hitBox = lh[i];
        if (_isBetween(x, hitBox.left, hitBox.left + hitBox.width) && _isBetween(y, hitBox.top, hitBox.top + hitBox.height)) {
          return this.legendItems[i];
        }
      }
    }
    return null;
  }
  handleEvent(e) {
    const opts = this.options;
    if (!isListened(e.type, opts)) {
      return;
    }
    const hoveredItem = this._getLegendItemAt(e.x, e.y);
    if (e.type === "mousemove" || e.type === "mouseout") {
      const previous = this._hoveredItem;
      const sameItem = itemsEqual(previous, hoveredItem);
      if (previous && !sameItem) {
        callback(opts.onLeave, [
          e,
          previous,
          this
        ], this);
      }
      this._hoveredItem = hoveredItem;
      if (hoveredItem && !sameItem) {
        callback(opts.onHover, [
          e,
          hoveredItem,
          this
        ], this);
      }
    } else if (hoveredItem) {
      callback(opts.onClick, [
        e,
        hoveredItem,
        this
      ], this);
    }
  }
};
function calculateItemSize(boxWidth, labelFont, ctx, legendItem, _itemHeight) {
  const itemWidth = calculateItemWidth(legendItem, boxWidth, labelFont, ctx);
  const itemHeight = calculateItemHeight(_itemHeight, legendItem, labelFont.lineHeight);
  return {
    itemWidth,
    itemHeight
  };
}
function calculateItemWidth(legendItem, boxWidth, labelFont, ctx) {
  let legendItemText = legendItem.text;
  if (legendItemText && typeof legendItemText !== "string") {
    legendItemText = legendItemText.reduce((a, b) => a.length > b.length ? a : b);
  }
  return boxWidth + labelFont.size / 2 + ctx.measureText(legendItemText).width;
}
function calculateItemHeight(_itemHeight, legendItem, fontLineHeight) {
  let itemHeight = _itemHeight;
  if (typeof legendItem.text !== "string") {
    itemHeight = calculateLegendItemHeight(legendItem, fontLineHeight);
  }
  return itemHeight;
}
function calculateLegendItemHeight(legendItem, fontLineHeight) {
  const labelHeight = legendItem.text ? legendItem.text.length : 0;
  return fontLineHeight * labelHeight;
}
function isListened(type, opts) {
  if ((type === "mousemove" || type === "mouseout") && (opts.onHover || opts.onLeave)) {
    return true;
  }
  if (opts.onClick && (type === "click" || type === "mouseup")) {
    return true;
  }
  return false;
}
var plugin_legend = {
  id: "legend",
  _element: Legend,
  start(chart, _args, options) {
    const legend = chart.legend = new Legend({
      ctx: chart.ctx,
      options,
      chart
    });
    layouts.configure(chart, legend, options);
    layouts.addBox(chart, legend);
  },
  stop(chart) {
    layouts.removeBox(chart, chart.legend);
    delete chart.legend;
  },
  beforeUpdate(chart, _args, options) {
    const legend = chart.legend;
    layouts.configure(chart, legend, options);
    legend.options = options;
  },
  afterUpdate(chart) {
    const legend = chart.legend;
    legend.buildLabels();
    legend.adjustHitBoxes();
  },
  afterEvent(chart, args) {
    if (!args.replay) {
      chart.legend.handleEvent(args.event);
    }
  },
  defaults: {
    display: true,
    position: "top",
    align: "center",
    fullSize: true,
    reverse: false,
    weight: 1e3,
    onClick(e, legendItem, legend) {
      const index2 = legendItem.datasetIndex;
      const ci = legend.chart;
      if (ci.isDatasetVisible(index2)) {
        ci.hide(index2);
        legendItem.hidden = true;
      } else {
        ci.show(index2);
        legendItem.hidden = false;
      }
    },
    onHover: null,
    onLeave: null,
    labels: {
      color: (ctx) => ctx.chart.options.color,
      boxWidth: 40,
      padding: 10,
      generateLabels(chart) {
        const datasets = chart.data.datasets;
        const { labels: { usePointStyle, pointStyle, textAlign, color: color2, useBorderRadius, borderRadius } } = chart.legend.options;
        return chart._getSortedDatasetMetas().map((meta) => {
          const style = meta.controller.getStyle(usePointStyle ? 0 : void 0);
          const borderWidth = toPadding(style.borderWidth);
          return {
            text: datasets[meta.index].label,
            fillStyle: style.backgroundColor,
            fontColor: color2,
            hidden: !meta.visible,
            lineCap: style.borderCapStyle,
            lineDash: style.borderDash,
            lineDashOffset: style.borderDashOffset,
            lineJoin: style.borderJoinStyle,
            lineWidth: (borderWidth.width + borderWidth.height) / 4,
            strokeStyle: style.borderColor,
            pointStyle: pointStyle || style.pointStyle,
            rotation: style.rotation,
            textAlign: textAlign || style.textAlign,
            borderRadius: useBorderRadius && (borderRadius || style.borderRadius),
            datasetIndex: meta.index
          };
        }, this);
      }
    },
    title: {
      color: (ctx) => ctx.chart.options.color,
      display: false,
      position: "center",
      text: ""
    }
  },
  descriptors: {
    _scriptable: (name) => !name.startsWith("on"),
    labels: {
      _scriptable: (name) => ![
        "generateLabels",
        "filter",
        "sort"
      ].includes(name)
    }
  }
};
var Title = class extends Element {
  constructor(config) {
    super();
    this.chart = config.chart;
    this.options = config.options;
    this.ctx = config.ctx;
    this._padding = void 0;
    this.top = void 0;
    this.bottom = void 0;
    this.left = void 0;
    this.right = void 0;
    this.width = void 0;
    this.height = void 0;
    this.position = void 0;
    this.weight = void 0;
    this.fullSize = void 0;
  }
  update(maxWidth, maxHeight) {
    const opts = this.options;
    this.left = 0;
    this.top = 0;
    if (!opts.display) {
      this.width = this.height = this.right = this.bottom = 0;
      return;
    }
    this.width = this.right = maxWidth;
    this.height = this.bottom = maxHeight;
    const lineCount = isArray(opts.text) ? opts.text.length : 1;
    this._padding = toPadding(opts.padding);
    const textSize = lineCount * toFont(opts.font).lineHeight + this._padding.height;
    if (this.isHorizontal()) {
      this.height = textSize;
    } else {
      this.width = textSize;
    }
  }
  isHorizontal() {
    const pos = this.options.position;
    return pos === "top" || pos === "bottom";
  }
  _drawArgs(offset) {
    const { top, left, bottom, right, options } = this;
    const align = options.align;
    let rotation = 0;
    let maxWidth, titleX, titleY;
    if (this.isHorizontal()) {
      titleX = _alignStartEnd(align, left, right);
      titleY = top + offset;
      maxWidth = right - left;
    } else {
      if (options.position === "left") {
        titleX = left + offset;
        titleY = _alignStartEnd(align, bottom, top);
        rotation = PI * -0.5;
      } else {
        titleX = right - offset;
        titleY = _alignStartEnd(align, top, bottom);
        rotation = PI * 0.5;
      }
      maxWidth = bottom - top;
    }
    return {
      titleX,
      titleY,
      maxWidth,
      rotation
    };
  }
  draw() {
    const ctx = this.ctx;
    const opts = this.options;
    if (!opts.display) {
      return;
    }
    const fontOpts = toFont(opts.font);
    const lineHeight = fontOpts.lineHeight;
    const offset = lineHeight / 2 + this._padding.top;
    const { titleX, titleY, maxWidth, rotation } = this._drawArgs(offset);
    renderText(ctx, opts.text, 0, 0, fontOpts, {
      color: opts.color,
      maxWidth,
      rotation,
      textAlign: _toLeftRightCenter(opts.align),
      textBaseline: "middle",
      translation: [
        titleX,
        titleY
      ]
    });
  }
};
function createTitle(chart, titleOpts) {
  const title = new Title({
    ctx: chart.ctx,
    options: titleOpts,
    chart
  });
  layouts.configure(chart, title, titleOpts);
  layouts.addBox(chart, title);
  chart.titleBlock = title;
}
var plugin_title = {
  id: "title",
  _element: Title,
  start(chart, _args, options) {
    createTitle(chart, options);
  },
  stop(chart) {
    const titleBlock = chart.titleBlock;
    layouts.removeBox(chart, titleBlock);
    delete chart.titleBlock;
  },
  beforeUpdate(chart, _args, options) {
    const title = chart.titleBlock;
    layouts.configure(chart, title, options);
    title.options = options;
  },
  defaults: {
    align: "center",
    display: false,
    font: {
      weight: "bold"
    },
    fullSize: true,
    padding: 10,
    position: "top",
    text: "",
    weight: 2e3
  },
  defaultRoutes: {
    color: "color"
  },
  descriptors: {
    _scriptable: true,
    _indexable: false
  }
};
var map2 = /* @__PURE__ */ new WeakMap();
var plugin_subtitle = {
  id: "subtitle",
  start(chart, _args, options) {
    const title = new Title({
      ctx: chart.ctx,
      options,
      chart
    });
    layouts.configure(chart, title, options);
    layouts.addBox(chart, title);
    map2.set(chart, title);
  },
  stop(chart) {
    layouts.removeBox(chart, map2.get(chart));
    map2.delete(chart);
  },
  beforeUpdate(chart, _args, options) {
    const title = map2.get(chart);
    layouts.configure(chart, title, options);
    title.options = options;
  },
  defaults: {
    align: "center",
    display: false,
    font: {
      weight: "normal"
    },
    fullSize: true,
    padding: 0,
    position: "top",
    text: "",
    weight: 1500
  },
  defaultRoutes: {
    color: "color"
  },
  descriptors: {
    _scriptable: true,
    _indexable: false
  }
};
var positioners = {
  average(items) {
    if (!items.length) {
      return false;
    }
    let i, len;
    let xSet = /* @__PURE__ */ new Set();
    let y = 0;
    let count = 0;
    for (i = 0, len = items.length; i < len; ++i) {
      const el = items[i].element;
      if (el && el.hasValue()) {
        const pos = el.tooltipPosition();
        xSet.add(pos.x);
        y += pos.y;
        ++count;
      }
    }
    if (count === 0 || xSet.size === 0) {
      return false;
    }
    const xAverage = [
      ...xSet
    ].reduce((a, b) => a + b) / xSet.size;
    return {
      x: xAverage,
      y: y / count
    };
  },
  nearest(items, eventPosition) {
    if (!items.length) {
      return false;
    }
    let x = eventPosition.x;
    let y = eventPosition.y;
    let minDistance = Number.POSITIVE_INFINITY;
    let i, len, nearestElement;
    for (i = 0, len = items.length; i < len; ++i) {
      const el = items[i].element;
      if (el && el.hasValue()) {
        const center = el.getCenterPoint();
        const d = distanceBetweenPoints(eventPosition, center);
        if (d < minDistance) {
          minDistance = d;
          nearestElement = el;
        }
      }
    }
    if (nearestElement) {
      const tp = nearestElement.tooltipPosition();
      x = tp.x;
      y = tp.y;
    }
    return {
      x,
      y
    };
  }
};
function pushOrConcat(base, toPush) {
  if (toPush) {
    if (isArray(toPush)) {
      Array.prototype.push.apply(base, toPush);
    } else {
      base.push(toPush);
    }
  }
  return base;
}
function splitNewlines(str) {
  if ((typeof str === "string" || str instanceof String) && str.indexOf("\n") > -1) {
    return str.split("\n");
  }
  return str;
}
function createTooltipItem(chart, item) {
  const { element, datasetIndex, index: index2 } = item;
  const controller = chart.getDatasetMeta(datasetIndex).controller;
  const { label, value } = controller.getLabelAndValue(index2);
  return {
    chart,
    label,
    parsed: controller.getParsed(index2),
    raw: chart.data.datasets[datasetIndex].data[index2],
    formattedValue: value,
    dataset: controller.getDataset(),
    dataIndex: index2,
    datasetIndex,
    element
  };
}
function getTooltipSize(tooltip, options) {
  const ctx = tooltip.chart.ctx;
  const { body, footer, title } = tooltip;
  const { boxWidth, boxHeight } = options;
  const bodyFont = toFont(options.bodyFont);
  const titleFont = toFont(options.titleFont);
  const footerFont = toFont(options.footerFont);
  const titleLineCount = title.length;
  const footerLineCount = footer.length;
  const bodyLineItemCount = body.length;
  const padding = toPadding(options.padding);
  let height = padding.height;
  let width = 0;
  let combinedBodyLength = body.reduce((count, bodyItem) => count + bodyItem.before.length + bodyItem.lines.length + bodyItem.after.length, 0);
  combinedBodyLength += tooltip.beforeBody.length + tooltip.afterBody.length;
  if (titleLineCount) {
    height += titleLineCount * titleFont.lineHeight + (titleLineCount - 1) * options.titleSpacing + options.titleMarginBottom;
  }
  if (combinedBodyLength) {
    const bodyLineHeight = options.displayColors ? Math.max(boxHeight, bodyFont.lineHeight) : bodyFont.lineHeight;
    height += bodyLineItemCount * bodyLineHeight + (combinedBodyLength - bodyLineItemCount) * bodyFont.lineHeight + (combinedBodyLength - 1) * options.bodySpacing;
  }
  if (footerLineCount) {
    height += options.footerMarginTop + footerLineCount * footerFont.lineHeight + (footerLineCount - 1) * options.footerSpacing;
  }
  let widthPadding = 0;
  const maxLineWidth = function(line) {
    width = Math.max(width, ctx.measureText(line).width + widthPadding);
  };
  ctx.save();
  ctx.font = titleFont.string;
  each(tooltip.title, maxLineWidth);
  ctx.font = bodyFont.string;
  each(tooltip.beforeBody.concat(tooltip.afterBody), maxLineWidth);
  widthPadding = options.displayColors ? boxWidth + 2 + options.boxPadding : 0;
  each(body, (bodyItem) => {
    each(bodyItem.before, maxLineWidth);
    each(bodyItem.lines, maxLineWidth);
    each(bodyItem.after, maxLineWidth);
  });
  widthPadding = 0;
  ctx.font = footerFont.string;
  each(tooltip.footer, maxLineWidth);
  ctx.restore();
  width += padding.width;
  return {
    width,
    height
  };
}
function determineYAlign(chart, size) {
  const { y, height } = size;
  if (y < height / 2) {
    return "top";
  } else if (y > chart.height - height / 2) {
    return "bottom";
  }
  return "center";
}
function doesNotFitWithAlign(xAlign, chart, options, size) {
  const { x, width } = size;
  const caret = options.caretSize + options.caretPadding;
  if (xAlign === "left" && x + width + caret > chart.width) {
    return true;
  }
  if (xAlign === "right" && x - width - caret < 0) {
    return true;
  }
}
function determineXAlign(chart, options, size, yAlign) {
  const { x, width } = size;
  const { width: chartWidth, chartArea: { left, right } } = chart;
  let xAlign = "center";
  if (yAlign === "center") {
    xAlign = x <= (left + right) / 2 ? "left" : "right";
  } else if (x <= width / 2) {
    xAlign = "left";
  } else if (x >= chartWidth - width / 2) {
    xAlign = "right";
  }
  if (doesNotFitWithAlign(xAlign, chart, options, size)) {
    xAlign = "center";
  }
  return xAlign;
}
function determineAlignment(chart, options, size) {
  const yAlign = size.yAlign || options.yAlign || determineYAlign(chart, size);
  return {
    xAlign: size.xAlign || options.xAlign || determineXAlign(chart, options, size, yAlign),
    yAlign
  };
}
function alignX(size, xAlign) {
  let { x, width } = size;
  if (xAlign === "right") {
    x -= width;
  } else if (xAlign === "center") {
    x -= width / 2;
  }
  return x;
}
function alignY(size, yAlign, paddingAndSize) {
  let { y, height } = size;
  if (yAlign === "top") {
    y += paddingAndSize;
  } else if (yAlign === "bottom") {
    y -= height + paddingAndSize;
  } else {
    y -= height / 2;
  }
  return y;
}
function getBackgroundPoint(options, size, alignment, chart) {
  const { caretSize, caretPadding, cornerRadius } = options;
  const { xAlign, yAlign } = alignment;
  const paddingAndSize = caretSize + caretPadding;
  const { topLeft, topRight, bottomLeft, bottomRight } = toTRBLCorners(cornerRadius);
  let x = alignX(size, xAlign);
  const y = alignY(size, yAlign, paddingAndSize);
  if (yAlign === "center") {
    if (xAlign === "left") {
      x += paddingAndSize;
    } else if (xAlign === "right") {
      x -= paddingAndSize;
    }
  } else if (xAlign === "left") {
    x -= Math.max(topLeft, bottomLeft) + caretSize;
  } else if (xAlign === "right") {
    x += Math.max(topRight, bottomRight) + caretSize;
  }
  return {
    x: _limitValue(x, 0, chart.width - size.width),
    y: _limitValue(y, 0, chart.height - size.height)
  };
}
function getAlignedX(tooltip, align, options) {
  const padding = toPadding(options.padding);
  return align === "center" ? tooltip.x + tooltip.width / 2 : align === "right" ? tooltip.x + tooltip.width - padding.right : tooltip.x + padding.left;
}
function getBeforeAfterBodyLines(callback2) {
  return pushOrConcat([], splitNewlines(callback2));
}
function createTooltipContext(parent, tooltip, tooltipItems) {
  return createContext(parent, {
    tooltip,
    tooltipItems,
    type: "tooltip"
  });
}
function overrideCallbacks(callbacks, context) {
  const override = context && context.dataset && context.dataset.tooltip && context.dataset.tooltip.callbacks;
  return override ? callbacks.override(override) : callbacks;
}
var defaultCallbacks = {
  beforeTitle: noop,
  title(tooltipItems) {
    if (tooltipItems.length > 0) {
      const item = tooltipItems[0];
      const labels = item.chart.data.labels;
      const labelCount = labels ? labels.length : 0;
      if (this && this.options && this.options.mode === "dataset") {
        return item.dataset.label || "";
      } else if (item.label) {
        return item.label;
      } else if (labelCount > 0 && item.dataIndex < labelCount) {
        return labels[item.dataIndex];
      }
    }
    return "";
  },
  afterTitle: noop,
  beforeBody: noop,
  beforeLabel: noop,
  label(tooltipItem) {
    if (this && this.options && this.options.mode === "dataset") {
      return tooltipItem.label + ": " + tooltipItem.formattedValue || tooltipItem.formattedValue;
    }
    let label = tooltipItem.dataset.label || "";
    if (label) {
      label += ": ";
    }
    const value = tooltipItem.formattedValue;
    if (!isNullOrUndef(value)) {
      label += value;
    }
    return label;
  },
  labelColor(tooltipItem) {
    const meta = tooltipItem.chart.getDatasetMeta(tooltipItem.datasetIndex);
    const options = meta.controller.getStyle(tooltipItem.dataIndex);
    return {
      borderColor: options.borderColor,
      backgroundColor: options.backgroundColor,
      borderWidth: options.borderWidth,
      borderDash: options.borderDash,
      borderDashOffset: options.borderDashOffset,
      borderRadius: 0
    };
  },
  labelTextColor() {
    return this.options.bodyColor;
  },
  labelPointStyle(tooltipItem) {
    const meta = tooltipItem.chart.getDatasetMeta(tooltipItem.datasetIndex);
    const options = meta.controller.getStyle(tooltipItem.dataIndex);
    return {
      pointStyle: options.pointStyle,
      rotation: options.rotation
    };
  },
  afterLabel: noop,
  afterBody: noop,
  beforeFooter: noop,
  footer: noop,
  afterFooter: noop
};
function invokeCallbackWithFallback(callbacks, name, ctx, arg) {
  const result = callbacks[name].call(ctx, arg);
  if (typeof result === "undefined") {
    return defaultCallbacks[name].call(ctx, arg);
  }
  return result;
}
var Tooltip = class extends Element {
  static positioners = positioners;
  constructor(config) {
    super();
    this.opacity = 0;
    this._active = [];
    this._eventPosition = void 0;
    this._size = void 0;
    this._cachedAnimations = void 0;
    this._tooltipItems = [];
    this.$animations = void 0;
    this.$context = void 0;
    this.chart = config.chart;
    this.options = config.options;
    this.dataPoints = void 0;
    this.title = void 0;
    this.beforeBody = void 0;
    this.body = void 0;
    this.afterBody = void 0;
    this.footer = void 0;
    this.xAlign = void 0;
    this.yAlign = void 0;
    this.x = void 0;
    this.y = void 0;
    this.height = void 0;
    this.width = void 0;
    this.caretX = void 0;
    this.caretY = void 0;
    this.labelColors = void 0;
    this.labelPointStyles = void 0;
    this.labelTextColors = void 0;
  }
  initialize(options) {
    this.options = options;
    this._cachedAnimations = void 0;
    this.$context = void 0;
  }
  _resolveAnimations() {
    const cached = this._cachedAnimations;
    if (cached) {
      return cached;
    }
    const chart = this.chart;
    const options = this.options.setContext(this.getContext());
    const opts = options.enabled && chart.options.animation && options.animations;
    const animations = new Animations(this.chart, opts);
    if (opts._cacheable) {
      this._cachedAnimations = Object.freeze(animations);
    }
    return animations;
  }
  getContext() {
    return this.$context || (this.$context = createTooltipContext(this.chart.getContext(), this, this._tooltipItems));
  }
  getTitle(context, options) {
    const { callbacks } = options;
    const beforeTitle = invokeCallbackWithFallback(callbacks, "beforeTitle", this, context);
    const title = invokeCallbackWithFallback(callbacks, "title", this, context);
    const afterTitle = invokeCallbackWithFallback(callbacks, "afterTitle", this, context);
    let lines = [];
    lines = pushOrConcat(lines, splitNewlines(beforeTitle));
    lines = pushOrConcat(lines, splitNewlines(title));
    lines = pushOrConcat(lines, splitNewlines(afterTitle));
    return lines;
  }
  getBeforeBody(tooltipItems, options) {
    return getBeforeAfterBodyLines(invokeCallbackWithFallback(options.callbacks, "beforeBody", this, tooltipItems));
  }
  getBody(tooltipItems, options) {
    const { callbacks } = options;
    const bodyItems = [];
    each(tooltipItems, (context) => {
      const bodyItem = {
        before: [],
        lines: [],
        after: []
      };
      const scoped = overrideCallbacks(callbacks, context);
      pushOrConcat(bodyItem.before, splitNewlines(invokeCallbackWithFallback(scoped, "beforeLabel", this, context)));
      pushOrConcat(bodyItem.lines, invokeCallbackWithFallback(scoped, "label", this, context));
      pushOrConcat(bodyItem.after, splitNewlines(invokeCallbackWithFallback(scoped, "afterLabel", this, context)));
      bodyItems.push(bodyItem);
    });
    return bodyItems;
  }
  getAfterBody(tooltipItems, options) {
    return getBeforeAfterBodyLines(invokeCallbackWithFallback(options.callbacks, "afterBody", this, tooltipItems));
  }
  getFooter(tooltipItems, options) {
    const { callbacks } = options;
    const beforeFooter = invokeCallbackWithFallback(callbacks, "beforeFooter", this, tooltipItems);
    const footer = invokeCallbackWithFallback(callbacks, "footer", this, tooltipItems);
    const afterFooter = invokeCallbackWithFallback(callbacks, "afterFooter", this, tooltipItems);
    let lines = [];
    lines = pushOrConcat(lines, splitNewlines(beforeFooter));
    lines = pushOrConcat(lines, splitNewlines(footer));
    lines = pushOrConcat(lines, splitNewlines(afterFooter));
    return lines;
  }
  _createItems(options) {
    const active = this._active;
    const data = this.chart.data;
    const labelColors = [];
    const labelPointStyles = [];
    const labelTextColors = [];
    let tooltipItems = [];
    let i, len;
    for (i = 0, len = active.length; i < len; ++i) {
      tooltipItems.push(createTooltipItem(this.chart, active[i]));
    }
    if (options.filter) {
      tooltipItems = tooltipItems.filter((element, index2, array) => options.filter(element, index2, array, data));
    }
    if (options.itemSort) {
      tooltipItems = tooltipItems.sort((a, b) => options.itemSort(a, b, data));
    }
    each(tooltipItems, (context) => {
      const scoped = overrideCallbacks(options.callbacks, context);
      labelColors.push(invokeCallbackWithFallback(scoped, "labelColor", this, context));
      labelPointStyles.push(invokeCallbackWithFallback(scoped, "labelPointStyle", this, context));
      labelTextColors.push(invokeCallbackWithFallback(scoped, "labelTextColor", this, context));
    });
    this.labelColors = labelColors;
    this.labelPointStyles = labelPointStyles;
    this.labelTextColors = labelTextColors;
    this.dataPoints = tooltipItems;
    return tooltipItems;
  }
  update(changed, replay) {
    const options = this.options.setContext(this.getContext());
    const active = this._active;
    let properties;
    let tooltipItems = [];
    if (!active.length) {
      if (this.opacity !== 0) {
        properties = {
          opacity: 0
        };
      }
    } else {
      const position = positioners[options.position].call(this, active, this._eventPosition);
      tooltipItems = this._createItems(options);
      this.title = this.getTitle(tooltipItems, options);
      this.beforeBody = this.getBeforeBody(tooltipItems, options);
      this.body = this.getBody(tooltipItems, options);
      this.afterBody = this.getAfterBody(tooltipItems, options);
      this.footer = this.getFooter(tooltipItems, options);
      const size = this._size = getTooltipSize(this, options);
      const positionAndSize = Object.assign({}, position, size);
      const alignment = determineAlignment(this.chart, options, positionAndSize);
      const backgroundPoint = getBackgroundPoint(options, positionAndSize, alignment, this.chart);
      this.xAlign = alignment.xAlign;
      this.yAlign = alignment.yAlign;
      properties = {
        opacity: 1,
        x: backgroundPoint.x,
        y: backgroundPoint.y,
        width: size.width,
        height: size.height,
        caretX: position.x,
        caretY: position.y
      };
    }
    this._tooltipItems = tooltipItems;
    this.$context = void 0;
    if (properties) {
      this._resolveAnimations().update(this, properties);
    }
    if (changed && options.external) {
      options.external.call(this, {
        chart: this.chart,
        tooltip: this,
        replay
      });
    }
  }
  drawCaret(tooltipPoint, ctx, size, options) {
    const caretPosition = this.getCaretPosition(tooltipPoint, size, options);
    ctx.lineTo(caretPosition.x1, caretPosition.y1);
    ctx.lineTo(caretPosition.x2, caretPosition.y2);
    ctx.lineTo(caretPosition.x3, caretPosition.y3);
  }
  getCaretPosition(tooltipPoint, size, options) {
    const { xAlign, yAlign } = this;
    const { caretSize, cornerRadius } = options;
    const { topLeft, topRight, bottomLeft, bottomRight } = toTRBLCorners(cornerRadius);
    const { x: ptX, y: ptY } = tooltipPoint;
    const { width, height } = size;
    let x1, x2, x3, y1, y2, y3;
    if (yAlign === "center") {
      y2 = ptY + height / 2;
      if (xAlign === "left") {
        x1 = ptX;
        x2 = x1 - caretSize;
        y1 = y2 + caretSize;
        y3 = y2 - caretSize;
      } else {
        x1 = ptX + width;
        x2 = x1 + caretSize;
        y1 = y2 - caretSize;
        y3 = y2 + caretSize;
      }
      x3 = x1;
    } else {
      if (xAlign === "left") {
        x2 = ptX + Math.max(topLeft, bottomLeft) + caretSize;
      } else if (xAlign === "right") {
        x2 = ptX + width - Math.max(topRight, bottomRight) - caretSize;
      } else {
        x2 = this.caretX;
      }
      if (yAlign === "top") {
        y1 = ptY;
        y2 = y1 - caretSize;
        x1 = x2 - caretSize;
        x3 = x2 + caretSize;
      } else {
        y1 = ptY + height;
        y2 = y1 + caretSize;
        x1 = x2 + caretSize;
        x3 = x2 - caretSize;
      }
      y3 = y1;
    }
    return {
      x1,
      x2,
      x3,
      y1,
      y2,
      y3
    };
  }
  drawTitle(pt, ctx, options) {
    const title = this.title;
    const length = title.length;
    let titleFont, titleSpacing, i;
    if (length) {
      const rtlHelper = getRtlAdapter(options.rtl, this.x, this.width);
      pt.x = getAlignedX(this, options.titleAlign, options);
      ctx.textAlign = rtlHelper.textAlign(options.titleAlign);
      ctx.textBaseline = "middle";
      titleFont = toFont(options.titleFont);
      titleSpacing = options.titleSpacing;
      ctx.fillStyle = options.titleColor;
      ctx.font = titleFont.string;
      for (i = 0; i < length; ++i) {
        ctx.fillText(title[i], rtlHelper.x(pt.x), pt.y + titleFont.lineHeight / 2);
        pt.y += titleFont.lineHeight + titleSpacing;
        if (i + 1 === length) {
          pt.y += options.titleMarginBottom - titleSpacing;
        }
      }
    }
  }
  _drawColorBox(ctx, pt, i, rtlHelper, options) {
    const labelColor = this.labelColors[i];
    const labelPointStyle = this.labelPointStyles[i];
    const { boxHeight, boxWidth } = options;
    const bodyFont = toFont(options.bodyFont);
    const colorX = getAlignedX(this, "left", options);
    const rtlColorX = rtlHelper.x(colorX);
    const yOffSet = boxHeight < bodyFont.lineHeight ? (bodyFont.lineHeight - boxHeight) / 2 : 0;
    const colorY = pt.y + yOffSet;
    if (options.usePointStyle) {
      const drawOptions = {
        radius: Math.min(boxWidth, boxHeight) / 2,
        pointStyle: labelPointStyle.pointStyle,
        rotation: labelPointStyle.rotation,
        borderWidth: 1
      };
      const centerX = rtlHelper.leftForLtr(rtlColorX, boxWidth) + boxWidth / 2;
      const centerY = colorY + boxHeight / 2;
      ctx.strokeStyle = options.multiKeyBackground;
      ctx.fillStyle = options.multiKeyBackground;
      drawPoint(ctx, drawOptions, centerX, centerY);
      ctx.strokeStyle = labelColor.borderColor;
      ctx.fillStyle = labelColor.backgroundColor;
      drawPoint(ctx, drawOptions, centerX, centerY);
    } else {
      ctx.lineWidth = isObject(labelColor.borderWidth) ? Math.max(...Object.values(labelColor.borderWidth)) : labelColor.borderWidth || 1;
      ctx.strokeStyle = labelColor.borderColor;
      ctx.setLineDash(labelColor.borderDash || []);
      ctx.lineDashOffset = labelColor.borderDashOffset || 0;
      const outerX = rtlHelper.leftForLtr(rtlColorX, boxWidth);
      const innerX = rtlHelper.leftForLtr(rtlHelper.xPlus(rtlColorX, 1), boxWidth - 2);
      const borderRadius = toTRBLCorners(labelColor.borderRadius);
      if (Object.values(borderRadius).some((v) => v !== 0)) {
        ctx.beginPath();
        ctx.fillStyle = options.multiKeyBackground;
        addRoundedRectPath(ctx, {
          x: outerX,
          y: colorY,
          w: boxWidth,
          h: boxHeight,
          radius: borderRadius
        });
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = labelColor.backgroundColor;
        ctx.beginPath();
        addRoundedRectPath(ctx, {
          x: innerX,
          y: colorY + 1,
          w: boxWidth - 2,
          h: boxHeight - 2,
          radius: borderRadius
        });
        ctx.fill();
      } else {
        ctx.fillStyle = options.multiKeyBackground;
        ctx.fillRect(outerX, colorY, boxWidth, boxHeight);
        ctx.strokeRect(outerX, colorY, boxWidth, boxHeight);
        ctx.fillStyle = labelColor.backgroundColor;
        ctx.fillRect(innerX, colorY + 1, boxWidth - 2, boxHeight - 2);
      }
    }
    ctx.fillStyle = this.labelTextColors[i];
  }
  drawBody(pt, ctx, options) {
    const { body } = this;
    const { bodySpacing, bodyAlign, displayColors, boxHeight, boxWidth, boxPadding } = options;
    const bodyFont = toFont(options.bodyFont);
    let bodyLineHeight = bodyFont.lineHeight;
    let xLinePadding = 0;
    const rtlHelper = getRtlAdapter(options.rtl, this.x, this.width);
    const fillLineOfText = function(line) {
      ctx.fillText(line, rtlHelper.x(pt.x + xLinePadding), pt.y + bodyLineHeight / 2);
      pt.y += bodyLineHeight + bodySpacing;
    };
    const bodyAlignForCalculation = rtlHelper.textAlign(bodyAlign);
    let bodyItem, textColor, lines, i, j, ilen, jlen;
    ctx.textAlign = bodyAlign;
    ctx.textBaseline = "middle";
    ctx.font = bodyFont.string;
    pt.x = getAlignedX(this, bodyAlignForCalculation, options);
    ctx.fillStyle = options.bodyColor;
    each(this.beforeBody, fillLineOfText);
    xLinePadding = displayColors && bodyAlignForCalculation !== "right" ? bodyAlign === "center" ? boxWidth / 2 + boxPadding : boxWidth + 2 + boxPadding : 0;
    for (i = 0, ilen = body.length; i < ilen; ++i) {
      bodyItem = body[i];
      textColor = this.labelTextColors[i];
      ctx.fillStyle = textColor;
      each(bodyItem.before, fillLineOfText);
      lines = bodyItem.lines;
      if (displayColors && lines.length) {
        this._drawColorBox(ctx, pt, i, rtlHelper, options);
        bodyLineHeight = Math.max(bodyFont.lineHeight, boxHeight);
      }
      for (j = 0, jlen = lines.length; j < jlen; ++j) {
        fillLineOfText(lines[j]);
        bodyLineHeight = bodyFont.lineHeight;
      }
      each(bodyItem.after, fillLineOfText);
    }
    xLinePadding = 0;
    bodyLineHeight = bodyFont.lineHeight;
    each(this.afterBody, fillLineOfText);
    pt.y -= bodySpacing;
  }
  drawFooter(pt, ctx, options) {
    const footer = this.footer;
    const length = footer.length;
    let footerFont, i;
    if (length) {
      const rtlHelper = getRtlAdapter(options.rtl, this.x, this.width);
      pt.x = getAlignedX(this, options.footerAlign, options);
      pt.y += options.footerMarginTop;
      ctx.textAlign = rtlHelper.textAlign(options.footerAlign);
      ctx.textBaseline = "middle";
      footerFont = toFont(options.footerFont);
      ctx.fillStyle = options.footerColor;
      ctx.font = footerFont.string;
      for (i = 0; i < length; ++i) {
        ctx.fillText(footer[i], rtlHelper.x(pt.x), pt.y + footerFont.lineHeight / 2);
        pt.y += footerFont.lineHeight + options.footerSpacing;
      }
    }
  }
  drawBackground(pt, ctx, tooltipSize, options) {
    const { xAlign, yAlign } = this;
    const { x, y } = pt;
    const { width, height } = tooltipSize;
    const { topLeft, topRight, bottomLeft, bottomRight } = toTRBLCorners(options.cornerRadius);
    ctx.fillStyle = options.backgroundColor;
    ctx.strokeStyle = options.borderColor;
    ctx.lineWidth = options.borderWidth;
    ctx.beginPath();
    ctx.moveTo(x + topLeft, y);
    if (yAlign === "top") {
      this.drawCaret(pt, ctx, tooltipSize, options);
    }
    ctx.lineTo(x + width - topRight, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + topRight);
    if (yAlign === "center" && xAlign === "right") {
      this.drawCaret(pt, ctx, tooltipSize, options);
    }
    ctx.lineTo(x + width, y + height - bottomRight);
    ctx.quadraticCurveTo(x + width, y + height, x + width - bottomRight, y + height);
    if (yAlign === "bottom") {
      this.drawCaret(pt, ctx, tooltipSize, options);
    }
    ctx.lineTo(x + bottomLeft, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - bottomLeft);
    if (yAlign === "center" && xAlign === "left") {
      this.drawCaret(pt, ctx, tooltipSize, options);
    }
    ctx.lineTo(x, y + topLeft);
    ctx.quadraticCurveTo(x, y, x + topLeft, y);
    ctx.closePath();
    ctx.fill();
    if (options.borderWidth > 0) {
      ctx.stroke();
    }
  }
  _updateAnimationTarget(options) {
    const chart = this.chart;
    const anims = this.$animations;
    const animX = anims && anims.x;
    const animY = anims && anims.y;
    if (animX || animY) {
      const position = positioners[options.position].call(this, this._active, this._eventPosition);
      if (!position) {
        return;
      }
      const size = this._size = getTooltipSize(this, options);
      const positionAndSize = Object.assign({}, position, this._size);
      const alignment = determineAlignment(chart, options, positionAndSize);
      const point = getBackgroundPoint(options, positionAndSize, alignment, chart);
      if (animX._to !== point.x || animY._to !== point.y) {
        this.xAlign = alignment.xAlign;
        this.yAlign = alignment.yAlign;
        this.width = size.width;
        this.height = size.height;
        this.caretX = position.x;
        this.caretY = position.y;
        this._resolveAnimations().update(this, point);
      }
    }
  }
  _willRender() {
    return !!this.opacity;
  }
  draw(ctx) {
    const options = this.options.setContext(this.getContext());
    let opacity = this.opacity;
    if (!opacity) {
      return;
    }
    this._updateAnimationTarget(options);
    const tooltipSize = {
      width: this.width,
      height: this.height
    };
    const pt = {
      x: this.x,
      y: this.y
    };
    opacity = Math.abs(opacity) < 1e-3 ? 0 : opacity;
    const padding = toPadding(options.padding);
    const hasTooltipContent = this.title.length || this.beforeBody.length || this.body.length || this.afterBody.length || this.footer.length;
    if (options.enabled && hasTooltipContent) {
      ctx.save();
      ctx.globalAlpha = opacity;
      this.drawBackground(pt, ctx, tooltipSize, options);
      overrideTextDirection(ctx, options.textDirection);
      pt.y += padding.top;
      this.drawTitle(pt, ctx, options);
      this.drawBody(pt, ctx, options);
      this.drawFooter(pt, ctx, options);
      restoreTextDirection(ctx, options.textDirection);
      ctx.restore();
    }
  }
  getActiveElements() {
    return this._active || [];
  }
  setActiveElements(activeElements, eventPosition) {
    const lastActive = this._active;
    const active = activeElements.map(({ datasetIndex, index: index2 }) => {
      const meta = this.chart.getDatasetMeta(datasetIndex);
      if (!meta) {
        throw new Error("Cannot find a dataset at index " + datasetIndex);
      }
      return {
        datasetIndex,
        element: meta.data[index2],
        index: index2
      };
    });
    const changed = !_elementsEqual(lastActive, active);
    const positionChanged = this._positionChanged(active, eventPosition);
    if (changed || positionChanged) {
      this._active = active;
      this._eventPosition = eventPosition;
      this._ignoreReplayEvents = true;
      this.update(true);
    }
  }
  handleEvent(e, replay, inChartArea = true) {
    if (replay && this._ignoreReplayEvents) {
      return false;
    }
    this._ignoreReplayEvents = false;
    const options = this.options;
    const lastActive = this._active || [];
    const active = this._getActiveElements(e, lastActive, replay, inChartArea);
    const positionChanged = this._positionChanged(active, e);
    const changed = replay || !_elementsEqual(active, lastActive) || positionChanged;
    if (changed) {
      this._active = active;
      if (options.enabled || options.external) {
        this._eventPosition = {
          x: e.x,
          y: e.y
        };
        this.update(true, replay);
      }
    }
    return changed;
  }
  _getActiveElements(e, lastActive, replay, inChartArea) {
    const options = this.options;
    if (e.type === "mouseout") {
      return [];
    }
    if (!inChartArea) {
      return lastActive.filter((i) => this.chart.data.datasets[i.datasetIndex] && this.chart.getDatasetMeta(i.datasetIndex).controller.getParsed(i.index) !== void 0);
    }
    const active = this.chart.getElementsAtEventForMode(e, options.mode, options, replay);
    if (options.reverse) {
      active.reverse();
    }
    return active;
  }
  _positionChanged(active, e) {
    const { caretX, caretY, options } = this;
    const position = positioners[options.position].call(this, active, e);
    return position !== false && (caretX !== position.x || caretY !== position.y);
  }
};
var plugin_tooltip = {
  id: "tooltip",
  _element: Tooltip,
  positioners,
  afterInit(chart, _args, options) {
    if (options) {
      chart.tooltip = new Tooltip({
        chart,
        options
      });
    }
  },
  beforeUpdate(chart, _args, options) {
    if (chart.tooltip) {
      chart.tooltip.initialize(options);
    }
  },
  reset(chart, _args, options) {
    if (chart.tooltip) {
      chart.tooltip.initialize(options);
    }
  },
  afterDraw(chart) {
    const tooltip = chart.tooltip;
    if (tooltip && tooltip._willRender()) {
      const args = {
        tooltip
      };
      if (chart.notifyPlugins("beforeTooltipDraw", {
        ...args,
        cancelable: true
      }) === false) {
        return;
      }
      tooltip.draw(chart.ctx);
      chart.notifyPlugins("afterTooltipDraw", args);
    }
  },
  afterEvent(chart, args) {
    if (chart.tooltip) {
      const useFinalPosition = args.replay;
      if (chart.tooltip.handleEvent(args.event, useFinalPosition, args.inChartArea)) {
        args.changed = true;
      }
    }
  },
  defaults: {
    enabled: true,
    external: null,
    position: "average",
    backgroundColor: "rgba(0,0,0,0.8)",
    titleColor: "#fff",
    titleFont: {
      weight: "bold"
    },
    titleSpacing: 2,
    titleMarginBottom: 6,
    titleAlign: "left",
    bodyColor: "#fff",
    bodySpacing: 2,
    bodyFont: {},
    bodyAlign: "left",
    footerColor: "#fff",
    footerSpacing: 2,
    footerMarginTop: 6,
    footerFont: {
      weight: "bold"
    },
    footerAlign: "left",
    padding: 6,
    caretPadding: 2,
    caretSize: 5,
    cornerRadius: 6,
    boxHeight: (ctx, opts) => opts.bodyFont.size,
    boxWidth: (ctx, opts) => opts.bodyFont.size,
    multiKeyBackground: "#fff",
    displayColors: true,
    boxPadding: 0,
    borderColor: "rgba(0,0,0,0)",
    borderWidth: 0,
    animation: {
      duration: 400,
      easing: "easeOutQuart"
    },
    animations: {
      numbers: {
        type: "number",
        properties: [
          "x",
          "y",
          "width",
          "height",
          "caretX",
          "caretY"
        ]
      },
      opacity: {
        easing: "linear",
        duration: 200
      }
    },
    callbacks: defaultCallbacks
  },
  defaultRoutes: {
    bodyFont: "font",
    footerFont: "font",
    titleFont: "font"
  },
  descriptors: {
    _scriptable: (name) => name !== "filter" && name !== "itemSort" && name !== "external",
    _indexable: false,
    callbacks: {
      _scriptable: false,
      _indexable: false
    },
    animation: {
      _fallback: false
    },
    animations: {
      _fallback: "animation"
    }
  },
  additionalOptionScopes: [
    "interaction"
  ]
};
var plugins = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  Colors: plugin_colors,
  Decimation: plugin_decimation,
  Filler: index,
  Legend: plugin_legend,
  SubTitle: plugin_subtitle,
  Title: plugin_title,
  Tooltip: plugin_tooltip
});
var addIfString = (labels, raw, index2, addedLabels) => {
  if (typeof raw === "string") {
    index2 = labels.push(raw) - 1;
    addedLabels.unshift({
      index: index2,
      label: raw
    });
  } else if (isNaN(raw)) {
    index2 = null;
  }
  return index2;
};
function findOrAddLabel(labels, raw, index2, addedLabels) {
  const first = labels.indexOf(raw);
  if (first === -1) {
    return addIfString(labels, raw, index2, addedLabels);
  }
  const last = labels.lastIndexOf(raw);
  return first !== last ? index2 : first;
}
var validIndex = (index2, max) => index2 === null ? null : _limitValue(Math.round(index2), 0, max);
function _getLabelForValue(value) {
  const labels = this.getLabels();
  if (value >= 0 && value < labels.length) {
    return labels[value];
  }
  return value;
}
var CategoryScale = class extends Scale {
  static id = "category";
  static defaults = {
    ticks: {
      callback: _getLabelForValue
    }
  };
  constructor(cfg) {
    super(cfg);
    this._startValue = void 0;
    this._valueRange = 0;
    this._addedLabels = [];
  }
  init(scaleOptions) {
    const added = this._addedLabels;
    if (added.length) {
      const labels = this.getLabels();
      for (const { index: index2, label } of added) {
        if (labels[index2] === label) {
          labels.splice(index2, 1);
        }
      }
      this._addedLabels = [];
    }
    super.init(scaleOptions);
  }
  parse(raw, index2) {
    if (isNullOrUndef(raw)) {
      return null;
    }
    const labels = this.getLabels();
    index2 = isFinite(index2) && labels[index2] === raw ? index2 : findOrAddLabel(labels, raw, valueOrDefault(index2, raw), this._addedLabels);
    return validIndex(index2, labels.length - 1);
  }
  determineDataLimits() {
    const { minDefined, maxDefined } = this.getUserBounds();
    let { min, max } = this.getMinMax(true);
    if (this.options.bounds === "ticks") {
      if (!minDefined) {
        min = 0;
      }
      if (!maxDefined) {
        max = this.getLabels().length - 1;
      }
    }
    this.min = min;
    this.max = max;
  }
  buildTicks() {
    const min = this.min;
    const max = this.max;
    const offset = this.options.offset;
    const ticks = [];
    let labels = this.getLabels();
    labels = min === 0 && max === labels.length - 1 ? labels : labels.slice(min, max + 1);
    this._valueRange = Math.max(labels.length - (offset ? 0 : 1), 1);
    this._startValue = this.min - (offset ? 0.5 : 0);
    for (let value = min; value <= max; value++) {
      ticks.push({
        value
      });
    }
    return ticks;
  }
  getLabelForValue(value) {
    return _getLabelForValue.call(this, value);
  }
  configure() {
    super.configure();
    if (!this.isHorizontal()) {
      this._reversePixels = !this._reversePixels;
    }
  }
  getPixelForValue(value) {
    if (typeof value !== "number") {
      value = this.parse(value);
    }
    return value === null ? NaN : this.getPixelForDecimal((value - this._startValue) / this._valueRange);
  }
  getPixelForTick(index2) {
    const ticks = this.ticks;
    if (index2 < 0 || index2 > ticks.length - 1) {
      return null;
    }
    return this.getPixelForValue(ticks[index2].value);
  }
  getValueForPixel(pixel) {
    return Math.round(this._startValue + this.getDecimalForPixel(pixel) * this._valueRange);
  }
  getBasePixel() {
    return this.bottom;
  }
};
function generateTicks$1(generationOptions, dataRange) {
  const ticks = [];
  const MIN_SPACING = 1e-14;
  const { bounds, step, min, max, precision, count, maxTicks, maxDigits, includeBounds } = generationOptions;
  const unit = step || 1;
  const maxSpaces = maxTicks - 1;
  const { min: rmin, max: rmax } = dataRange;
  const minDefined = !isNullOrUndef(min);
  const maxDefined = !isNullOrUndef(max);
  const countDefined = !isNullOrUndef(count);
  const minSpacing = (rmax - rmin) / (maxDigits + 1);
  let spacing = niceNum((rmax - rmin) / maxSpaces / unit) * unit;
  let factor, niceMin, niceMax, numSpaces;
  if (spacing < MIN_SPACING && !minDefined && !maxDefined) {
    return [
      {
        value: rmin
      },
      {
        value: rmax
      }
    ];
  }
  numSpaces = Math.ceil(rmax / spacing) - Math.floor(rmin / spacing);
  if (numSpaces > maxSpaces) {
    spacing = niceNum(numSpaces * spacing / maxSpaces / unit) * unit;
  }
  if (!isNullOrUndef(precision)) {
    factor = Math.pow(10, precision);
    spacing = Math.ceil(spacing * factor) / factor;
  }
  if (bounds === "ticks") {
    niceMin = Math.floor(rmin / spacing) * spacing;
    niceMax = Math.ceil(rmax / spacing) * spacing;
  } else {
    niceMin = rmin;
    niceMax = rmax;
  }
  if (minDefined && maxDefined && step && almostWhole((max - min) / step, spacing / 1e3)) {
    numSpaces = Math.round(Math.min((max - min) / spacing, maxTicks));
    spacing = (max - min) / numSpaces;
    niceMin = min;
    niceMax = max;
  } else if (countDefined) {
    niceMin = minDefined ? min : niceMin;
    niceMax = maxDefined ? max : niceMax;
    numSpaces = count - 1;
    spacing = (niceMax - niceMin) / numSpaces;
  } else {
    numSpaces = (niceMax - niceMin) / spacing;
    if (almostEquals(numSpaces, Math.round(numSpaces), spacing / 1e3)) {
      numSpaces = Math.round(numSpaces);
    } else {
      numSpaces = Math.ceil(numSpaces);
    }
  }
  const decimalPlaces = Math.max(_decimalPlaces(spacing), _decimalPlaces(niceMin));
  factor = Math.pow(10, isNullOrUndef(precision) ? decimalPlaces : precision);
  niceMin = Math.round(niceMin * factor) / factor;
  niceMax = Math.round(niceMax * factor) / factor;
  let j = 0;
  if (minDefined) {
    if (includeBounds && niceMin !== min) {
      ticks.push({
        value: min
      });
      if (niceMin < min) {
        j++;
      }
      if (almostEquals(Math.round((niceMin + j * spacing) * factor) / factor, min, relativeLabelSize(min, minSpacing, generationOptions))) {
        j++;
      }
    } else if (niceMin < min) {
      j++;
    }
  }
  for (; j < numSpaces; ++j) {
    const tickValue = Math.round((niceMin + j * spacing) * factor) / factor;
    if (maxDefined && tickValue > max) {
      break;
    }
    ticks.push({
      value: tickValue
    });
  }
  if (maxDefined && includeBounds && niceMax !== max) {
    if (ticks.length && almostEquals(ticks[ticks.length - 1].value, max, relativeLabelSize(max, minSpacing, generationOptions))) {
      ticks[ticks.length - 1].value = max;
    } else {
      ticks.push({
        value: max
      });
    }
  } else if (!maxDefined || niceMax === max) {
    ticks.push({
      value: niceMax
    });
  }
  return ticks;
}
function relativeLabelSize(value, minSpacing, { horizontal, minRotation }) {
  const rad = toRadians(minRotation);
  const ratio = (horizontal ? Math.sin(rad) : Math.cos(rad)) || 1e-3;
  const length = 0.75 * minSpacing * ("" + value).length;
  return Math.min(minSpacing / ratio, length);
}
var LinearScaleBase = class extends Scale {
  constructor(cfg) {
    super(cfg);
    this.start = void 0;
    this.end = void 0;
    this._startValue = void 0;
    this._endValue = void 0;
    this._valueRange = 0;
  }
  parse(raw, index2) {
    if (isNullOrUndef(raw)) {
      return null;
    }
    if ((typeof raw === "number" || raw instanceof Number) && !isFinite(+raw)) {
      return null;
    }
    return +raw;
  }
  handleTickRangeOptions() {
    const { beginAtZero } = this.options;
    const { minDefined, maxDefined } = this.getUserBounds();
    let { min, max } = this;
    const setMin = (v) => min = minDefined ? min : v;
    const setMax = (v) => max = maxDefined ? max : v;
    if (beginAtZero) {
      const minSign = sign(min);
      const maxSign = sign(max);
      if (minSign < 0 && maxSign < 0) {
        setMax(0);
      } else if (minSign > 0 && maxSign > 0) {
        setMin(0);
      }
    }
    if (min === max) {
      let offset = max === 0 ? 1 : Math.abs(max * 0.05);
      setMax(max + offset);
      if (!beginAtZero) {
        setMin(min - offset);
      }
    }
    this.min = min;
    this.max = max;
  }
  getTickLimit() {
    const tickOpts = this.options.ticks;
    let { maxTicksLimit, stepSize } = tickOpts;
    let maxTicks;
    if (stepSize) {
      maxTicks = Math.ceil(this.max / stepSize) - Math.floor(this.min / stepSize) + 1;
      if (maxTicks > 1e3) {
        console.warn(`scales.${this.id}.ticks.stepSize: ${stepSize} would result generating up to ${maxTicks} ticks. Limiting to 1000.`);
        maxTicks = 1e3;
      }
    } else {
      maxTicks = this.computeTickLimit();
      maxTicksLimit = maxTicksLimit || 11;
    }
    if (maxTicksLimit) {
      maxTicks = Math.min(maxTicksLimit, maxTicks);
    }
    return maxTicks;
  }
  computeTickLimit() {
    return Number.POSITIVE_INFINITY;
  }
  buildTicks() {
    const opts = this.options;
    const tickOpts = opts.ticks;
    let maxTicks = this.getTickLimit();
    maxTicks = Math.max(2, maxTicks);
    const numericGeneratorOptions = {
      maxTicks,
      bounds: opts.bounds,
      min: opts.min,
      max: opts.max,
      precision: tickOpts.precision,
      step: tickOpts.stepSize,
      count: tickOpts.count,
      maxDigits: this._maxDigits(),
      horizontal: this.isHorizontal(),
      minRotation: tickOpts.minRotation || 0,
      includeBounds: tickOpts.includeBounds !== false
    };
    const dataRange = this._range || this;
    const ticks = generateTicks$1(numericGeneratorOptions, dataRange);
    if (opts.bounds === "ticks") {
      _setMinAndMaxByKey(ticks, this, "value");
    }
    if (opts.reverse) {
      ticks.reverse();
      this.start = this.max;
      this.end = this.min;
    } else {
      this.start = this.min;
      this.end = this.max;
    }
    return ticks;
  }
  configure() {
    const ticks = this.ticks;
    let start = this.min;
    let end = this.max;
    super.configure();
    if (this.options.offset && ticks.length) {
      const offset = (end - start) / Math.max(ticks.length - 1, 1) / 2;
      start -= offset;
      end += offset;
    }
    this._startValue = start;
    this._endValue = end;
    this._valueRange = end - start;
  }
  getLabelForValue(value) {
    return formatNumber(value, this.chart.options.locale, this.options.ticks.format);
  }
};
var LinearScale = class extends LinearScaleBase {
  static id = "linear";
  static defaults = {
    ticks: {
      callback: Ticks.formatters.numeric
    }
  };
  determineDataLimits() {
    const { min, max } = this.getMinMax(true);
    this.min = isNumberFinite(min) ? min : 0;
    this.max = isNumberFinite(max) ? max : 1;
    this.handleTickRangeOptions();
  }
  computeTickLimit() {
    const horizontal = this.isHorizontal();
    const length = horizontal ? this.width : this.height;
    const minRotation = toRadians(this.options.ticks.minRotation);
    const ratio = (horizontal ? Math.sin(minRotation) : Math.cos(minRotation)) || 1e-3;
    const tickFont = this._resolveTickFontOptions(0);
    return Math.ceil(length / Math.min(40, tickFont.lineHeight / ratio));
  }
  getPixelForValue(value) {
    return value === null ? NaN : this.getPixelForDecimal((value - this._startValue) / this._valueRange);
  }
  getValueForPixel(pixel) {
    return this._startValue + this.getDecimalForPixel(pixel) * this._valueRange;
  }
};
var log10Floor = (v) => Math.floor(log10(v));
var changeExponent = (v, m) => Math.pow(10, log10Floor(v) + m);
function isMajor(tickVal) {
  const remain = tickVal / Math.pow(10, log10Floor(tickVal));
  return remain === 1;
}
function steps(min, max, rangeExp) {
  const rangeStep = Math.pow(10, rangeExp);
  const start = Math.floor(min / rangeStep);
  const end = Math.ceil(max / rangeStep);
  return end - start;
}
function startExp(min, max) {
  const range = max - min;
  let rangeExp = log10Floor(range);
  while (steps(min, max, rangeExp) > 10) {
    rangeExp++;
  }
  while (steps(min, max, rangeExp) < 10) {
    rangeExp--;
  }
  return Math.min(rangeExp, log10Floor(min));
}
function generateTicks(generationOptions, { min, max }) {
  min = finiteOrDefault(generationOptions.min, min);
  const ticks = [];
  const minExp = log10Floor(min);
  let exp = startExp(min, max);
  let precision = exp < 0 ? Math.pow(10, Math.abs(exp)) : 1;
  const stepSize = Math.pow(10, exp);
  const base = minExp > exp ? Math.pow(10, minExp) : 0;
  const start = Math.round((min - base) * precision) / precision;
  const offset = Math.floor((min - base) / stepSize / 10) * stepSize * 10;
  let significand = Math.floor((start - offset) / Math.pow(10, exp));
  let value = finiteOrDefault(generationOptions.min, Math.round((base + offset + significand * Math.pow(10, exp)) * precision) / precision);
  while (value < max) {
    ticks.push({
      value,
      major: isMajor(value),
      significand
    });
    if (significand >= 10) {
      significand = significand < 15 ? 15 : 20;
    } else {
      significand++;
    }
    if (significand >= 20) {
      exp++;
      significand = 2;
      precision = exp >= 0 ? 1 : precision;
    }
    value = Math.round((base + offset + significand * Math.pow(10, exp)) * precision) / precision;
  }
  const lastTick = finiteOrDefault(generationOptions.max, value);
  ticks.push({
    value: lastTick,
    major: isMajor(lastTick),
    significand
  });
  return ticks;
}
var LogarithmicScale = class extends Scale {
  static id = "logarithmic";
  static defaults = {
    ticks: {
      callback: Ticks.formatters.logarithmic,
      major: {
        enabled: true
      }
    }
  };
  constructor(cfg) {
    super(cfg);
    this.start = void 0;
    this.end = void 0;
    this._startValue = void 0;
    this._valueRange = 0;
  }
  parse(raw, index2) {
    const value = LinearScaleBase.prototype.parse.apply(this, [
      raw,
      index2
    ]);
    if (value === 0) {
      this._zero = true;
      return void 0;
    }
    return isNumberFinite(value) && value > 0 ? value : null;
  }
  determineDataLimits() {
    const { min, max } = this.getMinMax(true);
    this.min = isNumberFinite(min) ? Math.max(0, min) : null;
    this.max = isNumberFinite(max) ? Math.max(0, max) : null;
    if (this.options.beginAtZero) {
      this._zero = true;
    }
    if (this._zero && this.min !== this._suggestedMin && !isNumberFinite(this._userMin)) {
      this.min = min === changeExponent(this.min, 0) ? changeExponent(this.min, -1) : changeExponent(this.min, 0);
    }
    this.handleTickRangeOptions();
  }
  handleTickRangeOptions() {
    const { minDefined, maxDefined } = this.getUserBounds();
    let min = this.min;
    let max = this.max;
    const setMin = (v) => min = minDefined ? min : v;
    const setMax = (v) => max = maxDefined ? max : v;
    if (min === max) {
      if (min <= 0) {
        setMin(1);
        setMax(10);
      } else {
        setMin(changeExponent(min, -1));
        setMax(changeExponent(max, 1));
      }
    }
    if (min <= 0) {
      setMin(changeExponent(max, -1));
    }
    if (max <= 0) {
      setMax(changeExponent(min, 1));
    }
    this.min = min;
    this.max = max;
  }
  buildTicks() {
    const opts = this.options;
    const generationOptions = {
      min: this._userMin,
      max: this._userMax
    };
    const ticks = generateTicks(generationOptions, this);
    if (opts.bounds === "ticks") {
      _setMinAndMaxByKey(ticks, this, "value");
    }
    if (opts.reverse) {
      ticks.reverse();
      this.start = this.max;
      this.end = this.min;
    } else {
      this.start = this.min;
      this.end = this.max;
    }
    return ticks;
  }
  getLabelForValue(value) {
    return value === void 0 ? "0" : formatNumber(value, this.chart.options.locale, this.options.ticks.format);
  }
  configure() {
    const start = this.min;
    super.configure();
    this._startValue = log10(start);
    this._valueRange = log10(this.max) - log10(start);
  }
  getPixelForValue(value) {
    if (value === void 0 || value === 0) {
      value = this.min;
    }
    if (value === null || isNaN(value)) {
      return NaN;
    }
    return this.getPixelForDecimal(value === this.min ? 0 : (log10(value) - this._startValue) / this._valueRange);
  }
  getValueForPixel(pixel) {
    const decimal = this.getDecimalForPixel(pixel);
    return Math.pow(10, this._startValue + decimal * this._valueRange);
  }
};
function getTickBackdropHeight(opts) {
  const tickOpts = opts.ticks;
  if (tickOpts.display && opts.display) {
    const padding = toPadding(tickOpts.backdropPadding);
    return valueOrDefault(tickOpts.font && tickOpts.font.size, defaults.font.size) + padding.height;
  }
  return 0;
}
function measureLabelSize(ctx, font, label) {
  label = isArray(label) ? label : [
    label
  ];
  return {
    w: _longestText(ctx, font.string, label),
    h: label.length * font.lineHeight
  };
}
function determineLimits(angle, pos, size, min, max) {
  if (angle === min || angle === max) {
    return {
      start: pos - size / 2,
      end: pos + size / 2
    };
  } else if (angle < min || angle > max) {
    return {
      start: pos - size,
      end: pos
    };
  }
  return {
    start: pos,
    end: pos + size
  };
}
function fitWithPointLabels(scale) {
  const orig = {
    l: scale.left + scale._padding.left,
    r: scale.right - scale._padding.right,
    t: scale.top + scale._padding.top,
    b: scale.bottom - scale._padding.bottom
  };
  const limits = Object.assign({}, orig);
  const labelSizes = [];
  const padding = [];
  const valueCount = scale._pointLabels.length;
  const pointLabelOpts = scale.options.pointLabels;
  const additionalAngle = pointLabelOpts.centerPointLabels ? PI / valueCount : 0;
  for (let i = 0; i < valueCount; i++) {
    const opts = pointLabelOpts.setContext(scale.getPointLabelContext(i));
    padding[i] = opts.padding;
    const pointPosition = scale.getPointPosition(i, scale.drawingArea + padding[i], additionalAngle);
    const plFont = toFont(opts.font);
    const textSize = measureLabelSize(scale.ctx, plFont, scale._pointLabels[i]);
    labelSizes[i] = textSize;
    const angleRadians = _normalizeAngle(scale.getIndexAngle(i) + additionalAngle);
    const angle = Math.round(toDegrees(angleRadians));
    const hLimits = determineLimits(angle, pointPosition.x, textSize.w, 0, 180);
    const vLimits = determineLimits(angle, pointPosition.y, textSize.h, 90, 270);
    updateLimits(limits, orig, angleRadians, hLimits, vLimits);
  }
  scale.setCenterPoint(orig.l - limits.l, limits.r - orig.r, orig.t - limits.t, limits.b - orig.b);
  scale._pointLabelItems = buildPointLabelItems(scale, labelSizes, padding);
}
function updateLimits(limits, orig, angle, hLimits, vLimits) {
  const sin = Math.abs(Math.sin(angle));
  const cos = Math.abs(Math.cos(angle));
  let x = 0;
  let y = 0;
  if (hLimits.start < orig.l) {
    x = (orig.l - hLimits.start) / sin;
    limits.l = Math.min(limits.l, orig.l - x);
  } else if (hLimits.end > orig.r) {
    x = (hLimits.end - orig.r) / sin;
    limits.r = Math.max(limits.r, orig.r + x);
  }
  if (vLimits.start < orig.t) {
    y = (orig.t - vLimits.start) / cos;
    limits.t = Math.min(limits.t, orig.t - y);
  } else if (vLimits.end > orig.b) {
    y = (vLimits.end - orig.b) / cos;
    limits.b = Math.max(limits.b, orig.b + y);
  }
}
function createPointLabelItem(scale, index2, itemOpts) {
  const outerDistance = scale.drawingArea;
  const { extra, additionalAngle, padding, size } = itemOpts;
  const pointLabelPosition = scale.getPointPosition(index2, outerDistance + extra + padding, additionalAngle);
  const angle = Math.round(toDegrees(_normalizeAngle(pointLabelPosition.angle + HALF_PI)));
  const y = yForAngle(pointLabelPosition.y, size.h, angle);
  const textAlign = getTextAlignForAngle(angle);
  const left = leftForTextAlign(pointLabelPosition.x, size.w, textAlign);
  return {
    visible: true,
    x: pointLabelPosition.x,
    y,
    textAlign,
    left,
    top: y,
    right: left + size.w,
    bottom: y + size.h
  };
}
function isNotOverlapped(item, area) {
  if (!area) {
    return true;
  }
  const { left, top, right, bottom } = item;
  const apexesInArea = _isPointInArea({
    x: left,
    y: top
  }, area) || _isPointInArea({
    x: left,
    y: bottom
  }, area) || _isPointInArea({
    x: right,
    y: top
  }, area) || _isPointInArea({
    x: right,
    y: bottom
  }, area);
  return !apexesInArea;
}
function buildPointLabelItems(scale, labelSizes, padding) {
  const items = [];
  const valueCount = scale._pointLabels.length;
  const opts = scale.options;
  const { centerPointLabels, display } = opts.pointLabels;
  const itemOpts = {
    extra: getTickBackdropHeight(opts) / 2,
    additionalAngle: centerPointLabels ? PI / valueCount : 0
  };
  let area;
  for (let i = 0; i < valueCount; i++) {
    itemOpts.padding = padding[i];
    itemOpts.size = labelSizes[i];
    const item = createPointLabelItem(scale, i, itemOpts);
    items.push(item);
    if (display === "auto") {
      item.visible = isNotOverlapped(item, area);
      if (item.visible) {
        area = item;
      }
    }
  }
  return items;
}
function getTextAlignForAngle(angle) {
  if (angle === 0 || angle === 180) {
    return "center";
  } else if (angle < 180) {
    return "left";
  }
  return "right";
}
function leftForTextAlign(x, w, align) {
  if (align === "right") {
    x -= w;
  } else if (align === "center") {
    x -= w / 2;
  }
  return x;
}
function yForAngle(y, h4, angle) {
  if (angle === 90 || angle === 270) {
    y -= h4 / 2;
  } else if (angle > 270 || angle < 90) {
    y -= h4;
  }
  return y;
}
function drawPointLabelBox(ctx, opts, item) {
  const { left, top, right, bottom } = item;
  const { backdropColor } = opts;
  if (!isNullOrUndef(backdropColor)) {
    const borderRadius = toTRBLCorners(opts.borderRadius);
    const padding = toPadding(opts.backdropPadding);
    ctx.fillStyle = backdropColor;
    const backdropLeft = left - padding.left;
    const backdropTop = top - padding.top;
    const backdropWidth = right - left + padding.width;
    const backdropHeight = bottom - top + padding.height;
    if (Object.values(borderRadius).some((v) => v !== 0)) {
      ctx.beginPath();
      addRoundedRectPath(ctx, {
        x: backdropLeft,
        y: backdropTop,
        w: backdropWidth,
        h: backdropHeight,
        radius: borderRadius
      });
      ctx.fill();
    } else {
      ctx.fillRect(backdropLeft, backdropTop, backdropWidth, backdropHeight);
    }
  }
}
function drawPointLabels(scale, labelCount) {
  const { ctx, options: { pointLabels } } = scale;
  for (let i = labelCount - 1; i >= 0; i--) {
    const item = scale._pointLabelItems[i];
    if (!item.visible) {
      continue;
    }
    const optsAtIndex = pointLabels.setContext(scale.getPointLabelContext(i));
    drawPointLabelBox(ctx, optsAtIndex, item);
    const plFont = toFont(optsAtIndex.font);
    const { x, y, textAlign } = item;
    renderText(ctx, scale._pointLabels[i], x, y + plFont.lineHeight / 2, plFont, {
      color: optsAtIndex.color,
      textAlign,
      textBaseline: "middle"
    });
  }
}
function pathRadiusLine(scale, radius, circular, labelCount) {
  const { ctx } = scale;
  if (circular) {
    ctx.arc(scale.xCenter, scale.yCenter, radius, 0, TAU);
  } else {
    let pointPosition = scale.getPointPosition(0, radius);
    ctx.moveTo(pointPosition.x, pointPosition.y);
    for (let i = 1; i < labelCount; i++) {
      pointPosition = scale.getPointPosition(i, radius);
      ctx.lineTo(pointPosition.x, pointPosition.y);
    }
  }
}
function drawRadiusLine(scale, gridLineOpts, radius, labelCount, borderOpts) {
  const ctx = scale.ctx;
  const circular = gridLineOpts.circular;
  const { color: color2, lineWidth } = gridLineOpts;
  if (!circular && !labelCount || !color2 || !lineWidth || radius < 0) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = color2;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(borderOpts.dash || []);
  ctx.lineDashOffset = borderOpts.dashOffset;
  ctx.beginPath();
  pathRadiusLine(scale, radius, circular, labelCount);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}
function createPointLabelContext(parent, index2, label) {
  return createContext(parent, {
    label,
    index: index2,
    type: "pointLabel"
  });
}
var RadialLinearScale = class extends LinearScaleBase {
  static id = "radialLinear";
  static defaults = {
    display: true,
    animate: true,
    position: "chartArea",
    angleLines: {
      display: true,
      lineWidth: 1,
      borderDash: [],
      borderDashOffset: 0
    },
    grid: {
      circular: false
    },
    startAngle: 0,
    ticks: {
      showLabelBackdrop: true,
      callback: Ticks.formatters.numeric
    },
    pointLabels: {
      backdropColor: void 0,
      backdropPadding: 2,
      display: true,
      font: {
        size: 10
      },
      callback(label) {
        return label;
      },
      padding: 5,
      centerPointLabels: false
    }
  };
  static defaultRoutes = {
    "angleLines.color": "borderColor",
    "pointLabels.color": "color",
    "ticks.color": "color"
  };
  static descriptors = {
    angleLines: {
      _fallback: "grid"
    }
  };
  constructor(cfg) {
    super(cfg);
    this.xCenter = void 0;
    this.yCenter = void 0;
    this.drawingArea = void 0;
    this._pointLabels = [];
    this._pointLabelItems = [];
  }
  setDimensions() {
    const padding = this._padding = toPadding(getTickBackdropHeight(this.options) / 2);
    const w = this.width = this.maxWidth - padding.width;
    const h4 = this.height = this.maxHeight - padding.height;
    this.xCenter = Math.floor(this.left + w / 2 + padding.left);
    this.yCenter = Math.floor(this.top + h4 / 2 + padding.top);
    this.drawingArea = Math.floor(Math.min(w, h4) / 2);
  }
  determineDataLimits() {
    const { min, max } = this.getMinMax(false);
    this.min = isNumberFinite(min) && !isNaN(min) ? min : 0;
    this.max = isNumberFinite(max) && !isNaN(max) ? max : 0;
    this.handleTickRangeOptions();
  }
  computeTickLimit() {
    return Math.ceil(this.drawingArea / getTickBackdropHeight(this.options));
  }
  generateTickLabels(ticks) {
    LinearScaleBase.prototype.generateTickLabels.call(this, ticks);
    this._pointLabels = this.getLabels().map((value, index2) => {
      const label = callback(this.options.pointLabels.callback, [
        value,
        index2
      ], this);
      return label || label === 0 ? label : "";
    }).filter((v, i) => this.chart.getDataVisibility(i));
  }
  fit() {
    const opts = this.options;
    if (opts.display && opts.pointLabels.display) {
      fitWithPointLabels(this);
    } else {
      this.setCenterPoint(0, 0, 0, 0);
    }
  }
  setCenterPoint(leftMovement, rightMovement, topMovement, bottomMovement) {
    this.xCenter += Math.floor((leftMovement - rightMovement) / 2);
    this.yCenter += Math.floor((topMovement - bottomMovement) / 2);
    this.drawingArea -= Math.min(this.drawingArea / 2, Math.max(leftMovement, rightMovement, topMovement, bottomMovement));
  }
  getIndexAngle(index2) {
    const angleMultiplier = TAU / (this._pointLabels.length || 1);
    const startAngle = this.options.startAngle || 0;
    return _normalizeAngle(index2 * angleMultiplier + toRadians(startAngle));
  }
  getDistanceFromCenterForValue(value) {
    if (isNullOrUndef(value)) {
      return NaN;
    }
    const scalingFactor = this.drawingArea / (this.max - this.min);
    if (this.options.reverse) {
      return (this.max - value) * scalingFactor;
    }
    return (value - this.min) * scalingFactor;
  }
  getValueForDistanceFromCenter(distance) {
    if (isNullOrUndef(distance)) {
      return NaN;
    }
    const scaledDistance = distance / (this.drawingArea / (this.max - this.min));
    return this.options.reverse ? this.max - scaledDistance : this.min + scaledDistance;
  }
  getPointLabelContext(index2) {
    const pointLabels = this._pointLabels || [];
    if (index2 >= 0 && index2 < pointLabels.length) {
      const pointLabel = pointLabels[index2];
      return createPointLabelContext(this.getContext(), index2, pointLabel);
    }
  }
  getPointPosition(index2, distanceFromCenter, additionalAngle = 0) {
    const angle = this.getIndexAngle(index2) - HALF_PI + additionalAngle;
    return {
      x: Math.cos(angle) * distanceFromCenter + this.xCenter,
      y: Math.sin(angle) * distanceFromCenter + this.yCenter,
      angle
    };
  }
  getPointPositionForValue(index2, value) {
    return this.getPointPosition(index2, this.getDistanceFromCenterForValue(value));
  }
  getBasePosition(index2) {
    return this.getPointPositionForValue(index2 || 0, this.getBaseValue());
  }
  getPointLabelPosition(index2) {
    const { left, top, right, bottom } = this._pointLabelItems[index2];
    return {
      left,
      top,
      right,
      bottom
    };
  }
  drawBackground() {
    const { backgroundColor, grid: { circular } } = this.options;
    if (backgroundColor) {
      const ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      pathRadiusLine(this, this.getDistanceFromCenterForValue(this._endValue), circular, this._pointLabels.length);
      ctx.closePath();
      ctx.fillStyle = backgroundColor;
      ctx.fill();
      ctx.restore();
    }
  }
  drawGrid() {
    const ctx = this.ctx;
    const opts = this.options;
    const { angleLines, grid, border } = opts;
    const labelCount = this._pointLabels.length;
    let i, offset, position;
    if (opts.pointLabels.display) {
      drawPointLabels(this, labelCount);
    }
    if (grid.display) {
      this.ticks.forEach((tick, index2) => {
        if (index2 !== 0 || index2 === 0 && this.min < 0) {
          offset = this.getDistanceFromCenterForValue(tick.value);
          const context = this.getContext(index2);
          const optsAtIndex = grid.setContext(context);
          const optsAtIndexBorder = border.setContext(context);
          drawRadiusLine(this, optsAtIndex, offset, labelCount, optsAtIndexBorder);
        }
      });
    }
    if (angleLines.display) {
      ctx.save();
      for (i = labelCount - 1; i >= 0; i--) {
        const optsAtIndex = angleLines.setContext(this.getPointLabelContext(i));
        const { color: color2, lineWidth } = optsAtIndex;
        if (!lineWidth || !color2) {
          continue;
        }
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = color2;
        ctx.setLineDash(optsAtIndex.borderDash);
        ctx.lineDashOffset = optsAtIndex.borderDashOffset;
        offset = this.getDistanceFromCenterForValue(opts.reverse ? this.min : this.max);
        position = this.getPointPosition(i, offset);
        ctx.beginPath();
        ctx.moveTo(this.xCenter, this.yCenter);
        ctx.lineTo(position.x, position.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  drawBorder() {
  }
  drawLabels() {
    const ctx = this.ctx;
    const opts = this.options;
    const tickOpts = opts.ticks;
    if (!tickOpts.display) {
      return;
    }
    const startAngle = this.getIndexAngle(0);
    let offset, width;
    ctx.save();
    ctx.translate(this.xCenter, this.yCenter);
    ctx.rotate(startAngle);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.ticks.forEach((tick, index2) => {
      if (index2 === 0 && this.min >= 0 && !opts.reverse) {
        return;
      }
      const optsAtIndex = tickOpts.setContext(this.getContext(index2));
      const tickFont = toFont(optsAtIndex.font);
      offset = this.getDistanceFromCenterForValue(this.ticks[index2].value);
      if (optsAtIndex.showLabelBackdrop) {
        ctx.font = tickFont.string;
        width = ctx.measureText(tick.label).width;
        ctx.fillStyle = optsAtIndex.backdropColor;
        const padding = toPadding(optsAtIndex.backdropPadding);
        ctx.fillRect(-width / 2 - padding.left, -offset - tickFont.size / 2 - padding.top, width + padding.width, tickFont.size + padding.height);
      }
      renderText(ctx, tick.label, 0, -offset, tickFont, {
        color: optsAtIndex.color,
        strokeColor: optsAtIndex.textStrokeColor,
        strokeWidth: optsAtIndex.textStrokeWidth
      });
    });
    ctx.restore();
  }
  drawTitle() {
  }
};
var INTERVALS = {
  millisecond: {
    common: true,
    size: 1,
    steps: 1e3
  },
  second: {
    common: true,
    size: 1e3,
    steps: 60
  },
  minute: {
    common: true,
    size: 6e4,
    steps: 60
  },
  hour: {
    common: true,
    size: 36e5,
    steps: 24
  },
  day: {
    common: true,
    size: 864e5,
    steps: 30
  },
  week: {
    common: false,
    size: 6048e5,
    steps: 4
  },
  month: {
    common: true,
    size: 2628e6,
    steps: 12
  },
  quarter: {
    common: false,
    size: 7884e6,
    steps: 4
  },
  year: {
    common: true,
    size: 3154e7
  }
};
var UNITS = /* @__PURE__ */ Object.keys(INTERVALS);
function sorter(a, b) {
  return a - b;
}
function parse(scale, input) {
  if (isNullOrUndef(input)) {
    return null;
  }
  const adapter = scale._adapter;
  const { parser, round: round2, isoWeekday } = scale._parseOpts;
  let value = input;
  if (typeof parser === "function") {
    value = parser(value);
  }
  if (!isNumberFinite(value)) {
    value = typeof parser === "string" ? adapter.parse(value, parser) : adapter.parse(value);
  }
  if (value === null) {
    return null;
  }
  if (round2) {
    value = round2 === "week" && (isNumber(isoWeekday) || isoWeekday === true) ? adapter.startOf(value, "isoWeek", isoWeekday) : adapter.startOf(value, round2);
  }
  return +value;
}
function determineUnitForAutoTicks(minUnit, min, max, capacity) {
  const ilen = UNITS.length;
  for (let i = UNITS.indexOf(minUnit); i < ilen - 1; ++i) {
    const interval = INTERVALS[UNITS[i]];
    const factor = interval.steps ? interval.steps : Number.MAX_SAFE_INTEGER;
    if (interval.common && Math.ceil((max - min) / (factor * interval.size)) <= capacity) {
      return UNITS[i];
    }
  }
  return UNITS[ilen - 1];
}
function determineUnitForFormatting(scale, numTicks, minUnit, min, max) {
  for (let i = UNITS.length - 1; i >= UNITS.indexOf(minUnit); i--) {
    const unit = UNITS[i];
    if (INTERVALS[unit].common && scale._adapter.diff(max, min, unit) >= numTicks - 1) {
      return unit;
    }
  }
  return UNITS[minUnit ? UNITS.indexOf(minUnit) : 0];
}
function determineMajorUnit(unit) {
  for (let i = UNITS.indexOf(unit) + 1, ilen = UNITS.length; i < ilen; ++i) {
    if (INTERVALS[UNITS[i]].common) {
      return UNITS[i];
    }
  }
}
function addTick(ticks, time, timestamps) {
  if (!timestamps) {
    ticks[time] = true;
  } else if (timestamps.length) {
    const { lo, hi } = _lookup(timestamps, time);
    const timestamp = timestamps[lo] >= time ? timestamps[lo] : timestamps[hi];
    ticks[timestamp] = true;
  }
}
function setMajorTicks(scale, ticks, map3, majorUnit) {
  const adapter = scale._adapter;
  const first = +adapter.startOf(ticks[0].value, majorUnit);
  const last = ticks[ticks.length - 1].value;
  let major, index2;
  for (major = first; major <= last; major = +adapter.add(major, 1, majorUnit)) {
    index2 = map3[major];
    if (index2 >= 0) {
      ticks[index2].major = true;
    }
  }
  return ticks;
}
function ticksFromTimestamps(scale, values, majorUnit) {
  const ticks = [];
  const map3 = {};
  const ilen = values.length;
  let i, value;
  for (i = 0; i < ilen; ++i) {
    value = values[i];
    map3[value] = i;
    ticks.push({
      value,
      major: false
    });
  }
  return ilen === 0 || !majorUnit ? ticks : setMajorTicks(scale, ticks, map3, majorUnit);
}
var TimeScale = class extends Scale {
  static id = "time";
  static defaults = {
    bounds: "data",
    adapters: {},
    time: {
      parser: false,
      unit: false,
      round: false,
      isoWeekday: false,
      minUnit: "millisecond",
      displayFormats: {}
    },
    ticks: {
      source: "auto",
      callback: false,
      major: {
        enabled: false
      }
    }
  };
  constructor(props) {
    super(props);
    this._cache = {
      data: [],
      labels: [],
      all: []
    };
    this._unit = "day";
    this._majorUnit = void 0;
    this._offsets = {};
    this._normalized = false;
    this._parseOpts = void 0;
  }
  init(scaleOpts, opts = {}) {
    const time = scaleOpts.time || (scaleOpts.time = {});
    const adapter = this._adapter = new adapters._date(scaleOpts.adapters.date);
    adapter.init(opts);
    mergeIf(time.displayFormats, adapter.formats());
    this._parseOpts = {
      parser: time.parser,
      round: time.round,
      isoWeekday: time.isoWeekday
    };
    super.init(scaleOpts);
    this._normalized = opts.normalized;
  }
  parse(raw, index2) {
    if (raw === void 0) {
      return null;
    }
    return parse(this, raw);
  }
  beforeLayout() {
    super.beforeLayout();
    this._cache = {
      data: [],
      labels: [],
      all: []
    };
  }
  determineDataLimits() {
    const options = this.options;
    const adapter = this._adapter;
    const unit = options.time.unit || "day";
    let { min, max, minDefined, maxDefined } = this.getUserBounds();
    function _applyBounds(bounds) {
      if (!minDefined && !isNaN(bounds.min)) {
        min = Math.min(min, bounds.min);
      }
      if (!maxDefined && !isNaN(bounds.max)) {
        max = Math.max(max, bounds.max);
      }
    }
    if (!minDefined || !maxDefined) {
      _applyBounds(this._getLabelBounds());
      if (options.bounds !== "ticks" || options.ticks.source !== "labels") {
        _applyBounds(this.getMinMax(false));
      }
    }
    min = isNumberFinite(min) && !isNaN(min) ? min : +adapter.startOf(Date.now(), unit);
    max = isNumberFinite(max) && !isNaN(max) ? max : +adapter.endOf(Date.now(), unit) + 1;
    this.min = Math.min(min, max - 1);
    this.max = Math.max(min + 1, max);
  }
  _getLabelBounds() {
    const arr = this.getLabelTimestamps();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    if (arr.length) {
      min = arr[0];
      max = arr[arr.length - 1];
    }
    return {
      min,
      max
    };
  }
  buildTicks() {
    const options = this.options;
    const timeOpts = options.time;
    const tickOpts = options.ticks;
    const timestamps = tickOpts.source === "labels" ? this.getLabelTimestamps() : this._generate();
    if (options.bounds === "ticks" && timestamps.length) {
      this.min = this._userMin || timestamps[0];
      this.max = this._userMax || timestamps[timestamps.length - 1];
    }
    const min = this.min;
    const max = this.max;
    const ticks = _filterBetween(timestamps, min, max);
    this._unit = timeOpts.unit || (tickOpts.autoSkip ? determineUnitForAutoTicks(timeOpts.minUnit, this.min, this.max, this._getLabelCapacity(min)) : determineUnitForFormatting(this, ticks.length, timeOpts.minUnit, this.min, this.max));
    this._majorUnit = !tickOpts.major.enabled || this._unit === "year" ? void 0 : determineMajorUnit(this._unit);
    this.initOffsets(timestamps);
    if (options.reverse) {
      ticks.reverse();
    }
    return ticksFromTimestamps(this, ticks, this._majorUnit);
  }
  afterAutoSkip() {
    if (this.options.offsetAfterAutoskip) {
      this.initOffsets(this.ticks.map((tick) => +tick.value));
    }
  }
  initOffsets(timestamps = []) {
    let start = 0;
    let end = 0;
    let first, last;
    if (this.options.offset && timestamps.length) {
      first = this.getDecimalForValue(timestamps[0]);
      if (timestamps.length === 1) {
        start = 1 - first;
      } else {
        start = (this.getDecimalForValue(timestamps[1]) - first) / 2;
      }
      last = this.getDecimalForValue(timestamps[timestamps.length - 1]);
      if (timestamps.length === 1) {
        end = last;
      } else {
        end = (last - this.getDecimalForValue(timestamps[timestamps.length - 2])) / 2;
      }
    }
    const limit = timestamps.length < 3 ? 0.5 : 0.25;
    start = _limitValue(start, 0, limit);
    end = _limitValue(end, 0, limit);
    this._offsets = {
      start,
      end,
      factor: 1 / (start + 1 + end)
    };
  }
  _generate() {
    const adapter = this._adapter;
    const min = this.min;
    const max = this.max;
    const options = this.options;
    const timeOpts = options.time;
    const minor = timeOpts.unit || determineUnitForAutoTicks(timeOpts.minUnit, min, max, this._getLabelCapacity(min));
    const stepSize = valueOrDefault(options.ticks.stepSize, 1);
    const weekday = minor === "week" ? timeOpts.isoWeekday : false;
    const hasWeekday = isNumber(weekday) || weekday === true;
    const ticks = {};
    let first = min;
    let time, count;
    if (hasWeekday) {
      first = +adapter.startOf(first, "isoWeek", weekday);
    }
    first = +adapter.startOf(first, hasWeekday ? "day" : minor);
    if (adapter.diff(max, min, minor) > 1e5 * stepSize) {
      throw new Error(min + " and " + max + " are too far apart with stepSize of " + stepSize + " " + minor);
    }
    const timestamps = options.ticks.source === "data" && this.getDataTimestamps();
    for (time = first, count = 0; time < max; time = +adapter.add(time, stepSize, minor), count++) {
      addTick(ticks, time, timestamps);
    }
    if (time === max || options.bounds === "ticks" || count === 1) {
      addTick(ticks, time, timestamps);
    }
    return Object.keys(ticks).sort(sorter).map((x) => +x);
  }
  getLabelForValue(value) {
    const adapter = this._adapter;
    const timeOpts = this.options.time;
    if (timeOpts.tooltipFormat) {
      return adapter.format(value, timeOpts.tooltipFormat);
    }
    return adapter.format(value, timeOpts.displayFormats.datetime);
  }
  format(value, format) {
    const options = this.options;
    const formats = options.time.displayFormats;
    const unit = this._unit;
    const fmt = format || formats[unit];
    return this._adapter.format(value, fmt);
  }
  _tickFormatFunction(time, index2, ticks, format) {
    const options = this.options;
    const formatter = options.ticks.callback;
    if (formatter) {
      return callback(formatter, [
        time,
        index2,
        ticks
      ], this);
    }
    const formats = options.time.displayFormats;
    const unit = this._unit;
    const majorUnit = this._majorUnit;
    const minorFormat = unit && formats[unit];
    const majorFormat = majorUnit && formats[majorUnit];
    const tick = ticks[index2];
    const major = majorUnit && majorFormat && tick && tick.major;
    return this._adapter.format(time, format || (major ? majorFormat : minorFormat));
  }
  generateTickLabels(ticks) {
    let i, ilen, tick;
    for (i = 0, ilen = ticks.length; i < ilen; ++i) {
      tick = ticks[i];
      tick.label = this._tickFormatFunction(tick.value, i, ticks);
    }
  }
  getDecimalForValue(value) {
    return value === null ? NaN : (value - this.min) / (this.max - this.min);
  }
  getPixelForValue(value) {
    const offsets = this._offsets;
    const pos = this.getDecimalForValue(value);
    return this.getPixelForDecimal((offsets.start + pos) * offsets.factor);
  }
  getValueForPixel(pixel) {
    const offsets = this._offsets;
    const pos = this.getDecimalForPixel(pixel) / offsets.factor - offsets.end;
    return this.min + pos * (this.max - this.min);
  }
  _getLabelSize(label) {
    const ticksOpts = this.options.ticks;
    const tickLabelWidth = this.ctx.measureText(label).width;
    const angle = toRadians(this.isHorizontal() ? ticksOpts.maxRotation : ticksOpts.minRotation);
    const cosRotation = Math.cos(angle);
    const sinRotation = Math.sin(angle);
    const tickFontSize = this._resolveTickFontOptions(0).size;
    return {
      w: tickLabelWidth * cosRotation + tickFontSize * sinRotation,
      h: tickLabelWidth * sinRotation + tickFontSize * cosRotation
    };
  }
  _getLabelCapacity(exampleTime) {
    const timeOpts = this.options.time;
    const displayFormats = timeOpts.displayFormats;
    const format = displayFormats[timeOpts.unit] || displayFormats.millisecond;
    const exampleLabel = this._tickFormatFunction(exampleTime, 0, ticksFromTimestamps(this, [
      exampleTime
    ], this._majorUnit), format);
    const size = this._getLabelSize(exampleLabel);
    const capacity = Math.floor(this.isHorizontal() ? this.width / size.w : this.height / size.h) - 1;
    return capacity > 0 ? capacity : 1;
  }
  getDataTimestamps() {
    let timestamps = this._cache.data || [];
    let i, ilen;
    if (timestamps.length) {
      return timestamps;
    }
    const metas = this.getMatchingVisibleMetas();
    if (this._normalized && metas.length) {
      return this._cache.data = metas[0].controller.getAllParsedValues(this);
    }
    for (i = 0, ilen = metas.length; i < ilen; ++i) {
      timestamps = timestamps.concat(metas[i].controller.getAllParsedValues(this));
    }
    return this._cache.data = this.normalize(timestamps);
  }
  getLabelTimestamps() {
    const timestamps = this._cache.labels || [];
    let i, ilen;
    if (timestamps.length) {
      return timestamps;
    }
    const labels = this.getLabels();
    for (i = 0, ilen = labels.length; i < ilen; ++i) {
      timestamps.push(parse(this, labels[i]));
    }
    return this._cache.labels = this._normalized ? timestamps : this.normalize(timestamps);
  }
  normalize(values) {
    return _arrayUnique(values.sort(sorter));
  }
};
function interpolate2(table, val, reverse) {
  let lo = 0;
  let hi = table.length - 1;
  let prevSource, nextSource, prevTarget, nextTarget;
  if (reverse) {
    if (val >= table[lo].pos && val <= table[hi].pos) {
      ({ lo, hi } = _lookupByKey(table, "pos", val));
    }
    ({ pos: prevSource, time: prevTarget } = table[lo]);
    ({ pos: nextSource, time: nextTarget } = table[hi]);
  } else {
    if (val >= table[lo].time && val <= table[hi].time) {
      ({ lo, hi } = _lookupByKey(table, "time", val));
    }
    ({ time: prevSource, pos: prevTarget } = table[lo]);
    ({ time: nextSource, pos: nextTarget } = table[hi]);
  }
  const span = nextSource - prevSource;
  return span ? prevTarget + (nextTarget - prevTarget) * (val - prevSource) / span : prevTarget;
}
var TimeSeriesScale = class extends TimeScale {
  static id = "timeseries";
  static defaults = TimeScale.defaults;
  constructor(props) {
    super(props);
    this._table = [];
    this._minPos = void 0;
    this._tableRange = void 0;
  }
  initOffsets() {
    const timestamps = this._getTimestampsForTable();
    const table = this._table = this.buildLookupTable(timestamps);
    this._minPos = interpolate2(table, this.min);
    this._tableRange = interpolate2(table, this.max) - this._minPos;
    super.initOffsets(timestamps);
  }
  buildLookupTable(timestamps) {
    const { min, max } = this;
    const items = [];
    const table = [];
    let i, ilen, prev, curr, next;
    for (i = 0, ilen = timestamps.length; i < ilen; ++i) {
      curr = timestamps[i];
      if (curr >= min && curr <= max) {
        items.push(curr);
      }
    }
    if (items.length < 2) {
      return [
        {
          time: min,
          pos: 0
        },
        {
          time: max,
          pos: 1
        }
      ];
    }
    for (i = 0, ilen = items.length; i < ilen; ++i) {
      next = items[i + 1];
      prev = items[i - 1];
      curr = items[i];
      if (Math.round((next + prev) / 2) !== curr) {
        table.push({
          time: curr,
          pos: i / (ilen - 1)
        });
      }
    }
    return table;
  }
  _generate() {
    const min = this.min;
    const max = this.max;
    let timestamps = super.getDataTimestamps();
    if (!timestamps.includes(min) || !timestamps.length) {
      timestamps.splice(0, 0, min);
    }
    if (!timestamps.includes(max) || timestamps.length === 1) {
      timestamps.push(max);
    }
    return timestamps.sort((a, b) => a - b);
  }
  _getTimestampsForTable() {
    let timestamps = this._cache.all || [];
    if (timestamps.length) {
      return timestamps;
    }
    const data = this.getDataTimestamps();
    const label = this.getLabelTimestamps();
    if (data.length && label.length) {
      timestamps = this.normalize(data.concat(label));
    } else {
      timestamps = data.length ? data : label;
    }
    timestamps = this._cache.all = timestamps;
    return timestamps;
  }
  getDecimalForValue(value) {
    return (interpolate2(this._table, value) - this._minPos) / this._tableRange;
  }
  getValueForPixel(pixel) {
    const offsets = this._offsets;
    const decimal = this.getDecimalForPixel(pixel) / offsets.factor - offsets.end;
    return interpolate2(this._table, decimal * this._tableRange + this._minPos, true);
  }
};
var scales = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  RadialLinearScale,
  TimeScale,
  TimeSeriesScale
});
var registerables = [
  controllers,
  elements,
  plugins,
  scales
];

// node_modules/chart.js/auto/auto.js
Chart.register(...registerables);
var auto_default = Chart;

// public/lib/xScale.js
function computeLandmarkPositions({ domain, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP, x }) {
  const { minX, maxX } = domain;
  const range = maxX - minX;
  if (range <= 0) return { markerPct: 0, brAmberLPct: 0, sweetPct: 0, brAmberRPct: 0, brRedRPct: 0, wallPct: 100, gradientStops: [], clamped: true, overflow: "left" };
  const toPct = (v) => Math.max(0, Math.min(100, (v - minX) / range * 100));
  const safeX = Number.isFinite(x) ? x : 0;
  let markerPct, clamped = false, overflow = "none";
  if (safeX < minX) {
    markerPct = 0;
    clamped = true;
    overflow = "left";
  } else if (safeX > maxX) {
    markerPct = 100;
    clamped = true;
    overflow = "right";
  } else {
    markerPct = toPct(safeX);
  }
  const brAmberLPct = Number.isFinite(xBrAmberL) ? toPct(xBrAmberL) : 0;
  const sweetPct = toPct(xSweet);
  const brAmberRPct = toPct(xBrAmberR);
  const brRedRPct = Number.isFinite(xBrRedR) ? toPct(xBrRedR) : toPct(wallP);
  const wallPct = toPct(wallP);
  const gradientStops = [
    { pct: 0, color: "var(--zone-shallow)" },
    { pct: brAmberLPct, color: "var(--zone-entry)" },
    { pct: sweetPct, color: "var(--zone-sweet)" },
    { pct: brRedRPct, color: "var(--zone-deep)" },
    { pct: wallPct, color: "var(--zone-wall)" }
  ];
  return { markerPct, brAmberLPct, sweetPct, brAmberRPct, brRedRPct, wallPct, gradientStops, clamped, overflow };
}
function projectedX(reference, u) {
  return reference && Number.isFinite(u) ? reference.a + reference.d * u : null;
}
var LOCK_FRACTION = 0.75;
function computeEoqViewport({ wallP, xCurrent, previousDomainMax, previewX, origin }) {
  const safeWall = Number.isFinite(wallP) && wallP > 1 ? wallP : 2;
  const min = Number.isFinite(origin) ? origin : 1;
  const locked = (x) => Number.isFinite(x) ? min + (x - min) / LOCK_FRACTION : -Infinity;
  const carried = Number.isFinite(previousDomainMax) ? previousDomainMax : -Infinity;
  let max = Math.min(Math.max(Math.sqrt(safeWall), carried, locked(xCurrent)), safeWall);
  const actualDomainMax = max;
  max = Math.min(Math.max(max, locked(previewX)), safeWall);
  const mainDomain = { min, max };
  const overviewDomain = { min: 1, max: safeWall };
  const range = safeWall - 1;
  const viewportPct = {
    left: Math.max(0, Math.min(100, (mainDomain.min - 1) / range * 100)),
    right: Math.max(0, Math.min(100, (mainDomain.max - 1) / range * 100))
  };
  const safeCurrent = Number.isFinite(xCurrent) ? xCurrent : 1;
  const markerPct = Math.max(0, Math.min(100, (safeCurrent - 1) / range * 100));
  const isPastWall = safeCurrent > safeWall;
  return { mainDomain, overviewDomain, viewportPct, markerPct, isPastWall, actualDomainMax };
}

// public/elements/heroDiptych.js
var SAMPLE_POINTS = 50;
var Y_HEADROOM = 1.3;
var ACTIVE_OPACITY = 1;
var INACTIVE_OPACITY = 0.25;
var ACTIVE_LINE_WIDTH = 2.5;
var INACTIVE_LINE_WIDTH = 1.2;
var ACTIVE_DOT_RADIUS = 7;
var INACTIVE_DOT_RADIUS = 4.5;
var DOT_HIT_RADIUS = 15;
var ACTIVE_LANDMARK_WIDTH = 1.6;
var INACTIVE_LANDMARK_WIDTH = 1;
var INACTIVE_DASH = [6, 4];
var DOT_OVERLAP_THRESHOLD_PX = 4;
var ORDER = {
  inactiveReference: 50,
  inactiveLandmark: 45,
  activeReference: 30,
  activeLandmark: 25,
  wall: 15,
  inactiveDot: 10,
  activeDot: 0
};
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}
function brLabelColor(br, read) {
  if (br >= 0.25) return read("--coral") || "#ff7566";
  if (br >= 0.1) return read("--amber") || "#ffc24d";
  return read("--mint") || "#4fe0b0";
}
function tooltipPaint(read) {
  const edge = read("--sw-hairline");
  return {
    backgroundColor: read("--sw-overlay") || "rgba(20, 26, 30, 0.9)",
    bodyColor: read("--sw-highlight") || "#eef3f6",
    borderColor: edge || "rgba(0,0,0,0)",
    borderWidth: edge ? 1 : 0
  };
}
function colorWithAlpha(color2, alpha2) {
  if (!color2) return `rgba(79,224,176,${alpha2})`;
  if (color2.startsWith("rgba(")) return color2.replace(/,\s*[\d.]+\s*\)$/, `, ${alpha2})`);
  if (color2.startsWith("rgb(")) return color2.replace("rgb(", "rgba(").replace(")", `, ${alpha2})`);
  if (color2.startsWith("#")) {
    const hex2 = color2.slice(1, 7);
    if (hex2.length === 6) {
      const r = parseInt(hex2.slice(0, 2), 16), g = parseInt(hex2.slice(2, 4), 16), b = parseInt(hex2.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha2})`;
    }
  }
  return color2;
}
function referenceY(x, reference) {
  const u = (x - reference.a) / reference.d;
  if (!(u > 0)) return null;
  return 1 + (u - 1) * (u - 1) / (2 * u);
}
function sampleReference(reference, minX, maxX, nPoints = SAMPLE_POINTS) {
  const start = minX;
  const span = maxX - reference.a;
  if (!(span > 0)) return [];
  const logMin = Math.log(Math.max(start - reference.a, span * 1e-3));
  const logMax = Math.log(span);
  const points = [];
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    const x = reference.a + Math.exp(logMin + t * (logMax - logMin));
    const y = referenceY(x, reference);
    if (y !== null) points.push({ x, y });
  }
  return points;
}
var chartPoint = (p, reference) => {
  const x = projectedX(reference, p.u);
  return x !== null && Number.isFinite(p.pp) ? { x, y: 1 + p.pp } : null;
};
function yMaxOf({ reference, xBrAmberL, wallP }) {
  const candidates = [];
  if (reference) {
    if (Number.isFinite(xBrAmberL)) {
      const y = referenceY(xBrAmberL, reference);
      if (y !== null) candidates.push(y);
    }
    const yWall = referenceY(wallP, reference);
    if (yWall !== null) candidates.push(yWall);
  }
  if (candidates.length === 0) candidates.push(1);
  return Math.max(...candidates) * Y_HEADROOM;
}
var ZONE_LABELS = { green: "Valley", left: "Left arm", amber: "Amber", red: "Red", wall: "At wall", calibrating: "Calibrating" };
function positionVerdict(br, u, x, wallP) {
  if (!Number.isFinite(br)) return { zone: "calibrating", caption: "Calibrating\u2026" };
  if (x >= wallP) return { zone: "wall", caption: "At the cost wall \u2014 carrying the excess one more call costs as much as a full rebuild. Consider restarting now." };
  if (u < 1) {
    if (br >= 0.1) return { zone: "left", caption: "Left of the sweet spot \u2014 position penalty falls with every call." };
    return { zone: "green", caption: "Left of the sweet spot \u2014 bill premium within the valley." };
  }
  if (br >= 0.25) return { zone: "red", caption: "Past the sweet spot \u2014 bill premium above red." };
  if (br >= 0.1) return { zone: "amber", caption: "Past the sweet spot \u2014 bill premium above amber." };
  return { zone: "green", caption: "Past the sweet spot \u2014 bill premium within the valley." };
}
var fourLandmarks = (src) => src.xSweet == null ? null : { xSweet: src.xSweet, xBrAmberL: src.xBrAmberL, xBrAmberR: src.xBrAmberR, xBrRedR: src.xBrRedR };
function groupModelFromStatus(rl, available) {
  const reference = available && rl.reference ? rl.reference : null;
  const x = rl.x_display;
  const dot = chartPoint({ u: rl.u, pp: rl.pp }, reference);
  return {
    dot,
    wallP: rl.wallP ?? 1 + rl.C_RATIO,
    reference,
    landmarks: available ? fourLandmarks(rl) : null,
    u: rl.u,
    mf: rl.mf,
    br: rl.br,
    x,
    residual: dot && Number.isFinite(x) ? x - dot.x : null
  };
}
function groupModelFromScenario(scenario, wallP) {
  if (!scenario || scenario.reliable !== true) return null;
  const reference = scenario.reference ?? null;
  const last = (scenario.trajectory ?? []).at(-1) ?? null;
  const dot = last ? chartPoint(last, reference) : null;
  return {
    dot,
    wallP,
    reference,
    landmarks: fourLandmarks(scenario),
    u: scenario.u,
    mf: scenario.mf,
    br: scenario.br,
    x: last ? last.x : null,
    residual: dot && last && Number.isFinite(last.x) ? last.x - dot.x : null
  };
}
function shownGroupOf(activeGroup, mint) {
  return activeGroup === "mint" && mint?.dot ? "mint" : "amber";
}
function mount2(root, ctx) {
  let previousActualDomainMax = null;
  let prevSegment = null;
  let activeGroup = "amber";
  let previewState = null;
  let lastSnapshot = null;
  const container = document.createElement("div");
  container.className = "sw-hero-diptych";
  container.innerHTML = `
    <div class="eoq-top">
      <div>
        <span class="lab">Position</span>
        <div class="sub">cost-rate valley \xB7 Harris 1913</div>
      </div>
      <span class="eoq-u"><span class="sw-hero-group-pill" style="display:none;"></span>u = <b class="sw-hero-uval">\u2014</b> \xB7 <span class="sw-hero-mf">movable \u2014%</span></span>
    </div>
    <div class="sw-hero-chart-wrap">
      <canvas class="sw-hero-canvas"></canvas>
    </div>
  `;
  root.appendChild(container);
  const verdictRow = document.createElement("div");
  verdictRow.className = "sw-hero-verdict-row";
  verdictRow.innerHTML = `<span class="pill sw-verdict-pill">idle</span><p class="sw-verdict-text">Position tracking begins after the first API call.</p>`;
  root.appendChild(verdictRow);
  const canvas = container.querySelector(".sw-hero-canvas");
  const uvalEl = container.querySelector(".sw-hero-uval");
  const groupPillEl = container.querySelector(".sw-hero-group-pill");
  const mfEl = container.querySelector(".sw-hero-mf");
  const verdictPill = verdictRow.querySelector(".sw-verdict-pill");
  const verdictText = verdictRow.querySelector(".sw-verdict-text");
  let mintColor, amberColor, sweetColor, entryColor, deepColor, wallColor;
  function resolveColors() {
    mintColor = cssVar(container, "--mint", "#4fe0b0");
    amberColor = cssVar(container, "--amber", "#ffc24d");
    sweetColor = cssVar(container, "--zone-sweet", "#4fe0b0");
    entryColor = cssVar(container, "--zone-entry", "#6cc6f0");
    deepColor = cssVar(container, "--zone-deep", "#ffc24d");
    wallColor = cssVar(container, "--zone-wall", "#ff7566");
  }
  resolveColors();
  const brLabelPlugin = {
    id: "brLabel",
    afterDraw(chartInstance) {
      const opts = chartInstance.options.plugins.brLabel;
      if (!opts) return;
      const { ctx: ctx2 } = chartInstance;
      const yScale = chartInstance.scales.y, xScale = chartInstance.scales.x;
      ctx2.save();
      ctx2.font = '400 9px "JetBrains Mono", monospace';
      ctx2.fillStyle = getComputedStyle(chartInstance.canvas).getPropertyValue("--txt-dim")?.trim() || "#aaa";
      ctx2.save();
      ctx2.translate(xScale.left - 30, yScale.top + (yScale.bottom - yScale.top) / 2);
      ctx2.rotate(-Math.PI / 2);
      ctx2.textAlign = "center";
      ctx2.fillText("bill premium", 0, 0);
      ctx2.restore();
      if (!Number.isFinite(opts.br) || !Number.isFinite(opts.y)) {
        ctx2.restore();
        return;
      }
      const yPx = Math.max(yScale.top + 10, Math.min(yScale.bottom - 4, yScale.getPixelForValue(opts.y)));
      ctx2.font = '500 11px "JetBrains Mono", monospace';
      ctx2.textAlign = "right";
      ctx2.textBaseline = "middle";
      const color2 = brLabelColor(opts.br, (name) => getComputedStyle(chartInstance.canvas).getPropertyValue(name).trim());
      ctx2.fillStyle = color2;
      ctx2.fillText(`${Math.floor(opts.br * 100)}%`, xScale.left - 4, yPx);
      ctx2.restore();
    }
  };
  const chart = new auto_default(canvas, {
    type: "line",
    data: { datasets: [] },
    plugins: [brLabelPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          filter: (item) => chart.data.datasets[item.datasetIndex]?._swRole === "dot",
          callbacks: {
            label: (item) => {
              const ds = chart.data.datasets[item.datasetIndex];
              const who = ds._swGroup === "amber" ? "Current state" : "Preview state";
              return Number.isFinite(ds._swResidual) ? `${who} \xB7 residual ${ds._swResidual.toFixed(3)}` : who;
            },
            title: () => ""
          },
          displayColors: false,
          ...tooltipPaint((name) => getComputedStyle(container).getPropertyValue(name).trim()),
          bodyFont: { family: '"JetBrains Mono", monospace', size: 11 },
          padding: { x: 8, y: 5 },
          cornerRadius: 6
        },
        brLabel: { br: null, y: null }
      },
      scales: {
        x: { type: "linear", min: 0.8, max: 5, title: { display: false } },
        y: { type: "linear", min: 0.94, max: 2, title: { display: false }, ticks: { callback: () => "    ", font: { size: 11, family: '"JetBrains Mono", monospace' } }, grid: { display: false } }
      },
      onClick: handleChartClick
    }
  });
  ctx.charts.hero = chart;
  function vertical(groupId, key, x, yMax, color2, dash, width, order, role) {
    return {
      data: [{ x, y: 0 }, { x, y: yMax }],
      borderColor: color2,
      borderWidth: width,
      borderDash: dash,
      pointRadius: 0,
      pointHitRadius: 0,
      showLine: true,
      fill: false,
      parsing: false,
      order,
      _swId: `${groupId}.${key}`,
      _swGroup: groupId,
      _swRole: role,
      _swLandmark: key
    };
  }
  function buildGroupDatasets(groupId, model, { domainMin, domainMax, yMax, isActive }) {
    const op = isActive ? ACTIVE_OPACITY : INACTIVE_OPACITY;
    const lw = isActive ? ACTIVE_LINE_WIDTH : INACTIVE_LINE_WIDTH;
    const lmW = isActive ? ACTIVE_LANDMARK_WIDTH : INACTIVE_LANDMARK_WIDTH;
    const dotR = isActive ? ACTIVE_DOT_RADIUS : INACTIVE_DOT_RADIUS;
    const groupColor = groupId === "amber" ? amberColor : mintColor;
    const datasets = [];
    if (model.reference) {
      datasets.push({
        data: sampleReference(model.reference, domainMin, domainMax),
        borderColor: colorWithAlpha(mintColor, op * 0.8),
        backgroundColor: isActive ? colorWithAlpha(mintColor, op * 0.06) : "transparent",
        borderWidth: lw * 0.8,
        borderDash: isActive ? [] : INACTIVE_DASH,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        fill: isActive ? "start" : false,
        tension: 0.3,
        parsing: false,
        order: isActive ? ORDER.activeReference : ORDER.inactiveReference,
        _swId: `${groupId}.reference`,
        _swGroup: groupId,
        _swRole: "reference",
        _swLandmark: null
      });
    }
    if (model.landmarks) {
      const lmOrder = isActive ? ORDER.activeLandmark : ORDER.inactiveLandmark;
      const { xSweet, xBrAmberL, xBrAmberR, xBrRedR } = model.landmarks;
      datasets.push(vertical(groupId, "sweet", xSweet, yMax, colorWithAlpha(sweetColor, op * 0.7), [4, 4], lmW, lmOrder, "landmark"));
      datasets.push(vertical(groupId, "amberL", xBrAmberL, yMax, colorWithAlpha(entryColor, op * 0.7), [3, 4], lmW, lmOrder, "landmark"));
      datasets.push(vertical(groupId, "amberR", xBrAmberR, yMax, colorWithAlpha(deepColor, op * 0.7), [4, 4], lmW, lmOrder, "landmark"));
      datasets.push(vertical(groupId, "redR", xBrRedR, yMax, colorWithAlpha(wallColor, op * 0.7), [4, 4], lmW, lmOrder, "landmark"));
    }
    datasets.push(vertical(groupId, "wall", model.wallP, yMax, colorWithAlpha(wallColor, op), [], lmW, ORDER.wall, "wall"));
    if (model.dot) {
      datasets.push({
        data: [model.dot],
        borderColor: colorWithAlpha(groupColor, op),
        backgroundColor: colorWithAlpha(groupColor, op),
        pointRadius: dotR,
        pointHoverRadius: dotR + 2,
        pointHitRadius: DOT_HIT_RADIUS,
        pointBorderWidth: 0,
        showLine: false,
        parsing: false,
        order: isActive ? ORDER.activeDot : ORDER.inactiveDot,
        _swId: `${groupId}.dot`,
        _swGroup: groupId,
        _swRole: "dot",
        _swLandmark: null,
        _swResidual: model.residual
      });
    }
    return datasets;
  }
  function updateTopbar(model, shownGroup) {
    const dirty = previewState?.dirty === true;
    if (dirty) {
      groupPillEl.style.display = "";
      groupPillEl.textContent = shownGroup === "mint" ? "preview" : "default";
      groupPillEl.className = `sw-hero-group-pill pill-${shownGroup}`;
    } else {
      groupPillEl.style.display = "none";
    }
    uvalEl.textContent = Number.isFinite(model?.u) ? model.u.toFixed(1) : "\u2014";
    mfEl.textContent = Number.isFinite(model?.mf) ? `movable ${Math.floor(model.mf * 100)}%` : "movable \u2014%";
  }
  function showIdle() {
    chart.data.datasets = [];
    chart.options.plugins.brLabel.br = null;
    chart.update("none");
    updateTopbar(null, "amber");
    verdictPill.textContent = "idle";
    verdictText.textContent = "Position tracking begins after the first API call.";
  }
  function render() {
    const status = lastSnapshot?.status;
    const rl = status?.rateLamp;
    if (!rl?.reliable) {
      showIdle();
      return;
    }
    const available = lastSnapshot?.capabilities?.eoqLandmarks?.available === true;
    const amber = groupModelFromStatus(rl, available);
    const mint = previewState?.dirty ? groupModelFromScenario(previewState.scenario, amber.wallP) : null;
    const shown = shownGroupOf(activeGroup, mint);
    const active = shown === "mint" ? mint : amber;
    const viewport = computeEoqViewport({
      wallP: amber.wallP,
      xCurrent: amber.dot ? amber.dot.x : null,
      origin: amber.reference?.a,
      previousDomainMax: previousActualDomainMax,
      previewX: mint?.dot ? mint.dot.x : null
    });
    previousActualDomainMax = viewport.actualDomainMax;
    const domain = viewport.mainDomain;
    const yMax = Math.max(
      yMaxOf({ reference: amber.reference, xBrAmberL: amber.landmarks?.xBrAmberL, wallP: amber.wallP }),
      mint ? yMaxOf({ reference: mint.reference, xBrAmberL: mint.landmarks?.xBrAmberL, wallP: mint.wallP }) : 0
    );
    let datasets = buildGroupDatasets("amber", amber, { domainMin: domain.min, domainMax: domain.max, yMax, isActive: shown === "amber" });
    if (mint) datasets = [...datasets, ...buildGroupDatasets("mint", mint, { domainMin: domain.min, domainMax: domain.max, yMax, isActive: shown === "mint" })];
    chart.data.datasets = datasets;
    chart.options.scales.x.min = domain.min;
    chart.options.scales.x.max = domain.max;
    chart.options.scales.y.min = 1 - yMax * 0.06;
    chart.options.scales.y.max = yMax;
    chart.options.plugins.brLabel.br = active.br;
    chart.options.plugins.brLabel.y = active.dot ? active.dot.y : null;
    chart.update("none");
    updateTopbar(active, shown);
    const verdict = positionVerdict(active.br, active.u, active.x, active.wallP);
    verdictPill.textContent = ZONE_LABELS[verdict.zone] ?? verdict.zone;
    verdictText.textContent = verdict.caption;
  }
  function dotsOverlap() {
    let amberPt = null, mintPt = null;
    chart.data.datasets.forEach((ds, i) => {
      if (ds._swRole !== "dot") return;
      const el = chart.getDatasetMeta(i).data[0];
      if (!el) return;
      if (ds._swGroup === "amber") amberPt = { x: el.x, y: el.y };
      if (ds._swGroup === "mint") mintPt = { x: el.x, y: el.y };
    });
    if (!amberPt || !mintPt) return false;
    return Math.hypot(amberPt.x - mintPt.x, amberPt.y - mintPt.y) < DOT_OVERLAP_THRESHOLD_PX;
  }
  function handleChartClick(evt) {
    const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
    const dotHit = hits.find(({ datasetIndex }) => chart.data.datasets[datasetIndex]?._swRole === "dot");
    if (!dotHit) return;
    const group = chart.data.datasets[dotHit.datasetIndex]._swGroup;
    activeGroup = dotsOverlap() ? activeGroup === "mint" ? "amber" : "mint" : group;
    ctx.bus.dispatchEvent(new CustomEvent("sw-active-group", { detail: { activeGroup } }));
    render();
  }
  function onBucketPreview(e) {
    const detail = e.detail ?? null;
    const wasDirty = previewState?.dirty === true;
    previewState = detail;
    if (detail?.dirty && !wasDirty) {
      activeGroup = "mint";
      ctx.bus.dispatchEvent(new CustomEvent("sw-active-group", { detail: { activeGroup } }));
    } else if (!detail?.dirty && wasDirty) {
      activeGroup = "amber";
      ctx.bus.dispatchEvent(new CustomEvent("sw-active-group", { detail: { activeGroup } }));
    }
    render();
  }
  function onExternalActiveGroup(e) {
    const newGroup = e.detail?.activeGroup;
    if (!newGroup || newGroup === activeGroup) return;
    activeGroup = newGroup;
    render();
  }
  ctx.bus.addEventListener("sw-bucket-preview", onBucketPreview);
  ctx.bus.addEventListener("sw-active-group", onExternalActiveGroup);
  function update(snapshot) {
    const currentSegment = snapshot?.status?.segment ?? null;
    if (currentSegment !== prevSegment) {
      previousActualDomainMax = null;
      prevSegment = currentSegment;
    }
    lastSnapshot = snapshot;
    render();
  }
  function destroy() {
    ctx.bus.removeEventListener("sw-bucket-preview", onBucketPreview);
    ctx.bus.removeEventListener("sw-active-group", onExternalActiveGroup);
    chart.destroy();
    container.remove();
    verdictRow.remove();
  }
  return { update, destroy };
}

// public/elements/depthAux.js
function cssVar2(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}
function markerModel(rl, previewState, activeGroup) {
  const x = projectedX(rl.reference, rl.u);
  const scenario = previewState?.dirty && previewState.scenario?.reliable === true ? previewState.scenario : null;
  const mintX = scenario ? projectedX(scenario.reference, scenario.u) : null;
  const useMint = activeGroup === "mint" && mintX !== null;
  return { x, mintX, activeX: useMint ? mintX : x, activeBr: useMint ? scenario.br : rl.br };
}
function mount3(root, ctx) {
  const container = document.createElement("div");
  container.className = "sw-depth-aux";
  container.innerHTML = `
    <div class="sw-aux-bar-outer" style="position:relative;">
      <div class="sw-aux-bar-wrap">
        <div class="sw-aux-gradient"></div>
        <div class="sw-aux-viewport-frame"></div>
        <div class="sw-aux-ticks" style="position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;overflow:visible;"></div>
        <div class="sw-aux-marker sw-aux-marker-amber" style="display:none;"></div>
        <div class="sw-aux-marker sw-aux-marker-mint" style="display:none;"></div>
      </div>
    </div>
  `;
  root.appendChild(container);
  const barWrap = container.querySelector(".sw-aux-bar-wrap");
  const gradientEl = container.querySelector(".sw-aux-gradient");
  const frameEl = container.querySelector(".sw-aux-viewport-frame");
  const amberMarkerEl = container.querySelector(".sw-aux-marker-amber");
  const mintMarkerEl = container.querySelector(".sw-aux-marker-mint");
  const ticksEl = container.querySelector(".sw-aux-ticks");
  const MARKER_OVERLAP_PX = 4;
  function markersOverlap() {
    return Math.abs(amberMarkerEl.offsetLeft - mintMarkerEl.offsetLeft) < MARKER_OVERLAP_PX;
  }
  function handleMarkerClick(clickedGroup) {
    if (markersOverlap()) {
      activeGroup = activeGroup === "mint" ? "amber" : "mint";
    } else {
      activeGroup = clickedGroup;
    }
    ctx.bus.dispatchEvent(new CustomEvent("sw-active-group", { detail: { activeGroup } }));
    if (lastSnapshot) renderBar(lastSnapshot);
  }
  amberMarkerEl.addEventListener("click", () => handleMarkerClick("amber"));
  mintMarkerEl.addEventListener("click", () => handleMarkerClick("mint"));
  let resizeObserver = null;
  let previousDomainMax = null;
  let prevSegment = null;
  let previewState = null;
  let lastSnapshot = null;
  let activeGroup = "amber";
  function syncToChartArea() {
    const heroChart = ctx.charts.hero;
    if (!heroChart?.chartArea) return;
    const ca = heroChart.chartArea;
    barWrap.style.marginLeft = `${ca.left}px`;
    barWrap.style.width = `${ca.width}px`;
  }
  function setupResizeObserver() {
    const heroCanvas = ctx.charts.hero?.canvas;
    if (!heroCanvas) return;
    resizeObserver = new ResizeObserver(() => syncToChartArea());
    resizeObserver.observe(heroCanvas);
  }
  const zoneShallow = cssVar2(container, "--zone-shallow", "#3f8a6a");
  const zoneSweet = cssVar2(container, "--zone-sweet", "#4fe0b0");
  const zoneDeep = cssVar2(container, "--zone-deep", "#ffc24d");
  const zoneWall = cssVar2(container, "--zone-wall", "#ff7566");
  function buildZonesGradient(entryPct, sweetPct, exitPct, wallPct) {
    return `linear-gradient(90deg, ${zoneShallow} 0%, ${zoneSweet} ${sweetPct}%, ${zoneDeep} ${exitPct}%, ${zoneWall} ${wallPct}%)`;
  }
  function buildLabelsHTML(entryPct, sweetPct, exitPct, wallPct, barWidth) {
    const labels = [];
    labels.push(`<span class="sw-aux-label-ext-left">shallow</span>`);
    labels.push(`<span class="sw-aux-label-ext-right">wall</span>`);
    if (barWidth >= 120) {
      const sweetMid = ((entryPct + exitPct) / 2).toFixed(1);
      const deepMid = ((exitPct + wallPct) / 2).toFixed(1);
      labels.push(`<span class="sw-aux-zone-label" style="left:${sweetMid}%;color:var(--sw-on-fill, #052018)">sweet</span>`);
      labels.push(`<span class="sw-aux-zone-label" style="left:${deepMid}%;color:var(--sw-on-fill, #3a2a08)">deep</span>`);
    }
    return labels.join("");
  }
  function renderBar(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    const capabilities = snapshot?.capabilities;
    const available = capabilities?.eoqLandmarks?.available === true;
    if (!available || !rl) {
      gradientEl.style.background = "var(--sw-groove, linear-gradient(90deg, #0a0d10 0%, #141a1e 40%, #0e1215 100%))";
      gradientEl.style.backgroundSize = "";
      gradientEl.style.animation = "";
      amberMarkerEl.style.display = "none";
      mintMarkerEl.style.display = "none";
      frameEl.style.display = "none";
      ticksEl.innerHTML = "";
      syncToChartArea();
      return;
    }
    const { xBrAmberL, xSweet, xBrAmberR, xBrRedR } = rl;
    const wallP = rl.wallP ?? 1 + rl.C_RATIO;
    const currentSegment = snapshot?.status?.segment ?? null;
    if (currentSegment !== prevSegment) {
      previousDomainMax = null;
      prevSegment = currentSegment;
    }
    const marker = markerModel(rl, previewState, activeGroup);
    const hasMint = marker.mintX !== null;
    const x = marker.x;
    const viewport = computeEoqViewport({ wallP, xCurrent: x, previousDomainMax, previewX: marker.mintX, origin: rl.reference?.a });
    previousDomainMax = viewport.actualDomainMax;
    const overviewDomain = { minX: viewport.overviewDomain.min, maxX: viewport.overviewDomain.max };
    const positions2 = computeLandmarkPositions({ domain: overviewDomain, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP, x });
    gradientEl.style.backgroundSize = "";
    gradientEl.style.animation = "";
    gradientEl.style.background = buildZonesGradient(
      positions2.brAmberLPct,
      positions2.sweetPct,
      positions2.brRedRPct,
      positions2.wallPct
    );
    frameEl.style.display = "";
    frameEl.style.left = `${viewport.viewportPct.left.toFixed(1)}%`;
    frameEl.style.width = `${(viewport.viewportPct.right - viewport.viewportPct.left).toFixed(1)}%`;
    const barWidth = barWrap.offsetWidth || 200;
    ticksEl.innerHTML = buildLabelsHTML(
      positions2.brAmberLPct,
      positions2.sweetPct,
      positions2.brRedRPct,
      positions2.wallPct,
      barWidth
    );
    const overviewRange = viewport.overviewDomain.max - viewport.overviewDomain.min;
    const toPct = (xVal) => overviewRange > 0 ? Math.max(0, Math.min(100, (xVal - viewport.overviewDomain.min) / overviewRange * 100)) : 0;
    const amberPct = toPct(x);
    amberMarkerEl.style.display = "";
    amberMarkerEl.style.left = `${amberPct.toFixed(1)}%`;
    amberMarkerEl.style.opacity = hasMint && activeGroup === "mint" ? "0.35" : "1";
    amberMarkerEl.style.pointerEvents = hasMint ? "auto" : "none";
    if (hasMint) {
      const mintPct = toPct(marker.mintX);
      mintMarkerEl.style.display = "";
      mintMarkerEl.style.left = `${mintPct.toFixed(1)}%`;
      mintMarkerEl.style.opacity = activeGroup === "amber" ? "0.35" : "1";
      mintMarkerEl.style.pointerEvents = "auto";
    } else {
      mintMarkerEl.style.display = "none";
    }
    const activeX = marker.activeX;
    const activeMarkerEl = activeGroup === "mint" && hasMint ? mintMarkerEl : amberMarkerEl;
    const inactiveMarkerEl = activeGroup === "mint" && hasMint ? amberMarkerEl : mintMarkerEl;
    const brVal = marker.activeBr;
    const brSuffix = Number.isFinite(brVal) ? ` \xB7 b+${Math.floor(brVal * 100)}%` : "";
    activeMarkerEl.innerHTML = `<span class="sw-aux-flag">x\u0302 <b>${activeX.toFixed(2)}\xD7</b>${brSuffix}</span>`;
    inactiveMarkerEl.innerHTML = "";
    syncToChartArea();
  }
  function onBucketPreview(e) {
    previewState = e.detail ?? null;
    if (lastSnapshot) renderBar(lastSnapshot);
  }
  function onActiveGroup(e) {
    const newGroup = e.detail?.activeGroup ?? "amber";
    if (newGroup === activeGroup) return;
    activeGroup = newGroup;
    if (lastSnapshot) renderBar(lastSnapshot);
  }
  ctx.bus.addEventListener("sw-bucket-preview", onBucketPreview);
  ctx.bus.addEventListener("sw-active-group", onActiveGroup);
  function update(snapshot) {
    lastSnapshot = snapshot;
    if (!resizeObserver) setupResizeObserver();
    renderBar(snapshot);
  }
  function destroy() {
    ctx.bus.removeEventListener("sw-bucket-preview", onBucketPreview);
    ctx.bus.removeEventListener("sw-active-group", onActiveGroup);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    container.remove();
  }
  return { update, destroy };
}

// public/lib/uiConstants.js
var DONUT_CIRCUMFERENCE = 88;
var HOVER_LINE_COLOR = "#6cc6f0";
var COPY_FEEDBACK_MS = 1500;
var OTHERS_DRIFT_WARN_PCT = 0.02;
var MAG_VISIBLE_TICKS = 5;
var CHURN_ELEVATED_THRESHOLD = 3;
var CHURN_STRUGGLING_THRESHOLD = 5;
var CHURN_STRUGGLING_REREADS = 2;
var WASTE_FLOOR = 2500;
var MAX_TOUCH_MARKERS = 64;

// public/elements/burnMeter.js
function mount4(root, _ctx) {
  const container = document.createElement("div");
  container.className = "sw-burn-meter";
  container.innerHTML = `
    <div>
      <span class="lab">Carry rent</span>
      <div class="sub">break-even meter \xB7 Karlin 1990</div>
    </div>
    <div class="bar-group cycle-group">
      <span class="bar-name">cycle</span>
      <div class="bar-inline">
        <div class="bar-track"><div class="bar-fill cycle" style="width:0%"></div></div>
        <div class="bar-tail"><span class="bar-inline-value">\u2014</span></div>
      </div>
    </div>
    <div class="bar-group depth-group disabled">
      <span class="bar-name">reminder</span>
      <div class="bar-with-mag">
        <div class="bar-track">
          <div class="bar-fill depth" style="width:0%"></div>
          <div class="bar-ticks"></div>
        </div>
        <div class="mag-tail"><div class="mag-ticks"></div></div>
      </div>
      <div class="bar-detail">Awaiting measurement \xB7 reminder inactive</div>
    </div>
  `;
  root.appendChild(container);
  const cycleFill = container.querySelector(".bar-fill.cycle");
  const cycleValue = container.querySelector(".cycle-group .bar-inline-value");
  const depthGroup = container.querySelector(".depth-group");
  const depthFill = container.querySelector(".bar-fill.depth");
  const depthTicks = container.querySelector(".bar-ticks");
  const magTicks = container.querySelector(".mag-ticks");
  const depthDetail = container.querySelector(".depth-group .bar-detail");
  let _prevTickCount = -1;
  function renderTickSegments(n) {
    const count = Math.max(0, Math.min(20, Math.round(n) || 0));
    if (count === _prevTickCount) return;
    _prevTickCount = count;
    depthTicks.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const seg = document.createElement("div");
      seg.className = "bar-tick-segment";
      depthTicks.appendChild(seg);
    }
  }
  let _prevMagKey = null;
  function renderMagazine(lapCount, hot) {
    const spent = Math.max(0, lapCount || 0);
    const visible = Math.min(spent, MAG_VISIBLE_TICKS);
    const key = `${spent}:${hot}`;
    if (key === _prevMagKey) return;
    _prevMagKey = key;
    magTicks.innerHTML = "";
    for (let i = 0; i < MAG_VISIBLE_TICKS; i++) {
      const t = document.createElement("div");
      t.className = "mag-tick" + (i < visible ? " spent" : "") + (i < visible && hot ? " hot" : "");
      magTicks.appendChild(t);
    }
    let ov = container.querySelector(".mag-overflow");
    if (spent > MAG_VISIBLE_TICKS) {
      if (!ov) {
        ov = document.createElement("span");
        ov.className = "mag-overflow";
        container.querySelector(".mag-tail").appendChild(ov);
      }
      ov.textContent = `+${spent - MAG_VISIBLE_TICKS}`;
    } else if (ov) {
      ov.remove();
    }
  }
  const EMPTY_RM = { cycleProgress: 0, depthActive: false, depthProgress: 0, backstopInterval: null, backstopLapCount: 0, depthHot: false };
  function update(snapshot) {
    const rm = snapshot?.status?.rateLamp?.rentMeter || EMPTY_RM;
    const cyclePct = Math.round(Math.min(1, Math.max(0, rm.cycleProgress ?? 0)) * 100);
    cycleFill.style.width = `${cyclePct}%`;
    cycleValue.textContent = `${cyclePct}%`;
    if (rm.depthActive) {
      depthGroup.classList.remove("disabled");
      const depthPct = Math.round(Math.min(1, Math.max(0, rm.depthProgress ?? 0)) * 100);
      depthFill.className = "bar-fill " + (rm.depthHot ? "depth-hot" : "depth");
      depthFill.style.width = `${depthPct}%`;
      renderTickSegments(rm.backstopInterval);
      renderMagazine(rm.backstopLapCount, rm.depthHot);
      depthDetail.textContent = `Next reminder: ${depthPct}%`;
    } else {
      depthGroup.classList.add("disabled");
      depthFill.style.width = "0%";
      renderTickSegments(0);
      renderMagazine(0, false);
      depthDetail.textContent = "Awaiting measurement \xB7 reminder inactive";
    }
  }
  function destroy() {
    container.remove();
  }
  return { update, destroy };
}

// public/chart-helpers.js
var RATCHET_Y_INIT = 2e5;
var RATCHET_Y_CAP = 1e6;
function computeYRatchet(currentRatchetY, yMax) {
  let r = currentRatchetY;
  while (r < RATCHET_Y_CAP && yMax > r * 0.8) {
    r = Math.min(Math.ceil(r * 1.5), RATCHET_Y_CAP);
  }
  return r;
}
function computeYMax(hist) {
  let yMax = 1;
  for (const p of hist) {
    const eL = Number.isFinite(p.L) ? p.L : 0;
    if (eL > yMax) yMax = eL;
  }
  return yMax;
}
function buildProjectionData(points, lastGEma, currentRatchetX, currentRatchetY) {
  if (points.length === 0) return [];
  const slope = lastGEma > 0 ? lastGEma : points[points.length - 1]?.g > 0 ? points[points.length - 1].g : 0;
  if (slope <= 0) return [];
  const lastTurn = points.length;
  const lastL = points[points.length - 1].L;
  let effectiveRatchetX = currentRatchetX;
  if (effectiveRatchetX - lastTurn < 5) {
    effectiveRatchetX = lastTurn + 20;
  }
  const projectedY = lastL + slope * (effectiveRatchetX - lastTurn);
  const clampedY = Math.min(projectedY, currentRatchetY);
  const endX = clampedY < projectedY ? lastTurn + (clampedY - lastL) / slope : effectiveRatchetX;
  return [
    { x: lastTurn, y: lastL },
    { x: endX, y: clampedY }
  ];
}
function buildMissMarkers(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].miss) out.push({ x: i + 1, y: 0, historyIndex: i });
  }
  return out;
}

// public/lib/crosshairHelpers.js
function computeCrosshairLabel(snappedTurn, currentPoints, lastGEma) {
  const lastDataTurn = currentPoints.length;
  if (snappedTurn <= lastDataTurn && currentPoints[snappedTurn - 1]) {
    const l = currentPoints[snappedTurn - 1].L;
    return `turn ${snappedTurn} \xB7 L=${Math.round(l / 1e3)}k`;
  }
  if (lastDataTurn === 0) return null;
  const slope = lastGEma > 0 ? lastGEma : currentPoints[lastDataTurn - 1]?.g > 0 ? currentPoints[lastDataTurn - 1].g : 0;
  if (slope <= 0) return null;
  const lastL = currentPoints[lastDataTurn - 1].L;
  const projL = lastL + slope * (snappedTurn - lastDataTurn);
  return `projected L=${Math.round(projL / 1e3)}k`;
}
function computeLabelOffset(pixelX, caRight, labelWidth) {
  const fromRight = caRight - pixelX;
  return fromRight < 80 ? -(labelWidth + 6) : 6;
}

// public/elements/historyChart.js
function cssVar3(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}
var RATCHET_X_INIT = 100;
function nextXRatchet(current) {
  return current * 2;
}
var G_LIVE_MIN = 1;
function groupBySegment(history) {
  const map3 = /* @__PURE__ */ new Map();
  for (const p of history) {
    const seg = p.segment ?? 0;
    if (!map3.has(seg)) map3.set(seg, []);
    map3.get(seg).push(p);
  }
  return map3;
}
function fitColdStart(points) {
  return points;
}
function pickThresholdLine(currentL, entryL, exitL, redL, colors2) {
  if (entryL != null && currentL < entryL) {
    return { value: entryL, color: colors2.mint, label: `entry ${Math.round(entryL / 1e3)}k` };
  }
  if (exitL != null && currentL < exitL) {
    return { value: exitL, color: colors2.amber, label: `b10 ${Math.round(exitL / 1e3)}k` };
  }
  if (redL != null) {
    return { value: redL, color: colors2.coral, label: `b25 ${Math.round(redL / 1e3)}k` };
  }
  return null;
}
function buildChartConfig(points, ratchetX, ratchetY, thresholdLine, colors2) {
  const labels = points.map((_, i) => i + 1);
  const lData = points.map((p) => p.L);
  const lPointRadius = points.map((_, i) => i === points.length - 1 ? 4 : 0);
  const lPointColor = points.map((_, i) => i === points.length - 1 ? colors2.amber : "transparent");
  const thresholdData = thresholdLine ? [{ x: 1, y: thresholdLine.value }, { x: ratchetX, y: thresholdLine.value }] : [];
  const thresholdColor = thresholdLine?.color ?? colors2.amber;
  const missMarkers = buildMissMarkers(points);
  const thresholdLabelPlugin = {
    id: "thresholdLabels",
    afterDatasetsDraw(chart) {
      const ds = chart.data.datasets[1];
      if (!ds || !ds.data || ds.data.length === 0) return;
      const last = ds.data[ds.data.length - 1];
      const val = typeof last === "object" ? last.y : last;
      if (val == null || !Number.isFinite(val)) return;
      const yScale = chart.scales.y;
      if (val > yScale.max || val < yScale.min) return;
      const ca = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillStyle = ds.borderColor;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(chart._thresholdLabel ?? "", ca.right - 4, yScale.getPixelForValue(val) - 3);
      ctx.restore();
    }
  };
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "L (tokens)",
          data: lData,
          borderColor: colors2.mint,
          backgroundColor: colors2.mintBg,
          borderWidth: 1.8,
          pointRadius: lPointRadius,
          pointBackgroundColor: lPointColor,
          pointBorderColor: lPointColor,
          fill: false,
          tension: 0
        },
        {
          label: "threshold",
          data: thresholdData,
          borderColor: thresholdColor,
          borderWidth: 1.3,
          borderDash: [4, 5],
          pointRadius: 0,
          fill: false,
          tension: 0,
          parsing: false,
          spanGaps: true
        },
        {
          id: "projection",
          label: "projection",
          data: [],
          // populated by mount()'s rebuildChart/updateChart
          borderColor: colors2.txtDim,
          borderWidth: 1.3,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
          parsing: false,
          spanGaps: true
        },
        {
          id: "missMarkers",
          label: "Cache miss",
          data: missMarkers,
          borderColor: colors2.coralAlpha,
          backgroundColor: colors2.coralAlpha,
          pointStyle: "triangle",
          pointRadius: 6,
          pointBorderWidth: 0,
          showLine: false,
          fill: false,
          parsing: false
        }
      ]
    },
    plugins: [thresholdLabelPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          type: "linear",
          min: 1,
          max: ratchetX,
          title: { display: false }
        },
        y: {
          type: "linear",
          min: 0,
          max: ratchetY,
          title: { display: false }
        }
      }
    }
  };
}
function thresholdLinesOf(source, bDefault, anchorL) {
  const here = projectedX(source?.reference, source?.u);
  const toL = (x) => Number.isFinite(x) && Number.isFinite(here) && bDefault > 0 ? anchorL + bDefault * (x - here) : null;
  return { entry: toL(source?.xBrAmberL), exit: toL(source?.xBrAmberR), red: toL(source?.xBrRedR) };
}
function shownThresholdLinesOf(defaultLandmarks, previewState, activeGroup, anchorL) {
  const scenario = previewState?.dirty && previewState.scenario?.reliable === true && previewState.scenario.reference ? previewState.scenario : null;
  return activeGroup === "mint" && scenario ? thresholdLinesOf(scenario, scenario.bDefault, anchorL) : thresholdLinesOf(defaultLandmarks, defaultLandmarks?.B_default, anchorL);
}
function mount5(root, ctx) {
  let segments = /* @__PURE__ */ new Map();
  let segmentKeys = [];
  let currentPage = 0;
  let follow = true;
  let chart = null;
  let ratchetX = RATCHET_X_INIT;
  let ratchetY = RATCHET_Y_INIT;
  let defaultLandmarks = null;
  let previewState = null;
  let activeGroup = "amber";
  const activeLines = (anchorL) => shownThresholdLinesOf(defaultLandmarks, previewState, activeGroup, anchorL);
  let lastGEma = null;
  let hoverTouchMap = null;
  root.innerHTML = `
    <h3 class="sw-history-header">
      <span>Usage history</span>
      <span class="sw-history-actions">
        <span class="pager">
          <button class="sw-history-prev" disabled>\u2039</button>
          segment <b class="sw-history-page-num">\u2014</b> / <span class="sw-history-page-total">\u2014</span>
          <button class="sw-history-next" disabled>\u203A</button>
        </span>
        <span class="sw-history-anchor"></span>
      </span>
    </h3>
    <div class="sw-history-subtitle">Raw context tokens (L) across turns in this segment \xB7 axis auto-ranges</div>
    <div class="sw-history-container">
      <canvas class="sw-history-canvas"></canvas>
      <div class="sw-history-crosshair" style="display:none;">
        <div class="sw-crosshair-line"></div>
        <div class="sw-crosshair-label"></div>
      </div>
    </div>
    <div class="sw-history-legend">
      <span><i class="sw-legend-l"></i>L tokens</span>
      <span><i class="sw-legend-threshold"></i>next threshold</span>
      <span><i class="sw-legend-proj"></i>projection</span>
      <span><i class="sw-legend-miss"></i>cache miss</span>
    </div>
    <div class="sw-history-footnote">
      <span>calls <b class="sw-fn-calls">\u2014</b></span>
      <span>g\u2091 <b class="sw-fn-g">\u2014</b></span>
      <span>stock L <b class="sw-fn-l">\u2014</b></span>
      <span>position basis B <b class="sw-fn-base">\u2014</b></span>
    </div>
  `;
  const canvas = root.querySelector(".sw-history-canvas");
  const crosshairEl = root.querySelector(".sw-history-crosshair");
  const crosshairLine = root.querySelector(".sw-crosshair-line");
  const crosshairLabel = root.querySelector(".sw-crosshair-label");
  const prevBtn = root.querySelector(".sw-history-prev");
  const nextBtn = root.querySelector(".sw-history-next");
  const pageNumEl = root.querySelector(".sw-history-page-num");
  const pageTotalEl = root.querySelector(".sw-history-page-total");
  const fnG = root.querySelector(".sw-fn-g");
  const fnCalls = root.querySelector(".sw-fn-calls");
  const fnL = root.querySelector(".sw-fn-l");
  const fnBase = root.querySelector(".sw-fn-base");
  const container = root.querySelector(".sw-history-container");
  const hoverLineEl = document.createElement("div");
  hoverLineEl.className = "sw-history-hoverline";
  hoverLineEl.style.cssText = `display:none;position:absolute;top:0;height:100%;border-left:1px dashed ${HOVER_LINE_COLOR};pointer-events:none;`;
  const hoverLineTag = document.createElement("span");
  hoverLineTag.style.cssText = 'position:absolute;top:0;left:2px;font-size:9px;font-family:"JetBrains Mono",monospace;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;color:' + HOVER_LINE_COLOR + ";";
  hoverLineEl.appendChild(hoverLineTag);
  container.appendChild(hoverLineEl);
  const touchLinePool = [];
  function getTouchLine(index2, color2) {
    if (index2 >= touchLinePool.length) {
      const el2 = document.createElement("div");
      el2.className = "sw-history-touchline";
      el2.style.cssText = "display:none;position:absolute;top:0;height:100%;border-left:1px dashed;pointer-events:none;z-index:1;opacity:0.35;";
      container.appendChild(el2);
      touchLinePool.push(el2);
    }
    const el = touchLinePool[index2];
    el.style.borderLeftColor = color2;
    return el;
  }
  function hideTouchLines() {
    for (const el of touchLinePool) el.style.display = "none";
  }
  let currentPoints = [];
  const mint = cssVar3(root, "--mint", "#4fe0b0");
  const amber = cssVar3(root, "--amber", "#ffc24d");
  const coral = cssVar3(root, "--coral", "#ff7566");
  const txtDim = cssVar3(root, "--txt-dim", "#93a1ab");
  const sky = cssVar3(root, "--sky", "#49c5e0");
  const colors2 = {
    mint,
    mintBg: mint.startsWith("#") ? mint + "0F" : "rgba(79,224,176,0.06)",
    mintDim: mint.startsWith("#") ? mint + "22" : "rgba(79,224,176,0.13)",
    amber,
    coral,
    coralAlpha: coral.startsWith("#") ? coral + "80" : "rgba(255,117,102,0.5)",
    sky,
    txtDim,
    highlight: cssVar3(root, "--sw-highlight", "#ffffff")
  };
  root.querySelector(".sw-legend-l").style.background = mint;
  const threshSwatch = root.querySelector(".sw-legend-threshold");
  threshSwatch.style.cssText = `height:1.5px;border-top:2px dashed ${amber};background:none;width:14px;`;
  const missSwatch = root.querySelector(".sw-legend-miss");
  missSwatch.style.cssText = `width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:7px solid ${coral};background:none;border-radius:0;`;
  const projSwatch = root.querySelector(".sw-legend-proj");
  projSwatch.style.cssText = `border-top:2px dashed ${txtDim};background:none;width:14px;height:1.5px;`;
  const handlePrev = () => {
    if (currentPage > 0) {
      currentPage--;
      follow = currentPage === segmentKeys.length - 1;
      rebuildChart();
    }
  };
  const handleNext = () => {
    if (currentPage < segmentKeys.length - 1) {
      currentPage++;
      follow = currentPage === segmentKeys.length - 1;
      rebuildChart();
    }
  };
  prevBtn.addEventListener("click", handlePrev);
  nextBtn.addEventListener("click", handleNext);
  let lastSnappedTurn = null;
  function onChartMouseMove(e) {
    if (!chart) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const ca = chart.chartArea;
    if (!ca || mouseX < ca.left || mouseX > ca.right) {
      crosshairEl.style.display = "none";
      lastSnappedTurn = null;
      return;
    }
    const xValue = chart.scales.x.getValueForPixel(mouseX);
    const snappedTurn = Math.max(1, Math.round(xValue));
    if (snappedTurn === lastSnappedTurn) return;
    lastSnappedTurn = snappedTurn;
    const currentPoints2 = segmentKeys.length > 0 ? segments.get(segmentKeys[currentPage]) || [] : [];
    const labelText = computeCrosshairLabel(snappedTurn, currentPoints2, lastGEma);
    if (labelText === null) {
      crosshairEl.style.display = "none";
      return;
    }
    crosshairEl.style.display = "";
    const pixelX = chart.scales.x.getPixelForValue(snappedTurn);
    crosshairLine.style.left = `${pixelX}px`;
    crosshairLine.style.top = `${ca.top}px`;
    crosshairLine.style.height = `${ca.bottom - ca.top}px`;
    crosshairLabel.textContent = labelText;
    const labelOffset = computeLabelOffset(pixelX, ca.right, crosshairLabel.offsetWidth);
    crosshairLabel.style.left = `${pixelX + labelOffset}px`;
    const lastDataTurn = currentPoints2.length;
    let yPx;
    if (snappedTurn <= lastDataTurn && currentPoints2[snappedTurn - 1]) {
      yPx = chart.scales.y.getPixelForValue(currentPoints2[snappedTurn - 1].L);
    } else {
      const slope = lastGEma > 0 ? lastGEma : currentPoints2[lastDataTurn - 1]?.g || 0;
      const lastL = currentPoints2[lastDataTurn - 1]?.L || 0;
      yPx = chart.scales.y.getPixelForValue(lastL + slope * (snappedTurn - lastDataTurn));
    }
    const clampedY = Math.max(ca.top, Math.min(ca.bottom - 20, yPx - 10));
    crosshairLabel.style.top = `${clampedY}px`;
    const ds0 = chart.data.datasets[0];
    const prevHighlight = ds0._crosshairIdx;
    const idx = snappedTurn - 1;
    const isDataPoint = idx >= 0 && idx < lastDataTurn;
    const isCurrent = idx === lastDataTurn - 1;
    if (prevHighlight != null && prevHighlight !== idx) {
      ds0.pointRadius[prevHighlight] = prevHighlight === lastDataTurn - 1 ? 4 : 0;
      ds0.pointBackgroundColor[prevHighlight] = prevHighlight === lastDataTurn - 1 ? colors2.amber : "transparent";
    }
    if (isDataPoint) {
      ds0.pointRadius[idx] = 4;
      ds0.pointBackgroundColor[idx] = colors2.highlight;
      ds0._crosshairIdx = idx;
      chart.update("none");
    } else {
      ds0._crosshairIdx = null;
      if (prevHighlight != null) chart.update("none");
    }
  }
  function onChartMouseLeave() {
    crosshairEl.style.display = "none";
    lastSnappedTurn = null;
    if (chart) {
      const ds0 = chart.data.datasets[0];
      const idx = ds0._crosshairIdx;
      if (idx != null) {
        const lastDataTurn = ds0.pointRadius?.length || 0;
        ds0.pointRadius[idx] = idx === lastDataTurn - 1 ? 4 : 0;
        ds0.pointBackgroundColor[idx] = idx === lastDataTurn - 1 ? colors2.amber : "transparent";
        ds0._crosshairIdx = null;
        chart.update("none");
      }
    }
  }
  canvas.addEventListener("mousemove", onChartMouseMove);
  canvas.addEventListener("mouseleave", onChartMouseLeave);
  function onBucketHover(e) {
    const { lastCallSeq, name, touchSeqs, tier, group } = e.detail || {};
    if (lastCallSeq == null || !chart) {
      hoverLineEl.style.display = "none";
      hideTouchLines();
      if (hoverTouchMap) {
        hoverTouchMap = null;
        chart?.update("none");
      }
      return;
    }
    const segOffset = currentPoints.length > 0 ? (currentPoints[0].foldedSeq ?? 1) - 1 : 0;
    const localSeq = lastCallSeq - segOffset;
    if (localSeq >= 1 && localSeq <= currentPoints.length) {
      const px = chart.scales.x.getPixelForValue(localSeq);
      const ca = chart.chartArea;
      hoverLineEl.style.display = "";
      hoverLineEl.style.left = `${px}px`;
      hoverLineEl.style.top = `${ca.top}px`;
      hoverLineEl.style.height = `${ca.bottom - ca.top}px`;
      const truncated = touchSeqs && touchSeqs.length > MAX_TOUCH_MARKERS;
      const baseName = name ? name.split("/").pop() || name : "";
      hoverLineTag.textContent = truncated ? `${baseName} (last ${MAX_TOUCH_MARKERS})` : baseName;
    } else {
      hoverLineEl.style.display = "none";
    }
    hideTouchLines();
    if (group === "output" && touchSeqs && touchSeqs.length > 0 && chart) {
      const shown = touchSeqs.slice(-MAX_TOUCH_MARKERS);
      const tierColor = tier === "coral" ? colors2.coral : tier === "amber" ? colors2.amber : colors2.mint;
      const ca = chart.chartArea;
      let lineIdx = 0;
      for (const entry of shown) {
        const seq = typeof entry === "number" ? entry : entry.seq;
        const local = seq - segOffset;
        if (local < 1 || local > currentPoints.length) continue;
        const px = chart.scales.x.getPixelForValue(local);
        const el = getTouchLine(lineIdx++, tierColor);
        el.style.display = "";
        el.style.left = `${px}px`;
        el.style.top = `${ca.top}px`;
        el.style.height = `${ca.bottom - ca.top}px`;
      }
      if (hoverTouchMap) {
        hoverTouchMap = null;
        chart.update("none");
      }
    } else {
      const newMap = /* @__PURE__ */ new Map();
      if (touchSeqs && touchSeqs.length > 0) {
        for (const entry of touchSeqs) {
          const seq = typeof entry === "number" ? entry : entry.seq;
          const mode = typeof entry === "object" ? entry.mode : null;
          const local = seq - segOffset;
          if (local >= 1 && local <= currentPoints.length) {
            if (mode === "w" || !newMap.has(local)) newMap.set(local, mode);
          }
        }
      }
      hoverTouchMap = newMap.size > 0 ? newMap : null;
      chart.update("none");
    }
  }
  ctx.bus.addEventListener("sw-bucket-hover", onBucketHover);
  function onBucketPreview(e) {
    previewState = e.detail ?? null;
    redrawThresholdLine();
  }
  function onActiveGroup(e) {
    const newGroup = e.detail?.activeGroup ?? "amber";
    if (newGroup === activeGroup) return;
    activeGroup = newGroup;
    redrawThresholdLine();
  }
  function redrawThresholdLine() {
    if (!chart || !follow) return;
    const currentL = currentPoints.length > 0 ? currentPoints[currentPoints.length - 1]?.L ?? 0 : 0;
    const lines = activeLines(currentL);
    const tLine = pickThresholdLine(currentL, lines.entry, lines.exit, lines.red, colors2);
    chart.data.datasets[1].data = tLine ? [{ x: 1, y: tLine.value }, { x: ratchetX, y: tLine.value }] : [];
    chart.data.datasets[1].borderColor = tLine?.color ?? colors2.amber;
    chart._thresholdLabel = tLine?.label ?? "";
    chart.update("none");
  }
  ctx.bus.addEventListener("sw-bucket-preview", onBucketPreview);
  ctx.bus.addEventListener("sw-active-group", onActiveGroup);
  function updateControls() {
    const total = segmentKeys.length;
    prevBtn.disabled = currentPage <= 0;
    nextBtn.disabled = currentPage >= total - 1;
    if (total > 0) {
      pageNumEl.textContent = currentPage + 1;
      pageTotalEl.textContent = total;
    } else {
      pageNumEl.textContent = "\u2014";
      pageTotalEl.textContent = "\u2014";
    }
  }
  function updateFootnote(points) {
    if (!points || points.length === 0) {
      fnG.textContent = "\u2014";
      fnCalls.textContent = "\u2014";
      fnL.textContent = "\u2014";
      fnBase.textContent = "\u2014";
      return;
    }
    const last = points[points.length - 1];
    const gVal = lastGEma >= G_LIVE_MIN ? lastGEma : last?.g;
    fnG.textContent = gVal != null ? Math.round(gVal).toLocaleString() : "\u2014";
    fnCalls.textContent = points.length;
    fnL.textContent = Number.isFinite(last?.L) ? `${Math.round(last.L / 1e3)}k` : "\u2014";
    fnBase.textContent = Number.isFinite(last?.bDefault) ? `${Math.round(last.bDefault / 1e3)}k` : "\u2014";
  }
  function computeRatchet(points) {
    const yMax = computeYMax(points);
    ratchetY = computeYRatchet(ratchetY, yMax);
    const xMax = points.length;
    while (ratchetX < xMax) {
      ratchetX = nextXRatchet(ratchetX);
    }
  }
  function rebuildChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    hoverTouchMap = null;
    ratchetX = RATCHET_X_INIT;
    ratchetY = RATCHET_Y_INIT;
    const raw = segmentKeys.length > 0 ? segments.get(segmentKeys[currentPage]) || [] : [];
    const points = fitColdStart(raw);
    currentPoints = points;
    if (points.length === 0) {
      if (!chart) {
        const config2 = buildChartConfig([], ratchetX, ratchetY, null, colors2);
        chart = new auto_default(canvas, config2);
        ctx.charts.history = chart;
      }
      updateControls();
      updateFootnote(points);
      return;
    }
    computeRatchet(points);
    const currentL = points[points.length - 1]?.L ?? 0;
    const lines = follow ? activeLines(currentL) : { entry: null, exit: null, red: null };
    const tLine = pickThresholdLine(currentL, lines.entry, lines.exit, lines.red, colors2);
    const config = buildChartConfig(points, ratchetX, ratchetY, tLine, colors2);
    chart = new auto_default(canvas, config);
    chart._thresholdLabel = tLine?.label ?? "";
    chart.data.datasets[0].segment = {
      borderColor: (ctx2) => {
        if (!hoverTouchMap) return colors2.mint;
        const mode = hoverTouchMap.get(ctx2.p1DataIndex + 1);
        if (mode === "w") return colors2.amber;
        if (mode === "r") return colors2.sky;
        return colors2.mintDim;
      }
    };
    const projDs = chart.data.datasets.find((d) => d.id === "projection");
    if (projDs) {
      projDs.data = buildProjectionData(points, lastGEma, ratchetX, ratchetY);
      chart.options.scales.x.max = Math.max(ratchetX, projDs.data?.[1]?.x ?? 0);
      chart.update("none");
    }
    ctx.charts.history = chart;
    updateControls();
    updateFootnote(points);
    lastSnappedTurn = null;
  }
  function updateChart(points) {
    if (!chart || !points || points.length === 0) return;
    const prevRX = ratchetX;
    const prevRY = ratchetY;
    computeRatchet(points);
    const labels = points.map((_, i) => i + 1);
    const lData = points.map((p) => p.L);
    const lPointRadius = points.map((_, i) => i === points.length - 1 ? 4 : 0);
    const lPointColor = points.map((_, i) => i === points.length - 1 ? colors2.amber : "transparent");
    const currentL = points[points.length - 1]?.L ?? 0;
    const lines = follow ? activeLines(currentL) : { entry: null, exit: null, red: null };
    const tLine = pickThresholdLine(currentL, lines.entry, lines.exit, lines.red, colors2);
    const thresholdData = tLine ? [{ x: 1, y: tLine.value }, { x: ratchetX, y: tLine.value }] : [];
    const missMarkers = buildMissMarkers(points);
    chart.data.labels = labels;
    chart.data.datasets[0].data = lData;
    chart.data.datasets[0].pointRadius = lPointRadius;
    chart.data.datasets[0].pointBackgroundColor = lPointColor;
    chart.data.datasets[0].pointBorderColor = lPointColor;
    const hiIdx = chart.data.datasets[0]._crosshairIdx;
    if (hiIdx != null && hiIdx < lPointRadius.length) {
      lPointRadius[hiIdx] = 4;
      lPointColor[hiIdx] = colors2.highlight;
    }
    chart.data.datasets[1].data = thresholdData;
    chart.data.datasets[1].borderColor = tLine?.color ?? colors2.amber;
    chart._thresholdLabel = tLine?.label ?? "";
    const projDs = chart.data.datasets.find((d) => d.id === "projection");
    if (projDs) {
      projDs.data = buildProjectionData(points, lastGEma, ratchetX, ratchetY);
    }
    const missDs = chart.data.datasets.find((d) => d.id === "missMarkers");
    if (missDs) missDs.data = missMarkers;
    const projEndX = projDs?.data?.[1]?.x ?? 0;
    chart.options.scales.x.max = Math.max(ratchetX, projEndX);
    if (ratchetY !== prevRY) chart.options.scales.y.max = ratchetY;
    currentPoints = points;
    chart.update("none");
    updateControls();
    updateFootnote(points);
  }
  function update(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    defaultLandmarks = rl ?? null;
    if (rl?.gEma != null && Number.isFinite(rl.gEma)) {
      lastGEma = rl.gEma;
    }
    const history = snapshot.history || [];
    const newSegments = groupBySegment(history);
    const newKeys = Array.from(newSegments.keys()).sort((a, b) => a - b);
    const keysChanged = newKeys.length !== segmentKeys.length || newKeys.some((k, i) => k !== segmentKeys[i]);
    segments = newSegments;
    segmentKeys = newKeys;
    if (segmentKeys.length === 0) {
      if (!chart) {
        const config = buildChartConfig([], ratchetX, ratchetY, null, colors2);
        chart = new auto_default(canvas, config);
        ctx.charts.history = chart;
      }
      updateControls();
      updateFootnote([]);
      return;
    }
    if (follow || keysChanged) {
      const latestPage = segmentKeys.length - 1;
      if (follow) {
        if (currentPage !== latestPage) {
          currentPage = latestPage;
          rebuildChart();
          return;
        }
      } else if (keysChanged) {
        if (currentPage >= segmentKeys.length) {
          currentPage = segmentKeys.length - 1;
          follow = true;
          rebuildChart();
          return;
        }
      }
    }
    const points = fitColdStart(segments.get(segmentKeys[currentPage]) || []);
    if (!chart) {
      rebuildChart();
      return;
    }
    updateChart(points);
  }
  function destroy() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    prevBtn.removeEventListener("click", handlePrev);
    nextBtn.removeEventListener("click", handleNext);
    canvas.removeEventListener("mousemove", onChartMouseMove);
    canvas.removeEventListener("mouseleave", onChartMouseLeave);
    ctx.bus.removeEventListener("sw-bucket-hover", onBucketHover);
    ctx.bus.removeEventListener("sw-bucket-preview", onBucketPreview);
    ctx.bus.removeEventListener("sw-active-group", onActiveGroup);
    root.innerHTML = "";
  }
  return { update, destroy };
}

// public/elements/historyDrawer.js
var USER_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="4" r="2"/><path d="M2.5 10c.5-2 1.7-3 3.5-3s3 .9 3.5 3"/></svg>';
var ASSISTANT_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.8v8.4M1.8 6h8.4"/></svg>';
var HISTORY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3zM5.5 5h5M5.5 8h5M5.5 11h3"/></svg>';
var SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
var BROWSE_URL = "/api/turn/browse";
function mount6(root, ctx) {
  let isOpen = false;
  let sections = [];
  let unavailable = false;
  let snapshotGeneration = 0;
  let query = "";
  let expandedKey = null;
  const expandedLabels = /* @__PURE__ */ new Set();
  let destroyed = false;
  const anchor = root.querySelector(".sw-history-anchor");
  if (!anchor) return { update() {
  }, destroy() {
  } };
  const trigger = document.createElement("button");
  trigger.className = "sw-history-trigger";
  trigger.type = "button";
  trigger.innerHTML = `${HISTORY_SVG} History`;
  anchor.appendChild(trigger);
  const countEl = document.createElement("span");
  countEl.className = "sw-history-count";
  const paintCount = () => {
    if (unavailable || sections.length === 0) {
      countEl.remove();
      return;
    }
    countEl.textContent = String(sections.length);
    trigger.appendChild(countEl);
  };
  const scrim = document.createElement("div");
  scrim.className = "sw-history-scrim";
  scrim.setAttribute("aria-hidden", "true");
  ctx.overlayRoot.appendChild(scrim);
  const drawer = document.createElement("aside");
  drawer.className = "sw-history-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "History");
  drawer.setAttribute("aria-modal", "true");
  drawer.innerHTML = `
    <header class="sw-history-head">
      <div class="sw-history-title-row">
        <h2 class="sw-history-title">History</h2>
        <button class="sw-history-close" type="button" aria-label="Close history">\xD7</button>
      </div>
      <label class="sw-history-search">
        ${SEARCH_SVG}
        <input type="search" aria-label="Search history"
               placeholder="Search turns and notes" autocomplete="off">
      </label>
    </header>
    <div class="sw-history-list"></div>
  `;
  ctx.overlayRoot.appendChild(drawer);
  const closeBtn = drawer.querySelector(".sw-history-close");
  const listEl = drawer.querySelector(".sw-history-list");
  const searchEl = drawer.querySelector(".sw-history-search input");
  const rowKey = (label, index2, side) => `${label}:${index2}:${side}`;
  const isSectionOpen = (label) => query !== "" || expandedLabels.has(label);
  function matches(entry) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return `${entry.u_text}
${entry.note ?? ""}`.toLowerCase().includes(needle);
  }
  function createRow(entry, side, key) {
    const isUser = side === "u";
    const body = isUser ? entry.u_text : entry.note ?? "";
    const expandable = body !== "";
    const expanded = expandable && expandedKey === key;
    const row2 = document.createElement("article");
    row2.className = "sw-history-row";
    row2.dataset.role = isUser ? "user" : "assistant";
    row2.dataset.expanded = String(expanded);
    const glyph = document.createElement("span");
    glyph.className = "sw-history-role";
    glyph.setAttribute("role", "img");
    glyph.setAttribute("aria-label", isUser ? "User" : "Assistant");
    glyph.innerHTML = isUser ? USER_SVG : ASSISTANT_SVG;
    row2.appendChild(glyph);
    if (!expandable) {
      const empty = document.createElement("div");
      empty.className = "sw-history-preview";
      row2.appendChild(empty);
      return row2;
    }
    const main = document.createElement("div");
    main.className = "sw-history-main";
    main.setAttribute("role", "button");
    main.setAttribute("tabindex", "0");
    main.setAttribute("aria-expanded", String(expanded));
    const preview = document.createElement("div");
    preview.className = "sw-history-preview";
    preview.textContent = body;
    main.appendChild(preview);
    row2.appendChild(main);
    const detail = document.createElement("div");
    detail.className = "sw-history-detail";
    const copy = document.createElement("div");
    copy.className = "sw-history-copy";
    copy.textContent = body;
    detail.appendChild(copy);
    row2.appendChild(detail);
    const toggle = () => {
      const previous = listEl.querySelector('.sw-history-row[data-expanded="true"]');
      if (previous && previous !== row2) {
        previous.dataset.expanded = "false";
        previous.querySelector(".sw-history-main")?.setAttribute("aria-expanded", "false");
      }
      const next = expandedKey !== key;
      expandedKey = next ? key : null;
      row2.dataset.expanded = String(next);
      main.setAttribute("aria-expanded", String(next));
    };
    main.addEventListener("click", toggle);
    main.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    return row2;
  }
  function createSection({ label, headline }, rows) {
    const section = document.createElement("section");
    section.className = "sw-history-section";
    section.setAttribute("aria-label", label);
    const divider = document.createElement("div");
    divider.className = "sw-history-divider";
    divider.setAttribute("role", "button");
    divider.setAttribute("tabindex", "0");
    const labelEl = document.createElement("strong");
    labelEl.textContent = label;
    divider.appendChild(labelEl);
    section.appendChild(divider);
    const paint = () => {
      const open = isSectionOpen(label);
      section.dataset.expanded = String(open);
      divider.setAttribute("aria-expanded", String(open));
    };
    paint();
    const toggle = () => {
      if (expandedLabels.has(label)) expandedLabels.delete(label);
      else expandedLabels.add(label);
      paint();
    };
    divider.addEventListener("click", toggle);
    divider.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    if (headline !== "") {
      const head = document.createElement("span");
      head.className = "sw-history-headline-head";
      head.setAttribute("aria-hidden", "true");
      head.textContent = headline;
      divider.appendChild(head);
      const block = document.createElement("div");
      block.className = "sw-history-headline";
      block.textContent = headline;
      block.addEventListener("click", toggle);
      section.appendChild(block);
    }
    for (const { entry, index: index2 } of rows) {
      section.appendChild(createRow(entry, "u", rowKey(label, index2, "u")));
      if ((entry.note ?? "") !== "") {
        section.appendChild(createRow(entry, "a", rowKey(label, index2, "a")));
      }
    }
    return section;
  }
  function renderList() {
    listEl.textContent = "";
    if (unavailable) {
      const state = document.createElement("div");
      state.className = "sw-history-empty";
      state.textContent = "History is unavailable right now. Close and reopen the drawer to retry.";
      listEl.appendChild(state);
      return;
    }
    const visible = sections.map((section) => ({
      section,
      rows: section.entries.map((entry, index2) => ({ entry, index: index2 })).filter(({ entry }) => matches(entry))
    })).filter(({ rows }) => rows.length > 0);
    if (visible.length === 0) {
      const state = document.createElement("div");
      state.className = "sw-history-empty";
      state.textContent = query ? `No turns match \u201C${query}\u201D.` : "No stored turns are available.";
      listEl.appendChild(state);
    } else {
      for (const { section, rows } of visible) listEl.appendChild(createSection(section, rows));
    }
    const marker = document.createElement("div");
    marker.className = "sw-history-horizon";
    marker.textContent = "Current-session turns are not included.";
    listEl.appendChild(marker);
  }
  async function fetchSections() {
    try {
      const res = await ctx.request(BROWSE_URL);
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body?.sections) ? body.sections : null;
    } catch {
      return null;
    }
  }
  async function loadSnapshot() {
    const generation = ++snapshotGeneration;
    const next = await fetchSections();
    if (generation !== snapshotGeneration) return;
    unavailable = next === null;
    if (next) sections = next;
  }
  async function openDrawer() {
    if (isOpen) return;
    isOpen = true;
    drawer.classList.add("sw-history-drawer-open");
    scrim.classList.add("sw-history-scrim-visible");
    scrim.setAttribute("aria-hidden", "false");
    document.querySelector(".sw-wrap")?.setAttribute("inert", "");
    searchEl.focus();
    await loadSnapshot();
    if (destroyed) return;
    paintCount();
    if (!isOpen) return;
    const savedScrollTop = listEl.scrollTop;
    renderList();
    requestAnimationFrame(() => {
      listEl.scrollTop = savedScrollTop;
    });
  }
  function closeDrawer() {
    if (!isOpen) return;
    isOpen = false;
    drawer.classList.remove("sw-history-drawer-open");
    scrim.classList.remove("sw-history-scrim-visible");
    scrim.setAttribute("aria-hidden", "true");
    document.querySelector(".sw-wrap")?.removeAttribute("inert");
    trigger.focus();
  }
  trigger.addEventListener("click", openDrawer);
  closeBtn.addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);
  searchEl.addEventListener("input", (event) => {
    query = event.target.value.trim();
    expandedKey = null;
    renderList();
  });
  function onKeydown(event) {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    closeDrawer();
  }
  document.addEventListener("keydown", onKeydown);
  loadSnapshot().then(() => {
    if (!destroyed) paintCount();
  });
  return {
    // One snapshot at mount and one per open (no polling), so a store update is not a reason to
    // refetch.
    update() {
    },
    destroy() {
      destroyed = true;
      document.removeEventListener("keydown", onKeydown);
      document.querySelector(".sw-wrap")?.removeAttribute("inert");
      scrim.remove();
      drawer.remove();
      anchor.textContent = "";
    }
  };
}

// public/lib/churnTier.js
function churnTier({ churn, waste, pureRereads } = {}) {
  const w = waste ?? 0;
  if (w >= WASTE_FLOOR && (pureRereads ?? 0) >= CHURN_STRUGGLING_REREADS) return "coral";
  if (Number.isFinite(churn) && churn > CHURN_STRUGGLING_THRESHOLD && w >= WASTE_FLOOR) return "coral";
  if (Number.isFinite(churn) && churn >= CHURN_ELEVATED_THRESHOLD) return "amber";
  return "mint";
}
var TIER_RANK = { mint: 0, amber: 1, coral: 2 };
function maxChildTier(children) {
  let max = "mint";
  for (const child of children) {
    const t = child.churnTier ?? "mint";
    if (TIER_RANK[t] > TIER_RANK[max]) max = t;
    if (max === "coral") return "coral";
  }
  return max;
}

// public/lib/redaction.js
function redactCmd(cmd) {
  return String(cmd).replace(/\b[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)\s*=\s*\S+/gi, (m) => m.split("=")[0] + "=***").replace(/(--?(?:token|api[-_]?key|password|pass|secret)[=\s]+)\S+/gi, "$1***").replace(/\b(Bearer)\s+\S+/gi, "$1 ***").replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@").replace(/\/(home|Users|root)\/[^/\s]+/g, "~").replace(/\b\w+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "***@<ip>");
}

// public/elements/bucketPanel.js
function foldPaths(paths) {
  if (!paths || paths.length === 0) return [];
  const files = paths.filter((p) => !p.path.endsWith("/"));
  if (files.length === 0) return [];
  function makeFileLeaf(p, name, indent) {
    const defaultSel = p.defaultSelected !== false;
    const waste = (p.totalSpent ?? p.tokens ?? 0) - (p.tokens ?? 0);
    const tier = churnTier({ churn: p.churn ?? null, waste, pureRereads: p.pureRereads ?? 0 });
    return {
      id: "file:" + p.path,
      group: "paths",
      kind: "file",
      name,
      label: p.path,
      displayName: name,
      detail: void 0,
      tool: void 0,
      tokens: p.tokens ?? 0,
      totalSpent: p.totalSpent ?? p.tokens ?? 0,
      churn: p.churn ?? null,
      pureRereads: p.pureRereads ?? 0,
      readCount: p.readCount ?? 0,
      editCount: p.editCount ?? 0,
      efficiency: p.efficiency ?? null,
      touchSeqs: p.touchSeqs ?? null,
      defaultDiscardReason: p.defaultDiscardReason ?? null,
      userOverride: p.userOverride || null,
      churnTier: tier,
      lastTurn: p.lastTurn ?? null,
      lastCallSeq: p.lastCallSeq ?? null,
      locked: false,
      selectable: true,
      defaultSelected: defaultSel,
      selected: defaultSel,
      children: null,
      indent
    };
  }
  function makeDirNode(label, children, indent, fullPrefix) {
    const tokens = children.reduce((s, c) => s + (c.tokens ?? 0), 0);
    const dirTier = maxChildTier(children);
    return {
      id: "dir:paths:" + fullPrefix,
      group: "paths",
      kind: "dir",
      name: label,
      label,
      displayName: label,
      detail: void 0,
      tool: void 0,
      tokens,
      churnTier: dirTier,
      lastTurn: null,
      locked: false,
      selectable: true,
      defaultSelected: true,
      selected: true,
      children,
      indent,
      collapsed: true
    };
  }
  function build(entries, prefix, indent) {
    const groups = /* @__PURE__ */ new Map();
    const here = [];
    for (const p of entries) {
      let rest = prefix ? p.path.slice(prefix.length + 1) : p.path;
      if (!prefix && rest.startsWith("/")) rest = rest.slice(1);
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 0) {
        here.push(p);
      } else {
        const seg = rest.slice(0, slashIdx);
        if (!groups.has(seg)) groups.set(seg, []);
        groups.get(seg).push(p);
      }
    }
    const result2 = [];
    for (const p of here) {
      let rest = prefix ? p.path.slice(prefix.length + 1) : p.path;
      if (!prefix && rest.startsWith("/")) rest = rest.slice(1);
      result2.push(makeFileLeaf(p, rest, indent));
    }
    for (const [seg, group] of groups) {
      const dirPrefix = prefix ? prefix + "/" + seg : group[0].path.startsWith("/") ? "/" + seg : seg;
      if (group.length === 1) {
        const p = group[0];
        let rel = prefix ? p.path.slice(prefix.length + 1) : p.path;
        if (!prefix && rel.startsWith("/")) rel = rel.slice(1);
        result2.push(makeFileLeaf(p, rel, indent));
      } else {
        let label = seg;
        let curPrefix = dirPrefix;
        let curGroup = group;
        while (true) {
          const sub = /* @__PURE__ */ new Map();
          const subHere = [];
          for (const p of curGroup) {
            const rest = p.path.slice(curPrefix.length + 1);
            const si = rest.indexOf("/");
            if (si < 0) subHere.push(p);
            else {
              const s = rest.slice(0, si);
              if (!sub.has(s)) sub.set(s, []);
              sub.get(s).push(p);
            }
          }
          if (subHere.length === 0 && sub.size === 1) {
            const [[nextSeg, nextGroup]] = sub;
            label += "/" + nextSeg;
            curPrefix += "/" + nextSeg;
            curGroup = nextGroup;
          } else {
            break;
          }
        }
        const children = build(curGroup, curPrefix, indent + 1);
        result2.push(makeDirNode(label, children, indent, curPrefix));
      }
    }
    return result2;
  }
  let commonPrefix = "";
  if (files.length > 1 && files[0].path.startsWith("/") && files.every((p) => p.path.startsWith("/"))) {
    const first = files[0].path;
    let end = 0;
    outer: for (let i = 0; i < first.length; i++) {
      for (let j = 1; j < files.length; j++) {
        if (i >= files[j].path.length || files[j].path[i] !== first[i]) break outer;
      }
      if (first[i] === "/") end = i;
    }
    if (end > 0) commonPrefix = first.slice(0, end);
  }
  const result = build(files, commonPrefix, 0);
  sortByTokensDesc(result);
  return result;
}
function sortByTokensDesc(nodes) {
  nodes.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
  for (const n of nodes) {
    if (n.children) sortByTokensDesc(n.children);
  }
}
var RESIDUAL_FAMILIES = [
  ["bash", (b) => b.name],
  ["mcp", (m) => m.tool],
  ["agent", (a) => a.name],
  ["tool", (t) => t.name]
];
var RESIDUAL_KINDS = new Set(RESIDUAL_FAMILIES.map(([kind]) => kind));
function foldResidual(kind, list, nameOf) {
  if (!list || list.length === 0) return [];
  function makeLeaf(item, indent) {
    const name = nameOf(item);
    const isBash = kind === "bash";
    const id = kind + ":" + name;
    const displayName = isBash ? redactCmd(name) : name;
    return {
      id,
      group: "output",
      kind,
      name,
      label: name,
      displayName,
      detail: item.detail ?? void 0,
      tool: isBash ? void 0 : name,
      tokens: item.tokens ?? 0,
      count: item.count ?? 1,
      lastTurn: item.lastTurn ?? null,
      lastCallSeq: item.lastCallSeq ?? null,
      touchSeqs: item.touchSeqs ?? null,
      locked: false,
      selectable: true,
      defaultSelected: false,
      selected: false,
      children: null,
      indent
    };
  }
  if (list.length === 1) {
    return [makeLeaf(list[0], 0)];
  }
  const children = list.map((item) => makeLeaf(item, 1));
  const tokens = children.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const dirNode = {
    id: "dir:output:" + kind,
    group: "output",
    kind: "dir",
    name: kind,
    label: kind,
    displayName: kind,
    detail: void 0,
    tool: void 0,
    tokens,
    lastTurn: null,
    locked: false,
    selectable: true,
    defaultSelected: false,
    selected: false,
    children,
    indent: 0,
    collapsed: true
  };
  return [dirNode];
}
function buildTree(bucketData) {
  if (!bucketData) return [];
  const tree = [];
  tree.push({
    id: "system:prompt",
    group: "system",
    kind: "system",
    name: "system prompt",
    label: "system prompt",
    displayName: "system prompt",
    detail: void 0,
    tool: void 0,
    tokens: bucketData.dead || 0,
    lastTurn: null,
    locked: true,
    selectable: false,
    defaultSelected: false,
    selected: false,
    children: null,
    indent: 0
  });
  for (const s of bucketData.skills || []) {
    tree.push({
      id: "skill:" + s.name,
      group: "system",
      kind: "skill",
      name: s.name,
      label: "skill:" + s.name,
      displayName: "skill:" + s.name,
      detail: void 0,
      tool: void 0,
      tokens: s.tokens ?? 0,
      lastTurn: s.lastTurn ?? null,
      lastCallSeq: s.lastCallSeq ?? null,
      userOverride: s.userOverride || null,
      locked: false,
      selectable: true,
      defaultSelected: true,
      selected: true,
      children: null,
      indent: 0
    });
  }
  tree.push(...foldPaths(bucketData.paths || []));
  let sumResidual = 0;
  for (const [kind, nameOf] of RESIDUAL_FAMILIES) {
    const list = bucketData.residual?.[kind] || [];
    tree.push(...foldResidual(kind, list, nameOf));
    sumResidual += list.reduce((s, item) => s + (item.tokens ?? 0), 0);
  }
  const totalRaw = bucketData.totalResidualRaw ?? bucketData.totalResidual ?? 0;
  const othersRaw = totalRaw - sumResidual;
  if (othersRaw < -(OTHERS_DRIFT_WARN_PCT * (bucketData.totalL || 0))) {
    console.warn("bucket measurement drift");
  }
  tree.push({
    id: "others",
    group: "output",
    kind: "others",
    name: "others",
    label: "others",
    displayName: "others",
    detail: void 0,
    tool: void 0,
    tokens: Math.max(0, othersRaw),
    lastTurn: null,
    locked: true,
    selectable: false,
    defaultSelected: false,
    selected: false,
    children: null,
    indent: 0
  });
  return tree;
}
function flattenLeaves(tree, out = []) {
  for (const n of tree) {
    if (n.children && n.children.length) flattenLeaves(n.children, out);
    else out.push(n);
  }
  return out;
}
function flattenDirs(tree, out = []) {
  for (const n of tree) {
    if (n.children && n.children.length) {
      out.push(n);
      flattenDirs(n.children, out);
    }
  }
  return out;
}
function deriveDirState(nodeOrChildren) {
  const src = Array.isArray(nodeOrChildren) ? nodeOrChildren : nodeOrChildren?.children || [];
  const leaves = flattenLeaves(src).filter((n) => n.selectable);
  if (leaves.length === 0) return "unchecked";
  const sel = leaves.filter((n) => n.selected).length;
  if (sel === 0) return "unchecked";
  if (sel === leaves.length) return "checked";
  return "half";
}
function summarize(tree) {
  let fixed = 0, selected = 0, discarded = 0;
  for (const leaf of flattenLeaves(tree)) {
    if (leaf.locked && leaf.kind === "system") fixed += leaf.tokens;
    else if (leaf.locked && leaf.kind === "others") discarded += leaf.tokens;
    else if (leaf.selected) selected += leaf.tokens;
    else discarded += leaf.tokens;
  }
  return { fixed, selected, discarded, total: fixed + selected + discarded };
}
function donutSegments({ fixed, selected, discarded }) {
  const total = fixed + selected + discarded;
  const C = DONUT_CIRCUMFERENCE;
  const arc = (v) => total > 0 ? v / total * C : 0;
  const sysLen = arc(fixed), selLen = arc(selected), disLen = arc(discarded);
  const seg = (len, offset) => ({ dasharray: `${len.toFixed(1)} ${(C - len).toFixed(1)}`, dashoffset: offset });
  return {
    system: seg(sysLen, 0),
    selected: seg(selLen, -sysLen),
    discarded: seg(disLen, -(sysLen + selLen))
  };
}
function applyOverrides(tree, overrides2) {
  for (const leaf of flattenLeaves(tree)) {
    if (!leaf.selectable) continue;
    leaf.selected = overrides2.has(leaf.label) ? overrides2.get(leaf.label) : leaf.defaultSelected;
  }
}
function buildOverridePayload(tree) {
  const overrides2 = {};
  for (const leaf of flattenLeaves(tree)) {
    if (!leaf.selectable) continue;
    if (leaf.group === "output") continue;
    if (leaf.selected && !leaf.defaultSelected) {
      overrides2[leaf.label] = "include";
    } else if (!leaf.selected && leaf.defaultSelected) {
      overrides2[leaf.label] = "exclude";
    }
  }
  return overrides2;
}
function buildHandoffInstruction(tree) {
  const keep = [];
  function walkPath(node) {
    if (node.kind === "file") {
      if (node.selected) keep.push(redactCmd(node.name));
      return;
    }
    if (node.kind !== "dir") return;
    const state = deriveDirState(node);
    if (state === "checked") {
      keep.push(redactCmd(node.name));
      return;
    }
    if (state === "unchecked") return;
    for (const c of node.children) walkPath(c);
  }
  for (const n of tree) if (n.group === "paths") walkPath(n);
  for (const leaf of flattenLeaves(tree)) {
    if (leaf.kind === "skill" && leaf.selectable && leaf.selected) {
      keep.push(leaf.name);
    }
  }
  if (!keep.length) return "";
  return "/sw-handoff keep: " + keep.join(", ");
}
function tokenLabel(tokens) {
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(Math.round(tokens));
}
function barColorClass(node) {
  if (node.kind === "system") return "color-mute";
  if (node.kind === "skill") return "color-sky";
  if (node.kind === "others") return "color-mute";
  if (node.group === "output") return "color-amber";
  const tier = node.churnTier ?? "mint";
  if (tier === "coral") return "color-coral";
  if (tier === "amber") return "color-amber";
  return "color-mint";
}
function nameClass(node) {
  if (node.kind === "system") return "is-system";
  if (node.kind === "skill") return "is-skill";
  if (node.kind === "dir") return "is-dir-name";
  if (RESIDUAL_KINDS.has(node.kind)) return "is-special";
  if (node.kind === "others") return "is-others";
  return "";
}
function findNodeById(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children && n.children.length) {
      const found = findNodeById(n.children, id);
      if (found) return found;
    }
  }
  return null;
}
function paintIndentGuides(row2, indent) {
  const images = [];
  const positions2 = [];
  for (let i = 0; i < indent; i++) {
    images.push("linear-gradient(var(--edge,#2a2d35),var(--edge,#2a2d35))");
    positions2.push(`${i * 18 + 12}px 0`);
  }
  row2.style.backgroundImage = images.join(",");
  row2.style.backgroundPosition = positions2.join(",");
  row2.style.backgroundSize = "1px 100%";
  row2.style.backgroundRepeat = "no-repeat";
}
function latestOnly() {
  let latest = 0;
  return { next() {
    latest += 1;
    return latest;
  }, isLatest(token) {
    return token === latest;
  } };
}
function createPreviewPublisher({ fetchImpl, emit, hasSelection, overridesOf }) {
  const previewGate = latestOnly();
  let shownKey = null;
  const keyOf = (overrides2) => JSON.stringify(Object.keys(overrides2).sort().map((k) => [k, overrides2[k]]));
  function publish(detail, key) {
    shownKey = key;
    emit(detail);
  }
  return async function dispatchPreview(forceFalse) {
    if (forceFalse || !hasSelection()) {
      previewGate.next();
      if (shownKey !== null) publish({ dirty: false }, null);
      return;
    }
    const token = previewGate.next();
    const overrides2 = overridesOf();
    const key = keyOf(overrides2);
    if (key !== shownKey) publish({ dirty: true, scenario: null }, key);
    try {
      const res = await fetchImpl("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: overrides2 })
      });
      if (!previewGate.isLatest(token)) return;
      if (!res.ok) {
        publish({ dirty: true, scenario: null }, key);
        return;
      }
      const { scenario } = await res.json();
      if (!previewGate.isLatest(token)) return;
      publish({ dirty: true, scenario }, key);
    } catch (e) {
      console.error("[preview]", e);
      if (previewGate.isLatest(token)) publish({ dirty: true, scenario: null }, key);
    }
  };
}
function mount7(root, ctx) {
  const state = {
    tree: [],
    selectionOverrides: /* @__PURE__ */ new Map(),
    // leaf path (label) → bool (user toggles since last Apply/Reset)
    collapsedOverrides: /* @__PURE__ */ new Map(),
    // dir id → bool (user fold toggles)
    sectionCollapsed: { system: false, paths: false, output: true },
    // section-level fold
    prevSegment: null,
    lastGoodBucketData: null,
    // last non-null bd — fallback for transient failures
    _bodyTips: []
    // tooltip elements appended to ctx.overlayRoot (for cleanup)
  };
  function setLocalSelection(selectionOverrides, leaf, target) {
    const committed = leaf.userOverride === "include" ? true : leaf.userOverride === "exclude" ? false : leaf.defaultSelected;
    if (target === committed) {
      selectionOverrides.delete(leaf.label);
    } else {
      selectionOverrides.set(leaf.label, target);
    }
  }
  const card = document.createElement("div");
  card.className = "bucket-card";
  card.id = "sw-buckets";
  const header = document.createElement("div");
  header.className = "bucket-header";
  const donutWrap = document.createElement("div");
  donutWrap.className = "header-donut";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("aria-hidden", "true");
  const circleTrack = document.createElementNS(SVG_NS, "circle");
  circleTrack.setAttribute("cx", "18");
  circleTrack.setAttribute("cy", "18");
  circleTrack.setAttribute("r", "14");
  circleTrack.setAttribute("fill", "none");
  circleTrack.style.stroke = "var(--sw-hairline, rgba(255,255,255,0.04))";
  circleTrack.setAttribute("stroke-width", "4.5");
  const circleSystem = document.createElementNS(SVG_NS, "circle");
  circleSystem.setAttribute("cx", "18");
  circleSystem.setAttribute("cy", "18");
  circleSystem.setAttribute("r", "14");
  circleSystem.setAttribute("fill", "none");
  circleSystem.style.stroke = "var(--sw-faint, #5a6a75)";
  circleSystem.setAttribute("stroke-width", "4.5");
  circleSystem.className.baseVal = "donut-system";
  const circleSelected = document.createElementNS(SVG_NS, "circle");
  circleSelected.setAttribute("cx", "18");
  circleSelected.setAttribute("cy", "18");
  circleSelected.setAttribute("r", "14");
  circleSelected.setAttribute("fill", "none");
  circleSelected.style.stroke = "var(--sw-ok, #4fe0b0)";
  circleSelected.setAttribute("stroke-width", "4.5");
  circleSelected.className.baseVal = "donut-selected";
  const circleDiscarded = document.createElementNS(SVG_NS, "circle");
  circleDiscarded.setAttribute("cx", "18");
  circleDiscarded.setAttribute("cy", "18");
  circleDiscarded.setAttribute("r", "14");
  circleDiscarded.setAttribute("fill", "none");
  circleDiscarded.style.stroke = "var(--sw-bad, #ff7566)";
  circleDiscarded.setAttribute("stroke-width", "4.5");
  circleDiscarded.setAttribute("opacity", "0.7");
  circleDiscarded.className.baseVal = "donut-discarded";
  svg.appendChild(circleTrack);
  svg.appendChild(circleSystem);
  svg.appendChild(circleSelected);
  svg.appendChild(circleDiscarded);
  donutWrap.appendChild(svg);
  const headerInfo = document.createElement("div");
  headerInfo.className = "header-info";
  const h32 = document.createElement("h3");
  h32.textContent = "Context buckets";
  const subtitle = document.createElement("div");
  subtitle.className = "subtitle";
  subtitle.textContent = "rebuild cost \xB7 uncheck to plan handoff";
  headerInfo.appendChild(h32);
  headerInfo.appendChild(subtitle);
  const headerStats = document.createElement("div");
  headerStats.className = "header-stats";
  const statSelectedEl = document.createElement("div");
  const statSelectedSpan = document.createElement("span");
  statSelectedSpan.className = "val-selected stat-selected";
  statSelectedEl.appendChild(statSelectedSpan);
  const statDiscardedEl = document.createElement("div");
  const statDiscardedSpan = document.createElement("span");
  statDiscardedSpan.className = "val-discarded stat-discarded";
  statDiscardedEl.appendChild(statDiscardedSpan);
  headerStats.appendChild(statSelectedEl);
  headerStats.appendChild(statDiscardedEl);
  header.appendChild(donutWrap);
  header.appendChild(headerInfo);
  header.appendChild(headerStats);
  const statusBar = document.createElement("div");
  statusBar.className = "panel-status-bar";
  statusBar.style.display = "none";
  const sweepTrack = document.createElement("div");
  sweepTrack.className = "sync-sweep-track";
  sweepTrack.setAttribute("aria-hidden", "true");
  sweepTrack.style.display = "none";
  const treeEl = document.createElement("div");
  treeEl.className = "bucket-tree";
  const footer = document.createElement("div");
  footer.className = "bucket-footer";
  const resetBtn = document.createElement("button");
  resetBtn.className = "bucket-reset-btn";
  resetBtn.textContent = "Reset";
  resetBtn.type = "button";
  const applyBtn = document.createElement("button");
  applyBtn.className = "bucket-apply-btn";
  applyBtn.textContent = "Apply";
  applyBtn.type = "button";
  applyBtn.disabled = true;
  const handoffBtn = document.createElement("button");
  handoffBtn.className = "bucket-copy-btn";
  handoffBtn.textContent = "Prepare handoff";
  handoffBtn.type = "button";
  handoffBtn.title = "Run /sw-handoff in your session to preserve checked context";
  footer.appendChild(resetBtn);
  footer.appendChild(applyBtn);
  footer.appendChild(handoffBtn);
  card.appendChild(sweepTrack);
  card.appendChild(header);
  card.appendChild(statusBar);
  card.appendChild(treeEl);
  card.appendChild(footer);
  root.appendChild(card);
  let staleInterval = null;
  function clearStaleInterval() {
    if (staleInterval) {
      clearInterval(staleInterval);
      staleInterval = null;
    }
  }
  const dispatchPreview = createPreviewPublisher({
    fetchImpl: ctx.request,
    emit: (detail) => ctx.bus.dispatchEvent(new CustomEvent("sw-bucket-preview", { detail })),
    hasSelection: () => state.selectionOverrides.size > 0,
    overridesOf: () => buildOverridePayload(state.tree)
  });
  let _hoveredNodeId = null;
  function dispatchHover(detail) {
    ctx.bus.dispatchEvent(new CustomEvent("sw-bucket-hover", { detail }));
  }
  function makeRow(node, maxLeafTokens) {
    const row2 = document.createElement("div");
    row2.className = "bucket-row";
    if (node.kind === "dir") row2.classList.add("is-dir");
    if (node.indent) {
      row2.dataset.indent = String(node.indent);
      row2.style.setProperty("--indent", String(node.indent));
      paintIndentGuides(row2, node.indent);
    }
    row2.dataset.id = node.id;
    row2.dataset.tokens = String(node.tokens);
    if (node.lastCallSeq != null) row2.dataset.lastCallSeq = String(node.lastCallSeq);
    row2.setAttribute("tabindex", "0");
    row2.setAttribute("role", "option");
    const isExcluded = node.kind === "file" ? node.defaultSelected === false : node.kind === "dir" && flattenLeaves(node.children).every((l) => l.defaultSelected === false);
    if (isExcluded) row2.classList.add("is-excluded");
    const cb = document.createElement("span");
    cb.className = "bucket-cb";
    if (node.locked) {
      cb.classList.add("locked");
      if (node.kind !== "others") cb.classList.add("checked");
      row2.setAttribute("aria-disabled", "true");
      row2.setAttribute("aria-checked", node.kind !== "others" ? "true" : "false");
    } else if (node.kind === "dir") {
      const ds = deriveDirState(node);
      if (ds === "checked") cb.classList.add("checked");
      else if (ds === "half") cb.classList.add("half");
      row2.setAttribute("aria-checked", ds === "checked" ? "true" : ds === "half" ? "mixed" : "false");
    } else {
      if (node.selected) cb.classList.add("checked");
      row2.setAttribute("aria-checked", node.selected ? "true" : "false");
    }
    row2.appendChild(cb);
    if (node.kind === "dir") {
      const expand = document.createElement("span");
      expand.className = "bucket-expand";
      if (node.collapsed) expand.classList.add("collapsed");
      expand.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
      row2.appendChild(expand);
    }
    const nameWrap = document.createElement("span");
    nameWrap.className = "bucket-name-wrap";
    const nameEl = document.createElement("span");
    nameEl.className = "bucket-name";
    const nc = nameClass(node);
    if (nc) nameEl.classList.add(nc);
    if (node.group === "paths" || node.kind === "dir" && node.group === "paths") {
      const tier = node.churnTier ?? "mint";
      if (tier === "amber") nameEl.classList.add("churn-med");
      else if (tier === "coral") nameEl.classList.add("churn-high");
    }
    nameEl.textContent = node.displayName;
    if (node.userOverride) nameEl.dataset.override = node.userOverride;
    nameWrap.appendChild(nameEl);
    if (node.count > 1 && RESIDUAL_KINDS.has(node.kind)) {
      const badge = document.createElement("span");
      badge.className = "bucket-count";
      badge.textContent = String(node.count);
      nameWrap.appendChild(badge);
    }
    row2.appendChild(nameWrap);
    const right = document.createElement("span");
    right.className = "bucket-right";
    const tokEl = document.createElement("span");
    tokEl.className = "bucket-tokens";
    tokEl.textContent = tokenLabel(node.tokens);
    right.appendChild(tokEl);
    const barWrap = document.createElement("span");
    barWrap.className = "bucket-bar-wrap";
    const bar = document.createElement("span");
    bar.className = "bucket-bar " + barColorClass(node);
    const pct = maxLeafTokens > 0 ? Math.sqrt(node.tokens) / Math.sqrt(maxLeafTokens) * 100 : 0;
    bar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    barWrap.appendChild(bar);
    right.appendChild(barWrap);
    row2.appendChild(right);
    if (node.group === "paths" && node.kind === "file") {
      const tip = document.createElement("div");
      tip.className = "sw-bucket-tip";
      row2.addEventListener("mouseenter", () => {
        tip.style.display = "block";
        const rect = row2.getBoundingClientRect();
        const tipH = tip.offsetHeight;
        const tipW = tip.offsetWidth;
        const offset = 8;
        const spaceRight = window.innerWidth - rect.right;
        if (spaceRight >= tipW + offset) {
          tip.style.left = rect.right + offset + "px";
        } else {
          tip.style.left = rect.left - tipW - offset + "px";
        }
        const rowMid = rect.top + rect.height / 2;
        const idealY = rowMid - tipH / 2;
        tip.style.top = Math.max(8, Math.min(idealY, window.innerHeight - tipH - 8)) + "px";
      });
      row2.addEventListener("mouseleave", () => {
        tip.style.display = "none";
        tip.style.left = "";
      });
      if (isExcluded && node.defaultDiscardReason) {
        const excLine = document.createElement("div");
        excLine.className = "tooltip-excluded";
        excLine.textContent = "excluded";
        const reason = document.createElement("span");
        reason.className = "reason";
        reason.textContent = node.defaultDiscardReason;
        excLine.appendChild(reason);
        tip.appendChild(excLine);
      }
      const rows = [
        ["retained", tokenLabel(node.tokens)],
        ["total spent", tokenLabel(node.totalSpent ?? node.tokens)],
        ["ops", `${node.readCount ?? 0}R \xB7 ${node.editCount ?? 0}E`]
      ];
      if ((node.pureRereads ?? 0) > 0) rows.push(["pure rereads", String(node.pureRereads)]);
      for (const [label, val] of rows) {
        const tr = document.createElement("div");
        tr.className = "tooltip-row";
        tr.textContent = `${label}: ${val}`;
        tip.appendChild(tr);
      }
      if (node.efficiency != null) {
        const effRow = document.createElement("div");
        effRow.className = "tooltip-eff";
        const effLabel = document.createElement("span");
        effLabel.textContent = `eff ${Math.round(node.efficiency)}%`;
        const effBar = document.createElement("span");
        effBar.className = "tooltip-eff-bar";
        const tier = node.churnTier ?? "mint";
        const effFill = document.createElement("span");
        effFill.className = `tooltip-eff-fill color-${tier}`;
        effFill.style.width = `${Math.max(0, Math.min(100, node.efficiency ?? 0)).toFixed(1)}%`;
        effBar.appendChild(effFill);
        effRow.appendChild(effLabel);
        effRow.appendChild(effBar);
        tip.appendChild(effRow);
      }
      ctx.overlayRoot.appendChild(tip);
      state._bodyTips.push(tip);
    }
    if (node.selectable && !node.locked) {
      const cbTitle = node.selected ? "" : "Exclude = this file is not required for restart rebuild. Does not reduce your position.";
      if (cbTitle) cb.title = cbTitle;
    }
    if (node.kind === "others") {
      row2.style.opacity = "0.5";
    } else if (!node.locked) {
      if (node.kind === "dir") {
        if (deriveDirState(node) === "unchecked") row2.style.opacity = "0.5";
      } else if (!node.selected) {
        row2.style.opacity = "0.5";
      }
    }
    return row2;
  }
  function renderNodeTree(nodes, maxLeafTokens, fragment) {
    for (const node of nodes) {
      const row2 = makeRow(node, maxLeafTokens);
      fragment.appendChild(row2);
      if (node.kind === "dir" && node.children && node.children.length) {
        const childFrag = document.createDocumentFragment();
        renderNodeTree(node.children, maxLeafTokens, childFrag);
        const childWrap = document.createElement("div");
        childWrap.className = "bucket-dir-children";
        childWrap.dataset.parentId = node.id;
        if (node.collapsed) childWrap.style.display = "none";
        childWrap.appendChild(childFrag);
        fragment.appendChild(childWrap);
      }
    }
  }
  function render() {
    for (const t of state._bodyTips) t.remove();
    state._bodyTips.length = 0;
    treeEl.innerHTML = "";
    const allLeaves = flattenLeaves(state.tree);
    const maxLeafTokens = allLeaves.reduce((m, n) => n.kind === "others" || n.kind === "system" ? m : Math.max(m, n.tokens), 0);
    const systemNodes = state.tree.filter((n) => n.group === "system");
    const pathNodes = state.tree.filter((n) => n.group === "paths");
    const outputNodes = state.tree.filter((n) => n.group === "output");
    const frag = document.createDocumentFragment();
    function makeSection(label, nodes, isFirst) {
      if (!nodes.length) return;
      if (!isFirst) {
        const sep = document.createElement("hr");
        sep.className = "bucket-sep";
        frag.appendChild(sep);
      }
      const lbl = document.createElement("div");
      lbl.className = "section-label";
      if (state.sectionCollapsed[label]) lbl.classList.add("collapsed");
      lbl.dataset.section = label;
      const chevron = document.createElement("span");
      chevron.className = "section-chevron";
      chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
      lbl.appendChild(chevron);
      const displayLabel = label === "output" ? "tools" : label;
      lbl.appendChild(document.createTextNode(displayLabel));
      const sectionTokens = nodes.reduce((s, n) => s + (n.tokens ?? 0), 0);
      const summary = document.createElement("span");
      summary.className = "section-summary";
      summary.textContent = tokenLabel(sectionTokens);
      lbl.appendChild(summary);
      frag.appendChild(lbl);
      const group = document.createElement("div");
      group.className = "section-group";
      group.dataset.section = label;
      if (state.sectionCollapsed[label]) group.classList.add("collapsed");
      renderNodeTree(nodes, maxLeafTokens, group);
      frag.appendChild(group);
    }
    makeSection("system", systemNodes, true);
    makeSection("paths", pathNodes, !systemNodes.length);
    makeSection("output", outputNodes, !systemNodes.length && !pathNodes.length);
    treeEl.appendChild(frag);
    const sums = summarize(state.tree);
    const segs = donutSegments(sums);
    circleSystem.setAttribute("stroke-dasharray", segs.system.dasharray);
    circleSystem.setAttribute("stroke-dashoffset", String(segs.system.dashoffset));
    circleSelected.setAttribute("stroke-dasharray", segs.selected.dasharray);
    circleSelected.setAttribute("stroke-dashoffset", String(segs.selected.dashoffset));
    circleDiscarded.setAttribute("stroke-dasharray", segs.discarded.dasharray);
    circleDiscarded.setAttribute("stroke-dashoffset", String(segs.discarded.dashoffset));
    statSelectedSpan.textContent = `selected ${tokenLabel(sums.selected)}`;
    statDiscardedSpan.textContent = `discarded ${sums.discarded >= 0 ? tokenLabel(sums.discarded) : "0"}`;
    const hasLocalGhost = state.selectionOverrides.size > 0;
    const hasBackendOverrides = flattenLeaves(state.tree).some((n) => n.userOverride != null);
    const hasApplicableGhost = hasLocalGhost && flattenLeaves(state.tree).some((n) => n.selectable && n.group !== "output" && state.selectionOverrides.has(n.label));
    applyBtn.disabled = !hasApplicableGhost;
    if (hasLocalGhost) {
      resetBtn.textContent = "Reset preview";
      resetBtn.classList.add("active");
      resetBtn.style.display = "";
    } else if (hasBackendOverrides) {
      resetBtn.textContent = "Reset overrides";
      resetBtn.classList.add("active");
      resetBtn.style.display = "";
    } else {
      resetBtn.classList.remove("active");
      resetBtn.style.display = "none";
    }
  }
  function renderSkeleton() {
    treeEl.innerHTML = "";
    subtitle.textContent = "loading\u2026";
    statSelectedSpan.textContent = "";
    statDiscardedSpan.textContent = "";
    circleSystem.setAttribute("stroke-dasharray", "26 62");
    circleSystem.setAttribute("stroke-dashoffset", "0");
    circleSelected.setAttribute("stroke-dasharray", "0 88");
    circleSelected.setAttribute("stroke-dashoffset", "0");
    circleDiscarded.setAttribute("stroke-dasharray", "0 88");
    circleDiscarded.setAttribute("stroke-dashoffset", "0");
    const statsShimmer = document.createDocumentFragment();
    [82, 70].forEach((w) => {
      const s = document.createElement("span");
      s.className = "skel";
      s.style.cssText = `width:${w}px;height:10px;display:block;margin-bottom:3px;`;
      statsShimmer.appendChild(s);
    });
    headerStats.innerHTML = "";
    headerStats.appendChild(statsShimmer);
    const skelGroups = [
      { label: "system", rows: [
        { widths: [130], hasIcon: true },
        { widths: [112], hasIcon: true },
        { widths: [80], hasIcon: true }
      ] },
      { label: "paths", rows: [
        { widths: [118], hasExpand: true },
        { widths: [90], indent: 1 },
        { widths: [110], indent: 1 },
        { widths: [148] },
        { widths: [60], hasExpand: true },
        { widths: [94], indent: 1 },
        { widths: [78], indent: 1 },
        { widths: [162] }
      ] },
      { label: "tools", rows: [
        { widths: [46], hasExpand: true },
        { widths: [40] },
        { widths: [58] }
      ] }
    ];
    const frag = document.createDocumentFragment();
    let firstGroup = true;
    for (const grp of skelGroups) {
      if (!firstGroup) {
        const sep = document.createElement("hr");
        sep.className = "bucket-sep";
        frag.appendChild(sep);
      }
      firstGroup = false;
      const lbl = document.createElement("div");
      lbl.className = "section-label skel-label";
      lbl.textContent = grp.label;
      frag.appendChild(lbl);
      for (const rowDef of grp.rows) {
        const rowEl = document.createElement("div");
        rowEl.className = "skel-row" + (rowDef.indent ? ` indent-${rowDef.indent}` : "");
        const cbSkel = document.createElement("span");
        cbSkel.className = "skel skel-cb";
        rowEl.appendChild(cbSkel);
        if (rowDef.hasIcon) {
          const iconSkel = document.createElement("span");
          iconSkel.className = "skel skel-icon";
          rowEl.appendChild(iconSkel);
        }
        if (rowDef.hasExpand) {
          const expandSkel = document.createElement("span");
          expandSkel.className = "skel skel-expand";
          rowEl.appendChild(expandSkel);
        }
        const nameSkel = document.createElement("span");
        nameSkel.className = "skel skel-name";
        nameSkel.style.maxWidth = `${rowDef.widths[0]}px`;
        rowEl.appendChild(nameSkel);
        const rightDiv = document.createElement("div");
        rightDiv.className = "bucket-right";
        const tokSkel = document.createElement("span");
        tokSkel.className = "skel skel-tokens";
        const barSkel = document.createElement("span");
        barSkel.className = "skel skel-barwrap";
        rightDiv.appendChild(tokSkel);
        rightDiv.appendChild(barSkel);
        rowEl.appendChild(rightDiv);
        frag.appendChild(rowEl);
      }
    }
    treeEl.appendChild(frag);
    resetBtn.classList.remove("active");
  }
  function updateSyncState() {
    const transport = ctx?.transport;
    const bs = transport?.bucketState ?? {};
    const isFetching = bs.isFetching ?? false;
    const consecutiveFailures = bs.consecutiveFailures ?? 0;
    const lastSuccessAt = bs.lastSuccessAt ?? null;
    clearStaleInterval();
    sweepTrack.style.display = "none";
    statusBar.style.display = "none";
    statusBar.innerHTML = "";
    card.removeAttribute("data-state");
    donutWrap.classList.remove("donut-syncing");
    if (!state.lastGoodBucketData) return;
    if (isFetching) {
      card.dataset.state = "syncing";
      sweepTrack.style.display = "";
      donutWrap.classList.add("donut-syncing");
      statusBar.style.display = "";
      const chip = document.createElement("span");
      chip.className = "status-chip chip-syncing";
      chip.setAttribute("role", "status");
      chip.setAttribute("aria-live", "polite");
      chip.setAttribute("aria-label", "Syncing bucket data");
      const dot = document.createElement("span");
      dot.className = "status-dot";
      dot.setAttribute("aria-hidden", "true");
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(" syncing\u2026"));
      statusBar.appendChild(chip);
    } else if (consecutiveFailures >= 1 && lastSuccessAt) {
      let updateStaleText = function() {
        const elapsed = Math.round((Date.now() - lastSuccessAt) / 1e3);
        chipText.textContent = ` last updated ${elapsed}s ago \xB7 retrying`;
        chip.setAttribute("aria-label", `Data may be stale \u2014 last updated ${elapsed} seconds ago, retrying`);
      };
      card.dataset.state = "stale";
      statusBar.style.display = "";
      const chip = document.createElement("span");
      chip.className = "status-chip chip-stale";
      chip.setAttribute("role", "status");
      chip.setAttribute("aria-live", "polite");
      const dot = document.createElement("span");
      dot.className = "status-dot";
      dot.setAttribute("aria-hidden", "true");
      chip.appendChild(dot);
      const chipText = document.createTextNode("");
      chip.appendChild(chipText);
      updateStaleText();
      staleInterval = setInterval(updateStaleText, 1e3);
      statusBar.appendChild(chip);
    }
  }
  function update(snapshot) {
    let bd = snapshot?.bucketData;
    if (!bd) bd = state.lastGoodBucketData;
    if (!bd) {
      if (!headerStats.querySelector(".stat-selected")) {
        headerStats.innerHTML = "";
        headerStats.appendChild(statSelectedEl);
        headerStats.appendChild(statDiscardedEl);
      }
      renderSkeleton();
      return;
    }
    if (!state.lastGoodBucketData) {
      if ((bd.totalB ?? 0) <= 0 && (bd.dead ?? 0) <= 0) {
        subtitle.textContent = "connected \xB7 awaiting data";
        return;
      }
      state.lastGoodBucketData = bd;
      subtitle.textContent = "rebuild cost \xB7 uncheck to plan handoff";
      headerStats.innerHTML = "";
      headerStats.appendChild(statSelectedEl);
      headerStats.appendChild(statDiscardedEl);
    } else if (bd !== state.lastGoodBucketData) {
      state.lastGoodBucketData = bd;
    }
    const currentSegment = snapshot?.status?.segment ?? bd.segment ?? null;
    if (currentSegment !== state.prevSegment) {
      state.selectionOverrides.clear();
      state.collapsedOverrides.clear();
      state.prevSegment = currentSegment;
      dispatchPreview(true);
    }
    state.tree = buildTree(bd);
    applyOverrides(state.tree, state.selectionOverrides);
    for (const leaf of flattenLeaves(state.tree)) {
      if (!leaf.selectable) continue;
      if (state.selectionOverrides.has(leaf.label)) continue;
      if (leaf.userOverride === "include") leaf.selected = true;
      else if (leaf.userOverride === "exclude") leaf.selected = false;
    }
    for (const dirNode of flattenDirs(state.tree)) {
      if (state.collapsedOverrides.has(dirNode.id)) {
        dirNode.collapsed = state.collapsedOverrides.get(dirNode.id);
      }
    }
    const liveLeafLabels = new Set(flattenLeaves(state.tree).filter((n) => n.selectable).map((n) => n.label));
    for (const k of state.selectionOverrides.keys()) {
      if (!liveLeafLabels.has(k)) state.selectionOverrides.delete(k);
    }
    const liveDirIds = new Set(flattenDirs(state.tree).map((n) => n.id));
    for (const k of state.collapsedOverrides.keys()) {
      if (!liveDirIds.has(k)) state.collapsedOverrides.delete(k);
    }
    render();
    if (_hoveredNodeId) {
      const node = findNodeById(state.tree, _hoveredNodeId);
      if (node && node.lastCallSeq != null) {
        const touchSeqs = node.touchSeqs ?? null;
        const tier = node.churnTier ?? "mint";
        const group = node.group ?? "paths";
        const name = node.displayName ?? node.name ?? "";
        dispatchHover({ lastCallSeq: Number(node.lastCallSeq), name, touchSeqs, tier, group });
      } else {
        _hoveredNodeId = null;
        dispatchHover(null);
      }
    }
    updateSyncState();
    dispatchPreview();
  }
  function refreshDerived() {
    render();
    dispatchPreview();
  }
  function showCopyOverlay(text) {
    const existing = card.querySelector(".bucket-copy-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "bucket-copy-overlay";
    const ta = document.createElement("textarea");
    ta.readOnly = true;
    ta.value = text;
    ta.setAttribute("aria-label", "Handoff instruction \u2014 select all and copy");
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.className = "bucket-copy-overlay-dismiss";
    overlay.appendChild(ta);
    overlay.appendChild(dismissBtn);
    card.appendChild(overlay);
    ta.focus();
    ta.select();
    dismissBtn.addEventListener("click", () => overlay.remove(), { once: true });
  }
  let copyTimeout = null;
  treeEl.addEventListener("click", (e) => {
    const cbEl = e.target.closest(".bucket-cb");
    if (!cbEl) return;
    const row2 = cbEl.closest(".bucket-row");
    if (!row2) return;
    const id = row2.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.locked || !node.selectable) return;
    if (node.kind === "dir") {
      const dirState = deriveDirState(node);
      const target = dirState !== "checked";
      for (const leaf of flattenLeaves(node.children)) {
        if (leaf.selectable) {
          leaf.selected = target;
          setLocalSelection(state.selectionOverrides, leaf, target);
        }
      }
    } else {
      node.selected = !node.selected;
      setLocalSelection(state.selectionOverrides, node, node.selected);
    }
    refreshDerived();
  });
  treeEl.addEventListener("click", (e) => {
    if (e.target.closest(".bucket-cb")) return;
    const row2 = e.target.closest(".bucket-row");
    if (!row2) return;
    const id = row2.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.kind !== "dir") return;
    node.collapsed = !node.collapsed;
    state.collapsedOverrides.set(node.id, node.collapsed);
    const childrenContainer = row2.nextElementSibling;
    if (childrenContainer?.classList.contains("bucket-dir-children")) {
      childrenContainer.style.display = node.collapsed ? "none" : "";
    }
    const expand = row2.querySelector(".bucket-expand");
    if (expand) expand.classList.toggle("collapsed", node.collapsed);
  });
  treeEl.addEventListener("click", (e) => {
    const lbl = e.target.closest(".section-label");
    if (!lbl) return;
    const section = lbl.dataset.section;
    if (!section) return;
    state.sectionCollapsed[section] = !state.sectionCollapsed[section];
    lbl.classList.toggle("collapsed", state.sectionCollapsed[section]);
    const group = lbl.nextElementSibling;
    if (group?.classList.contains("section-group")) {
      group.classList.toggle("collapsed", state.sectionCollapsed[section]);
    }
  });
  let _applyNoticeTimeout = null;
  applyBtn.addEventListener("click", async () => {
    if (applyBtn.disabled) return;
    const skippedOutput = flattenLeaves(state.tree).some((n) => n.selectable && n.group === "output" && state.selectionOverrides.has(n.label));
    const overrides2 = buildOverridePayload(state.tree);
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying\u2026";
    try {
      const res = await ctx.request("/api/user-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: overrides2 })
      });
      if (res.ok) {
        state.selectionOverrides.clear();
        dispatchPreview(true);
        if (skippedOutput) {
          showApplyNotice("tool overrides not saved");
        }
      }
    } catch (e) {
      console.error("[override apply]", e);
    }
    applyBtn.textContent = "Apply";
    applyBtn.disabled = state.selectionOverrides.size === 0;
  });
  function showApplyNotice(msg) {
    if (_applyNoticeTimeout) clearTimeout(_applyNoticeTimeout);
    let notice = footer.querySelector(".bucket-apply-notice");
    if (!notice) {
      notice = document.createElement("span");
      notice.className = "bucket-apply-notice";
      footer.insertBefore(notice, footer.firstChild);
    }
    notice.textContent = msg;
    notice.style.display = "";
    _applyNoticeTimeout = setTimeout(() => {
      notice.style.display = "none";
      _applyNoticeTimeout = null;
    }, 4e3);
  }
  resetBtn.addEventListener("click", async () => {
    if (state.selectionOverrides.size > 0) {
      state.selectionOverrides.clear();
      applyOverrides(state.tree, state.selectionOverrides);
      for (const leaf of flattenLeaves(state.tree)) {
        if (!leaf.selectable) continue;
        if (leaf.userOverride === "include") leaf.selected = true;
        else if (leaf.userOverride === "exclude") leaf.selected = false;
      }
      render();
      dispatchPreview(true);
    } else {
      resetBtn.disabled = true;
      resetBtn.textContent = "Resetting\u2026";
      try {
        await ctx.request("/api/user-overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides: {} })
        });
        state.selectionOverrides.clear();
        for (const leaf of flattenLeaves(state.tree)) {
          leaf.userOverride = null;
        }
        render();
        dispatchPreview(true);
      } catch (e) {
        console.error("[override reset]", e);
      }
      resetBtn.textContent = "Reset";
      resetBtn.disabled = false;
    }
  });
  handoffBtn.addEventListener("click", async () => {
    if (state.selectionOverrides.size > 0) {
      const overrides2 = buildOverridePayload(state.tree);
      try {
        const res = await ctx.request("/api/user-overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides: overrides2 })
        });
        if (res.ok) {
          state.selectionOverrides.clear();
          dispatchPreview(true);
        }
      } catch (e) {
        console.error("[handoff auto-apply]", e);
      }
    }
    if (state.selectionOverrides.size > 0) {
      handoffBtn.textContent = "\u26A0 Override not saved";
      await new Promise((r) => setTimeout(r, 2e3));
    }
    const text = buildHandoffInstruction(state.tree);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      handoffBtn.classList.add("copied");
      handoffBtn.textContent = "\u2713 Copied";
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        handoffBtn.classList.remove("copied");
        handoffBtn.textContent = "Prepare handoff";
        copyTimeout = null;
      }, COPY_FEEDBACK_MS);
    } catch {
      showCopyOverlay(text);
    }
  });
  treeEl.addEventListener("mouseover", (e) => {
    const row2 = e.target.closest(".bucket-row");
    if (!row2) return;
    if (row2.contains(e.relatedTarget)) return;
    const lastCallSeq = row2.dataset.lastCallSeq;
    if (lastCallSeq != null) {
      const name = row2.querySelector(".bucket-name")?.textContent || "";
      const id = row2.dataset.id;
      const node = findNodeById(state.tree, id);
      const touchSeqs = node?.touchSeqs ?? null;
      const tier = node?.churnTier ?? "mint";
      const group = node?.group ?? "paths";
      _hoveredNodeId = id;
      dispatchHover({ lastCallSeq: Number(lastCallSeq), name, touchSeqs, tier, group });
    }
  });
  treeEl.addEventListener("mouseout", (e) => {
    const row2 = e.target.closest(".bucket-row");
    if (!row2) return;
    if (row2.contains(e.relatedTarget)) return;
    _hoveredNodeId = null;
    dispatchHover({ lastCallSeq: null });
  });
  treeEl.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const row2 = e.target.closest(".bucket-row");
    if (!row2) return;
    const id = row2.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.locked || !node.selectable) return;
    e.preventDefault();
    if (node.kind === "dir") {
      const dirState = deriveDirState(node);
      const target = dirState !== "checked";
      for (const leaf of flattenLeaves(node.children)) {
        if (leaf.selectable) {
          leaf.selected = target;
          setLocalSelection(state.selectionOverrides, leaf, target);
        }
      }
    } else {
      node.selected = !node.selected;
      setLocalSelection(state.selectionOverrides, node, node.selected);
    }
    refreshDerived();
  });
  function destroy() {
    clearStaleInterval();
    if (copyTimeout) {
      clearTimeout(copyTimeout);
      copyTimeout = null;
    }
    const overlay = card.querySelector(".bucket-copy-overlay");
    if (overlay) overlay.remove();
    for (const t of state._bodyTips) t.remove();
    state._bodyTips.length = 0;
    if (unsubBucketState) unsubBucketState();
    dispatchHover(null);
    dispatchPreview(true);
    card.remove();
  }
  const unsubBucketState = ctx?.transport?.onBucketState?.(() => {
    if (state.lastGoodBucketData) updateSyncState();
  });
  renderSkeleton();
  return { update, destroy };
}

// dsh/src/client/elements.js
var SLOT_TABLES = {
  chrome: [mount],
  hero: [mount2, mount3, mount4],
  history: [mount5, mount6],
  buckets: [mount7]
};

// dsh/src/client/tab.js
var h = import_react.default.createElement;
var SLOT_ORDER = ["chrome", "buckets", "hero", "history"];
var LEAF_IDS = { chrome: "sw-chrome", hero: "sw-hero", history: "sw-history", buckets: "sw-buckets" };
function resultBadge(result, t) {
  return { state: resultSignalState(result), title: stateText(result, t) };
}
function SignalBadge({ state, title, t }) {
  return h(
    "span",
    { className: "sw-chrome-conn", "data-state": state, role: "status", title },
    h("span", { className: "sw-chrome-conn-dot", "aria-hidden": "true" }),
    h("span", { className: "sw-chrome-conn-label" }, t(`signal.${state}`))
  );
}
function SessionWatcherScreen({ result, t, rootRef, scheme, signalState }) {
  const badge = signalState !== "live" ? { state: signalState } : result?.kind === "live" ? { state: "live" } : resultBadge(result, t);
  return h(
    "div",
    { "data-sw-tab": "", "data-sw-scheme": scheme, ref: rootRef },
    h("div", { id: LEAF_IDS.chrome }, h(SignalBadge, { ...badge, t })),
    h("div", { id: LEAF_IDS.hero }),
    h("div", { className: "sw-lower" }, h("div", { id: LEAF_IDS.history }), h("div", { id: LEAF_IDS.buckets }))
  );
}
function createMountController({ ctx, tables, log = console.error }) {
  const instances2 = [];
  function contained(slot, phase, run) {
    try {
      return run();
    } catch (error) {
      log(`[sw] ${slot} ${phase} failed`, error);
      return void 0;
    }
  }
  function update(snapshot) {
    for (const { slot, instance } of instances2) contained(slot, "update", () => instance.update(snapshot));
  }
  return {
    mount(leaves, snapshot) {
      for (const slot of SLOT_ORDER) {
        for (const mount8 of tables[slot]) {
          const instance = contained(slot, "mount", () => mount8(leaves[slot], ctx));
          if (instance !== void 0) instances2.push({ slot, instance });
        }
      }
      if (snapshot !== null) update(snapshot);
    },
    update,
    destroy() {
      for (const { slot, instance } of instances2) contained(slot, "destroy", () => instance.destroy());
    }
  };
}
function scrollHostToTop(root) {
  const scrollport = root.closest("[data-conversation-scroll]");
  if (scrollport !== null) scrollport.scrollTop = 0;
}
var themeKey = (theme) => JSON.stringify([theme.active.id, theme.active.colorScheme, theme.active.tokens]);
var colorScheme = (theme) => theme.active.colorScheme;
function SessionWatcherTab({ store, signalState, call, useTheme, t }) {
  const rootRef = import_react.default.useRef(null);
  const contextRef = import_react.default.useRef(null);
  const [result, setResult] = import_react.default.useState(() => store.result);
  const snapshotRef = import_react.default.useRef(result?.kind === "live" ? result.snapshot : null);
  const controllerRef = import_react.default.useRef(null);
  const theme = useTheme(themeKey);
  const scheme = useTheme(colorScheme);
  const connection = import_react.default.useSyncExternalStore(signalState.subscribe, signalState.getSnapshot, signalState.getSnapshot);
  const isLive = result?.kind === "live";
  import_react.default.useLayoutEffect(() => {
    scrollHostToTop(rootRef.current);
    contextRef.current = { ...createTabContext({ call, root: rootRef.current }), transport: store };
    return store.subscribe((next) => {
      if (next.kind === "live") {
        snapshotRef.current = next.snapshot;
        controllerRef.current?.update(next.snapshot);
      }
      setResult(next);
    });
  }, []);
  import_react.default.useLayoutEffect(() => {
    const root = rootRef.current;
    const leaves = {};
    for (const slot of SLOT_ORDER) leaves[slot] = root.querySelector("#" + LEAF_IDS[slot]);
    const controller = createMountController({ ctx: contextRef.current, tables: SLOT_TABLES });
    controller.mount(leaves, isLive ? snapshotRef.current : null);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, [isLive, theme]);
  return h(SessionWatcherScreen, { result, t, rootRef, scheme, signalState: connection });
}

// public/lib/featureDetect.js
function buildCapabilities(status) {
  const rl = status?.rateLamp;
  const reliable = rl?.reliable === true;
  const hasBillProgress = rl?.billProgress != null && Number.isFinite(rl.billProgress);
  const landmarks = reliable && rl.xSweet != null;
  const landmarkReason = !reliable ? "calibrating" : !landmarks ? "reference unavailable" : null;
  return {
    eoqLandmarks: { available: landmarks, reason: landmarkReason },
    billingLedger: { available: hasBillProgress, reason: !hasBillProgress ? "billing ledger unavailable" : null }
  };
}

// public/lib/bucketState.js
var BUCKET_FETCH_DEBOUNCE_MS = 300;
function createBucketStateTracker() {
  const listeners = /* @__PURE__ */ new Set();
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let isFetching = false;
  let fetchingTimer = null;
  function snapshot() {
    return { isFetching, consecutiveFailures, lastSuccessAt };
  }
  function notify() {
    const s = snapshot();
    for (const cb of listeners) cb(s);
  }
  return {
    begin() {
      if (fetchingTimer) return;
      fetchingTimer = setTimeout(() => {
        isFetching = true;
        notify();
      }, BUCKET_FETCH_DEBOUNCE_MS);
    },
    end(ok) {
      if (fetchingTimer) {
        clearTimeout(fetchingTimer);
        fetchingTimer = null;
      }
      const wasFetching = isFetching;
      isFetching = false;
      if (ok === true) {
        consecutiveFailures = 0;
        lastSuccessAt = Date.now();
      } else if (ok === false) consecutiveFailures++;
      else if (!wasFetching) return;
      notify();
    },
    get state() {
      return snapshot();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
}

// dsh/src/client/session-store.js
var MIN_GAP_MS = 1e3;
var PULL_TIMEOUT_MS = 5e3;
var ENDPOINTS2 = ["status", "history", "buckets"];
var messageOf = (error) => String(error?.message ?? error);
function fold(settled) {
  for (const outcome of settled) {
    if (outcome.status === "rejected") return { kind: "unreachable", message: messageOf(outcome.reason) };
    if (outcome.value.ok !== true) return { kind: "unreachable", message: outcome.value.error.message };
  }
  for (const { value: { value } } of settled) {
    if (value.state !== "live") return { kind: "state", state: value.state, diagnostic: value.diagnostic };
  }
  const [status, history, bucketData] = settled.map((outcome) => outcome.value.value.payload);
  return { kind: "live", snapshot: { status, history, capabilities: buildCapabilities(status), bucketData } };
}
var answeredLive = (outcome) => outcome.status === "fulfilled" && outcome.value.ok === true && outcome.value.value.state === "live";
function createSessionStores({
  call,
  minGap = MIN_GAP_MS,
  pullTimeout = PULL_TIMEOUT_MS,
  setTimeout: setTimeout2 = globalThis.setTimeout,
  clearTimeout: clearTimeout2 = globalThis.clearTimeout,
  now = Date.now
}) {
  const stores = /* @__PURE__ */ new Map();
  function createStore(sessionId) {
    const listeners = /* @__PURE__ */ new Set();
    const tracker = createBucketStateTracker();
    let timer = null;
    let inflight = null;
    let dirty = false;
    let lastDone = null;
    let result = null;
    function arm(delay) {
      timer = setTimeout2(() => {
        timer = null;
        pull();
      }, delay);
    }
    function attempt(endpoint, signal2) {
      try {
        return Promise.resolve(call(endpoint, { sessionId }, signal2));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    function pull() {
      const controller = new AbortController();
      inflight = controller;
      tracker.begin();
      const calls = Promise.allSettled(ENDPOINTS2.map((endpoint) => attempt(endpoint, controller.signal)));
      const deadline = setTimeout2(() => {
        controller.abort(new Error("the pull timed out"));
        complete(ENDPOINTS2.map(() => ({ status: "rejected", reason: controller.signal.reason })));
      }, pullTimeout);
      calls.then((settled) => {
        if (inflight !== controller) return;
        clearTimeout2(deadline);
        complete(settled);
      });
    }
    function complete(settled) {
      inflight = null;
      lastDone = now();
      result = fold(settled);
      if (dirty) {
        dirty = false;
        if (listeners.size > 0) arm(minGap);
      }
      tracker.end(answeredLive(settled[ENDPOINTS2.indexOf("buckets")]));
      for (const listener of listeners) listener(result);
    }
    function signal() {
      if (listeners.size === 0) return;
      if (inflight) {
        dirty = true;
        return;
      }
      if (timer !== null) return;
      if (lastDone === null || now() - lastDone >= minGap) pull();
      else arm(lastDone + minGap - now());
    }
    return {
      get result() {
        return result;
      },
      signal,
      refresh: signal,
      subscribe(listener) {
        listeners.add(listener);
        signal();
        return () => {
          if (!listeners.delete(listener) || listeners.size > 0 || timer === null) return;
          clearTimeout2(timer);
          timer = null;
        };
      },
      get bucketState() {
        return tracker.state;
      },
      onBucketState: (cb) => tracker.subscribe(cb)
    };
  }
  return {
    for(sessionId) {
      let store = stores.get(sessionId);
      if (!store) {
        store = createStore(sessionId);
        stores.set(sessionId, store);
      }
      return store;
    },
    signal(sessionId) {
      stores.get(sessionId)?.signal();
    },
    openAll() {
      for (const store of stores.values()) store.signal();
    }
  };
}

// dsh/src/client/signal.js
var REOPEN_DELAYS_MS = [1e3, 2e3, 5e3, 1e4];
function openSignalStream({ url, EventSource, onFrame, onOpen, onState, setTimeout: setTimeout2, clearTimeout: clearTimeout2 }) {
  let source = null;
  let reopenTimer = null;
  let attempt = 0;
  function connect() {
    const current = new EventSource(url);
    source = current;
    onState("connecting");
    current.addEventListener("message", (event) => {
      let sessionId;
      try {
        ({ sessionId } = JSON.parse(event.data));
      } catch {
        sessionId = void 0;
      }
      if (typeof sessionId !== "string") {
        console.error("[sw] malformed signal frame", event.data);
        return;
      }
      onFrame(sessionId);
    });
    current.addEventListener("open", () => {
      attempt = 0;
      onState("live");
      onOpen();
    });
    current.addEventListener("error", () => {
      if (current.readyState !== EventSource.CLOSED) {
        onState("connecting");
        return;
      }
      onState("disconnected");
      const delay = REOPEN_DELAYS_MS[Math.min(attempt, REOPEN_DELAYS_MS.length - 1)];
      attempt += 1;
      reopenTimer = setTimeout2(() => {
        reopenTimer = null;
        connect();
      }, delay);
    });
  }
  connect();
  return {
    close() {
      if (reopenTimer !== null) {
        clearTimeout2(reopenTimer);
        reopenTimer = null;
      }
      source.close();
    }
  };
}

// dsh/src/client/dock.js
var import_react2 = __toESM(require("react"), 1);

// public/lib/format.js
var PLACEHOLDER = "\u2014";
function formatTokens(n) {
  if (!Number.isFinite(n)) return PLACEHOLDER;
  return `${Math.round(n).toLocaleString("en-US")} tok`;
}
function formatBr(br) {
  if (!Number.isFinite(br) || br < 0) return PLACEHOLDER;
  return `${Math.floor(br * 100)}%`;
}
function formatU(u) {
  if (!Number.isFinite(u)) return PLACEHOLDER;
  return u.toFixed(1);
}
function formatDelta(gEma) {
  if (!Number.isFinite(gEma) || gEma < 1) return PLACEHOLDER;
  return formatTokens(gEma);
}
function phasePercent(phase) {
  return Math.floor(Math.min(0.999999, Math.max(0, phase)) * 100);
}
function formatPhase(phase) {
  if (!Number.isFinite(phase)) return PLACEHOLDER;
  return `${phasePercent(phase)}%`;
}

// dsh/src/client/dock.js
var h3 = import_react2.default.createElement;
var PANEL_MARGIN = 12;
var PANEL_GAP = 8;
var MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };
var PILL_BR_CAP = 0.99;
var BADGE_CAP = 99;
var TRACK_SPAN = 1.25;
var ARROWS = { left: "M1.5 4.5 5.5 8.5 8 6 13.5 11.5M10 11.5h3.5V8", right: "M1.5 11.5 5.5 7.5 8 10 13.5 4.5M10 4.5h3.5V8" };
function ring(zone, arc, idle) {
  return h3(
    "svg",
    { className: "sw-lamp", "data-zone": zone, "data-idle": idle ? "" : void 0, width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" },
    h3("circle", { className: "trk", cx: 7, cy: 7, r: 5.5, pathLength: 100 }),
    arc > 0 ? h3("circle", { className: "arc", cx: 7, cy: 7, r: 5.5, pathLength: 100, transform: "rotate(-90 7 7)", strokeDasharray: `${arc} 100` }) : null,
    h3("circle", { className: "core", cx: 7, cy: 7, r: 2 })
  );
}
var row = (label, value, swatch) => h3(
  import_react2.default.Fragment,
  { key: label },
  h3("dt", null, swatch === void 0 ? null : h3("i", { className: "sw-sw", "data-k": swatch }), label),
  h3("dd", null, value)
);
function track(rateLamp, t) {
  const { reference, xSweet, xBrAmberL, xBrAmberR, xBrRedR } = rateLamp;
  const x = projectedX(reference, rateLamp.u);
  if (![x, xSweet, xBrAmberL, xBrAmberR, xBrRedR].every(Number.isFinite)) return null;
  const minX = reference.a;
  const { markerPct, brAmberLPct, sweetPct, brAmberRPct, brRedRPct } = computeLandmarkPositions({
    domain: { minX, maxX: minX + (xBrRedR - minX) * TRACK_SPAN },
    xBrAmberL,
    xSweet,
    xBrAmberR,
    xBrRedR,
    wallP: xBrRedR,
    x
  });
  const bands = [["white", 0, brAmberLPct], ["green", brAmberLPct, brAmberRPct], ["amber", brAmberRPct, brRedRPct], ["red", brRedRPct, 100]].map(([zone, from2, to2]) => h3("i", { key: zone, "data-zone": zone, style: { flex: (to2 - from2).toFixed(2) } }));
  const sweetLeft = `${sweetPct.toFixed(2)}%`;
  return h3(
    import_react2.default.Fragment,
    null,
    h3(
      "div",
      { className: "sw-track", "aria-hidden": "true" },
      bands,
      h3("div", { className: "sw-lit", style: { clipPath: `inset(0 ${(100 - markerPct).toFixed(2)}% 0 0)` } }, bands),
      h3("s", { style: { left: sweetLeft } }),
      h3("b", { style: { left: `${markerPct.toFixed(2)}%` } })
    ),
    h3("div", { className: "sw-scale" }, h3("span", { style: { left: sweetLeft } }, t("dock.sweet")))
  );
}
function contextStock(status, rateLamp, t) {
  const baseline = status.bDefault ?? status.B;
  const effective = Math.max(0, status.L - baseline);
  return h3(
    "div",
    { className: "sw-sec" },
    h3("div", { className: "sw-ctx-h" }, h3("span", null, t("dock.stock")), h3("span", null, formatTokens(status.L))),
    h3("div", { className: "sw-stock", "aria-hidden": "true" }, h3("i", { "data-k": "base", style: { flex: baseline } }), h3("i", { "data-k": "eff", style: { flex: effective } })),
    h3("dl", null, row(t("dock.baseline"), formatTokens(baseline), "base"), row(t("dock.effective"), formatTokens(effective), "eff")),
    h3("dl", { className: "sw-rows" }, row(t("dock.growth"), formatDelta(rateLamp.gEma)))
  );
}
function latestAlert(previous, result) {
  const event = result?.kind === "live" ? result.snapshot.status.rateLamp?.lastStopEvent : null;
  return event?.message ? event : previous;
}
function createDock({ useAnchoredPosition: useAnchoredPosition2, useDismissOnOutsidePointer: useDismissOnOutsidePointer2, createPortal: createPortal2 }) {
  function DockView({ result, alert, t, open, onOpenChange }) {
    const rootRef = import_react2.default.useRef(null);
    const panelRef = import_react2.default.useRef(null);
    const position = useAnchoredPosition2({ open, anchorRef: rootRef, panelRef, side: "top", gap: PANEL_GAP, margin: PANEL_MARGIN });
    useDismissOnOutsidePointer2(rootRef, open, onOpenChange, panelRef);
    import_react2.default.useEffect(() => {
      if (!open) return void 0;
      const onKeyDown = (event) => {
        if (event.key === "Escape") onOpenChange(false);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => {
        document.removeEventListener("keydown", onKeyDown);
      };
    }, [open, onOpenChange]);
    const status = result?.kind === "live" ? result.snapshot.status : null;
    const rateLamp = status?.rateLamp?.reliable === true && Number.isFinite(status.rateLamp.br) ? status.rateLamp : null;
    const meter = rateLamp?.rentMeter;
    const clockActive = meter?.depthActive === true;
    const laps = meter?.backstopLapCount;
    const arm = rateLamp?.u < 1 ? "left" : "right";
    const word = rateLamp !== null ? null : status !== null ? t("dock.calibrating") : t(`signal.${resultSignalState(result)}`);
    const clockValue = clockActive ? formatPhase(meter.depthProgress) : t("dock.clockIdle");
    const summary = rateLamp === null ? word : [
      `${t("dock.br")} ${formatBr(rateLamp.br)}`,
      t(arm === "left" ? "dock.armLeft" : "dock.armRight"),
      `${t("dock.clock")} ${clockValue}`,
      ...laps > 0 ? [t("dock.laps", { count: laps })] : []
    ].join(t("dock.separator"));
    const name = t("dock.pill", { summary });
    const lamp = ring(rateLamp === null ? "white" : status.lamp, clockActive ? phasePercent(meter.depthProgress) : 0, rateLamp !== null && !clockActive);
    const pill = h3(
      "button",
      {
        type: "button",
        ref: rootRef,
        "data-sw-dock": "",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-label": name,
        title: name,
        onClick: () => onOpenChange(!open)
      },
      lamp,
      h3("span", null, rateLamp === null ? word : `${t("dock.br")} ${formatBr(Math.min(rateLamp.br, PILL_BR_CAP))}`),
      rateLamp === null ? null : h3("svg", { className: "sw-arm", "data-arm": arm, viewBox: "0 0 16 16", "aria-hidden": "true" }, h3("path", { d: ARROWS[arm] })),
      laps > 0 ? h3("span", { className: "sw-count", "data-hot": meter.depthHot ? "" : void 0, role: "img", "aria-label": t("dock.laps", { count: laps }) }, laps > BADGE_CAP ? `${BADGE_CAP}+` : laps) : null
    );
    if (!open) return pill;
    const failing = status === null && ["failed", "unreachable"].includes(resultSignalState(result));
    const header = [
      h3(
        "div",
        { key: "title", className: "sw-title" },
        h3("span", { className: "sw-title-label" }, lamp, t("view.label")),
        h3("span", { className: "sw-title-value", "data-tone": failing ? "error" : void 0 }, rateLamp === null ? word : t(`dock.zone.${status.lamp}`))
      ),
      h3("div", { key: "rule", className: "sw-title-rule" })
    ];
    const body = rateLamp === null ? h3("p", null, status === null ? stateText(result, t) : t("dock.insufficientData")) : h3(
      import_react2.default.Fragment,
      null,
      h3(
        "div",
        { className: "sw-hero" },
        h3("div", null, h3("div", { className: "sw-hero-fig" }, formatBr(rateLamp.br)), h3("div", { className: "sw-hero-cap" }, t("dock.br"))),
        h3("div", { className: "sw-hero-pos" }, h3("span", { className: "sw-hero-fig" }, formatU(rateLamp.u)), h3("small", null, t("dock.u")))
      ),
      track(rateLamp, t),
      contextStock(status, rateLamp, t),
      h3(
        "div",
        { className: "sw-sec" },
        h3("div", { className: "sw-ctx-h" }, h3("span", null, t("dock.clock")), h3("span", null, clockValue)),
        clockActive ? h3("div", { className: "sw-bar", "data-zone": status.lamp, "aria-hidden": "true" }, h3("i", { style: { width: `${phasePercent(meter.depthProgress)}%` } })) : null,
        alert && laps >= alert.billCount ? h3("div", { className: "sw-alert", "data-zone": status.lamp }, h3("p", null, alert.message)) : null
      )
    );
    const panel = h3("div", {
      ref: panelRef,
      "data-sw-dock": "",
      role: "dialog",
      "aria-label": t("dock.label"),
      style: position ?? MEASURE_STYLE
    }, header, body);
    return h3(import_react2.default.Fragment, null, pill, createPortal2(panel, document.body));
  }
  function Dock({ store, t }) {
    const [result, setResult] = import_react2.default.useState(() => store.result);
    const [alert, setAlert] = import_react2.default.useState(() => latestAlert(null, store.result));
    const [open, setOpen] = import_react2.default.useState(false);
    import_react2.default.useEffect(() => store.subscribe((next) => {
      setResult(next);
      setAlert((previous) => latestAlert(previous, next));
    }), [store]);
    return h3(DockView, { result, alert, t, open, onOpenChange: setOpen });
  }
  return { Dock, DockView };
}

// dsh/src/client/plugin.js
var PLUGIN_ID = "@nomadop/session-watcher-dsh";
var CHANNEL = "/session-watcher";
var EVENTS_URL = "api/session-watcher.events";
function applyClient(ctx, { tabCss, useAnchoredPosition: useAnchoredPosition2, useDismissOnOutsidePointer: useDismissOnOutsidePointer2, createPortal: createPortal2 }) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), "session-watcher: dictionaries");
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_ID;
    tag.dataset.pluginCss = `${PLUGIN_ID}/tab.css`;
    tag.textContent = tabCss;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "session-watcher: tab stylesheet");
  const sessions = createSessionStores({
    call: (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
  });
  let signalState = "connecting";
  const signalListeners = /* @__PURE__ */ new Set();
  const signalStore = {
    getSnapshot: () => signalState,
    subscribe(listener) {
      signalListeners.add(listener);
      return () => {
        signalListeners.delete(listener);
      };
    }
  };
  const setSignalState = (next) => {
    if (next === signalState) return;
    signalState = next;
    for (const listener of [...signalListeners]) listener();
  };
  ctx.effect(() => {
    const { generation } = ctx.connection;
    let stream = null;
    let seen = generation.getSnapshot()?.id;
    const open = () => {
      stream = openSignalStream({
        url: EVENTS_URL,
        EventSource: globalThis.EventSource,
        onFrame: sessions.signal,
        onOpen: sessions.openAll,
        onState: setSignalState,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout
      });
    };
    const close = () => {
      stream?.close();
      stream = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") open();
      else close();
    };
    const unsubscribe = generation.subscribe(() => {
      const id = generation.getSnapshot()?.id;
      if (id === void 0) return;
      if (seen !== void 0 && id !== seen && stream !== null) {
        close();
        open();
      }
      seen = id;
    });
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") open();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      close();
    };
  }, "session-watcher: signal stream");
  const t = ctx.locale.bind(NS);
  const theme = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: (listener) => ctx.on("theme/change", listener)
  };
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "session-watcher",
    order: 20,
    locale: NS,
    label: () => t("view.label"),
    inject: (sessionId) => ({
      store: sessions.for(sessionId),
      signalState: signalStore,
      call: (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, { ...payload, sessionId }),
      hooks: { theme }
    })
  }, SessionWatcherTab));
  const { Dock } = createDock({ useAnchoredPosition: useAnchoredPosition2, useDismissOnOutsidePointer: useDismissOnOutsidePointer2, createPortal: createPortal2 });
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
    name: "conversation.composer.dock",
    id: "session-watcher",
    order: 10,
    locale: NS,
    inject: (sessionId) => ({ store: sessions.for(sessionId) })
  }, Dock));
}

// public/themes/base.css
var base_default = `/* base.css \u2014 structural layout. NO colors, NO fonts except fallbacks. */

*, *::before, *::after { box-sizing: border-box; }

/* Every capsule or circle radius is paired with \`corner-shape: round\`, in both sheets: the DSH host sets a superellipse corner-shape on every element, which squares off such ends. */

/* The page gutter. The DSH tab root reads it through the scoper's :root \u2192 :scope rewrite. */
:root { --sw-gutter: 24px 26px 50px; }

body {
  margin: 0;
  padding: var(--sw-gutter);
  -webkit-font-smoothing: antialiased;
  font-family: "Inter", system-ui, sans-serif;
}

/* \u2500\u2500 Outer wrapper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-wrap {
  max-width: 1180px;
  margin: 0 auto;
}

/* \u2500\u2500 Chrome (#sw-chrome) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
#sw-chrome {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  position: relative;
  flex-wrap: nowrap;
}

/* \u2500\u2500 Hero (#sw-hero) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
#sw-hero {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  grid-template-rows: auto auto;
  align-items: stretch;
  border-radius: 22px;
  overflow: hidden;
}

/* heroDiptych occupies left column row 1, verdict row spans both at row 2,
   depthAux is left col row 3, burnMeter is right col rows 1-3. */
.sw-hero-diptych {
  grid-column: 1;
  grid-row: 1;
}

.sw-hero-verdict-row {
  grid-column: 1 / -1;
  grid-row: 3;
}

.sw-depth-aux {
  grid-column: 1;
  grid-row: 2;
  padding: 0 24px 16px;
  overflow: visible;
}

.sw-aux-bar-outer {
  overflow: visible;
}

.sw-aux-viewport-frame {
  position: absolute;
  top: -4px;
  bottom: -4px;
  border: 2px solid var(--sw-highlight, rgba(238, 243, 246, 0.7));
  background: var(--sw-hover, rgba(238, 243, 246, 0.04));
  border-radius: 4px;
  pointer-events: none;
  z-index: 2;
  box-shadow: var(--sw-glow, 0 0 6px rgba(238, 243, 246, 0.3));
}

.sw-aux-bar-wrap {
  position: relative;
  height: 20px;
  border-radius: 5px;
  overflow: visible;
  border: 1px solid var(--edge, #252f37);
  font-family: "JetBrains Mono", monospace;
  font-size: 8px;
}

.sw-aux-gradient {
  position: absolute;
  top: 0; bottom: 0; left: 0; right: 0;
  border-radius: 4px;
}

.sw-aux-marker {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 2px;
  background: var(--sw-highlight, #fff);
  box-shadow: var(--sw-glow, 0 0 6px rgba(255, 255, 255, 0.6));
  transition: opacity 0.15s;
}

.sw-aux-marker::before {
  content: "";
  position: absolute;
  left: -4px;
  top: -4px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid var(--sw-highlight, #fff);
}

.sw-aux-marker::after {
  content: "";
  position: absolute;
  left: -10px;
  right: -10px;
  top: -8px;
  bottom: -8px;
  cursor: pointer;
}

.sw-aux-flag {
  position: absolute;
  top: -27px;
  transform: translateX(-50%);
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  background: var(--sw-overlay, rgba(13, 18, 20, 0.95));
  border: 1px solid var(--amber-dim, #7a5a20);
  color: var(--amber, #ffc24d);
  border-radius: 5px;
  padding: 2px 7px;
  white-space: nowrap;
}

.sw-aux-flag b { color: var(--sw-highlight, #fff); }

.sw-aux-zone-label {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  font-family: "JetBrains Mono", monospace;
  font-size: 8px;
  pointer-events: none;
}

.sw-aux-label-ext-left {
  position: absolute;
  right: calc(100% + 4px);
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  font-family: "JetBrains Mono", monospace;
  font-size: 8px;
  color: var(--txt-dim, #93a1ab);
  letter-spacing: 0.02em;
}

.sw-aux-label-ext-right {
  position: absolute;
  left: calc(100% + 4px);
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  font-family: "JetBrains Mono", monospace;
  font-size: 8px;
  color: var(--coral, #ff7566);
  letter-spacing: 0.02em;
}

.sw-burn-meter {
  grid-column: 2;
  grid-row: 1 / 3;
}

/* \u2500\u2500 Lower section (history + buckets side by side) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-lower {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}

#sw-history {
  min-width: 0;
}

#sw-history canvas {
  width: 100%;
}

#sw-buckets {
  min-width: 0;
}

/* Card container */
#sw-buckets .bucket-card {
  background: var(--card);
  border: 1px solid var(--edge);
  border-radius: 18px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  height: 360px;
}

/* \u2500\u2500 Header: Donut + stats \u2500\u2500\u2500 */
#sw-buckets .bucket-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

#sw-buckets .header-donut {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  position: relative;
}

#sw-buckets .header-donut svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
  transition: all 0.3s ease;
}

#sw-buckets .header-info h3 {
  font-family: "Sora", sans-serif;
  font-weight: 600;
  font-size: 14px;
  margin: 0;
  color: var(--txt);
}

#sw-buckets .header-info .subtitle {
  font-size: 10.5px;
  color: var(--mute);
  margin-top: 2px;
}

#sw-buckets .header-stats {
  margin-left: auto;
  text-align: right;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  line-height: 1.7;
}

#sw-buckets .header-stats .val-selected {
  color: var(--mint);
}

#sw-buckets .header-stats .val-discarded {
  color: var(--coral);
}

/* \u2500\u2500 Section labels \u2500\u2500\u2500 */
#sw-buckets .section-label {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--txt-dim);
  margin: 10px 0 6px;
  padding-left: 2px;
}

#sw-buckets .section-label:first-of-type {
  margin-top: 0;
}

#sw-buckets .section-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  transition: transform 0.15s;
  transform: rotate(90deg);
}

#sw-buckets .section-chevron svg {
  width: 12px;
  height: 12px;
}

#sw-buckets .section-label.collapsed .section-chevron {
  transform: rotate(0deg);
}

#sw-buckets .section-summary {
  margin-left: auto;
  font-size: 9px;
  opacity: 0;
  transition: opacity 0.15s;
}

#sw-buckets .section-label.collapsed .section-summary {
  opacity: 1;
}

#sw-buckets .section-group.collapsed {
  display: none;
}

/* \u2500\u2500 Tree rows \u2500\u2500\u2500 */
#sw-buckets .bucket-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  line-height: 1;
}

#sw-buckets .bucket-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4.5px 4px;
  position: relative;
  border-radius: 4px;
  cursor: default;
  min-height: 24px;
}

#sw-buckets .bucket-row:hover {
  background-color: var(--sw-hover, rgba(79, 224, 176, 0.04));
}

#sw-buckets .bucket-row.is-dir {
  cursor: pointer;
}

#sw-buckets .bucket-row.is-dir:hover {
  background-color: var(--sw-hover, rgba(79, 224, 176, 0.06));
}

/* Indent \u2014 dynamic depth (IDE-style: no hard cap).
   Each indent level adds 18px padding. Vertical guide lines are drawn via
   multiple backgrounds set by JS (one 1px line per ancestor level). */
#sw-buckets .bucket-row[data-indent] {
  padding-left: calc(var(--indent, 0) * 18px + 4px);
}

/* Focus ring (a11y) */
#sw-buckets .bucket-row:focus-visible {
  outline: 1px solid var(--mint);
  outline-offset: -1px;
}

/* \u2500\u2500 Checkbox \u2500\u2500\u2500 */
#sw-buckets .bucket-cb {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--mute);
  border-radius: 3px;
  flex-shrink: 0;
  cursor: pointer;
  position: relative;
  transition: all 0.15s;
}

#sw-buckets .bucket-cb.checked {
  background: var(--mint);
  border-color: var(--mint);
}

#sw-buckets .bucket-cb.checked::after {
  content: "";
  position: absolute;
  top: 0.5px;
  left: 3px;
  width: 4px;
  height: 6.5px;
  border: solid var(--sw-on-mint, #052018);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

#sw-buckets .bucket-cb.locked {
  background: var(--mute);
  border-color: var(--mute);
  cursor: default;
  opacity: 0.35;
}

/* Half-select (indeterminate) state for directories */
#sw-buckets .bucket-cb.half {
  background: linear-gradient(135deg, var(--mint) 50%, transparent 50%);
  border-color: var(--mint);
}

/* \u2500\u2500 Expand toggle \u2500\u2500\u2500 */
#sw-buckets .bucket-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  transition: transform 0.15s;
  transform: rotate(90deg);
  color: var(--txt-dim);
}

#sw-buckets .bucket-expand svg {
  width: 12px;
  height: 12px;
}

#sw-buckets .bucket-expand.collapsed {
  transform: rotate(0deg);
}

/* \u2500\u2500 Icon \u2500\u2500\u2500 */
#sw-buckets .bucket-icon {
  font-size: 10px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

/* \u2500\u2500 Name wrap (flex item that shrinks; holds name + badge inline) \u2500\u2500\u2500 */
#sw-buckets .bucket-name-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

/* \u2500\u2500 Name kind classes \u2500\u2500\u2500 */
#sw-buckets .bucket-name {
  color: var(--txt-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 2px;
}

#sw-buckets .bucket-name.is-dir-name {
  color: var(--txt);
  font-weight: 500;
}

#sw-buckets .bucket-name.is-special {
  color: var(--amber);
}

#sw-buckets .bucket-name.is-system {
  color: var(--mute);
}

#sw-buckets .bucket-name.is-skill {
  color: var(--sky);
}

#sw-buckets .bucket-name.is-others {
  color: var(--mute);
  font-style: italic;
}

/* \u2500\u2500 Call-count badge (iOS capsule style) \u2500\u2500\u2500 */
#sw-buckets .bucket-count {
  font-family: "JetBrains Mono", monospace;
  font-size: 8.5px;
  font-weight: 500;
  color: var(--amber);
  background: var(--sw-wash, rgba(255, 194, 77, 0.12));
  border-radius: 100px;
  corner-shape: round;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
  flex-shrink: 0;
  margin-left: 4px;
  line-height: 1.4;
}

/* \u2500\u2500 Token count + bar \u2500\u2500\u2500 */
#sw-buckets .bucket-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

#sw-buckets .bucket-tokens {
  font-size: 10px;
  color: var(--txt-dim);
  white-space: nowrap;
  min-width: 32px;
  text-align: right;
}

#sw-buckets .bucket-bar-wrap {
  display: inline-block;
  width: 48px;
  height: 6px;
  border-radius: 3px;
  background: var(--edge);
  overflow: hidden;
  flex-shrink: 0;
  vertical-align: middle;
}

#sw-buckets .bucket-bar {
  display: block;
  height: 100%;
  border-radius: 3px;
  min-width: 3px;
  transition: width 0.3s ease;
}

#sw-buckets .bucket-bar.color-mint  { background: var(--mint); }
#sw-buckets .bucket-bar.color-amber { background: var(--amber); }
#sw-buckets .bucket-bar.color-coral { background: var(--coral); }
#sw-buckets .bucket-bar.color-mute  { background: var(--mute); }
#sw-buckets .bucket-bar.color-sky   { background: var(--sky); }

/* \u2500\u2500 Churn tier: path name coloring \u2500\u2500 */
#sw-buckets .bucket-name.churn-med  { color: var(--amber); }
#sw-buckets .bucket-name.churn-high { color: var(--coral); }
#sw-buckets .bucket-name.is-dir-name.churn-med  { color: var(--amber); opacity: 0.85; }
#sw-buckets .bucket-name.is-dir-name.churn-high { color: var(--coral); opacity: 0.85; }

/* \u2500\u2500 Excluded rows \u2500\u2500 */
#sw-buckets .bucket-row.is-excluded { opacity: 0.5; }
#sw-buckets .bucket-row.is-excluded .bucket-cb { border-style: dashed; }
#sw-buckets .bucket-row.is-excluded .bucket-name { font-style: italic; color: var(--mute); }

/* \u2500\u2500 Section separator \u2500\u2500\u2500 */
#sw-buckets .bucket-sep {
  border: none;
  border-top: 1px dotted var(--edge);
  margin: 8px 0;
}

/* \u2500\u2500 Dir children container \u2500\u2500\u2500 */
#sw-buckets .bucket-dir-children {
  /* display:none toggled by JS when collapsed */
}

/* Override indicator \u2014 wavy underline on filename */
#sw-buckets .bucket-name[data-override] {
  text-decoration: underline wavy;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  overflow: visible;
}
#sw-buckets .bucket-name[data-override="include"] {
  text-decoration-color: var(--sw-ok, rgba(79, 224, 176, 0.4));
}
#sw-buckets .bucket-name[data-override="exclude"] {
  text-decoration-color: var(--sw-bad, rgba(255, 117, 102, 0.4));
}

/* \u2500\u2500 Footer \u2500\u2500\u2500 */
#sw-buckets .bucket-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dotted var(--edge);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  position: relative;
}

#sw-buckets .bucket-copy-btn {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  background: var(--mint);
  border: 1px solid var(--mint);
  border-radius: 8px;
  padding: 6px 12px;
  color: var(--sw-on-mint, #052018);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

#sw-buckets .bucket-copy-btn:hover {
  opacity: var(--sw-hover-opacity, 0.85);
}

#sw-buckets .bucket-copy-btn.copied {
  background: var(--mint-dim);
  border-color: var(--mint);
  color: var(--sw-on-fill, var(--mint));
}

#sw-buckets .bucket-reset-btn {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--mute);
  border: 1px solid var(--edge);
  border-radius: 8px;
  padding: 6px 12px;
  background: none;
  cursor: pointer;
  transition: all 0.2s;
}

#sw-buckets .bucket-reset-btn.active {
  color: var(--txt-dim);
  border-color: var(--txt-dim);
}

#sw-buckets .bucket-apply-btn {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  background: var(--mint);
  border: 1px solid var(--mint);
  border-radius: 8px;
  padding: 6px 12px;
  color: var(--sw-on-mint, #052018);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

#sw-buckets .bucket-apply-btn:hover:not(:disabled) {
  opacity: var(--sw-hover-opacity, 0.85);
}

#sw-buckets .bucket-apply-btn:disabled {
  display: none;
}

#sw-buckets .bucket-apply-notice {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  color: var(--amber);
  white-space: nowrap;
}

/* \u2500\u2500 Copy overlay \u2500\u2500\u2500 */
#sw-buckets .bucket-copy-overlay {
  position: absolute;
  inset: 0;
  border-radius: 18px;
  background: var(--sw-overlay, rgba(23, 30, 35, 0.96));
  border: 1px solid var(--edge);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px;
  z-index: 10;
}

#sw-buckets .bucket-copy-overlay textarea {
  flex: 1;
  background: var(--card2);
  border: 1px solid var(--edge);
  border-radius: 8px;
  color: var(--txt-dim);
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  line-height: 1.6;
  padding: 10px 12px;
  resize: none;
  outline: none;
}

#sw-buckets .bucket-copy-overlay-dismiss {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--txt-dim);
  border: 1px solid var(--edge);
  border-radius: 8px;
  padding: 6px 12px;
  background: none;
  cursor: pointer;
  align-self: flex-end;
  transition: all 0.2s;
}

#sw-buckets .bucket-copy-overlay-dismiss:hover {
  border-color: var(--mint-dim);
  color: var(--txt);
}

/* \u2500\u2500 Loading States \u2500\u2500\u2500 */

/* State 1: skeleton shimmer */
@keyframes sw-shimmer {
  0%   { background-position: -380px center; }
  100% { background-position: 380px center; }
}

#sw-buckets .skel {
  background: var(--sw-skeleton, linear-gradient(
    90deg,
    var(--edge)                0%,
    rgba(255,255,255,0.045)   42%,
    rgba(79, 224, 176, 0.09)  50%,
    rgba(255,255,255,0.045)   58%,
    var(--edge)               100%
  ));
  background-size: 380px 100%;
  animation: sw-shimmer 1.9s ease-in-out infinite;
  border-radius: 3px;
  display: inline-block;
}

/* Indeterminate donut spin */
@keyframes sw-donut-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes sw-track-breathe {
  0%, 100% { opacity: 0.20; }
  50%       { opacity: 0.40; }
}

#sw-buckets .donut-spin-arc {
  transform-origin: 18px 18px;
  animation: sw-donut-spin 1.6s linear infinite;
}

#sw-buckets .donut-track-breathe {
  animation: sw-track-breathe 2.4s ease-in-out infinite;
}

/* Skeleton row geometry */
#sw-buckets .skel-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4.5px 4px;
  min-height: 24px;
}

#sw-buckets .skel-cb      { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
#sw-buckets .skel-icon    { width: 14px; height: 9px;  border-radius: 2px; flex-shrink: 0; }
#sw-buckets .skel-expand  { width: 10px; height: 8px;  border-radius: 2px; flex-shrink: 0; }
#sw-buckets .skel-name    { height: 9px; flex: 1; }
#sw-buckets .skel-tokens  { width: 28px; height: 9px;  border-radius: 3px; flex-shrink: 0; }
#sw-buckets .skel-barwrap { width: 48px; height: 6px;  border-radius: 3px; flex-shrink: 0; }

/* Dimmed section labels during skeleton */
#sw-buckets .section-label.skel-label { opacity: 0.38; }

/* Skeleton indent connector */
#sw-buckets .skel-row.indent-1 {
  padding-left: 22px;
  position: relative;
}
#sw-buckets .skel-row.indent-1::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--edge);
}

/* State 2a: syncing sweep line */
@keyframes sw-sweep {
  0%   { left: -65%; width: 55%; }
  100% { left: 110%; width: 55%; }
}

#sw-buckets .sync-sweep-track {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 18px 18px 0 0;
  background: transparent;
  overflow: hidden;
  z-index: 2;
}

#sw-buckets .sync-sweep-track::after {
  content: "";
  position: absolute;
  top: 0;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--mint)  25%,
    var(--sky)   75%,
    transparent 100%
  );
  animation: sw-sweep 1.7s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}

/* Syncing donut dim */
#sw-buckets .donut-syncing {
  opacity: 0.55;
  transition: opacity 0.4s;
}

/* Status chips (syncing + stale) */
#sw-buckets .panel-status-bar {
  margin: -6px 0 10px;
  display: flex;
  align-items: center;
}

#sw-buckets .status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  letter-spacing: 0.05em;
  border-radius: 100px;
  corner-shape: round;
  padding: 3px 9px 3px 7px;
  white-space: nowrap;
  flex-shrink: 0;
}

#sw-buckets .status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  corner-shape: round;
  flex-shrink: 0;
}

/* Syncing chip \u2014 sky-tinted */
#sw-buckets .status-chip.chip-syncing {
  background: var(--sw-wash, rgba(108, 198, 240, 0.09));
  border: 1px solid var(--sw-wash-edge, rgba(108, 198, 240, 0.22));
  color: var(--sky);
}
#sw-buckets .status-chip.chip-syncing .status-dot {
  background: var(--sky);
}

@keyframes sw-dot-pulse {
  0%, 100% { opacity: 1;   transform: scale(1);   }
  50%       { opacity: 0.3; transform: scale(0.65); }
}

#sw-buckets .status-chip.chip-syncing .status-dot {
  animation: sw-dot-pulse 1.1s ease-in-out infinite;
}

/* Stale chip \u2014 amber-tinted */
#sw-buckets .status-chip.chip-stale {
  background: var(--sw-wash, rgba(255, 194, 77, 0.07));
  border: 1px solid var(--sw-wash-edge, rgba(255, 194, 77, 0.22));
  color: var(--amber);
}
#sw-buckets .status-chip.chip-stale .status-dot {
  background: var(--amber);
}

@keyframes sw-stale-pulse {
  0%, 100% { opacity: 0.9; }
  50%       { opacity: 0.25; }
}

#sw-buckets .status-chip.chip-stale .status-dot {
  animation: sw-stale-pulse 2.2s ease-in-out infinite;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  #sw-buckets .skel { animation: none; background: var(--edge); }
  #sw-buckets .donut-spin-arc { animation: none; }
  #sw-buckets .donut-track-breathe { animation: none; }
  #sw-buckets .sync-sweep-track::after { animation: none; opacity: 0.6; left: 0; width: 100%; }
  #sw-buckets .status-chip.chip-syncing .status-dot,
  #sw-buckets .status-chip.chip-stale   .status-dot { animation: none; }
}

/* \u2500\u2500 History hover line \u2500\u2500\u2500 */
.sw-history-hoverline {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--sky);
  pointer-events: none;
  z-index: 2;
}

.sw-history-hoverline-tag {
  font: 9px/1 "JetBrains Mono", monospace;
  color: var(--sky);
  position: absolute;
  top: 4px;
  left: 4px;
  white-space: nowrap;
  pointer-events: none;
}

/* \u2500\u2500 Terms (#sw-terms) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
#sw-terms {
  margin-top: 16px;
}

/* \u2500\u2500 History chart crosshair overlay (spec \xA76.2) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-history-container {
  position: relative;
}

.sw-history-crosshair {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  pointer-events: none;
}

.sw-crosshair-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-highlight, rgba(238, 243, 246, 0.4));
}

.sw-crosshair-label {
  position: absolute;
  padding: 2px 6px;
  font-size: 10px;
  font-family: "JetBrains Mono", monospace;
  background: var(--sw-overlay, rgba(10, 26, 24, 0.85));
  border: 1px solid var(--sw-hairline, rgba(238, 243, 246, 0.2));
  border-radius: 3px;
  white-space: nowrap;
  color: var(--sw-highlight, #eef3f6);
}

/* \u2500\u2500 Pricing preset select \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-pricing-preset-row {
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px dotted var(--edge, #252f37);
}

.sw-pricing-preset-row label {
  display: block;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--mute, #5a6a75);
  margin-bottom: 5px;
}

.sw-pricing-preset-select {
  width: 100%;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: var(--txt, #eef3f6);
  background: var(--sw-field, #0d1214);
  border: 1px solid var(--edge, #252f37);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%2393a1ab' stroke-width='1.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.sw-pricing-preset-select:focus {
  border-color: var(--mint-dim, #2a5f4e);
}

/* \u2500\u2500 Theme switcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-theme-wrapper {
  position: relative;
}

.sw-theme-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  corner-shape: round;
  border: 1px solid rgba(238, 243, 246, 0.3);
  cursor: pointer;
  padding: 0;
}

.sw-theme-popover {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  background: var(--card-bg, rgba(10, 26, 24, 0.95));
  border: 1px solid rgba(238, 243, 246, 0.15);
  z-index: 100;
  min-width: 100px;
}

.sw-theme-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.sw-theme-row:hover {
  background: rgba(238, 243, 246, 0.08);
}

.sw-theme-swatches {
  display: flex;
  gap: 3px;
}

.sw-theme-swatches span {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.sw-theme-letter {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  opacity: 0.7;
}

/* Dual-landmarks group pill in topbar */
.sw-hero-group-pill {
  display: inline-block;
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 8px;
  margin-right: 6px;
  vertical-align: middle;
}
.sw-hero-group-pill.pill-amber {
  background: var(--sw-wash, rgba(255, 194, 77, 0.15));
  color: var(--amber, #ffc24d);
}
.sw-hero-group-pill.pill-mint {
  background: var(--sw-wash, rgba(79, 224, 176, 0.15));
  color: var(--mint, #4fe0b0);
}

/* \u2500\u2500 Structured path tooltip (appended to body, position: fixed) \u2500\u2500 */
.sw-bucket-tip {
  display: none;
  position: fixed;
  z-index: 9999;
  background: var(--card, #1a2233);
  border: 1px solid var(--edge, #252f37);
  border-radius: 8px;
  padding: 8px 10px;
  min-width: 180px;
  font-size: 10px;
  font-family: "JetBrains Mono", monospace;
  color: var(--txt-dim, #93a1ab);
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--sw-shadow-float, 0 4px 16px rgba(0,0,0,0.3));
}
.sw-bucket-tip .tooltip-row { margin-bottom: 2px; }
.sw-bucket-tip .tooltip-eff {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.sw-bucket-tip .tooltip-eff-bar {
  flex: 1;
  height: 4px;
  background: var(--edge, #252f37);
  border-radius: 2px;
  overflow: hidden;
}
.sw-bucket-tip .tooltip-eff-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
}
.sw-bucket-tip .tooltip-eff-fill.color-mint  { background: var(--mint, #4fe0b0); }
.sw-bucket-tip .tooltip-eff-fill.color-amber { background: var(--amber, #ffc24d); }
.sw-bucket-tip .tooltip-eff-fill.color-coral { background: var(--coral, #ff7566); }
.sw-bucket-tip .tooltip-excluded {
  color: var(--mute, #5a6a78);
  margin-bottom: 4px;
  font-weight: 600;
}
.sw-bucket-tip .tooltip-excluded .reason {
  font-weight: 400;
  color: var(--mute, #5a6a78);
  margin-left: 6px;
}

/* \u2500\u2500 History header actions layout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.sw-history-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sw-history-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* \u2500\u2500 History Drawer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   The drawer stops at the note layer, so there are no residual-tool, entity, search-evidence or
   search-only rules here. The browse snapshot carries no address, so the row grid is role + content.
   --edge-strong and --violet are defined by no theme, so the drawer's border keeps --edge and the
   search focus ring keeps --mint-dim. */

/* Trigger button in the history header */
.sw-history-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 30px;
  min-height: 34px;
  padding: 3px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--txt-dim);
  cursor: pointer;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
}

/* The segment count beside the entry's word, dimmer than it: the word is what a reader activates and
   the number only says how much stands behind it. The trigger is a flex row, so the gap between them
   is the row's own. */
.sw-history-count {
  color: var(--mute);
  font-variant-numeric: tabular-nums;
}

.sw-history-trigger:hover {
  background: var(--sw-hover, rgba(79, 224, 176, 0.06));
  color: var(--txt);
}

.sw-history-trigger svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--mint);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}

/* Scrim */
.sw-history-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--sw-scrim, rgba(4, 7, 9, 0.46));
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease-out;
}

.sw-history-scrim.sw-history-scrim-visible {
  opacity: 1;
  pointer-events: auto;
}

/* Drawer panel */
.sw-history-drawer {
  position: fixed;
  inset: 0 0 0 auto;
  z-index: 1001;
  display: flex;
  width: 440px;
  flex-direction: column;
  border-left: 1px solid var(--edge);
  background: var(--card);
  box-shadow: var(--sw-shadow-drawer, -26px 0 64px rgba(0, 0, 0, 0.46));
  transform: translateX(100%);
  transition: transform 180ms cubic-bezier(.2, .8, .2, 1), visibility 0s linear 180ms;
  visibility: hidden;
}

.sw-history-drawer.sw-history-drawer-open {
  transform: translateX(0);
  transition: transform 180ms cubic-bezier(.2, .8, .2, 1), visibility 0s;
  visibility: visible;
}

/* Header */
.sw-history-head {
  padding: 20px 20px 15px;
  border-bottom: 1px solid var(--edge);
}

.sw-history-title-row {
  display: flex;
  min-height: 28px;
  align-items: center;
}

.sw-history-title {
  margin: 0;
  font-family: "Sora", sans-serif;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.sw-history-close {
  display: grid;
  width: 28px;
  height: 28px;
  margin-left: auto;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--txt-dim);
  cursor: pointer;
  font-size: 18px;
}

.sw-history-close:hover {
  background: var(--sw-hover, rgba(27, 35, 42, 0.7));
  color: var(--txt);
}

/* Search */
.sw-history-search {
  display: grid;
  grid-template-columns: 18px 1fr;
  min-height: 36px;
  align-items: center;
  margin-top: 13px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--edge);
  border-radius: 8px;
  background: var(--bg);
}

.sw-history-search:focus-within {
  border-color: var(--mint-dim);
  box-shadow: var(--sw-focus-ring, 0 0 0 1px rgba(79, 224, 176, 0.14));
}

.sw-history-search svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--mute);
  stroke-width: 1.6;
}

.sw-history-search input {
  min-width: 0;
  height: 34px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--txt);
  font-size: 11.5px;
}

.sw-history-search input::placeholder {
  color: var(--mute);
}

/* List */
.sw-history-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 12px 24px 10px;
  scrollbar-color: var(--edge) transparent;
  scrollbar-width: thin;
}

/* Session divider \u2014 also the section's collapse toggle, so it takes the affordances of a control. It
   carries a token and prose side by side: the label holds the monospace uppercase treatment, and the
   wayfinder's head beside it reads as body copy. */
.sw-history-divider {
  display: flex;
  min-height: 31px;
  align-items: center;
  gap: 8px;
  padding: 11px 9px 4px 8px;
  border-radius: 9px;
  color: var(--mute);
  cursor: pointer;
}

.sw-history-divider:focus-visible {
  outline: 1px solid var(--mint-dim);
  outline-offset: -1px;
}

/* A stub of rule line parting the label from the prose beside it, the width the horizon
   marker's stub is. Its width is the whole of it, so it does not shrink: left shrinkable
   it would be a residue of whatever the head and the rule line leave, and its length
   would then be a fact about them. Its place in the line is the label's \`order\` rather
   than its own document position, which as a pseudo-element would put it first. */
.sw-history-divider::before {
  width: 14px;
  height: 1px;
  flex-shrink: 0;
  background: var(--edge);
  content: "";
}

.sw-history-divider::after {
  height: 1px;
  flex: 1;
  background: var(--edge);
  content: "";
}

/* The label matches the head's colour and size, so the line reads as one object. What keeps it an
   address rather than the opening of the prose beside it is then the monospace uppercase treatment
   alone, which is why that treatment carries the whole distinction here. The label holds the line's
   left edge, so the rule line begins to its right rather than leading into it. */
.sw-history-divider strong {
  order: -1;
  color: var(--txt);
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* The wayfinder's head, on the divider line in both states. Its box is a fixed share of the line
   rather than its content width, so the fade lands past the text of a short headline instead of over
   it, while a long one is clipped and faded with no marker owed. The clip is presentation, so the
   string behind it is whole \u2014 which is why the head is aria-hidden and only the sibling block is
   meant to read the whole of it. */
.sw-history-headline-head {
  min-width: 0;
  flex: 0 0 60%;
  overflow: hidden;
  color: var(--txt);
  font-size: 11px;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 2em), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 2em), transparent);
}

/* The collapsed body: the wayfinder as body copy, indented to begin where a row's text begins, so
   that expanding a section leaves the reading edge where it was. It is a sibling of the toggle, so
   it is placed by flow rather than nested where it would name the control, and it carries that
   toggle's click \u2014 the surface is the whole block. Hence unselectable: a drag across it would be
   undone by the click ending the drag, and here the surface IS the text. */
.sw-history-headline {
  padding: 1px 9px 11px 38px;
  color: var(--txt-dim);
  font-size: 11.5px;
  line-height: 1.62;
  white-space: pre-wrap;
  cursor: pointer;
  user-select: none;
}

/* Collapsed shows the wayfinder, expanded shows the rows. Both hang off the one attribute the
   toggle flips, so collapsing a section hides the row it had open instead of closing it. */
.sw-history-section[data-expanded="true"] .sw-history-headline {
  display: none;
}

.sw-history-section[data-expanded="false"] .sw-history-row {
  display: none;
}

/* Derived from .sw-history-divider: the static horizon marker is the same rule-line treatment with
   no label of its own, so the tail of the list reads as a boundary rather than as a row. */
.sw-history-horizon {
  display: flex;
  min-height: 31px;
  align-items: center;
  gap: 8px;
  padding: 14px 9px 4px 8px;
  color: var(--mute);
  font-family: "JetBrains Mono", monospace;
  font-size: 9px;
  line-height: 1.4;
}

.sw-history-horizon::before {
  height: 1px;
  width: 14px;
  background: var(--edge);
  content: "";
}

/* Turn rows: role glyph, then content. A leading address column is gone with the address itself, so
   the row keeps only the inset the glyph needs. */
.sw-history-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  min-height: 43px;
  align-items: start;
  padding-left: 8px;
  border-radius: 9px;
}

/* The divider is its section's toggle, so it takes the rows' hover treatment rather than a second
   one of its own. Collapsed, the block is part of that same surface, so the paint moves up to the
   section: one box spans the divider and the block with no seam and no notch where they meet, and a
   section whose headline is empty leaves no block highlighted behind it. */
.sw-history-row:hover,
.sw-history-section[data-expanded="true"] .sw-history-divider:hover {
  background: var(--sw-hover, rgba(27, 35, 42, 0.58));
}

.sw-history-section[data-expanded="false"]:hover {
  border-radius: 9px;
  background: var(--sw-hover, rgba(27, 35, 42, 0.58));
}

.sw-history-role {
  display: grid;
  width: 18px;
  height: 18px;
  margin-top: 12px;
  place-items: center;
  border: 1px solid var(--edge);
  border-radius: 50%;
  corner-shape: round;
  color: var(--sky);
}

.sw-history-role svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}

.sw-history-row[data-role="assistant"] .sw-history-role {
  border-radius: 5px;
  color: var(--amber);
  transform: rotate(45deg);
}

.sw-history-row[data-role="assistant"] .sw-history-role svg {
  transform: rotate(-45deg);
}

.sw-history-main {
  min-width: 0;
  padding: 12px 9px 11px 6px;
  cursor: pointer;
}

.sw-history-preview {
  overflow: hidden;
  color: var(--txt-dim);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The expanded text is a grid sibling of the toggle rather than a child of it, so it is placed into
   the content column explicitly instead of falling into an implicit row's first column. */
.sw-history-detail {
  display: none;
  grid-column: 2;
  max-height: 50vh;
  padding: 0 9px 12px 6px;
  overflow: auto;
  color: var(--txt-dim);
  cursor: text;
  font-size: 11.5px;
  line-height: 1.62;
}

.sw-history-copy {
  white-space: pre-wrap;
}

.sw-history-row[data-expanded="true"] {
  margin: 3px 0 7px;
  background: var(--sw-hover, rgba(27, 35, 42, 0.7));
  box-shadow: inset 0 0 0 1px var(--edge);
}

.sw-history-row[data-expanded="true"] .sw-history-preview {
  color: var(--txt);
  font-weight: 500;
}

.sw-history-row[data-expanded="true"] .sw-history-detail {
  display: block;
}

.sw-history-empty {
  display: grid;
  min-height: 220px;
  place-items: center;
  padding: 28px;
  color: var(--mute);
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
}

/* \u2500\u2500 Responsive: mobile full-width \u2500\u2500\u2500 */
@media (max-width: 760px) {
  .sw-history-drawer {
    width: 100vw;
    border-left: 0;
    box-shadow: none;
  }
}

/* \u2500\u2500 Reduced motion \u2500\u2500\u2500 */
@media (prefers-reduced-motion: reduce) {
  .sw-history-drawer,
  .sw-history-scrim {
    transition: none;
  }
}
`;

// public/themes/h.css
var h_default = '/* h.css \u2014 H theme: tokens + full component styles (ev-range). */\n\n:root {\n  /* Surface hierarchy */\n  --bg: #0e1114;\n  --bg2: #141a1e;\n  --card: #171e23;\n  --card2: #1b232a;\n  --edge: #252f37;\n\n  /* Accent palette */\n  --mint: #4fe0b0;\n  --mint-dim: #2a5f4e;\n  --sky: #6cc6f0;\n  --amber: #ffc24d;\n  --amber-dim: #7a5a20;\n  --coral: #ff7566;\n  --coral-dim: #7a2a22;\n\n  /* Text hierarchy */\n  --txt: #eef3f6;\n  --txt-dim: #93a1ab;\n  --mute: #5a6a75;\n\n  /* Zone colors for depthAux gradient */\n  --zone-shallow: #3f8a6a;\n  --zone-entry: #6cc6f0;\n  --zone-sweet: #4fe0b0;\n  --zone-deep: #ffc24d;\n  --zone-wall: #ff7566;\n}\n\nbody {\n  background: radial-gradient(120% 80% at 50% -10%, #17242a 0%, var(--bg) 60%, #0a0d0f 100%);\n  color: var(--txt);\n  font-family: "Inter", system-ui, sans-serif;\n}\n\n/* \u2500\u2500 Chrome bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.sw-chrome-bar {\n  display: contents;\n}\n\n.sw-chrome-mark {\n  width: 32px;\n  height: 32px;\n  border-radius: 9px;\n  background: linear-gradient(135deg, var(--mint), #2f9c7c);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: #052018;\n  font-family: "Sora", sans-serif;\n  font-weight: 700;\n  font-size: 14px;\n  flex-shrink: 0;\n}\n\n.sw-chrome-title {\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 18px;\n  letter-spacing: -0.01em;\n  color: var(--txt);\n  white-space: nowrap;\n}\n\n.sw-chrome-tag {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  letter-spacing: 0.18em;\n  color: var(--mute);\n  text-transform: uppercase;\n}\n\n.sw-chrome-spacer {\n  flex: 1;\n}\n\n.sw-chrome-conn {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--mint);\n  background: rgba(79, 224, 176, 0.1);\n  border: 1px solid var(--mint-dim);\n  border-radius: 20px;\n  corner-shape: round;\n  padding: 4px 11px;\n}\n\n.sw-chrome-conn-dot {\n  display: inline-block;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  corner-shape: round;\n  background: var(--mint);\n  box-shadow: 0 0 7px var(--mint);\n  flex-shrink: 0;\n}\n\n.sw-chrome-conn-label {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n}\n\n.sw-chrome-meta {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  color: var(--txt-dim);\n}\n\n.sw-chrome-stop-banner {\n  position: sticky;\n  top: 0;\n  z-index: 10;\n  background: var(--coral);\n  color: #fff;\n  font-weight: bold;\n  padding: 8px 16px;\n  border-radius: 6px;\n  margin-bottom: 12px;\n  font-size: 13px;\n}\n\n/* \u2500\u2500 Pricing chip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.sw-pricing-wrapper {\n  display: inline-flex;\n  position: relative;\n  flex-shrink: 0;\n}\n\n.sw-pricing-chip {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10.5px;\n  color: var(--txt-dim);\n  cursor: pointer;\n  user-select: none;\n  background: var(--bg2);\n  border: 1px solid var(--edge);\n  border-radius: 20px;\n  corner-shape: round;\n  padding: 5px 12px;\n  line-height: 1.4;\n}\n\n.sw-pricing-chip:hover {\n  border-color: var(--mint-dim);\n}\n\n.sw-pricing-chip-label b {\n  color: var(--sky);\n}\n\n.sw-pricing-popover {\n  display: none;\n  position: absolute;\n  top: calc(100% + 6px);\n  right: 0;\n  z-index: 20;\n  width: 340px;\n  background: var(--card);\n  border: 1px solid var(--edge);\n  border-radius: 14px;\n  padding: 16px 18px;\n  box-shadow: var(--sw-shadow-float, 0 16px 40px rgba(0, 0, 0, 0.5));\n  font-size: 0.85em;\n  font-family: "Inter", sans-serif;\n}\n\n.sw-pricing-popover .pp-h {\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 14px;\n  margin-bottom: 12px;\n  color: var(--txt);\n}\n\n.sw-pricing-popover .pp-h span {\n  font-family: "Inter", sans-serif;\n  font-weight: 400;\n  font-size: 11px;\n  color: var(--mute);\n  margin-left: 6px;\n}\n\n\n\n\n\n.sw-pricing-prow {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 12px;\n  margin-bottom: 12px;\n}\n\n.sw-pricing-pf label {\n  display: block;\n  font-size: 11px;\n  color: var(--txt-dim);\n  margin-bottom: 6px;\n}\n\n.sw-pricing-ib {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  background: var(--sw-field, #0d1214);\n  border: 1px solid var(--edge);\n  border-radius: 11px;\n  padding: 9px 12px;\n}\n\n.sw-pricing-ib:focus-within {\n  border-color: var(--mint-dim);\n}\n\n.sw-pricing-ib span {\n  color: var(--mute);\n  font-family: "JetBrains Mono", monospace;\n  font-size: 13px;\n}\n\n.sw-pricing-ib input {\n  background: transparent;\n  border: 0;\n  color: var(--txt);\n  width: 100%;\n  outline: none;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 15px;\n}\n\n.sw-pricing-pmid {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  color: var(--txt-dim);\n  margin-bottom: 12px;\n}\n\n.sw-pricing-pmid .sw-pricing-ratio-val {\n  color: var(--sky);\n}\n\n.sw-pricing-pmid .sw-pricing-source-val {\n  color: var(--mint);\n}\n\n.sw-pricing-notice {\n  font-size: 0.8em;\n  color: #92400e;\n  background: #fef3c7;\n  padding: 4px 8px;\n  border-radius: 4px;\n  margin-bottom: 8px;\n}\n\n.sw-pricing-error {\n  font-size: 0.8em;\n  color: var(--coral);\n  margin-bottom: 8px;\n}\n\n.sw-pricing-pfoot {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n}\n\n.sw-pricing-save-note {\n  font-size: 10.5px;\n  color: var(--mute);\n}\n\n.sw-pricing-save {\n  padding: 10px 22px;\n  border: none;\n  border-radius: 11px;\n  background: var(--mint);\n  color: var(--sw-on-mint, #052018);\n  cursor: pointer;\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 13px;\n}\n\n.sw-pricing-reset {\n  padding: 6px 14px;\n  border: 1px solid var(--edge);\n  border-radius: 8px;\n  background: none;\n  cursor: pointer;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  color: var(--txt-dim);\n}\n\n/* \u2500\u2500 Hero diptych \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n#sw-hero {\n  background: linear-gradient(160deg, var(--card2), var(--card));\n  border: 1px solid var(--edge);\n  box-shadow: var(--sw-shadow-float, 0 20px 50px rgba(0, 0, 0, 0.35));\n}\n\n.sw-hero-diptych {\n  padding: 20px 24px 12px;\n  border-right: 1px dashed var(--edge);\n}\n\n.sw-hero-diptych .lab {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9.5px;\n  letter-spacing: 0.18em;\n  text-transform: uppercase;\n  color: var(--mute);\n}\n\n.sw-hero-diptych .sub {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--mute);\n  margin-top: 2px;\n}\n\n.sw-hero-diptych .eoq-top {\n  display: flex;\n  justify-content: space-between;\n  align-items: baseline;\n}\n\n.sw-hero-diptych .eoq-u {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  color: var(--txt-dim);\n}\n\n.sw-hero-diptych .eoq-u b {\n  color: var(--amber);\n}\n\n.sw-hero-chart-wrap {\n  position: relative;\n  width: 100%;\n  height: 180px;\n  margin-top: 4px;\n}\n\n.sw-hero-canvas {\n  width: 100% !important;\n  height: 100% !important;\n}\n\n@keyframes sw-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }\n\n.sw-hero-uval {\n  color: var(--amber);\n  font-weight: 600;\n}\n\n\n/* \u2500\u2500 Depth aux-bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.sw-depth-aux {\n  padding: 0 24px 16px;\n  border-right: 1px dashed var(--edge);\n}\n\n.sw-aux-bar-wrap {\n  position: relative;\n  height: 20px;\n  border-radius: 5px;\n  overflow: visible;\n  border: 1px solid var(--edge);\n  font-family: "JetBrains Mono", monospace;\n  font-size: 8px;\n}\n\n.sw-aux-gradient {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 0;\n  right: 0;\n  border-radius: 4px;\n  overflow: hidden;\n}\n\n.sw-aux-marker {\n  position: absolute;\n  top: -6px;\n  bottom: -6px;\n  width: 2px;\n  background: var(--sw-highlight, #fff);\n  box-shadow: var(--sw-glow, 0 0 6px rgba(255, 255, 255, 0.6));\n  transition: opacity 0.15s;\n}\n\n.sw-aux-marker::before {\n  content: "";\n  position: absolute;\n  left: -4px;\n  top: -4px;\n  border-left: 5px solid transparent;\n  border-right: 5px solid transparent;\n  border-top: 6px solid var(--sw-highlight, #fff);\n}\n\n.sw-aux-marker::after {\n  content: "";\n  position: absolute;\n  left: -10px;\n  right: -10px;\n  top: -8px;\n  bottom: -8px;\n  cursor: pointer;\n}\n\n.sw-aux-flag {\n  position: absolute;\n  top: -27px;\n  transform: translateX(-50%);\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  background: var(--sw-overlay, #0d1214);\n  border: 1px solid var(--amber-dim);\n  color: var(--amber);\n  border-radius: 5px;\n  padding: 2px 7px;\n  white-space: nowrap;\n}\n\n.sw-aux-flag b {\n  color: var(--sw-highlight, #fff);\n}\n\n.sw-aux-zone-label {\n  position: absolute;\n  top: 50%;\n  transform: translate(-50%, -50%);\n  font-size: 8px;\n  letter-spacing: 0.04em;\n  color: var(--sw-highlight, #eef3f6);\n  pointer-events: none;\n}\n\n.sw-aux-controls {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-top: 10px;\n}\n\n.sw-aux-toklabel {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--txt-dim);\n  margin-top: 8px;\n  text-align: center;\n}\n\n.sw-aux-toklabel b {\n  color: var(--txt);\n  font-weight: 600;\n}\n\n.sw-aux-placeholder {\n  font-size: 0.8em;\n  opacity: 0.7;\n}\n\n/* \u2500\u2500 Burn meter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.sw-burn-meter {\n  padding: 20px 24px;\n  border-left: 1px dashed var(--edge);\n  display: flex;\n  flex-direction: column;\n}\n\n.sw-burn-meter .lab {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9.5px;\n  letter-spacing: 0.18em;\n  text-transform: uppercase;\n  color: var(--mute);\n}\n\n.sw-burn-meter .sub {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--mute);\n  margin-top: 2px;\n}\n\n/* \u2500\u2500 Dual-bar rent meter: bar groups \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-group { margin-top: 16px; }\n.bar-group + .bar-group { margin-top: 14px; }\n\n.bar-name {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  font-weight: 400;\n  color: var(--mute);\n  text-transform: uppercase;\n  letter-spacing: 0.08em;\n  display: block;\n  margin-bottom: 4px;\n}\n\n/* \u2500\u2500 Cycle bar (inline: track + tail) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-inline { display: flex; align-items: center; gap: 6px; }\n.bar-inline .bar-track { flex: 1; }\n\n.bar-tail {\n  flex-shrink: 0;\n  width: 46px;\n  display: flex;\n  align-items: center;\n  justify-content: flex-start;\n}\n\n.bar-inline-value {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--txt-dim);\n  font-weight: 400;\n}\n\n/* \u2500\u2500 Bar track (vehicle gauge style) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-track {\n  height: 18px;\n  border-radius: 3px;\n  background: var(--sw-groove, linear-gradient(180deg, #0a0d10 0%, #141a1e 40%, #0e1215 100%));\n  border: 1px solid var(--edge);\n  overflow: visible;\n  position: relative;\n  box-shadow: var(--sw-groove-shadow, inset 0 1px 3px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.03));\n}\n\n/* Background 10% notch marks \u2014 only on cycle bar (depth uses dynamic ticks) */\n.bar-inline .bar-track::before {\n  content: "";\n  position: absolute;\n  inset: 0;\n  z-index: 2;\n  pointer-events: none;\n  background: repeating-linear-gradient(\n    90deg,\n    transparent 0px, transparent 9.8%,\n    var(--sw-hairline, rgba(255,255,255,0.04)) 9.8%, var(--sw-hairline, rgba(255,255,255,0.04)) 10%\n  );\n}\n\n/* \u2500\u2500 Depth bar (with magazine tail) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-with-mag { display: flex; align-items: center; gap: 6px; }\n.bar-with-mag > .bar-track { flex: 1; }\n\n/* \u2500\u2500 Bar fill \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-fill {\n  height: 100%;\n  overflow: hidden;\n  position: relative;\n  transition: width 0.2s;\n  border-radius: 2px;\n}\n\n/* Cycle bar: mint with edge glow */\n.bar-fill.cycle {\n  background: linear-gradient(180deg, var(--mint) 0%, var(--mint-dim) 100%);\n  color: var(--mint);\n  box-shadow: var(--sw-accent-glow, 0 0 8px rgba(79,224,176,0.3), inset 0 1px 0 rgba(255,255,255,0.2));\n}\n\n.bar-fill.cycle::after {\n  content: "";\n  position: absolute;\n  right: 0; top: 0; bottom: 0;\n  width: 4px;\n  background: linear-gradient(180deg, var(--sw-shade, #c8fff0), var(--mint));\n  box-shadow: var(--sw-cap-glow, 0 0 6px rgba(200,255,240,0.6));\n  border-radius: 0 2px 2px 0;\n}\n\n/* Depth bar: amber glow */\n.bar-fill.depth {\n  background: linear-gradient(180deg, var(--amber) 0%, var(--amber-dim) 100%);\n  color: var(--amber);\n  box-shadow: var(--sw-accent-glow, 0 0 8px rgba(255,194,77,0.3), inset 0 1px 0 rgba(255,255,255,0.15));\n}\n\n.bar-fill.depth::after {\n  content: "";\n  position: absolute;\n  right: 0; top: 0; bottom: 0;\n  width: 4px;\n  background: linear-gradient(180deg, var(--sw-shade, #fff5dd), var(--amber));\n  box-shadow: var(--sw-cap-glow, 0 0 6px rgba(255,245,221,0.6));\n  border-radius: 0 2px 2px 0;\n}\n\n/* Depth bar hot: coral gradient */\n.bar-fill.depth-hot {\n  background: linear-gradient(180deg, var(--coral) 0%, var(--sw-shade, #a33a2f) 100%);\n  color: var(--coral);\n  box-shadow: var(--sw-accent-glow, 0 0 10px rgba(255,117,102,0.4), inset 0 1px 0 rgba(255,255,255,0.15));\n}\n\n.bar-fill.depth-hot::after {\n  content: "";\n  position: absolute;\n  right: 0; top: 0; bottom: 0;\n  width: 4px;\n  background: linear-gradient(180deg, var(--sw-shade, #ffd5d0), var(--coral));\n  box-shadow: var(--sw-cap-glow, 0 0 8px rgba(255,213,208,0.7));\n  border-radius: 0 2px 2px 0;\n}\n\n/* \u2500\u2500 Bar tick segments (internal backstop divisions) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-ticks {\n  position: absolute;\n  inset: 0;\n  z-index: 3;\n  pointer-events: none;\n  display: flex;\n}\n\n.bar-tick-segment {\n  flex: 1;\n  border-right: 2px solid var(--sw-hairline, rgba(238,243,246,0.2));\n}\n\n.bar-tick-segment:last-child { border-right: none; }\n\n/* \u2500\u2500 Bar detail line \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-detail {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  color: var(--mute);\n  margin-top: 5px;\n}\n\n.bar-detail .hl { color: var(--txt-dim); }\n\n/* \u2500\u2500 Disabled depth group \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.bar-group.disabled .bar-name { color: var(--sw-faint, #3a4550); }\n.bar-group.disabled .bar-track { opacity: 0.3; }\n.bar-group.disabled .bar-track::before { opacity: 0.3; }\n\n/* \u2500\u2500 Magazine tail \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.mag-tail {\n  flex-shrink: 0;\n  width: 46px;\n  display: flex;\n  align-items: center;\n  gap: 3px;\n}\n\n.mag-ticks {\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n  gap: 3px;\n}\n\n.mag-tick {\n  width: 4px;\n  height: 18px;\n  border-radius: 2px;\n  border: 1px solid var(--edge);\n  background: var(--sw-groove, linear-gradient(180deg, #1a2028 0%, #0e1215 100%));\n  box-shadow: var(--sw-groove-shadow, inset 0 1px 2px rgba(0,0,0,0.4));\n  transition: all 0.2s;\n}\n\n.mag-tick.spent {\n  background: linear-gradient(180deg, var(--amber) 0%, var(--amber-dim) 100%);\n  border-color: var(--amber-dim);\n  color: var(--amber);\n  box-shadow: var(--sw-accent-glow, 0 0 6px rgba(255,194,77,0.5), inset 0 1px 0 rgba(255,255,255,0.2));\n}\n\n.mag-tick.spent.hot {\n  background: linear-gradient(180deg, var(--coral) 0%, var(--coral-dim) 100%);\n  border-color: var(--coral-dim);\n  color: var(--coral);\n  box-shadow: var(--sw-accent-glow, 0 0 8px rgba(255,117,102,0.6), inset 0 1px 0 rgba(255,255,255,0.2));\n}\n\n.mag-overflow {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  font-weight: 500;\n  color: var(--coral);\n}\n\n/* \u2500\u2500 Verdict row (spans hero columns) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.sw-hero-verdict-row {\n  grid-column: 1 / -1;\n  border-top: 1px solid var(--edge);\n  padding: 13px 24px;\n  background: var(--sw-overlay, rgba(255, 194, 77, 0.05));\n  display: flex;\n  align-items: center;\n  gap: 12px;\n}\n\n.sw-hero-verdict-row .pill {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--amber);\n  border: 1px solid var(--amber-dim);\n  border-radius: 20px;\n  corner-shape: round;\n  padding: 4px 12px;\n  white-space: nowrap;\n}\n\n.sw-hero-verdict-row p {\n  margin: 0;\n  font-size: 13.5px;\n  color: var(--txt-dim);\n}\n\n.sw-hero-verdict-row p b {\n  color: var(--txt);\n  font-weight: 600;\n}\n\n/* \u2500\u2500 History card \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n#sw-history {\n  background: var(--card);\n  border: 1px solid var(--edge);\n  border-radius: 18px;\n  padding: 18px 20px;\n  height: 360px;\n  display: flex;\n  flex-direction: column;\n}\n\n.sw-history-header {\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 14px;\n  margin: 0;\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  color: var(--txt);\n}\n\n.sw-history-subtitle {\n  font-size: 11px;\n  color: var(--mute);\n  margin: 3px 0 12px;\n}\n\n.sw-history-container {\n  position: relative;\n  width: 100%;\n  flex: 1;\n  min-height: 0;\n}\n\n.sw-history-canvas {\n  width: 100% !important;\n  height: 100% !important;\n}\n\n.pager {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  color: var(--txt-dim);\n}\n\n.pager button {\n  background: var(--bg2);\n  border: 1px solid var(--edge);\n  color: var(--txt-dim);\n  border-radius: 6px;\n  width: 22px;\n  height: 22px;\n  cursor: pointer;\n  font-size: 12px;\n}\n\n.pager b {\n  color: var(--txt);\n}\n\n.sw-history-legend {\n  display: flex;\n  gap: 15px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  color: var(--txt-dim);\n  margin-top: 7px;\n}\n\n.sw-history-legend i {\n  display: inline-block;\n  width: 12px;\n  height: 2.5px;\n  vertical-align: middle;\n  margin-right: 5px;\n  border-radius: 2px;\n}\n\n.sw-history-footnote {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 14px;\n  border-top: 1px dotted var(--edge);\n  margin-top: 12px;\n  padding-top: 10px;\n  padding-bottom: 14px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--mute);\n}\n\n.sw-history-footnote b {\n  color: var(--txt-dim);\n  font-weight: 500;\n}\n\n/* \u2500\u2500 Buckets card \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n\n/* Card container */\n#sw-buckets .bucket-card {\n  background: var(--card);\n  border: 1px solid var(--edge);\n  border-radius: 18px;\n  padding: 18px 20px;\n  display: flex;\n  flex-direction: column;\n  position: relative;\n  overflow: hidden;\n}\n\n/* \u2500\u2500 Header: Donut + stats \u2500\u2500\u2500 */\n#sw-buckets .bucket-header {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin-bottom: 14px;\n}\n\n#sw-buckets .header-donut {\n  width: 42px;\n  height: 42px;\n  flex-shrink: 0;\n  position: relative;\n}\n\n#sw-buckets .header-donut svg {\n  width: 100%;\n  height: 100%;\n  transform: rotate(-90deg);\n  transition: all 0.3s ease;\n}\n\n#sw-buckets .header-info h3 {\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 14px;\n  margin: 0;\n  color: var(--txt);\n}\n\n#sw-buckets .header-info .subtitle {\n  font-size: 10.5px;\n  color: var(--mute);\n  margin-top: 2px;\n}\n\n#sw-buckets .header-stats {\n  margin-left: auto;\n  text-align: right;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  line-height: 1.7;\n}\n\n#sw-buckets .header-stats .val-selected {\n  color: var(--mint);\n}\n\n#sw-buckets .header-stats .val-discarded {\n  color: var(--coral);\n}\n\n/* \u2500\u2500 Section labels \u2500\u2500\u2500 */\n#sw-buckets .section-label {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  letter-spacing: 0.12em;\n  text-transform: uppercase;\n  color: var(--txt-dim);\n  margin: 10px 0 6px;\n  padding-left: 2px;\n}\n\n#sw-buckets .section-label:first-of-type {\n  margin-top: 0;\n}\n\n/* \u2500\u2500 Tree rows \u2500\u2500\u2500 */\n#sw-buckets .bucket-tree {\n  flex: 1;\n  min-height: 0;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 11px;\n  line-height: 1;\n}\n\n#sw-buckets .bucket-row {\n  display: flex;\n  align-items: center;\n  gap: 7px;\n  padding: 4.5px 4px;\n  position: relative;\n  border-radius: 4px;\n  cursor: default;\n  min-height: 24px;\n}\n\n#sw-buckets .bucket-row:hover {\n  background-color: var(--sw-hover, rgba(79, 224, 176, 0.04));\n}\n\n#sw-buckets .bucket-row.is-dir {\n  cursor: pointer;\n}\n\n#sw-buckets .bucket-row.is-dir:hover {\n  background-color: var(--sw-hover, rgba(79, 224, 176, 0.06));\n}\n\n/* Indent guides */\n#sw-buckets .bucket-row[data-indent="1"] { padding-left: 22px; }\n#sw-buckets .bucket-row[data-indent="2"] { padding-left: 40px; }\n#sw-buckets .bucket-row[data-indent="3"] { padding-left: 58px; }\n\n#sw-buckets .bucket-row[data-indent="1"]::before,\n#sw-buckets .bucket-row[data-indent="2"]::before {\n  content: "";\n  position: absolute;\n  left: 12px;\n  top: 0;\n  bottom: 0;\n  width: 1px;\n  background: var(--edge);\n}\n\n#sw-buckets .bucket-row[data-indent="2"]::after {\n  content: "";\n  position: absolute;\n  left: 30px;\n  top: 0;\n  bottom: 0;\n  width: 1px;\n  background: var(--edge);\n  opacity: 0.5;\n}\n\n/* Focus ring (a11y) */\n#sw-buckets .bucket-row:focus-visible {\n  outline: 1px solid var(--mint);\n  outline-offset: -1px;\n}\n\n/* \u2500\u2500 Checkbox \u2500\u2500\u2500 */\n#sw-buckets .bucket-cb {\n  width: 12px;\n  height: 12px;\n  border: 1.5px solid var(--mute);\n  border-radius: 3px;\n  flex-shrink: 0;\n  cursor: pointer;\n  position: relative;\n  transition: all 0.15s;\n}\n\n#sw-buckets .bucket-cb.checked {\n  background: var(--mint);\n  border-color: var(--mint);\n}\n\n#sw-buckets .bucket-cb.checked::after {\n  content: "";\n  position: absolute;\n  top: 0.5px;\n  left: 3px;\n  width: 4px;\n  height: 6.5px;\n  border: solid var(--sw-on-mint, #052018);\n  border-width: 0 1.5px 1.5px 0;\n  transform: rotate(45deg);\n}\n\n#sw-buckets .bucket-cb.locked {\n  background: var(--mute);\n  border-color: var(--mute);\n  cursor: default;\n  opacity: 0.35;\n}\n\n/* Half-select (indeterminate) state for directories */\n#sw-buckets .bucket-cb.half {\n  background: linear-gradient(135deg, var(--mint) 50%, transparent 50%);\n  border-color: var(--mint);\n}\n\n/* \u2500\u2500 Expand toggle \u2500\u2500\u2500 */\n#sw-buckets .bucket-expand {\n  color: var(--txt-dim);\n}\n\n/* \u2500\u2500 Icon \u2500\u2500\u2500 */\n#sw-buckets .bucket-icon {\n  font-size: 10px;\n  width: 14px;\n  text-align: center;\n  flex-shrink: 0;\n}\n\n/* \u2500\u2500 Name kind classes \u2500\u2500\u2500 */\n#sw-buckets .bucket-name {\n  color: var(--txt-dim);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding-bottom: 2px;\n}\n\n#sw-buckets .bucket-name.is-dir-name {\n  color: var(--txt);\n  font-weight: 500;\n}\n\n#sw-buckets .bucket-name.is-special {\n  color: var(--amber);\n}\n\n#sw-buckets .bucket-name.is-system {\n  color: var(--mute);\n}\n\n#sw-buckets .bucket-name.is-skill {\n  color: var(--sky);\n}\n\n#sw-buckets .bucket-name.is-others {\n  color: var(--mute);\n  font-style: italic;\n}\n\n/* \u2500\u2500 Token count + bar \u2500\u2500\u2500 */\n#sw-buckets .bucket-right {\n  margin-left: auto;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex-shrink: 0;\n}\n\n#sw-buckets .bucket-tokens {\n  font-size: 10px;\n  color: var(--txt-dim);\n  white-space: nowrap;\n  min-width: 32px;\n  text-align: right;\n}\n\n#sw-buckets .bucket-bar-wrap {\n  display: inline-block;\n  width: 48px;\n  height: 6px;\n  border-radius: 3px;\n  background: var(--edge);\n  overflow: hidden;\n  flex-shrink: 0;\n  vertical-align: middle;\n}\n\n#sw-buckets .bucket-bar {\n  display: block;\n  height: 100%;\n  border-radius: 3px;\n  min-width: 3px;\n  transition: width 0.3s ease;\n}\n\n#sw-buckets .bucket-bar.color-mint  { background: var(--mint); }\n#sw-buckets .bucket-bar.color-amber { background: var(--amber); }\n#sw-buckets .bucket-bar.color-coral { background: var(--coral); }\n#sw-buckets .bucket-bar.color-mute  { background: var(--mute); }\n#sw-buckets .bucket-bar.color-sky   { background: var(--sky); }\n\n/* \u2500\u2500 Churn tier: path name coloring \u2500\u2500 */\n#sw-buckets .bucket-name.churn-med  { color: var(--amber); }\n#sw-buckets .bucket-name.churn-high { color: var(--coral); }\n#sw-buckets .bucket-name.is-dir-name.churn-med  { color: var(--amber); opacity: 0.85; }\n#sw-buckets .bucket-name.is-dir-name.churn-high { color: var(--coral); opacity: 0.85; }\n\n/* \u2500\u2500 Excluded rows \u2500\u2500 */\n#sw-buckets .bucket-row.is-excluded { opacity: 0.5; }\n#sw-buckets .bucket-row.is-excluded .bucket-cb { border-style: dashed; }\n#sw-buckets .bucket-row.is-excluded .bucket-name { font-style: italic; color: var(--mute); }\n\n\n/* Override indicator \u2014 wavy underline on filename */\n#sw-buckets .bucket-name[data-override] {\n  text-decoration: underline wavy;\n  text-decoration-thickness: 1px;\n  text-underline-offset: 2px;\n  overflow: visible;\n}\n#sw-buckets .bucket-name[data-override="include"] {\n  text-decoration-color: var(--sw-ok, rgba(79, 224, 176, 0.4));\n}\n#sw-buckets .bucket-name[data-override="exclude"] {\n  text-decoration-color: var(--sw-bad, rgba(255, 117, 102, 0.4));\n}\n\n/* \u2500\u2500 Section separator \u2500\u2500\u2500 */\n#sw-buckets .bucket-sep {\n  border: none;\n  border-top: 1px dotted var(--edge);\n  margin: 8px 0;\n}\n\n/* \u2500\u2500 Dir children container \u2500\u2500\u2500 */\n#sw-buckets .bucket-dir-children {\n  /* display:none toggled by JS when collapsed */\n}\n\n\n/* \u2500\u2500 Footer \u2500\u2500\u2500 */\n#sw-buckets .bucket-footer {\n  margin-top: 12px;\n  padding-top: 10px;\n  border-top: 1px dotted var(--edge);\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 6px;\n  position: relative;\n}\n\n#sw-buckets .bucket-copy-btn {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  background: var(--mint);\n  border: 1px solid var(--mint);\n  border-radius: 8px;\n  padding: 6px 12px;\n  color: var(--sw-on-mint, #052018);\n  font-weight: 600;\n  cursor: pointer;\n  transition: all 0.2s;\n}\n\n#sw-buckets .bucket-copy-btn:hover {\n  background: var(--sw-mint-deep, #3cc89a);\n  border-color: var(--sw-mint-deep, #3cc89a);\n}\n\n#sw-buckets .bucket-copy-btn.copied {\n  background: var(--mint-dim);\n  border-color: var(--mint);\n  color: var(--sw-on-fill, var(--mint));\n}\n\n#sw-buckets .bucket-reset-btn {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--mute);\n  border: 1px solid var(--edge);\n  border-radius: 8px;\n  padding: 6px 12px;\n  background: none;\n  cursor: pointer;\n  transition: all 0.2s;\n}\n\n#sw-buckets .bucket-reset-btn.active {\n  color: var(--txt-dim);\n  border-color: var(--txt-dim);\n}\n\n#sw-buckets .bucket-apply-btn {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  background: var(--mint);\n  border: 1px solid var(--mint);\n  border-radius: 8px;\n  padding: 6px 12px;\n  color: var(--sw-on-mint, #052018);\n  font-weight: 600;\n  cursor: pointer;\n  transition: all 0.2s;\n}\n\n#sw-buckets .bucket-apply-btn:hover:not(:disabled) {\n  background: var(--sw-mint-deep, #3cc89a);\n  border-color: var(--sw-mint-deep, #3cc89a);\n}\n\n#sw-buckets .bucket-apply-btn:disabled {\n  display: none;\n}\n\n#sw-buckets .bucket-apply-notice {\n  position: absolute;\n  left: 0;\n  bottom: calc(100% + 4px);\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  color: var(--amber);\n  white-space: nowrap;\n}\n\n/* \u2500\u2500 Copy overlay \u2500\u2500\u2500 */\n#sw-buckets .bucket-copy-overlay {\n  position: absolute;\n  inset: 0;\n  border-radius: 18px;\n  background: var(--sw-overlay, rgba(23, 30, 35, 0.96));\n  border: 1px solid var(--edge);\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 18px 20px;\n  z-index: 10;\n}\n\n#sw-buckets .bucket-copy-overlay textarea {\n  flex: 1;\n  background: var(--card2);\n  border: 1px solid var(--edge);\n  border-radius: 8px;\n  color: var(--txt-dim);\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  line-height: 1.6;\n  padding: 10px 12px;\n  resize: none;\n  outline: none;\n}\n\n#sw-buckets .bucket-copy-overlay-dismiss {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 10px;\n  color: var(--txt-dim);\n  border: 1px solid var(--edge);\n  border-radius: 8px;\n  padding: 6px 12px;\n  background: none;\n  cursor: pointer;\n  align-self: flex-end;\n  transition: all 0.2s;\n}\n\n#sw-buckets .bucket-copy-overlay-dismiss:hover {\n  border-color: var(--mint-dim);\n  color: var(--txt);\n}\n\n/* \u2500\u2500 Loading States \u2500\u2500\u2500 */\n\n/* State 1: skeleton shimmer */\n@keyframes sw-shimmer {\n  0%   { background-position: -380px center; }\n  100% { background-position: 380px center; }\n}\n\n#sw-buckets .skel {\n  background: var(--sw-skeleton, linear-gradient(\n    90deg,\n    var(--edge)                0%,\n    rgba(255,255,255,0.045)   42%,\n    rgba(79, 224, 176, 0.09)  50%,\n    rgba(255,255,255,0.045)   58%,\n    var(--edge)               100%\n  ));\n  background-size: 380px 100%;\n  animation: sw-shimmer 1.9s ease-in-out infinite;\n  border-radius: 3px;\n  display: inline-block;\n}\n\n/* Indeterminate donut spin */\n@keyframes sw-donut-spin {\n  from { transform: rotate(0deg); }\n  to   { transform: rotate(360deg); }\n}\n\n@keyframes sw-track-breathe {\n  0%, 100% { opacity: 0.20; }\n  50%       { opacity: 0.40; }\n}\n\n#sw-buckets .donut-spin-arc {\n  transform-origin: 18px 18px;\n  animation: sw-donut-spin 1.6s linear infinite;\n}\n\n#sw-buckets .donut-track-breathe {\n  animation: sw-track-breathe 2.4s ease-in-out infinite;\n}\n\n/* Skeleton row geometry */\n#sw-buckets .skel-row {\n  display: flex;\n  align-items: center;\n  gap: 7px;\n  padding: 4.5px 4px;\n  min-height: 24px;\n}\n\n#sw-buckets .skel-cb      { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }\n#sw-buckets .skel-icon    { width: 14px; height: 9px;  border-radius: 2px; flex-shrink: 0; }\n#sw-buckets .skel-expand  { width: 10px; height: 8px;  border-radius: 2px; flex-shrink: 0; }\n#sw-buckets .skel-name    { height: 9px; flex: 1; }\n#sw-buckets .skel-tokens  { width: 28px; height: 9px;  border-radius: 3px; flex-shrink: 0; }\n#sw-buckets .skel-barwrap { width: 48px; height: 6px;  border-radius: 3px; flex-shrink: 0; }\n\n/* Dimmed section labels during skeleton */\n#sw-buckets .section-label.skel-label { opacity: 0.38; }\n\n/* Skeleton indent connector */\n#sw-buckets .skel-row.indent-1 {\n  padding-left: 22px;\n  position: relative;\n}\n#sw-buckets .skel-row.indent-1::before {\n  content: "";\n  position: absolute;\n  left: 12px;\n  top: 0;\n  bottom: 0;\n  width: 1px;\n  background: var(--edge);\n}\n\n/* State 2a: syncing sweep line */\n@keyframes sw-sweep {\n  0%   { left: -65%; width: 55%; }\n  100% { left: 110%; width: 55%; }\n}\n\n#sw-buckets .sync-sweep-track {\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  height: 2px;\n  border-radius: 18px 18px 0 0;\n  background: transparent;\n  overflow: hidden;\n  z-index: 2;\n}\n\n#sw-buckets .sync-sweep-track::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  height: 100%;\n  background: linear-gradient(\n    90deg,\n    transparent 0%,\n    var(--mint)  25%,\n    var(--sky)   75%,\n    transparent 100%\n  );\n  animation: sw-sweep 1.7s cubic-bezier(0.45, 0, 0.55, 1) infinite;\n}\n\n/* Syncing donut dim */\n#sw-buckets .donut-syncing {\n  opacity: 0.55;\n  transition: opacity 0.4s;\n}\n\n/* Status chips (syncing + stale) */\n#sw-buckets .panel-status-bar {\n  margin: -6px 0 10px;\n  display: flex;\n  align-items: center;\n}\n\n#sw-buckets .status-chip {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  font-family: "JetBrains Mono", monospace;\n  font-size: 9px;\n  letter-spacing: 0.05em;\n  border-radius: 100px;\n  corner-shape: round;\n  padding: 3px 9px 3px 7px;\n  white-space: nowrap;\n  flex-shrink: 0;\n}\n\n#sw-buckets .status-dot {\n  width: 5px;\n  height: 5px;\n  border-radius: 50%;\n  corner-shape: round;\n  flex-shrink: 0;\n}\n\n/* Syncing chip \u2014 sky-tinted */\n#sw-buckets .status-chip.chip-syncing {\n  background: var(--sw-wash, rgba(108, 198, 240, 0.09));\n  border: 1px solid var(--sw-wash-edge, rgba(108, 198, 240, 0.22));\n  color: var(--sky);\n}\n#sw-buckets .status-chip.chip-syncing .status-dot {\n  background: var(--sky);\n}\n\n@keyframes sw-dot-pulse {\n  0%, 100% { opacity: 1;   transform: scale(1);   }\n  50%       { opacity: 0.3; transform: scale(0.65); }\n}\n\n#sw-buckets .status-chip.chip-syncing .status-dot {\n  animation: sw-dot-pulse 1.1s ease-in-out infinite;\n}\n\n/* Stale chip \u2014 amber-tinted */\n#sw-buckets .status-chip.chip-stale {\n  background: var(--sw-wash, rgba(255, 194, 77, 0.07));\n  border: 1px solid var(--sw-wash-edge, rgba(255, 194, 77, 0.22));\n  color: var(--amber);\n}\n#sw-buckets .status-chip.chip-stale .status-dot {\n  background: var(--amber);\n}\n\n@keyframes sw-stale-pulse {\n  0%, 100% { opacity: 0.9; }\n  50%       { opacity: 0.25; }\n}\n\n#sw-buckets .status-chip.chip-stale .status-dot {\n  animation: sw-stale-pulse 2.2s ease-in-out infinite;\n}\n\n/* Reduced motion */\n@media (prefers-reduced-motion: reduce) {\n  #sw-buckets .skel { animation: none; background: var(--edge); }\n  #sw-buckets .donut-spin-arc { animation: none; }\n  #sw-buckets .donut-track-breathe { animation: none; }\n  #sw-buckets .sync-sweep-track::after { animation: none; opacity: 0.6; left: 0; width: 100%; }\n  #sw-buckets .status-chip.chip-syncing .status-dot,\n  #sw-buckets .status-chip.chip-stale   .status-dot { animation: none; }\n}\n\n/* \u2500\u2500 History hover line (lives outside #sw-buckets, in history chart scope) \u2500\u2500\u2500 */\n.sw-history-hoverline {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  border-left: 1px dashed var(--sky);\n  pointer-events: none;\n  z-index: 2;\n}\n\n.sw-history-hoverline-tag {\n  font: 9px/1 "JetBrains Mono", monospace;\n  color: var(--sky);\n  position: absolute;\n  top: 4px;\n  left: 4px;\n  white-space: nowrap;\n  pointer-events: none;\n}\n\n/* \u2500\u2500 History touch-sequence marker lines (dashed, tier-colored, one per touchSeqs entry) \u2500\u2500 */\n.sw-history-touchline {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  border-left: 1px dashed;\n  pointer-events: none;\n  z-index: 1;\n  opacity: 0.55;\n}\n\n/* \u2500\u2500 Terms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n#sw-terms .sw-terms {\n  background: var(--card);\n  border: 1px solid var(--edge);\n  border-radius: 18px;\n  overflow: hidden;\n}\n\n#sw-terms .sw-terms-summary {\n  list-style: none;\n  cursor: pointer;\n  padding: 15px 20px;\n  font-family: "Sora", sans-serif;\n  font-weight: 600;\n  font-size: 14px;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  color: var(--txt);\n}\n\n#sw-terms .sw-terms-summary::-webkit-details-marker {\n  display: none;\n}\n\n#sw-terms .sw-terms-chev {\n  color: var(--mute);\n  font-size: 12px;\n  transition: transform 0.15s;\n}\n\n#sw-terms .sw-terms[open] .sw-terms-chev {\n  transform: rotate(90deg);\n}\n\n#sw-terms .sw-terms-subtitle {\n  font-family: "Inter", sans-serif;\n  font-weight: 400;\n  font-size: 11.5px;\n  color: var(--mute);\n  margin-left: auto;\n}\n\n#sw-terms .sw-terms-list {\n  padding: 4px 20px 20px;\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 12px 28px;\n  margin: 0;\n}\n\n#sw-terms .gterm {\n  display: flex;\n  gap: 12px;\n  align-items: baseline;\n}\n\n#sw-terms .gterm dt {\n  font-family: "JetBrains Mono", monospace;\n  font-size: 12px;\n  color: var(--mint);\n  font-weight: 600;\n  white-space: nowrap;\n  min-width: 120px;\n}\n\n#sw-terms .gterm dd {\n  margin: 0;\n  font-size: 12.5px;\n  color: var(--txt-dim);\n  line-height: 1.45;\n}\n';

// dsh/src/client/scope.js
var TAB_SCOPE = "[data-sw-tab]";
var KEYFRAMES = /@keyframes\b/y;
function scopeStylesheet(css, scope = TAB_SCOPE) {
  const hoisted = [];
  let rest = "";
  let depth = 0;
  let from2 = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "@" && depth === 0) {
      KEYFRAMES.lastIndex = i;
      if (!KEYFRAMES.test(css)) continue;
      const open = css.indexOf("{", i);
      let end = open + 1;
      for (let inner = 1; inner > 0; end++) {
        if (css[end] === "{") inner++;
        else if (css[end] === "}") inner--;
      }
      rest += css.slice(from2, i);
      hoisted.push(css.slice(i, end));
      from2 = end;
      i = end - 1;
    }
  }
  rest += css.slice(from2);
  return `${hoisted.join("\n")}
@scope (${scope}) {
${rest.replace(/:root\b/g, ":scope")}
}
`;
}
var BRIDGE_CSS = `@scope (${TAB_SCOPE}) {
  :scope {
    --bg: var(--dsw-alias-bg-base);
    --bg2: var(--dsw-alias-bg-layer-1);
    --card: var(--dsw-alias-bg-layer-2);
    --card2: var(--dsw-alias-bg-layer-3);
    --edge: var(--dsw-alias-border-l1);
    --txt: var(--dsw-alias-label-primary);
    --txt-dim: var(--dsw-alias-label-secondary);
    --mute: var(--dsw-alias-label-tertiary);
    color: var(--txt);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sw-gutter);
    padding-inline: max(calc(var(--dsh-composer-side-clearance) + 16px), calc((100% - var(--dsh-chat-content-width)) / 2));
  }
}
`;
var CHROME_CSS = `@scope (${TAB_SCOPE}) {
  #sw-chrome {
    justify-content: flex-end;
  }
  .sw-chrome-conn[data-state="connecting"],
  .sw-chrome-conn[data-state="reading"] {
    color: var(--amber);
    background: var(--sw-wash, rgba(255, 194, 77, 0.1));
    border-color: var(--sw-wash-edge, rgba(255, 194, 77, 0.4));
  }
  .sw-chrome-conn[data-state="connecting"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="reading"] .sw-chrome-conn-dot {
    background: var(--amber);
    box-shadow: 0 0 7px var(--amber);
  }
  .sw-chrome-conn[data-state="disconnected"],
  .sw-chrome-conn[data-state="failed"],
  .sw-chrome-conn[data-state="unreachable"] {
    color: var(--coral);
    background: var(--sw-wash, rgba(255, 117, 102, 0.1));
    border-color: var(--sw-wash-edge, rgba(255, 117, 102, 0.4));
  }
  .sw-chrome-conn[data-state="disconnected"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="failed"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="unreachable"] .sw-chrome-conn-dot {
    background: var(--coral);
    box-shadow: 0 0 7px var(--coral);
  }
  .sw-chrome-conn[data-state="unobserved"] {
    color: var(--mute);
    background: transparent;
    border-color: var(--edge);
  }
  .sw-chrome-conn[data-state="unobserved"] .sw-chrome-conn-dot {
    background: var(--mute);
    box-shadow: none;
  }
}
`;
var LIGHT_CSS = `@scope (${TAB_SCOPE}) {
  :scope[data-sw-scheme="light"] {
    --sw-groove: linear-gradient(180deg, #e2e6ec 0%, #edf0f4 45%, #e6eaef 100%);
    --sw-groove-shadow: inset 0 1px 2px rgba(38, 49, 72, 0.16);
    --sw-hairline: rgba(38, 49, 72, 0.16);
    --sw-highlight: rgba(24, 32, 48, 0.82);
    --sw-glow: 0 0 0 1px rgba(255, 255, 255, 0.8);
    --sw-field: var(--dsw-alias-bg-module-platform);
    --sw-overlay: var(--dsw-alias-bg-layer-2);
    --sw-hover: var(--dsw-alias-interactive-bg-hover);
    --sw-hover-opacity: 1;
    --sw-accent-glow: 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent), 0 1px 5px color-mix(in srgb, currentColor 34%, transparent);
    --sw-cap-glow: none;
    --sw-focus-ring: 0 0 0 2px var(--mint);
    --sw-shadow-float: var(--dsw-elevation-prominent);
    --sw-shadow-drawer: -12px 0 32px 0 rgba(38, 49, 72, 0.1);
    --sw-scrim: var(--dsw-alias-bg-mask-1);
    --sw-on-mint: var(--dsw-alias-label-primary-foreground);
    --sw-on-fill: var(--dsw-alias-label-primary);
    --sw-mint-deep: color-mix(in srgb, var(--mint) 85%, black);
    --sw-faint: var(--dsw-alias-label-tertiary);
    --sw-shade: color-mix(in srgb, currentColor 72%, black);
    --sw-wash: color-mix(in srgb, currentColor 10%, transparent);
    --sw-wash-edge: color-mix(in srgb, currentColor 28%, transparent);
    --sw-skeleton: linear-gradient(90deg, var(--dsw-alias-bg-skeleton) 0%, var(--dsw-alias-interactive-bg-hover) 50%, var(--dsw-alias-bg-skeleton) 100%);
    --sw-ok: var(--mint);
    --sw-bad: var(--coral);
    --mint: #0b7f91;
    --mint-dim: #6cc3d0;
    --sky: #3d57c9;
    --amber: #a46700;
    --amber-dim: #e8bb62;
    --coral: #d1304f;
    --coral-dim: #ee97a6;
    --zone-shallow: #a6dfe8;
    --zone-entry: #6f95ec;
    --zone-sweet: #27b5c9;
    --zone-deep: #efb12e;
    --zone-wall: #d8344f;
  }
}
`;
var DOCK_CSS = `button[data-sw-dock] {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
}
button[data-sw-dock]:hover, button[data-sw-dock][aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-sw-dock] [data-zone="white"] {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-dock] [data-zone="green"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-dock] [data-zone="amber"] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-dock] [data-zone="red"] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-dock] .sw-lamp {
  flex: none;
  overflow: visible;
}
[data-sw-dock] .sw-lamp circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}
[data-sw-dock] .sw-lamp .trk {
  stroke: var(--dsw-alias-border-l3);
}
[data-sw-dock] .sw-lamp[data-idle] .trk {
  stroke-dasharray: 1.4 3.1;
}
[data-sw-dock] .sw-lamp .arc {
  stroke-linecap: round;
}
[data-sw-dock] .sw-lamp .core {
  fill: currentColor;
  stroke: none;
}
button[data-sw-dock] .sw-arm {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
button[data-sw-dock] .sw-count {
  position: absolute;
  top: -5px;
  left: calc(100% - 7px);
  box-sizing: border-box;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
button[data-sw-dock] .sw-count[data-hot] {
  box-shadow: 0 0 0 1px var(--dsw-alias-state-error-primary);
}
div[data-sw-dock] {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: min(300px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
div[data-sw-dock] .sw-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
div[data-sw-dock] .sw-title-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
div[data-sw-dock] .sw-title-value {
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-title-value[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}
div[data-sw-dock] .sw-title-rule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
div[data-sw-dock] p {
  margin: 0;
}
div[data-sw-dock] dl {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] dt, div[data-sw-dock] dd {
  min-width: 0;
  margin: 0;
}
div[data-sw-dock] dt {
  display: flex;
  align-items: baseline;
}
div[data-sw-dock] dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
div[data-sw-dock] .sw-rows {
  margin-top: 8px;
}
div[data-sw-dock] .sw-hero {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
div[data-sw-dock] .sw-hero-fig {
  color: var(--dsw-alias-label-primary);
  font-size: 24px;
  line-height: 28px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-hero-cap {
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-hero-pos {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
div[data-sw-dock] .sw-hero-pos .sw-hero-fig {
  font-size: 16px;
}
div[data-sw-dock] .sw-hero-pos small {
  display: block;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
div[data-sw-dock] .sw-track {
  position: relative;
  display: flex;
  gap: 2px;
  height: 6px;
  margin: 14px 0 0;
}
div[data-sw-dock] .sw-track > i {
  border-radius: 3px;
  corner-shape: round;
  background: color-mix(in srgb, currentColor 22%, transparent);
}
div[data-sw-dock] .sw-lit {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 2px;
}
div[data-sw-dock] .sw-lit > i {
  border-radius: 3px;
  corner-shape: round;
  background: color-mix(in srgb, currentColor 88%, transparent);
}
div[data-sw-dock] .sw-track > s {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 0;
  border-left: 1px solid var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-track > b {
  position: absolute;
  top: -4px;
  bottom: -4px;
  box-sizing: border-box;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  corner-shape: round;
  background: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-2);
}
div[data-sw-dock] .sw-scale {
  position: relative;
  height: 16px;
  margin-top: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
div[data-sw-dock] .sw-scale > span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}
div[data-sw-dock] .sw-sec {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
div[data-sw-dock] .sw-ctx-h {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-ctx-h > span:last-child {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-stock {
  display: flex;
  gap: 1px;
  height: 8px;
  margin: 6px 0 8px;
  border-radius: 4px;
  corner-shape: round;
  overflow: hidden;
}
div[data-sw-dock] .sw-stock > i, div[data-sw-dock] .sw-sw {
  background: var(--dsw-alias-label-secondary);
}
div[data-sw-dock] .sw-stock > i[data-k="eff"], div[data-sw-dock] .sw-sw[data-k="eff"] {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 35%, transparent);
}
div[data-sw-dock] .sw-sw {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  margin-right: 8px;
  border-radius: 2px;
  corner-shape: round;
}
div[data-sw-dock] .sw-bar {
  position: relative;
  height: 4px;
  margin: 4px 0;
  border-radius: 2px;
  corner-shape: round;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 22%, transparent);
}
div[data-sw-dock] .sw-bar > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  corner-shape: round;
  background: currentColor;
}
div[data-sw-dock] .sw-alert {
  margin-top: 12px;
  padding: 8px 10px;
  border: 0.5px solid color-mix(in srgb, currentColor 45%, transparent);
  border-radius: var(--dsw-radius-sm);
}
div[data-sw-dock] .sw-alert p {
  color: var(--dsw-alias-label-secondary);
}
`;

// dsh/src/client/styles.js
var TAB_CSS = scopeStylesheet(base_default) + scopeStylesheet(h_default) + BRIDGE_CSS + CHROME_CSS + LIGHT_CSS + DOCK_CSS;

// dsh/src/client/index.js
var inject = ["slots", "locale", "theme", "connection"];
function apply(ctx) {
  applyClient(ctx, { tabCss: TAB_CSS, useAnchoredPosition: import_dsh_client_ui_primitives.useAnchoredPosition, useDismissOnOutsidePointer: import_dsh_client_ui_primitives.useDismissOnOutsidePointer, createPortal: import_react_dom.createPortal });
}
/*! Bundled license information:

@kurkle/color/dist/color.esm.js:
  (*!
   * @kurkle/color v0.3.4
   * https://github.com/kurkle/color#readme
   * (c) 2024 Jukka Kurkela
   * Released under the MIT License
   *)

chart.js/dist/chunks/helpers.dataset.js:
chart.js/dist/chart.js:
  (*!
   * Chart.js v4.5.1
   * https://www.chartjs.org
   * (c) 2025 Chart.js Contributors
   * Released under the MIT License
   *)
*/
return module.exports; } });
