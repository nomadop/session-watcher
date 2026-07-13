// public/elements/bucketTree.js — Locked placeholder for v3 bucket tree (spec §2 #11)
// capabilities.buckets.available is always false in v2.x; shows a gray skeleton + lock.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

export function mount(root, _ctx) {
  const container = document.createElement('div');
  container.className = 'sw-buckets-placeholder';

  container.innerHTML = `
    <h3 class="sw-buckets-header">
      What-if · drop context
      <span class="sw-buckets-lock">🔒 v3 buckets</span>
    </h3>
    <div class="sw-buckets-subtitle">Uncheck a bucket to see the curve if you didn't carry it. Local preview only — never saved.</div>
    <div class="sw-buckets-tree">
      <div class="n"><span class="cb lock"></span><span>dead · baseline floor</span><span class="tok">—</span></div>
      <div class="n"><span class="cb on"></span><span>lib/</span><span class="tok">—</span></div>
      <div class="n indent"><span class="cb on"></span><span>watcher.js</span><span class="tok">—</span></div>
      <div class="n indent"><span class="cb half"></span><span>metrics.js</span><span class="tok">—</span></div>
      <div class="n"><span class="cb on"></span><span>test/</span><span class="tok">—</span></div>
      <div class="n"><span class="cb"></span><span class="special">__residual__</span><span class="tok">—</span></div>
      <div class="n"><span class="cb"></span><span class="special">__other__</span><span class="tok">—</span></div>
    </div>
  `;

  root.appendChild(container);

  // update() is a no-op: placeholder is static until capabilities.buckets.available flips true
  function update(_snapshot) {
    // No-op — bucket tree is gated on capabilities.buckets.available which is
    // always false in v2.x. When v3 ships, replace this element entirely.
  }

  function destroy() {
    container.remove();
  }

  return { update, destroy };
}
