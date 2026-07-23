#!/usr/bin/env bash
# Simulated statusline for replay recording.
# Usage: ./scripts/replay-statusline.sh [port]
# Polls /api/status?fmt=line every 500ms and overwrites in place.

PORT="${1:-38987}"
URL="http://127.0.0.1:${PORT}/api/status?fmt=line"

trap 'tput cnorm; printf "\n"; exit 0' INT TERM
tput civis  # hide cursor

PREV_LINES=0

while true; do
  line=$(curl -s "$URL" 2>/dev/null)
  if [ -n "$line" ]; then
    # Move up to overwrite previous output
    if [ "$PREV_LINES" -gt 0 ]; then
      printf "\033[%dA" "$PREV_LINES"
    fi
    # Clear from cursor to end of screen, then print
    printf "\033[J%s\n" "$line"
    # Count how many lines were printed
    PREV_LINES=$(echo "$line" | wc -l)
  fi
  sleep 0.5
done
