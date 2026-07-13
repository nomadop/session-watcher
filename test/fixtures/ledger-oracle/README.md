# Ledger oracle fixtures — the v2.2-C SAFETY NET (spec §10.2 C0)

These JSON files **freeze the CURRENT (v2.1) behavior** of `settleBatchAtBoundary` (meter oracle) and
`resolveStopMessage` (alert oracle). They are the C-layer safety net: every later C sub-batch
(C1-2 `settleMeterAtBoundary` split, C2 edge-settle, C3 pending, C4 bounded advance) must reproduce them
**byte-for-byte**, proving it only *regrouped* behavior and never *changed* it.

## ★ A failing `test/rate-lamp.oracle.test.js` means a BEHAVIOR CHANGE — investigate, do NOT regenerate ★

The committed test (`test/rate-lamp.oracle.test.js`) is **READ-ONLY**. It loads these fixtures and asserts
equality; it **NEVER regenerates them**. If it goes red:

1. A later sub-batch changed settlement or alert behavior. **Find and understand the change.**
2. If the change is a BUG → fix the code so the fixtures pass again.
3. If the change is *intended* → that is a deliberate re-baseline of v2.1 behavior, which is **not** what
   any C sub-batch does. Do **NOT** run `generate.js` to paint the test green. Re-baselining requires an
   explicit, human-reviewed decision (and a commit that says so), never a reflex `generate` to silence a
   failing safety-net test.

## Two-step oracle pattern (C0a generate-once / C0b read-only — E6)

- **C0a — `generate.js` (generate ONCE):** run `node test/fixtures/ledger-oracle/generate.js` a single
  time against the current code. It drives the REAL `applyFoldedCallSample → settleBatchAtBoundary →
  resolveStopMessage → recordStopEvent` (via `oracle-driver.js`) and writes each `*.json` fixture. Every
  captured number is a real current output — **nothing is hand-computed.** Human-review the diff (sanity-
  check the numbers make sense), then commit. This is the ONLY thing that writes these files.
- **C0b — `test/rate-lamp.oracle.test.js` (read-only):** loads each fixture and asserts the current code
  still reproduces it. It shares the exact `oracle-driver.js` the generator used, so a divergence can only
  mean the LIB behavior changed.

## Files

- `oracle-driver.js` — shared harness (imported by both generator and test; **not** a `*.test.js`, so
  `node --test` never runs it standalone). Drives the real pure functions; computes nothing itself.
- `generate.js` — C0a generate-once script. Never imported by the test.
- `single-turn.json` — two calls, one turn, no crossing (matches the brief's shown inline test).
- `three-turn.json` — one poll spanning **3 turns, each a DIFFERENT deltaW**, each crossing at least once
  (a non_idle_burn / empty_burn / non_idle_burn mix). The brief's second shown test reads this one.
- `pre-flush-stale.json` — burn happened but the boundary settles against a stale L_read (deltaL 0).
- `poll-first.json` — normal poll integrates several calls, then one boundary settle.
- `stop-first.json` — a boundary fires before anything is pending (bill null), then a later boundary bills.
- `persist-before-commit.json` — the ALERT oracle: each boundary also runs `resolveStopMessage` +
  `recordStopEvent`. Exercises every kind (wall / empty_burn / dw_backstop / non_idle_burn / cache_unstable
  / gate / null) and freezes the exact `lastStopEvent` the Stop route persists synchronously — including
  that a `statusline_pulse` resolution is NOT persisted (`recordStopEvent` no-ops on non-stop_hook).
- `v2-hydrate.json` — a previously-persisted **v2** ledger (`KEY.schemaVersion:2`), stored as a real
  `final` state. The test hydrates it back through `validateLedgerState` (round-trips clean) and, per
  **H-C**, asserts that stamping the SAME ledger `schemaVersion:1` degrades to `null` → fresh. **There is
  deliberately NO `v1-ledger.json` and NO migration/`.bak`** — a stale v1 disk ledger is a per-session
  transient that re-calibrates a short span, so it is dropped, not migrated.

## Fixture shape

Each meter fixture is `{ script, captures, meter, bills, alerts, stopEvents }`:
- `script` — ordered steps: `{ sample: [seq, burnRate, L_read, turnSeq] }` or
  `{ boundary: {L_readNow,kStable,inDeepWater,foldedSeqNow,turnSeqNow}, resolve?: {...} }`.
- `captures` — per boundary: `[billCycleCount, currentTurnDeltaW, bill?.kind ?? null]` (the intermediate
  per-turn summary the spec §10.2 C0 requires — asserted for EVERY ended turn, not just the final ledger).
- `meter` — per boundary: `{billProgress, billCycleCount, currentTurnDeltaW, billAnchorLRead}`.
- `bills` — per boundary: the `settleBatchAtBoundary` bill (`{kind,delivery,billCount,deltaL}`) or `null`.
- `alerts` / `stopEvents` — per boundary (alert fixture only): the `resolveStopMessage` result and the
  persisted `lastStopEvent` (or `null`).

`v2-hydrate.json` is `{ script, persisted }` (the reproducible final ledger).
