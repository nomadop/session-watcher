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

// ER-2 (Task 10): the 外推 (kFit extrapolation) dataset and the 辅助 L* (LstarFit) dataset + its #auxToggle
// checkbox are retired. The decision chart now has exactly THREE datasets — [0] L, [1] Lthreshold,
// [2] cache-miss markers (the miss marker moved [4]→[2]). The old 'aux-L* toggle' test and every
// extrapolation-line assertion (extrapLen / extrapTip / FU-N1) are dropped with the chain.
test('miss history → 3-point red marker, L reconstructed (not 0), tooltip raw fields', async ({ page }) => {
  const missHist = [
    { ts:'t', segment:0, L:40000, Lthreshold:120000, kAvg:940, paybackP:0, phi:1, miss:false, cacheRead:40000, cacheCreation:2000 },
    { ts:'t', segment:0, L:80000, Lthreshold:120000, kAvg:940, paybackP:0.9, phi:1.5, miss:false, cacheRead:80000, cacheCreation:2000 },
    { ts:'t', segment:0, L:82000, Lthreshold:120000, kAvg:940, paybackP:0.95, phi:1.6, miss:true, cacheRead:0, cacheCreation:82000 },
    { ts:'t', segment:0, L:83000, Lthreshold:120000, kAvg:940, paybackP:0.98, phi:1.7, miss:false, cacheRead:83000, cacheCreation:2000 },
  ];
  await page.route('**/api/history*', r => r.fulfill({ json: missHist }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_decisionChart && window.__SW_decisionChart.data.datasets[2]?.data?.length > 0);
  const res = await page.evaluate(() => {
    const chart = window.__SW_decisionChart;
    const ds = chart.data.datasets;
    const marker = ds[2];                          // ER-2: miss markers moved [4]→[2]
    const Lseries = ds[0].data;
    // Actually EXERCISE the tooltip callback (GPT-plan-review #7): call afterBody with a marker point
    // (historyIndex 2) and confirm it renders the RAW cacheRead/cacheCreation, not the rendered y.
    const cb = chart.options.plugins.tooltip.callbacks.afterBody;
    const tipLines = cb([{ raw: { historyIndex: 2 }, dataIndex: 0 }]);
    // A1 (surgical): the index-aligned L line (dataset 0) MUST regain its dataIndex-mapped breakdown.
    // Pass the dataset object; its bare {x,y} points carry NO historyIndex, so the guard falls through
    // to item.dataIndex → lastHist[1] = row 1 (cacheRead 80000 / cacheCreation 2000).
    const Lds = chart.data.datasets[0];
    const mainTip = cb([{ raw: Lds.data[1] ?? { x:1, y:80000 }, dataIndex: 1, datasetIndex: 0, dataset: Lds }]);
    return { markerLen: marker.data.length, x0: marker.data[0]?.x, x1: marker.data[1]?.x,
      y2: marker.data[2]?.y, hi0: marker.data[0]?.historyIndex, hi1: marker.data[1]?.historyIndex,
      dsLen: ds.length,
      LatMiss: Lseries[2]?.y, tip: tipLines.join('\n'),
      mainTip: Array.isArray(mainTip) ? mainTip.join('\n') : mainTip };
  });
  expect(res.dsLen).toBe(3);                     // ER-2: exactly L / Lthreshold / miss — no 外推, no 辅助 L*
  expect(res.markerLen).toBe(3);                 // one miss → 3 points
  expect(res.x0).toBe(res.x1);                   // bottom & top share x
  expect(res.y2).toBeNull();                     // third point is the null separator
  expect(res.hi0).toBe(2); expect(res.hi1).toBe(2); // both carry the source history index
  expect(res.LatMiss).toBe(82000);              // L line reconstructed, NOT raw cacheRead 0
  expect(res.tip).toContain('cacheRead: 0');     // tooltip shows RAW read (0 at miss)
  expect(res.tip).toContain('cacheCreation: 82000'); // and raw creation (the reconstructed stock source)
  expect(res.tip).toContain('miss');             // and the miss annotation
  // A1 (surgical, RED→GREEN discriminator): an ordinary L-line point (dataset 0) regains its
  // dataIndex-mapped breakdown. row 1 → cacheRead 80000 / cacheCreation 2000.
  expect(res.mainTip).toContain('cacheRead: 80000');    // row 1's real read (dataIndex-mapped)
  expect(res.mainTip).toContain('cacheCreation: 2000');  // row 1's real creation
});

test('DeepSeek-shaped history (no miss) renders NO red marker (structural no-op) — gemini reverse-assertion', async ({ page }) => {
  const noMiss = [
    { ts:'t', segment:0, L:40000, Lthreshold:120000, kAvg:940, paybackP:0, phi:1, miss:false, cacheRead:40000, cacheCreation:0 },
    { ts:'t', segment:0, L:80000, Lthreshold:120000, kAvg:940, paybackP:0.9, phi:1.5, miss:false, cacheRead:80000, cacheCreation:0 },
  ];
  await page.route('**/api/history*', r => r.fulfill({ json: noMiss }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_decisionChart && window.__SW_decisionChart.data.datasets.length >= 3);
  const markerLen = await page.evaluate(() => window.__SW_decisionChart.data.datasets[2].data.length); // ER-2: miss markers [4]→[2]
  expect(markerLen).toBe(0); // no miss → no vertical line
});

// ── Step 3b: lastStopEvent banner (round-6 gemini#3) — the dashboard's only surface for a stop_hook
// alert now the OS popup is gone. Same STRICT priority + TTL as formatLine: the stop message wins the
// turn when its turnSeq === currentTurnSeq, else the banner is hidden. A minimal reliable status frame
// is enough (the banner render reads only status.rateLamp.lastStopEvent + currentTurnSeq).
const statusWithStop = (turnSeq, eventTurnSeq, message = 'STOP-BANNER-ALERT-XYZ') => ({
  model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
  metricsReliable: true, calibratingReason: null, phi: 2, paybackP: 0.5,
  baseline: { total: 55000, fingerprint: 'fp' },
  rateLamp: { reliable: true, hBreak: 8, billProgress: 0.9, inDeepWater: true, currentTurnSeq: turnSeq,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message, billCount: 0, turnSeq: eventTurnSeq } },
});

test('stop-banner: a live lastStopEvent (turnSeq === currentTurnSeq) shows the banner with the message', async ({ page }) => {
  await page.route('**/api/status*', r => r.fulfill({ json: statusWithStop(42, 42) }));
  await page.route('**/api/history*', r => r.fulfill({ json: [] }));
  await page.goto(base);
  const banner = page.locator('#stop-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('STOP-BANNER-ALERT-XYZ');
});

test('stop-banner TTL: a stale lastStopEvent (turnSeq !== currentTurnSeq) keeps the banner hidden', async ({ page }) => {
  await page.route('**/api/status*', r => r.fulfill({ json: statusWithStop(43, 41) }));
  await page.route('**/api/history*', r => r.fulfill({ json: [] }));
  await page.goto(base);
  const banner = page.locator('#stop-banner');
  // Give the poll handler a tick to run the render, then assert it stays hidden (TTL expired).
  await page.waitForTimeout(200);
  await expect(banner).toBeHidden();
});
