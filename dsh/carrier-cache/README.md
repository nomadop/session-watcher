# @nomadop/session-watcher-dsh-carrier-cache

The activation bundle of the carrier cache adapter of [`@nomadop/session-watcher-dsh`](https://www.npmjs.com/package/@nomadop/session-watcher-dsh), a DeepSeek Harness profile layer of two rows: the stock `llm-pi-ai` row turned off, and `@nomadop/session-watcher-dsh/pi-ai` mounted under its own id with no configuration of its own. The provider dictionary stays on the `llm-pi-ai` row.

It declares no dependency: the second row resolves to the Session Watcher package the profile has installed, so install `@nomadop/session-watcher-dsh` first; this bundle is versioned on its own. Session Watcher's Settings page installs and switches this bundle for the host's owner; the DSH plugin docs of Session Watcher describe it.
