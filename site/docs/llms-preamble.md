# Session Watcher

> A local monitor that estimates when carrying an existing agent context becomes more expensive than rebuilding it, for Claude Code and DeepSeek Harness (DSH).

Session Watcher provides restart-cost metrics and handoff tooling for long-running coding sessions, and shows the readings in a dashboard and a statusline under Claude Code and in a tab and a composer dock under DSH. It installs as a Claude Code plugin or as a DSH plugin.

Demo: `npx -y @nomadop/session-watcher demo`
