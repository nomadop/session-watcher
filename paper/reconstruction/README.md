# §4.2.1 Forward bill-reconstruction validation — data package

Replaces the backward (bill → L_avg → g) validation with a **forward**
reconstruction (per-turn log usage → bill) and reconciles it against the raw
provider bill. Headline: **median dollar recovery 91.2%** over 20 clean days
(2026-06-09 .. 2026-06-28), the stable window where JSONL transcript export was
deployed and billing is complete.

The published CSVs are trimmed to this window; original full-month data (06-03
through 06-29/07-01) is not included in the release package.

## Files

| file | what |
|---|---|
| `wash_usage.py` | desensitizes raw JSONL transcripts → content-free per-API-call usage table. Strips all text/paths/ids; folds by message.id; emits one row per call. |
| `apicalls-2026-6.csv` | the washed table (33,161 folded calls, 121 sessions, 20 days). Columns: `ts, session, seq, model, tier, cache_read, cache_creation, input, output`. `ts` is date-only. **No content**. This is the reviewer-facing reproduction input. |
| `amount-2026-6.csv` | raw provider bill for the same 20-day window (159 rows, one per day/model/type). Columns: `date, model, type, price, amount`. |
| `reconcile_bill.py` | reconciliation: washed usage table + raw bill → daily ratios & dollar error. |
| `daily_reconciliation.csv` | 20-day output table: `day, hit_ratio, miss_ratio, out_ratio, usd_recon, usd_bill, usd_err, miss_pct_of_bill`. |
| `compute_hbreak.py` | computes h_break and n* (EOQ optimum) from the washed table, producing the S6 key result (85% of sessions exceed h_break). Reads `apicalls-2026-6.csv` from its own directory (no CLI args). |

## Reproduce (two steps, no access to private transcripts needed for step 2)

```bash
# 1. wash raw transcripts → content-free usage table (run once, by the data owner)
python3 wash_usage.py --logs ../../fixtures/host/.claude/projects --out apicalls-2026-6.csv

# 2. reconcile against the raw bill (reviewer can reproduce on the published CSVs)
python3 reconcile_bill.py \
  --bill amount-2026-6.csv \
  --apicalls apicalls-2026-6.csv \
  --tier pro --start 2026-06-09 --end 2026-06-28 \
  --out daily_reconciliation.csv
```

Step 1 requires access to the private transcript fixtures (not in this
repository). Step 2 runs on the published CSVs alone and reproduces the 91.2%
median dollar recovery.

To reproduce the h_break / EOQ analysis (Remark 9, S6):

```bash
python3 compute_hbreak.py
```

## Method (three reconstruction rules — see script docstrings)

1. **message.id folding** (in `wash_usage.py`) — one API call emits many
   `usage`-bearing snapshots with identical cache_read; fold by message.id (last
   snapshot wins), else ~2.4× double-count. Mirrors shipped watcher `_byId`.
2. **tier by model, matching the bill** — bill separates AGENT (`deepseek-v4-pro`)
   from SUBAGENT (`deepseek-v4-flash`). Reconstruction tiers by model, NOT by the
   transcript `isSidechain` flag: a main session can make inline flash calls that
   belong to the flash bill line.
3. **per-turn miss = input_tokens** — cache-miss is billed on every turn's
   uncached input, not cold-start only. `cache_creation == 0` in this DeepSeek
   corpus, so miss == input. (Cold-start-only gave 0.33×; per-turn gives ~0.91×.)

Field → bill-type: `cache-hit ← cache_read`, `cache-miss ← cache_creation+input`,
`output ← output_tokens`. Prices read per-model FROM the bill (pro miss/hit=120×,
flash=50×). `<synthetic>` / all-zero-usage rows dropped (aborted-turn artifacts).

## Results (tier=pro, 20 days, 2026-06-09 .. 2026-06-28)

| metric | median | mean |
|---|---|---|
| hit_ratio (holding, ΣL) | 0.872× | 0.872× |
| miss_ratio (order, per-turn input) | 0.912× | 0.900× |
| out_ratio (output) | 0.982× | 0.974× |
| **dollar recovery** | **0.912×** | **0.905×** |

miss carries 18–51% of the bill's dollars (miss/hit price = 120×) despite small
token share; its 0.912× ratio does not bias the total.

## Known limits (for the caveat text)

- All three component ratios sit slightly below 1 together (hit 0.872, miss 0.912,
  out 0.982) — a same-signed ~9% underestimate. This is a **coverage** gap (some
  calls not captured in the exported transcripts), not a pricing-rule error:
  a pricing error would move one component, not all three in proportion. The
  C_o≠C_m single-price issue is regime-avoided here because reconciliation reads
  input/output as separate fields at their own prices (not via a merged g).
- Ground truth (bill) is per-day. One heavy-loop day at the end of the billing
  month (2026-06-29) appears bill-incomplete and is excluded from the published
  window; the raw full-month data is available from the author on request.
- Stated as ~9% median dollar error — not claimed as exact.
- The reconstruction rules were calibrated on the same billing month, so the 91%
  recovery is in-sample; cross-operator generalization remains untested.
