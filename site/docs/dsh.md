# DSH Plugin

`@nomadop/session-watcher-dsh` runs Session Watcher inside DeepSeek Harness (DSH). The plugin loads into the DSH host process, watches the sessions of that host, and shows the readings in a tab and a composer dock of the DSH Web UI. The measurement, the store, the handoff and the turn history are the ones the Claude Code plugin uses. What is specific to DSH is the harness layer that reads DSH's session event log and the host wiring around it.

## Install

Add the package to a DSH profile:

```bash
dsh plugin --profile <name> add @nomadop/session-watcher-dsh
```

`<name>` is the profile you run; the tab appears in the Web UI, whose profile `dsh web` boots as `web`. The plugin needs DSH 0.2.2-rc.1 or later.

The plugin adds its own `sw_event_read` tool, which reads one event of a session in the caller's directory back as the verbatim text of its messages, tool calls and tool results, a message's reasoning blocks included as recorded, in their original position and without replay data, and for any other event type only its identity; the `before` and `after` neighbors are the raw events around it, each as a short semantic summary that leaves out reasoning blocks, except that a handoff payload and its file excerpts, an inner-seal carrier and a compaction checkpoint show their identity alone, and reading one of them as the target returns its body verbatim; no other tool bundle is needed for it, and DSH's Session search can be switched on or off freely. DSH's built-in optional `session_event_read`, which comes with that Session search, is the one that reads the raw event record in full, such as a system prompt, the dynamic tool set, a todo write, a turn end or another diagnostic payload.

## What gets watched

Each session the host lists, creates or appends to gets its own watcher, subagent sessions included. A session the plugin first meets is read in full from the host's session log, then followed event by event. While that first read is in progress, the tools wait for it, and the tab and the dock show that the session is being read.

A session that is not running, because it has settled or has not run again since the host restarted, has no watcher until the tab, the dock or `watcher_status` first asks for it. The host then looks the session up among the sessions it has persisted and builds its watcher the same way, so an old session reads in the tab and the dock. A session the host has not persisted stays unobserved.

If a session's watcher fails, it stops measuring that session and keeps the diagnostic that made it fail. The tab, the dock and the tools report that diagnostic, and other sessions are not affected.

The plugin shares the store under `~/.session-watcher` with the Claude Code plugin: the archived segments, the Rate Lamp ledger, the handoffs and turn records, and the pricing overrides. A pricing override saved from the tab reprices at once every session of the host that runs that model.

The host measures a model call under the `name` its `llm` model catalog gives the call's provider and model id, and under the id where the catalog has none. The model-keyed state follows that name: a pricing override is saved and looked up under it, so one saved under an id has to be saved again under the name, and a name that lacks the model family prices under the defaults.

## The Session Watcher tab

The tab sits in the conversation view strip, labelled **SW Meter**, and shows the session open in that conversation. It mounts the dashboard's own elements:

- the hero chart and its position verdict
- the depth bar
- the cycle and reminder bars
- the history chart and the history drawer
- the bucket panel, with the same keep/discard selection and position preview, and its file rows' drawer of the lines the session holds
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

The agent gets the tool set tabled under MCP Tools on the [Guarantees page](https://nomadop.github.io/session-watcher/docs/guarantees/#mcp-tools), without `rotate_session` and `load_handoff`, which are Claude Code only; a DSH agent receives a handoff through the commands below. Each tool answers for the session of the agent that calls it, except that `watcher_status` can name another session and `sw_event_read` another session of the caller's directory. On DSH, a turn address `S{k}:{T}` names a session and an event `seq`, and the turn tools' replies tell the agent to read that event with `sw_event_read(session_id, seq)`.

## Skills

The package ships the `sw-handoff` and `sw-explain` skills, the same files the Claude Code plugin ships, and registers them with the host. Loading a handoff is a command here, not a skill.

## Commands

The plugin registers the human commands below, typed in the Web composer.

`/sw-load [token]` loads a handoff into the session. With a token it loads that handoff. Choosing `/sw-load` from the slash menu, or pressing Enter on a bare `/sw-load` with no attachment, opens a picker instead: it lists the handoffs the project still retains, the undelivered group before the delivered one and each newest first, with the token, the age and the task, and its search matches the token or the task text. Selecting a row replaces the composer's draft with `/sw-load <token>` and loads nothing; the load runs when you submit that line. Enter on a bare `/sw-load` with an attachment is refused, and a bare `/sw-load` that still reaches the command, such as a command claim submitted with no arguments, loads the one handoff pending for the project, which is one that another session of the project prepared, nobody has delivered, and that falls in the recent candidate window; when several are pending it lists them, each with its token, age and task preview, loads none and waits for a run with one token. It runs only while the agent is idle.

The command does the loading itself: it delivers the handoff, which binds it to the session, records the load and renames the session after the handoff's next task, then shows the kept paths' text from the files on disk, in the shape of the host's `read` tool, and records each file it shows as read by the session so the model can edit it when the host maps the file's path and states its version; a file shown without that record needs a `read` before the model can edit it. The model gets two harness-owned messages, one holding the delivery's payload and, when any kept text was shown, one holding that text, and a follow-up that names any path skipped or not read to the end of its range, tells the model to take the payload as the task's established current state, to invoke the kept skills and to present that state, as the summary states it, for the user to confirm or correct before work resumes, and points to `turn_page` and `lineage_headlines` for a detail the payload leaves out. The model holds neither `load_handoff` nor a skill for this, so it cannot load a handoff for the user on a path where a typed line is not claimed as a command, such as ACP, a headless run or an SDK; the supported entry is the Web composer.

`/sw-continue` clears the session in place and resumes it from its newest handoff: after the clear it loads that handoff itself, as `/sw-load` does, and hands the model the result. The follow-up has the model continue the task from its next step in the same turn, where the follow-up of `/sw-load` has it present the loaded state for you to confirm first, and has the model ask any question, approval or permission the task left open and wait for you. Its behavior is stated under MCP Tools on the [Guarantees page](https://nomadop.github.io/session-watcher/docs/guarantees/#mcp-tools).

## Inner compaction (experimental)

Inner compaction is an experimental mode in which Session Watcher replaces the work a session has accumulated with a summary while the session runs. It is off unless you turn it on.

### Turning it on

A new session shows an **Enable compaction** switch among the options of the New Session view only while **Show compaction option** is on in Settings → Session Watcher, which it is not by default. Every independent new session starts with the switch off, and there is no default preference. Hiding the switch changes only whether it is shown: a mode already chosen stands, and the header mark and the monitor, the **SW Events** tab in the conversation view strip, are unaffected. The choice is open only until the session's first turn starts: after that the recorded mode stays locked, including when that first turn was rejected or cancelled. A started session that has the mode on shows a read-only **Enable compaction** mark in its header, hidden when the header is narrow, as the agent preset's label beside it is. Neither shows while the page's read of the mode fails; that hides the entries and does not by itself stop the host from sealing. A recorded mode that does not read as a mode shows neither entry, and that session seals nothing and writes a diagnostic.

Settings → Session Watcher holds the four settings of inner compaction. Each applies as soon as it is saved, with no restart: Save writes the staged changes, and Cancel, like leaving the page, drops them. Under Experimental, **Show compaction option** is the setting above. Under Compaction preferences, **Compaction policy** sets how readily a seal runs, from Most aggressive through Aggressive, Balanced (the default), Conservative and Most conservative. **Backup summary model**, none by default, is the model a content-filtered summary is last asked on, chosen among the models the host's providers offer, and **Subagents follow compaction choice**, off by default, decides whether a plain subagent is given its parent's mode.

A resumed session keeps the mode it recorded, and a session with no record stays off. A fork inherits the mode with the history it forks from. A plain subagent, one that is not a fork, is given its parent's mode as its own only while **Subagents follow compaction choice** is on, read as the subagent is created: with it off a plain subagent stays off, and no subagent already created changes. With it on, a parent whose mode is unknown or invalid leaves the subagent off and a diagnostic says so.

### What a seal does

With the mode on, once enough completed model steps have accumulated in the unsealed source, Session Watcher estimates before each main step what a seal would save, and the chosen **Compaction policy** decides whether a seal runs before that step: a more aggressive policy seals earlier and a more conservative one waits longer. The number of steps is fixed and cannot be configured; it only starts the estimate. A saved policy applies from the next estimate, and an estimate already under way, with the summary requests that follow it, keeps the policy it began with. A call to the session's current model selection summarizes the whole unsealed source, user and harness items outside any model step included, and the main step waits for it. A reply that is not the expected notes, whether text that finishes normally or a tool call, is asked again over the same request, a fixed small number of requests in all. A summary the provider's content filter cuts off is asked again on the session's model, then on the **Backup summary model** when one is set; with none set, no other model is used. Each request is its own attempt, from its dispatch until it commits, fails or is cancelled; the monitor lists every attempt, the failed ones beside the one that seals. A seal is held back while a `get_turn_skeleton` call, which starts a handoff, sits in the unsealed source with no handoff load after it; the call returning does not release it.

The seal replaces that source in the active context with one carrier message, written as a system reminder: a closing tag in its text is escaped, `<\/system-reminder>`. The carrier has up to three parts:

- One summary line for each model step or each item outside a model step, opening with the addresses of the events it replaces. Files attached to those events move into the carrier as their stored attachments; an image is saved as a file the model can open with `read_image`, behind a note that the image is no longer in the context. Beside the line of a step that asked the user with `ask_user_question`, the carrier holds each question the user answered, as the model wrote it, and the user's answer to it, the labels they selected and their own text, both whole and marked `question:` and `user:`, whether or not the summary retells them. The options and their descriptions are left out, and a question with no answer text, an error result or a call that cannot be read this way adds nothing.
- The files and skills the session held, entered as the changes against what the earlier carriers, and the kept file text a `/sw-load` showed that is still in the context, already carry. A file's held lines are its text on the disk as it stands at seal time. A skill's text is the result the session's log recorded for it, which no disk read changes. A held file the disk cannot give is carried as an unreadable entry with its reason and a hint to read it directly; that is a state of the file, not a failure of the seal.
- The session state at seal time, as a last block headed by the session seq it was read at: the working directory, the subagents that are running and the background jobs that are running, each with its label, and the todo list, each on a line of its own that names the tool which would show it (`working_directory`, `list_agents`, `job_list`, `todo_write`), then the git state of the working directory: the output of `git status --short --branch` and `git log -1 --oneline` on the lines under a line that names the two commands, the status lines past a fixed number replaced by one line saying how many are left. An item is read only when the session's tools include its tool; the git state needs none, and is left out where the working directory is no repository (a repository with no commit yet shows its status alone). An item that is empty and has never been shown is left out. Every other item is shown every time: an empty one reads `(empty)`; any other one is shown in full when it differs from the value the nearest earlier carrier still in the context showed for it, and otherwise marked unchanged since it was last shown. When no item is shown the block is left out. If an item cannot be read, the seal goes on without it and writes a diagnostic.

A seal does not summarize the earlier prefix again: the opening prefix of the session, its system prompt, the original task and the context the harness admitted before the first model request, and the earlier carriers stay as they were. A session that starts with `/sw-load`, and one cleared by `/sw-continue`, has the same kind of prefix: the load's payload, its read result and the follow-up are admitted before the first model request after the start or the clear, so they stay with the context the harness admitted there, and the first seal carries only the kept lines that differ from what the load showed. The events it replaces stay in the session log. The stock compaction of the session keeps its own configuration, and the seal runs before it, so it sees the sealed context.

A seal is not an outer compaction and does not extend the model's window. Its summary is not lossless, and the active context is not guaranteed to get shorter or to stay bounded.

### Re-reading lines the context holds

With the mode on, a `read` whose every returned line the session's context already holds, at the same line number and with the same text, is answered with an error saying so instead of the text. The read itself has run, so an edit of the file may follow it without another read. Lines a carrier left out of its body or withdrew, a line with the closing tag of a system reminder, which a carrier writes escaped, a file whose result DSH's own pruner has cut, and anything the check cannot establish let the read return its text as usual. A blocked read is recorded in the session log with its turn, step, call and lines, never the file text.

### The restart reminder under the mode

With the mode on, the restart reminder's budget counts only the calls the session's source keeps standing: the first calls of its context and the first call behind each seal. The calls since the last seal wait, since the next seal may replace them, and a seal rebuilds the budget from the calls that stand instead of adding to it, so the reminder does not run ahead of calls a seal has replaced. Until a seal has run the budget does not move, and while seals stop the budget stops with them. The position, the bill premium and the context stock read the whole path as they do without the mode.

### Recalling what a seal replaced

The model reads the addresses in the carrier with `sw_event_read`. The file handles in a carrier are stored attachments, those moved from the replaced events and the image files the seal saved, not a restoration of arbitrary earlier file contents; a saved image is read with `read_image`, and a held file's current content by reading the file itself. Whether the model notices a gap and reads is its own decision. A read of an event its context already holds whole, a carrier or a handoff payload of the open epoch, the read message and follow-up of that handoff's load, or a source a carrier of that epoch quotes word for word, is refused with an answer saying so, whatever window it asks for.

### When a seal fails

A summary call that fails, whose reply still is not the expected notes at the last request, or that the content filter cuts off again on the last model it is asked on, a thrown failure while reading held files or saving an attachment or image, a failure assembling the carrier, and a commit the seal or the session refuses each end the turn with an error. The mode does not change, no other failure is retried, and the next message tries again. A message the failed step had just claimed may not have been admitted to the history; send it again. If the failures persist, `/compact` is a manual way out while the agent is idle and compaction is mounted: when it finds a range to summarize and the summary, commit and flush succeed, the session continues from its checkpoint. A provider or storage outage can still stop it.

### Marking the last carrier for the provider's cache (opt-in)

An optional pi-ai adapter entry, `@nomadop/session-watcher-dsh/pi-ai`, adds one cache point at the end of the last carrier in each request, beside the points the adapter already writes. The official bundle package (below) ships the same adapter file as its own `/pi-ai` entry. The host entry never loads it, and a profile that does not mount it sends the requests it always did. The entry is the Harness's `llm-pi-ai` plugin, vendored with that one change (see `dsh/vendor/dsh-llm-pi-ai/UPSTREAM.md` in the repository), and it is a temporary replacement: it does not follow the installed Harness's own `llm-pi-ai` when that changes.

The point goes where the request's own serializer already places cache points, so a route that caches nothing gets none:

- Anthropic Messages (`cache_control` on the carrier's final content block), Bedrock Converse (a standalone `cachePoint` block after the carrier) and Chat Completions gateways whose profile states `compat.cacheControlFormat: anthropic` (`cache_control` on the final text part) take the lifetime of the route's own points.
- OpenAI Responses takes `prompt_cache_breakpoint: {mode: explicit}` on the carrier's final `input_text` block only while the owner's Responses breakpoint switch is on (see below), which it is not until chosen, and then whatever the route's model declares about `supportsExplicitPromptCacheMode`, an explicit `false` included. Only a request that gets the breakpoint is changed, and it is sent the cache options pi-ai writes for a route that declares the capability: on a route kept for long that request carries `prompt_cache_options: {ttl: 30m}` in place of the 24-hour `prompt_cache_retention`, while the route's other requests keep the retention. A request with no carrier, one whose carrier is its last input item and every request of a route whose profile turns caching off are sent as pi-ai writes them. With the switch off no Responses route gets a breakpoint, a catalog model that declares the capability and a profile's `compat.supportsExplicitPromptCacheMode: true` included, and the request is as pi-ai writes it. Only the `openai-responses` protocol is covered: Azure and Codex routes and a request under ChatGPT sign-in get none. An endpoint may reject a request that carries the breakpoint or those options.
- Routes of the DeepSeek adapters, any other protocol, a route with `cacheRetention: none` and an endpoint that is not stated to take the markers get no point and are sent as the adapter sends them.

A route's point limit counts the marker positions one request carries at once, not the cached token volume, the number of carriers or the calls added up over a session. Only the latest carrier takes the extra point, and the tools do not each take one: a route that marks its tools marks the last one. A request that is already full before the carrier point cannot take it; a request that only reaches its limit once the carrier point is added still takes it. The positions below are the native layouts of the pi-ai serializers checked when this was written, structural facts and not measured rates, and a newer serializer may lay its points out differently:

| Route | Native marker positions | With the carrier point |
| --- | --- | --- |
| Bedrock Converse, a Claude model that supports caching | the system prompt and the tail of the last user message | room for the carrier point |
| Anthropic Messages with an API key | the system prompt, the last tool when the model's capabilities allow `cache_control` on tools, and the message tail | the carrier point can be added, up to the limit |
| Anthropic Messages under OAuth sign-in | the identity prompt and the system instructions, each marked, the last tool and the message tail | with ordinary system instructions, cacheable tools and a message tail, the request is already full and the carrier point is not added |
| Chat Completions gateway of the Anthropic format | the system message, the last tool and the last conversation message | the carrier point can be added, up to the limit |
| OpenAI Responses with the switch on | the latest message's implicit breakpoint | room for the explicit carrier point |

A row holds while caching is on for the route, the route's protocol, the Responses switch and sign-in are ones the list above supports, the request has the system prompt, tools or tail the row names, and the carrier does not already end at the native tail marker. A request that lacks a position its row names has more room than the row says.

The adapter's own point already ends a carrier that is the request's last message, and that request is left alone. A request that is full before the carrier point, as the Anthropic OAuth row is, is sent with its original markers and without the extra point, and one warning names the route; the carrier optimization does not apply to that request. The limit is a request-shape limit: the entry does not claim to prevent every provider rejection. A message that opens with the carrier's opening text, the system reminder's opening and then the address sentence, is taken for a carrier whoever wrote it, which changes only where the marker sits.

The entry does not detect an expired cache, rewarm one or choose a lifetime, and no provider's reuse of the prefix, latency or cost has been measured with it: the request shapes are checked against loopback endpoints, not against a provider's cache.

To use it from this package, replace the adapter in a bundle's or the profile's patch layer; the profile has to hold this package, whose entry the row names. The Loader's `name` only asserts a row's package, so the original row stays, turned off, and the replacement is a new row under its own id with no configuration of its own:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  disabled: true
- insert:
    - id: llm-pi-ai-carrier-cache
      name: '@nomadop/session-watcher-dsh/pi-ai'
```

The provider dictionary stays where it is, under the `llm-pi-ai` row's `config.providers` in whichever layer sets it. The replacement reads that row as the Loader composes it, once, when it starts: an edit of the dictionary takes effect at the next start, not while the host runs, and the profile holds no second copy. The original row has to be off, and a `!!js` expression inside the dictionary is not evaluated for it, which makes the dictionary unusable to the replacement. The lifetime Session Watcher prices a route under is the one this dictionary declares for it.

When the replacement cannot use that row, it serves no route and Session Watcher's Settings page shows what happened, what it can cost and how to recover. The causes are that the Loader has no readable `llm-pi-ai` row, that the row is still on (the original adapter then serves its routes), and that its configuration is not a usable provider dictionary. With the replacement's routes unavailable, a session may find its route missing; where routing still works, turning on compaction can mean the earlier prompt cache is not reused after a compaction, which adds latency and cost, and no session content is lost. Check the `llm-pi-ai` configuration on the host and reload, or disable the replacement's bundle to restore the original routing. A replacement that does not mount at all, because its package cannot be loaded or its registration conflicts with the original's, reports nothing there: the Loader's log holds the error.

The Models page does not follow the row: its pi-ai editor and its hand-declared provider card are bound to the settings namespace `llm-pi-ai`, which is the turned-off original's, and the replacement has no settings entry to write. While the replacement is on, the editor's submit is unavailable for its routes and a hand-declared provider cannot be created there. Manage the routes in the `llm-pi-ai` row's `config.providers` in the patch layer and restart. Turning the original row on again and removing the replacement row returns to the stock adapter and the page.

#### Switching it from Settings

A profile with a plugin manager gets a switch on Session Watcher's Settings page, in a row only the owner of the host is shown. It acts on one of two bundles that hold the activation above and nothing else, the disabled `llm-pi-ai` row and the replacement row with no configuration: the official `@nomadop/session-watcher-dsh-carrier-cache`, packed beside this package from `dsh/carrier-cache/`, and a local `@local/sw-carrier-cache-web` that the owner installed. Whichever of them the manager lists, readable, is used as it is. Both at once, one the manager lists but cannot read and an inventory it cannot read leave the row unavailable, say which, and install nothing. The switch selects or deselects the bundle through the profile's plugin manager. The host decides who may use it, not the page: a call whose peer is not the owner is refused before the manager is read, and no request can name another bundle.

The official bundle carries the adapter itself and does not depend on the Session Watcher package: its replacement row names its own `@nomadop/session-watcher-dsh-carrier-cache/pi-ai`, so the profile needs no Session Watcher package for the route to be served, and the host packages the adapter imports are its peers, which the Harness provides. The carrier point itself needs the Session Watcher host entry: each time pi-ai serializes a request the adapter asks it what a carrier opens with, and a request made while no host is mounted, or one made while the host that is mounted does not answer, is sent without a point and without a warning; a host whose answer is no text, or that fails to answer, gets a warning. A bundle from before the adapter asked the host tells a carrier by a text of its own, which the carriers of a newer host do not open with, and a newer bundle asks an older host, which does not answer; either pair silently gives no carrier a point, and only once both are updated does a carrier get one, whichever is updated first. The adapter is the file this package ships as `/pi-ai`. The bundle is versioned on its own, apart from the Session Watcher packages, and a change of the adapter's file calls for a new version of the bundle. The local bundle's row, as in the recipe above, names this package's entry.

#### Installing the official bundle

Where the manager lists neither bundle, the row offers the install: switching on opens a confirmation naming the package and its version, and nothing is installed until the owner confirms it. The package is fixed in the host's code and its version is the exact one of the bundle's own package, which the plugin gives the host; the page cannot name a package, a spec or a registry, and a request that does not carry the owner's literal confirmation is answered with the need for it and changes nothing. The install is the plugin manager's own, with its pnpm, saved at that exact version and switched off, with no registry of its own and no package script approved by the switch.

The installed package is read back from the manager's inventory before anything selects it: it has to be the fixed name at that version, readable and not selected. It then goes through the selection, the takeover check and the rollback below like any other bundle. A step that fails after the install leaves the package installed and switched off, which the answer says; the switch never uninstalls anything. A package that comes out as another name or version is not selected either, and is likewise left where it is. The check against an external manager is the manager's own: if another one installs the same package between the switch's read and its install, the manager refuses the second install and the next request reuses what is there; no deduplication is promised beyond that.

The version binding is checked when the package is installed and not when one already installed is reused.

The row shows on only when the running composition confirms the takeover: the original `llm-pi-ai` row is off with no mounted fiber, and the replacement itself reports a nonempty set of routes the llm registry accepted from it, equal to the dictionary's. A manager that reports the change applied, a replacement that reports no failure, or a mounted fiber is not enough alone, and the check is made again at each reading, so an edit of the dictionary the replacement did not follow, or the original row switched on again beside it, ends the on. A selection that fails or is not confirmed is undone by deselecting the bundle, and the answer says what that rollback verified: the replacement withdrawn and the original adapter mounted serving every route of its dictionary (rolled back), the replacement withdrawn with the original's return to service not proven (withdrawn, restoration unconfirmed), or the rollback not finishing, the saved selection or the replacement still in place (rollback failed). A route a third adapter took when the original let it go is the withdrawn case, since the route list names the route but the original is not mounted.

A manager that reports the change waits for a restart is not a success either, and the switch does not leave it for the next start: the selection it saved is withdrawn and the answer names the restart as the reason. A profile without hot reload therefore cannot be switched on from Settings; select the bundle on the Plugins page and restart, and the row shows what that start confirmed.

Deselecting reports the original as restored only on the same proof as a rollback. Where the deselection is saved and waits for a restart, the replacement keeps serving the routes until then, so the answer says so and the row shows pending, not off. The row shows off only with the bundle not selected and the replacement not mounted, and pending for every other reading it cannot confirm, such as a selected bundle whose replacement failed to start.

One change runs at a time; a second request meanwhile is answered busy, and nothing is queued. Requests are not migrated and no promise is made about those in flight: one sent while the routes change goes to whichever adapter serves them when it is dispatched, and may be interrupted.

The OpenAI Responses breakpoint has a switch of its own under that row. It is a setting of Session Watcher, `carrierResponsesBreakpoint`, off until it is saved on, and the page writes it as it writes its other settings, so DSH decides who may, and the row is shown to the owner alone. It acts at once without Save and changes nothing else: it can be turned off on its own, and the carrier cache point stays as it is. It is usable only while the carrier cache point is on and confirmed; while the point is off, unavailable or not confirmed the control is held off and keeps showing the saved choice, which applies again when the point does. The page says that the endpoint may reject requests that carry the breakpoint or its cache options, and a route whose requests then fail is a reason to switch it off. The host hands the saved value to the replacement at each request, so a change reaches the next request without a restart; a replacement still mounted while the control is held off, as when a switch-off waits for a restart, goes on using the saved value until it leaves. A host that cannot give the replacement the value leaves the switch off for it.

#### Updating an installed bundle

An installed bundle is not updated with Session Watcher: update both on the Plugins page, and a carrier gets its cache point once both are updated, whichever is updated first; until then the requests are sent without a point and without a warning. One order is required for an official bundle at a version before it carried the adapter: its row names this package's `/pi-ai` entry, and under hot reload updating Session Watcher first can withdraw that entry, which leaves the route unavailable and stops the upgrade, so that bundle is updated first. After the bundle's update the row names the bundle's own package, and the Session Watcher update leaves the route as it is. Where the bundle was never installed, the Settings install offers the version this package names.

#### What the call drawer shows

The inner compaction monitor's call overview lists, for each summary request, what the replacement's wrapped payload hook did each time pi-ai serialized that request, in order, from the hook's own result: **Carrier cache point added** (the entry's point was added), **Native point at the same position reused** (the route's own point already ends the carrier), **Checked, none added** with its reason (no carrier in the request, the route writes no point of its own, the route's point limit is met, the Responses breakpoint switch is off, or the protocol or route is not supported), and **Not observed** where nothing was observed: the original adapter served the request, the replacement did not mount, or the record is from before the evidence existed. The list is bounded and counts what it leaves out. A request the seal asks again after a format failure or a content filter is its own request with its own list. The record holds these closed results and no request body, prompt or credential, and it claims nothing of the endpoint: not that a retransmission of an HTTP request reuses the serialized parameters, that the provider accepted the point, or that a later request hit the cache.

## Handoff across sessions

Both hosts store handoffs in the same place. If a lineage crosses from one host to the other, each host reads the other host's sessions in it as unverified turn records: the summary, the lineage headlines and the turn notes are all there, but those turns have no `S{k}:{T}` address and `turn_search` and `turn_locate` find nothing in them.

## Turn Notes

`get_turn_skeleton` puts the skeleton and the notes file under `session-watcher/turn-notes` in the system temp directory, which DSH's `workspace-write` file policy admits, so the agent writes the notes file with its own file tool without an approval. The Claude Code plugin keeps its Turn Notes under `~/.session-watcher`.

## Replaying a session log

`session-watcher replay <path>` plays back a DSH session log on the dashboard it plays a Claude Code transcript on: the host's `session.v4.jsonl.zstd` or a plaintext `session.v4.jsonl`.

```bash
npx -y @nomadop/session-watcher replay <path>
```

The command decides from the file's first line whether it is a DSH session log, so the same command takes either kind of file. It reads the file itself and needs neither a running DSH host nor the plugin.
