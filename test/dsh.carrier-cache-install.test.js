// The first install of the carrier cache bundle from Settings, over the checkout `SW_DSH_CHECKOUT` names: the owner's switch on the real Loader, plugin manager and Connection of an isolated profile, whose package manager is pnpm run offline over tarballs `pnpm pack` made of this repository's packages, so nothing is downloaded and nothing is published (`test/helpers/dsh-pi-ai-child.js`, `test/helpers/dsh-pi-ai-fixture.js`). Without the checkout or without pnpm every case skips.
import test from 'node:test';

import { runShippedScenario, shippedEntrySkip } from './helpers/dsh-shipped-entry.js';
import { pnpmSkip } from './helpers/dsh-pi-ai-fixture.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SHIPPED = { skip: shippedEntrySkip(CHECKOUT) || pnpmSkip(), timeout: 240_000 };
const CHILD = { child: 'dsh-pi-ai-child.js', timeout: 240_000 };

test('a bundle installed nowhere with an install source is offered and never installed unasked: the status names the package and version, every request short of the literal confirmation is answered with the need for it and leaves the manager untouched and the profile as it was, no request can name what to install, and without an install source the switch is as unavailable as before', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-gate', CHECKOUT, CHILD);
});

test('a confirmed first install over the isolated profile and offline pnpm installs the packed official bundle disabled with no registry and no script approval, reads its identity back, selects it and shows the replacement serving the route from the bundle\'s own package with no Session Watcher package in the profile, the package holding two rows and no configuration; switching off keeps it installed and the next switching on installs nothing', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-flow', CHECKOUT, CHILD);
});

test('the local bundle and the official one are each reused as they are whatever the install source: with one installed the switch selects it, installs nothing and asks for no confirmation, an official bundle at another version than the install source names included', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-reuse', CHECKOUT, CHILD);
});

test('nothing is installed over what is not a missing bundle: both bundles, either one with its files gone, a selection with no package and an inventory that cannot be read each leave the switch unavailable with the reason, and a confirmed request reaches neither the install nor the selection', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-refuses', CHECKOUT, CHILD);
});

test('a first install that does not end in a confirmed package selects nothing: the manager\'s failure and a throw install nothing, a package with a script is never approved or run and fails the install, and a package of another name or another version is kept disabled and not accepted', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-failures', CHECKOUT, CHILD);
});

test('a selection that fails after the install is the switch\'s own rollback over a package that stays installed, disabled and kept: the answer says it was installed, tells a withdrawn replacement from an original proven serving, and names a restart the manager asked for', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-enable-failures', CHECKOUT, CHILD);
});

test('one change runs at a time over the install as well: a second confirmed request meanwhile is answered busy and reaches no manager, and the guard is released afterwards', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-guard', CHECKOUT, CHILD);
});

test('the install is the owner\'s alone: a guest peer or none, with the confirmation, reaches neither the install nor the selection, a request with no session cookie never reaches the handler, and the owner\'s peer installs', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-auth', CHECKOUT, CHILD);
});

test('an external manager that installs the package between the switch\'s read and its install is not deduplicated against: the manager refuses the second install, the answer is a failed install, nothing is selected and the profile holds one package, which the next request reuses', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-race', CHECKOUT, CHILD);
});

test('the installed official bundle carries the adapter its replacement row names: the profile holds no Session Watcher package and no copy of a host package, the bundle depends on nothing and asks the host for the packages its entry imports, and the row\'s specifier resolves from the bundle, from the profile as the Loader anchors it and from the profile\'s runtime table to the bundle\'s own file, which is the pi-ai plugin and serves the route', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-resolution', CHECKOUT, CHILD);
});

test('the isolated profile cannot download: the registry spec of the official package, the source a publication would give, fails without reaching anything and is answered as a failed install over an unchanged profile', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-install-offline', CHECKOUT, CHILD);
});
