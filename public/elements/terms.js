// public/elements/terms.js — Glossary using native <details> element (spec §2 #14)
// Collapsed by default; open/close handled by the browser natively — zero JS needed.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

const TERMS = [
  { term: 'u', def: 'How far past sweet you are, in units of "one optimal session length". u=1 is the sweet spot, u=2 is twice as long as ideal. Compare u across sessions even when task types differ — same u means same relative timing quality.' },
  { term: 'bill premium', def: 'Abbreviated "br". Estimated extra cost vs perfect timing, as a fraction of this session\'s bill — assuming you keep doing similar-sized turns. Accurate when task type is steady; less precise if you switch from heavy generation to pure reading mid-session. Lamp thresholds: green < 10%, amber ≥ 10%, red ≥ 25%.' },
  { term: 'movable fraction', def: 'Abbreviated "mf". How much of your bill you could save by restarting at the right time. Heavy-read sessions (big context floor, small steps) have low mf (~18%) because most cost is the floor you\'d re-pay anyway; light-gen sessions (small floor, big steps) have high mf (~38%). br = mf × pp, so same br means same dollar pain regardless of session shape.' },
  { term: 'price penalty', def: 'Abbreviated "pp". Raw timing inefficiency score — how far from optimal on the cost curve. Converted to bill impact by multiplying by mf.' },
  { term: 'L', def: 'Cached context tokens you\'re carrying right now.' },
  { term: 'B', def: 'Rebuild baseline — the tokens you\'d re-pay on a fresh session (system prompt + tools + files read so far). Grows as the session discovers more context. The cost curve is anchored to B.' },
  { term: 'x', def: 'How many times over the baseline you are: L ÷ B. The position axis under the curve. x=1 means you\'re at the restart floor; x>1 means you\'re carrying avoidable context.' },
  { term: 'landmarks', def: 'The dashed lines on the cost curve marking zone boundaries.' },
  { term: 'wall', def: 'The point where holding one more turn costs as much as a whole restart. Past it you\'re paying full price.' },
  { term: 'rent rate', def: 'Instantaneous burn rate at your current position — how fast the cycle bar fills per turn.' },
  { term: 'cycle bar', def: 'The micro-timescale meter. Fills to 100% = you\'ve accumulated one restart\'s worth of avoidable rent. Resets and increments the bill-cycle count on overflow.' },
  { term: 'depth bar', def: 'The macro-timescale meter. Activates after the notification gate fires (first sustained amber). Tracks progress toward the next backstop reminder — each full lap fires another reminder.' },
  { term: 'gₑ', def: 'Rolling growth rate (EMA of recent per-call residual increments). Anchors the cost curve shape and projection slope.' },
  { term: 'segment', def: 'A continuous run of conversation. A new segment begins whenever context is reset or carried over to a fresh session; the chart pages by segment.' },
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
