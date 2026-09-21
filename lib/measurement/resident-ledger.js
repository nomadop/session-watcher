// Resident-content ledger for the portable Measurement Engine: fragment mutations, signed adjustment,
// spend/touch accounting, and residual grouping. Everything crossing this Interface is a number, an
// opaque key, or JSON-compatible metadata, so the module reads no file, imports no Node built-in, and
// interprets no harness vocabulary. Its mutation surface belongs to the Engine; the Engine alone decides
// when an effect or a residual allocation is accepted.

// A touch history is a display trail, so it keeps a bounded newest suffix rather than the whole run.
export const TOUCH_HISTORY_MAX = 128;
export const TOUCH_HISTORY_KEEP = 64;

const MUTATION_KINDS = new Set(['replace-fragments', 'merge-fragments', 'adjust-total']);

function invariant(ok, message) {
  if (!ok) throw new Error(`resident ledger invariant: ${message}`);
}

function isTokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSignedTokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// The projected resident total of one resource. `correction` is the Engine's banked, never-confirmed
// credit for this resource, supplied only when a closing snapshot resolves it. Repeated deletes and a
// correction larger than the belief never drive the total negative: the clamp is a read, so the signed
// adjustment underneath keeps its value and a later re-read recovers.
export function resourceTokensOf(resource, correction = 0) {
  return Math.max(0, resource.fragmentTotal + resource.adjustment + resource.overhead - correction);
}

export function createResidentLedger() {
  const resources = new Map();
  const residuals = new Map();

  function newResource() {
    return {
      fragments: new Map(),
      fragmentTotal: 0,
      adjustment: 0,
      overhead: 0,
      accumulatedSpend: 0,
      readCount: 0,
      editCount: 0,
      pureRereads: 0,
      // Two independent facts: whether a whole-content snapshot has ever landed (a consumer that wants
      // line coverage should read the file instead), and whether the next whole-content read is a pure
      // re-read (write access invalidates that claim).
      fullSnapshot: false,
      wholeContentEligible: false,
      lastTurn: 0,
      lastCallSeq: 0,
      touches: [],
    };
  }

  function setFragment(resource, key, tokens) {
    const previous = resource.fragments.get(key) || 0;
    resource.fragments.set(key, tokens);
    resource.fragmentTotal += tokens - previous;   // incremental total maintenance, O(1) per fragment
  }

  function pushTouch(owner, seq, mode) {
    owner.touches.push({ seq, mode });
    if (owner.touches.length > TOUCH_HISTORY_MAX) {
      owner.touches.splice(0, owner.touches.length - TOUCH_HISTORY_KEEP);
    }
  }

  // Validates the whole effect, allocates its overhead and spend once, applies every impact, and reports
  // which resources it created and which grew. Validation completes before the first mutation: a
  // half-applied effect would raise the resident total without a matching per-resource growth entry,
  // which the Engine's settlement invariant reads as an attribution shortfall.
  function applyEffect(effect, context) {
    invariant(effect !== null && typeof effect === 'object', 'effect must be an object');
    const access = effect.access;
    invariant(access === 'read' || access === 'write', 'effect access must be read or write');
    invariant(isTokenCount(effect.overheadTokens), 'effect overheadTokens must be a non-negative finite number');
    invariant(isTokenCount(effect.spentTokens), 'effect spentTokens must be a non-negative finite number');
    const impacts = effect.impacts;
    invariant(Array.isArray(impacts) && impacts.length > 0, 'effect must carry at least one impact');
    invariant(context !== null && typeof context === 'object', 'effect context must be an object');

    const plans = impacts.map((impact) => {
      invariant(impact !== null && typeof impact === 'object', 'impact must be an object');
      const { resourceKey, mutation } = impact;
      invariant(typeof resourceKey === 'string' && resourceKey.length > 0,
        'impact resourceKey must be a non-empty string');
      invariant(mutation !== null && typeof mutation === 'object', 'impact mutation must be an object');
      invariant(MUTATION_KINDS.has(mutation.kind), `unsupported mutation kind: ${String(mutation.kind)}`);
      if (mutation.kind === 'adjust-total') {
        // Single-impact by construction: an evenly divided overhead has no meaning for a mutation that
        // allocates none, so a multi-impact adjustment would leave part of the overhead unallocated.
        invariant(impacts.length === 1, 'adjust-total is single-impact');
        invariant(isSignedTokenCount(mutation.deltaTokens), 'adjust-total deltaTokens must be a finite number');
        return { resourceKey, mutation, incomingTokens: 0 };
      }
      const fragments = mutation.fragments;
      invariant(Array.isArray(fragments), 'a fragment mutation must carry a fragments array');
      const seen = new Set();
      let incomingTokens = 0;
      for (const fragment of fragments) {
        invariant(fragment !== null && typeof fragment === 'object', 'fragment must be an object');
        invariant(fragment.key !== undefined && fragment.key !== null, 'fragment key must be present');
        invariant(!seen.has(fragment.key), `duplicate fragment key in one impact: ${String(fragment.key)}`);
        seen.add(fragment.key);
        invariant(isTokenCount(fragment.tokens), 'fragment tokens must be a non-negative finite number');
        incomingTokens += fragment.tokens;
      }
      return { resourceKey, mutation, incomingTokens };
    });

    const single = plans.length === 1;
    const perImpactOverhead = (single && plans[0].mutation.kind === 'adjust-total')
      ? 0
      : effect.overheadTokens / plans.length;
    // Spend follows each impact's actual injected share — its incoming fragment tokens plus its allocated
    // overhead — so a small resource inside a wide multi-resource result is never charged more than it
    // injected, which would drive its churn below one.
    let injectedTotal = 0;
    for (const plan of plans) injectedTotal += plan.incomingTokens + perImpactOverhead;
    for (const plan of plans) {
      plan.overhead = perImpactOverhead;
      plan.spend = single
        ? effect.spentTokens
        : (injectedTotal > 0
          ? effect.spentTokens * ((plan.incomingTokens + perImpactOverhead) / injectedTotal)
          : effect.spentTokens / plans.length);
    }

    const before = new Map();
    for (const plan of plans) {
      if (before.has(plan.resourceKey)) continue;
      const existing = resources.get(plan.resourceKey);
      before.set(plan.resourceKey, existing ? resourceTokensOf(existing) : 0);
    }

    const newResourceKeys = [];
    for (const plan of plans) {
      let resource = resources.get(plan.resourceKey);
      if (!resource) {
        resource = newResource();
        resources.set(plan.resourceKey, resource);
        newResourceKeys.push(plan.resourceKey);
      }
      const { mutation } = plan;
      if (mutation.kind === 'replace-fragments') {
        resource.fragments = new Map();
        resource.fragmentTotal = 0;
        resource.adjustment = 0;   // a fresh observation supersedes every unlocalized signed edit
        for (const fragment of mutation.fragments) setFragment(resource, fragment.key, fragment.tokens);
        resource.overhead = plan.overhead;
      } else if (mutation.kind === 'merge-fragments') {
        for (const fragment of mutation.fragments) setFragment(resource, fragment.key, fragment.tokens);
        resource.overhead = plan.overhead;
      } else {
        resource.adjustment += mutation.deltaTokens;   // signed debt; existing overhead stays
      }

      // `replace-fragments` IS the whole-content observation: it supersedes the resource's entire fragment
      // set, which only a reader that saw the whole content can claim. A projection's fragment keys are
      // resource-local values the ledger never interprets, so the kind is the single source of this fact.
      const wholeContent = mutation.kind === 'replace-fragments';
      if (wholeContent) resource.fullSnapshot = true;
      if (access === 'write') {
        resource.wholeContentEligible = false;
      } else if (wholeContent) {
        if (resource.wholeContentEligible && plan.incomingTokens > 0) resource.pureRereads += 1;
        resource.wholeContentEligible = true;
      }

      if (plan.spend > 0) resource.accumulatedSpend += plan.spend;
      if (access === 'write') resource.editCount += 1; else resource.readCount += 1;
      resource.lastTurn = context.turn;
      resource.lastCallSeq = context.foldedSeq;
      pushTouch(resource, context.foldedSeq, access === 'write' ? 'w' : 'r');
    }

    const positiveResourceDeltas = [];
    for (const [resourceKey, beforeTokens] of before) {
      const growth = resourceTokensOf(resources.get(resourceKey)) - beforeTokens;
      if (growth > 0) positiveResourceDeltas.push({ resourceKey, growth });
    }
    return { newResourceKeys, positiveResourceDeltas, diagnostics: [] };
  }

  // One positive-share residual candidate: { groupKey, tokens, turn, foldedSeq, hadError, meta }. The
  // cursors are the candidate's own, recorded when its record arrived, not the settling step's.
  function applyResidualAllocation(allocation) {
    invariant(allocation !== null && typeof allocation === 'object', 'allocation must be an object');
    const { groupKey, tokens, turn, foldedSeq, hadError, meta } = allocation;
    invariant(typeof groupKey === 'string' && groupKey.length > 0,
      'allocation groupKey must be a non-empty string');
    invariant(isTokenCount(tokens) && tokens > 0, 'allocation tokens must be a positive finite number');
    let residual = residuals.get(groupKey);
    if (!residual) {
      residual = { tokens: 0, count: 0, lastTurn: 0, lastCallSeq: 0, touches: [], meta: null };
      residuals.set(groupKey, residual);
    }
    residual.tokens += tokens;
    residual.count += 1;
    residual.lastTurn = turn;
    residual.lastCallSeq = foldedSeq;
    pushTouch(residual, foldedSeq, hadError === true ? 'e' : 'w');
    residual.meta = meta ?? null;   // replaced wholesale; the ledger does not interpret it
  }

  // Cheap positive totals for the reads that need only the resident sum or a per-resource weight.
  // snapshot() detaches every fragment map, which a status read summing tokens must not pay for.
  function residentTotals() {
    const out = [];
    for (const [resourceKey, resource] of resources) {
      const tokens = resourceTokensOf(resource);
      if (tokens > 0) out.push({ resourceKey, tokens });
    }
    return out;
  }

  function snapshot() {
    return {
      resources: [...resources.entries()].map(([resourceKey, value]) => ({
        resourceKey,
        ...structuredClone(value),
      })),
      residuals: [...residuals.entries()].map(([groupKey, value]) => ({
        groupKey,
        ...structuredClone(value),
      })),
    };
  }

  return { applyEffect, applyResidualAllocation, residentTotals, snapshot };
}
