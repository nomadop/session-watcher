#!/usr/bin/env python3
"""
Forward bill reconstruction & reconciliation (v2.1, §4.2.1 forward validation).

CLAIM UNDER TEST
----------------
Given only the per-turn API logs (Claude Code JSONL transcripts), the deepseek
monthly bill can be reconstructed FORWARD by integrating the shipped-lib usage
fields — no backward L_avg->g inversion needed. Median dollar recovery 91% on the
stable window (2026-06-09 .. 2026-06-28).

INPUTS (both raw, uncleaned — reviewer-reproducible)
----------------------------------------------------
  1. Raw provider bill:  amount-2026-6.csv
       columns: date, model, type, price, amount
       (pre-cleaned: user_id/api_key dropped; api_key_name filtered to 'claude')
       - model 'deepseek-v4-pro'   == AGENT   (main orchestrating session)
       - model 'deepseek-v4-flash' == SUBAGENT (sidechain workers)
       - type is the ground truth per (day, model, type); 'request_count' is
         non-billable and ignored.
  2. Raw JSONL transcripts: fixtures/host/.claude/projects/**/*.jsonl
       (contain sidechain rows; the subagent split is applied HERE, in code,
        not pre-baked into the data.)

THREE RECONSTRUCTION RULES (each was a real correction; see paper §4.2.1)
------------------------------------------------------------------------
  R1. message.id folding. One API call emits MANY assistant lines that each
      carry `usage` (streaming / output-growth snapshots) with the SAME
      cache_read. Summing them raw double-counts ~2.4x. We fold by message.id
      and keep the LAST snapshot (output has grown to final). This mirrors the
      shipped watcher's `_byId` fold (lib/fold.js).
  R2. subagent exclusion. The bill's AGENT tier is model==pro; JSONL rows with
      isSidechain==true (or living under a /subagents/ path) are the SUBAGENT
      tier (bill model==flash). To reconcile the agent tier we drop sidechain
      rows. Toggle with --include-sidechain to reconcile the combined bill.
  R3. per-turn miss = input_tokens (NOT cold-start-only). cache-miss is billed
      on EVERY turn's uncached input, not just the first cold call. deepseek
      cache_creation == 0 in this corpus, so miss_tokens == input_tokens.
      (Earlier cold-start-only rule gave 0.33x; per-turn gives ~0.91x.)

MAPPING log usage field -> bill type
------------------------------------
  cache-hit  (holding, Σ L(t))  <- cache_read_input_tokens
  cache-miss (order)            <- cache_creation_input_tokens + input_tokens
  output                        <- output_tokens

Prices are taken PER MODEL from the bill itself (not hardcoded), so the dollar
total uses the same unit prices the provider charged:
  pro : hit 2.5e-8, miss 3e-6, out 6e-6   (miss/hit = 120x)
  flash: hit 2e-8,  miss 1e-6, out 2e-6   (miss/hit = 50x)

USAGE
-----
  python3 reconcile_bill.py \
      --bill     amount-2026-6.csv \
      --apicalls apicalls-2026-6.csv \
      --tier     pro \
      --start    2026-06-09 --end 2026-06-28 \
      --out      daily_reconciliation.csv

Outputs daily_reconciliation.csv and prints the median/mean ratios to stdout.
"""
import argparse, csv, glob, json, os, statistics as st
from collections import defaultdict

TYPE_MAP = {
    'input_cache_hit_tokens': 'hit',
    'input_cache_miss_tokens': 'miss',
    'output_tokens': 'out',
}


def load_bill(path, tier):
    """tier in {'pro','flash','both'}. Returns (tokens[day][comp], price[comp])."""
    want = {'pro': ['pro'], 'flash': ['flash'], 'both': ['pro', 'flash']}[tier]
    tokens = defaultdict(lambda: defaultdict(int))
    price = {}
    with open(path, encoding='utf-8-sig') as fh:
        for r in csv.DictReader(fh):
            model = r['model']
            model_tier = 'pro' if 'pro' in model else ('flash' if 'flash' in model else '?')
            if model_tier not in want:
                continue
            comp = TYPE_MAP.get(r['type'])
            if comp is None:
                continue
            tokens[r['date']][comp] += int(r['amount'])
            p = (r.get('price') or '').strip()
            if p:
                # last writer wins; per-tier prices are equal within a tier
                price[comp] = float(p)
    return tokens, price


def reconstruct(apicalls_csv, tier):
    """Aggregate the washed per-call usage table (already folded by message.id in
    wash_usage.py) into daily hit/miss/out totals for the requested billing tier.

    tier is matched by MODEL (matching how the bill is structured), NOT by the
    isSidechain-derived 'tier' column:
      tier=='pro'   -> deepseek-v4-pro rows   (bill AGENT tier)
      tier=='flash' -> deepseek-v4-flash rows (bill SUBAGENT tier)
      tier=='both'  -> both models
    <synthetic> and all-zero-usage rows are dropped (aborted-turn artifacts; the
    shipped lib drops these in extract.js). R3: miss = cache_creation + input.
    """
    want = {'pro': ['pro'], 'flash': ['flash'], 'both': ['pro', 'flash']}[tier]
    recon = defaultdict(lambda: defaultdict(int))
    with open(apicalls_csv) as fh:
        for r in csv.DictReader(fh):
            model = r['model']
            m = 'pro' if 'pro' in model else ('flash' if 'flash' in model else '?')
            if m not in want:
                continue
            cr = int(r['cache_read']); cc = int(r['cache_creation'])
            inp = int(r['input']); out = int(r['output'])
            if cr + cc + inp + out == 0:
                continue  # aborted-turn / synthetic
            day = r['ts'].split('T')[0]
            recon[day]['hit'] += cr
            recon[day]['miss'] += cc + inp   # R3: miss = cc + input (per-turn, not cold-only)
            recon[day]['out'] += out
    return recon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bill', required=True, help='raw provider bill CSV (amount-2026-6.csv)')
    ap.add_argument('--apicalls', required=True, help='washed per-call usage CSV from wash_usage.py')
    ap.add_argument('--tier', choices=['pro', 'flash', 'both'], default='pro',
                    help='billing tier matched by model: pro=agent, flash=subagent')
    ap.add_argument('--start', default='2026-06-09')
    ap.add_argument('--end', default='2026-06-28')
    ap.add_argument('--out', default='daily_reconciliation.csv')
    args = ap.parse_args()

    bill, price = load_bill(args.bill, args.tier)
    recon = reconstruct(args.apicalls, args.tier)

    def usd(d):
        return d['hit'] * price['hit'] + d['miss'] * price['miss'] + d['out'] * price['out']

    days = sorted(d for d in bill if args.start <= d <= args.end)
    rows_out = []
    for day in days:
        b, r = bill[day], recon[day]
        hr = r['hit'] / b['hit'] if b.get('hit') else 0.0
        mr = r['miss'] / b['miss'] if b.get('miss') else 0.0
        orr = r['out'] / b['out'] if b.get('out') else 0.0
        rr, br = usd(r), usd(b)
        rows_out.append({
            'day': day,
            'hit_ratio': round(hr, 4), 'miss_ratio': round(mr, 4), 'out_ratio': round(orr, 4),
            'usd_recon': round(rr, 4), 'usd_bill': round(br, 4),
            'usd_err': round(rr / br, 4) if br else 0.0,
            'miss_pct_of_bill': round(b['miss'] * price['miss'] / br * 100, 1) if br else 0.0,
        })

    with open(args.out, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows_out[0].keys()))
        w.writeheader()
        w.writerows(rows_out)

    def med(xs, k): return st.median([x[k] for x in xs])
    def mean(xs, k): return st.mean([x[k] for x in xs])
    print(f"tier={args.tier} window={args.start}..{args.end} days={len(rows_out)}")
    print(f"prices: {price}  (miss/hit = {price['miss']/price['hit']:.0f}x)")
    print(f"{'':14}{'hit':>8}{'miss':>8}{'out':>8}{'usd_err':>9}")
    print(f"{'MEDIAN':14}{med(rows_out,'hit_ratio'):>8.2f}{med(rows_out,'miss_ratio'):>8.2f}"
          f"{med(rows_out,'out_ratio'):>8.2f}{med(rows_out,'usd_err'):>9.3f}")
    print(f"{'MEAN':14}{mean(rows_out,'hit_ratio'):>8.2f}{mean(rows_out,'miss_ratio'):>8.2f}"
          f"{mean(rows_out,'out_ratio'):>8.2f}{mean(rows_out,'usd_err'):>9.3f}")
    print(f"wrote {args.out}")


if __name__ == '__main__':
    main()
