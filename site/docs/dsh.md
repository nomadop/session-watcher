# DSH Plugin

`@nomadop/session-watcher-dsh` runs Session Watcher inside DeepSeek Harness (DSH). The plugin loads into the DSH host process, watches the sessions of that host, and shows the readings in a tab and a composer dock of the DSH Web UI. The measurement, the store, the handoff and the turn history are the ones the Claude Code plugin uses. What is specific to DSH is the harness layer that reads DSH's session event log and the host wiring around it.

## Install

Add the package to a DSH profile:

```bash
dsh plugin --profile <name> add @nomadop/session-watcher-dsh
```

`<name>` is the profile you run; the tab appears in the Web UI, whose profile `dsh web` boots as `web`.

The package's bundle patch also mounts DSH's own `@deepseek-ai/dsh-tool-session-query`, which provides the `session_event_read` tool.

## What gets watched

Each session the host lists, creates or appends to gets its own watcher, subagent sessions included. A session the plugin first meets is read in full from the host's session log, then followed event by event. While that first read is in progress, the tools wait for it, and the tab and the dock show that the session is being read.

A session that is not running, because it has settled or has not run again since the host restarted, has no watcher until the tab, the dock or `watcher_status` first asks for it. The host then looks the session up among the sessions it has persisted and builds its watcher the same way, so an old session reads in the tab and the dock. A session the host has not persisted stays unobserved.

If a session's watcher fails, it stops measuring that session and keeps the diagnostic that made it fail. The tab, the dock and the tools report that diagnostic, and other sessions are not affected.

The plugin shares the store under `~/.session-watcher` with the Claude Code plugin: the archived segments, the Rate Lamp ledger, the handoffs and turn records, and the pricing overrides. A pricing override saved from the tab reprices at once every session of the host that runs that model.

The host measures a model call under the `name` its `llm` model catalog gives the call's provider and model id, and under the id where the catalog has none. The model-keyed state follows that name: a pricing override is saved and looked up under it, so one saved under an id has to be saved again under the name, and a name that lacks the model family prices under the defaults.

## The Session Watcher tab

The tab sits in the conversation view strip, labelled **Session Watcher**, and shows the session open in that conversation. It mounts the dashboard's own elements:

- the hero chart and its position verdict
- the depth bar
- the cycle and reminder bars
- the history chart and the history drawer
- the bucket panel, with the same keep/discard selection and position preview
- the pricing chip

The DSH Web UI provides the page chrome and the theme. The dashboard's chrome bar, theme chip and glossary are not mounted. The tab paints a light palette under a light host theme.

### Refresh

The tab refreshes from a change signal. The host sends a signal naming a session on an event stream whenever that session's watcher goes live, applies new events, fails or is removed, and after a pricing write changes its readings or a user override applies to it. A page holds one stream while it is visible. A signal makes that session's tab and dock pull the session's readings over the plugin's `/session-watcher` RPC channel. A stream that closes reopens after a growing wait, and a reopened stream makes every open session pull once. A failed pull is not retried; the next signal pulls again.

### The badge

The tab keeps its panel on screen under every state, with the elements at their idle paint while there is no reading. A badge in its top row names the state. The signal stream's state shows while it is not live; otherwise the badge shows the state of the last read.

| Badge | When |
|-------|------|
| `live` | The stream is open and the last read returned a reading |
| `connecting` | The page is opening the stream, or the browser is retrying one that dropped, which is how a stopped DSH host first shows |
| `disconnected` | The stream closed and the page waits to reopen it; the panel keeps its last reading |
| `reading` | The first read of the session has not finished |
| `unobserved` | The host has no watcher for the session and has not persisted it |
| `failed` | The session's watcher failed; the badge's hover text carries its diagnostic |
| `unreachable` | A read failed while the stream is open: it timed out, or the RPC channel rejected the call or answered with an error; the badge's hover text carries the message |

## The composer dock

The dock is a pill below the composer.

With a reading, the pill shows a lamp ring with the bill premium beside it. The ring's core is the lamp's zone and its arc the progress of the alert clock, the dock's label for the reminder bar's meter. An arrow names the arm the session is on, falling on the left arm, where the bill premium falls as the session goes on, and rising on the right arm, where it rises. A badge at the pill's corner counts the alert clock's laps once there is one. The bill premium printed on the pill is capped to keep the pill short; the pill's hover text and its accessible name carry the real figure, the arm, the clock and the lap count.

Without a reading, the pill is a white ring and one word: `Calibrating` while the lamp has not enough data, otherwise the state of the read: reading, unobserved, failed or unreachable.

Clicking the pill opens a popover above it. Its header names the lamp's zone. Below it, with a reading:

- the bill premium and the normalized position
- the position track, once there are landmarks to draw: the four zone bands lit up to where the session stands on the dashboard's axis, with the sweet spot marked
- the context stock, split into the rebuild baseline and the effective context above it, with the growth per call
- the alert clock, and under it the latest alert while the clock's laps have reached that alert's bill count

Without a reading, the popover holds one line: the state of the read, or that there is not enough data yet. Escape or a click outside closes it.

## Supported surface

The tab and the dock are supported on `dsh web`. Whether a page's `EventSource` reaches the host's events route in the DSH Desktop shell has not been verified.

## Tools

The agent gets the tool set tabled under MCP Tools on the [Guarantees page](https://nomadop.github.io/session-watcher/docs/guarantees/#mcp-tools), without `rotate_session`, which is Claude Code only. Each tool answers for the session of the agent that calls it, except that `watcher_status` can name another. On DSH, a turn address `S{k}:{T}` names a session and an event `seq`, and the turn tools' replies tell the agent to read that event with `session_event_read(session_id, seq)`.

## Skills

The package ships the `sw-handoff`, `sw-load` and `sw-explain` skills, the same files the Claude Code plugin ships, and registers them with the host.

## Handoff across sessions

When an agent starts or resumes, it receives a message listing the pending handoffs that other sessions prepared for its project. That message is the same text the Claude Code SessionStart hook shows. Subagents do not receive it. The message is not measured as a turn.

Both hosts store handoffs in the same place. If a lineage crosses from one host to the other, each host reads the other host's sessions in it as unverified turn records: the summary, the lineage headlines and the turn notes are all there, but those turns have no `S{k}:{T}` address and `turn_search` and `turn_locate` find nothing in them.

## Turn Notes

`get_turn_skeleton` puts the skeleton and the notes file under `session-watcher/turn-notes` in the system temp directory, which DSH's `workspace-write` file policy admits, so the agent writes the notes file with its own file tool without an approval. The Claude Code plugin keeps its Turn Notes under `~/.session-watcher`.

## Replaying a session log

`session-watcher replay <path>` plays back a DSH session log on the dashboard it plays a Claude Code transcript on: the host's `session.v4.jsonl.zstd` or a plaintext `session.v4.jsonl`.

```bash
npx -y @nomadop/session-watcher replay <path>
```

The command decides from the file's first line whether it is a DSH session log, so the same command takes either kind of file. It reads the file itself and needs neither a running DSH host nor the plugin.
