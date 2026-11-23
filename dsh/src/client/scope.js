// dsh/src/client/scope.js — the dashboard sheets confined to the DSH tab root, and the rules the plugin adds beside them: the host-token bridge, the chrome leaf's rules, the light palette, the dock, the session mode's entries and the inner compaction monitor.
import { LIST_MIN_WIDTH, DRAWER_MIN_WIDTH, DRAWER_BODY_PADDING_X } from './monitor-state.js';

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
 * The toolbar above the split is one row of buttons that wraps with the width, its warning toggle at the right end; a pressed button takes the hover fill.
 * The drawer never narrows the list below its smallest width; where the split is narrower than the list and the drawer need together, a size container query lays the drawer over the list's right edge instead, at the width the user set up to the split's.
 * A row is a compact item: a title line whose status and meta wrap onto further lines as the width needs, and a preview line cut with an ellipsis: a call's response takes the whole line, a slot's width is shared between the input and the response in the golden ratio. A placeholder row, which stands where an open group's leaves are being read, could not be read or are none, is one line of secondary text, with a spinner while the read is in progress. A settlement row has no toggle, so its title is indented by `--sw-mon-chevron-width` plus `--sw-mon-chevron-gap`, the variables the chevron and the toggle read, and starts where the titles of the rows that fold start.
 * The drawer's pages set text and JSON in wrapping preformatted blocks, so a long line is read whole without widening the drawer; the pages' tabs, folds and tags use the same tokens as the list.
 * The file list of the evidence and files pages is a size container of its own, as wide as the drawer body: below its narrow width the statistics column shrinks and the segment count goes. An open file's head, its path and statistics, sticks to the top edge of the body; its `top` is the body's upper padding negated, a sticky offset being measured inside that padding. The block of a file's lines is `public/themes/file-rows.css`, outside every `@scope` wrapper, which reads the `--sw-fl-*` variables the root maps to the host's tokens. The host defines no `--dsw-alias-fill-*` token, so the position bar's track and a gap row take the host's hover fill; the light theme's first and second layer are one colour, so a file's head and meta line take a tint of the second layer toward the label.
 * The drawer body is a size container named `body`, which the settlement drawer's payback page reads: its narrow rules lay a row's three numbers out as small labelled cells over a thin plot, and a wider body gets a taller plot. The page's axis header and unit line stick to the body's edges at the body's padding negated, as the file list's head does, and only its data table scrolls sideways. A mark of the plot or the curve is told from the others by its shape or dash as well as its colour, the loss under zero is hatched, and the area above it takes the host's hover fill, as the position bar's track does.
 * The settlement drawer's context page lays its pictures out at the widths its elements measure, so its rules hold no geometry of them: its readout sticks to the top of the body and its unit line to the foot, the lines of the stock chart differ by their dash as well as their colour, the line the stock is measured against is dotted in the warning colour, and the sign of a net is its text and glyph beside the success or error colour of the line chart and the figure.
 */
export const MONITOR_CSS = `[data-sw-monitor] {
  --sw-mon-chevron-width: 5px;
  --sw-mon-chevron-gap: 6px;
  --sw-fl-bg: var(--dsw-alias-bg-layer-1);
  --sw-fl-text: var(--dsw-alias-label-primary);
  --sw-fl-dim: var(--dsw-alias-label-tertiary);
  --sw-fl-edge: var(--dsw-alias-border-l2);
  --sw-fl-hover: var(--dsw-alias-interactive-bg-hover);
  --sw-fl-warn: var(--dsw-alias-state-warn-primary);
  --sw-fl-mono: var(--ds-font-family-code);
  --sw-fl-sep-font: var(--dsw-font-xxxs-11);
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
  text-align: center;
}
[data-sw-monitor] .sw-mon-toolbar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  box-sizing: border-box;
  min-height: 32px;
  padding: 4px 12px;
  gap: 4px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-mon-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
[data-sw-monitor] .sw-mon-fbtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  box-sizing: border-box;
  height: 20px;
  padding: 0 7px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: var(--dsw-font-xxs-12);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-mon-fbtn[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
@media (hover: hover) {
  [data-sw-monitor] .sw-mon-fbtn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
[data-sw-monitor] .sw-mon-fbtn[data-act="warned"] {
  margin-left: auto;
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
[data-sw-monitor] .sw-mon-meta-item[data-part="step"] {
  position: relative;
}
[data-sw-monitor] .sw-mon-badge {
  position: absolute;
  top: -5px;
  left: 100%;
  box-sizing: border-box;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
  font-size: 10px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
[data-sw-monitor] .sw-mon-fbtn:focus-visible,
[data-sw-monitor] .sw-mon-link:focus-visible,
[data-sw-monitor] .sw-mon-tab:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
[data-sw-monitor] .sw-mon-drawer-body {
  container: body / inline-size;
  flex: 1;
  min-height: 0;
  padding: 12px ${DRAWER_BODY_PADDING_X}px;
  overflow-y: auto;
}
/* A sticky bar covers an edge of the scrollport, which the scroll that brings a focused element into view does not count: the page keeps that much clear. Each size is the bar's border and padding with the lines its text takes where it wraps: the readout a small line over two lines of text, the axis header one line, the unit line two. */
[data-sw-monitor] .sw-mon-drawer-body:has(.sw-cx-read) {
  scroll-padding-top: calc(0.5px + 8px + 6px + 3lh);
}
[data-sw-monitor] .sw-mon-drawer-body:has(.sw-pb-axis) {
  scroll-padding-top: calc(6px + 4px + 0.5px + 1lh);
}
[data-sw-monitor] .sw-mon-drawer-body:has(.sw-cx-pin, .sw-pb-pin) {
  scroll-padding-bottom: calc(0.5px + 6px + 8px + 2lh);
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
[data-sw-monitor] [data-sw-usage="output"] {
  color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 80%, var(--dsw-alias-label-primary));
}
[data-sw-monitor] [data-sw-usage="cacheWrite"] {
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-label-primary));
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
[data-sw-monitor] .sw-mon-event[data-sw-opened] {
  border-color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-mon-tool {
  margin: 0 0 12px;
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  corner-shape: round;
}
[data-sw-monitor] .sw-mon-tool-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  margin: 0 0 4px;
}
[data-sw-monitor] .sw-mon-tool-name {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-mon-tool-state {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-tool-state[data-state="error"] {
  color: var(--dsw-alias-state-error-primary);
}
[data-sw-monitor] .sw-mon-tool-warnings {
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] .sw-mon-tool-warning {
  color: var(--dsw-alias-state-warn-primary);
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-mon-tool-pruned {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-mon-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
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
[data-sw-monitor] .sw-pb {
  --sw-pb-idw: 34px;
  --sw-pb-cn: 34px;
  --sw-pb-cd: 44px;
  --sw-pb-gap: 8px;
}
[data-sw-monitor] .sw-pb button:focus-visible,
[data-sw-monitor] .sw-pb summary:focus-visible,
[data-sw-monitor] .sw-pb [tabindex]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
[data-sw-monitor] .sw-pb-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0 6px;
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-pb-head span {
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-facts {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-share {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-facts p {
  margin: 0;
}
[data-sw-monitor] .sw-pb-cap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  margin: 12px 0 2px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-pb-cap-k {
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-axisbtn {
  flex: none;
  height: 20px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xs);
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-note {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-pb-chart svg {
  display: block;
  width: 100%;
  overflow: visible;
}
[data-sw-monitor] .sw-pb-lbl {
  fill: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}
[data-sw-monitor] .sw-pb-xlbl {
  fill: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-pb-halo {
  paint-order: stroke;
  stroke: var(--dsw-alias-bg-layer-2);
  stroke-linejoin: round;
  stroke-width: 3px;
}
[data-sw-monitor] .sw-pb-strong {
  fill: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[data-sw-monitor] .sw-pb-zero {
  stroke: var(--dsw-alias-label-secondary);
  stroke-width: 1;
}
[data-sw-monitor] .sw-pb-grid {
  stroke: var(--dsw-alias-border-l2);
  stroke-dasharray: 2 3;
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-pb-clipline {
  stroke: var(--dsw-alias-label-tertiary);
  stroke-dasharray: 4 2;
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-pb-curve {
  fill: none;
  stroke: var(--dsw-alias-label-primary);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-pb-gain {
  fill: var(--dsw-alias-interactive-bg-hover);
}
[data-sw-monitor] .sw-pb-hatch-line {
  stroke: var(--dsw-alias-label-secondary);
  stroke-width: 1;
}
[data-sw-monitor] .sw-pb-pt {
  fill: var(--dsw-alias-label-primary);
  stroke: var(--dsw-alias-bg-layer-2);
  stroke-width: 1;
}
[data-sw-monitor] .sw-pb-seal {
  stroke: var(--dsw-alias-label-secondary);
  stroke-width: 1;
}
[data-sw-monitor] .sw-pb-lane {
  fill: none;
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-pb-rows {
  margin: 12px 0 0;
}
[data-sw-monitor] .sw-pb-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin: 8px 0 0;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-keys span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
[data-sw-monitor] .sw-pb-key {
  position: relative;
  display: inline-block;
  flex: none;
  width: 20px;
  height: 10px;
}
[data-sw-monitor] .sw-pb-key::before {
  content: "";
  position: absolute;
  top: 4px;
  right: 0;
  left: 0;
  border-top: 2px solid var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-pb-key[data-key="surplus"]::before {
  top: 2px;
  border-color: var(--dsw-alias-state-business-primary);
  border-top-width: 6px;
}
[data-sw-monitor] .sw-pb-key[data-key="missing"]::before {
  border-top: 2px dashed var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-key[data-key="needed"]::before {
  top: 1px;
  right: auto;
  left: 6px;
  width: 8px;
  height: 8px;
  border: 0;
  background: var(--dsw-alias-label-primary);
  transform: rotate(45deg) scale(0.8);
}
[data-sw-monitor] .sw-pb-sort {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 8px 0 0;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-pb-sortbtn {
  height: 22px;
  padding: 0 7px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
}
[data-sw-monitor] .sw-pb-sortbtn[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-pb-axis,
[data-sw-monitor] .sw-pb-li {
  display: grid;
  grid-template-columns: var(--sw-pb-idw) minmax(0, 1fr) var(--sw-pb-cn) var(--sw-pb-cn) var(--sw-pb-cd);
  align-items: center;
  column-gap: var(--sw-pb-gap);
}
[data-sw-monitor] .sw-pb-axis {
  position: sticky;
  z-index: 2;
  top: -12px;
  margin: 10px -14px 0;
  padding: 6px 14px 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-pb-ax {
  position: relative;
  height: 16px;
}
[data-sw-monitor] .sw-pb-tick {
  position: absolute;
  top: 0;
  display: block;
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-t0 {
  left: 0;
}
[data-sw-monitor] .sw-pb-t1 {
  left: 50%;
  transform: translateX(-50%);
}
[data-sw-monitor] .sw-pb-t2 {
  right: 0;
}
[data-sw-monitor] .sw-pb-axis .sw-pb-num {
  color: var(--dsw-alias-label-secondary);
  text-align: right;
}
[data-sw-monitor] .sw-pb-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] .sw-pb-li {
  padding: 4px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
}
@media (hover: hover) {
  [data-sw-monitor] .sw-pb-axisbtn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
[data-sw-monitor] .sw-pb-id {
  font-weight: 600;
}
[data-sw-monitor] .sw-pb-li[data-unknown] .sw-pb-id {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}
[data-sw-monitor] .sw-pb-li .sw-pb-num {
  text-align: right;
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-li .sw-pb-num[data-muted] {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-pb-li .sw-pb-num small {
  display: none;
  margin-right: 4px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-pb-plot {
  position: relative;
  display: block;
  height: 20px;
  border-right: 0.5px dotted var(--dsw-alias-border-l2);
  border-left: 0.5px solid var(--dsw-alias-border-l2);
  background:
    linear-gradient(var(--dsw-alias-border-l1), var(--dsw-alias-border-l1)) 25% 0 / 0.5px 100% no-repeat,
    linear-gradient(var(--dsw-alias-border-l1), var(--dsw-alias-border-l1)) 50% 0 / 0.5px 100% no-repeat,
    linear-gradient(var(--dsw-alias-border-l1), var(--dsw-alias-border-l1)) 75% 0 / 0.5px 100% no-repeat;
}
[data-sw-monitor] .sw-pb-plot i,
[data-sw-monitor] .sw-pb-plot b,
[data-sw-monitor] .sw-pb-plot em {
  position: absolute;
  display: block;
  font-style: normal;
}
[data-sw-monitor] .sw-pb-line {
  top: 9px;
  left: 0;
  height: 2px;
  background: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-pb-surplus {
  top: 6px;
  height: 8px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-pb-missing {
  top: 9px;
  height: 0;
  border-top: 2px dashed var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-end {
  top: 5px;
  width: 0;
  height: 10px;
  border-left: 2px solid var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-pb-dia {
  top: 6px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  background: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-2);
  transform: rotate(45deg);
}
[data-sw-monitor] .sw-pb-arrow {
  top: 5px;
  right: -1px;
  width: 0;
  height: 0;
  border-color: transparent transparent transparent var(--dsw-alias-label-primary);
  border-style: solid;
  border-width: 5px 0 5px 7px;
}
[data-sw-monitor] .sw-pb-over {
  top: 1px;
  right: 9px;
  padding: 0 3px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
  line-height: 14px;
}
[data-sw-monitor] .sw-pb-inf {
  top: 1px;
  margin-left: 5px;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
  line-height: 14px;
}
[data-sw-monitor] .sw-pb-equations {
  margin-top: 6px;
  border-collapse: collapse;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-pb-equations th,
[data-sw-monitor] .sw-pb-equations td {
  padding: 2px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  text-align: left;
  vertical-align: top;
}
[data-sw-monitor] .sw-pb-equations th {
  font-weight: 600;
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-table {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-pb-table summary {
  width: max-content;
  cursor: pointer;
}
[data-sw-monitor] .sw-pb-scroll {
  margin: 6px 0 0;
  overflow-x: auto;
}
[data-sw-monitor] .sw-pb-tbl {
  width: 100%;
  border-collapse: collapse;
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-pb-tbl th,
[data-sw-monitor] .sw-pb-tbl td {
  padding: 2px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  text-align: right;
  white-space: nowrap;
}
[data-sw-monitor] .sw-pb-tbl th:first-child {
  position: sticky;
  left: 0;
  background: var(--dsw-alias-bg-layer-2);
  text-align: left;
}
[data-sw-monitor] .sw-pb-tbl th {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}
[data-sw-monitor] .sw-pb-tbl td {
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-pb-tbl tr[data-unknown] td {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-pb-pin {
  position: sticky;
  z-index: 2;
  bottom: -12px;
  margin: 10px -14px 0;
  padding: 6px 14px 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
[data-sw-monitor] .sw-pb-unit {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-cx button:focus-visible,
[data-sw-monitor] .sw-cx summary:focus-visible,
[data-sw-monitor] .sw-cx [tabindex]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
[data-sw-monitor] .sw-cx .sw-cx-slider:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
[data-sw-monitor] .sw-cx-read {
  position: sticky;
  z-index: 4;
  top: -12px;
  box-sizing: border-box;
  min-height: 62px;
  margin: -12px -14px 8px;
  padding: 8px 14px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
[data-sw-monitor] .sw-cx-r {
  display: block;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-cx-r1,
[data-sw-monitor] .sw-cx-hint {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-cx-hint {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-cx-ctx {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-cx-h {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 8px;
  margin: 12px 0 4px;
}
[data-sw-monitor] .sw-cx-h h3 {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
[data-sw-monitor] .sw-cx-tag {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-cx-btn {
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
  white-space: nowrap;
}
@media (hover: hover) {
  [data-sw-monitor] .sw-cx-btn:hover {
    color: var(--dsw-alias-label-primary);
  }
  [data-sw-monitor] .sw-cx-rr:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
[data-sw-monitor] .sw-cx-facts {
  margin: 2px 0 8px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-facts span {
  display: block;
}
[data-sw-monitor] .sw-cx-svg {
  display: block;
  max-width: 100%;
  overflow: visible;
  touch-action: pan-y;
}
[data-sw-monitor] .sw-cx-lbl,
[data-sw-monitor] .sw-cx-ll {
  fill: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}
[data-sw-monitor] .sw-cx-halo {
  paint-order: stroke;
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-linejoin: round;
  stroke-width: 3px;
}
[data-sw-monitor] .sw-cx-biz {
  fill: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-cx-ink {
  fill: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-cx-warn {
  fill: var(--dsw-alias-state-warn-primary);
}
[data-sw-monitor] .sw-cx-plotbg {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-cx-grid {
  stroke: var(--dsw-alias-border-l1);
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-cx-axis {
  fill: none;
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-cx-sealline {
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.5;
  opacity: 0.8;
}
[data-sw-monitor] .sw-cx-seal {
  stroke: var(--dsw-alias-label-secondary);
  stroke-width: 1.25;
}
[data-sw-monitor] .sw-cx-warnline {
  stroke: var(--dsw-alias-state-warn-primary);
  stroke-dasharray: 1 3;
  stroke-linecap: round;
  stroke-width: 1;
}
[data-sw-monitor] .sw-cx-actual {
  fill: none;
  stroke: var(--dsw-alias-label-primary);
  stroke-linejoin: round;
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-uncompressed {
  fill: none;
  stroke: var(--dsw-alias-state-business-primary);
  stroke-dasharray: 5 3;
  stroke-linejoin: round;
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-xmark {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-state-business-primary);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-actualcross {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-label-primary);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-hit {
  fill: transparent;
  cursor: crosshair;
}
[data-sw-monitor] .sw-cx-sealhit {
  fill: transparent;
  cursor: pointer;
}
[data-sw-monitor] .sw-cx-cur {
  stroke: var(--dsw-alias-label-primary);
  stroke-width: 0.75;
}
[data-sw-monitor] .sw-cx-curdot {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-label-primary);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-curp {
  stroke: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-cx-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-cx-legend li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}
[data-sw-monitor] .sw-cx-legend svg {
  flex: none;
  overflow: visible;
}
[data-sw-monitor] .sw-cx-sw {
  fill: none;
}
[data-sw-monitor] .sw-cx-sw-actual {
  stroke: var(--dsw-alias-label-primary);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-sw-uncompressed {
  stroke: var(--dsw-alias-state-business-primary);
  stroke-dasharray: 5 3;
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-sw-seal {
  stroke: var(--dsw-alias-label-secondary);
  stroke-width: 1.25;
}
[data-sw-monitor] .sw-cx-assume {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-cx-comp {
  margin: 12px 0 0;
}
[data-sw-monitor] .sw-cx-comp-total {
  margin: 0 0 6px;
  font: var(--dsw-font-xs-13);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
[data-sw-monitor] .sw-cx-stack {
  display: flex;
  height: 8px;
  margin: 0 0 8px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--dsw-alias-border-l2);
}
[data-sw-monitor] .sw-cx-seg {
  display: block;
  height: 100%;
}
[data-sw-monitor] .sw-cx-seg[data-key='summary'],
[data-sw-monitor] .sw-cx-swatch[data-key='summary'] {
  background: var(--dsw-alias-border-l4);
}
[data-sw-monitor] .sw-cx-seg[data-key='rebuild'],
[data-sw-monitor] .sw-cx-swatch[data-key='rebuild'] {
  background: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-cx-seg[data-key='recall'],
[data-sw-monitor] .sw-cx-swatch[data-key='recall'] {
  background: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-cx-comp-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] .sw-cx-comp-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto 52px;
  gap: 0 8px;
  align-items: center;
  padding: 3px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
[data-sw-monitor] .sw-cx-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
[data-sw-monitor] .sw-cx-comp-name {
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-cx-comp-value,
[data-sw-monitor] .sw-cx-comp-percent {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
[data-sw-monitor] .sw-cx-comp-percent {
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-ring {
  fill: none;
  stroke: var(--dsw-alias-state-business-primary);
  stroke-width: 2;
}
[data-sw-monitor] .sw-cx-trial {
  margin: 8px 0 0;
}
[data-sw-monitor] .sw-cx-trial > summary {
  padding: 3px 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-sw-monitor] .sw-rc {
  margin: 12px 0 0;
}
[data-sw-monitor] .sw-rc-axis,
[data-sw-monitor] .sw-rc-track {
  display: block;
  max-width: 100%;
  height: auto;
  overflow: visible;
}
[data-sw-monitor] .sw-rc-zero {
  fill: var(--dsw-alias-border-l1, transparent);
}
[data-sw-monitor] .sw-rc-seal {
  stroke: var(--dsw-alias-label-tertiary);
  stroke-width: 1;
}
[data-sw-monitor] .sw-rc-rail {
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 1;
}
[data-sw-monitor] .sw-rc-lbl {
  fill: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}
[data-sw-monitor] .sw-rc-ring {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-state-warn-primary);
  stroke-width: 1.75;
}
[data-sw-monitor] .sw-rc-dot {
  fill: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-rc-list {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] .sw-rc-row {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 4px 0 2px;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
[data-sw-monitor] .sw-rc-row[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary);
}
@media (hover: hover) {
  [data-sw-monitor] .sw-rc-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
[data-sw-monitor] .sw-rc-name {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0 8px;
  padding: 0 4px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[data-sw-monitor] .sw-rc-name small {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-weight: 400;
}
[data-sw-monitor] .sw-rc-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  margin: 6px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
}
[data-sw-monitor] .sw-rc-key {
  display: inline-block;
  box-sizing: border-box;
  width: 9px;
  height: 9px;
  margin: 0 0 0 6px;
}
[data-sw-monitor] .sw-rc-ring-key {
  border: 1.75px solid var(--dsw-alias-state-warn-primary);
  border-radius: 50%;
}
[data-sw-monitor] .sw-rc-dot-key {
  border-radius: 50%;
  background: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-rc-seal-key {
  width: 1px;
  background: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-rc-zero-key {
  background: var(--dsw-alias-border-l1, transparent);
}
[data-sw-monitor] .sw-rc-panel {
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-1);
}
[data-sw-monitor] .sw-rc-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
[data-sw-monitor] .sw-rc-landing {
  margin: 2px 0 6px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-rc-text {
  margin: 0 0 6px;
  font: var(--dsw-font-xxxs-11);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
[data-sw-monitor] .sw-rc-more,
[data-sw-monitor] .sw-rc-read {
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
  white-space: nowrap;
}
[data-sw-monitor] button.sw-rc-more,
[data-sw-monitor] button.sw-rc-read {
  cursor: pointer;
}
[data-sw-monitor] .sw-rc-reads {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
[data-sw-monitor] span.sw-rc-read {
  display: inline-flex;
  align-items: center;
}
[data-sw-monitor] .sw-cx-card {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-1);
}
[data-sw-monitor] .sw-cx-lamchart {
  width: 100%;
  margin: 0 0 4px;
}
[data-sw-monitor] .sw-cx-lamchart svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
[data-sw-monitor] .sw-cx-ll {
  fill: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-ll.sw-cx-pri {
  fill: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-cx-lax {
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-cx-zero {
  stroke: var(--dsw-alias-label-tertiary);
  stroke-width: 1;
}
[data-sw-monitor] .sw-cx-guide {
  stroke: var(--dsw-alias-label-tertiary);
  stroke-dasharray: 2 3;
  stroke-width: 0.5;
}
[data-sw-monitor] .sw-cx-net {
  fill: none;
  stroke-width: 2;
}
[data-sw-monitor] .sw-cx-net.sw-cx-pos {
  stroke: var(--dsw-alias-state-success-primary);
}
[data-sw-monitor] .sw-cx-net.sw-cx-neg {
  stroke: var(--dsw-alias-state-error-primary);
  stroke-dasharray: 5 3;
}
[data-sw-monitor] .sw-cx-pt-m {
  fill: var(--dsw-alias-bg-layer-1);
  stroke: var(--dsw-alias-label-primary);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-pt-f {
  fill: var(--dsw-alias-label-primary);
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-width: 1;
}
[data-sw-monitor] .sw-cx-star {
  fill: var(--dsw-alias-state-business-primary);
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-width: 1;
}
[data-sw-monitor] .sw-cx-lamcursor {
  fill: var(--dsw-alias-state-business-primary);
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-width: 1.5;
}
[data-sw-monitor] .sw-cx-sl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  margin: 0 0 2px;
}
[data-sw-monitor] .sw-cx-sl label {
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-slider {
  width: 100%;
  height: 20px;
  margin: 0;
  accent-color: var(--dsw-alias-state-business-primary);
}
[data-sw-monitor] .sw-cx-rd {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-thr {
  margin: 6px 0 0;
  padding: 6px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
}
[data-sw-monitor] .sw-cx-rows {
  margin: 0;
}
[data-sw-monitor] .sw-cx-rows > summary,
[data-sw-monitor] .sw-cx-note > summary {
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-sw-monitor] .sw-cx-rows > summary {
  padding: 3px 0;
  border-radius: var(--dsw-radius-sm);
}
[data-sw-monitor] .sw-cx-rl {
  margin: 4px 0 0;
  padding: 0;
}
[data-sw-monitor] .sw-cx-rr {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) max(54px, 10ch) 48px;
  gap: 0 8px;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
[data-sw-monitor] .sw-cx-rr > span {
  min-width: 0;
  white-space: nowrap;
}
[data-sw-monitor] .sw-cx-rr > span:first-child {
  color: var(--dsw-alias-label-secondary);
  text-align: left;
}
[data-sw-monitor] .sw-cx-rh {
  height: 18px;
  border-bottom-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: inherit;
}
[data-sw-monitor] .sw-cx-rh > span:first-child {
  color: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] button.sw-cx-rr {
  cursor: pointer;
}
[data-sw-monitor] .sw-cx-bar {
  display: block;
  height: 10px;
  text-align: left;
}
[data-sw-monitor] .sw-cx-bar i {
  display: block;
  height: 100%;
  min-width: 1px;
  border-radius: 0 var(--dsw-radius-xs) var(--dsw-radius-xs) 0;
  background: var(--dsw-alias-label-tertiary);
}
[data-sw-monitor] .sw-cx-note {
  margin: 6px 0 0;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-1);
}
[data-sw-monitor] .sw-cx-note > summary {
  padding: 4px 8px;
  list-style-position: inside;
}
[data-sw-monitor] .sw-cx-in {
  padding: 0 8px 6px;
  color: var(--dsw-alias-label-secondary);
}
[data-sw-monitor] .sw-cx-in p {
  margin: 0 0 4px;
}
[data-sw-monitor] .sw-cx-pin {
  position: sticky;
  z-index: 2;
  bottom: -12px;
  margin: 12px -14px 0;
  padding: 6px 14px 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
[data-sw-monitor] .sw-cx-unit {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
@container body (min-width: 540px) {
  [data-sw-monitor] .sw-pb-plot {
    height: 22px;
  }
}
@container body (max-width: 340px) {
  [data-sw-monitor] .sw-pb-axis {
    grid-template-columns: minmax(0, 1fr);
  }
  [data-sw-monitor] .sw-pb-axis > .sw-pb-idh,
  [data-sw-monitor] .sw-pb-axis > .sw-pb-num {
    display: none;
  }
  [data-sw-monitor] .sw-pb-li {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-areas: "id id id" "a n d" "pl pl pl";
    row-gap: 3px;
    padding: 6px 0 7px;
  }
  [data-sw-monitor] .sw-pb-li .sw-pb-id {
    grid-area: id;
  }
  [data-sw-monitor] .sw-pb-li .sw-pb-plot {
    grid-area: pl;
    height: 16px;
  }
  [data-sw-monitor] .sw-pb-li .sw-pb-num {
    text-align: left;
  }
  [data-sw-monitor] .sw-pb-li .sw-pb-num small {
    display: inline;
  }
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
