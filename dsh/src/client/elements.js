// dsh/src/client/elements.js — the dashboard elements the tab mounts, per slot leaf, as `mount(root, ctx)` functions in `public/app.js`'s registration order.
import { mount as mountPricingChip } from '../../../public/elements/pricingChip.js';
import { mount as mountHeroDiptych } from '../../../public/elements/heroDiptych.js';
import { mount as mountDepthAux } from '../../../public/elements/depthAux.js';
import { mount as mountBurnMeter } from '../../../public/elements/burnMeter.js';
import { mount as mountHistoryChart } from '../../../public/elements/historyChart.js';
import { mount as mountHistoryDrawer } from '../../../public/elements/historyDrawer.js';
import { mount as mountBucketPanel } from '../../../public/elements/bucketPanel.js';

/** Each slot's element mounts; the chrome bar and the theme chip are the dashboard page's own and are never listed; the tab renders its connection badge itself in the chrome leaf. */
export const SLOT_TABLES = {
  chrome: [mountPricingChip],
  hero: [mountHeroDiptych, mountDepthAux, mountBurnMeter],
  history: [mountHistoryChart, mountHistoryDrawer],
  buckets: [mountBucketPanel],
};
