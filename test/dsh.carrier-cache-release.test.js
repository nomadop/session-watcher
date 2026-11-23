// The release path of the carrier cache bundle, over the checkout `SW_DSH_CHECKOUT` names: the packages this working tree packs and the releases it follows, served by a loopback registry that is transport only (`test/helpers/dsh-release-registry.js`), installed and updated by the real pnpm through the plugin manager of a profile booted as the Harness boots one, the host's own RPC and the Loader's own import (`test/helpers/dsh-release-child.js`). No release tarball is kept in the repository and nothing is fetched from a public registry. The cases skip only without the checkout; with it, a missing prerequisite (the release commits, the built host, pnpm) fails the case.
import test from 'node:test';

import { releaseSkip, runReleaseScenario } from './helpers/dsh-release-registry.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const RELEASE = { skip: releaseSkip(CHECKOUT), timeout: 300_000 };

test('a profile that holds the packed host and no companion is offered the companion at the packed version and installs nothing before the owner confirms: the confirmation installs that registry identity, selects it and serves the route through the adapter the companion carries, the original row off with its provider configuration', RELEASE, (t) => {
  runReleaseScenario(t, 'fresh-settings', CHECKOUT);
});

test('a profile that holds the companion and no Session Watcher package resolves the replacement row from the companion in a process that has loaded neither, with the real host peers, and serves the route with the carrier marker', RELEASE, (t) => {
  runReleaseScenario(t, 'cold-start', CHECKOUT);
});

test('a profile started from the previous Session Watcher and companion releases updates the companion and then Session Watcher through the plugin manager\'s own update methods: the old host keeps its route after the first, the companion serves it alone while the new Session Watcher tarball is held back, and both updates apply with no restore, the selection and provider configuration kept', RELEASE, (t) => {
  runReleaseScenario(t, 'migration', CHECKOUT);
});
