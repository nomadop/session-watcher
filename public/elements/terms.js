// public/elements/terms.js — Glossary using native <details> element (spec §2 #14)
// Collapsed by default; open/close handled by the browser natively — zero JS needed.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

const TERMS = [
  { term: 'u',          def: 'Normalized position on the cost curve: 0 = start, 1 = sweet spot, 2 = exit. Same value shown in statusline.' },
  { term: 'L',          def: 'Cached context tokens you\'re carrying right now.' },
  { term: 'L_base',     def: 'Cold-start floor — the tokens a fresh session begins with. Restarting can\'t get below it.' },
  { term: 'x',          def: 'How many times over the floor you are: L ÷ L_base. The position axis under the curve.' },
  { term: 'landmarks', def: 'The three dashed lines on the cost curve marking zone boundaries: shallow→sweet, sweet→deep, deep→wall.' },
  { term: 'wall',       def: 'The point where holding one more turn costs as much as a whole restart. Past it you\'re paying full price.' },
  { term: 'burn rate',  def: 'Rent per turn at your current position — how fast the bill meter fills.' },
  { term: 'billProgress', def: 'The rent meter. Fills to 1.00 = you\'ve spent one restart\'s worth by holding.' },
  { term: 'break-even', def: 'Turns until holding costs as much as restarting. Fewer = more urgent.' },
  { term: 'kAvg',       def: 'Typical tokens added per turn once the session settled — anchors the estimates.' },
  { term: 'gₑ',         def: 'Rolling growth rate (EMA of recent per-turn token increments). Used for projection slope.' },
  { term: 'projection', def: 'Dashed line extrapolating L forward at the current growth rate — dashboard-only estimate, not shown in statusline.' },
  { term: 'segment',    def: 'A run between restarts. Each /clear or compact starts a new one; the chart pages by segment.' },
  { term: 'cache miss', def: 'A turn where the cache was rebuilt rather than reused — flagged so it doesn\'t look like real growth.' },
];

export function mount(root, _ctx) {
  const details = document.createElement('details');
  details.className = 'sw-terms';

  const summary = document.createElement('summary');
  summary.className = 'sw-terms-summary';
  summary.innerHTML = `<span class="sw-terms-chev">▸</span>Terms<span class="sw-terms-subtitle">what each number on this page means · plain language, no theory</span>`;

  const dl = document.createElement('dl');
  dl.className = 'sw-terms-list';

  for (const { term, def } of TERMS) {
    const wrapper = document.createElement('div');
    wrapper.className = 'gterm';

    const dt = document.createElement('dt');
    dt.textContent = term;

    const dd = document.createElement('dd');
    dd.textContent = def;

    wrapper.appendChild(dt);
    wrapper.appendChild(dd);
    dl.appendChild(wrapper);
  }

  details.appendChild(summary);
  details.appendChild(dl);
  root.appendChild(details);

  // update() is a no-op: terms are static content
  function update(_snapshot) {}

  function destroy() {
    details.remove();
  }

  return { update, destroy };
}
