// The compaction settings form logic (`public/lib/compactionSettings.js`): the shape, the validation and the staged draft over a read/subscribe/write capability and a model-catalog capability handed in, with no DSH, Cordis or React behind them. The doubles below are the capabilities a host adapter supplies.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsDraft, PRESET_IDS } from '../public/lib/compactionSettings.js';
import { KAPPA_PRESETS } from '../dsh/src/inner-quote.js';

const ACCEPTED = Object.freeze({ showCompactionOption: false, compactionPreset: 'M2', summaryFallbackModel: null, subagentsInheritCompaction: false });
const BACKUP = Object.freeze({ provider: 'p-backup', model: 'm-backup' });

// A settings capability over one accepted state: `write(changes, revision)` rejects, folds the changes into the state and bumps its revision, or answers and leaves the mirror as it was, as `outcome` says (`refuse` and `ignore` are the host's refusal and an answer its mirror does not show); `hold` leaves the write pending until the test settles the entry it pushes on `held`.
function fakeSettings({ status = 'ready', values = ACCEPTED, revision = 4, writable = true } = {}) {
  let state = { status, values, revision, writable };
  const listeners = new Set();
  const settings = {
    writes: [],
    held: [],
    outcome: 'accept',
    read: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async write(changes, expected) {
      settings.writes.push({ changes, expected });
      if (settings.outcome === 'hold') await new Promise((resolve, reject) => { settings.held.push({ resolve, reject }); });
      if (settings.outcome === 'reject') throw new Error('the connection dropped');
      if (settings.outcome === 'accept') settings.push({ values: { ...state.values, ...changes }, revision: state.revision + 1 });
    },
    push(next) { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); },
  };
  return settings;
}

const NO_MODELS = { list: async () => ({ groups: [], failures: [] }) };

test('before the host serves the settings nothing is editable and no value is made up: loading and unavailable show no values, and a ready state shows exactly what the host accepted, an unset backup model as none', () => {
  for (const status of ['loading', 'unavailable']) {
    const settings = fakeSettings({ status, values: undefined, revision: undefined });
    const draft = createSettingsDraft({ settings, models: NO_MODELS });
    assert.deepEqual(draft.getSnapshot().status, status);
    assert.equal(draft.getSnapshot().values, null, `${status}: no defaults are shown`);
    assert.equal(draft.set('compactionPreset', 'S3'), false, `${status}: nothing is editable`);
    assert.equal(draft.getSnapshot().dirty, false);
  }
  // The host omits a field whose value is unset; a backup model unset reads as none.
  const { summaryFallbackModel, ...omitted } = ACCEPTED;
  const ready = createSettingsDraft({ settings: fakeSettings({ values: omitted }), models: NO_MODELS });
  assert.deepEqual(ready.getSnapshot().values, ACCEPTED);
  assert.equal(summaryFallbackModel, null);
  assert.deepEqual(PRESET_IDS, ['E2', 'W2', 'M2', 'S3', 'X3']);
  assert.deepEqual(PRESET_IDS, Object.keys(KAPPA_PRESETS), 'the form offers exactly the presets the host prices a quote under, in their order');
});

test('an edit stages over the accepted values and nothing is written: it shows in the values and marks the form dirty, setting a field back to what is accepted clears it, and a value the field cannot hold or a read-only document is refused', () => {
  const settings = fakeSettings();
  const draft = createSettingsDraft({ settings, models: NO_MODELS });
  assert.equal(draft.set('compactionPreset', 'S3'), true);
  assert.equal(draft.set('showCompactionOption', true), true);
  assert.deepEqual(draft.getSnapshot().values, { ...ACCEPTED, compactionPreset: 'S3', showCompactionOption: true });
  assert.equal(draft.getSnapshot().dirty, true);
  assert.equal(settings.writes.length, 0);
  draft.set('compactionPreset', 'M2');
  draft.set('showCompactionOption', false);
  assert.equal(draft.getSnapshot().dirty, false, 'a draft equal to the accepted values is no draft');

  for (const [field, value] of [['compactionPreset', 'Z9'], ['compactionPreset', 'S3 '], ['showCompactionOption', 'yes'], ['summaryFallbackModel', { provider: 'p' }], ['summaryFallbackModel', { provider: '', model: 'm' }], ['nonsense', true]]) {
    assert.equal(draft.set(field, value), false, `${field} ${JSON.stringify(value)}`);
  }
  assert.equal(draft.getSnapshot().dirty, false);
  assert.equal(createSettingsDraft({ settings: fakeSettings({ writable: false }), models: NO_MODELS }).set('compactionPreset', 'S3'), false, 'a read-only document stages nothing');
});

test('a save writes only the staged changes, fenced by the revision the draft started from, and what the host accepted replaces the draft: the form is saving meanwhile, a second save is not made, and the values read are the mirror\'s', async () => {
  const settings = fakeSettings();
  const draft = createSettingsDraft({ settings, models: NO_MODELS });
  draft.set('compactionPreset', 'W2');
  draft.set('summaryFallbackModel', BACKUP);
  settings.push({ revision: 5 });
  const seen = [];
  draft.subscribe(() => { seen.push(draft.getSnapshot().saving); });

  const first = draft.save();
  const second = draft.save();
  assert.equal(draft.getSnapshot().saving, true);
  assert.deepEqual([await first, await second], [true, false], 'the second save made no write');

  assert.deepEqual(settings.writes, [{ changes: { compactionPreset: 'W2', summaryFallbackModel: BACKUP }, expected: 4 }], 'the revision read when the draft began, not the later one');
  const after = draft.getSnapshot();
  assert.deepEqual([after.saving, after.failed, after.dirty], [false, false, false]);
  assert.deepEqual(after.values, { ...ACCEPTED, compactionPreset: 'W2', summaryFallbackModel: BACKUP }, 'the values are what the host now holds');
  assert.ok(seen.includes(true) && seen.at(-1) === false);
  assert.equal(await draft.save(), false, 'no draft, no write');
  assert.equal(settings.writes.length, 1);
});

test('a refused or failed save keeps the draft on screen as a draft and says so: it is not read as accepted, a later edit or a cancel clears the failure, and a cancel drops the draft whole', async () => {
  // `ignore` is a write the host answered true that its mirror does not show: not an accepted save either.
  for (const outcome of ['refuse', 'reject', 'ignore']) {
    const settings = fakeSettings();
    settings.outcome = outcome;
    const draft = createSettingsDraft({ settings, models: NO_MODELS });
    draft.set('subagentsInheritCompaction', true);
    assert.equal(await draft.save(), false, outcome);
    const failed = draft.getSnapshot();
    assert.deepEqual([failed.failed, failed.dirty, failed.saving], [true, true, false], outcome);
    assert.equal(failed.values.subagentsInheritCompaction, true, `${outcome}: the draft still shows as the draft`);
    assert.equal(settings.read().values.subagentsInheritCompaction, false, `${outcome}: the accepted values did not change`);

    draft.set('showCompactionOption', true);
    assert.equal(draft.getSnapshot().failed, false, `${outcome}: an edit clears the failure`);
    draft.cancel();
    assert.deepEqual(draft.getSnapshot().values, ACCEPTED, `${outcome}: cancel drops every staged change`);
    assert.deepEqual([draft.getSnapshot().dirty, draft.getSnapshot().failed], [false, false]);
  }
});

test('leaving while a save is in flight drops the draft and takes nothing back: the write stands as it was sent, and its late answer, refused, failed or shown by the mirror, brings back neither the draft nor a failure', async () => {
  for (const late of ['refuse', 'reject', 'accept']) {
    const settings = fakeSettings();
    settings.outcome = 'hold';
    const draft = createSettingsDraft({ settings, models: NO_MODELS });
    draft.set('compactionPreset', 'W2');
    draft.set('subagentsInheritCompaction', true);
    settings.push({ revision: 5 });
    const saving = draft.save();
    const sent = structuredClone(settings.writes);
    assert.deepEqual(sent, [{ changes: { compactionPreset: 'W2', subagentsInheritCompaction: true }, expected: 4 }]);

    draft.cancel();
    const left = draft.getSnapshot();
    assert.deepEqual([left.dirty, left.failed], [false, false], `${late}: leaving drops the draft`);
    assert.deepEqual(left.values, ACCEPTED, `${late}: the page is back on what the host accepted`);
    assert.deepEqual(settings.writes, sent, `${late}: the write already sent is neither changed nor repeated`);

    const answer = settings.held[0];
    const changes = sent[0].changes;
    if (late === 'accept') settings.push({ values: { ...ACCEPTED, ...changes }, revision: 6 });
    if (late === 'reject') answer.reject(new Error('the connection dropped'));
    else answer.resolve();
    assert.equal(await saving, late === 'accept', late);
    const after = draft.getSnapshot();
    assert.deepEqual([after.saving, after.dirty, after.failed], [false, false, false], `${late}: nothing is brought back`);
    assert.deepEqual(after.values, late === 'accept' ? { ...ACCEPTED, ...changes } : ACCEPTED, `${late}: the values are the mirror's`);
    assert.equal(draft.set('showCompactionOption', true), true, `${late}: the next visit stages again`);
    assert.deepEqual(draft.getSnapshot().values, { ...after.values, showCompactionOption: true }, `${late}: only what the next visit staged`);
  }
});

const CATALOG = {
  groups: [
    { id: 'p-main', name: 'Main Provider', models: [{ id: 'm-one', name: 'Model One' }, { id: 'm-two', name: 'Model Two' }] },
    { id: 'p-backup', name: 'Backup Provider', models: [{ id: 'm-backup', name: 'Backup Model' }] },
  ],
  failures: [],
};
const deferredCatalog = () => {
  const loads = [];
  return { loads, list: () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); }) };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the model choices come from the catalog the capability lists and nothing else: idle until asked, loading, then each provider\'s models with the display names the catalog gives, and the form picks none for the user', async () => {
  const gate = deferredCatalog();
  const draft = createSettingsDraft({ settings: fakeSettings(), models: gate });
  assert.equal(draft.getSnapshot().catalog.status, 'idle');
  const loading = draft.loadModels();
  assert.equal(draft.getSnapshot().catalog.status, 'loading');
  gate.loads[0].resolve(CATALOG);
  await loading;
  const { catalog, choices, values } = draft.getSnapshot();
  assert.equal(catalog.status, 'ready');
  assert.deepEqual(choices.groups.map(group => [group.id, group.name, group.models.map(model => [model.provider, model.model, model.name])]), [
    ['p-main', 'Main Provider', [['p-main', 'm-one', 'Model One'], ['p-main', 'm-two', 'Model Two']]],
    ['p-backup', 'Backup Provider', [['p-backup', 'm-backup', 'Backup Model']]],
  ]);
  assert.equal(choices.saved, null);
  assert.equal(values.summaryFallbackModel, null, 'the catalog\'s first model is not chosen for the user');
  assert.equal(new Set(choices.groups.flatMap(group => group.models.map(model => model.key))).size, 3, 'each choice has its own key');
});

test('a catalog that fails says so and can be asked again, a provider that failed does not hide the others, and a request a newer one superseded is ignored', async () => {
  const gate = deferredCatalog();
  const draft = createSettingsDraft({ settings: fakeSettings(), models: gate });
  const failing = draft.loadModels();
  gate.loads[0].reject(new Error('the directory is unreachable'));
  await failing;
  assert.deepEqual([draft.getSnapshot().catalog.status, draft.getSnapshot().choices.groups], ['error', []]);
  const retry = draft.loadModels();
  gate.loads[1].resolve({ groups: [CATALOG.groups[0]], failures: [{ id: 'p-down', name: 'Down Provider' }] });
  await retry;
  assert.deepEqual([draft.getSnapshot().catalog.status, draft.getSnapshot().catalog.partial], ['ready', ['Down Provider']]);
  assert.deepEqual(draft.getSnapshot().choices.groups.map(group => group.id), ['p-main'], 'the provider that answered stays');

  const stale = draft.loadModels();
  const fresh = draft.loadModels();
  gate.loads[3].resolve(CATALOG);
  await fresh;
  gate.loads[2].resolve({ groups: [], failures: [] });
  await stale;
  assert.deepEqual(draft.getSnapshot().choices.groups.map(group => group.id), ['p-main', 'p-backup'], 'the older answer did not replace the newer');
  // An invalidation reloads only a catalog that was asked for, and a connection reset drops the draft with it.
  const idle = deferredCatalog();
  const untouched = createSettingsDraft({ settings: fakeSettings(), models: idle });
  untouched.invalidateModels();
  assert.equal(idle.loads.length, 0, 'nothing was asked for, nothing is loaded');
  draft.set('compactionPreset', 'X3');
  draft.reset();
  assert.equal(draft.getSnapshot().dirty, false);
  assert.equal(gate.loads.length, 5, 'the asked-for catalog is read again');
});

test('a saved backup model the catalog does not list stays what the form shows, marked unavailable once the catalog has answered, and can be cleared: no other model is chosen in its place', async () => {
  const settings = fakeSettings({ values: { ...ACCEPTED, summaryFallbackModel: { provider: 'p-gone', model: 'm-gone' } } });
  const gate = deferredCatalog();
  const draft = createSettingsDraft({ settings, models: gate });
  assert.deepEqual(draft.getSnapshot().choices.saved, { key: draft.getSnapshot().choices.saved.key, provider: 'p-gone', model: 'm-gone', unavailable: false }, 'before the catalog answers the route is known, not yet unavailable');
  const loading = draft.loadModels();
  gate.loads[0].resolve(CATALOG);
  await loading;
  assert.equal(draft.getSnapshot().choices.saved.unavailable, true);
  assert.deepEqual(draft.getSnapshot().values.summaryFallbackModel, { provider: 'p-gone', model: 'm-gone' });
  assert.equal(draft.set('summaryFallbackModel', null), true);
  assert.equal(draft.getSnapshot().choices.saved, null, 'cleared');
  assert.equal(await draft.save(), true);
  assert.deepEqual(settings.writes, [{ changes: { summaryFallbackModel: null }, expected: 4 }]);

  const listed = createSettingsDraft({ settings: fakeSettings({ values: { ...ACCEPTED, summaryFallbackModel: BACKUP } }), models: { list: async () => CATALOG } });
  await listed.loadModels();
  assert.equal(listed.getSnapshot().choices.saved, null, 'a route the catalog lists is one of its choices, not an extra');
});
