#!/usr/bin/env bash
# Session Watcher statusline — thin client. Never blocks CC: always exit 0 with output.
# Parses stdin JSON with node (guaranteed installed), NOT jq — cross-platform.
set -uo pipefail
input=$(cat)

state_dir="${SW_STATE_DIR:-$HOME/.session-watcher}"
# ONE node: parse stdin (sid+model), then read the port from the per-session state file itself.
# Emits tab-separated `sid<TAB>model<TAB>port` (port empty when no state file / no port). §4.4: single spawn.
# IFS=$'\t' — the ONLY separator is TAB, so a model display_name with spaces ("Claude Opus 4") stays whole
# and does not spill into $port (default IFS would split it → non-numeric port → false off-branch).
# sid is sanitized to [A-Za-z0-9._-] (matches safeSessionId) before the path.join → no `/`/`..` traversal.
IFS=$'\t' read -r sid model port <<EOF
$(printf '%s' "$input" | STATE_DIR="$state_dir" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j={};try{j=JSON.parse(s)}catch{}
  const raw=(j.session_id||"default");
  const sid=String(raw).replace(/[^A-Za-z0-9._-]/g,"_")||"default";
  // F9: model is the TAB field separator downstream — normalize any tab/CR/LF in the display_name to a
  // space so a pathological name cannot spill into the port field (sid is already path-sanitized; model
  // never touches a path, only the separator). Real model names never contain these; this is cheap defense.
  const m=String((j.model&&(j.model.display_name||j.model.id))||"model").replace(/[\t\r\n]/g," ");
  let port="";
  try{const fs=require("fs");const p=require("path").join(process.env.STATE_DIR,sid+".json");
      port=String(JSON.parse(fs.readFileSync(p,"utf8")).port||"");}catch{}
  process.stdout.write(sid+"\t"+m+"\t"+port);
})' 2>/dev/null || printf 'default\tmodel\t')
EOF

line=""
if [ -n "$port" ]; then
  line=$(curl -sf --max-time 1 "http://127.0.0.1:$port/api/status?fmt=line" 2>/dev/null || echo "")
fi

if [ -n "$line" ]; then
  printf '%s\n' "$line"
elif [ -z "$port" ]; then
  printf '[%s] no port file\n' "$model"
else
  printf '[%s] unreachable :%s\n' "$model" "$port"
fi
exit 0
