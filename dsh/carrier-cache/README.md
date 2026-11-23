# @nomadop/session-watcher-dsh-carrier-cache

The carrier cache adapter of [`@nomadop/session-watcher-dsh`](https://www.npmjs.com/package/@nomadop/session-watcher-dsh) for a DeepSeek Harness profile, with the profile layer that activates it: the stock `llm-pi-ai` row turned off, and the adapter mounted under its own id with no configuration of its own. The adapter is this package's `./pi-ai` export, the file Session Watcher ships under the same export. The provider dictionary stays on the `llm-pi-ai` row.

It depends on no package and needs no Session Watcher package for the route to be served. The host packages its adapter imports are peer dependencies, which the Harness provides; Session Watcher's Settings page, where it is installed, shows and switches the bundle for the host's owner, and its DSH plugin docs describe both. This bundle is versioned on its own: an installed copy from before it carried the adapter is updated on the Plugins page before Session Watcher is.
