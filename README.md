# Session Watcher

Most tools tell you how many tokens you spent. **Session Watcher tells you whether the current context is still worth carrying** — it computes the EOQ-optimal restart line `L*` from your Claude Code transcripts and shows it in a browser dashboard and a statusline. Nothing it computes ever re-enters the model's context.

## Paper

> **An Inventory-Theoretic Model of Prompt-Caching Economics**
> arXiv: *forthcoming*

See [`paper/paper.pdf`](paper/paper.pdf) for the full derivation of the EOQ→LLM mapping, the 41.4% movable-cost bound, the ski-rental restart strategy, and empirical validation on 1,016 real sessions.

## Install

### MCP (Claude Code)

```json
{
  "mcpServers": {
    "session-watcher": { "command": "node", "args": ["<path>/index.js"] }
  }
}
```

Then call the `start_watcher` tool — it opens a localhost dashboard and returns its URL.

### Auto-launch hook

Add to `~/.claude/settings.json`:

```json
{
  "hooks": { "SessionStart": [{ "command": "<path>/hooks/session-start.js" }] }
}
```

The watcher starts automatically with every Claude Code session.

### Standalone (no MCP)

```bash
node server.js --project ~/.claude/projects/<project> --ratio 50 --open
```

### Statusline

```json
{ "statusLine": { "type": "command", "command": "<path>/statusline.sh" } }
```

## Core model

`L = cache_read_input_tokens` (context stock). `g ≡ ΔL` (differenced stock, provider-independent). `L* = L_base + 2·√(2·C_RATIO·L_base·k_avg)`. Restart when `L ≥ min(L*, L_cap)`.

## Test

```bash
npm test                 # unit + integration (node:test)
npx playwright test      # E2E
```

## License

MIT
