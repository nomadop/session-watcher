// public/app.js — bootstrap: transport + store + element dispatch
import { createTransport } from './lib/transport.js';
import { createStore } from './lib/store.js';
import { buildCapabilities } from './lib/featureDetect.js';
import { mount as mountHistoryChart } from './elements/historyChart.js';
import { mount as mountHeroDiptych } from './elements/heroDiptych.js';
import { mount as mountDepthAux } from './elements/depthAux.js';
import { mount as mountBurnMeter } from './elements/burnMeter.js';
import { mount as mountPricingChip } from './elements/pricingChip.js';
import { mount as mountChrome } from './elements/chrome.js';
import { mount as mountThemeChip } from './elements/themeChip.js';
import { mount as mountBucketPanel } from './elements/bucketPanel.js';
import { mount as mountTerms } from './elements/terms.js';

const store = createStore();
const transport = createTransport();

// Element registry — populated via static imports before bootstrap()
const elements = [];

export function registerElement(mountFn, slotId) {
  elements.push({ mountFn, slotId, instance: null });
}

function bootstrap() {
  const ctx = { transport, store };

  // Mount all elements into their DOM slots
  for (const el of elements) {
    const root = document.getElementById(el.slotId);
    if (root) el.instance = el.mountFn(root, ctx);
  }

  // Wire data flow: transport → capabilities → store → elements
  transport.onData((status, history, _capabilities, bucketData) => {
    const capabilities = buildCapabilities(status);
    store.update(status, history, capabilities, bucketData);
  });

  store.subscribe((snapshot) => {
    for (const el of elements) {
      try { el.instance?.update(snapshot); }
      catch (err) { console.error(`[sw] ${el.slotId} update failed`, err); }
    }
  });

  // Theme change: destroy+remount all elements so they get fresh CSS var reads.
  // ThemeChip also remounts (its parent chrome rebuilds the DOM it lives in).
  document.addEventListener('sw-theme-change', () => {
    for (const el of elements) {
      try { el.instance?.destroy(); } catch {}
      const root = document.getElementById(el.slotId);
      if (root) {
        el.instance = el.mountFn(root, ctx);
        const snap = store.getSnapshot();
        if (snap) try { el.instance?.update(snap); } catch {}
      }
    }
  });

  // Start transport AFTER listeners are registered (prevents first-frame loss)
  transport.start();
}

// Element registrations
registerElement(mountChrome, 'sw-chrome');
registerElement(mountThemeChip, 'sw-chrome');
registerElement(mountPricingChip, 'sw-chrome');
registerElement(mountBucketPanel, 'sw-buckets');
registerElement(mountTerms, 'sw-terms');
registerElement(mountHeroDiptych, 'sw-hero');
registerElement(mountDepthAux, 'sw-hero');
registerElement(mountBurnMeter, 'sw-hero');
registerElement(mountHistoryChart, 'sw-history');

// e2e handle — preserved across refactor
window.__SW_dashboard = { store, transport, charts: { history: null, hero: null } };

bootstrap();
