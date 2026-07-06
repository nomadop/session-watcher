#!/usr/bin/env bash
# Session Watcher statusline — thin client. Never blocks CC: always exit 0 with output.
# Parses stdin JSON with node (guaranteed installed), NOT jq — cross-platform.
set -uo pipefail
input=$(cat)

state_dir="${SW_STATE_DIR:-$HOME/.session-watcher}"
# Extract session_id and model.display_name from the CC stdin JSON via node.
read -r sid model <<EOF
$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j={};try{j=JSON.parse(s)}catch{};const sid=(j.session_id||"default");const m=(j.model&&(j.model.display_name||j.model.id))||"model";process.stdout.write(sid+" "+m)})' 2>/dev/null || echo "default model")
EOF

line=""
state_file="$state_dir/$sid.json"
if [ -f "$state_file" ]; then
  port=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).port||""))}catch{}})' < "$state_file" 2>/dev/null)
  if [ -n "$port" ]; then
    line=$(curl -sf --max-time 1 "http://127.0.0.1:$port/api/status?fmt=line" 2>/dev/null || echo "")
  fi
fi

if [ -n "$line" ]; then
  # Append the full dashboard URL so the human can reopen it after closing the tab. Must be a
  # complete http:// string — a bare :PORT is not clickable/selectable as a URL in a terminal.
  # Only when server is up (line non-empty ⟹ port valid); the off-branch has no meaningful port.
  printf '%s · http://127.0.0.1:%s\n' "$line" "$port"
else
  printf '[%s] session-watcher off\n' "$model"
fi
exit 0
