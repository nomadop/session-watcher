// public/elements/pricingChip.js — Pricing chip + popover editor (spec §2 #8)
// Chip: ⚙ read X× write · source
// Popover: read/write price inputs, ratio display, save/reset/cancel
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

import { resolveActivePresetId, isDriftedFromPreset } from '../lib/pricingHelpers.js';

// State machine states
const STATE = {
  PRISTINE: 'pristine',
  DIRTY: 'dirty',
  SAVING: 'saving',
  SAVED: 'saved',
  ERROR: 'error',
};

export function mount(root, ctx) {
  const { transport } = ctx;

  // ── DOM Construction ──────────────────────────────────────────────────────

  const wrapper = document.createElement('div');
  wrapper.className = 'sw-pricing-wrapper';

  // Chip button
  const chip = document.createElement('button');
  chip.className = 'sw-pricing-chip';
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-haspopup', 'dialog');

  const gearSpan = document.createElement('span');
  gearSpan.textContent = '⚙';
  gearSpan.setAttribute('aria-hidden', 'true');

  const chipLabel = document.createElement('span');
  chipLabel.className = 'sw-pricing-chip-label';
  chipLabel.textContent = '…';

  chip.appendChild(gearSpan);
  chip.appendChild(chipLabel);

  // Popover
  const popover = document.createElement('div');
  popover.className = 'sw-pricing-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Edit pricing');

  popover.innerHTML = `
    <div class="pp-h">Pricing <span>config · takes effect on Save</span></div>
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
      <span class="sw-pricing-ratio-span">read <b class="sw-pricing-ratio-val">—</b> write</span>
      <span class="sw-pricing-source-span">source <b class="sw-pricing-source-val">—</b></span>
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

  // ── Element references ────────────────────────────────────────────────────

  const readInput    = popover.querySelector('.sw-pricing-read');
  const writeInput   = popover.querySelector('.sw-pricing-write');
  const ratioDisplay = popover.querySelector('.sw-pricing-ratio-val');
  const sourceDisplay = popover.querySelector('.sw-pricing-source-val');
  const noticeEl     = popover.querySelector('.sw-pricing-notice');
  const errorEl      = popover.querySelector('.sw-pricing-error');
  const saveBtn      = popover.querySelector('.sw-pricing-save');
  const resetBtn     = popover.querySelector('.sw-pricing-reset');
  const presetSelect = popover.querySelector('.sw-pricing-preset-select');

  // ── State ─────────────────────────────────────────────────────────────────

  let popoverOpen = false;
  let formState = STATE.PRISTINE;

  let effectiveReadPrice = null;
  let effectiveWritePrice = null;
  let effectiveSource = null;
  let effectiveRatio = null;

  let draftReadPrice = null;
  let draftWritePrice = null;

  let presets = [];
  let activePresetId = null;

  // ── Chip rendering ────────────────────────────────────────────────────────

  function updateChipLabel() {
    if (effectiveRatio == null) {
      chipLabel.innerHTML = '…';
      return;
    }
    // effectiveRatio = write/read; display as "read Nx write"
    const readToWrite = 1 / effectiveRatio;
    const ratioStr = readToWrite < 0.01 ? readToWrite.toFixed(3) : readToWrite < 0.1 ? readToWrite.toFixed(2) : readToWrite.toFixed(1);
    chipLabel.innerHTML = `read <b>${ratioStr}×</b> write · ${sourceLabel()}`;
  }

  // ── Popover state machine ─────────────────────────────────────────────────

  function computeInputRatio() {
    const r = parseFloat(readInput.value);
    const w = parseFloat(writeInput.value);
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(w) || w <= 0) return null;
    return w / r;
  }

  function updateRatioDisplay() {
    // Use input-derived ratio if available, else fall back to effective ratio from server
    const ratio = computeInputRatio() ?? effectiveRatio;
    if (ratio == null || ratio === 0) {
      ratioDisplay.textContent = '—';
    } else {
      // Display as 1/R (read-to-write), matching the chip label format
      const readToWrite = 1 / ratio;
      ratioDisplay.textContent = `${readToWrite < 0.01 ? readToWrite.toFixed(3) : readToWrite < 0.1 ? readToWrite.toFixed(2) : readToWrite.toFixed(1)}×`;
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

    noticeEl.style.display = 'none';
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
    readInput.readOnly = false;
    writeInput.readOnly = false;
    readInput.style.opacity = '';
    writeInput.style.opacity = '';

    switch (state) {
      case STATE.PRISTINE:
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        break;
      case STATE.DIRTY:
        saveBtn.disabled = false;
        saveBtn.style.opacity = '';
        noticeEl.style.display = '';
        break;
      case STATE.SAVING:
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        saveBtn.style.opacity = '0.7';
        readInput.readOnly = true;
        writeInput.readOnly = true;
        readInput.style.opacity = '0.6';
        writeInput.style.opacity = '0.6';
        break;
      case STATE.SAVED:
        saveBtn.disabled = true;
        saveBtn.textContent = '✓ Saved';
        saveBtn.style.opacity = '0.7';
        break;
      case STATE.ERROR:
        saveBtn.disabled = false;
        saveBtn.style.opacity = '';
        errorEl.style.display = '';
        break;
    }
  }

  function onInputChange() {
    // Manual edit clears preset (spec §10 frontend rule).
    // NaN guard: parseFloat('') → NaN; NaN comparison always false — must handle explicitly.
    if (activePresetId) {
      const drifted = isDriftedFromPreset(readInput.value, writeInput.value, presets.find(p => p.id === activePresetId));
      if (drifted) {
        activePresetId = null;
        presetSelect.value = '';
      }
    }
    draftReadPrice = parseFloat(readInput.value);
    draftWritePrice = parseFloat(writeInput.value);
    updateRatioDisplay();
    if (formState === STATE.SAVING) return;
    applyFormState(inputsMatchEffective() ? STATE.PRISTINE : STATE.DIRTY);
  }

  // ── Popover open/close ────────────────────────────────────────────────────

  function populateInputsFromEffective() {
    if (effectiveReadPrice != null) {
      readInput.value = effectiveReadPrice.toFixed(4);
    } else {
      readInput.value = '';
    }
    if (effectiveWritePrice != null) {
      writeInput.value = effectiveWritePrice.toFixed(4);
    } else {
      writeInput.value = '';
    }
    sourceDisplay.textContent = sourceLabel();
    updateRatioDisplay();
  }

  function openPopover() {
    if (popoverOpen) return;
    popoverOpen = true;
    populateInputsFromEffective();
    applyFormState(STATE.PRISTINE);
    popover.style.display = 'block';
    chip.setAttribute('aria-expanded', 'true');
  }

  function closePopover() {
    if (!popoverOpen) return;
    popoverOpen = false;
    popover.style.display = 'none';
    chip.setAttribute('aria-expanded', 'false');
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    noticeEl.style.display = 'none';
  }

  // ── Click-outside handler ─────────────────────────────────────────────────

  function onDocumentClick(e) {
    if (!popoverOpen) return;
    if (!wrapper.contains(e.target)) {
      closePopover();
    }
  }

  document.addEventListener('click', onDocumentClick, true);

  // ── Save / Reset ──────────────────────────────────────────────────────────

  async function doSave() {
    const readPrice = parseFloat(readInput.value);
    const writePrice = parseFloat(writeInput.value);

    if (!Number.isFinite(readPrice) || readPrice <= 0 || !Number.isFinite(writePrice) || writePrice <= 0) {
      applyFormState(STATE.ERROR);
      errorEl.textContent = 'Enter valid positive prices.';
      return;
    }

    applyFormState(STATE.SAVING);
    try {
      const res = await fetch('/api/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readPrice, writePrice, presetId: activePresetId }),
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
        errorEl.textContent = data.message || 'Save failed. Please try again.';
      }
    } catch (err) {
      applyFormState(STATE.ERROR);
      errorEl.textContent = 'Network error. Please try again.';
    }
  }

  async function doReset() {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting…';
    try {
      const res = await fetch('/api/pricing', { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        applyPricingData(data);
        updateChipLabel();
        populateInputsFromEffective();
        applyFormState(STATE.PRISTINE);
        transport.refresh();
      }
    } catch (err) {
      // best-effort; silently re-enable
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Reset';
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  let modelName = null;

  function populatePresetOptions() {
    presetSelect.innerHTML = '<option value="">Custom</option>';
    for (const p of presets) {
      const opt = document.createElement('option');
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
    // Store model name for display when source is model_default
    if (data.modelDefault?.model) modelName = data.modelDefault.model;

    // Presets
    if (Array.isArray(data.presets)) {
      presets = data.presets;
      populatePresetOptions();
    }

    // Active preset — only set if source is actually 'preset' (not drifted).
    // If source='saved' but presetId is stored, that's a drift state — treat as custom.
    activePresetId = resolveActivePresetId(effectiveSource, data.saved?.presetId);
    presetSelect.value = activePresetId || '';

    // Show Reset when there's a saved override or preset
    resetBtn.style.display = (effectiveSource === 'saved' || effectiveSource === 'preset') ? '' : 'none';
  }

  function sourceLabel() {
    if (effectiveSource === 'model_default' && modelName) return modelName;
    return (effectiveSource || '—').replace(/_/g, ' ');
  }

  async function loadInitialPricing() {
    try {
      const res = await fetch('/api/pricing');
      if (res.ok) {
        const data = await res.json();
        applyPricingData(data);
        updateChipLabel();
        if (popoverOpen) populateInputsFromEffective();
      }
    } catch {
      chipLabel.textContent = 'pricing unavailable';
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  chip.addEventListener('click', () => {
    if (popoverOpen) closePopover();
    else openPopover();
  });


  readInput.addEventListener('input', onInputChange);
  writeInput.addEventListener('input', onInputChange);

  presetSelect.addEventListener('change', () => {
    const selectedId = presetSelect.value;
    if (!selectedId) {
      activePresetId = null;
      return;
    }
    const preset = presets.find(p => p.id === selectedId);
    if (preset) {
      activePresetId = selectedId;
      readInput.value = preset.readPrice.toFixed(4);
      writeInput.value = preset.writePrice.toFixed(4);
      onInputChange();
    }
  });

  saveBtn.addEventListener('click', doSave);
  resetBtn.addEventListener('click', doReset);

  // ── Element contract ──────────────────────────────────────────────────────

  loadInitialPricing();

  function update(_snapshot) {
    // pricing chip is mostly self-contained (GET/POST/DELETE /api/pricing)
  }

  function destroy() {
    document.removeEventListener('click', onDocumentClick, true);
    wrapper.remove();
  }

  return { update, destroy };
}
