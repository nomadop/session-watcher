// dsh/src/client/styles.js — the plugin's stylesheet: the dashboard's two sheets as text, scoped to the tab root, followed by the rules `scope.js` adds. Only the bundler resolves the sheet imports.
import baseCss from '../../../public/themes/base.css';
import hCss from '../../../public/themes/h.css';
import { scopeStylesheet, BRIDGE_CSS, LIGHT_CSS, CHROME_CSS, DOCK_CSS } from './scope.js';

/** The text `applyClient` injects: the bridge, the chrome leaf's rules and the light palette follow the sheets so they override the sheets' own values, and the dock's rules follow outside every `@scope` wrapper. */
export const TAB_CSS = scopeStylesheet(baseCss) + scopeStylesheet(hCss) + BRIDGE_CSS + CHROME_CSS + LIGHT_CSS + DOCK_CSS;
