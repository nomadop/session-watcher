#!/usr/bin/env python3
"""
Compute h_break and n* for DeepSeek agent-tier sessions (§4.2.1 / Remark 9).
Methodology and result interpretation: see paper.tex §4.2.1.
"""

import csv, os
from statistics import median, mean
from collections import defaultdict

R_PRO = 120
R_FLASH = 50

def compute_h_break(L, g, R):
    if g <= 0 or L <= 0:
        return float('inf')
    a = g / 2.0
    b = L + g / 2.0
    c = -R * L
    disc = b*b - 4*a*c
    if disc < 0:
        return float('inf')
    return max(0, (-b + disc**0.5) / (2*a))

def compute_n_star(L, g, R):
    if g <= 0 or L <= 0:
        return float('inf')
    return (2 * R * L / g) ** 0.5

def main():
    sessions = defaultdict(list)
    csv_path = os.path.join(os.path.dirname(__file__), 'apicalls-2026-6.csv')
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            if row['tier'] != 'agent':
                continue
            key = (row['session'], row['model'])
            sessions[key].append({
                'seq': int(row['seq']),
                'L': int(row['cache_read']) + int(row['cache_creation']),
            })

    results = []
    for (sid, model), calls in sorted(sessions.items()):
        calls.sort(key=lambda c: c['seq'])
        L_vals = [c['L'] for c in calls]
        n = len(L_vals)
        if n < 5:
            continue

        warmup = min(3, n // 5)
        stable_window = L_vals[warmup:min(warmup + 10, n)]
        L_floor = min(stable_window) if stable_window else L_vals[warmup]
        if L_floor <= 0:
            continue

        later = L_vals[warmup:]
        if len(later) < 3:
            continue
        t = list(range(len(later)))
        n_l = len(later)
        st = sum(t)
        sL = sum(later)
        stL = sum(ti * li for ti, li in zip(t, later))
        st2 = sum(ti * ti for ti in t)
        denom = n_l * st2 - st * st
        g = max(0, (n_l * stL - st * sL) / denom) if denom > 0 else 0
        if g <= 0:
            continue

        R = R_FLASH if 'flash' in model else R_PRO
        hb = compute_h_break(L_floor, g, R)
        ns = compute_n_star(L_floor, g, R)
        k = n / ns if ns < 1e6 and ns > 0 else float('inf')

        results.append({
            'session': sid[:12], 'model': model, 'n': n,
            'L_floor': L_floor, 'g': g, 'R': R,
            'h_break': hb, 'n_star': ns, 'k': k,
        })

    print(f"Agent-tier sessions (n>=5, g>0): {len(results)}")
    print()

    metrics = [
        ('n (turns)',        [r['n'] for r in results]),
        ('L_floor (tokens)', [r['L_floor'] for r in results]),
        ('g (tok/turn)',     [r['g'] for r in results]),
        ('h_break (turns)',  [r['h_break'] for r in results if r['h_break'] < 1e6]),
        ('n* (EOQ optimum)', [r['n_star'] for r in results if r['n_star'] < 1e6]),
        ('k = n/n*',         [r['k'] for r in results if r['k'] < 100]),
    ]

    print(f"{'Metric':<20} {'Median':>8} {'Mean':>8} {'p25':>8} {'p75':>8}")
    print("-" * 52)
    for name, vals in metrics:
        if vals:
            sv = sorted(vals)
            print(f"{name:<20} {sv[len(sv)//2]:>8.1f} {mean(vals):>8.1f} "
                  f"{sv[len(sv)//4]:>8.1f} {sv[3*len(sv)//4]:>8.1f}")

    exceed = [r for r in results if r['h_break'] < 1e6 and r['n'] > r['h_break']]
    below  = [r for r in results if r['h_break'] < 1e6 and r['n'] <= r['h_break']]
    tot = len(exceed) + len(below)

    print(f"\n=== KEY RESULT (S6) ===")
    print(f"  n > h_break  (warm-session cheaper):  {len(exceed):>3} ({100*len(exceed)/tot:.0f}%)")
    print(f"  n <= h_break (fresh-session optimal): {len(below):>3} ({100*len(below)/tot:.0f}%)")

    if exceed:
        ehb = median([r['h_break'] for r in exceed])
        en  = median([r['n'] for r in exceed])
        ek  = median([r['k'] for r in exceed if r['k'] < 100])
        print(f"  Exceeders: median h_break={ehb:.0f}t, median n={en:.0f}t, median k={ek:.2f}")

    for m in ['deepseek-v4-pro', 'deepseek-v4-flash']:
        mr = [r for r in results if m in r['model']]
        me = [r for r in mr if r['h_break'] < 1e6 and r['n'] > r['h_break']]
        if mr:
            mhb = median([r['h_break'] for r in mr if r['h_break'] < 1e6])
            print(f"  {m}: {len(mr)} sessions, median h_break={mhb:.0f}, "
                  f"exceed={len(me)} ({100*len(me)/len(mr):.0f}%)")

    tail = [r for r in results if r['k'] < 100 and r['k'] > 3]
    print(f"\n  Tail (k > 3): {len(tail)}/{len(results)} sessions "
          f"({100*len(tail)/len(results):.0f}%)")

if __name__ == '__main__':
    main()
