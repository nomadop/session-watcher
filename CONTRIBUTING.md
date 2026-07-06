# Contributing

## Code style

- JavaScript ES modules only (`import`/`export`), `"type": "module"`. Node ≥18 built-ins
  (`node:fs`, `node:http`, `node:path`, `node:os`, `node:child_process`) — prefer these
  over third-party where possible; `lib/` MUST stay dependency-free (only Node built-ins
  + sibling `lib/` imports) so it is testable with zero-dep `node:test`.
- No TypeScript, no build step. `public/index.html` is a single zero-build file.
- 2-space indent; concise. Comments explain WHY (a hidden invariant, a verified-against-real-data
  decision), not WHAT.

## Testing (TDD is mandatory)

- Tests use `node:test` + `node:assert/strict`.
- `lib/` split (extract/metrics/baseline/watcher) is deliberate: each unit has its own
  test cycle. `server.js`/`index.js` stay single-file.
- Pure functions (`lib/metrics.js`, `lib/baseline.js`) are tested directly; stateful
  pieces (`SessionWatcher`, server) get integration tests with tmp JSONL fixtures.

## Domain vocabulary

Use consistent naming across code, tests, and API:

`L`, `Lstar`, `LstarFit`, `Lcap`, `Lthreshold`, `kAvg`, `kFitSlope`,
`kStable`, `paybackP`, `phi`, `rho`, `timingWeight`, `sweetP`, `regret`,
`etaCalls`, `metricsReliable`, `restartReason`, `calibratingReason`,
`baseline{dead,task,total,source,confidence,kneeTurn}`.

## Hard invariants

- **Never hardcode environment values** (L_base≈42k, k≈940, warmup≈6 rounds). These are
  computed live; empirical anchors are for TEST fixtures ONLY.
- **Zero context pollution**: MCP tools return only `{url}`/status shapes — NEVER
  metric numbers. Both frontends read `/api/status`; nothing re-enters the model.
- **Sidecar pattern**: all state lives in the long-running `server.js`; MCP + both
  frontends are stateless leaves.
- **Three-operator discipline**: `k_avg` drives authoritative L*, `Σg` drives P/φ,
  `k_fit` is extrapolation-only.
- Field access to JSONL goes through `extractUsage` only (single isolation layer).
- **Dedup PRIMARY key = `message.id` folding**, NOT top-level `uuid`.
- **L-drop AFTER message.id snapshot folding** — a late low-cacheRead snapshot must not
  fake a segment boundary.

For the full domain model (g≡ΔL, L_base two-layer design, metricsReliable probe,
restart gating, etc.), see [`docs/domain-model.md`](docs/domain-model.md).
