// Pure pricing preset logic — no DOM. Shared by pricingChip.js and tests.

export function resolveActivePresetId(effectiveSource, savedPresetId) {
  return (effectiveSource === 'preset' && savedPresetId) ? savedPresetId : null;
}

export function isDriftedFromPreset(inputRead, inputWrite, preset) {
  if (!preset) return true;
  const r = parseFloat(inputRead);
  const w = parseFloat(inputWrite);
  return !Number.isFinite(r) || !Number.isFinite(w)
    || Math.abs(r - preset.readPrice) > 1e-9
    || Math.abs(w - preset.writePrice) > 1e-9;
}
