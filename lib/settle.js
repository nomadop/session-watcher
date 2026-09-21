// §2.4c deferred-settlement primitive. ONE interval's worth of bank/retire, and the only implementation
// of it: the Measurement Engine's settlement step is its sole caller, so there is no second copy of this
// arithmetic to drift against.
//
// Matches this row's ΔB against this row's ΔL EXACTLY ONCE: banks only the leftover B-surplus per-path
// (content credited ahead of L), retires the historical ledger only with the leftover L-surplus. This is
// the report-#1 fix — the earlier order netted ΔL three times and leaked phantom residual on catch-up.
//
// Conservation invariants (holds every row):
//   Dₐ = max(0, D + ΔB − ΔL)          (new deferred total)
//   residual = max(0, ΔL − ΔB − D)    (phantom residual — 0 while the ledger can absorb it)
// `ledger` = { total:number, byPath:Map<string,number> } is MUTATED in place; `total` is recomputed as
// Σ byPath after every prune, so Σ byPath === total is an invariant (no scalar/Map dust desync).
export function settleDeferred(deltaL, deltaB, pathDeltas, ledger, { epsilon = 1e-6 } = {}) {
  const dL = Math.max(0, deltaL);
  const bSurplus = Math.max(0, deltaB - dL); // B credited ahead of L this row → candidate to BANK
  const lSurplus = Math.max(0, dL - deltaB); // L confirmed beyond this row's B → RETIRES old ledger

  // Positive path growth only — positive-only sum for BOTH denominator and attribution keeps
  // Σ(banked-by-path) === banked exactly (a negative delta must not inflate the denominator).
  let posTotal = 0;
  if (pathDeltas) for (const d of pathDeltas.values()) if (d > 0) posTotal += d;

  // BANK: the whole B-surplus, attributed across the paths that grew. The caller owns the guarantee that
  // `pathDeltas` accounts for the surplus — the Engine's shortfall invariant raises an internal failure
  // when it does not, so a surplus this attribution cannot place never reaches the ledger.
  const banked = bSurplus;
  if (banked > 0 && posTotal > 0) {
    for (const [p, d] of pathDeltas) {
      if (d <= 0) continue;
      ledger.byPath.set(p, (ledger.byPath.get(p) || 0) + banked * (d / posTotal));
    }
  }

  // RETIRE: draw the HISTORICAL ledger down with the L-surplus only. Residual is what neither this
  // row's ΔB nor the banked history can explain.
  const retired = Math.min(ledger.total, lSurplus);
  const residual = lSurplus - retired;
  if (retired > 0 && ledger.total > 0) {
    const frac = retired / ledger.total;
    for (const [p, amt] of ledger.byPath) {
      const next = amt - amt * frac;
      if (next > epsilon) ledger.byPath.set(p, next); else ledger.byPath.delete(p);
    }
  }

  // Keep the scalar EXACTLY consistent with the Map (folds epsilon-pruned dust into `total`).
  let sum = 0;
  for (const v of ledger.byPath.values()) sum += v;
  ledger.total = sum;

  return { residual, banked, retired };
}
