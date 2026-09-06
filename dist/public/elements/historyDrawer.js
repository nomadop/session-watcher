// public/elements/historyDrawer.js — the read-only History drawer.
//
// One snapshot per open from GET /api/turn/browse, one collapsible section per session in the
// lineage carrying the wayfinder headline it shows in place of its rows, one row for a History Turn's
// stored user text and one for its note — a turn with no note text contributes only the user row —
// client-side substring search, and no write path at all. There is no transport module: the one
// snapshot GET goes through browser fetch directly and is awaited where it is made.
//
// Every piece of server-derived text reaches the DOM as textContent. innerHTML is limited to
// module-owned static markup: the drawer shell and the four SVG literals below.

const USER_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="4" r="2"/><path d="M2.5 10c.5-2 1.7-3 3.5-3s3 .9 3.5 3"/></svg>';
const ASSISTANT_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.8v8.4M1.8 6h8.4"/></svg>';
const HISTORY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3zM5.5 5h5M5.5 8h5M5.5 11h3"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';

const BROWSE_URL = '/api/turn/browse';

/**
 * mount(root, _ctx) — History drawer element.
 * root: the #sw-history slot, where historyChart has already placed .sw-history-anchor
 * _ctx: accepted for registry symmetry and deliberately not read
 */
export function mount(root, _ctx) {
  // ── State ──────────────────────────────────────────────────────────────────
  let isOpen = false;
  let sections = [];
  let unavailable = false;
  // A request writes its outcome only while it is still the newest, so an overlapped one cannot land
  // its failure over the sections a newer one has already rendered. Requests can overlap because
  // there is one at mount for the entry's number and one per open.
  let snapshotGeneration = 0;
  let query = '';
  // Single-open accordion: opening one non-empty row closes the previous one.
  let expandedKey = null;
  // Sections are multi-open and every one starts collapsed, so the first open is all wayfinders.
  // Membership is keyed by lineage label rather than by position: a label survives a replacement
  // snapshot, where a position shifts as soon as an earlier session gains its first stored row.
  const expandedLabels = new Set();
  let destroyed = false;

  const anchor = root.querySelector('.sw-history-anchor');
  if (!anchor) return { update() {}, destroy() {} };

  // ── Trigger ────────────────────────────────────────────────────────────────
  const trigger = document.createElement('button');
  trigger.className = 'sw-history-trigger';
  trigger.type = 'button';
  trigger.innerHTML = `${HISTORY_SVG} History`;
  anchor.appendChild(trigger);

  // How many segments the drawer holds, read off the same response the list is built from, so the
  // number can never name a segment the drawer does not have. It counts the snapshot rather than the
  // rendered list: a search term filters the list and leaves the number alone, because what the entry
  // answers is how much is behind it, not how much a filter left showing. It is mounted only where
  // the response supports a number: an unavailable response retracts it rather than reporting none,
  // which would be a claim about the lineage that a failed request does not make. An empty lineage
  // carries no number either — the drawer's own empty state is what says there is nothing.
  const countEl = document.createElement('span');
  countEl.className = 'sw-history-count';
  const paintCount = () => {
    if (unavailable || sections.length === 0) { countEl.remove(); return; }
    countEl.textContent = String(sections.length);
    trigger.appendChild(countEl);
  };

  // ── Scrim + panel ──────────────────────────────────────────────────────────
  const scrim = document.createElement('div');
  scrim.className = 'sw-history-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  document.body.appendChild(scrim);

  const drawer = document.createElement('aside');
  drawer.className = 'sw-history-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'History');
  drawer.setAttribute('aria-modal', 'true');
  drawer.innerHTML = `
    <header class="sw-history-head">
      <div class="sw-history-title-row">
        <h2 class="sw-history-title">History</h2>
        <button class="sw-history-close" type="button" aria-label="Close history">×</button>
      </div>
      <label class="sw-history-search">
        ${SEARCH_SVG}
        <input type="search" aria-label="Search history"
               placeholder="Search turns and notes" autocomplete="off">
      </label>
    </header>
    <div class="sw-history-list"></div>
  `;
  document.body.appendChild(drawer);

  const closeBtn = drawer.querySelector('.sw-history-close');
  const listEl = drawer.querySelector('.sw-history-list');
  const searchEl = drawer.querySelector('.sw-history-search input');

  // ── Helpers ────────────────────────────────────────────────────────────────

  // The snapshot carries no per-row identity, so expansion keys off the section's label plus the
  // row's position inside that section. Rows run oldest → newest and only ever append, so an existing
  // row keeps its position from one snapshot to the next, and a session gaining its first stored row
  // between two opens shifts nothing outside its own section.
  const rowKey = (label, index, side) => `${label}:${index}:${side}`;

  // A search term forces every rendered section open, so a match is never left behind a wayfinder.
  // The forced state is this expression rather than a second stored set, so clearing the term returns
  // every section to the one the reader built by clicking.
  const isSectionOpen = (label) => query !== '' || expandedLabels.has(label);

  // One turn matches, so a matched U and its A never separate — the pairing is the list's point. The
  // session label is not in the corpus: it would make a bare `S1` also match `S10` upward. Neither is
  // the headline: a section matching on its wayfinder alone would render holding no row, and a
  // rendered section always having rows is what lets the term above force it open for free.
  function matches(entry) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return `${entry.u_text}\n${entry.note ?? ''}`.toLowerCase().includes(needle);
  }

  function createRow(entry, side, key) {
    const isUser = side === 'u';
    const body = isUser ? entry.u_text : (entry.note ?? '');
    const expandable = body !== '';
    const expanded = expandable && expandedKey === key;

    const row = document.createElement('article');
    row.className = 'sw-history-row';
    row.dataset.role = isUser ? 'user' : 'assistant';
    row.dataset.expanded = String(expanded);

    const glyph = document.createElement('span');
    glyph.className = 'sw-history-role';
    glyph.setAttribute('role', 'img');
    glyph.setAttribute('aria-label', isUser ? 'User' : 'Assistant');
    glyph.innerHTML = isUser ? USER_SVG : ASSISTANT_SVG;
    row.appendChild(glyph);

    if (!expandable) {
      // Only the U side reaches here: renderList builds no A row for an empty note, and the capture
      // path cannot produce an empty u_text — cleanUserText and cleanAskAnswer open a turn only on a
      // non-empty cleaned projection. The branch stays anyway because dropping it is worse than
      // inert: an empty body would then take role="button" and a tab stop, naming nothing and
      // expanding to nothing. A plain div has no button role, no tab stop and no handler.
      const empty = document.createElement('div');
      empty.className = 'sw-history-preview';
      row.appendChild(empty);
      return row;
    }

    const main = document.createElement('div');
    main.className = 'sw-history-main';
    main.setAttribute('role', 'button');
    main.setAttribute('tabindex', '0');
    main.setAttribute('aria-expanded', String(expanded));

    const preview = document.createElement('div');
    preview.className = 'sw-history-preview';
    preview.textContent = body;
    main.appendChild(preview);
    row.appendChild(main);

    // The full text is a SIBLING of the control, never a child of it. Inside the control, a selection
    // dragged from the full text out into the preview dispatches its click on their nearest common
    // ancestor — the control — so the row collapsed and destroyed the selection whatever the detail
    // did with propagation; and the control's name is computed from its contents, so an expanded row
    // announced the whole note as its label. Out here the common ancestor is the row, which has no
    // handler, so no propagation guard is needed and the control's name stays the preview line.
    const detail = document.createElement('div');
    detail.className = 'sw-history-detail';
    const copy = document.createElement('div');
    copy.className = 'sw-history-copy';
    copy.textContent = body;
    detail.appendChild(copy);
    row.appendChild(detail);

    const toggle = () => {
      // In place, not a re-render. Membership has not changed — only which row is open — and
      // replacing the list's children would zero its scrollTop on the drawer's most frequent
      // interaction, then land the reader wherever focus() chose.
      const previous = listEl.querySelector('.sw-history-row[data-expanded="true"]');
      if (previous && previous !== row) {
        previous.dataset.expanded = 'false';
        previous.querySelector('.sw-history-main')?.setAttribute('aria-expanded', 'false');
      }
      const next = expandedKey !== key;
      expandedKey = next ? key : null;
      row.dataset.expanded = String(next);
      main.setAttribute('aria-expanded', String(next));
    };
    main.addEventListener('click', toggle);
    main.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });

    return row;
  }

  // rows: the section's matching entries, each carrying its position inside the section's own list,
  // so a row keeps its expansion key while a search term hides its neighbours.
  function createSection({ label, headline }, rows) {
    const section = document.createElement('section');
    section.className = 'sw-history-section';
    section.setAttribute('aria-label', label);

    const divider = document.createElement('div');
    divider.className = 'sw-history-divider';
    divider.setAttribute('role', 'button');
    divider.setAttribute('tabindex', '0');
    const labelEl = document.createElement('strong');
    labelEl.textContent = label;
    divider.appendChild(labelEl);
    section.appendChild(divider);

    const paint = () => {
      const open = isSectionOpen(label);
      section.dataset.expanded = String(open);
      divider.setAttribute('aria-expanded', String(open));
    };
    paint();

    const toggle = () => {
      // In place, not a re-render, for the reason the row's toggle is: membership has not changed,
      // and replacing the list's children would zero its scrollTop. The rows and the collapsed block
      // both hang off this one attribute in CSS, so a row left open inside a collapsed section is
      // untouched and comes back open. A click while a search term is active records the reader's
      // intent in the set and leaves the forced-open view alone, as paint reads the one expression.
      if (expandedLabels.has(label)) expandedLabels.delete(label);
      else expandedLabels.add(label);
      paint();
    };
    divider.addEventListener('click', toggle);
    divider.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });

    // The head rides the divider line in both states, so a reader scrolled deep inside an expanded
    // section still sees which segment they are in. It carries the whole headline and is clipped by
    // CSS rather than cut here: there is no character budget to pick and no marker owed.
    //
    // It is aria-hidden, so the control's accessible name is the label alone. The head is a visual
    // preview of text the sibling block carries authoritatively, which makes it duplicative content
    // rather than the control's name — and since the clipping is CSS, an unhidden head would put the
    // WHOLE headline into that name and turn a long wayfinder into a multi-sentence button. Hiding it
    // also stops the collapsed state announcing the wayfinder twice.
    //
    // The block is a SIBLING of the control, for the reason the row's full text is one: a control's
    // accessible name is computed from its contents, so a wayfinder nested in the divider would
    // announce as the control's name. It stays in the accessibility tree as the authoritative read.
    // It carries the toggle as well, so the whole collapsed body is the toggle's surface rather than
    // the divider line alone, and CSS makes it unselectable: a selection dragged across it would be
    // destroyed by the click that ends the drag — the failure the row's detail moved out of its own
    // control to avoid — and here the surface IS the text, so there is nowhere to move it to.
    //
    // An empty headline leaves the section with no wayfinder to show — no head and no block. The
    // divider still carries its label and still toggles.
    if (headline !== '') {
      const head = document.createElement('span');
      head.className = 'sw-history-headline-head';
      head.setAttribute('aria-hidden', 'true');
      head.textContent = headline;
      divider.appendChild(head);
      const block = document.createElement('div');
      block.className = 'sw-history-headline';
      block.textContent = headline;
      block.addEventListener('click', toggle);
      section.appendChild(block);
    }

    for (const { entry, index } of rows) {
      section.appendChild(createRow(entry, 'u', rowKey(label, index, 'u')));
      // A turn with no note text contributes no A row. An absent note means the assistant did
      // nothing in that turn — submitTurnNotes requires a note for exactly the turns that had
      // assistant activity — so the absence is informative rather than lossy, and neither an empty
      // cell nor a marker is owed. A note submitted as an empty string renders the same way: there
      // is no text to show either way.
      if ((entry.note ?? '') !== '') {
        section.appendChild(createRow(entry, 'a', rowKey(label, index, 'a')));
      }
    }

    return section;
  }

  // Called only when list MEMBERSHIP changes: a replacement snapshot, or a search input event.
  function renderList() {
    listEl.textContent = '';

    if (unavailable) {
      const state = document.createElement('div');
      state.className = 'sw-history-empty';
      state.textContent = 'History is unavailable right now. Close and reopen the drawer to retry.';
      listEl.appendChild(state);
      return;
    }

    // A section renders only where it holds a matching row, so an empty search result is the whole
    // list's empty state rather than a wall of wayfinders with nothing under them.
    const visible = sections
      .map((section) => ({
        section,
        rows: section.entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => matches(entry)),
      }))
      .filter(({ rows }) => rows.length > 0);

    if (visible.length === 0) {
      const state = document.createElement('div');
      state.className = 'sw-history-empty';
      state.textContent = query
        ? `No turns match “${query}”.`
        : 'No stored turns are available.';
      listEl.appendChild(state);
    } else {
      for (const { section, rows } of visible) listEl.appendChild(createSection(section, rows));
    }

    const marker = document.createElement('div');
    marker.className = 'sw-history-horizon';
    // Static scope copy, not response state. It carries no number or count: its only job is to name
    // the boundary, not to introduce a second measurement with no downstream action.
    marker.textContent = 'Current-session turns are not included.';
    listEl.appendChild(marker);
  }

  // null for every way the response fails to carry a list. Not `?? []`: an empty list renders as "no
  // stored turns", a claim this response does not support, so a 200 carrying no array lands in the
  // same unavailable state as a 500 does.
  async function fetchSections() {
    try {
      const res = await fetch(BROWSE_URL);
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body?.sections) ? body.sections : null;
    } catch {
      return null;
    }
  }

  async function loadSnapshot() {
    const generation = ++snapshotGeneration;
    const next = await fetchSections();
    if (generation !== snapshotGeneration) return;
    unavailable = next === null;
    if (next) sections = next;
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  async function openDrawer() {
    if (isOpen) return;
    isOpen = true;

    drawer.classList.add('sw-history-drawer-open');
    scrim.classList.add('sw-history-scrim-visible');
    scrim.setAttribute('aria-hidden', 'false');
    document.querySelector('.sw-wrap')?.setAttribute('inert', '');
    // Move focus into the modal before awaiting I/O; otherwise the active element is the trigger
    // inside the background subtree that was just made inert.
    searchEl.focus();

    // Keep the previous snapshot, search filter and expansion visible while the local request
    // resolves; the completed request is rendered through that same UI state and replaces the view
    // atomically with either the new list or the unavailable state. Overlapping opens are not
    // versioned or aborted; the last completion wins. On the first open there is no previous RENDER
    // to keep, and renderList below is the only thing that puts a list in the DOM, so the shell stays
    // empty until this path reaches it.
    await loadSnapshot();
    if (destroyed) return;
    paintCount();
    if (!isOpen) return;
    // Capture at replacement time, not request start: the retained snapshot stays interactive while
    // fetch is pending, and a scroll made during that interval is the position to preserve.
    const savedScrollTop = listEl.scrollTop;
    renderList();
    // The first open has no position to preserve, so this same restore leaves the reader at the top —
    // the list opens at its oldest section, which is where the wayfinders start.
    requestAnimationFrame(() => { listEl.scrollTop = savedScrollTop; });
  }

  function closeDrawer() {
    if (!isOpen) return;
    isOpen = false;
    drawer.classList.remove('sw-history-drawer-open');
    scrim.classList.remove('sw-history-scrim-visible');
    scrim.setAttribute('aria-hidden', 'true');
    document.querySelector('.sw-wrap')?.removeAttribute('inert');
    trigger.focus();
  }

  trigger.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);

  searchEl.addEventListener('input', (event) => {
    query = event.target.value.trim();
    expandedKey = null;
    // Membership changes here, so the list is rebuilt — and replacing its children is also what
    // returns it to the top, which is the intended search reset.
    renderList();
  });

  function onKeydown(event) {
    if (event.key !== 'Escape' || !isOpen) return;
    // Blink treats Escape on a non-empty input[type="search"] as a clear, and it applies that default
    // AFTER this handler has moved focus to the trigger — emptying the field without firing an input
    // event, so `query` would keep filtering with nothing on screen to explain it. Suppressing the
    // default keeps the field, `query` and the rendered list in agreement across close/reopen. The
    // native cancel button still clears the field while the drawer is open.
    event.preventDefault();
    closeDrawer();
  }
  document.addEventListener('keydown', onKeydown);

  // One fetch at mount, for the entry's number alone — and it costs a whole browse snapshot, not a
  // count, on a dashboard where the drawer may never be opened. It is paid again on every remount,
  // which a theme change performs for every element. Opening still refetches: a dashboard left
  // standing would otherwise offer history as old as its page.
  loadSnapshot().then(() => { if (!destroyed) paintCount(); });

  return {
    // One snapshot at mount and one per open (no polling), so a store update is not a reason to
    // refetch.
    update() {},
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKeydown);
      document.querySelector('.sw-wrap')?.removeAttribute('inert');
      scrim.remove();
      drawer.remove();
      anchor.textContent = '';
    },
  };
}
