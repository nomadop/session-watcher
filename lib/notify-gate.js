// 主动打断门控。纯状态机——server 拥有持久化 + I/O(§4.6.2)。
// 保守 fullCarry 轴上每 segment 最多 fire 两次。防三种噪声:thrash / nag / cold-start。

function fresh(segment) {
  return { segment, turnSeq: 0, maxTierFired: 0, pendingCount: 0 };
}

function messageFor(tier) {
  // fullCarry-framed 中性文案:hook 不引用 α,也不下 verdict/紧迫指令(Global Constraints §1/§5)。
  if (tier === 2) return 'Session Watcher: far past the full-carry exit (+1Δ). Consider a restart/compact at the next natural boundary — no more alerts this segment. Ask session-restart-advisor for details.';
  return 'Session Watcher: crossed the full-carry cost-optimal exit. Consider restarting at the next natural boundary. Ask session-restart-advisor for details.';
}

const finite = (...xs) => xs.every(v => Number.isFinite(v));

// Raw fullCarry-axis tier (spec §4.6.1 step 5), extracted so POST and GET /peek share it (A7/GPT#9).
export function rawTierFor(x, fc) {
  const { xStar, dhat } = fc || {};
  if (!Number.isFinite(x) || !Number.isFinite(xStar) || !Number.isFinite(dhat) || dhat <= 0 || xStar <= 0) return 0;
  return x >= xStar + dhat ? 2 : x >= xStar ? 1 : 0;
}

export function evaluateGate(snapshot, prevState) {
  // 1. segment reconcile(restart/clear/compact/rotation 都会 bump v1 的 segment)
  let state = (!prevState || prevState.segment !== snapshot.segment)
    ? fresh(snapshot.segment) : { ...prevState };

  const done = (notify, tier, reason, message = null) =>
    ({ notify, tier, reason, message, nextState: state });

  // 2. turn 幂等(re-delivered / stale Stop)
  if (snapshot.turnSeq <= state.turnSeq) return done(false, 0, 'duplicate_turn');
  const advance = () => { state.turnSeq = snapshot.turnSeq; };  // 非 fire 出口也记录已评估本 turn

  // 3. reliability 门(warmup / metrics unreliable)——freeze,绝不 fire
  if (snapshot.reliable === false) { advance(); state.pendingCount = 0; return done(false, 0, 'not_reliable'); }

  // 4. landmark validity 门
  const fc = snapshot.landmarks?.fullCarry || {};
  const { xStar, dhat } = fc;
  if (!finite(snapshot.x, xStar, dhat) || dhat <= 0 || xStar <= 0) {
    advance(); state.pendingCount = 0; return done(false, 0, 'invalid_landmarks');
  }

  // 5. fullCarry 轴上的 raw tier(A7/GPT#9:调 rawTierFor,POST 与 peek 共用一份 tier 数学)。
  // step 4 的 invalid_landmarks 门仍先跑:rawTierFor 对非法输入返 0,不得与真正的 below-entry 0 混淆。
  const rawTier = rawTierFor(snapshot.x, snapshot.landmarks?.fullCarry);

  // 6. ratchet——吸收 thrash 与 x* 下漂(rawTier ≤ 已 fire 的最高 tier → 抑制)
  if (rawTier <= state.maxTierFired) { advance(); state.pendingCount = 0; return done(false, rawTier, 'below_or_fired'); }

  // 7. tier1 首穿确认(2 连续 eligible turn;tier2 豁免:+Δ 越过出口,假阳性低)
  if (rawTier === 1 && state.maxTierFired < 1) {
    state.pendingCount += 1;
    advance();
    if (state.pendingCount < 2) return done(false, 1, 'pending_confirm');
  }

  // 8. fire
  state.maxTierFired = rawTier;
  state.pendingCount = 0;
  advance();
  return done(true, rawTier, 'fire', messageFor(rawTier));
}

export function serializeState(state) { return JSON.stringify(state); }
export function parseState(str) {
  try { const s = JSON.parse(str); return (s && typeof s.segment !== 'undefined') ? s : null; } catch { return null; }
}

// round-6 GPT#6: range/enum guard, symmetric with validateLedgerState. parseState only checks JSON +
// `segment` presence, so a finite-but-out-of-range state (turnSeq:-1, maxTierFired:999, pendingCount:99)
// could drive the ratchet into permanent suppression or spurious fires. Reject → null (caller treats as
// fresh). Ranges: segment/turnSeq non-negative ints; maxTierFired ∈ {0,1,2}; pendingCount 0..2 (evaluateGate
// never sets it above the confirm window — adjust the upper bound here if that window changes).
export function validateGateState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of ['segment', 'turnSeq', 'maxTierFired', 'pendingCount']) {
    if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  }
  if (obj.maxTierFired > 2) return null;
  if (obj.pendingCount > 2) return null;
  return obj;
}
