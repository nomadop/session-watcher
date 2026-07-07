# Session Watcher

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21236704.svg)](https://doi.org/10.5281/zenodo.21236704)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Most tools tell you how many tokens you spent. **Session Watcher tells you whether the current context is still worth carrying** — it computes the EOQ-optimal restart line `L*` from your Claude Code transcripts and shows it in a browser dashboard and a statusline. Nothing it computes ever re-enters the model's context.

> **Status: work in progress.** The paper describes the full theoretical specification. This README documents what the current code actually implements. See [§ Gap from paper](#gap-from-paper) below.

## Paper

> **Context Is Inventory: A Rent-or-Buy Model for Prompt-Cached LLM Sessions**
> Longju Cheng (2026)
> DOI: [`10.5281/zenodo.21236704`](https://doi.org/10.5281/zenodo.21236704)

See [`paper/paper.pdf`](paper/paper.pdf) for the full derivation of the EOQ→LLM mapping, the 41.4% movable-cost bound, the ski-rental restart strategy, and preliminary measurements on 1,016 real session transcripts (single operator, in-sample).

## What's implemented

| Feature | Status |
|---------|--------|
| JSONL transcript tailing with message-ID folding | done |
| Miss denoising (structural criteria) | done |
| Knee detection with Schmitt-trigger latching | done |
| Fold-jump detection and baseline re-latching | done |
| EOQ exit line `L*` and per-turn cost multiple `φ` | done |
| Web dashboard (Chart.js, SSE) | done |
| Statusline widget (bash + curl) | done |
| Zero-pollution invariant (MCP guard) | done |

## MCP tools

| Tool | Description |
|------|-------------|
| `start_watcher` | Start (or reuse) the Session Watcher dashboard server; returns its URL |
| `stop_watcher` | Stop the managed Session Watcher server |
| `watcher_status` | Report whether the server is running and its URL |

All three tools are read-only (`readOnlyHint: true`) — they never return metric values or session content into the model's context.

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

## Gap from paper

The paper (§6) describes the full model specification; the current release implements a working subset. These features are specified but not yet shipped:

| Feature | Paper ref | Current state |
|---------|-----------|---------------|
| Billing gauge `billProgress = u²` | §3.7 (billing-gauge remark), §6.1 | not yet implemented — dashboard currently shows a linear `L/L*` bar |
| TTL-aware `Reff` auto-adjustment | `Reff` identity §4.2.3, §6.1 | not yet implemented — uses static per-family ratios (see below) |
| Wall position `x_wall = 1 + Reff` | §3.7 (two scaling laws), §6.1 | not yet implemented |
| Ski-rental policy recommendation engine | §3.5–3.6, §6.2 | not yet implemented — specified but the operational loop has not been tested end-to-end |

**Ratio table note:** The current release uses simplified per-family static ratios:

| Model family | Code `C_RATIO` | Paper value |
|-------------|----------------|-------------|
| Claude (Anthropic) | 10 | 12.5 (5-min TTL) / 20 (1-hr TTL) |
| DeepSeek (all tiers) | 50 | 50 (Flash) / 120 (Pro) |

The per-tier distinction (Flash vs. Pro) and automatic TTL-aware adjustment are pending implementation. If you need accurate tier-specific ratios today, pass `--ratio` explicitly on the CLI or set `ratioOverride` via the MCP tool.

## Core model

`L = cache_read_input_tokens` (context stock). `g ≡ ΔL` (differenced stock, provider-independent). `L* = L_base + 2·√(2·C_RATIO·L_base·k_avg)`. Restart when `L ≥ min(L*, L_cap)`.

## Citation

The DOI resolves to the preprint; cite the paper:

```bibtex
@unpublished{cheng2026context,
  author = {Longju Cheng},
  title  = {Context Is Inventory: A Rent-or-Buy Model for Prompt-Cached LLM Sessions},
  year   = 2026,
  doi    = {10.5281/zenodo.21236704},
  url    = {https://doi.org/10.5281/zenodo.21236704},
  note   = {Preprint}
}
```

## Test

```bash
npm test                 # unit + integration (node:test)
npx playwright test      # E2E
```

## License

MIT
