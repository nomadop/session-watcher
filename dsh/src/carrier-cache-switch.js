// dsh/src/carrier-cache-switch.js — the owner's switch of a companion bundle, which turns the original `llm-pi-ai` row off and mounts the opt-in pi-ai entry in its place (`pi-ai-index.js`): `LOCAL_CARRIER_BUNDLE` where the profile holds it, `OFFICIAL_CARRIER_BUNDLE` (`dsh/carrier-cache/`) otherwise.
// It acts through the plugin manager the profile mounts and reports what the running composition shows afterwards, never what the manager answered alone.
// It installs one package, once: the official bundle, when the manager's inventory lists neither bundle, the host was given an install target and the owner has confirmed. The identity is fixed here and the version by the target, which only a composition can give (`applyHost`), so no request names a package, a spec, a registry or a script to approve; a profile without the manager, with a damaged or doubled bundle, or without a target has no install. Nothing is ever uninstalled.
// It queues nothing and promises nothing about requests in flight: a request sent while the routes change goes to whichever adapter serves them at the moment it is dispatched, and no deduplication against another manager is promised either.
import { ORIGINAL_ROW, PI_AI_SERVICE } from './pi-ai-integration.js';

/** The profile's own activation of the pi-ai entry, a local package the owner installed beforehand, which the switch reuses where it is there. */
export const LOCAL_CARRIER_BUNDLE = '@local/sw-carrier-cache-web';

/**
 * The official companion bundle (`dsh/carrier-cache/`): the one package the switch may install, named here alone. Its version is its own, independent of the Session Watcher packages, and the install target the host gives names exactly the version of its `package.json`; the identity and the version are checked when the package is installed and not when one already installed is reused.
 */
export const OFFICIAL_CARRIER_BUNDLE = '@nomadop/session-watcher-dsh-carrier-cache';

/** Cordis's `FiberState.ACTIVE`, a cross-package const enum the host's own plugin inventory mirrors the same way. */
const FIBER_ACTIVE = 2;

/** The `reason` an unverified selection answers beside its rollback, by what the manager answered: a selection it applied that the running composition does not confirm, one it saved and left for a restart, or anything else it could not do. */
const REASONS = { applied: 'not-confirmed', 'restart-required': 'restart-required' };

const BUNDLES = [LOCAL_CARRIER_BUNDLE, OFFICIAL_CARRIER_BUNDLE];

const sameRoutes = (left, right) => left.length === right.length && left.every(route => right.includes(route));

/**
 * The switch's reads of the context, each made at the call that needs it, so a remount or an unmount is followed.
 * `native()` answers the original row as the Loader composes it, `{ disabled, mounted, routes }` with `routes` the profile dictionary's keys, or null where the Loader holds no readable row; `served()` the routes the llm registry holds an adapter for, null where the service is absent.
 * `installTarget()` answers what the host installs the official bundle from, `{ spec, version }` with `spec` the one package spec the plugin manager takes and `version` the exact version it must come out as, or null where the host has none: the composition hands it in (`applyHost`), the plugin face the official bundle's own, and a caller that passes none has no install.
 * @param {{ get: (name: string) => unknown }} ctx
 * @param {{ installTarget?: () => ({ spec: string, version: string }|null) }} [options]
 */
export function carrierCacheDepsOf(ctx, { installTarget = () => null } = {}) {
  return {
    installTarget,
    manager: () => ctx.get('pluginManager'),
    replacement: () => ctx.get(PI_AI_SERVICE),
    native() {
      let row;
      try {
        row = ctx.get('loader')?.resolve(ORIGINAL_ROW);
      } catch {
        return null;
      }
      if (row === undefined) return null;
      const providers = row.options?.config?.providers;
      return {
        disabled: row.disabled === true,
        mounted: row.fiber?.state === FIBER_ACTIVE,
        routes: providers !== null && typeof providers === 'object' ? Object.keys(providers) : [],
      };
    },
    served() {
      try {
        return ctx.llm.listProviders().map(provider => provider.id);
      } catch {
        return null;
      }
    },
  };
}

/**
 * The switch: `status()` answers `{ state, cause?, reason?, install?, busy? }` and `set(enabled, { confirmInstall })` answers `{ outcome, ... }`; neither throws.
 *
 * The bundle is the one of the two the manager's inventory lists; both listed (`conflict`), one it lists but cannot read (`damaged`) and an inventory it cannot read (`unreadable`) are `unavailable` with that `reason`, and nothing is installed over any of them. `state` is `not-installed` where neither is listed and the host holds an install target, with `install` the name and version it would install; with no target, or no manager (no `reason`), it is `unavailable`. It is `on` where the bundle is selected and the takeover is confirmed. `off` is the bundle not selected with the opt-in entry not mounted, so never a replacement that still serves; `pending` is every other reading: selected with no confirmed takeover (the entry failed, or the Loader's original row no longer matches what the entry registered), or not selected with the entry still mounted, a deselection that waits for a restart. `cause` is the entry's own failure where it names one.
 * The takeover is confirmed when the original row is off with no mounted fiber and the opt-in entry's own registration evidence (`PI_AI_SERVICE`, which stands only while its fiber does) reports no failure and a nonempty set of routes equal to the row's dictionary keys; `failure: null`, the directory and the fiber each stand without a registration.
 * `set(enabled)` takes one request at a time and answers `busy` to any other while one runs. Where neither bundle is listed, only a request to switch on with the literal `confirmInstall: true` installs: without it the answer is `install-confirmation-required` and nothing is touched. The install runs `installBundle(target.spec, { enabled: false, saveExact: true })` and nothing else: no registry, no `approvedBuilds`. It ends `install-failed` where it fails, whatever the manager's error was, and `install-unconfirmed` where the inventory, read again, does not list exactly the fixed name at the target's version, installed and not selected; a package that was installed stays installed, disabled. Otherwise it goes on as the selection below and its answer carries `installed: true`. Selecting the bundle is `enabled` once the manager reports it applied and the takeover is confirmed. Any other end is unverified, a manager that answers `restart-required` included, and the switch leaves no unchecked substitution for the next start: it deselects the bundle again and answers `reason` (`apply-failed`, `restart-required`, or `not-confirmed`, with the entry's failure `cause` where it names one) and what that rollback verified of the saved selection and of the running composition: `rolled-back` where the entry is withdrawn and the original adapter is proven mounted serving its routes, `withdrawn` where the entry is withdrawn and the original's restoration is not proven, `rollback-failed` where the saved selection is still on or the entry is still mounted.
 * Deselecting the bundle is `disabled` once it is saved off and the entry is withdrawn, with `native` `restored` where the original is proven serving again and `unconfirmed` where it is not, `restart-required` where the change is saved and waits for a restart (the entry keeps serving until then, so the status is `pending`), and `failed` otherwise.
 *
 * @param {{ manager: () => ({ listBundles: () => Promise<object[]>, setBundleEnabled: (name: string, enabled: boolean) => Promise<{ application: string }>,
 *     installBundle: (spec: string, options: { enabled: boolean, saveExact: boolean }) => Promise<{ application: string, error?: { code: string } }> }|undefined),
 *   installTarget?: () => ({ spec: string, version: string }|null),
 *   replacement: () => ({ failure: ({ cause: string }|null), routes?: () => string[] }|undefined),
 *   native: () => ({ disabled: boolean, mounted: boolean, routes: string[] }|null), served: () => (string[]|null) }} deps
 */
export function createCarrierCacheSwitch({ manager, replacement, native, served, installTarget = () => null }) {
  let busy = false;

  // What the plugin manager's inventory holds of the two bundles the switch knows: `ready` the one that is listed and readable, `missing` neither (the only reading an install may follow), and otherwise why the switch cannot act: no manager, an inventory it could not read, a listed bundle it cannot read, or both bundles at once.
  async function inventory() {
    const held = manager();
    if (held === undefined) return { kind: 'no-manager' };
    let found;
    try {
      found = (await held.listBundles()).filter(each => BUNDLES.includes(each.name));
    } catch {
      return { kind: 'unreadable' };
    }
    if (found.length === 0) return { kind: 'missing', manager: held };
    if (found.length > 1) return { kind: 'conflict' };
    const [bundle] = found;
    return bundle.availability === 'missing' || bundle.error !== undefined ? { kind: 'damaged' } : { kind: 'ready', manager: held, bundle };
  }

  function takeoverConfirmed() {
    const service = replacement();
    const row = native();
    const routes = service?.failure === null ? service.routes?.() : undefined;
    return Array.isArray(routes) && routes.length > 0 && row !== null && row.disabled && !row.mounted && sameRoutes(routes, row.routes);
  }

  // The original adapter is mounted under its own row and the registry holds an adapter for each route its dictionary names; the identity is the Loader row's, never what the route list suggests.
  function nativeRestored() {
    const row = native();
    const listed = served();
    return row !== null && !row.disabled && row.mounted && listed !== null && row.routes.every(route => listed.includes(route));
  }

  // The manager's own answer to one selection; a throw is the failure it ends as.
  async function select(held, name, enabled) {
    try {
      return (await held.setBundleEnabled(name, enabled)).application;
    } catch {
      return 'failed';
    }
  }

  // The saved selection, read again from the manager's own list.
  const savedOff = async (name) => {
    const found = await inventory();
    return found.kind === 'ready' && found.bundle.name === name && found.bundle.enabled === false;
  };

  // The rollback of a selection that did not end in a confirmed takeover: the selection undone, then the saved selection and the running composition read, whatever the manager answered.
  async function rollBack(held, name) {
    await select(held, name, false);
    if (!await savedOff(name) || replacement() !== undefined) return { outcome: 'rollback-failed' };
    return { outcome: nativeRestored() ? 'rolled-back' : 'withdrawn' };
  }

  async function enable(held, name) {
    const application = await select(held, name, true);
    if (application === 'applied' && takeoverConfirmed()) return { outcome: 'enabled' };
    const cause = replacement()?.failure?.cause;
    return { ...await rollBack(held, name), reason: REASONS[application] ?? 'apply-failed', ...(cause === undefined ? {} : { cause }) };
  }

  // The first install of the official bundle, disabled, through the manager. The manager's answer is not the proof: the package is accepted only when the inventory, read again, lists exactly the fixed name at the target's exact version, readable, not selected. Only then does the one selection that follows go through `enable`, with its own confirmation of the takeover and its own rollback; a package that stays installed after a failure stays disabled and is never removed here.
  // No spec but the target's, no registry, no `approvedBuilds`: a package script is never approved here, and the manager then fails the install and saves no dependency, so it ends as `install-failed`.
  async function installAndEnable(held, target) {
    let result;
    try {
      result = await held.installBundle(target.spec, { enabled: false, saveExact: true });
    } catch {
      return { outcome: 'install-failed' };
    }
    if (result.application === 'failed' || result.application === 'cancelled' || result.error !== undefined) {
      return { outcome: 'install-failed' };
    }
    const found = await inventory();
    const { bundle } = found;
    if (found.kind !== 'ready' || bundle.name !== OFFICIAL_CARRIER_BUNDLE || bundle.enabled !== false || bundle.version !== target.version) return { outcome: 'install-unconfirmed' };
    return { ...await enable(found.manager, OFFICIAL_CARRIER_BUNDLE), installed: true };
  }

  async function disable(held, name) {
    const application = await select(held, name, false);
    if (application === 'restart-required') return { outcome: 'restart-required' };
    if (application === 'applied' && await savedOff(name) && replacement() === undefined) return { outcome: 'disabled', native: nativeRestored() ? 'restored' : 'unconfirmed' };
    return { outcome: 'failed' };
  }

  return {
    async status() {
      const found = await inventory();
      const busyNow = busy ? { busy: true } : {};
      if (found.kind === 'missing') {
        const target = installTarget();
        return target === null ? { state: 'unavailable', ...busyNow } : { state: 'not-installed', install: { name: OFFICIAL_CARRIER_BUNDLE, version: target.version }, ...busyNow };
      }
      if (found.kind !== 'ready') return { state: 'unavailable', ...(found.kind === 'no-manager' ? {} : { reason: found.kind }), ...busyNow };
      if (found.bundle.enabled && takeoverConfirmed()) return { state: 'on', ...busyNow };
      if (!found.bundle.enabled && replacement() === undefined) return { state: 'off', ...busyNow };
      const cause = replacement()?.failure?.cause;
      return { state: 'pending', ...(cause === undefined ? {} : { cause }), ...busyNow };
    },
    async set(enabled, { confirmInstall = false } = {}) {
      if (busy) return { outcome: 'busy' };
      busy = true;
      try {
        const found = await inventory();
        if (found.kind === 'ready') return await (enabled ? enable(found.manager, found.bundle.name) : disable(found.manager, found.bundle.name));
        const target = found.kind === 'missing' && enabled ? installTarget() : null;
        if (target === null) return { outcome: 'unavailable' };
        // The only request that may install: it names no package, and it is answered with the need for the owner's own confirmation, the literal `true`, before anything is touched.
        if (confirmInstall !== true) return { outcome: 'install-confirmation-required' };
        return await installAndEnable(found.manager, target);
      } finally {
        busy = false;
      }
    },
  };
}
