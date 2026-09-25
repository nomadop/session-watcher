# Concepts

Core quantities and interpretation for the Session Watcher measurement system.

This page defines the user-visible metrics and cost-model quantities. Each entry lists the canonical name, its API field, units, a plain-language definition, and validity conditions; a threshold entry lists the constant and where it lives instead of a field. For stable behavioral guarantees, see the Guarantees page.

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

When all tracked files are excluded, B_default still equals the system overhead floor. Before the first interaction B_default is zero, and the baseline validity gate withholds every position quantity except the position ratio, which reports its fallback, until it turns positive.

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

**Validity.** Meaningful when baseline is valid (B_default > 0 and cRatio > 0). Falls back to 1 otherwise.

### u (Normalized Position)

**API field.** `u`

**Units.** dimensionless (restart intervals)

**Definition.** How far along its own cost cycle the session has actually travelled, counted in restart intervals. Each API call adds the fraction of a restart interval that the baseline in force and the realized mean growth of the context outside that baseline imply at that moment, so the count only ever moves forward and is never re-valued: a baseline that grows later changes how fast the count advances from then on, not the distance already covered. One completed interval is the sweet spot; less is the early side, more is the late side. This is the authoritative position — the lamp, the verdict and every landmark read it.

**Validity.** Zero until the segment has realized growth over a settled interval, positive afterwards. Null when the baseline is invalid.

### reference (Reference Skeleton)

**API field.** `rateLamp.reference`

**Definition.** The straight-line relation between position ratio and normalized position, fitted across the whole path the segment has travelled. Every landmark on the position axis — the sweet spot, the warning boundary on each arm and the critical boundary — is read off this line, so they move together as the fit sharpens. While the session is still short of the sweet spot the fit is reported as provisional.

**Validity.** Present once the segment's stamped points span more than a single normalized position and the fit rises; absent otherwise, and when it is absent every position landmark is absent with it.

---

## Rate Axis

Quantities measuring how fast context is growing.

### g (Growth Rate)

**API field.** `g`

**Units.** tokens/call (smoothed)

**Definition.** The effective growth rate of unexplained context accumulation per API call. Computed as a single-exponential level filter with a per-call step cap over the per-call residual — the growth of total context stock that known file operations do not account for. Floored at a minimum value to prevent cold-start artifacts. The position (u) is not read from it: the position fold prices each interval at the realized mean growth of the context outside the scenario's baseline, so a file the baseline leaves out counts as growth rather than disappearing from both sides.

**Intuition.** "How fast is new context arriving each turn?" A high g means content is accumulating rapidly; the cost model responds by widening the optimal zone (recommending longer cycles before restart).

**Validity.** Always positive (floored). Reflects the smoothed level once several interactions have occurred.

### residual

**API field.** (internal — feeds g)

**Units.** tokens

**Definition.** The per-interaction growth of total context stock, net of the growth known file operations account for. This is the "unexplained growth" that feeds the growth-rate smoother: reasoning tokens, tool output framing, conversation structure, and any content the system cannot trace to a specific file.

**Validity.** Non-negative. It is read from total stock rather than from L: content parks in cache creation before cache reads advance, and total stock carries no such lag, so a file read cannot surface as a residual spike while its tokens are still in transit.

---

## Cost Axis

Quantities from the EOQ (Economic Order Quantity) cost model that drive the restart recommendation.

### dhat (Nucleus)

**API field.** `dhat`

**Units.** dimensionless

**Definition.** The characteristic scale of the cost model, derived from an inventory-theory analogy. Computed from the restart cost ratio, the rate the position fold runs on, and the baseline that rate is measured against, at the latest reading. A larger dhat means restarts can be delayed longer before cost rises significantly.

Note: the landmarks on the position axis are not placed from dhat — they are read off the reference skeleton, which is fitted to the path the session travelled rather than derived from the latest reading. dhat is reported as a diagnostic beside the raw position ratio, and nothing in the lamp, the verdict or the reminder reads it.

**Validity.** Positive when the baseline is valid and the segment has realized growth over a settled interval; zero before that. Null when the baseline is invalid.

### xSweet (Sweet Spot)

**API field.** `xSweet`

**Units.** dimensionless (position ratio)

**Definition.** The position ratio at which the bill premium is minimized: the reference skeleton read off at one completed restart interval. It is where the sweet spot sits on the position-ratio axis, which is what a chart needs to draw it; which arm the session is on is decided by normalized position rather than by comparing x to this value.

**Validity.** Defined whenever the reference skeleton is. It is that skeleton evaluated at `u = 1`, and the skeleton's slope is only required to be positive and finite, so an early fit can place it at or below `x = 1`.

### pp (Position Penalty)

**API field.** `pp`

**Units.** dimensionless (0 to unbounded)

**Definition.** The timing-penalty shape on its own, before any scaling by how much of the bill timing can move. It is zero at the sweet spot and rises on both sides, gently on the early side and without bound on the late side. Bill premium is this quantity multiplied by the movable fraction.

**Validity.** Non-negative when defined. Null while the position is still zero — until the segment has realized growth over a settled interval — and when the baseline is invalid.

### br (Bill Premium)

**API field.** `br`

**Units.** dimensionless (0 to unbounded)

**Definition.** The excess cost relative to optimal timing at the normalized position the session has actually reached. Measures how much more expensive the path travelled is compared to stopping at the sweet spot.

bp combines two factors: (1) the position penalty, which grows as the session moves away from the sweet spot in either direction, and (2) the movable fraction that scales this penalty by how much of the total cost is actually timing-sensitive. bp=0 at the sweet spot.

**Lamp behavior.** Which arm the session is on is decided by normalized position, never by the position ratio against xSweet. On the right arm the lamp is green below `BR_AMBER`, amber above it, red above `BR_RED`. On the left arm the lamp shows white until the position reaches the mirror image of the amber boundary and green from there to the sweet spot; the warning and critical colours are right-arm states only, because the mathematical penalty at cold start is operationally meaningless. The reminder is a separate mechanism and reads accumulated rent rather than bp, so it is not conditioned on the arm.

**Validity.** Non-negative when defined. Null while the position penalty is null and when the baseline is invalid.

### mf (Movable Fraction)

**API field.** `mf`

**Units.** dimensionless fraction (0 to `1/(1+√2)`)

**Definition.** The proportion of total session cost that is timing-sensitive — could theoretically be avoided by optimal restart timing. The remainder is unavoidable overhead (system floor, irreducible growth cost) that no restart strategy can eliminate.

If mf is small, even bad timing costs little. If mf is large, timing matters significantly. mf scales the bill premium so that sessions where restarts matter get earlier alerts. It is path-weighted over the segment's travelled intervals; the reminder clock instead converts each interval's rent at that interval's own fraction.

**Validity.** In range `[0, 1/(1+√2))` when the baseline is valid — exactly zero until the segment has realized any growth — and null on the segment's first measured call or when the baseline is invalid. The upper bound comes from the AM-GM inequality.

### cRatio (Cost Ratio)

**API field.** `cRatio`

**Units.** dimensionless ratio

**Definition.** The ratio of cache-write price to cache-read price for the current model (C_write / C_read). Determined from a model lookup table — keyed by the model and, where the provider prices cache lifetimes apart, by the prompt-cache lifetime the host declares — or from a user override. "How many reads does one write cost?" A higher cRatio means restarts are more expensive, pushing the sweet spot further out.

**Validity.** Always positive.

### wallP (Rate Wall Position)

**API field.** `rateLamp.wallP`

**Units.** dimensionless (position ratio)

**Definition.** The x-position at which one more call's avoidable rent equals a complete rebuild: `wallP = 1 + cRatio`. At this point the session is consuming cache-read budget as fast as one restart cycle can replenish it.

Note: wallP is NOT guaranteed to exceed xSweet. The fitted sweet spot can land beyond the rate wall, so wallP is the rate-saturation marker, not an unconditional "past optimal" signal.

**Validity.** Computed whenever baseline is valid. Always greater than 1.

---

## Operations Axis

Quantities that drive the restart reminder and display indicators.

### backstopInterval

**API field.** `rateLamp.rentMeter.backstopInterval`, with the fill in `rateLamp.rentMeter.depthProgress`

**Units.** bill cycles (dimensionless)

**Definition.** How much accumulated rent one reminder is worth, measured in rebuild-equivalent bill cycles: it is the bill a session would run up travelling from a fresh start to the amber premium. The reminder bar fills with the same per-call rent increment that drives the bill cycle, divided by this interval; the call whose increment fills the bar raises a reminder stamped with the lap count reached and wraps the bar, so a call large enough to fill it more than once is announced by that stamp rather than by a reminder per lap. The interval is set by the exchange fraction in force for the interval being converted: a higher fraction (more at stake) shortens it; a lower one lengthens it, so loading a large file slows the clock from then on without rewinding it. Because the unit is accumulated rent rather than wall time, the reminder arrives sooner in expensive sessions and later in cheap ones — and because the reminder reads accumulated rent alone, nothing about the measured position can retract a reminder already raised.

**Validity.** A finite positive number of bill cycles while the current interval's exchange fraction is positive. The wire carries `null` whenever it is not — including before the segment has realized any growth — and while it does, the wallet clock holds where it stands and raises no reminder.

### BR_AMBER

**Constant.** `BR_AMBER` in `lib/bill-regret.js`

**Definition.** The bill-premium threshold at which the session enters the warning zone. It also sets the reminder's scale: the reminder interval is the accumulated bill between a fresh start and this premium.

### BR_RED

**Constant.** `BR_RED` in `lib/bill-regret.js`

**Definition.** The higher bill-premium threshold for the red/critical zone. Used for lamp color only; the reminder's scale comes from `BR_AMBER`.

### Lamp States

The statusline lamp is a visual indicator synthesized from bp and normalized position:

| State | Condition |
|-------|-----------|
| White | bp is not computable, OR left arm below the mirrored amber boundary |
| Green | Right arm with bp < `BR_AMBER`; OR left arm past the mirrored amber boundary |
| Amber | bp ≥ `BR_AMBER` and bp < `BR_RED` (right arm only) |
| Red | bp ≥ `BR_RED` (right arm only) |

The arm is read from normalized position, so a session that has not yet reached the sweet spot is never treated as "overstaying" however large its numerical bp.

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

### scenario (Position Preview)

**API field.** `scenario`, the answer of `POST /api/preview`

**Definition.** The session's whole position history re-folded under a candidate set of include/exclude choices, so the dashboard can show where the session would sit if those choices were applied. It carries the candidate path, its landmarks and its premium. Asking for one applies nothing and tells nothing else: the position already on screen stays where it was, and applying the same choices afterwards produces the same numbers. A transcript replay refuses the request, because the preview would be folded from the replay's context while the apply would land on the live one.

**Validity.** Reported when measurement is reliable; otherwise the answer says only that it is unavailable.

### Bucket Types

The system tracks different categories of content:

| Type | Description |
|------|-------------|
| **File path** | Standard tracked file (Read, Write, Edit, grep hit, or a shell read that names one file) |
| **Skill** | Skill/instruction content loaded into context (included in B_default by default) |
| **Bash/MCP residual** | Tool output not attributed to a specific file (contributes to residual growth, not B) |

File paths are canonicalized so that different representations of the same file (`./a.js`, `/cwd/a.js`) map to a single entry, preventing baseline inflation from path fragmentation.
