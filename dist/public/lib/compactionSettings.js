// public/lib/compactionSettings.js — the compaction settings form's logic: the shape and validation of the four settings and the staged draft over them.
// It sees plain data and two capabilities handed in, `settings` (read, subscribe, write) and `models` (list), so a DSH page and a dashboard page can each supply their own: no Cordis, DSH, React or DOM is behind it.

/** The compaction policies, from the most aggressive to the most conservative; the host's presets hold the same ids. */
export const PRESET_IDS = Object.freeze(['E2', 'W2', 'M2', 'S3', 'X3']);

const isRoute = value => value !== null && typeof value === 'object' && ['provider', 'model'].every(key => typeof value[key] === 'string' && value[key] !== '');

// What each setting accepts; a setting not here does not exist.
const VALID = {
  showCompactionOption: value => typeof value === 'boolean',
  compactionPreset: value => PRESET_IDS.includes(value),
  summaryFallbackModel: value => value === null || isRoute(value),
  subagentsInheritCompaction: value => typeof value === 'boolean',
};
const FIELDS = Object.keys(VALID);

// The key of a route in a choice list: opaque, looked up and never parsed; it names the pair unambiguously and holds no character a markup attribute cannot.
const routeKey = route => JSON.stringify([route.provider, route.model]);

// A route is its two ids; every other value is its own.
const same = (a, b) => a === b || (isRoute(a) && isRoute(b) && a.provider === b.provider && a.model === b.model);

// The accepted values as the form holds them: a backup model the host leaves out is none.
const normalized = values => ({ ...values, summaryFallbackModel: values.summaryFallbackModel ?? null });

/**
 * One form over `settings`, `{ read, subscribe, write }`: `read()` answers `{ status: 'loading' | 'ready' | 'unavailable', values, revision, writable }` of what the host accepted, `subscribe(listener)` answers the unsubscribe, and `write(changes, revision)` settles once the host has answered the changes it was fenced with the revision of, rejecting where it could not be asked: what the host accepted is what `read()` then answers, the one authority of whether a save landed.
 * `models.list()` resolves the catalog, `{ groups: [{ id, name, models: [{ id, name }] }], failures: [{ id, name }] }`, and rejects where it cannot be read.
 * The form answers `getSnapshot()` and `subscribe(listener)` for what a view renders and `set`, `save`, `cancel`, `loadModels`, `invalidateModels` and `reset` for what it does.
 * The backup model's choices are the catalog's and nothing else: none is picked for the user, and a saved route the catalog does not list stays what the form shows, marked unavailable once the catalog has answered.
 *
 * @param {{ settings: object, models: { list: () => Promise<{ groups: object[], failures: object[] }> } }} capabilities
 */
export function createSettingsDraft({ settings, models }) {
  const listeners = new Set();
  // The staged changes over the accepted values, the revision the first of them was staged against, and what the last save did.
  let draft = {};
  let draftRevision;
  let saving = false;
  let failed = false;
  // The catalog: its state, what it answered and the request that stands, so an older answer never replaces a newer one.
  let catalog = { status: 'idle', groups: [], partial: [] };
  let request = 0;
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const unsubscribe = settings.subscribe(changed);

  // The catalog's groups with a key for each model, and the route the form holds where the catalog does not list it.
  function choicesOf(route) {
    const groups = catalog.groups.map(({ id, name, models: listed }) => ({
      id, name, models: listed.map(model => ({ key: routeKey({ provider: id, model: model.id }), provider: id, model: model.id, name: model.name })),
    }));
    const listed = route !== null && groups.some(group => group.models.some(model => model.provider === route.provider && model.model === route.model));
    const saved = route === null || listed ? null : { key: routeKey(route), provider: route.provider, model: route.model, unavailable: catalog.status === 'ready' };
    return { groups, saved };
  }

  function snapshot() {
    const state = settings.read();
    const shown = { status: catalog.status, partial: catalog.partial };
    if (state.status !== 'ready') return { status: state.status, writable: false, values: null, dirty: false, saving, failed, catalog: shown, choices: choicesOf(null) };
    const accepted = normalized(state.values);
    const values = { ...accepted, ...draft };
    return {
      status: 'ready', writable: state.writable, values, dirty: FIELDS.some(field => !same(values[field], accepted[field])), saving, failed,
      catalog: shown, choices: choicesOf(values.summaryFallbackModel),
    };
  }

  const clear = () => { draft = {}; draftRevision = undefined; failed = false; };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(field, value) {
      const state = settings.read();
      if (state.status !== 'ready' || !state.writable || saving || !Object.hasOwn(VALID, field) || !VALID[field](value)) return false;
      if (Object.keys(draft).length === 0) draftRevision = state.revision;
      if (same(normalized(state.values)[field], value)) delete draft[field];
      else draft = { ...draft, [field]: value };
      failed = false;
      changed();
      return true;
    },
    /** Writes the staged changes alone, fenced by the revision the draft began at; resolves whether the host's mirror shows them afterwards. */
    async save() {
      const { dirty, writable, status, values } = snapshot();
      if (saving || status !== 'ready' || !writable || !dirty) return false;
      const stored = normalized(settings.read().values);
      const changes = Object.fromEntries(FIELDS.filter(field => !same(values[field], stored[field])).map(field => [field, values[field]]));
      saving = true;
      failed = false;
      changed();
      let landed = false;
      try {
        await settings.write(changes, draftRevision);
        const now = settings.read();
        landed = now.status === 'ready' && FIELDS.every(field => !(field in changes) || same(normalized(now.values)[field], changes[field]));
      } catch {
        landed = false;
      }
      saving = false;
      // A cancel while the write was pending dropped the draft; a failure then has nothing on screen to belong to.
      if (landed) clear();
      else failed = Object.keys(draft).length > 0;
      changed();
      return landed;
    },
    cancel() {
      clear();
      changed();
    },
    /** Reads the catalog, superseding a read in flight; a failed read leaves an error state a later call replaces. */
    async loadModels() {
      const mine = ++request;
      catalog = { ...catalog, status: 'loading' };
      changed();
      let next;
      try {
        const { groups, failures } = await models.list();
        next = { status: 'ready', groups, partial: failures.map(failure => failure.name) };
      } catch {
        next = { status: 'error', groups: [], partial: [] };
      }
      if (mine !== request) return;
      catalog = next;
      changed();
    },
    /** A model input changed: a catalog that was asked for is read again, one never asked for stays unread. */
    invalidateModels() {
      if (catalog.status !== 'idle') void this.loadModels();
    },
    /** The connection began again: the draft was staged against a host that may no longer be there. */
    reset() {
      if (!saving) clear();
      this.invalidateModels();
      changed();
    },
    dispose() { unsubscribe(); },
  };
}
