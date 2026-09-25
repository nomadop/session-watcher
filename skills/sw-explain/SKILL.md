---
name: sw-explain
description: Use when the user asks what a Session Watcher metric means (br, mf, pp, u, wall, sweet, valley) or runs /sw-explain — explains the requested metric in plain language and contextualizes it for the current session.
---

# Explain a Session Watcher metric

When the user asks about a metric:

1. Call `watcher_status` to confirm the dashboard is running and get its URL (metric VALUES live on the dashboard the user can see — do not expect raw numbers from MCP).
2. Explain the requested metric in plain language.
3. Contextualize against the flat-valley / AM-GM bound where relevant.

## Metric glossary

- **br (bill premium)** — how far the bill sits above its cost at the sweet spot, as a fraction. `BR_AMBER` and `BR_RED` are the zone boundaries, and the dashboard shows where the session sits against them. `br = mf × pp`.
- **mf (movable fraction)** — the share of cost that timing can affect. AM-GM caps it at `√2−1`, which is also why the reminder interval has a natural floor. Whatever sits above that share is cost no restart timing can reach.
- **pp** — the timing-penalty shape term `(u−1)²/(2u)`; minimized at u=1 (the sweet spot).
- **u** — normalized position, accumulated causally: each API call adds the fraction of a restart interval that the conditions in force for it imply, so u only moves forward and loading more files never walks it back. Short of a whole interval = left arm (cost still falling, so the lamp stays white or green); one whole interval = sweet; beyond it = past sweet. The lamp's colour is arm-gated this way; the carry-rent reminder is not, because it reads accumulated rent instead of the position. `uInst`, the `(x−1)/dhat` ratio, is reported beside the causal `u` as a diagnostic that nothing acts on.
- **wall** — where continuing costs more per turn than a full restart.
- **sweet / valley** — the cost-curve minimum, reported as `xSweet` and read off the reference skeleton fitted across the session's own path; the valley around it is flat (small timing penalty).

Frame reassuringly where the numbers allow it: the movable fraction bounds how much of the bill timing can reach at all, and the valley around the sweet spot is flat, so a moderate `br` on the left arm carries no urgency. `br` itself has no ceiling — `pp` grows without bound on the late arm, which is why `renderBr` clamps what the statusline prints.
