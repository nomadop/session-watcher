// dsh/src/client/scope.js — the dashboard sheets confined to the DSH tab root, and the rules the plugin adds beside them: the host-token bridge, the chrome leaf's rules, the light palette, the dock, the session mode's entries and the inner compaction monitor.
import { LIST_MIN_WIDTH, DRAWER_MIN_WIDTH } from './monitor-state.js';

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

/** The session mode's entries outside every `@scope` wrapper: the toggle's pill and its switch, and the read-only mark, which takes the font size, line height, height, fill, colour and radius of the host's agent-preset label beside it and hides at the same title-row width. */
export const MODE_CSS = `button[data-sw-mode-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  padding: 1px 8px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
}
button[data-sw-mode-toggle]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
button[data-sw-mode-toggle]:disabled {
  cursor: default;
  opacity: 0.6;
}
[data-sw-mode-toggle] .sw-mode-track {
  position: relative;
  flex: none;
  width: 20px;
  height: 12px;
  border-radius: 999px;
  corner-shape: round;
  background: currentColor;
  opacity: 0.45;
}
[data-sw-mode-toggle] .sw-mode-track i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-label-primary);
}
[data-sw-mode-toggle][aria-checked="true"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-mode-toggle][aria-checked="true"] .sw-mode-track i {
  left: 10px;
}
span[data-sw-mode-mark] {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-fill-tsp-secondary);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 22px;
  white-space: nowrap;
}
@container (max-width: 540px) {
  span[data-sw-mode-mark] {
    display: none;
  }
}
`;

/** The settings category's rules: DSH's own tokens, type sizes and row, field and button shapes, so the page sits beside its sibling categories in either theme. Outside every `@scope` wrapper: the page renders in the settings panel, not in the tab. */
export const SETTINGS_CSS = `.sw-set {
  display: flex;
  flex-direction: column;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.sw-set-heading {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 600;
}
.sw-set-group {
  margin: 20px 0 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.sw-set-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.sw-set-text {
  flex: 1 1 240px;
  min-width: 0;
}
.sw-set-title {
  font-size: 14px;
  line-height: 20px;
}
.sw-set-desc {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.sw-set-control {
  flex: 0 0 auto;
  max-width: 100%;
}
.sw-set-switch {
  box-sizing: border-box;
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
}
.sw-set-switch[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary);
}
.sw-set-switch:disabled {
  cursor: default;
  opacity: 0.5;
}
.sw-set-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.sw-set-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.sw-set-switch[aria-checked='false'] .sw-set-switch-thumb {
  background: var(--dsw-alias-switch-thumb);
}
.sw-set-switch[aria-checked='true'] .sw-set-switch-thumb {
  transform: translateX(16px);
}
.sw-set-select {
  box-sizing: border-box;
  width: 260px;
  max-width: 100%;
  height: 32px;
  padding: 0 32px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background-color: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
}
.sw-set-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.sw-set-select:disabled {
  opacity: 0.6;
  cursor: default;
}
.sw-set-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.sw-set-error {
  color: var(--dsw-alias-state-error-primary);
}
.sw-set-integration {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.sw-set-integration p {
  margin: 0;
}
.sw-set-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.sw-set-link:disabled {
  opacity: 0.4;
  cursor: default;
}
.sw-set-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
}
.sw-set-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.sw-set-button {
  appearance: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.sw-set-save {
  border-color: transparent;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.sw-set-button:disabled {
  opacity: 0.4;
  cursor: default;
}
.sw-set-button:focus-visible,
.sw-set-link:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
`;

// Below this container width the list's and the drawer's smallest widths no longer fit side by side.
const DRAWER_OVERLAY_BELOW_PX = LIST_MIN_WIDTH + DRAWER_MIN_WIDTH;

/**
 * The inner compaction monitor's rules outside every `@scope` wrapper, each starting at a `[data-sw-monitor]` element.
 * The rules use the host's `--dsw-alias-*` color tokens, its `--dsw-font-*` type-scale shorthands where a rule takes one, `--ds-font-family-code`, `--dsw-radius-sm` and `--dsw-focus-ring-*` tokens; the root sets the tabular figures, and a rule whose `font` shorthand resets `font-variant-numeric` inherits it again; the one variable that is not the host theme's is `--dsh-composer-height`, which the conversation shell publishes: the root keeps the list pane's end clear of the composer that the shell's `data-conversation-composer-overlay` rules float over the view, and until the shell has published it keeps the space the shell's own views assume, so that a list placed at its tail before the variable arrives ends clear of a composer no taller than that space.
 * The root fills the view area and the list pane scrolls inside it, so the pane, and not the conversation's scrollport, is what is placed at its tail when the view first lays out.
 * The drawer never narrows the list below its smallest width; where the split is narrower than the list and the drawer need together, a size container query lays the drawer over the list's right edge instead, at the width the user set up to the split's.
 * A row is a compact item: a title line whose status and meta wrap onto further lines as the width needs, and a preview line cut with an ellipsis: a call's response takes the whole line, a slot's width is shared between the input and the response in the golden ratio. A placeholder row, which stands where an open group's leaves are being read, could not be read or are none, is one line of secondary text, with a spinner while the read is in progress. A settlement row has no toggle, so its title is indented by `--sw-mon-chevron-width` plus `--sw-mon-chevron-gap`, the variables the chevron and the toggle read, and starts where the titles of the rows that fold start.
 * The drawer's pages set text and JSON in wrapping preformatted blocks, so a long line is read whole without widening the drawer; the pages' tabs, folds and tags use the same tokens as the list.
 * The file list of the evidence and files pages is a size container of its own, as wide as the drawer body: below its narrow width the statistics column shrinks and the segment count goes. An open file's head, its path and statistics, sticks to the top edge of the body; its `top` is the body's upper padding negated, a sticky offset being measured inside that padding. A file's lines wrap by default; with wrapping off each file scrolls sideways on its own while its line numbers and its gap and withdrawn rows stay at its left. The host defines no `--dsw-alias-fill-*` token, so the position bar's track and a gap row take the host's hover fill; the light theme's first and second layer are one colour, so a file's head and meta line take a tint of the second layer toward the label.
 */
export const MONITOR_CSS = `[data-sw-monitor] {
  --sw-mon-chevron-width: 5px;
  --sw-mon-chevron-gap: 6px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding-bottom: calc(var(--dsh-composer-height, 152px) + 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
  font-variant-numeric: tabular-nums;
}
[data-sw-monitor] .sw-mon-notice {
  margin: 0;
  padding: 24px 20px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] > .sw-mon-notice {
  text-align: center;
}
[data-sw-monitor] .sw-mon-split {
  container: sw-monitor / inline-size;
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
[data-sw-monitor] .sw-mon-pane {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
[data-sw-monitor] .sw-mon-row {
  position: relative;
  box-sizing: border-box;
  padding: 6px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  cursor: pointer;
  outline: none;
}
[data-sw-monitor] .sw-mon-row[data-sw-row="attempt"],
[data-sw-monitor] .sw-mon-row[data-sw-row="handoff"],
[data-sw-monitor] .sw-mon-row[data-sw-row="settlement"] {
  border-bottom-color: var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-mon-row[aria-level="2"] {
  padding-left: 32px;
}
[data-sw-monitor] .sw-mon-row[aria-level="2"]::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: -0.5px;
  left: 14px;
  width: 2px;
  background: var(--dsw-alias-border-l2);
  pointer-events: none;
}
[data-sw-monitor] .sw-mon-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 10px;
  min-width: 0;
}
[data-sw-monitor] .sw-mon-title {
  min-width: 0;
}
[data-sw-monitor] .sw-mon-row[data-sw-row="attempt"] .sw-mon-title,
[data-sw-monitor] .sw-mon-row[data-sw-row="handoff"] .sw-mon-title,
[data-sw-monitor] .sw-mon-row[data-sw-row="settlement"] .sw-mon-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}
[data-sw-monitor] .sw-mon-row[data-sw-row="settlement"] .sw-mon-title {
  padding-left: calc(var(--sw-mon-chevron-width) + var(--sw-mon-chevron-gap));
}
[data-sw-monitor] .sw-mon-row[aria-level="2"] .sw-mon-title {
  margin-bottom: 2px;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-mon-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
}
@media (hover: hover) {
  [data-sw-monitor] .sw-mon-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
[data-sw-monitor] .sw-mon-row[data-sw-row="placeholder"] {
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
[data-sw-monitor] .sw-mon-spinner {
  flex: none;
  align-self: center;
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  border-radius: 50%;
  animation: sw-mon-spin 0.9s linear infinite;
}
@keyframes sw-mon-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-sw-monitor] .sw-mon-spinner {
    animation: none;
  }
}
[data-sw-monitor] .sw-mon-row[aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active);
}
[data-sw-monitor] .sw-mon-row[aria-selected="true"]::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: -0.5px;
  left: 0;
  width: 2px;
  background: var(--dsw-alias-state-business-primary);
  pointer-events: none;
}
[data-sw-monitor] .sw-mon-row:focus-visible {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sw-mon-chevron-gap);
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
[data-sw-monitor] .sw-mon-chevron {
  flex: none;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 3.5px 0 3.5px var(--sw-mon-chevron-width);
  border-color: transparent transparent transparent currentColor;
  transition: transform 120ms ease-in-out;
}
[data-sw-monitor] .sw-mon-toggle[aria-expanded="true"] .sw-mon-chevron {
  transform: rotate(90deg);
}
[data-sw-monitor] .sw-mon-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
[data-sw-monitor] .sw-mon-in,
[data-sw-monitor] .sw-mon-out {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-sw-monitor] .sw-mon-in {
  flex: 38.2 1 0;
}
[data-sw-monitor] .sw-mon-out {
  flex: 61.8 1 0;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-mon-row[data-sw-row="attempt"] .sw-mon-out,
[data-sw-monitor] .sw-mon-row[data-sw-row="handoff"] .sw-mon-out,
[data-sw-monitor] .sw-mon-row[data-sw-row="call"] .sw-mon-out,
[data-sw-monitor] .sw-mon-row[data-sw-row="content"] .sw-mon-out {
  color: inherit;
}
[data-sw-monitor] .sw-mon-arrow {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-status {
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-mon-status[data-status="committed"],
[data-sw-monitor] .sw-mon-status[data-status="received"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-monitor] .sw-mon-status[data-status="paid"] {
  color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-status[data-status="failed"],
[data-sw-monitor] .sw-mon-status[data-status="error"] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-monitor] .sw-mon-status[data-status="cancelled"] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-mon-status[data-status="generating"],
[data-sw-monitor] .sw-mon-status[data-status="validating"] {
  color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-status[data-status="unknown"],
[data-sw-monitor] .sw-mon-status[data-status="absent"] {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] [data-type="load"] {
  color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] [data-type="continue"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-monitor] .sw-mon-row[data-sw-attention] {
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-mon-meta-item[data-sw-attention] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-mon-drawer {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  box-sizing: border-box;
  max-width: calc(100% - ${LIST_MIN_WIDTH}px);
  min-width: 0;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
[data-sw-monitor] .sw-mon-handle {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
  outline: none;
  touch-action: none;
}
[data-sw-monitor] .sw-mon-handle:hover,
[data-sw-monitor] .sw-mon-handle:focus-visible,
[data-sw-monitor] .sw-mon-handle:active {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent);
}
[data-sw-monitor] .sw-mon-drawer-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  box-sizing: border-box;
  height: 42px;
  padding: 0 8px 0 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-mon-drawer-title,
[data-sw-monitor] .sw-mon-drawer-sub {
  margin: 0;
  white-space: nowrap;
}
[data-sw-monitor] .sw-mon-drawer-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  font-variant-numeric: inherit;
  font-weight: 600;
  text-overflow: ellipsis;
}
[data-sw-monitor] .sw-mon-drawer-sub {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-mon-close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 18px;
  line-height: 18px;
}
[data-sw-monitor] .sw-mon-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-mon-close:focus-visible,
[data-sw-monitor] .sw-mon-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
[data-sw-monitor] .sw-mon-drawer-body {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
  overflow-y: auto;
}
[data-sw-monitor] .sw-mon-facts {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 4px 12px;
  align-items: baseline;
  margin: 0;
}
[data-sw-monitor] .sw-mon-facts dt {
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-mon-facts dd {
  min-width: 0;
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-mon-note {
  margin: 12px 0 0;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-cache {
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] .sw-mon-cache .sw-mon-note {
  margin: 0;
}
[data-sw-monitor] .sw-mon-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  margin: -12px -14px 12px;
  padding: 0 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-mon-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  height: 34px;
  padding: 0 9px;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: var(--dsw-font-xs-13);
  font-variant-numeric: inherit;
}
@media (hover: hover) {
  [data-sw-monitor] .sw-mon-tab:hover {
    color: var(--dsw-alias-label-primary);
  }
}
[data-sw-monitor] .sw-mon-tab[aria-selected="true"] {
  color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  right: 9px;
  bottom: 0;
  left: 9px;
  height: 2px;
  border-radius: 1px 1px 0 0;
  background: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-section {
  margin: 0 0 16px;
}
[data-sw-monitor] .sw-mon-heading {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
[data-sw-monitor] .sw-mon-pre {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  tab-size: 2;
}
[data-sw-monitor] .sw-mon-block,
[data-sw-monitor] .sw-mon-message {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 0 8px;
}
[data-sw-monitor] .sw-mon-block[data-error] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-monitor] .sw-mon-label {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-tag {
  margin-left: 8px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-mon-tag[data-tag="earlier"] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-mon-fold,
[data-sw-monitor] .sw-mon-event {
  margin: 0 0 8px;
}
[data-sw-monitor] .sw-mon-event {
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  corner-shape: round;
}
[data-sw-monitor] .sw-mon-fold > summary,
[data-sw-monitor] .sw-mon-event > summary {
  cursor: pointer;
}
[data-sw-monitor] .sw-mon-missing,
[data-sw-monitor] .sw-mon-empty {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-empty {
  margin: 0;
}
[data-sw-monitor] .sw-fl {
  container: sw-fl / inline-size;
  margin: 0 -14px;
}
[data-sw-monitor] .sw-fl button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
[data-sw-monitor] .sw-fl [data-tone="ok"] {
  color: var(--dsw-alias-state-success-primary);
}
[data-sw-monitor] .sw-fl [data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-fl [data-tone="err"] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-monitor] .sw-fl-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 2px 10px;
  padding: 4px 14px 8px;
}
[data-sw-monitor] .sw-fl-sum {
  flex: 1 1 0;
  min-width: 8em;
  margin: 0;
}
[data-sw-monitor] .sw-fl-sum > span {
  white-space: nowrap;
}
[data-sw-monitor] .sw-fl-sub {
  flex: 1 0 100%;
  order: 3;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-ctl {
  display: flex;
  flex: none;
  gap: 4px;
  margin: -2px 0;
}
[data-sw-monitor] .sw-fl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-sw-monitor] .sw-fl-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
}
[data-sw-monitor] .sw-fl-btn[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-fl-btn[aria-disabled="true"] {
  opacity: 0.4;
  cursor: default;
}
[data-sw-monitor] .sw-fl-list {
  --sw-fl-stat: 8.5em;
  --sw-fl-head: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 97%, var(--dsw-alias-label-primary));
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-fl-group {
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-fl-gh,
[data-sw-monitor] .sw-fl-fh {
  margin: 0;
  font: inherit;
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-fl-gbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  padding: 3px 14px;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 94%, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-variant-numeric: inherit;
  font-weight: 600;
  text-align: left;
}
[data-sw-monitor] .sw-fl-lbl {
  flex: 1;
  min-width: 0;
}
[data-sw-monitor] .sw-fl-gcnt {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}
[data-sw-monitor] .sw-fl-item {
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
[data-sw-monitor] .sw-fl-item:last-child {
  border-bottom: 0;
}
[data-sw-monitor] .sw-fl-fh {
  position: sticky;
  z-index: 2;
  top: -12px;
  background: var(--sw-fl-head);
}
[data-sw-monitor] .sw-fl-item[data-open] > .sw-fl-fh {
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-fl-fbtn {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: start;
  gap: 1px 8px;
  width: 100%;
  padding: 4px 14px 5px;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-variant-numeric: inherit;
  text-align: left;
}
@media (hover: hover) {
  [data-sw-monitor] .sw-fl-gbtn:hover,
  [data-sw-monitor] .sw-fl-fbtn:hover,
  [data-sw-monitor] .sw-fl-foldbtn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  [data-sw-monitor] .sw-fl-btn:not([aria-disabled="true"]):hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
  [data-sw-monitor] .sw-fl-row:hover > .sw-fl-t {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
[data-sw-monitor] .sw-fl-chev {
  flex: none;
  align-self: start;
  width: 0;
  height: 0;
  margin: 6px 0 0;
  border-style: solid;
  border-width: 3.5px 0 3.5px 5px;
  border-color: transparent transparent transparent currentColor;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 120ms ease-in-out;
}
[data-sw-monitor] .sw-fl-gbtn .sw-fl-chev,
[data-sw-monitor] .sw-fl-foldbtn .sw-fl-chev {
  align-self: center;
  margin: 0;
}
[data-sw-monitor] [aria-expanded="true"] > .sw-fl-chev {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  [data-sw-monitor] .sw-fl-chev {
    transition: none;
  }
}
[data-sw-monitor] .sw-fl-path {
  min-width: 0;
  font-family: var(--ds-font-family-code);
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-dir {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-fl-base {
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-fl-cnt {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
[data-sw-monitor] .sw-fl-pv {
  grid-column: 2 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--sw-fl-stat);
  align-items: center;
  gap: 0 8px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-fl-pv[data-nobar] {
  grid-template-columns: minmax(0, 1fr);
}
[data-sw-monitor] .sw-fl-bar {
  position: relative;
  min-width: 96px;
  height: 4px;
  border-radius: 1px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
  overflow: hidden;
}
[data-sw-monitor] .sw-fl-bar i {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-fl-bar i[data-x] {
  background: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-fl-stat {
  min-width: 0;
  text-align: right;
  white-space: nowrap;
}
[data-sw-monitor] .sw-fl-pv[data-nobar] .sw-fl-stat {
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-plain {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 0 8px;
  padding: 4px 14px;
}
[data-sw-monitor] .sw-fl-plain > .sw-fl-path {
  grid-column: 2;
}
[data-sw-monitor] .sw-fl-why {
  grid-column: 3;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
[data-sw-monitor] .sw-fl-why[data-long] {
  grid-column: 2 / -1;
  white-space: normal;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-item[data-removed] .sw-fl-path,
[data-sw-monitor] .sw-fl-item[data-removed] .sw-fl-dir,
[data-sw-monitor] .sw-fl-item[data-removed] .sw-fl-base {
  color: var(--dsw-alias-label-tertiary);
  text-decoration: line-through;
}
[data-sw-monitor] .sw-fl-meta {
  padding: 5px 14px 6px 31px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--sw-fl-head);
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-fl-full {
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-scroll {
  background: var(--dsw-alias-bg-layer-1);
  overflow-x: auto;
}
[data-sw-monitor] .sw-fl-rows {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  tab-size: 2;
}
[data-sw-monitor] .sw-fl-list[data-wrap="off"] .sw-fl-rows {
  width: max-content;
  min-width: 100%;
}
[data-sw-monitor] .sw-fl-row {
  display: contents;
}
[data-sw-monitor] .sw-fl-n {
  position: sticky;
  z-index: 1;
  left: 0;
  min-height: 18px;
  padding: 0 6px 0 14px;
  border-right: 0.5px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-tertiary);
  text-align: right;
  user-select: none;
}
[data-sw-monitor] .sw-fl-t {
  min-width: 0;
  min-height: 18px;
  padding: 0 14px 0 8px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
[data-sw-monitor] .sw-fl-list[data-wrap="off"] .sw-fl-t {
  overflow-wrap: normal;
  white-space: pre;
}
[data-sw-monitor] .sw-fl-sep {
  grid-column: 1 / -1;
  border-top: 0.5px dashed var(--dsw-alias-border-l2);
  border-bottom: 0.5px dashed var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-fl-sep > span,
[data-sw-monitor] .sw-fl-wd > span {
  position: sticky;
  left: 0;
  width: max-content;
  max-width: 100cqw;
  padding: 0 14px;
}
[data-sw-monitor] .sw-fl-sep > span {
  display: block;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-fl-wd {
  grid-column: 1 / -1;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent);
  color: var(--dsw-alias-state-warn-primary);
  font-family: var(--ds-font-family-code);
}
[data-sw-monitor] .sw-fl-wd > span {
  display: flex;
  gap: 8px;
}
[data-sw-monitor] .sw-fl-wd b {
  flex: none;
  width: 1ch;
  font-weight: 600;
}
[data-sw-monitor] .sw-fl-foot {
  margin: 12px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-fl-foldbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 28px;
  padding: 4px 14px;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-variant-numeric: inherit;
  text-align: left;
}
[data-sw-monitor] .sw-fl-fold + .sw-fl-fold {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
[data-sw-monitor] .sw-fl-foldbody {
  padding: 2px 14px 10px 31px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-fl-foldbody p {
  margin: 0;
}
[data-sw-monitor] .sw-fl-foldbody .sw-mon-pre {
  color: var(--dsw-alias-label-primary);
}
@container sw-fl (width < 360px) {
  [data-sw-monitor] .sw-fl-list {
    --sw-fl-stat: 6.5em;
  }
  [data-sw-monitor] .sw-fl-sg {
    display: none;
  }
}
@container sw-monitor (width < ${DRAWER_OVERLAY_BELOW_PX}px) {
  [data-sw-monitor] .sw-mon-drawer {
    position: absolute;
    z-index: 2;
    top: 0;
    right: 0;
    bottom: 0;
    max-width: 100%;
    box-shadow: -12px 0 24px -12px var(--dsw-alias-bg-mask-1);
  }
}
`;
