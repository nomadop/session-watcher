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

- **br (bill regret)** — how much extra you pay vs optimal restart timing, as a fraction. 0.10 = amber, 0.25 = red. `br = mf × pp`.
- **mf (movable fraction)** — the share of cost that timing can affect. Capped at √2−1 ≈ 41.4% by AM-GM — even worst-case timing can't cost more than that.
- **pp** — the timing-penalty shape term `(u−1)²/(2u)`; minimized at u=1 (the sweet spot).
- **u** — normalized position `(x−1)/dhat`. u<1 = left arm (cost still falling, no action). u=1 = sweet. u>1 = past sweet.
- **wall** — where continuing costs more per turn than a full restart.
- **sweet / valley** — `xSweet = 1 + dhat`, the cost-curve minimum; the valley around it is flat (small timing penalty).

Frame reassuringly: e.g. "br=18% sounds high, but the ceiling is ~41.4%, so you're inside the flat valley — no urgency."
