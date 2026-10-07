// dsh/src/client/scope.js — the dashboard sheets confined to the DSH tab root, and the rules the plugin adds beside them: the host-token bridge, the chrome leaf's rules, the light palette and the dock.

const TAB_SCOPE = '[data-sw-tab]';
const KEYFRAMES = /@keyframes\b/y;

/**
 * Returns `css` with every top-level `@keyframes` block hoisted, in source order, before a `@scope (${scope}) { … }` wrapper around the rest, inside which every `:root` selector reads `:scope`.
 * Keyframes are document-global, so they stay outside the wrapper; a `body` rule stays inside and matches nothing, since a scoped rule's subject must be in scope.
 * The scan counts braces, so it holds for a sheet whose comments and strings carry none, as the dashboard's do.
 *
 * @param {string} css
 * @param {string} [scope]
 * @returns {string}
 */
export function scopeStylesheet(css, scope = TAB_SCOPE) {
  const hoisted = [];
  let rest = '';
  let depth = 0;
  let from = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '@' && depth === 0) {
      KEYFRAMES.lastIndex = i;
      if (!KEYFRAMES.test(css)) continue;
      const open = css.indexOf('{', i);
      let end = open + 1;
      for (let inner = 1; inner > 0; end++) {
        if (css[end] === '{') inner++;
        else if (css[end] === '}') inner--;
      }
      rest += css.slice(from, i);
      hoisted.push(css.slice(i, end));
      from = end;
      i = end - 1;
    }
  }
  rest += css.slice(from);
  return `${hoisted.join('\n')}\n@scope (${scope}) {\n${rest.replace(/:root\b/g, ':scope')}\n}\n`;
}

/**
 * The surface, edge and text variables redefined from the host's `--dsw-alias-*` tokens on the tab root, which also takes the box the host pane leaves to its views and carries the gutter the dashboard's `body` carries. The box rules make the root a flex child that can shrink and own its overflow when its pane does not scroll. The inline padding narrows the content to the host's chat column, `--dsh-chat-content-width`, centred inside a full-bleed root, with the transcript's own side inset as the floor.
 * Every other dashboard variable keeps the dashboard sheet's own value.
 */
export const BRIDGE_CSS = `@scope (${TAB_SCOPE}) {
  :scope {
    --bg: var(--dsw-alias-bg-base);
    --bg2: var(--dsw-alias-bg-layer-1);
    --card: var(--dsw-alias-bg-layer-2);
    --card2: var(--dsw-alias-bg-layer-3);
    --edge: var(--dsw-alias-border-l1);
    --txt: var(--dsw-alias-label-primary);
    --txt-dim: var(--dsw-alias-label-secondary);
    --mute: var(--dsw-alias-label-tertiary);
    color: var(--txt);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sw-gutter);
    padding-inline: max(calc(var(--dsh-composer-side-clearance) + 16px), calc((100% - var(--dsh-chat-content-width)) / 2));
  }
}
`;

/**
 * The chrome leaf's tab-only rules, after the dashboard sheets so they override `#sw-chrome`'s alignment: the leaf's children sit at the right edge; the pending badges, connecting and reading, take the amber accent and the failing ones, disconnected, failed and unreachable, the coral accent, the way the dashboard chrome colours them; an unobserved badge takes the muted text and the edge.
 * A `live` badge keeps the sheet's `.sw-chrome-conn` colours. The accents are the palette's variables, so a light scheme reads its own values; the wash variables fall back to the dark literals.
 */
export const CHROME_CSS = `@scope (${TAB_SCOPE}) {
  #sw-chrome {
    justify-content: flex-end;
  }
  .sw-chrome-conn[data-state="connecting"],
  .sw-chrome-conn[data-state="reading"] {
    color: var(--amber);
    background: var(--sw-wash, rgba(255, 194, 77, 0.1));
    border-color: var(--sw-wash-edge, rgba(255, 194, 77, 0.4));
  }
  .sw-chrome-conn[data-state="connecting"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="reading"] .sw-chrome-conn-dot {
    background: var(--amber);
    box-shadow: 0 0 7px var(--amber);
  }
  .sw-chrome-conn[data-state="disconnected"],
  .sw-chrome-conn[data-state="failed"],
  .sw-chrome-conn[data-state="unreachable"] {
    color: var(--coral);
    background: var(--sw-wash, rgba(255, 117, 102, 0.1));
    border-color: var(--sw-wash-edge, rgba(255, 117, 102, 0.4));
  }
  .sw-chrome-conn[data-state="disconnected"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="failed"] .sw-chrome-conn-dot,
  .sw-chrome-conn[data-state="unreachable"] .sw-chrome-conn-dot {
    background: var(--coral);
    box-shadow: 0 0 7px var(--coral);
  }
  .sw-chrome-conn[data-state="unobserved"] {
    color: var(--mute);
    background: transparent;
    border-color: var(--edge);
  }
  .sw-chrome-conn[data-state="unobserved"] .sw-chrome-conn-dot {
    background: var(--mute);
    box-shadow: none;
  }
}
`;

/**
 * The tab root's palette under a light host theme: the `--sw-<role>` variables the dashboard sheets and element scripts read at each literal colour that fails on a light surface, and the accent and zone variables they read: the accents are the text tier, the zone colours the graphic tier.
 * Outside a light scheme no `--sw-<role>` variable is defined, so each use site falls back to its dark literal.
 */
export const LIGHT_CSS = `@scope (${TAB_SCOPE}) {
  :scope[data-sw-scheme="light"] {
    --sw-groove: linear-gradient(180deg, #e2e6ec 0%, #edf0f4 45%, #e6eaef 100%);
    --sw-groove-shadow: inset 0 1px 2px rgba(38, 49, 72, 0.16);
    --sw-hairline: rgba(38, 49, 72, 0.16);
    --sw-highlight: rgba(24, 32, 48, 0.82);
    --sw-glow: 0 0 0 1px rgba(255, 255, 255, 0.8);
    --sw-field: var(--dsw-alias-bg-module-platform);
    --sw-overlay: var(--dsw-alias-bg-layer-2);
    --sw-hover: var(--dsw-alias-interactive-bg-hover);
    --sw-hover-opacity: 1;
    --sw-accent-glow: 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent), 0 1px 5px color-mix(in srgb, currentColor 34%, transparent);
    --sw-cap-glow: none;
    --sw-focus-ring: 0 0 0 2px var(--mint);
    --sw-shadow-float: var(--dsw-elevation-prominent);
    --sw-shadow-drawer: -12px 0 32px 0 rgba(38, 49, 72, 0.1);
    --sw-scrim: var(--dsw-alias-bg-mask-1);
    --sw-on-mint: var(--dsw-alias-label-primary-foreground);
    --sw-on-fill: var(--dsw-alias-label-primary);
    --sw-mint-deep: color-mix(in srgb, var(--mint) 85%, black);
    --sw-faint: var(--dsw-alias-label-tertiary);
    --sw-shade: color-mix(in srgb, currentColor 72%, black);
    --sw-wash: color-mix(in srgb, currentColor 10%, transparent);
    --sw-wash-edge: color-mix(in srgb, currentColor 28%, transparent);
    --sw-skeleton: linear-gradient(90deg, var(--dsw-alias-bg-skeleton) 0%, var(--dsw-alias-interactive-bg-hover) 50%, var(--dsw-alias-bg-skeleton) 100%);
    --sw-ok: var(--mint);
    --sw-bad: var(--coral);
    --mint: #0b7f91;
    --mint-dim: #6cc3d0;
    --sky: #3d57c9;
    --amber: #a46700;
    --amber-dim: #e8bb62;
    --coral: #d1304f;
    --coral-dim: #ee97a6;
    --zone-shallow: #a6dfe8;
    --zone-entry: #6f95ec;
    --zone-sweet: #27b5c9;
    --zone-deep: #efb12e;
    --zone-wall: #d8344f;
  }
}
`;

/**
 * The composer dock's rules, outside every `@scope` wrapper and each starting at a `[data-sw-dock]` element: the pill with its lamp ring, arm arrow and lap badge, and the popover with its header, position track, context stock and alert clock.
 * The popover carries `data-sw-dock` itself because the portal moves it out of the pill's subtree, and wears the host stat dialog's menu surface, prominent elevation and width.
 * Colour comes from the host's `--dsw-*` tokens. A zone colours its element's `color` and everything the zone paints reads `currentColor`, so one rule per zone serves the ring, the track and the clock bar, and the alert box resets its text to the body colour.
 * The track's lit layer lays the bands again over the track's own with the same gap and radius, so a lit band covers its dim one exactly.
 * The pill declares the host pills' font size and line height on the button because it is a sibling of the host's pills, not inside their row, and inherits the composer row's larger reading size otherwise; both read the host's `--dsh-content-font-*` variables.
 * Every full-round radius pairs with `corner-shape: round`, the host's opt-out from the superellipse it sets on every element, which squares such ends off.
 * The lap badge is absolutely positioned at the pill's corner so a count appearing never moves the pill's layout box, and hangs from its left edge, clear of the arrow's tip, so a wider count grows away from the arrow.
 */
export const DOCK_CSS = `button[data-sw-dock] {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
}
button[data-sw-dock]:hover, button[data-sw-dock][aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-sw-dock] [data-zone="white"] {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-dock] [data-zone="green"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-dock] [data-zone="amber"] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-dock] [data-zone="red"] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-dock] .sw-lamp {
  flex: none;
  overflow: visible;
}
[data-sw-dock] .sw-lamp circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}
[data-sw-dock] .sw-lamp .trk {
  stroke: var(--dsw-alias-border-l3);
}
[data-sw-dock] .sw-lamp[data-idle] .trk {
  stroke-dasharray: 1.4 3.1;
}
[data-sw-dock] .sw-lamp .arc {
  stroke-linecap: round;
}
[data-sw-dock] .sw-lamp .core {
  fill: currentColor;
  stroke: none;
}
button[data-sw-dock] .sw-arm {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
button[data-sw-dock] .sw-count {
  position: absolute;
  top: -5px;
  left: calc(100% - 7px);
  box-sizing: border-box;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
button[data-sw-dock] .sw-count[data-hot] {
  box-shadow: 0 0 0 1px var(--dsw-alias-state-error-primary);
}
div[data-sw-dock] {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: min(300px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
div[data-sw-dock] .sw-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
div[data-sw-dock] .sw-title-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
div[data-sw-dock] .sw-title-value {
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-title-value[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}
div[data-sw-dock] .sw-title-rule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
div[data-sw-dock] p {
  margin: 0;
}
div[data-sw-dock] dl {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] dt, div[data-sw-dock] dd {
  min-width: 0;
  margin: 0;
}
div[data-sw-dock] dt {
  display: flex;
  align-items: baseline;
}
div[data-sw-dock] dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
div[data-sw-dock] .sw-rows {
  margin-top: 8px;
}
div[data-sw-dock] .sw-hero {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
div[data-sw-dock] .sw-hero-fig {
  color: var(--dsw-alias-label-primary);
  font-size: 24px;
  line-height: 28px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-hero-cap {
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-hero-pos {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
div[data-sw-dock] .sw-hero-pos .sw-hero-fig {
  font-size: 16px;
}
div[data-sw-dock] .sw-hero-pos small {
  display: block;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
div[data-sw-dock] .sw-track {
  position: relative;
  display: flex;
  gap: 2px;
  height: 6px;
  margin: 14px 0 0;
}
div[data-sw-dock] .sw-track > i {
  border-radius: 3px;
  corner-shape: round;
  background: color-mix(in srgb, currentColor 22%, transparent);
}
div[data-sw-dock] .sw-lit {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 2px;
}
div[data-sw-dock] .sw-lit > i {
  border-radius: 3px;
  corner-shape: round;
  background: color-mix(in srgb, currentColor 88%, transparent);
}
div[data-sw-dock] .sw-track > s {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 0;
  border-left: 1px solid var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-track > b {
  position: absolute;
  top: -4px;
  bottom: -4px;
  box-sizing: border-box;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  corner-shape: round;
  background: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-2);
}
div[data-sw-dock] .sw-scale {
  position: relative;
  height: 16px;
  margin-top: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
div[data-sw-dock] .sw-scale > span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}
div[data-sw-dock] .sw-sec {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
div[data-sw-dock] .sw-ctx-h {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--dsw-alias-label-tertiary);
}
div[data-sw-dock] .sw-ctx-h > span:last-child {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
div[data-sw-dock] .sw-stock {
  display: flex;
  gap: 1px;
  height: 8px;
  margin: 6px 0 8px;
  border-radius: 4px;
  corner-shape: round;
  overflow: hidden;
}
div[data-sw-dock] .sw-stock > i, div[data-sw-dock] .sw-sw {
  background: var(--dsw-alias-label-secondary);
}
div[data-sw-dock] .sw-stock > i[data-k="eff"], div[data-sw-dock] .sw-sw[data-k="eff"] {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 35%, transparent);
}
div[data-sw-dock] .sw-sw {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  margin-right: 8px;
  border-radius: 2px;
  corner-shape: round;
}
div[data-sw-dock] .sw-bar {
  position: relative;
  height: 4px;
  margin: 4px 0;
  border-radius: 2px;
  corner-shape: round;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 22%, transparent);
}
div[data-sw-dock] .sw-bar > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  corner-shape: round;
  background: currentColor;
}
div[data-sw-dock] .sw-alert {
  margin-top: 12px;
  padding: 8px 10px;
  border: 0.5px solid color-mix(in srgb, currentColor 45%, transparent);
  border-radius: var(--dsw-radius-sm);
}
div[data-sw-dock] .sw-alert p {
  color: var(--dsw-alias-label-secondary);
}
`;
