<div align="center">

# Session Watcher

**LLM context economics, in your terminal.**

Session Watcher treats your prompt cache as *inventory* — it uses EOQ theory to measure whether the current context is still *worth carrying*, tracking restart pressure so you can decide when to hand off.

<img src="assets/dashboard.gif" alt="Session Watcher dashboard" width="820">

</div>

<p align="center">
  <a href="https://doi.org/10.5281/zenodo.21236704"><img src="https://zenodo.org/badge/DOI/10.5281/zenodo.21236704.svg" alt="DOI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="#install"><img src="https://img.shields.io/badge/platform-node.js%20%E2%89%A522.16-green.svg" alt="Platform: Node.js ≥22.16"></a>
</p>

<p align="center">
  <a href="https://nomadop.github.io/session-watcher/docs/"><strong>Documentation</strong></a> ·
  <a href="https://www.npmjs.com/package/@nomadop/session-watcher">npm</a> ·
  <a href="https://doi.org/10.5281/zenodo.21236704">Paper</a> ·
  <a href="llms.txt">llms.txt</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#install">Install</a> ·
  <a href="#dsh-plugin">DSH</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#context-buckets">Context Buckets</a> ·
  <a href="#handoff">Handoff</a> ·
  <a href="#mcp-tools">MCP Tools</a> ·
  <a href="#agent-support">Agents</a> ·
  <a href="#citation">Cite</a>
</p>

---

## What it does

Session Watcher reads your Claude Code transcript in real time and answers one question: **is this session still worth carrying?**

Most context tools optimize *how* you consume tokens — Headroom compresses, `/compact` shrinks, RTK filters. Session Watcher tracks *when* the cost curve is drifting, giving you the data to decide. They compose: run any pruning strategy you like, SW measures the cost curve so you can decide when to hand off.

SW reads from the transcript, never writes to it. The dashboard and statusline are pure observers; MCP tools return data for you to act on.

## How it works

```
Your coding agent (Claude Code)
        │  writes session transcript
        ▼
┌───────────────────────────────────────────────────────┐
│  Session Watcher (in-process MCP server)              │
│  ───────────────────────────────────────────────────  │
│  harness/claude-code  — read rows, emit observations  │
│  measurement/engine   — B (context belief), epochs    │
│  session-watcher      — apply frames, run operations  │
│  rate-lamp            — rent ledger + wallet clock    │
│  server.js            — Express + SSE dashboard       │
│  statusline           — one-line shell client         │
└───────────────────────────────────────────────────────┘
        │  dashboard  ·  statusline  ·  MCP
        ▼
   Your browser / terminal status bar
```

The harness layer is the only part that knows Claude Code: it reads transcript rows, decides the active branch, and emits normalized observations. Everything below it — measurement, dialogue history, handoff — consumes those observations and carries no transcript format, no row shape, and no tool name of any particular agent.

**Core model:** `L = cache_read_input_tokens` — the context stock you are renting. `B` is the rebuild baseline: the session's overhead floor plus the tokens of every file, skill and tool it has pulled in, which is what a restart would have to re-read. `g` is the growth no path accounts for, a smoothed `ΔtotalStock − ΔB`. `x = L / B` is the raw position ratio; the authoritative position is `u`, which every call advances by its own fraction of the restart interval that held while it ran, so the position records the path travelled rather than a ratio of today's numbers, and each landmark on the x axis is read off the reference skeleton fitted across that path. `br = mf × pp` is the bill premium — how much you are overpaying relative to ideal restart timing. The restart reminder is separate: it reads the rent the ledger has accumulated, so no revision of the position can withdraw one.

Lamp thresholds are the named constants `BR_AMBER` and `BR_RED` in `lib/bill-regret.js`: below the amber one the lamp is green, between them amber, at or above the red one red. See the [paper](#paper) for the full derivation — EOQ inventory theory mapped to LLM prompt caching.

## Quick Start

Requires Node.js ≥ 22.16.

```bash
# Try without installing — self-contained demo
npx -y @nomadop/session-watcher demo

# Replay your own transcript
npx -y @nomadop/session-watcher replay ~/.claude/projects/<project>/<session>.jsonl
```

Opens a browser dashboard. The demo uses a pre-built anonymized session; replay uses your real transcript. Both are read-only — nothing is modified or uploaded.

## Install

### Plugin (recommended)

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add nomadop/session-watcher

# 2. Install the plugin
claude plugin install session-watcher@session-watcher
```

Or from within a Claude Code session:
```
/plugin marketplace add nomadop/session-watcher
/plugin install session-watcher@session-watcher
/reload-plugins
```

This registers:
- **MCP tools** — available in every session
- **SessionStart hook** — points the running watcher at a new session and announces pending handoffs

If you installed or updated in an already-running session, run `/reload-plugins` to activate.

## DSH plugin

`@nomadop/session-watcher-dsh` runs Session Watcher inside DeepSeek Harness (DSH). It watches every running session of the host it loads into and shares `~/.session-watcher` with the Claude Code plugin.

```bash
dsh plugin --profile <name> add @nomadop/session-watcher-dsh
```

- **The Session Watcher tab** — a view in the conversation view strip that mounts the dashboard's elements for that session.
- **The composer dock** — a pill below the composer showing the lamp, the bill premium and the alert clock, with the position and the context stock in its popover.
- **Tools** — the [MCP tools](#mcp-tools), each answering for the calling agent's own session, except that `watcher_status` can name another.
- **Skills** — `sw-handoff`, `sw-load` and `sw-explain`, registered with the host.
- **Handoff across sessions** — an agent that starts or resumes gets a message listing the pending handoffs other sessions prepared for its project.
- **Replay** — `npx -y @nomadop/session-watcher replay <path>` plays a DSH session log back on the dashboard.

See the [DSH plugin docs](https://nomadop.github.io/session-watcher/docs/dsh/) for the profile to add it to, what the tab and the dock show, the surface they are supported on, and handoffs that cross between the two hosts.

## Statusline

The plugin system does not yet support declaring a statusline. Add to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "<plugin-install-path>/dist/statusline.js"
  }
}
```

Find your plugin path with:
```bash
find ~/.claude/plugins/cache -path '*/session-watcher/*/dist/statusline.js' -print
```

Or check via `claude plugin details session-watcher@session-watcher`.

**Note:** the plugin cache path changes on version update. After updating, re-run the command above and update your statusline path.

One compact line:

<img src="assets/statusline.png" alt="Statusline example" width="820">

## Context Buckets

The bucket panel shows exactly which files, skills, and tools are consuming your context budget. Each path carries a token count — check or uncheck to preview how the restart cost changes. The U-curve ghost line updates in real time as you toggle.

<img src="assets/preview_u.gif" alt="Context bucket selection preview" width="820">

## Handoff

When it's time to restart, handoff preserves the state you want to keep. Run `/sw-handoff` to prepare a package — selected paths, working summary, next task. Then `/clear`, and in the fresh session run `/sw-load` to restore. Only what you chose is rebuilt — less ramp-up, less waste.

<img src="assets/handoff.gif" alt="Handoff workflow" width="820">

## MCP Tools

Both plugins register the same tools, except for `rotate_session`, which only Claude Code registers. The [Guarantees page](https://nomadop.github.io/session-watcher/docs/guarantees/#mcp-tools) tables them once, with where the two hosts differ.

## Agent support

Session Watcher is agent-agnostic. Everything below the harness layer consumes normalized observations, so it never learns which agent produced the session.

| Agent | Driver | Status |
|-------|--------|--------|
| Claude Code | JSONL tail (native) | ✅ |
| DSH (DeepSeek Harness) | session event log (native) | harness ✅ · plugin ✅ |
| OpenCode | adapter-ready | pending |
| OpenClaw | adapter-ready | pending |
| Hermes | adapter-ready | pending |
| Aider | adapter-ready | pending |

Adding a new agent means writing a harness for it under `lib/harness/<agent>/`: a source driver that turns that agent's own session evidence into normalized observations, a thin measurement projection adapter over the shared [`lib/measurement-projection.js`](lib/measurement-projection.js) with the interpreters for the agent's native tools, the dialogue source and history turn rules that read its conversation, and the recovery sentences that tell a reader how to open a turn it cites. The engine, dialogue history, handoff, and every product surface are shared and need no change. See [`lib/harness/claude-code/`](lib/harness/claude-code/) for the reference harness and [`lib/harness/dsh/`](lib/harness/dsh/) for a second one. PRs welcome.

## Paper

> **Context Is Inventory: A Rent-or-Buy Model for Prompt-Cached LLM Sessions**
> Longju Cheng (2026) · DOI: [`10.5281/zenodo.21236704`](https://doi.org/10.5281/zenodo.21236704)

The paper derives the full theoretical specification: EOQ→LLM mapping, the 41.4% movable-cost bound, the ski-rental restart strategy, and measurements on 1,016 real session transcripts. Read it at the [DOI](https://doi.org/10.5281/zenodo.21236704) above.

## Uninstall

```bash
claude plugin uninstall session-watcher@session-watcher
# Remove state directory (optional):
rm -rf ~/.session-watcher
```

## Test

```bash
npm test              # unit + integration (node:test)
npx playwright test   # E2E (requires running server)
```

## Citation

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

## Privacy

- No remote telemetry.
- Transcripts are read locally and never uploaded.
- Local aggregate usage and handoff records are stored under `~/.session-watcher`.
- No transcript prose or file contents are stored in telemetry.
- Removing `~/.session-watcher` deletes all local state, except the Turn Notes a DSH session prepared and has not yet submitted successfully, which sit under the system temp directory.

## License

MIT
