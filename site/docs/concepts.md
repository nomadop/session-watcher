# Concepts

Core quantities and interpretation for the Session Watcher measurement system.

This page defines the user-visible metrics and cost-model quantities. Each entry lists the canonical name, its API field, units, a plain-language definition, and validity conditions. For stable behavioral guarantees, see the Guarantees page.

---

## Position Axis

Quantities that locate the session on the token-position number line.

### L (Effective Context Length)

**API field.** `L`

**Units.** tokens

**Definition.** The authoritative size of the context the model is currently reading. Normally equals the cache-read token count from the latest API response. When a cache miss is detected (cache eviction mid-session), L is reconstructed as cache-read plus cache-creation so the metrics see a continuous value rather than a cliff.

**Validity.** Always non-negative. Zero before the first model interaction in a segment, or on a true cold-start where no cached context exists yet.

### B (Baseline)

The baseline measures how many tokens the model would need to re-ingest if the session restarted now.

#### B_full

**API field.** (internal — drives all decision math)

**Units.** tokens

**Definition.** The complete rebuild cost: the system overhead floor plus the sum of all tracked file contributions. B_full is the system's unfiltered belief about what a restart would cost.

**Validity.** Non-negative. Becomes positive on the first model interaction (because the system overhead floor is set immediately from the first API response). Zero only before that first interaction.

#### B_default

**API field.** `bDefault` (also exposed as `B` in the top-level status, display-capped)

**Units.** tokens

**Definition.** The subset of B_full that the user would actually carry into a new session: the system overhead floor plus only those files that pass the inclusion filter (not gitignored, not outside the project, plus any user overrides). This is the value used as the position denominator throughout the cost model.

When all tracked files are excluded, B_default still equals the system overhead floor. When B_default is zero (before the first interaction), the system falls back to B_full internally to avoid division by zero.

The public API field `B` is a display-capped version of B_full that ensures the physical invariant B ≤ totalStock holds during transient cache-creation lag. The cap self-releases once the provider's cache catches up.

**Validity.** `0 ≤ B_default ≤ B_full`. Positive after the first model interaction.

### System Overhead (Floor)

**API field.** (internal component of B)

**Units.** tokens

**Definition.** The irreducible context that is always present regardless of what files are loaded: system prompt, tool definitions, and conversation scaffolding. Measured once at the start of each segment from the first API response (the maximum of cache-read, cache-creation, and input token counts). Even after a restart, the session cannot go below this floor.

**Validity.** Set once per segment. Zero before the first model interaction.

### x (Position Ratio)

**API field.** `x`

**Units.** dimensionless ratio

**Definition.** How far the session has travelled past its baseline: `x = L / B_default`. At x=1 you are at baseline (no growth above the carry). At x=2 the context has doubled beyond baseline. The entire cost model is parameterized in terms of x.

**Validity.** Meaningful when baseline is valid (B_full > 0 and cRatio > 0). Falls back to 1 otherwise.

---

## Rate Axis

Quantities measuring how fast context is growing.

### g (Growth Rate)

**API field.** `g`

**Units.** tokens/call (smoothed)

**Definition.** The effective growth rate of unexplained context accumulation per API call. Computed as a Holt double-exponential moving average (tracking both level and trend) of the per-call residual — the L growth that cannot be attributed to known file operations. Floored at a minimum value to prevent cold-start artifacts.

**Intuition.** "How fast is new context arriving each turn?" A high g means content is accumulating rapidly; the cost model responds by widening the optimal zone (recommending longer cycles before restart).

**Validity.** Always positive (floored). Reflects the smoothed trend once several interactions have occurred.

### residual

**API field.** (internal — feeds g)

**Units.** tokens

**Definition.** The per-interaction L growth that cannot be attributed to known file operations and could not be retired from the deferred settlement ledger. This is the "unexplained growth" that feeds the growth-rate smoother: reasoning tokens, tool output framing, conversation structure, and any content the system cannot trace to a specific file.

**Validity.** Non-negative. The deferred ledger absorbs timing mismatches between B and L so that cache-creation lag does not produce false residual spikes.

---

## Cost Axis

Quantities from the EOQ (Economic Order Quantity) cost model that drive the restart recommendation.

### dhat (Nucleus)

**API field.** `dhat`

**Units.** dimensionless

**Definition.** The characteristic scale of the cost model, derived from an inventory-theory analogy. It determines how wide the low-cost valley is around the sweet spot. Computed from the restart cost ratio, growth rate, and baseline size. A larger dhat means restarts can be delayed longer before cost rises significantly.

**Validity.** Positive when baseline is valid. Null otherwise.

### xSweet (Sweet Spot)

**API field.** `xSweet`

**Units.** dimensionless (position ratio)

**Definition.** The position at which the bill premium is minimized: `xSweet = 1 + dhat`. Below xSweet you are on the left arm (restarting too early). Above xSweet you are on the right arm (overstaying, accumulating excess cost).

**Validity.** Defined whenever dhat is defined. Always greater than 1.

### bp (Bill Premium)

**API field.** `br`

**Units.** dimensionless (0 to unbounded)

**Definition.** The instantaneous excess cost relative to optimal timing. Measures how much more expensive the current position is compared to the sweet spot.

bp combines two factors: (1) a positional penalty that grows as the session moves away from the sweet spot in either direction, and (2) the movable fraction that scales this penalty by how much of the total cost is actually timing-sensitive. bp=0 at the sweet spot.

**Lamp behavior.** On the right arm (past sweet), below BP_AMBER the lamp is green; above BP_AMBER the session enters deep water. On the left arm (before sweet), the lamp shows white or green but never triggers alerts — the mathematical penalty at cold start is operationally meaningless.

**Validity.** Non-negative when defined. Null when baseline is invalid.

### mf (Movable Fraction)

**API field.** `mf`

**Units.** dimensionless fraction (0 to ~0.414)

**Definition.** The proportion of total session cost that is timing-sensitive — could theoretically be avoided by optimal restart timing. The remainder is unavoidable overhead (system floor, irreducible growth cost) that no restart strategy can eliminate.

If mf is small, even bad timing costs little. If mf is large, timing matters significantly. mf scales the bill premium so that sessions where restarts matter get earlier alerts.

**Validity.** In range (0, ~0.414) when baseline is valid; null otherwise. The upper bound comes from the AM-GM inequality.

### cRatio (Cost Ratio)

**API field.** `cRatio`

**Units.** dimensionless ratio

**Definition.** The ratio of cache-write price to cache-read price for the current model (C_write / C_read). Determined from a model lookup table or a user override. "How many reads does one write cost?" A higher cRatio means restarts are more expensive, pushing the sweet spot further out.

**Validity.** Always positive.

### wallP (Rate Wall Position)

**API field.** `rateLamp.wallP`

**Units.** dimensionless (position ratio)

**Definition.** The x-position at which rentRate reaches 1.0: `wallP = 1 + cRatio`. At this point the session is consuming cache-read budget as fast as one restart cycle can replenish it.

Note: wallP is NOT guaranteed to exceed xSweet. For small B or large g, dhat can exceed cRatio, placing the sweet spot beyond the rate wall. Therefore wallP is the rate-saturation marker, not an unconditional "past optimal" signal.

**Validity.** Computed whenever baseline is valid. Always greater than 1.

---

## Operations Axis

Quantities that drive the notification gate and display indicators.

### rentRate

**API field.** `burnRate`

**Units.** dimensionless rate

**Definition.** The instantaneous fraction of one restart cycle's cost being consumed per call. Computed as the excess of L above B_default, divided by the restart cost (cRatio × B_default). At rentRate=0 you are at or below baseline. At rentRate=1 you hit the rate wall. Increases linearly with L beyond baseline.

**Validity.** Non-negative. Null when baseline is invalid.

### backstopInterval

**API field.** (derived — rendered as `n/N` in the statusline)

**Units.** bill cycles (dimensionless)

**Definition.** How many full bill cycles must elapse in deep water before the backstop alert fires. One "bill" completes when the trapezoidal integral of rentRate (billProgress) crosses 1.0. The interval adapts to mf: higher mf (more at stake) shortens it; lower mf lengthens it. Because the unit is bill cycles (not wall time), the backstop fires sooner in expensive sessions and later in cheap ones.

**Validity.** Finite and positive when mf > 0. Infinite when mf is zero (backstop never fires).

### BP_AMBER

**API field.** (constant threshold)

**Definition.** The bill-premium threshold at which the session enters the warning zone. The deep-water gate fires when three conditions hold simultaneously: (1) x ≥ xSweet (right arm), (2) bp ≥ BP_AMBER for at least NOTIFY_DWELL consecutive API calls, AND (3) at least one bill-cycle crossing occurred during those calls. The cycle-crossing requirement debounces false fires when hovering near the threshold with no real cost accumulation.

### BP_RED

**API field.** (constant threshold)

**Definition.** The higher bill-premium threshold for the red/critical zone. Used for lamp color only; the gate mechanism uses BP_AMBER as its trigger.

### Lamp States

The statusline lamp is a visual indicator synthesized from bp, x, and xSweet:

| State | Condition |
|-------|-----------|
| White | bp is not computable, OR left arm below the amber entry boundary |
| Green | Right arm with bp < BP_AMBER; OR left arm past the amber entry boundary |
| Amber | bp ≥ BP_AMBER and bp < BP_RED (right arm only) |
| Red | bp ≥ BP_RED (right arm only) |

The gate never fires on the left arm regardless of the numerical bp value — a session that has not yet reached the sweet spot is not "overstaying."

---

## Structure Axis

Quantities describing the per-path token map and its maintenance.

### pathTotal

**API field.** `tokens` (in bucket data)

**Units.** tokens

**Definition.** Each tracked file's contribution to B: the sum of its line-level token counts, plus tool-invocation overhead, plus any pending edit estimate, minus any calibration correction. Floored at zero. Summed across all paths (plus the system overhead floor) to produce B_full.

**Validity.** Non-negative.

### discardReason

**API field.** `defaultDiscardReason` (in bucket data)

**Definition.** Why a path is excluded from B_default. Values: `'outside-project'`, `'gitignore'`, or null (included). Users can override via include/exclude.

### Bucket Types

The system tracks different categories of content:

| Type | Description |
|------|-------------|
| **File path** | Standard tracked file (Read, Write, Edit, grep hit) |
| **Skill** | Skill/instruction content loaded into context (included in B_default by default) |
| **Bash/MCP residual** | Tool output not attributed to a specific file (contributes to residual growth, not B) |

File paths are canonicalized so that different representations of the same file (`./a.js`, `/cwd/a.js`) map to a single entry, preventing baseline inflation from path fragmentation.
