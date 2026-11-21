# dsh-llm-pi-ai, vendored

A temporary copy of the bootstrap of the DeepSeek Harness plugin `@deepseek-ai/dsh-llm-pi-ai`, so the opt-in entry `src/pi-ai-index.js` can wrap each route's pi-ai provider before the public `PiAiAdapter` builds its snapshot. The Harness exposes no hook for that. The entry hands the bootstrap the configuration it validates from the original row's composed options (`Config`, then `resolveProfiles` for the scalar checks the bootstrap makes), so the copy's own volatile `providers` and its settings write path serve no plugin configuration here.

## Source

- Repository `deepseek-harness`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`, package version `0.2.2-rc.1`, path `packages/llm/llm-pi-ai/src/`.
- License: MIT, `LICENSE` here is the repository's copy. The package ships `dist/` only, so the `pi-ai-index.js` build step in `scripts/build.js` carries this file's text into `dsh/dist/pi-ai-index.js`.
- Local tests ran against the checkout's installed `@earendil-works/pi-ai` `1.3.0`, its pnpm-patched build, and that checkout's built libraries; the vendored `provider-data.generated.ts` is the snapshot that commit generated for that SDK.

## Scope

Copied under `src/` with upstream's names: `auth.ts`, `catalog.ts`, `config.ts`, `discovery.ts`, `index.ts`, `login.ts`, `models.ts`, `provider.ts`, `provider-data.ts`, `provider-data.generated.ts`, `types.ts`. These are the modules the plugin's bootstrap, profile resolution, credential bridge, directory, discovery and sign-in flows need and the package does not export.

Not copied: `adapter.ts`, `context.ts`, `replay.ts` and `stream.ts`. The request path is the installed package's public `PiAiAdapter`, so conversion, replay and streaming are the Harness's own.

## Local deltas

Each delta is a place where `src/` differs from the commit above; nothing else differs.

- `src/index.ts`, the entry's identity: `PiAiAdapter` is imported from `@deepseek-ai/dsh-llm-pi-ai` and its two re-exports are dropped; `name` is `llm-pi-ai-carrier-cache`; `apply(ctx, config)` is `bootstrap(ctx, config, decorateProfiles)`, which passes each resolved profile map through `decorateProfiles` once, where it is memoized by the raw snapshot, so the adapter's snapshot identity stays stable.
- `src/catalog.ts`, `src/config.ts`, the compat gate: the `openai-responses` compat gate offers `supportsExplicitPromptCacheMode`, which the shared Responses gate withholds, and the profile schema carries the field. The Azure and Codex protocols keep the withheld gate. The carrier cache point does not need the declaration: while the owner's Responses breakpoint switch is on, `lib/llm-adapter/carrier-point.js` writes the breakpoint and the options that go with it into the payload of a request that gets one, whatever the route declares, and while it is off no breakpoint is written, a declaring route keeping the request pi-ai writes for such a route. The delta stays so a profile that already declares the field keeps loading, and the tests' declaring routes (`test/helpers/dsh-pi-ai-child.js`, which take the serializer's own options for a declaring route as the oracle of the breakpoint's companion options) need it; it can go once no profile declares the field and those tests take their oracle from a catalog model that declares it natively.
- `src/index.ts`, the registration evidence: `bootstrap` answers `{ registeredRoutes() }`, the routes the registry accepted for the adapter as of its last registration or swap that returned, `[]` while the plugin is dormant. It has one reader, `dsh/src/pi-ai-index.js`, which offers it as `PI_AI_SERVICE.routes` (`dsh/src/pi-ai-integration.js`), the evidence `dsh/src/carrier-cache-switch.js` confirms a takeover from. Retiring the delta needs another source for that member, with the same meaning, in the entry that replaces this copy.

## Updating

Copy the files again from the new commit, re-apply each local delta above, and run `test/dsh.pi-ai-carrier-cache.test.js` with `SW_DSH_CHECKOUT` set to that checkout. A change to `PiAiAdapterOptions` or to what `resolveProfiles` returns is what breaks the bootstrap.

## Removing

Delete this directory, `dsh/src/pi-ai-index.js`, the `PI_AI_SERVICE` side of `dsh/src/pi-ai-integration.js`, `dsh/src/carrier-cache.js`, the host's read of `PI_AI_SERVICE` and its `pi-ai/status` endpoint, the Settings page's failure notice, the `./pi-ai` export and the optional peers it added in `dsh/package.json`, and the `pi-ai-index.js` build step in `scripts/build.js`. The carrier cache switch (`dsh/src/carrier-cache-switch.js`, its `carrier-cache/*` endpoints and the Settings row) takes the original adapter's routes over for this entry, so it goes with it. A profile that mounted the entry turns the original `llm-pi-ai` row on again first.

Kept: the carrier point writers (`lib/llm-adapter/`, which import no SW, DSH or pi-ai module), the per-request carrier evidence (`dsh/src/carrier-evidence.js`, `CARRIER_EVIDENCE_SERVICE` and the call record's `carrierCache` field in `lib/inner-seal/call-record.js` with the drawer's row) and the Responses breakpoint setting (the `carrierResponsesBreakpoint` field of the plugin's Config, its Settings row and `CARRIER_SETTINGS_SERVICE`). A replacement entry has to call the writer on the request-sending path, ask `CARRIER_SETTINGS_SERVICE` for the Responses switch at each request, and report each result through `CARRIER_EVIDENCE_SERVICE` inside the summary request's scope; one that never asks sends no Responses breakpoint.
