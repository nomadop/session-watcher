import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

let proc, base;
test.beforeAll(async () => {
  proc = spawn('node', ['server.js', '--project', 'fixtures/host/.claude/projects/C--Users-nomad-freshtrack', '--lbase', '42000', '--port', '0'],
    { env: { ...process.env, SW_NO_OPEN: '1' } });
  const port = await new Promise((resolve, reject) => {
    let buf = ''; const t = setTimeout(() => reject(new Error('timeout')), 10000);
    proc.stdout.on('data', d => { buf += d; const m = buf.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  base = `http://localhost:${port}`;
});
test.afterAll(() => { proc?.kill('SIGTERM'); });

test('dashboard loads, charts render, status bar present', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#decisionChart')).toBeVisible();
  await expect(page.locator('#paybackChart')).toBeVisible();
  await expect(page.locator('#statusbar')).toBeVisible();
  await expect(page.locator('#lline')).toContainText('L:');
  await expect(page.locator('#stats')).toContainText('Lbase:');
});

test('aux-L* toggle flips dataset visibility', async ({ page }) => {
  await page.goto(base);
  await page.locator('#auxToggle').check();
  await expect(page.locator('#auxToggle')).toBeChecked();
});

test('miss history → 3-point red marker, L reconstructed (not 0), tooltip raw fields', async ({ page }) => {
  const missHist = [
    { ts:'t', segment:0, L:40000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0, phi:1, miss:false, cacheRead:40000, cacheCreation:2000 },
    { ts:'t', segment:0, L:80000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0.9, phi:1.5, miss:false, cacheRead:80000, cacheCreation:2000 },
    { ts:'t', segment:0, L:82000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0.95, phi:1.6, miss:true, cacheRead:0, cacheCreation:82000 },
    { ts:'t', segment:0, L:83000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0.98, phi:1.7, miss:false, cacheRead:83000, cacheCreation:2000 },
  ];
  await page.route('**/api/history*', r => r.fulfill({ json: missHist }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_decisionChart && window.__SW_decisionChart.data.datasets[4]?.data?.length > 0);
  const res = await page.evaluate(() => {
    const chart = window.__SW_decisionChart;
    const ds = chart.data.datasets;
    const marker = ds[4];
    const Lseries = ds[0].data;
    // Actually EXERCISE the tooltip callback (GPT-plan-review #7): call afterBody with a marker point
    // (historyIndex 2) and confirm it renders the RAW cacheRead/cacheCreation, not the rendered y.
    const cb = chart.options.plugins.tooltip.callbacks.afterBody;
    const tipLines = cb([{ raw: { historyIndex: 2 }, dataIndex: 0 }]);
    // A1 (surgical): the index-aligned L line (dataset 0) MUST regain its dataIndex-mapped breakdown.
    // Pass the dataset object; its bare {x,y} points carry NO historyIndex, so the guard falls through
    // to item.dataIndex → lastHist[1] = row 1 (cacheRead 80000 / cacheCreation 2000). This is the
    // RED→GREEN discriminator: the committed 1e3ebd9 historyIndex-required guard returns '' here.
    const Lds = chart.data.datasets[0];
    const mainTip = cb([{ raw: Lds.data[1] ?? { x:1, y:80000 }, dataIndex: 1, datasetIndex: 0, dataset: Lds }]);
    // A1: the extrapolation dataset (index 2) holds only 2 points, is NOT index-aligned to `hist`, and is
    // tagged historyAligned:false. Hovering it used to fall back to items[0].dataIndex → render
    // lastHist[0]/[1]'s raw cacheRead/cacheCreation (a WRONG row). Pass the extrapolation DATASET so the
    // new dataset-tag guard fires (on the tag, not on historyIndex absence) → return '' so NO bogus
    // raw-field line renders. (raw still carries the real extrap x/y so the test reflects a real hover.)
    const extrapDS = chart.data.datasets[2];
    const extrap = extrapDS.data; // [{x,y},{x,y}] when kFitSlope>0 & etaCalls!=null
    const extrapTip0 = cb([{ raw: extrap[0] ?? { x: 0, y: 40000 }, dataIndex: 0, datasetIndex: 2, dataset: extrapDS }]);
    const extrapTip1 = cb([{ raw: extrap[1] ?? { x: 1, y: 120000 }, dataIndex: 1, datasetIndex: 2, dataset: extrapDS }]);
    return { markerLen: marker.data.length, x0: marker.data[0]?.x, x1: marker.data[1]?.x,
      y2: marker.data[2]?.y, hi0: marker.data[0]?.historyIndex, hi1: marker.data[1]?.historyIndex,
      LatMiss: Lseries[2]?.y, tip: tipLines.join('\n'),
      mainTip: Array.isArray(mainTip) ? mainTip.join('\n') : mainTip,
      extrapLen: extrap.length,
      extrapTip0: Array.isArray(extrapTip0) ? extrapTip0.join('\n') : extrapTip0,
      extrapTip1: Array.isArray(extrapTip1) ? extrapTip1.join('\n') : extrapTip1 };
  });
  expect(res.markerLen).toBe(3);                 // one miss → 3 points
  expect(res.x0).toBe(res.x1);                   // bottom & top share x
  expect(res.y2).toBeNull();                     // third point is the null separator
  expect(res.hi0).toBe(2); expect(res.hi1).toBe(2); // both carry the source history index
  expect(res.LatMiss).toBe(82000);              // L line reconstructed, NOT raw cacheRead 0
  expect(res.tip).toContain('cacheRead: 0');     // tooltip shows RAW read (0 at miss)
  expect(res.tip).toContain('cacheCreation: 82000'); // and raw creation (the reconstructed stock source)
  expect(res.tip).toContain('miss');             // and the miss annotation
  // A1 (surgical, RED→GREEN discriminator): an ordinary L-line point (dataset 0) regains its
  // dataIndex-mapped breakdown. row 1 → cacheRead 80000 / cacheCreation 2000. Pre-fix the
  // historyIndex-required guard returned '' here (mainTip==='') — this assertion was RED against 1e3ebd9.
  expect(res.mainTip).toContain('cacheRead: 80000');    // row 1's real read (dataIndex-mapped)
  expect(res.mainTip).toContain('cacheCreation: 2000');  // row 1's real creation
  // A1: hovering the extrapolation line (tagged historyAligned:false) renders NO raw-field line ('').
  // Pre-fix the dataIndex fallback showed lastHist[0]/[1]'s cacheRead/cacheCreation — a wrong row.
  expect(res.extrapTip0).toBe('');               // extrapolation start point → no bogus raw fields
  expect(res.extrapTip1).toBe('');               // extrapolation end point → no bogus raw fields
  expect(res.extrapTip0).not.toContain('cacheRead:');
  expect(res.extrapTip1).not.toContain('cacheCreation:');
  // FU-N1: pin the extrapolation series length (2 real projection points from this fixture).
  expect(res.extrapLen).toBe(2);
});

test('DeepSeek-shaped history (no miss) renders NO red marker (structural no-op) — gemini reverse-assertion', async ({ page }) => {
  const noMiss = [
    { ts:'t', segment:0, L:40000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0, phi:1, miss:false, cacheRead:40000, cacheCreation:0 },
    { ts:'t', segment:0, L:80000, Lthreshold:120000, kAvg:940, kFitSlope:940, paybackP:0.9, phi:1.5, miss:false, cacheRead:80000, cacheCreation:0 },
  ];
  await page.route('**/api/history*', r => r.fulfill({ json: noMiss }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_decisionChart && window.__SW_decisionChart.data.datasets.length >= 5);
  const markerLen = await page.evaluate(() => window.__SW_decisionChart.data.datasets[4].data.length);
  expect(markerLen).toBe(0); // no miss → no vertical line
});
