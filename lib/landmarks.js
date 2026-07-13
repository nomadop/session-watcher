import { CONSTANTS } from './constants.js';

// 主纲量 Δ̂ = √(2ρ),ρ = cRatio·kAvg/lBase。b=1 时精确复现 v1 lStar:
// lStar = lBase·(1 + M·Δ̂),M = EFFICIENCY_MULT = 2,故 fullCarry x* = 1 + 2·Δ̂。
export function nucleus(cRatio, kAvg, lBase) {
  if (cRatio <= 0 || kAvg <= 0 || lBase <= 0) return 0;
  return Math.sqrt(2 * cRatio * kAvg / lBase);
}

// 重建地板 B(bRebuild) 的地标,表达在当前 x 轴(x = L/lBase)上。
// 绝对 token: L*_B = B + M·√(2·cRatio·B·kAvg);除以 lBase、令 b = B/lBase → x*(b) = b + M·Δ̂·√b。
// 地板偏移 b 与 √ 项(Δ̂·√b)都随重建基线缩放——偏移是 b,不是固定 1。
// fullCarry 是 b=1 特例(→ 1 + M·Δ̂ = v1 lStar);deadOnly(b=lDead/lBase≪1)位置远低 → 更早重启。
// 系数 {0.5,1,2} 是 EOQ u-landmarks(u=n/n*=0.5/1/2):u=0.5、u=2 是 ±25%-regret 对称边界,u=1 谷底。
export function landmarksFor(cRatio, kAvg, lBase, bRebuild) {
  const b = (bRebuild > 0 && lBase > 0) ? bRebuild / lBase : 0;
  const dhat = nucleus(cRatio, kAvg, lBase) * Math.sqrt(b); // Δ̂·√b
  const M = CONSTANTS.EFFICIENCY_MULT; // 2
  return { dhat, xEntry: b + 0.5 * dhat, xSweet: b + dhat, xStar: b + M * dhat };
}

// 前瞻破平衡轮数(§0.4):分母是可避免部分 L−B,非 L−lBase。fullCarry(B=lBase)退化 cRatio/(x−1)。
// L ≤ B(地板下无可避免租金)→ Infinity。
export function hBreak(cRatio, bRebuild, L) {
  const avoidable = L - bRebuild;
  if (avoidable <= 0) return Infinity;
  return cRatio * bRebuild / avoidable;
}

// 中性事实枚举,替 LLM 做浮点比较;必须中性词,禁裁决词(OVERDUE 拒用)。x 的纯函数,无 α。
export function bandOf(x, { xEntry, xSweet, xStar }) {
  if (x < xEntry) return 'below_entry';
  if (x < xSweet) return 'entry_to_sweet';
  if (x < xStar) return 'sweet_to_exit';
  return 'above_exit';
}

// 双基线 bundle:工具吐两端点,不插值、不选(§0.5)。
export function landmarks(cRatio, kAvg, lBase, lDead, L) {
  const x = lBase > 0 ? L / lBase : 1;
  const full = landmarksFor(cRatio, kAvg, lBase, lBase);
  const dead = landmarksFor(cRatio, kAvg, lBase, lDead);
  return {
    x,
    fullCarry: { ...full, hBreak: hBreak(cRatio, lBase, L), band: bandOf(x, full) },
    deadOnly: { ...dead, hBreak: hBreak(cRatio, lDead, L), band: bandOf(x, dead) },
  };
}
