#!/usr/bin/env bash
# Session Watcher Stop-hook — thin client. Zero context injection: ALWAYS exit 0 + empty stdout.
# Session comes from stdin session_id (NOT env — env has no reliable session id). Latency-capped.
# v2.1 (user decision): POST-only. It advances the server-side gate/ledger and returns — NO system
# notification (no osascript/notify-send). The restart signal surfaces via statusline + dashboard.
# The response is intentionally ignored beyond the fire-and-forget POST.
set -euo pipefail
input="$(cat 2>/dev/null || true)"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -z "$sid" ] && exit 0
# round-7 GPT#6: WHITELIST the sid charset before using it in a filesystem path (stronger than the
# round-6 blacklist — a real session id is [A-Za-z0-9._-]; anything else, or empty, bails). round-8 GPT#2:
# also reject an INTERNAL `..` (e.g. `abc..def`) — the charset class alone allows dots, but `safeSessionId`
# on the server rejects any `..`, so without this the server writes `__invalid_session__.json` while the hook
# looks up `abc..def.json` → silent divergence. `*..*` matches the double-dot anywhere; the exact `.`/`..`
# arms stay for clarity. Both sides now agree on the same reject set.
case "$sid" in *[!A-Za-z0-9._-]*|''|.|..|*..*) exit 0 ;; esac
# Port-discovery file is ALWAYS under $HOME/.session-watcher (round-2 GPT#16 — NOT CLAUDE_PLUGIN_DATA;
# the server writes it there). State dirs (ledger/gate) may live under CLAUDE_PLUGIN_DATA, but this
# port file does not — the two must not diverge or the hook silently finds no server.
state="$HOME/.session-watcher/${sid}.json"
[ -f "$state" ] || exit 0
port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$state")"
[ -z "$port" ] && exit 0
# Fire-and-forget: advance the server-side gate/ledger. round-6 GPT#3a: POST the session_id so the server
# can reject a STALE/reused port that belongs to a DIFFERENT session (loopback bind blocks off-host, not a
# local cross-session port collision). Response ignored (no local notification). NOT auth — a stale-port
# guard, compatible with the RV-C6 no-token decision.
curl -s --max-time 0.2 -X POST \
  -H 'content-type: application/json' \
  --data "{\"session_id\":\"${sid}\"}" \
  "http://127.0.0.1:${port}/api/notify-gate" >/dev/null 2>&1 || true
exit 0
