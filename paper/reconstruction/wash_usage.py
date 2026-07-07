#!/usr/bin/env python3
"""
Desensitize raw Claude Code JSONL transcripts into a content-free, per-API-call
usage table for reviewer reproduction.

WHY
---
The reconciliation (reconcile_bill.py) needs only per-call token counts, not the
conversation content. Shipping this washed table + the bill + the scripts lets a
reviewer reproduce §4.2.1 end-to-end WITHOUT access to the private transcripts.
Everything content-bearing or identifying is stripped here.

WHAT IS STRIPPED / TRANSFORMED
------------------------------
  - all message text, tool names, file paths, cwd, git branch, previews  -> DROPPED
  - real session UUID / message.id / user_id / api_key                   -> DROPPED;
    a stable anonymized `session` = sha1(salt + session_id)[:10] replaces the UUID
    so calls from one session still group, but the UUID is unrecoverable.
  - only numeric usage fields + timestamp + model + tier survive.

FOLDING (baked in here, transparent via this script)
----------------------------------------------------
One API call emits many assistant lines that each carry `usage` (streaming /
output-growth snapshots) with the SAME cache_read. We fold by message.id and keep
the LAST snapshot (output has grown to final), emitting ONE row per call. Raw
summation would double-count ~2.4x. Mirrors the shipped watcher `_byId` fold.

TIER
----
  tier = 'sub' if (isSidechain == true OR file under a /subagents/ path) else 'agent'
  (bill mapping: agent == model deepseek-v4-pro, sub == deepseek-v4-flash)

OUTPUT  apicalls-2026-6.csv  (one row per folded API call)
  ts, session, seq, model, tier, cache_read, cache_creation, input, output

USAGE
  python3 wash_usage.py --logs ../../fixtures/host/.claude/projects \\
                        --out apicalls-2026-6.csv [--salt v2.1]
"""
import argparse, csv, glob, hashlib, json, os


def anon(session_id, salt):
    return hashlib.sha1((salt + '|' + session_id).encode()).hexdigest()[:10]


def wash(logs_root, out_path, salt):
    files = sorted(glob.glob(os.path.join(logs_root, '**', '*.jsonl'), recursive=True))
    n_files = n_rows_in = n_calls = 0
    with open(out_path, 'w', newline='') as out_fh:
        w = csv.writer(out_fh)
        w.writerow(['ts', 'session', 'seq', 'model', 'tier',
                    'cache_read', 'cache_creation', 'input', 'output'])
        for f in files:
            is_sub_file = os.sep + 'subagents' + os.sep in f
            # session id = the top-level transcript stem (subagent files inherit parent dir name)
            base = os.path.basename(f)
            if is_sub_file:
                # parent dir of /subagents/ is the owning session
                sess_id = os.path.basename(os.path.dirname(os.path.dirname(f)))
            else:
                sess_id = base[:-6] if base.endswith('.jsonl') else base
            sess = anon(sess_id, salt)

            rows = []  # (fold_key, ts, model, tier, cr, cc, inp, out)
            try:
                fh = open(f, encoding='utf-8', errors='ignore')
            except OSError:
                continue
            with fh:
                for ln in fh:
                    if '"usage"' not in ln:
                        continue
                    try:
                        o = json.loads(ln)
                    except json.JSONDecodeError:
                        continue
                    if o.get('type') != 'assistant':
                        continue
                    msg = o.get('message') or {}
                    u = msg.get('usage')
                    if not u:
                        continue
                    ts = o.get('timestamp', '')
                    if 'T' not in ts:
                        continue
                    ts = ts[:10]  # date only — time component unused downstream
                    n_rows_in += 1
                    tier = 'sub' if (o.get('isSidechain') or is_sub_file) else 'agent'
                    cr = u.get('cache_read_input_tokens', 0) or 0
                    cc = u.get('cache_creation_input_tokens', 0) or 0
                    inp = u.get('input_tokens', 0) or 0
                    out = u.get('output_tokens', 0) or 0
                    mid = msg.get('id')
                    rows.append((mid, ts, msg.get('model', ''), tier, cr, cc, inp, out))
            if rows:
                n_files += 1
            # fold by message.id (last snapshot wins); id-less rows kept distinct, first-appearance order
            by_key, order = {}, []
            for i, rec in enumerate(rows):
                key = rec[0] if rec[0] else ('__noid__', i)
                if key not in by_key:
                    order.append(key)
                by_key[key] = rec
            for seq, key in enumerate(order):
                _, ts, model, tier, cr, cc, inp, out = by_key[key]
                w.writerow([ts, sess, seq, model, tier, cr, cc, inp, out])
                n_calls += 1
    return n_files, n_rows_in, n_calls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--logs', required=True)
    ap.add_argument('--out', default='apicalls-2026-6.csv')
    ap.add_argument('--salt', default='v2.1-plateau-r2')
    args = ap.parse_args()
    nf, nr, nc = wash(args.logs, args.out, args.salt)
    print(f"washed {nf} transcripts: {nr} usage rows -> {nc} folded API calls")
    print(f"wrote {args.out}")


if __name__ == '__main__':
    main()
