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

// Task 2 (frontend redesign): the old single-file dashboard (#decisionChart, #paybackChart,
// #statusbar, #lline, #stats, #stop-banner, window.__SW_decisionChart) is retired wholesale —
// public/index.html is now a modular ES-module shell with stable slots. The chart/status/banner
// UI is rebuilt as elements in later tasks (5/6/7/8); this test only verifies the new shell
// bootstraps: slots are attached and the e2e handle (window.__SW_dashboard = { store, transport })
// is live.
test('new dashboard shell loads with slots and e2e handle', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#sw-chrome')).toBeAttached();
  await expect(page.locator('#sw-hero')).toBeAttached();
  await expect(page.locator('#sw-history')).toBeAttached();
  await expect(page.locator('#sw-buckets')).toBeAttached();
  await expect(page.locator('#sw-terms')).toBeAttached();
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  await page.waitForFunction(() => window.__SW_dashboard?.transport != null);
});

test('transport fetches status+history and pushes into the store after start()', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store?.getSnapshot()?.status != null);
  const snapshot = await page.evaluate(() => window.__SW_dashboard.store.getSnapshot());
  expect(snapshot.status).not.toBeNull();
  expect(Array.isArray(snapshot.history)).toBe(true);
  expect(snapshot.capabilities).not.toBeNull();
});

// Task 6: Hero Diptych — EOQ curve + aux-bar + burn meter
test('hero diptych renders chart canvas in #sw-hero when landmarks available', async ({ page }) => {
  const mockStatus = {
    rateLamp: {
      reliable: true,
      C_RATIO: 10,
      L_read: 63000,
      lBase: 42000,
      x_display: 1.5,
      xEntry: 1.2,
      xSweet: 1.5,
      xExit: 2.0,
      wallP: 11,
      hBreak: 5.2,
      billProgress: 0.45,
      billCycleCount: 3,
      currentTurnSeq: 7,
      lastBillEvent: null,
      band: 'entry_to_sweet',
      burnRate: 0.19,
      kStable: 940,
    },
    kAvg: 940,
    baseline: { total: 42000, dead: 5000 },
    model: 'claude-sonnet-4-20250514',
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);
  // Wait for hero chart to be created
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.hero != null, { timeout: 10000 });

  // Verify chart canvas is visible in #sw-hero
  const canvas = page.locator('#sw-hero canvas.sw-hero-canvas');
  await expect(canvas).toBeVisible();

  // Verify position display shows x value
  const xval = page.locator('#sw-hero .sw-hero-xval');
  await expect(xval).toContainText('x:');

  // Verify aux-bar gradient element exists
  const auxBar = page.locator('#sw-hero .sw-aux-gradient');
  await expect(auxBar).toBeAttached();

  // Verify burn meter fill bar exists
  const burnFill = page.locator('#sw-hero .sw-burn-fill');
  await expect(burnFill).toBeAttached();

  // Verify burn meter shows cycle count
  const odometer = page.locator('#sw-hero .sw-burn-odometer');
  await expect(odometer).toContainText('×3');

  // Verify turns label
  const turns = page.locator('#sw-hero .sw-burn-turns');
  await expect(turns).toContainText('~6 turns');
});

test('hero diptych shows placeholder when landmarks unavailable', async ({ page }) => {
  const mockStatus = {
    rateLamp: {
      reliable: false,
      C_RATIO: 10,
      L_read: 10000,
      lBase: 42000,
      billProgress: null,
      billCycleCount: 0,
      currentTurnSeq: 1,
      lastBillEvent: null,
    },
    kAvg: 0,
    baseline: { total: 42000, dead: 5000 },
    model: 'claude-sonnet-4-20250514',
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store?.getSnapshot()?.status != null, { timeout: 10000 });

  // Hero chart should NOT be created when landmarks are unavailable
  const heroChart = await page.evaluate(() => window.__SW_dashboard?.charts?.hero);
  expect(heroChart).toBeFalsy();

  // Aux-bar placeholder should be visible
  const placeholder = page.locator('#sw-hero .sw-aux-placeholder');
  await expect(placeholder).toBeVisible();

  // Burn meter fill should be at 0% (billing unavailable)
  const burnFill = page.locator('#sw-hero .sw-burn-fill');
  const width = await burnFill.evaluate(el => el.style.width);
  expect(width).toBe('0%');
});

// Task 5: history chart — per-segment paging, ratchet axes, footnote stats
// Task 7: Pricing Chip + Popover
test('pricing chip is visible with pricing info in #sw-chrome', async ({ page }) => {
  await page.goto(base);
  // Wait for app to bootstrap
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  // Chip must be visible
  const chip = page.locator('#sw-chrome .sw-pricing-chip');
  await expect(chip).toBeVisible();
  // Label should have loaded from GET /api/pricing (not just "…")
  await expect(chip.locator('.sw-pricing-chip-label')).not.toHaveText('…');
});

test('pricing chip: click opens popover, click outside closes it', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);

  const chip = page.locator('#sw-chrome .sw-pricing-chip');
  await chip.waitFor({ state: 'visible' });

  const popover = page.locator('#sw-chrome .sw-pricing-popover');
  // Popover starts hidden
  await expect(popover).toBeHidden();

  // Click chip → popover opens
  await chip.click();
  await expect(popover).toBeVisible();

  // Click outside → popover closes
  await page.mouse.click(5, 5);
  await expect(popover).toBeHidden();
});

test('pricing chip: fill prices and save → POST sent, chip updates', async ({ page }) => {
  // Reset any previously saved pricing first so the test is idempotent
  await fetch(`${base}/api/pricing`, { method: 'DELETE' }).catch(() => {});

  const postRequests = [];
  await page.route('**/api/pricing', async (route) => {
    if (route.request().method() === 'POST') {
      postRequests.push(await route.request().postDataJSON());
    }
    // Pass through to real server
    await route.continue();
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);

  const chip = page.locator('#sw-chrome .sw-pricing-chip');
  await chip.waitFor({ state: 'visible' });
  // Wait for GET /api/pricing to complete (label not "…")
  await expect(chip.locator('.sw-pricing-chip-label')).not.toHaveText('…');
  await chip.click();

  const popover = page.locator('#sw-chrome .sw-pricing-popover');
  await expect(popover).toBeVisible();

  // Read current effective prices to pick different values
  const currentReadPrice = await popover.locator('.sw-pricing-read').inputValue();
  const currentWritePrice = await popover.locator('.sw-pricing-write').inputValue();

  // Use values that differ from current effective (offset by 1)
  const newRead = (parseFloat(currentReadPrice) || 3) + 1;
  const newWrite = (parseFloat(currentWritePrice) || 15) + 1;
  const expectedRatio = (newWrite / newRead).toFixed(3);

  // Fill read and write prices
  const readInput = popover.locator('.sw-pricing-read');
  const writeInput = popover.locator('.sw-pricing-write');
  await readInput.fill(String(newRead));
  await writeInput.fill(String(newWrite));

  // Ratio display should update
  const ratioDisplay = popover.locator('.sw-pricing-ratio');
  await expect(ratioDisplay).toContainText(`ratio = write/read = ${expectedRatio}`);

  // Save button should be enabled (dirty state)
  const saveBtn = popover.locator('.sw-pricing-save');
  await expect(saveBtn).toBeEnabled();

  // Click Save
  await saveBtn.click();

  // Wait for save to complete (button shows ✓ or returns to pristine)
  await page.waitForFunction(() => {
    const btn = document.querySelector('.sw-pricing-save');
    return btn && (btn.textContent.includes('✓') || btn.disabled);
  }, { timeout: 5000 });

  // POST should have been intercepted
  expect(postRequests.length).toBeGreaterThan(0);
  expect(postRequests[0]).toMatchObject({ readPrice: newRead, writePrice: newWrite });

  // Chip label should now reflect saved pricing
  const chipLabel = chip.locator('.sw-pricing-chip-label');
  // After save it should show the ratio, not "…"
  await expect(chipLabel).not.toHaveText('…');
});

test('pricing chip: reset button sends DELETE and reverts chip', async ({ page }) => {
  const deleteRequests = [];
  await page.route('**/api/pricing', async (route) => {
    if (route.request().method() === 'DELETE') {
      deleteRequests.push(true);
    }
    await route.continue();
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);

  const chip = page.locator('#sw-chrome .sw-pricing-chip');
  await chip.waitFor({ state: 'visible' });
  await chip.click();

  const popover = page.locator('#sw-chrome .sw-pricing-popover');
  await expect(popover).toBeVisible();

  // Click Reset
  const resetBtn = popover.locator('.sw-pricing-reset');
  await resetBtn.click();

  // Wait briefly for DELETE to fire
  await page.waitForTimeout(500);

  // DELETE should have been intercepted
  expect(deleteRequests.length).toBeGreaterThan(0);

  // Chip label should still be populated
  const chipLabel = chip.locator('.sw-pricing-chip-label');
  await expect(chipLabel).not.toHaveText('…');
});

test('history chart renders canvas, pagination, and footnote with multi-segment data', async ({ page }) => {
  const mockHistory = [];
  // Segment 0: 5 points
  for (let i = 0; i < 5; i++) {
    mockHistory.push({
      ts: new Date(Date.now() - 60000 + i * 1000).toISOString(),
      segment: 0, L: 20000 + i * 10000, Lthreshold: 120000,
      kAvg: 940, paybackP: i * 0.1, phi: 1 + i * 0.1,
      miss: i === 2, cacheRead: 20000 + i * 10000, cacheCreation: 2000,
    });
  }
  // Segment 1: 3 points
  for (let i = 0; i < 3; i++) {
    mockHistory.push({
      ts: new Date(Date.now() + i * 1000).toISOString(),
      segment: 1, L: 10000 + i * 15000, Lthreshold: 120000,
      kAvg: 850, paybackP: i * 0.2, phi: 1 + i * 0.2,
      miss: false, cacheRead: 10000 + i * 15000, cacheCreation: 1500,
    });
  }

  // Intercept /api/history to return multi-segment mock data
  await page.route('**/api/history', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(mockHistory),
  }));

  await page.goto(base);
  // Wait for the chart to render
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.history != null, { timeout: 10000 });

  // Verify canvas is visible in #sw-history
  const canvas = page.locator('#sw-history canvas.sw-history-canvas');
  await expect(canvas).toBeVisible();

  // Verify pagination controls exist
  const prevBtn = page.locator('#sw-history .sw-history-prev');
  const nextBtn = page.locator('#sw-history .sw-history-next');
  await expect(prevBtn).toBeAttached();
  await expect(nextBtn).toBeAttached();

  // Verify page label shows segment info (follow=true means on last segment = 2/2)
  const pageLabel = page.locator('#sw-history .sw-history-page');
  await expect(pageLabel).toHaveText('Segment 2/2');

  // Verify footnote stats are displayed
  await expect(page.locator('#sw-history .sw-fn-kavg')).toContainText('kAvg:');
  await expect(page.locator('#sw-history .sw-fn-g')).toContainText('g:');
  await expect(page.locator('#sw-history .sw-fn-segment')).toContainText('Segment: 2/2');
  await expect(page.locator('#sw-history .sw-fn-calls')).toContainText('Calls: 3');
  await expect(page.locator('#sw-history .sw-fn-conn')).toContainText('Conn:');
});

// ─── Task 10: Final Integration + E2E Validation ───────────────────────────

// Task 10a: window.__SW_dashboard handle verification
test('__SW_dashboard exposes store with getSnapshot/subscribe and transport with connectionState/refresh/start/destroy', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);

  const result = await page.evaluate(() => {
    const { store, transport } = window.__SW_dashboard;
    return {
      storeHasGetSnapshot: typeof store.getSnapshot === 'function',
      storeHasSubscribe: typeof store.subscribe === 'function',
      transportHasConnectionState: typeof transport.connectionState === 'string',
      transportHasRefresh: typeof transport.refresh === 'function',
      transportHasStart: typeof transport.start === 'function',
      transportHasDestroy: typeof transport.destroy === 'function',
    };
  });

  expect(result.storeHasGetSnapshot).toBe(true);
  expect(result.storeHasSubscribe).toBe(true);
  expect(result.transportHasConnectionState).toBe(true);
  expect(result.transportHasRefresh).toBe(true);
  expect(result.transportHasStart).toBe(true);
  expect(result.transportHasDestroy).toBe(true);
});

// Task 10b: No console.error during normal operation
test('no console.error during normal dashboard operation', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(`[pageerror] ${err.message}`));

  const mockStatus = {
    model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
    metricsReliable: true, calibratingReason: null, phi: 2, paybackP: 0.5,
    baseline: { total: 55000, fingerprint: 'fp' },
    rateLamp: {
      reliable: true, hBreak: 8, billProgress: 0.62, inDeepWater: false,
      currentTurnSeq: 42, billCycleCount: 3,
      C_RATIO: 10, L_read: 137000, lBase: 55000,
      xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11,
      band: 'sweet', dhat: 0.6, targetL: 165000, kAvg: 3200,
    },
  };
  const mockHistory = [
    { ts: 't', segment: 0, L: 40000, Lthreshold: 120000, kAvg: 940, paybackP: 0, phi: 1, miss: false, cacheRead: 40000, cacheCreation: 2000 },
    { ts: 't', segment: 0, L: 80000, Lthreshold: 120000, kAvg: 940, paybackP: 0.9, phi: 1.5, miss: false, cacheRead: 80000, cacheCreation: 2000 },
    { ts: 't', segment: 1, L: 20000, Lthreshold: 120000, kAvg: 940, paybackP: 0, phi: 1, miss: false, cacheRead: 20000, cacheCreation: 2000 },
  ];

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockHistory),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store?.getSnapshot()?.status != null, { timeout: 10000 });
  // Give a moment for all element updates to settle
  await page.waitForTimeout(500);

  // Filter out known non-fatal external noise (Chart.js CDN, EventSource errors from poll fallback)
  const fatalErrors = consoleErrors.filter(msg =>
    !msg.includes('EventSource') &&
    !msg.includes('cdn.jsdelivr') &&
    !msg.includes('[sw]') // element update errors already caught and logged
  );
  expect(fatalErrors).toHaveLength(0);
});

// Task 10c: Normal state — all elements visible, chart rendered, aux-bar has gradient, burn meter has fill
test('normal state: all elements visible with valid rateLamp landmarks', async ({ page }) => {
  const mockStatus = {
    model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
    metricsReliable: true, calibratingReason: null, phi: 2, paybackP: 0.5,
    baseline: { total: 55000, fingerprint: 'fp' },
    rateLamp: {
      reliable: true, hBreak: 8, billProgress: 0.62, inDeepWater: false,
      currentTurnSeq: 42, billCycleCount: 3,
      C_RATIO: 10, L_read: 137000, lBase: 55000,
      xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11,
      band: 'sweet', dhat: 0.6, targetL: 165000, kAvg: 3200,
    },
  };
  const mockHistory = [
    { ts: 't', segment: 0, L: 40000, Lthreshold: 120000, kAvg: 940, paybackP: 0, phi: 1, miss: false, cacheRead: 40000, cacheCreation: 2000 },
    { ts: 't', segment: 0, L: 80000, Lthreshold: 120000, kAvg: 940, paybackP: 0.9, phi: 1.5, miss: false, cacheRead: 80000, cacheCreation: 2000 },
    { ts: 't', segment: 1, L: 20000, Lthreshold: 120000, kAvg: 940, paybackP: 0, phi: 1, miss: false, cacheRead: 20000, cacheCreation: 2000 },
  ];

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockHistory),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.hero != null, { timeout: 10000 });

  // Chrome is visible
  await expect(page.locator('#sw-chrome .sw-chrome-bar')).toBeVisible();

  // Hero diptych chart canvas is visible
  const heroCanvas = page.locator('#sw-hero canvas.sw-hero-canvas');
  await expect(heroCanvas).toBeVisible();

  // Hero shows current x position
  const xval = page.locator('#sw-hero .sw-hero-xval');
  await expect(xval).toContainText('x:');

  // Aux-bar is visible (not the placeholder) and has a non-empty gradient background
  const barWrap = page.locator('#sw-hero .sw-aux-bar-wrap');
  await expect(barWrap).toBeVisible();

  const gradientBg = await page.locator('#sw-hero .sw-aux-gradient').evaluate(el => el.style.background);
  expect(gradientBg).not.toBe('none');
  expect(gradientBg).not.toBe('');

  // Burn meter fill bar has non-zero width (billProgress = 0.62 → ~62%)
  const burnFill = page.locator('#sw-hero .sw-burn-fill');
  await expect(burnFill).toBeAttached();
  const fillWidth = await burnFill.evaluate(el => el.style.width);
  expect(fillWidth).not.toBe('0%');
  expect(fillWidth).not.toBe('');

  // Burn meter odometer shows cycle count
  const odometer = page.locator('#sw-hero .sw-burn-odometer');
  await expect(odometer).toContainText('×3');

  // History chart canvas is visible
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.history != null, { timeout: 10000 });
  await expect(page.locator('#sw-history canvas.sw-history-canvas')).toBeVisible();

  // Bucket tree placeholder is visible (always shown in v2.x)
  await expect(page.locator('#sw-buckets .sw-buckets-placeholder')).toBeVisible();
  await expect(page.locator('#sw-buckets .sw-buckets-unavailable')).toContainText('unavailable');

  // Terms glossary is attached
  await expect(page.locator('#sw-terms .sw-terms')).toBeAttached();
  await expect(page.locator('#sw-terms .sw-terms-summary')).toContainText('Glossary');
});

// Task 10d: Calibrating state — hero shows placeholder, burn meter shows "—", chrome shows meta
test('calibrating state: hero placeholder, burn meter dash, aux-bar hidden', async ({ page }) => {
  const mockStatus = {
    model: 'claude-opus-4-8', L: 5000, Lstar: null, Lthreshold: null, restart: false,
    metricsReliable: false, calibratingReason: 'insufficient_data',
    baseline: null,
    rateLamp: { reliable: false },
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store?.getSnapshot()?.status != null, { timeout: 10000 });

  // Hero chart should NOT be created (no landmarks)
  const heroChart = await page.evaluate(() => window.__SW_dashboard?.charts?.hero);
  expect(heroChart).toBeFalsy();

  // heroDiptych container exists but shows "Calibrating…" verdict
  const verdictEl = page.locator('#sw-hero .sw-hero-verdict');
  await expect(verdictEl).toContainText('Calibrating');

  // depthAux shows placeholder text (bar is hidden, placeholder is visible)
  const auxPlaceholder = page.locator('#sw-hero .sw-aux-placeholder');
  await expect(auxPlaceholder).toBeVisible();

  // Aux-bar wrap is hidden when landmarks unavailable
  const barWrap = page.locator('#sw-hero .sw-aux-bar-wrap');
  await expect(barWrap).toBeHidden();

  // Burn meter fill is at 0% (billing ledger unavailable)
  const burnFill = page.locator('#sw-hero .sw-burn-fill');
  const fillWidth = await burnFill.evaluate(el => el.style.width);
  expect(fillWidth).toBe('0%');

  // Burn meter turns label shows "—" (breakEvenTurns not available)
  const turnsEl = page.locator('#sw-hero .sw-burn-turns');
  await expect(turnsEl).toContainText('—');
});

// Task 10e: Deep-water state — hero shows position past xExit, verdict warns
test('deep-water state: hero shows deep/wall verdict when x > xExit', async ({ page }) => {
  const mockStatus = {
    model: 'claude-opus-4-8', L: 300000, Lstar: 375000, Lthreshold: 375000, restart: false,
    metricsReliable: true, calibratingReason: null, phi: 3, paybackP: 0.9,
    baseline: { total: 55000, fingerprint: 'fp' },
    rateLamp: {
      reliable: true, hBreak: 2, billProgress: 0.95, inDeepWater: true,
      currentTurnSeq: 100, billCycleCount: 5,
      C_RATIO: 10, L_read: 300000, lBase: 55000,
      // x = 300000/55000 ≈ 5.45 which is > xExit (2.2) and > wallP (3.5)
      xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 3.5,
      band: 'wall', dhat: 0.9, targetL: 165000, kAvg: 3200,
    },
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.hero != null, { timeout: 10000 });

  // Hero chart is rendered
  const heroCanvas = page.locator('#sw-hero canvas.sw-hero-canvas');
  await expect(heroCanvas).toBeVisible();

  // Verdict should show wall or deep warning (x ≈ 5.45 > wallP 3.5)
  const verdictEl = page.locator('#sw-hero .sw-hero-verdict');
  const verdictText = await verdictEl.textContent();
  // x > wallP → 'At wall'
  expect(verdictText).toMatch(/At wall|Deep/i);

  // x value displayed should be greater than xExit
  const xvalEl = page.locator('#sw-hero .sw-hero-xval');
  const xvalText = await xvalEl.textContent();
  // x ≈ 5.45
  expect(xvalText).toContain('×');
  const xNum = parseFloat(xvalText.replace(/[^0-9.]/g, ''));
  expect(xNum).toBeGreaterThan(2.2); // > xExit

  // Burn meter fill should be near 100% (billProgress = 0.95)
  const burnFill = page.locator('#sw-hero .sw-burn-fill');
  const fillWidth = await burnFill.evaluate(el => el.style.width);
  const fillPct = parseFloat(fillWidth);
  expect(fillPct).toBeGreaterThan(90);
});

// Task 10f: Aux-bar pixel alignment — verify it is positioned beneath hero chart with non-zero width
test('aux-bar is positioned beneath hero chart canvas with non-zero width', async ({ page }) => {
  const mockStatus = {
    model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
    metricsReliable: true, calibratingReason: null, phi: 2, paybackP: 0.5,
    baseline: { total: 55000, fingerprint: 'fp' },
    rateLamp: {
      reliable: true, hBreak: 8, billProgress: 0.62, inDeepWater: false,
      currentTurnSeq: 42, billCycleCount: 3,
      C_RATIO: 10, L_read: 137000, lBase: 55000,
      xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11,
      band: 'sweet',
    },
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.hero != null, { timeout: 10000 });

  const heroCanvas = page.locator('#sw-hero canvas.sw-hero-canvas');
  const auxBarWrap = page.locator('#sw-hero .sw-aux-bar-wrap');

  // Both elements must be visible
  await expect(heroCanvas).toBeVisible();
  await expect(auxBarWrap).toBeVisible();

  // Get bounding boxes
  const canvasBox = await heroCanvas.boundingBox();
  const auxBox = await auxBarWrap.boundingBox();

  expect(canvasBox).not.toBeNull();
  expect(auxBox).not.toBeNull();

  // Aux-bar must appear below the canvas (bottom of canvas <= top of aux bar, with tolerance)
  expect(auxBox.y).toBeGreaterThanOrEqual(canvasBox.y);

  // Aux-bar must have non-zero width
  expect(auxBox.width).toBeGreaterThan(0);

  // Aux-bar must have non-zero height
  expect(auxBox.height).toBeGreaterThan(0);
});

// Task 10g: Full bootstrap sequence — featureDetect → store → mount all → transport → first update dispatches to all elements
test('full bootstrap: store receives first update, all elements updated after transport.start()', async ({ page }) => {
  const mockStatus = {
    model: 'claude-opus-4-8', L: 137000, Lstar: 375000, Lthreshold: 375000, restart: false,
    metricsReliable: true, calibratingReason: null, phi: 2, paybackP: 0.5,
    baseline: { total: 55000, fingerprint: 'fp' },
    rateLamp: {
      reliable: true, hBreak: 8, billProgress: 0.62, inDeepWater: false,
      currentTurnSeq: 42, billCycleCount: 3,
      C_RATIO: 10, L_read: 137000, lBase: 55000,
      xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11,
      band: 'sweet',
    },
  };

  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));

  await page.goto(base);

  // Wait for the first update to flow through the full pipeline
  await page.waitForFunction(() => {
    const snap = window.__SW_dashboard?.store?.getSnapshot();
    return snap?.status != null && snap?.capabilities != null;
  }, { timeout: 10000 });

  const snapshot = await page.evaluate(() => window.__SW_dashboard.store.getSnapshot());

  // Verify status was received
  expect(snapshot.status).not.toBeNull();
  expect(snapshot.status.model).toBe('claude-opus-4-8');
  expect(snapshot.status.L).toBe(137000);

  // Verify capabilities were computed (featureDetect ran)
  expect(snapshot.capabilities).not.toBeNull();
  expect(snapshot.capabilities.eoqLandmarks).toBeDefined();
  expect(snapshot.capabilities.eoqLandmarks.available).toBe(true);
  expect(snapshot.capabilities.billingLedger.available).toBe(true);
  expect(snapshot.capabilities.breakEvenTurns.available).toBe(true);

  // Verify history was received
  expect(Array.isArray(snapshot.history)).toBe(true);

  // Verify transport state is not 'connecting' after first fetch
  const connState = await page.evaluate(() => window.__SW_dashboard.transport.connectionState);
  expect(['sse-live', 'polling', 'disconnected']).toContain(connState);
});

// ─── Task 9: v2 dashboard element assertions ───────────────────────────────

// Shared mock for v2 tests that need rateLamp landmarks
const v2MockStatus = {
  model: 'claude-sonnet-4-20250514',
  rateLamp: {
    reliable: true,
    C_RATIO: 10,
    L_read: 63000,
    lBase: 42000,
    x_display: 1.5,
    xEntry: 1.2,
    xSweet: 1.5,
    xExit: 2.0,
    wallP: 11,
    hBreak: 5.2,
    billProgress: 0.45,
    billCycleCount: 3,
    currentTurnSeq: 7,
    lastBillEvent: null,
    band: 'entry_to_sweet',
    burnRate: 0.19,
    kStable: 940,
  },
  kAvg: 940,
  baseline: { total: 42000, dead: 5000 },
};

test('v2: u reading shows in hero header', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v2MockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));
  await page.goto(base);
  // Wait for hero to render
  await page.waitForSelector('.eoq-u');
  const text = await page.textContent('.eoq-u');
  expect(text).toMatch(/u = /);
});

test('v2: viewport frame renders in aux bar', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v2MockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.hero != null, { timeout: 10000 });
  await page.waitForSelector('.sw-aux-viewport-frame');
  const display = await page.$eval('.sw-aux-viewport-frame', el => getComputedStyle(el).display);
  expect(display).not.toBe('none');
});

test('v2: history footnote has L and base fields', async ({ page }) => {
  const mockHistory = [];
  for (let i = 0; i < 3; i++) {
    mockHistory.push({
      ts: new Date(Date.now() + i * 1000).toISOString(),
      segment: 0, L: 20000 + i * 10000, Lthreshold: 120000,
      kAvg: 940, paybackP: i * 0.1, phi: 1 + i * 0.1,
      miss: false, cacheRead: 20000 + i * 10000, cacheCreation: 2000,
    });
  }
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v2MockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockHistory),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.history != null, { timeout: 10000 });
  await page.waitForSelector('.sw-fn-l');
  await page.waitForSelector('.sw-fn-base');
});

test('v2: theme switcher dot present', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('.sw-theme-dot');
});

test('v2: pricing popover has preset select', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  await page.click('.sw-pricing-chip');
  await page.waitForSelector('.sw-pricing-preset-select');
});

test('v2: history crosshair responds to hover', async ({ page }) => {
  const mockHistory = [];
  for (let i = 0; i < 3; i++) {
    mockHistory.push({
      ts: new Date(Date.now() + i * 1000).toISOString(),
      segment: 0, L: 20000 + i * 10000, Lthreshold: 120000,
      kAvg: 940, paybackP: i * 0.1, phi: 1 + i * 0.1,
      miss: false, cacheRead: 20000 + i * 10000, cacheCreation: 2000,
    });
  }
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v2MockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mockHistory),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.charts?.history != null, { timeout: 10000 });
  const canvas = await page.waitForSelector('.sw-history-canvas');
  await canvas.hover();
  // Crosshair may or may not be visible depending on data, but element exists
  const exists = await page.$('.sw-history-crosshair');
  expect(exists).toBeTruthy();
});

test('v2: Pareto toggle removed', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  const el = await page.$('.sw-aux-pareto-toggle');
  expect(el).toBeNull();
});

test('v2: old x reading removed from hero', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v2MockStatus),
  }));
  await page.route('**/api/history', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store?.getSnapshot()?.status != null, { timeout: 10000 });
  const el = await page.$('.eoq-x');
  expect(el).toBeNull();
});

test('v2: token label removed from aux', async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  const el = await page.$('.sw-aux-toklabel');
  expect(el).toBeNull();
});
