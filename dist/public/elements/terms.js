// public/elements/terms.js — Glossary using native <details> element (spec §2 #14)
// Collapsed by default; open/close handled by the browser natively — zero JS needed.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

const TERMS = [
  { term: 'u', def: 'How far past sweet you are, in units of "one optimal session length". u=1 is the sweet spot, u=2 is twice as long as ideal. Compare u across sessions even when task types differ — same u means same relative timing quality.' },
  { term: 'bill premium', def: 'Abbreviated "br". Estimated extra cost vs perfect timing, as a fraction of this session\'s bill — assuming you keep doing similar-sized turns. Accurate when task type is steady; less precise if you switch from heavy generation to pure reading mid-session. Lamp thresholds: green < 10%, yellow 10–24%, red ≥ 25%.' },
  { term: 'movable fraction', def: 'Abbreviated "mf". How much of your bill you could save by restarting at the right time. Heavy-read sessions (big context floor, small steps) have low mf (~18%) because most cost is the floor you\'d re-pay anyway; light-gen sessions (small floor, big steps) have high mf (~38%). br = mf × pp, so same br means same dollar pain regardless of session shape.' },
  { term: 'price penalty', def: 'Abbreviated "pp". Raw timing inefficiency score — how far from optimal on the cost curve. Converted to bill impact by multiplying by mf.' },
  { term: 'L', def: 'Cached context tokens you\'re carrying right now.' },
  { term: 'L_base', def: 'Cold-start floor — the tokens a fresh session begins with. Restarting can\'t get below it.' },
  { term: 'x', def: 'How many times over the floor you are: L ÷ L_base. The position axis under the curve.' },
  { term: 'landmarks', def: 'The dashed lines on the cost curve marking zone boundaries.' },
  { term: 'wall', def: 'The point where holding one more turn costs as much as a whole restart. Past it you\'re paying full price.' },
  { term: 'rent rate', def: 'Rent per turn at your current position — how fast the bill meter fills.' },
  { term: 'billProgress', def: 'The rent meter. Fills to 1.00 = you\'ve spent one restart\'s worth by holding.' },
  { term: 'kAvg', def: 'Typical tokens added per turn once the session settled — anchors the estimates.' },
  { term: 'gₑ', def: 'Rolling growth rate (EMA of recent per-turn token increments). Used for projection slope.' },
  { term: 'segment', def: 'A run between restarts. Each /clear or compact starts a new one; the chart pages by segment.' },
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
