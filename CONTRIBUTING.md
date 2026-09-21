# Contributing

## Code style

- JavaScript ES modules only (`import`/`export`), `"type": "module"`. Prefer the Node built-ins
  (`node:fs`, `node:http`, `node:path`, `node:os`, `node:child_process`, `node:sqlite`) over a
  third-party package, at the runtime `package.json`'s `engines` field pins.
- What a `lib/` module may import — the default, and the exceptions named against it — is stated once,
  in `.serena/memories/conventions.md`. Read the rule there; do not infer it from a neighbouring file.
- No TypeScript. The dashboard is un-built: `public/dashboard.html` loads `app.js` as a native ES
  module, with `lib/` and `elements/` beside it and Chart.js from a CDN. `public/index.html` is a
  separate self-contained landing page. Shipping does have a build — `npm run build` bundles into
  `dist/`, which is committed with its source change.
- 2-space indent; concise. Comments explain WHY (a hidden invariant, a verified-against-real-data
  decision), not WHAT. `.serena/memories/conventions.md` also carries the resolvable form a comment or
  test title must cite in.

## Testing (TDD is mandatory)

- Tests use `node:test` + `node:assert/strict`; `npm test` runs the suite and reports the count.
- A suite is named after the module or Interface it drives, so search for that name rather than
  consulting a list here. Pure functions are tested directly; stateful pieces — the application
  `SessionWatcher`, the server, the store — get integration tests over temporary fixtures.
- `server.js` and `index.js` stay single-file.
- Browser cases run under Playwright (`npm run e2e`) and need a browser binary installed.

## Domain vocabulary

`CONTEXT.md` is the glossary, and it is the only one. Use its terms in code, tests and API shapes, and add a
term there before spending it in prose rather than coining one here — a list copied into this file would drift
away from the definitions the moment either side moved. The v1/v2 statistical vocabulary those terms replaced
is retired; `.serena/memories/domain_model.md` keeps it as history and marks it so.

## Hard invariants

- **Never hardcode environment values.** The context floor, the growth rate and the warm-up length are
  computed live; empirical anchors belong to test fixtures only.
- **Zero context pollution**: MCP tools return status and data shapes, never metric numbers, and
  nothing a tool returns re-enters the model as a measurement.
- **Sidecar pattern** (the name `.serena/memories/core.md` uses for it): measurement state lives in the process
  that owns the transcript, and the MCP face, the dashboard and the statusline are stateless readers of it.
- **The harness is the only layer that knows the agent.** Native rows, content blocks, byte cursors and
  branch topology stop inside `lib/harness/claude-code/`; everything below consumes normalized
  observations and names no transcript format.
- **A native usage field is read in exactly one place** — `normalizeClaudeCodeUsage`, module-private to
  the observation reducer. No other layer reaches a raw usage field.
- **The dedup key is the message id, not the row uuid**, and an accepted revision folds into the step it
  revises rather than becoming a new one.
- **Only explicit source topology creates an epoch.** A drop in reported token totals never does.

For the domain model read `CONTEXT.md`; for the measurement stack,
`.serena/memories/v3_measurement.md`.
