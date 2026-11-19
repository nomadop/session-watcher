// The DSH adapter of the compaction settings: the category registered under `settings.section` once DSH's configuration mirror, remote services and slot stand, its page over the mirror, and the new-session switch's visibility following the same mirror. The mirror, the remote catalog and the slot machinery are doubles of the services DSH supplies; the form logic is `test/compaction-settings.test.js`'s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { applyClient } from '../dsh/src/client/plugin.js';
import { NS, en, zh } from '../dsh/src/client/locales.js';
import { SETTINGS_ENTRY } from '../dsh/src/client/settings.js';
import { SOURCE_FAILURES } from '../dsh/src/pi-ai-integration.js';
import { OPTIONS, stubDocument, fakeCtx } from './helpers/dsh-client-context.js';

const ACCEPTED = { showCompactionOption: false, compactionPreset: 'M2', subagentsInheritCompaction: false };
const CATALOG = {
  default: { provider: 'p-main', model: 'm-one' }, routableProviders: ['p-main'],
  groups: [{ id: 'p-main', name: 'Main Provider', models: [{ id: 'm-one', name: 'Model One' }, { id: 'm-two', name: 'Model Two' }] }],
  failures: [],
};

// DSH's `ctx.configForms`, the one form for the entry the plugin names: the snapshot the mirror holds, the atomic write recorded and answered as `answer` says, and a push as a mirror refresh.
function fakeConfigForms({ status = 'ready', value = ACCEPTED, revision = 7, writable = true } = {}) {
  let snapshot = { status, value, base: undefined, user: undefined, revision, writable };
  const listeners = new Set();
  const asked = [];
  const form = {
    mutations: [],
    answer: 'accept',
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async mutate(ops, expectedRevision) {
      form.mutations.push({ ops, expectedRevision });
      if (form.answer === 'throw') throw new Error('the transport failed');
      if (form.answer === 'refuse') return false;
      form.push({ value: { ...snapshot.value, ...Object.fromEntries(ops.map(op => [op.path[0], op.value])) }, revision: snapshot.revision + 1 });
      return true;
    },
    // The real entry's one-field write: the same atomic mutation, its revision the latest one the mirror holds.
    set: (field, value) => form.mutate([{ op: 'set', path: [field], value }]),
    push(next) { snapshot = { ...snapshot, ...next }; for (const listener of [...listeners]) listener(); },
  };
  return { service: { get(entryId) { asked.push(entryId); return form; } }, form, asked };
}

// The services the settings child injects, as the fake context hands them to a child; `$on` records each remote event listener.
function mounted(t, { forms = fakeConfigForms(), catalog = async () => ({ ok: true, value: CATALOG }), rpcCall } = {}) {
  stubDocument(t);
  const remoteEvents = [];
  const fake = fakeCtx({
    rpcCall,
    services: {
      configForms: () => forms.service,
      remote: () => ({ $on: (event, listener) => { remoteEvents.push({ event, listener }); return () => {}; }, session: { modelCatalog: catalog } }),
      'remote.session': () => true,
    },
  });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const entry = fake.registrations.find(r => r.options.name === 'settings.section');
  return { fake, forms, remoteEvents, entry };
}

const t = (key, params) => `${NS}:${key}${params ? JSON.stringify(params) : ''}`;
const page = (entry, extra = {}) => renderToString(React.createElement(entry.component, { ...entry.options.inject(), t, ...extra }));

test('the category is registered under settings.section once its services stand: the plugin\'s id and locale, an order after the agent presets, a label that follows the locale, and one form over the entry the plugin\'s Config is served under', (t) => {
  const { fake, forms, entry } = mounted(t);
  assert.equal(entry.options.id, 'session-watcher');
  assert.equal(entry.options.locale, NS);
  assert.equal(entry.options.order, 30);
  assert.equal(entry.options.label(), `${NS}:settings.nav#1`);
  assert.equal(entry.options.label(), `${NS}:settings.nav#2`, 'the label reads the locale at each call');
  assert.deepEqual(forms.asked, [SETTINGS_ENTRY, SETTINGS_ENTRY, SETTINGS_ENTRY], 'the settings form, the switch\'s visibility and the Responses breakpoint switch follow the one entry');
  assert.equal(SETTINGS_ENTRY, 'session-watcher');
  fake.undeclare();
  assert.equal(entry.disposed, 1);

  // Without the configuration mirror the category does not appear, and the rest of the plugin is registered all the same.
  stubDocument(t);
  const bare = fakeCtx({ services: { remote: () => ({ $on: () => () => {}, session: {} }), 'remote.session': () => true } });
  applyClient(bare.ctx, OPTIONS);
  bare.declare();
  assert.equal(bare.registrations.some(r => r.options.name === 'settings.section'), false);
  assert.ok(bare.registrations.some(r => r.options.name === 'conversation.view'));
});

test('the page shows what the mirror accepted in DSH\'s own words and controls: the two groups, the four settings by name, the policy\'s five names and the backup model\'s none, with the save and cancel held off until something is staged', (t) => {
  const { entry } = mounted(t);
  const html = page(entry);
  for (const key of ['settings.group.experimental', 'settings.group.preferences', 'settings.show.title', 'settings.policy.title', 'settings.backup.title', 'settings.inherit.title', 'settings.cancel', 'settings.save']) {
    assert.ok(html.includes(`${NS}:${key}`), key);
  }
  for (const id of ['E2', 'W2', 'M2', 'S3', 'X3']) assert.ok(html.includes(`${NS}:monitor.quote.preset.${id}`), id);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2, 'two ordinary switches');
  assert.match(html, /<option value="M2" selected/);
  assert.match(html, /<option value="" selected[^>]*>[^<]*settings\.backup\.none/, 'no backup model is chosen for the user');
  assert.equal((html.match(/<button type="button" class="sw-set-button[^"]*" disabled/g) ?? []).length, 2, 'nothing staged: both buttons are held off');
  // The page as a reader sees it, in the plugin's own English: the policy is named by its words alone.
  const words = renderToString(React.createElement(entry.component, { ...entry.options.inject(), t: key => en[key] })).replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(words, /\b[EWMSX][23]\b/, 'no internal id is shown as text');
  for (const name of ['Most aggressive', 'Aggressive', 'Balanced', 'Conservative', 'Most conservative']) assert.ok(words.includes(name), name);
});

test('before the mirror holds the settings the page shows its state and no control, and a read-only document shows its values with every control disabled', (t) => {
  for (const [status, key] of [['loading', 'settings.loading'], ['unavailable', 'settings.unavailable']]) {
    const { entry } = mounted(t, { forms: fakeConfigForms({ status, value: undefined, revision: undefined }) });
    const html = page(entry);
    assert.ok(html.includes(`${NS}:${key}`), status);
    assert.doesNotMatch(html, /role="switch"|<select/, `${status}: no editable default is shown`);
  }
  const { entry } = mounted(t, { forms: fakeConfigForms({ writable: false }) });
  const html = page(entry);
  assert.ok(html.includes(`${NS}:settings.readOnly`));
  assert.equal((html.match(/<select[^>]*disabled/g) ?? []).length, 2);
  assert.equal((html.match(/role="switch"[^>]*disabled|disabled[^>]*role="switch"/g) ?? []).length, 2);
});

test('a save through the page\'s form writes the staged settings to the mirror, fenced by the revision the staging began at, and the page then shows what the mirror holds; a refusal and a transport failure leave the draft on screen with the failure, and a cancel returns the page to the mirror', async (t) => {
  const { entry, forms } = mounted(t);
  const { form } = entry.options.inject();
  form.set('compactionPreset', 'X3');
  form.set('subagentsInheritCompaction', true);
  assert.match(page(entry), /<option value="X3" selected/, 'the draft shows before it is saved');
  assert.deepEqual(forms.form.mutations, [], 'nothing was written');
  forms.form.push({ revision: 9 });
  assert.equal(await form.save(), true);
  assert.deepEqual(forms.form.mutations, [{
    ops: [{ op: 'set', path: ['compactionPreset'], value: 'X3' }, { op: 'set', path: ['subagentsInheritCompaction'], value: true }], expectedRevision: 7,
  }]);
  assert.deepEqual(forms.form.getSnapshot().value, { ...ACCEPTED, compactionPreset: 'X3', subagentsInheritCompaction: true });
  assert.match(page(entry), /<option value="X3" selected/);

  for (const answer of ['refuse', 'throw']) {
    forms.form.answer = answer;
    form.set('compactionPreset', 'W2');
    assert.equal(await form.save(), false, answer);
    const html = page(entry);
    assert.ok(html.includes(`${NS}:settings.saveFailed`), `${answer}: the failure is shown`);
    assert.match(html, /<option value="W2" selected/, `${answer}: the draft stays`);
    assert.equal(forms.form.getSnapshot().value.compactionPreset, 'X3', `${answer}: the mirror did not take it`);
    form.cancel();
    assert.match(page(entry), /<option value="X3" selected/, `${answer}: cancel returns to the mirror`);
    assert.doesNotMatch(page(entry), /settings\.saveFailed/);
  }
});

test('the backup model\'s choices are the host\'s catalog: a saved route that is not in it stays selected and is marked, the catalog is read again on an adapter or a settings change and the draft dropped when the connection begins again', async (t) => {
  const { entry, forms, remoteEvents, fake } = mounted(t, { forms: fakeConfigForms({ value: { ...ACCEPTED, summaryFallbackModel: { provider: 'p-gone', model: 'm-gone' } } }) });
  const { form } = entry.options.inject();
  await form.loadModels();
  const html = page(entry);
  assert.ok(html.includes('Model One') && html.includes('Main Provider'), 'the catalog\'s models are the options');
  assert.match(html, /<option value="[^"]*" selected="">m-gone · p-gone \(session-watcher:settings\.backup\.unavailableTag/);
  assert.ok(html.includes(`${NS}:settings.backup.unavailable`));
  assert.deepEqual(remoteEvents.map(e => e.event).sort(), ['llm/adapters-updated', 'settings/document-updated']);
  form.set('compactionPreset', 'S3');
  remoteEvents.find(e => e.event === 'llm/adapters-updated').listener();
  remoteEvents.find(e => e.event === 'settings/document-updated').listener();
  fake.log.find(e => e.call === 'child.on' && e.event === 'connection/reset').listener();
  assert.equal(form.getSnapshot().dirty, false, 'the draft was dropped with the connection');
  assert.equal(forms.form.mutations.length, 0);
});

test('the new-session switch follows the mirror\'s setting: hidden until the mirror holds it on, hidden again where it is off or unavailable, and shown again when it is saved on', (t) => {
  const forms = fakeConfigForms({ status: 'loading', value: undefined, revision: undefined });
  const { fake } = mounted(t, { forms });
  const hero = fake.registrations.find(r => r.options.name === 'conversation.hero.options');
  const { visibility } = hero.options.inject('s1');
  assert.equal(visibility.getSnapshot(), false, 'before the mirror answers');
  forms.form.push({ status: 'ready', value: { ...ACCEPTED, showCompactionOption: true }, revision: 1 });
  assert.equal(visibility.getSnapshot(), true);
  const heard = [];
  visibility.subscribe(() => heard.push(visibility.getSnapshot()));
  forms.form.push({ value: { ...ACCEPTED, showCompactionOption: false }, revision: 2 });
  forms.form.push({ value: { ...ACCEPTED, showCompactionOption: true }, revision: 3 });
  forms.form.push({ status: 'unavailable', value: undefined });
  assert.deepEqual(heard, [false, true, false]);
});

// An integration store holding `failure`, as the page reads it.
const holding = failure => ({ getSnapshot: () => ({ failure }), subscribe: () => () => {}, load: async () => {} });

test('a pi-ai integration failure shows on the page, held settings or not, with its cause, what it can cost and how to recover, and nothing shows while there is none', (t) => {
  const { entry } = mounted(t);
  assert.doesNotMatch(page(entry), /settings\.integration/, 'no failure is none');
  const waiting = mounted(t, { forms: fakeConfigForms({ status: 'loading', value: undefined, revision: undefined }) });
  for (const [why, view] of [['ready', entry], ['loading', waiting.entry]]) {
    for (const cause of SOURCE_FAILURES) {
      const html = page(view, { integration: holding({ cause }) });
      for (const key of [`settings.integration.cause.${cause}`, 'settings.integration.title', 'settings.integration.consequence', 'settings.integration.recovery']) {
        assert.ok(html.includes(`${NS}:${key}`), `${why} ${cause}: ${key}`);
      }
      assert.match(html, /role="alert"/, `${why} ${cause}`);
    }
  }
});

test('the integration status is read from the host without a session and follows what the host answers: a failure, then none once it is gone, while a refusal or a transport failure leaves what the page showed', async (t) => {
  const asked = [];
  let answer = { ok: true, value: { failure: { cause: 'source-invalid' } } };
  const { entry } = mounted(t, { rpcCall: async (channel, endpoint, payload) => { asked.push({ channel, endpoint, payload }); if (answer === 'throw') throw new Error('the transport failed'); return answer; } });
  const { integration } = entry.options.inject();
  assert.deepEqual(integration.getSnapshot(), { failure: null }, 'nothing is shown before the host has answered');
  let notified = 0;
  integration.subscribe(() => { notified += 1; });
  await integration.load();
  assert.deepEqual(asked, [{ channel: '/session-watcher', endpoint: 'pi-ai/status', payload: {} }]);
  assert.deepEqual(integration.getSnapshot(), { failure: { cause: 'source-invalid' } });
  assert.equal(notified, 1);
  await integration.load();
  assert.equal(notified, 1, 'an answer that changes nothing notifies nobody');
  answer = 'throw';
  await integration.load();
  answer = { ok: false, error: { code: 'unknown_endpoint', message: 'unknown endpoint pi-ai/status', details: {} } };
  await integration.load();
  assert.deepEqual(integration.getSnapshot(), { failure: { cause: 'source-invalid' } }, 'a host that cannot answer leaves what was shown');
  answer = { ok: true, value: { failure: null } };
  await integration.load();
  assert.deepEqual(integration.getSnapshot(), { failure: null });
  assert.equal(notified, 2);
});

// ── The carrier cache switch ─────────────────────────────────────────────────

const CARRIER = (state, extra = {}) => ({ getSnapshot: () => ({ state, busy: false, outcome: null, ...extra }), subscribe: () => () => {}, load: async () => {}, set: async () => {} });
// The carrier cache control's own state, which the page's other switches do not share (the mirror's settings render `false` too).
const carrierChecked = html => html.match(/aria-checked="(true|false)" aria-label="[^"]*settings\.carrier\.title"/)?.[1];
// The control of the switch whose accessible name is `titleKey`, as the page renders it: its own tag, so its checked and held-off state are not the page's other switches'.
const controlOf = (html, titleKey) => html.match(new RegExp(`<button[^>]*aria-label="[^"]*${titleKey.replaceAll('.', '\\.')}"[^>]*>`))?.[0];
const responsesControl = html => controlOf(html, 'settings.carrier.responses.title');
const checkedOf = control => control.match(/aria-checked="(true|false)"/)[1];
const heldOff = control => / disabled=""/.test(control);
const carrierControl = html => controlOf(html, 'settings.carrier.title');
const OUTCOMES = {
  enabled: { outcome: 'enabled' },
  'disabled-restored': { outcome: 'disabled', native: 'restored' },
  'disabled-unconfirmed': { outcome: 'disabled', native: 'unconfirmed' },
  'restart-required': { outcome: 'restart-required' },
  'rolled-back': { outcome: 'rolled-back', reason: 'not-confirmed' },
  withdrawn: { outcome: 'withdrawn', reason: 'not-confirmed', cause: 'source-invalid' },
  'rollback-failed': { outcome: 'rollback-failed', reason: 'apply-failed' },
  failed: { outcome: 'failed' },
  busy: { outcome: 'busy' },
  unavailable: { outcome: 'unavailable' },
};

test('the carrier cache store reads the status without a session and asks for a change as the owner\'s, the body naming only the state wanted: a forbidden answer hides the control, a refusal or a transport failure leaves what was shown, and a second request meanwhile is not sent', async (t) => {
  const asked = [];
  const answers = { 'carrier-cache/status': { ok: true, value: { state: 'off' } }, 'carrier-cache/set': { ok: true, value: { outcome: 'enabled' } } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hold = false;
  const { entry } = mounted(t, {
    rpcCall: async (channel, endpoint, payload) => {
      asked.push({ channel, endpoint, payload });
      if (answers[endpoint] === 'throw') throw new Error('the transport failed');
      if (hold && endpoint === 'carrier-cache/set') await gate;
      return answers[endpoint];
    },
  });
  const { carrier } = entry.options.inject();
  assert.deepEqual(carrier.getSnapshot(), { state: 'loading', busy: false, outcome: null }, 'nothing is shown before the host has answered');
  await carrier.load();
  assert.deepEqual(asked, [{ channel: '/session-watcher', endpoint: 'carrier-cache/status', payload: {} }]);
  assert.deepEqual(carrier.getSnapshot(), { state: 'off', busy: false, outcome: null });

  answers['carrier-cache/status'] = { ok: true, value: { state: 'pending', cause: 'source-invalid' } };
  await carrier.load();
  assert.deepEqual(carrier.getSnapshot(), { state: 'pending', cause: 'source-invalid', busy: false, outcome: null });
  answers['carrier-cache/status'] = 'throw';
  await carrier.load();
  answers['carrier-cache/status'] = { ok: false, error: { code: 'unknown_endpoint', message: 'unknown endpoint', details: {} } };
  await carrier.load();
  assert.equal(carrier.getSnapshot().state, 'pending', 'a host that cannot answer leaves what was shown');

  // A change names only the state wanted; the page then reads the status again and shows the outcome.
  asked.length = 0;
  answers['carrier-cache/status'] = { ok: true, value: { state: 'on' } };
  hold = true;
  const first = carrier.set(true);
  const second = carrier.set(true);
  assert.equal(carrier.getSnapshot().busy, true);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(asked.map(({ endpoint, payload }) => [endpoint, payload]), [['carrier-cache/set', { enabled: true }], ['carrier-cache/status', {}]], 'one request, then a read');
  assert.deepEqual(carrier.getSnapshot(), { state: 'on', busy: false, outcome: { outcome: 'enabled' } });

  // A transport failure ends the change as failed and releases the control; a refusal from the host is its own outcome.
  answers['carrier-cache/set'] = 'throw';
  hold = false;
  await carrier.set(false);
  assert.deepEqual(carrier.getSnapshot().outcome, { outcome: 'failed' });
  assert.equal(carrier.getSnapshot().busy, false);
  answers['carrier-cache/set'] = { ok: true, value: { outcome: 'busy' } };
  await carrier.set(false);
  assert.deepEqual(carrier.getSnapshot().outcome, { outcome: 'busy' });

  // A forbidden answer is the host saying the caller is not its owner: the page shows no control. It is a presentation only; the host decides who may change anything.
  answers['carrier-cache/status'] = { ok: false, error: { code: 'forbidden', message: 'owner only', details: {} } };
  await carrier.load();
  assert.equal(carrier.getSnapshot().state, 'hidden');
});

test('a bundle the host reports as not installed is installed only through the owner\'s confirmation: switching on opens the confirmation and asks the host nothing, cancelling closes it, confirming asks once with the literal confirmation and nothing else, and a confirmation nobody opened sends nothing', async (t) => {
  const asked = [];
  const answers = {
    'carrier-cache/status': { ok: true, value: { state: 'not-installed', install: { name: '@x/bundle', version: '1.2.3' } } },
    'carrier-cache/set': { ok: true, value: { outcome: 'enabled', installed: true } },
  };
  const { entry } = mounted(t, { rpcCall: async (channel, endpoint, payload) => { asked.push([endpoint, payload]); return answers[endpoint]; } });
  const { carrier } = entry.options.inject();
  await carrier.load();
  assert.deepEqual(carrier.getSnapshot(), { state: 'not-installed', install: { name: '@x/bundle', version: '1.2.3' }, busy: false, outcome: null });

  await carrier.confirmInstall();
  assert.deepEqual(asked.filter(([endpoint]) => endpoint === 'carrier-cache/set'), [], 'nobody opened a confirmation');
  await carrier.set(true);
  assert.equal(carrier.getSnapshot().confirming, true);
  assert.deepEqual(asked.filter(([endpoint]) => endpoint === 'carrier-cache/set'), [], 'switching on asks the host nothing yet');
  carrier.cancelInstall();
  assert.equal('confirming' in carrier.getSnapshot(), false);
  await carrier.confirmInstall();
  assert.deepEqual(asked.filter(([endpoint]) => endpoint === 'carrier-cache/set'), [], 'a cancelled confirmation sends nothing');

  await carrier.set(true);
  answers['carrier-cache/status'] = { ok: true, value: { state: 'on' } };
  asked.length = 0;
  await carrier.confirmInstall();
  assert.deepEqual(asked, [['carrier-cache/set', { enabled: true, confirmInstall: true }], ['carrier-cache/status', {}]]);
  assert.deepEqual(carrier.getSnapshot(), { state: 'on', busy: false, outcome: { outcome: 'enabled', installed: true } });

  // A confirmation does not outlive the state it was opened for.
  answers['carrier-cache/status'] = { ok: true, value: { state: 'not-installed', install: { name: '@x/bundle', version: '1.2.3' } } };
  await carrier.load();
  await carrier.set(true);
  assert.equal(carrier.getSnapshot().confirming, true);
  answers['carrier-cache/status'] = { ok: true, value: { state: 'off' } };
  await carrier.load();
  assert.equal('confirming' in carrier.getSnapshot(), false);

  // The reason an unavailable switch gives is kept for the page.
  answers['carrier-cache/status'] = { ok: true, value: { state: 'unavailable', reason: 'conflict' } };
  await carrier.load();
  assert.deepEqual(carrier.getSnapshot(), { state: 'unavailable', reason: 'conflict', busy: false, outcome: null });

  // A refusal from the owner check hides the control and closes any confirmation.
  answers['carrier-cache/status'] = { ok: true, value: { state: 'not-installed', install: { name: '@x/bundle', version: '1.2.3' } } };
  await carrier.load();
  await carrier.set(true);
  answers['carrier-cache/set'] = { ok: false, error: { code: 'forbidden', message: 'owner only', details: {} } };
  await carrier.confirmInstall();
  assert.deepEqual(carrier.getSnapshot(), { state: 'hidden', busy: false, outcome: null });
});

test('the page offers the install of a bundle that is not installed and asks the owner to confirm it: the package and version are named, the switch is off and free, the confirmation names what installs, what it does not approve and what stays after a failure, and each reason an unavailable switch gives has its own text', (t) => {
  const { entry } = mounted(t);
  const row = (carrier) => page(entry, { carrier });
  const install = { name: '@x/bundle', version: '1.2.3' };
  const named = key => `${NS}:${key}${JSON.stringify(install)}`.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const offered = row(CARRIER('not-installed', { install }));
  assert.ok(offered.includes(named('settings.carrier.notInstalled')), 'the package and version');
  assert.equal(carrierChecked(offered), 'false');
  assert.equal(heldOff(carrierControl(offered)), false, 'the switch can be used');
  assert.doesNotMatch(offered, /data-sw-carrier-install/, 'no confirmation is open');

  const asking = row(CARRIER('not-installed', { install, confirming: true }));
  assert.ok(asking.includes(named('settings.carrier.install.confirm')));
  assert.match(asking, /data-sw-carrier-install-accept/);
  assert.match(asking, /data-sw-carrier-install-cancel/);
  assert.match(asking, /role="alertdialog"/);
  assert.equal(heldOff(carrierControl(row(CARRIER('not-installed', { install, confirming: true, busy: true })))), true);
  const running = row(CARRIER('not-installed', { install, confirming: true, busy: true }));
  const buttonOf = (html, control) => html.match(new RegExp(`<button[^>]*data-sw-carrier-install-${control}[^>]*>`))[0];
  for (const control of ['accept', 'cancel']) {
    assert.equal(heldOff(buttonOf(running, control)), true, `${control} is held while the install runs`);
    assert.equal(heldOff(buttonOf(asking, control)), false, `${control} is free until then`);
  }
  assert.ok(running.includes(`${NS}:settings.carrier.install.running`) && !asking.includes('install.running'), 'the install says it runs');

  assert.ok(row(CARRIER('unavailable')).includes(`${NS}:settings.carrier.unavailable`));
  for (const reason of ['conflict', 'damaged', 'unreadable']) {
    const html = row(CARRIER('unavailable', { reason }));
    assert.ok(html.includes(`${NS}:settings.carrier.unavailable.${reason}`), reason);
    assert.equal(heldOff(carrierControl(html)), true, reason);
  }

  for (const outcome of ['install-confirmation-required', 'install-failed', 'install-unconfirmed']) {
    assert.ok(row(CARRIER('not-installed', { install, outcome: { outcome } })).includes(`${NS}:settings.carrier.outcome.${outcome}`), outcome);
  }
  assert.ok(row(CARRIER('on', { outcome: { outcome: 'enabled', installed: true } })).includes(`${NS}:settings.carrier.outcome.installed-enabled`));
  assert.ok(!row(CARRIER('on', { outcome: { outcome: 'enabled' } })).includes('installed-enabled'));
  for (const outcome of ['rolled-back', 'withdrawn', 'rollback-failed']) {
    const html = row(CARRIER('off', { outcome: { outcome, reason: 'not-confirmed', installed: true } }));
    assert.ok(html.includes(`${NS}:settings.carrier.outcome.${outcome}`) && html.includes(`${NS}:settings.carrier.installedNote`), `${outcome}: the package stays installed, said so`);
  }
  assert.ok(!row(CARRIER('off', { outcome: { outcome: 'rolled-back', reason: 'not-confirmed' } })).includes('installedNote'));
});

test('the page shows the carrier cache row for each state the host reports with its switch and outcome, and nothing while the answer is awaited or the caller is not the owner', (t) => {
  const { entry } = mounted(t);
  const row = (carrier) => page(entry, { carrier });
  for (const hidden of ['loading', 'hidden']) assert.doesNotMatch(row(CARRIER(hidden)), /data-sw-carrier/, hidden);

  const off = row(CARRIER('off'));
  assert.match(off, /data-sw-carrier/);
  for (const key of ['settings.carrier.title', 'settings.carrier.description', 'settings.carrier.caveat']) assert.ok(off.includes(`${NS}:${key}`), key);
  assert.equal(carrierChecked(off), 'false');
  assert.equal(carrierChecked(row(CARRIER('on'))), 'true');
  const pending = row(CARRIER('pending', { cause: 'source-invalid' }));
  assert.ok(pending.includes(`${NS}:settings.carrier.pending`));
  assert.ok(pending.includes(`${NS}:settings.integration.cause.source-invalid`));
  assert.equal(carrierChecked(pending), 'false', 'a reading that is not confirmed in effect is not shown as on');
  const unavailable = row(CARRIER('unavailable'));
  assert.ok(unavailable.includes(`${NS}:settings.carrier.unavailable`));
  assert.equal(heldOff(carrierControl(unavailable)), true);
  assert.equal(heldOff(carrierControl(row(CARRIER('off', { busy: true })))), true, 'the control is held while a change runs');
  assert.equal(heldOff(carrierControl(off)), false);

  for (const [name, outcome] of Object.entries(OUTCOMES)) {
    const html = row(CARRIER('off', { outcome }));
    assert.ok(html.includes(`${NS}:settings.carrier.outcome.${name}`), name);
    assert.equal([...html.matchAll(/data-sw-carrier-outcome/g)].length, 1, name);
  }
  assert.ok(row(CARRIER('off', { outcome: OUTCOMES.withdrawn })).includes(`${NS}:settings.integration.cause.source-invalid`), 'the entry\'s cause is named');
  assert.doesNotMatch(off, /data-sw-carrier-outcome/);
});

test('a selection the host withdrew because the manager left it for a restart says so beside each of the three rollback outcomes, which stay distinct, and no other reason adds that sentence; a switch-off waiting for a restart is worded on its own and the control is not shown on', (t) => {
  const { entry } = mounted(t);
  const row = (carrier) => page(entry, { carrier });
  const REASON = `${NS}:settings.carrier.reason.restart-required`;
  for (const outcome of ['rolled-back', 'withdrawn', 'rollback-failed']) {
    const html = row(CARRIER('off', { outcome: { outcome, reason: 'restart-required' } }));
    assert.ok(html.includes(`${NS}:settings.carrier.outcome.${outcome}`), outcome);
    assert.ok(html.includes(REASON), outcome);
    for (const reason of ['apply-failed', 'not-confirmed']) assert.ok(!row(CARRIER('off', { outcome: { outcome, reason } })).includes(REASON), `${outcome} ${reason}`);
  }
  assert.ok(!row(CARRIER('off', { outcome: OUTCOMES['restart-required'] })).includes(REASON), 'a switch-off waiting for a restart names no withdrawn selection');
  const waiting = row(CARRIER('pending', { outcome: OUTCOMES['restart-required'] }));
  assert.ok(waiting.includes(`${NS}:settings.carrier.outcome.restart-required`));
  assert.ok(waiting.includes(`${NS}:settings.carrier.pending`));
  assert.equal(carrierChecked(waiting), 'false');
});

test('every outcome and state the carrier cache row words has a text in both locales, and the two locales word the same keys', () => {
  for (const [locale, dictionary] of Object.entries({ en, zh })) {
    for (const name of Object.keys(OUTCOMES)) assert.equal(typeof dictionary[`settings.carrier.outcome.${name}`], 'string', `${locale} ${name}`);
    for (const key of ['title', 'description', 'caveat', 'pending', 'unavailable', 'reason.restart-required', 'responses.title', 'responses.description', 'responses.warning', 'responses.held', 'responses.failed']) assert.equal(typeof dictionary[`settings.carrier.${key}`], 'string', `${locale} ${key}`);
  }
  assert.deepEqual(Object.keys(en).filter(key => key.startsWith('settings.carrier.')), Object.keys(zh).filter(key => key.startsWith('settings.carrier.')));
});

// ── The Responses breakpoint switch, saved in the plugin's Config under the carrier cache row ──

const FIELD = 'carrierResponsesBreakpoint';
const RESPONSES = (snapshot = {}) => ({
  getSnapshot: () => ({ status: 'ready', on: false, writable: true, saving: false, failed: false, ...snapshot }), subscribe: () => () => {}, set: async () => {},
});

test('the Responses breakpoint switch is the mirror\'s saved field, off until saved on: a change is one field written to the mirror and shows what the mirror then holds, a refusal or a transport failure leaves it as it was, one change runs at a time, and a mirror that is not ready or not writable is never written', async (t) => {
  const asked = [];
  const forms = fakeConfigForms();
  const { entry } = mounted(t, { forms, rpcCall: async (channel, endpoint, payload) => { asked.push({ endpoint, payload }); return { ok: true, value: { state: 'on' } }; } });
  const { responses, carrier } = entry.options.inject();
  assert.deepEqual(responses.getSnapshot(), { status: 'ready', on: false, writable: true, saving: false, failed: false }, 'a mirror that holds no value is off');

  await responses.set(true);
  assert.deepEqual(forms.form.mutations, [{ ops: [{ op: 'set', path: [FIELD], value: true }], expectedRevision: undefined }], 'one field, nothing else, and no revision of the page\'s own');
  assert.deepEqual(responses.getSnapshot(), { status: 'ready', on: true, writable: true, saving: false, failed: false });

  // Off alone: the field is the only thing written, and the carrier cache switch is neither asked nor changed.
  forms.form.mutations.length = 0;
  await responses.set(false);
  assert.deepEqual(forms.form.mutations.map(({ ops }) => ops), [[{ op: 'set', path: [FIELD], value: false }]]);
  assert.equal(responses.getSnapshot().on, false);
  assert.deepEqual(asked, [], 'no request to the carrier cache switch');
  assert.equal(carrier.getSnapshot().state, 'loading');

  // The mirror is the authority: a refusal and a transport failure leave what it holds and say the change failed, until the next change.
  forms.form.mutations.length = 0;
  forms.form.answer = 'refuse';
  await responses.set(true);
  assert.deepEqual(responses.getSnapshot(), { status: 'ready', on: false, writable: true, saving: false, failed: true });
  forms.form.answer = 'throw';
  await responses.set(true);
  assert.deepEqual(responses.getSnapshot(), { status: 'ready', on: false, writable: true, saving: false, failed: true });
  forms.form.answer = 'accept';
  await responses.set(true);
  assert.deepEqual(responses.getSnapshot(), { status: 'ready', on: true, writable: true, saving: false, failed: false });

  // One change at a time, and each change announced to a listener of the store.
  let notified = 0;
  const stop = responses.subscribe(() => { notified += 1; });
  forms.form.mutations.length = 0;
  const first = responses.set(false);
  assert.equal(responses.getSnapshot().saving, true);
  const second = responses.set(false);
  await Promise.all([first, second]);
  assert.equal(forms.form.mutations.length, 1);
  assert.ok(notified >= 2, 'the page is told when the change starts and when it ends');
  stop();

  // A saved selection is what the next page shows, and a mirror that cannot be written is not written.
  const saved = mounted(t, { forms: fakeConfigForms({ value: { ...ACCEPTED, [FIELD]: true } }) });
  assert.equal(saved.entry.options.inject().responses.getSnapshot().on, true, 'the selection persists with the Config');
  for (const unwritable of [{ status: 'loading', value: undefined, revision: undefined }, { status: 'unavailable', value: undefined, revision: undefined }, { writable: false }]) {
    const blocked = mounted(t, { forms: fakeConfigForms(unwritable) });
    await blocked.entry.options.inject().responses.set(true);
    assert.deepEqual(blocked.forms.form.mutations, [], JSON.stringify(unwritable));
  }
});

test('the page shows the Responses breakpoint switch under the carrier cache switch with the endpoint\'s possible refusal in words: usable only while the carrier cache point is on and confirmed, held off with the saved choice still shown while it is not, and held off while a change runs, the mirror is read-only or the change is being saved', (t) => {
  const { entry } = mounted(t);
  const row = (carrier, responses = RESPONSES()) => page(entry, { carrier, responses });

  const idle = row(CARRIER('on'));
  for (const key of ['settings.carrier.responses.title', 'settings.carrier.responses.description', 'settings.carrier.responses.warning']) assert.ok(idle.includes(`${NS}:${key}`), key);
  assert.equal(checkedOf(responsesControl(idle)), 'false', 'off by default');
  assert.equal(heldOff(responsesControl(idle)), false);
  assert.ok(!idle.includes(`${NS}:settings.carrier.responses.held`), 'nothing is held while the carrier cache point is on');
  assert.equal(checkedOf(responsesControl(row(CARRIER('on'), RESPONSES({ on: true })))), 'true');
  assert.equal(heldOff(responsesControl(row(CARRIER('on'), RESPONSES({ on: true })))), false, 'it can be turned off by itself');

  // The carrier cache point off, unavailable or not confirmed: the switch is held off and keeps the choice, and says why; the endpoint's warning stays.
  for (const state of ['off', 'pending', 'unavailable']) {
    for (const on of [false, true]) {
      const html = row(CARRIER(state), RESPONSES({ on }));
      const control = responsesControl(html);
      assert.equal(heldOff(control), true, `${state} ${on}`);
      assert.equal(checkedOf(control), String(on), `${state}: the saved choice is kept`);
      assert.ok(html.includes(`${NS}:settings.carrier.responses.held`), state);
      assert.ok(html.includes(`${NS}:settings.carrier.responses.warning`), state);
    }
  }
  // Nothing of the carrier cache row shows before the host answers or to a caller that is not the owner, the Responses switch with it.
  for (const hidden of ['loading', 'hidden']) assert.doesNotMatch(row(CARRIER(hidden)), /settings\.carrier\.responses/, hidden);

  assert.equal(heldOff(responsesControl(row(CARRIER('on', { busy: true })))), true, 'a change of the carrier cache point runs');
  assert.equal(heldOff(responsesControl(row(CARRIER('on'), RESPONSES({ writable: false })))), true, 'a read-only document');
  assert.equal(heldOff(responsesControl(row(CARRIER('on'), RESPONSES({ saving: true })))), true, 'a change being saved');
  assert.equal(heldOff(responsesControl(row(CARRIER('on'), RESPONSES({ status: 'loading' })))), true);
  assert.ok(!idle.includes(`${NS}:settings.carrier.responses.failed`));
  assert.ok(row(CARRIER('on'), RESPONSES({ failed: true })).includes(`${NS}:settings.carrier.responses.failed`), 'a change that was not saved says so');
  // The carrier cache control and its own state are the ones they were.
  assert.equal(carrierChecked(row(CARRIER('on'), RESPONSES({ on: true }))), 'true');
  assert.equal(carrierChecked(row(CARRIER('off'), RESPONSES({ on: true }))), 'false');
});
