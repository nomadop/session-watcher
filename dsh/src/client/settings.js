// dsh/src/client/settings.js — the Session Watcher category of DSH's Settings: the DSH adapter that binds the compaction settings form to the host's configuration mirror and model catalog, the new-session switch's visibility, the failure of the opt-in pi-ai entry the host reports, the owner's carrier cache switch with the Responses breakpoint switch under it, and the page the category shows.
// The form's logic is `public/lib/compactionSettings.js`; this module supplies its capabilities from DSH services and renders its snapshot, and keeps no setting of its own.
import React from 'react';
import { createSettingsDraft, PRESET_IDS } from '../../../public/lib/compactionSettings.js';
import { NS } from './locales.js';
import { Switch } from './switch.js';

const h = React.createElement;

/** The settings namespace of the plugin: the id of its entry in the profile, the `id` of its row in the bundle patch, which the configuration mirror serves its Config under. */
export const SETTINGS_ENTRY = 'session-watcher';

/**
 * The form over the services of `child`, the context that injects `configForms`, `remote` and `remote.session`: reads and writes go through the host's configuration mirror (`configForms`), the backup model's choices through the host's model catalog.
 * The catalog is read again when an adapter or a settings document changes and the draft is dropped when the connection begins again, as DSH's own settings pages do.
 */
export function bindSettingsForm(child) {
  const entry = child.configForms.get(SETTINGS_ENTRY);
  const settings = {
    read() {
      const { status, value, revision, writable } = entry.getSnapshot();
      return { status, values: value, revision, writable };
    },
    subscribe: listener => entry.subscribe(listener),
    write: (changes, revision) => entry.mutate(Object.entries(changes).map(([field, value]) => ({ op: 'set', path: [field], value })), revision),
  };
  const models = {
    async list() {
      const reply = await child.remote.session.modelCatalog();
      if (!reply.ok) throw new Error('the model catalog could not be read');
      return { groups: reply.value.groups, failures: reply.value.failures };
    },
  };
  const form = createSettingsDraft({ settings, models });
  child.effect(() => child.remote.$on('llm/adapters-updated', () => { form.invalidateModels(); }));
  child.effect(() => child.remote.$on('settings/document-updated', () => { form.invalidateModels(); }));
  child.effect(() => child.on('connection/reset', () => { form.reset(); }));
  child.effect(() => () => { form.dispose(); });
  return form;
}

/**
 * Whether the new-session compaction switch is shown, as a store of one boolean over the host's configuration mirror: true once the mirror holds the setting on, false before it holds any and wherever it is unavailable.
 * `bind(child)` follows the mirror from the context that injects `configForms` and answers to that context's disposal.
 */
export function createOptionVisibility() {
  let shown = false;
  const listeners = new Set();
  const publish = (next) => {
    if (next === shown) return;
    shown = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bind(child) {
      const entry = child.configForms.get(SETTINGS_ENTRY);
      const follow = () => { const { status, value } = entry.getSnapshot(); publish(status === 'ready' && value?.showCompactionOption === true); };
      follow();
      child.effect(() => {
        const stop = entry.subscribe(follow);
        return () => { stop(); publish(false); };
      });
    },
  };
}

/**
 * The opt-in pi-ai entry's failure as the host reports it, as a store of `{ failure }`, `failure` null or the `{ cause }` the entry gives for serving no route: null until the host has answered `pi-ai/status`, which names no session.
 * `load()` asks again; a refusal or a transport failure leaves what the store held, and an answer that changes nothing notifies nobody.
 *
 * @param {{ call: (endpoint: string, payload: object) => Promise<object> }} options
 */
export function createIntegrationStatus({ call }) {
  let snapshot = { failure: null };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async load() {
      let reply;
      try {
        reply = await call('pi-ai/status', {});
      } catch {
        return;
      }
      if (reply?.ok !== true) return;
      const failure = reply.value?.failure ?? null;
      if (failure?.cause === snapshot.failure?.cause) return;
      snapshot = { failure };
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * The owner's switch of the carrier cache bundle as the host reports it, as a store of `{ state, cause?, reason?, install?, confirming?, busy, outcome }`.
 * `state` is `loading` until the host has answered `carrier-cache/status`, then what it answers (`unavailable`, `not-installed`, `off`, `on` or `pending`, `cause` the opt-in entry's own failure beside `pending`), and `hidden` where the host answers `forbidden`, which says the caller is not its owner: a presentation only, since the host decides who may change anything.
 * `load()` asks again; a refusal or a transport failure leaves what the store held. `set(enabled)` asks the host for the change with a body naming the state alone, never a target, keeps `busy` true until the host has answered and the status is read again, and ignores a second request meanwhile; its `outcome` is the host's answer, or `{ outcome: 'failed' }` where none came.
 * Where the host reports `not-installed` (`install` the package and version it would install, `reason` beside `unavailable` why the switch cannot act), switching on asks the host nothing: it opens the owner's confirmation (`confirming`), which `cancelInstall()` closes and `confirmInstall()` answers with the one request that carries `confirmInstall: true`. A confirmation nobody opened sends nothing, and one does not outlive the `not-installed` reading it was opened for.
 *
 * @param {{ call: (endpoint: string, payload: object) => Promise<object> }} options
 */
export function createCarrierCacheStore({ call }) {
  let snapshot = { state: 'loading', busy: false, outcome: null };
  const listeners = new Set();
  const publish = (next) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  // The host's answer to `endpoint`, or undefined where none came.
  const ask = async (endpoint, payload) => {
    try {
      return await call(endpoint, payload);
    } catch {
      return undefined;
    }
  };
  const forbidden = reply => reply?.ok === false && reply.error?.code === 'forbidden';
  async function load() {
    const reply = await ask('carrier-cache/status', {});
    if (forbidden(reply)) {
      publish({ state: 'hidden', busy: false, outcome: null });
    } else if (reply?.ok === true) {
      const { state, cause, reason, install } = reply.value;
      publish({
        state, ...(cause === undefined ? {} : { cause }), ...(reason === undefined ? {} : { reason }), ...(install === undefined ? {} : { install }),
        ...(state === 'not-installed' && snapshot.confirming === true ? { confirming: true } : {}), busy: snapshot.busy, outcome: snapshot.outcome,
      });
    }
  }
  // One change asked of the host; the confirmation it may have been asked under ends with it.
  async function change(body) {
    publish({ ...snapshot, busy: true, outcome: null });
    const reply = await ask('carrier-cache/set', body);
    if (forbidden(reply)) {
      publish({ state: 'hidden', busy: false, outcome: null });
      return;
    }
    const outcome = reply?.ok === true ? reply.value : { outcome: 'failed' };
    await load();
    const { confirming, ...settled } = snapshot;
    publish({ ...settled, busy: false, outcome });
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    async set(enabled) {
      if (snapshot.busy) return;
      if (enabled && snapshot.state === 'not-installed') {
        publish({ ...snapshot, confirming: true, outcome: null });
        return;
      }
      await change({ enabled });
    },
    cancelInstall() {
      if (snapshot.busy || snapshot.confirming !== true) return;
      const { confirming, ...closed } = snapshot;
      publish(closed);
    },
    async confirmInstall() {
      if (snapshot.busy || snapshot.confirming !== true) return;
      await change({ enabled: true, confirmInstall: true });
    },
  };
}

/** The field of the plugin's Config, in the configuration mirror, that holds the owner's Responses breakpoint switch; the host reads it at each request (`CARRIER_EVIDENCE_SERVICE`). */
const RESPONSES_FIELD = 'carrierResponsesBreakpoint';

/**
 * The owner's Responses breakpoint switch as a store of `{ status, on, writable, saving, failed }` over the configuration mirror `entry` the plugin's Config is served under: `on` is what the mirror holds, off while it holds none, and the mirror is the one authority of whether a change landed.
 * `set(on)` writes the one field at once, never waiting for the form's Save, and rewrites nothing else; it does nothing while the mirror is not ready or not writable or another change runs, a refusal or a transport failure leaves what the mirror holds and sets `failed` until the next change.
 * The write is the mirror's own, so DSH decides who may make it, as it does for every other setting of the page.
 *
 * @param {{ entry: { getSnapshot: Function, subscribe: Function, set: (field: string, value: unknown) => Promise<boolean> } }} options
 */
export function createResponsesBreakpointStore({ entry }) {
  let saving = false;
  let failed = false;
  const listeners = new Set();
  let snapshot = null;
  const read = () => {
    const { status, value, writable } = entry.getSnapshot();
    return { status, on: value?.[RESPONSES_FIELD] === true, writable, saving, failed };
  };
  const changed = () => { for (const listener of [...listeners]) listener(); };
  return {
    // The same object while nothing it shows has changed.
    getSnapshot() {
      const next = read();
      if (snapshot === null || JSON.stringify(next) !== JSON.stringify(snapshot)) snapshot = next;
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      const stop = entry.subscribe(listener);
      return () => { listeners.delete(listener); stop(); };
    },
    async set(on) {
      const { status, writable } = entry.getSnapshot();
      if (saving || status !== 'ready' || !writable) return;
      saving = true;
      failed = false;
      changed();
      try {
        failed = (await entry.set(RESPONSES_FIELD, on)) !== true;
      } catch {
        failed = true;
      }
      saving = false;
      changed();
    },
  };
}

// The store's or the form's latest snapshot, read again after each change it announces.
function useSnapshot(form) {
  const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
  React.useEffect(() => {
    setSnapshot(form.getSnapshot());
    return form.subscribe(() => { setSnapshot(form.getSnapshot()); });
  }, [form]);
  return snapshot;
}

// The failure of the opt-in pi-ai entry in words: what is wrong, what it can cost and how to recover, and nothing when there is no failure.
function IntegrationFailure({ failure, t }) {
  if (failure === null) return null;
  return h('div', { className: 'sw-set-note sw-set-error sw-set-integration', role: 'alert', 'data-sw-integration': '' },
    h('strong', null, t('settings.integration.title')),
    h('p', null, t(`settings.integration.cause.${failure.cause}`)),
    h('p', null, t('settings.integration.consequence')),
    h('p', null, t('settings.integration.recovery')));
}

// What the host's answer to a change is told as: the key under `settings.carrier.outcome`, a deselection naming whether the original adapter is proven serving again and a switching on that installed the bundle first saying so.
const outcomeKey = ({ outcome, native, installed }) => {
  if (outcome === 'disabled') return `disabled-${native}`;
  return outcome === 'enabled' && installed === true ? 'installed-enabled' : outcome;
};

// The carrier cache switch's row: the owner's control of the companion bundle, which a first switching on installs after the owner's confirmation, nothing while the host has not answered or says the caller is not its owner. The control shows `on` only for the state the host confirmed, and a reading the host does not confirm in either direction is a pending state, worded as such, never an on.
// Under it the Responses breakpoint switch, which acts only while the carrier cache point is on and confirmed: otherwise it is held off with its saved choice shown, and its note says the endpoint may refuse a request that carries the breakpoint.
function CarrierCacheRow({ carrier, responses, id, t }) {
  const { state, cause, reason, install, confirming, busy, outcome } = useSnapshot(carrier);
  const breakpoint = useSnapshot(responses);
  React.useEffect(() => { void carrier.load(); }, [carrier]);
  if (state === 'loading' || state === 'hidden') return null;
  const notes = [
    state === 'unavailable' ? h('p', { key: 'unavailable', className: 'sw-set-note', role: 'status' }, t(reason === undefined ? 'settings.carrier.unavailable' : `settings.carrier.unavailable.${reason}`)) : null,
    state === 'not-installed' ? h('p', { key: 'not-installed', className: 'sw-set-note', role: 'status' }, t('settings.carrier.notInstalled', install)) : null,
    state === 'not-installed' && confirming === true
      ? h('div', { key: 'install', className: 'sw-set-note sw-set-integration', role: 'alertdialog', 'aria-label': t('settings.carrier.install.accept'), 'data-sw-carrier-install': '' },
        h('p', null, t('settings.carrier.install.confirm', install)),
        busy ? h('p', { role: 'status' }, t('settings.carrier.install.running')) : null,
        h('button', { type: 'button', className: 'sw-set-button', disabled: busy, 'data-sw-carrier-install-accept': '', onClick: () => { void carrier.confirmInstall(); } }, t('settings.carrier.install.accept')),
        h('button', { type: 'button', className: 'sw-set-button', disabled: busy, 'data-sw-carrier-install-cancel': '', onClick: () => { carrier.cancelInstall(); } }, t('settings.carrier.install.cancel')))
      : null,
    state === 'pending'
      ? h('p', { key: 'pending', className: 'sw-set-note sw-set-error', role: 'status' }, t('settings.carrier.pending'), cause === undefined ? null : ` ${t(`settings.integration.cause.${cause}`)}`)
      : null,
    h('p', { key: 'caveat', className: 'sw-set-note' }, t('settings.carrier.caveat')),
    outcome === null ? null : h('p', { key: 'outcome', className: 'sw-set-note', role: 'status', 'data-sw-carrier-outcome': outcome.outcome },
      t(`settings.carrier.outcome.${outcomeKey(outcome)}`), outcome.reason === 'restart-required' ? ` ${t('settings.carrier.reason.restart-required')}` : null, outcome.cause === undefined ? null : ` ${t(`settings.integration.cause.${outcome.cause}`)}`,
      outcome.installed === true && outcome.outcome !== 'enabled' ? ` ${t('settings.carrier.installedNote')}` : null),
  ];
  return h('div', { 'data-sw-carrier': '' },
    h('h3', { className: 'sw-set-group' }, t('settings.group.cache')),
    h(Row, { id: `${id}-carrier`, title: t('settings.carrier.title'), description: t('settings.carrier.description'), notes },
      h(Switch, { checked: state === 'on', label: t('settings.carrier.title'), disabled: busy || state === 'unavailable', onChange: (next) => { void carrier.set(next); } })),
    h(Row, {
      id: `${id}-carrier-responses`, title: t('settings.carrier.responses.title'), description: t('settings.carrier.responses.description'),
      notes: [
        h('p', { key: 'warning', className: 'sw-set-note' }, t('settings.carrier.responses.warning')),
        state === 'on' ? null : h('p', { key: 'held', className: 'sw-set-note', role: 'status' }, t('settings.carrier.responses.held')),
        breakpoint.failed ? h('p', { key: 'failed', className: 'sw-set-note sw-set-error', role: 'status' }, t('settings.carrier.responses.failed')) : null,
      ],
    },
    h(Switch, {
      checked: breakpoint.on, label: t('settings.carrier.responses.title'),
      disabled: state !== 'on' || busy || breakpoint.status !== 'ready' || !breakpoint.writable || breakpoint.saving,
      onChange: (next) => { void responses.set(next); },
    })));
}

const NOTICE_TEXT = { loading: 'settings.loading', unavailable: 'settings.unavailable' };

// One setting's row: its name and sentence on the left, its control on the right, wrapping under them where the page is narrow.
function Row({ id, title, description, notes, children }) {
  return h('div', { className: 'sw-set-row', role: 'group', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-text` },
    h('div', { className: 'sw-set-text' },
      h('div', { className: 'sw-set-title', id: `${id}-title` }, title),
      h('div', { className: 'sw-set-desc', id: `${id}-text` }, description),
      ...notes),
    h('div', { className: 'sw-set-control' }, children));
}

// The backup model's dropdown: none, the catalog's models by provider, and the saved route the catalog does not list, kept as the value it is.
function BackupModelSelect({ id, labelledBy, snapshot, form, t }) {
  const { choices, values } = snapshot;
  const selected = values.summaryFallbackModel;
  const byKey = new Map([...choices.groups.flatMap(group => group.models), ...(choices.saved === null ? [] : [choices.saved])].map(choice => [choice.key, choice]));
  const value = selected === null ? '' : [...byKey.values()].find(choice => choice.provider === selected.provider && choice.model === selected.model)?.key ?? '';
  const onChange = (event) => {
    const choice = byKey.get(event.target.value);
    form.set('summaryFallbackModel', choice === undefined ? null : { provider: choice.provider, model: choice.model });
  };
  return h('select', { id, className: 'sw-set-select', value, disabled: !snapshot.writable || snapshot.saving, onChange, 'aria-labelledby': labelledBy, 'data-sw-backup-model': '' },
    h('option', { value: '' }, t('settings.backup.none')),
    ...choices.groups.map(group => h('optgroup', { key: group.id, label: group.name },
      ...group.models.map(model => h('option', { key: model.key, value: model.key }, model.name)))),
    choices.saved === null ? null : h('option', { key: choices.saved.key, value: choices.saved.key },
      `${choices.saved.model} · ${choices.saved.provider}${choices.saved.unavailable ? ` (${t('settings.backup.unavailableTag')})` : ''}`));
}

/**
 * The category's page: two groups of ordinary controls over the form's draft and a cancel and save area, rendered from the form's snapshot alone, under the failure of the opt-in pi-ai entry when the host reports one (`createIntegrationStatus`), which opening the page asks for again, and the owner's carrier cache switch (`createCarrierCacheStore`) with the Responses breakpoint switch under it (`createResponsesBreakpointStore`), rows of their own that act at once and never wait for Save.
 * Leaving the page drops the unsaved draft; nothing is written before Save.
 */
export function CompactionSettings({ form, integration, carrier, responses, t }) {
  const snapshot = useSnapshot(form);
  const { failure } = useSnapshot(integration);
  const id = React.useId();
  React.useEffect(() => {
    void form.loadModels();
    return () => { form.cancel(); };
  }, [form]);
  React.useEffect(() => { void integration.load(); }, [integration]);
  const heading = h('h2', { className: 'sw-set-heading' }, t('settings.title'));
  if (snapshot.status !== 'ready') {
    return h('section', { className: 'sw-set' }, heading, h(IntegrationFailure, { failure, t }), h('p', { className: 'sw-set-note', role: 'status' }, t(NOTICE_TEXT[snapshot.status])), h(CarrierCacheRow, { carrier, responses, id, t }));
  }
  const { values, catalog, choices } = snapshot;
  const locked = !snapshot.writable || snapshot.saving;
  const toggle = (field, title) => h(Switch, { checked: values[field], label: title, disabled: locked, onChange: next => { form.set(field, next); } });
  const modelNotes = [
    catalog.status === 'loading' ? h('p', { key: 'loading', className: 'sw-set-note', role: 'status' }, t('settings.backup.loading')) : null,
    catalog.status === 'error'
      ? h('p', { key: 'error', className: 'sw-set-note sw-set-error', role: 'alert' }, t('settings.backup.loadFailed'),
        h('button', { type: 'button', className: 'sw-set-link', disabled: snapshot.saving, onClick: () => { void form.loadModels(); } }, t('settings.backup.retry')))
      : null,
    catalog.partial.length > 0 ? h('p', { key: 'partial', className: 'sw-set-note', role: 'status' }, t('settings.backup.partial', { providers: catalog.partial.join(', ') })) : null,
    choices.saved?.unavailable ? h('p', { key: 'gone', className: 'sw-set-note sw-set-error', role: 'status' }, t('settings.backup.unavailable')) : null,
  ];
  return h('section', { className: 'sw-set', 'data-sw-settings': '' },
    heading,
    h(IntegrationFailure, { failure, t }),
    snapshot.writable ? null : h('p', { className: 'sw-set-note', role: 'status' }, t('settings.readOnly')),
    h('h3', { className: 'sw-set-group' }, t('settings.group.experimental')),
    h(Row, { id: `${id}-show`, title: t('settings.show.title'), description: t('settings.show.description'), notes: [] }, toggle('showCompactionOption', t('settings.show.title'))),
    h('h3', { className: 'sw-set-group' }, t('settings.group.preferences')),
    h(Row, { id: `${id}-policy`, title: t('settings.policy.title'), description: t('settings.policy.description'), notes: [] },
      h('select', {
        className: 'sw-set-select', value: values.compactionPreset, disabled: locked, 'aria-labelledby': `${id}-policy-title`,
        onChange: (event) => { form.set('compactionPreset', event.target.value); },
      }, ...PRESET_IDS.map(preset => h('option', { key: preset, value: preset }, t(`monitor.quote.preset.${preset}`))))),
    h(Row, { id: `${id}-backup`, title: t('settings.backup.title'), description: t('settings.backup.description'), notes: modelNotes },
      h(BackupModelSelect, { id: `${id}-backup-select`, labelledBy: `${id}-backup-title`, snapshot, form, t })),
    h(Row, { id: `${id}-inherit`, title: t('settings.inherit.title'), description: t('settings.inherit.description'), notes: [] }, toggle('subagentsInheritCompaction', t('settings.inherit.title'))),
    h(CarrierCacheRow, { carrier, responses, id, t }),
    h('div', { className: 'sw-set-footer' },
      snapshot.failed ? h('p', { className: 'sw-set-failed', role: 'status' }, t('settings.saveFailed')) : null,
      h('button', { type: 'button', className: 'sw-set-button', disabled: !snapshot.dirty || snapshot.saving, onClick: () => { form.cancel(); } }, t('settings.cancel')),
      h('button', { type: 'button', className: 'sw-set-button sw-set-save', disabled: !snapshot.dirty || snapshot.saving || !snapshot.writable, onClick: () => { void form.save(); } },
        t(snapshot.saving ? 'settings.saving' : 'settings.save'))));
}

/** The category's `order` in the settings navigation, after the agent presets'. */
export const SETTINGS_SECTION_ORDER = 30;

/**
 * Registers the Session Watcher category under each lifetime of the `settings.section` declaration, for the injection child that reads `slots`, `configForms`, `remote` and `remote.session`.
 * One form is bound for the child and handed to the page; the entry's label follows the locale at each read.
 *
 * @param {object} child - the injection child
 * @param {{ t: Function, call: Function }} options - the plugin's bound translate and the RPC call without a session
 */
export function registerSettingsSection(child, { t, call }) {
  const form = bindSettingsForm(child);
  const integration = createIntegrationStatus({ call });
  const carrier = createCarrierCacheStore({ call });
  const responses = createResponsesBreakpointStore({ entry: child.configForms.get(SETTINGS_ENTRY) });
  child.slots.inject('settings.section', () => child.slots.register({
    name: 'settings.section',
    id: 'session-watcher',
    order: SETTINGS_SECTION_ORDER,
    locale: NS,
    label: () => t('settings.nav'),
    inject: () => ({ form, integration, carrier, responses }),
  }, CompactionSettings));
}
