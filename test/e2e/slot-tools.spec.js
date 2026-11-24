import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { zh } from '../../dsh/src/client/locales.js';
import { MONITOR_CSS } from '../../dsh/src/client/scope.js';

if (process.env.SW_PLAYWRIGHT_CHANNEL) test.use({ channel: process.env.SW_PLAYWRIGHT_CHANNEL });

let client;
test.beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { InnerCompactionView } from './dsh/src/client/monitor-view.js';
        import { createMonitorStores } from './dsh/src/client/monitor-store.js';
        import { zh } from './dsh/src/client/locales.js';
        const stores = createMonitorStores({ call: (endpoint, body) => globalThis.monitorCall(endpoint, body) });
        const t = (key, params) => zh[key].replace(/\\{(\\w+)\\}/g, (_, name) => params[name]);
        createRoot(document.getElementById('root')).render(React.createElement(InnerCompactionView, { monitor: stores.for('session'), t }));
      `,
    },
    bundle: true, write: false,
  });
  client = outputFiles[0].text;
});

const WARN = 'rgb(255, 165, 0)';
const ERROR = 'rgb(255, 0, 0)';
const QUIET = 'rgb(120, 120, 120)';
// The host's alias tokens the monitor's rules read, as three distinct colours, and a page that gives the monitor a bounded height as the tab does.
const THEME = `
  :root { --dsw-alias-state-warn-primary: ${WARN}; --dsw-alias-state-error-primary: ${ERROR}; --dsw-alias-label-tertiary: ${QUIET};
    --dsw-alias-label-primary: rgb(0, 0, 0); --dsw-alias-state-business-primary: rgb(0, 0, 255); }
  html, body, #root { height: 100%; margin: 0; }
`;

const attempt = {
  id: 6, revision: 10, epoch: 0, status: 'committed', stepN: 1, cRatio: 2, startedAt: 0, endedAt: 1, range: { first: 4, last: 5, count: 2 }, slots: 1, reason: null,
  call: { state: 'received', endedAt: 1, finish: 'stop', thrown: null, input: '', output: 'a summary', outputDisplay: 'a summary', usage: { input: 20, output: 10, cacheRead: 60, cacheWrite: 0 } },
  contextChange: { before: 1030, after: 600, delta: -430, miss: 30 }, trigger: null,
};
const source = { type: 'assistant/message', kind: 'model', category: 'assistant' };
const slotList = { slots: [{ key: 10, turn: 1, step: 1, source, input: 'reading', output: 'a note' }] };

const textResult = (seq, text) => ({ seq, type: 'tool/result', visible: false, raw: { seq }, blocks: [{ type: 'tool-result', callId: 'r1', isError: false, blocks: [{ type: 'text', text }] }] });
const filler = seq => ({ seq, type: 'developer/message', visible: true, raw: { seq }, blocks: [{ type: 'text', text: `context ${seq}\n`.repeat(4) }] });
const events = [
  { seq: 10, type: 'assistant/message', visible: true, raw: { seq: 10 }, blocks: [{ type: 'text', text: 'reading' }, { type: 'tool-call', id: 'r1', name: 'read', arguments: '{"file_path":"a.js"}' }] },
  textResult(11, 'the whole file'),
  ...Array.from({ length: 30 }, (_, at) => filler(20 + at)),
  { ...textResult(60, 'file pruned'), visible: true },
];
const card = (overrides) => ({ id: '1:1:r1', name: 'read', input: '{"file_path":"a.js"}', result: { seq: 11, error: false, empty: false }, pruned: null, warnings: [], ...overrides });
const slot = tools => ({ key: 10, number: 1, seqs: events.map(event => event.seq), turn: 1, step: 1, source, c: 'a note', events, ...(tools === undefined ? {} : { tools }) });

// `requests` hears the endpoint of each request the monitor makes.
async function open(page, detail, requests = []) {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.exposeFunction('monitorCall', async (endpoint) => (requests.push(endpoint), {
    ok: true,
    value: endpoint === 'inner-monitor' ? { attempts: [attempt], handoffs: [] } : endpoint === 'inner-monitor/slots' ? slotList : detail,
  }));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: THEME + MONITOR_CSS });
  await page.addScriptTag({ content: client });
  await page.getByRole('treeitem').first().click();
  await page.locator('[data-sw-row="slot"]').first().click();
  return page.getByRole('complementary');
}

const tab = (drawer, name) => drawer.getByRole('tab', { name, exact: true });

test('a slot opens at its summary and its Tools tab shows the cards, whose jump opens the pruned replacement on the source page and brings it into view', async ({ page }) => {
  const drawer = await open(page, slot({
    warnings: ['state-write'],
    calls: [
      card({ pruned: { seq: 60 }, warnings: [{ kind: 'carrier-recall' }, { kind: 'state-write' }] }),
      card({ id: '1:1:r2', name: 'bash', input: '{"command":"ls"}', result: { seq: 12, error: true, empty: true } }),
      card({ id: '1:1:r3', warnings: [{ kind: 'read-block' }] }),
    ],
  }));
  await expect(tab(drawer, zh['monitor.slotPage.summary'])).toHaveAttribute('aria-selected', 'true');
  await expect(tab(drawer, zh['monitor.slotPage.tools'])).toBeVisible();

  await tab(drawer, zh['monitor.slotPage.tools']).click();
  const cards = drawer.locator('article[data-sw-tool]');
  await expect(cards).toHaveCount(3);
  await expect(drawer.locator('details[open]')).toHaveCount(0);
  await expect(cards.first().locator('[data-sw-warning="carrier-recall"]')).toHaveText(zh['monitor.tool.attempt.carrier-recall']);
  await expect(cards.first().locator('[data-sw-warning="state-write"]')).toHaveText(zh['monitor.tool.stateWrite']);
  await expect(drawer.locator('[data-sw-section="warnings"] [data-sw-warning="state-write"]')).toHaveText(zh['monitor.warning.state-write']);
  // Amber text marks a warning, red text only the failure, and the pruned note stays quiet.
  await expect(cards.first().locator('[data-sw-warning="carrier-recall"]')).toHaveCSS('color', WARN);
  await expect(cards.nth(1).locator('[data-state="error"]')).toHaveText(zh['monitor.tool.failed']);
  await expect(cards.nth(1).locator('[data-state="error"]')).toHaveCSS('color', ERROR);
  await expect(cards.first().locator('[data-sw-pruned]')).toHaveCSS('color', QUIET);
  await expect(cards.first().locator('[data-sw-pruned]')).toContainText(zh['monitor.tool.pruned']);

  await expect(cards.nth(2).locator('[data-sw-warning="read-block"]')).toHaveText(zh['monitor.tool.attempt.read-block']);
  await expect(cards.nth(2).locator('[data-sw-warning="read-block"]')).toHaveCSS('color', WARN);

  await cards.first().getByRole('button', { name: zh['monitor.tool.openPruned'].replace('{seq}', '60') }).click();
  await expect(tab(drawer, zh['monitor.slotPage.source'])).toHaveAttribute('aria-selected', 'true');
  const target = drawer.locator('details[data-seq="60"]');
  await expect(target).toHaveAttribute('open', '');
  await expect(target).toHaveAttribute('data-sw-opened', '');
  await expect(target.locator(':scope > summary')).toBeFocused();
  await expect(target).toBeInViewport();
  await expect(drawer.locator('[data-sw-opened]')).toHaveCount(1);

  // The reader's own next choice of a page clears the jump.
  await tab(drawer, zh['monitor.slotPage.tools']).click();
  await tab(drawer, zh['monitor.slotPage.source']).click();
  await expect(drawer.locator('[data-sw-opened]')).toHaveCount(0);
});

test('a slot with nothing to show has no Tools tab', async ({ page }) => {
  const none = await open(page, slot({ warnings: [], calls: [] }));
  await expect(tab(none, zh['monitor.slotPage.summary'])).toHaveAttribute('aria-selected', 'true');
  await expect(tab(none, zh['monitor.slotPage.tools'])).toHaveCount(0);
});

test('a slot that only has a warning to show opens its Tools tab on the header alone', async ({ page }) => {
  const drawer = await open(page, slot({ warnings: ['read-block'], calls: [] }));
  await tab(drawer, zh['monitor.slotPage.tools']).click();
  await expect(drawer.locator('[data-sw-section="warnings"] [data-sw-warning="read-block"]')).toHaveText(zh['monitor.tool.attempt.read-block']);
  await expect(drawer.locator('article[data-sw-tool]')).toHaveCount(0);
});

const CALL = { input: 1_000, output: 40, cacheRead: 5_000, cacheWrite: 300 };
const NEXT = { input: 2_000, output: 60, cacheRead: 7_000, cacheWrite: 0 };
const usageSlot = usage => ({ ...slot(), usage: { current: { seq: 10, usage: CALL }, next: { kind: 'main', seq: 14, usage: NEXT }, sourceTokens: 26_624, ...usage } });
const fill = (key, params) => zh[key].replace(/\{(\w+)\}/g, (_, name) => params[name]);
const block = (drawer, name) => drawer.locator(`[data-sw-section="${name}"]`);
const FOUR = ({ input, output, cacheRead, cacheWrite }) => [`${input} token`, `${output} token`, `${cacheRead} token`, `${cacheWrite} token`];

test('a slot with a measured call opens at its summary, offers Usage after the source text without a new request, and the page shows both calls and the estimate', async ({ page }) => {
  const requests = [];
  const drawer = await open(page, usageSlot(), requests);
  const labels = await drawer.getByRole('tab').allTextContents();
  expect(labels).toEqual(['overview', 'summary', 'source', 'usage'].map(name => zh[`monitor.slotPage.${name}`]));
  await expect(tab(drawer, zh['monitor.slotPage.summary'])).toHaveAttribute('aria-selected', 'true');
  const before = [...requests];
  expect(before.filter(endpoint => endpoint === 'inner-monitor/slot')).toHaveLength(1);

  await tab(drawer, zh['monitor.slotPage.usage']).click();
  await expect(tab(drawer, zh['monitor.slotPage.usage'])).toHaveAttribute('aria-selected', 'true');
  await expect(block(drawer, 'current').locator('h3')).toHaveText(fill('monitor.slotUsage.current', { seq: 10 }));
  await expect(block(drawer, 'current').locator('dt')).toHaveText([zh['monitor.slotUsage.input'], zh['monitor.usage.output'], zh['monitor.usage.cacheRead'], zh['monitor.usage.cacheWrite']]);
  await expect(block(drawer, 'current').locator('dd')).toHaveText(FOUR(CALL));
  await expect(block(drawer, 'next').locator('h3')).toHaveText(fill('monitor.slotUsage.nextMain', { seq: 14 }));
  await expect(block(drawer, 'next').locator('dd')).toHaveText(FOUR(NEXT));
  await expect(block(drawer, 'source')).toContainText(fill('monitor.slotUsage.approx', { tokens: '26624 token' }));
  await expect(block(drawer, 'source')).toContainText(zh['monitor.slotUsage.sourceNote']);

  await tab(drawer, zh['monitor.slotPage.source']).click();
  await tab(drawer, zh['monitor.slotPage.usage']).click();
  await tab(drawer, zh['monitor.slotPage.summary']).click();
  expect(requests, 'paging reads the resource the drawer already holds').toEqual(before);
});

const usageDrawer = async (page, usage) => {
  const drawer = await open(page, usageSlot(usage));
  await tab(drawer, zh['monitor.slotPage.usage']).click();
  return drawer;
};

test('the usage page words the successor as the summary call where no later slot holds a call', async ({ page }) => {
  const drawer = await usageDrawer(page, { next: { kind: 'summary', seq: 40, usage: NEXT } });
  await expect(block(drawer, 'next').locator('h3')).toHaveText(fill('monitor.slotUsage.nextSummary', { seq: 40 }));
  await expect(block(drawer, 'next').locator('dd')).toHaveText(FOUR(NEXT));
});

test('the usage page reads a call and an estimate that were not recorded as such, with no bucket shown', async ({ page }) => {
  const drawer = await usageDrawer(page, { current: { seq: 10, usage: null }, next: { kind: 'main', seq: 14, usage: null }, sourceTokens: null });
  for (const name of ['current', 'next', 'source']) await expect(block(drawer, name)).toContainText(zh['monitor.notRecorded']);
  await expect(drawer.locator('dl')).toHaveCount(0);
});

test('the usage page says a successor it cannot confirm cannot be confirmed, and shows an estimate of zero', async ({ page }) => {
  const drawer = await usageDrawer(page, { next: null, sourceTokens: 0 });
  await expect(block(drawer, 'next')).toContainText(zh['monitor.slotUsage.unconfirmed']);
  await expect(block(drawer, 'source')).toContainText(fill('monitor.slotUsage.approx', { tokens: '0 token' }));
});

test('a slot with an estimate alone shows the estimate and no call', async ({ page }) => {
  const drawer = await usageDrawer(page, { current: null, next: null, sourceTokens: 0 });
  await expect(block(drawer, 'source')).toContainText(fill('monitor.slotUsage.approx', { tokens: '0 token' }));
  await expect(block(drawer, 'current')).toHaveCount(0);
  await expect(block(drawer, 'next')).toHaveCount(0);
});

test('a slot of an older host keeps the pages it had, without a Usage tab', async ({ page }) => {
  await expect(tab(await open(page, slot()), zh['monitor.slotPage.usage'])).toHaveCount(0);
});

test('a slot with neither a call nor an estimate has no Usage tab', async ({ page }) => {
  await expect(tab(await open(page, usageSlot({ current: null, next: null, sourceTokens: null })), zh['monitor.slotPage.usage'])).toHaveCount(0);
});

// ── The two numbers the usage page colours ──────────────────────────────────────────────────────────────

// The colour of `locator` as sRGB bytes: the browser's own computed value (a mixed colour included) painted to one canvas pixel.
const rgbOf = locator => locator.evaluate((element) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = getComputedStyle(element).color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
});
const near = (actual, expected) => actual.every((value, at) => Math.abs(value - expected[at]) <= 1);
const lines = (drawer, name) => block(drawer, name).locator('dd');
const OUTPUT = 1;
const CACHE_WRITE = 3;
// By hand under this spec's tokens: the monitor's blue four parts in five with the primary text colour, and its amber three parts in five.
const BLUE_ON_TEXT = [0, 0, 204];
const AMBER_ON_TEXT = [153, 99, 0];
const TEXT = [0, 0, 0];

test('the usage page colours the slot\'s own output in the theme blue and the successor\'s cache write in the theme amber, a real zero included, and every other cell stays in the text colour', async ({ page }) => {
  const drawer = await usageDrawer(page, {});
  expect(await lines(drawer, 'next').nth(CACHE_WRITE).innerText()).toBe('0 token');

  expect(near(await rgbOf(lines(drawer, 'current').nth(OUTPUT).locator('[data-sw-usage]')), BLUE_ON_TEXT)).toBe(true);
  expect(near(await rgbOf(lines(drawer, 'next').nth(CACHE_WRITE).locator('[data-sw-usage]')), AMBER_ON_TEXT)).toBe(true);
  await expect(drawer.locator('[data-sw-usage]')).toHaveCount(2);
  for (const [name, coloured] of [['current', OUTPUT], ['next', CACHE_WRITE]]) {
    for (const at of [0, 1, 2, 3].filter(index => index !== coloured)) {
      expect(near(await rgbOf(lines(drawer, name).nth(at)), TEXT), `${name} cell ${at}`).toBe(true);
      await expect(lines(drawer, name).nth(at).locator('[data-sw-usage]')).toHaveCount(0);
    }
  }
  // The same fields of the other call, the labels, the heading and the estimate keep the colours they had.
  for (const [name, at] of [['next', OUTPUT], ['current', CACHE_WRITE]]) expect(near(await rgbOf(lines(drawer, name).nth(at)), TEXT), `${name} cell ${at}`).toBe(true);
  expect(near(await rgbOf(block(drawer, 'current').locator('dt').nth(OUTPUT)), [120, 120, 120])).toBe(true);
  expect(near(await rgbOf(block(drawer, 'next').locator('dt').nth(CACHE_WRITE)), [120, 120, 120])).toBe(true);
  expect(near(await rgbOf(block(drawer, 'current').locator('h3')), TEXT)).toBe(true);
  expect(near(await rgbOf(block(drawer, 'source').locator('p').last()), TEXT)).toBe(true);
});

test('the colour follows the field, not the value: a successor cache write above zero and the summary call\'s cache write are amber, and the slot\'s own output of zero is blue', async ({ page }) => {
  const drawer = await usageDrawer(page, {
    current: { seq: 10, usage: { ...CALL, output: 0 } }, next: { kind: 'summary', seq: 40, usage: { ...NEXT, cacheWrite: 4_096 } },
  });
  expect(await lines(drawer, 'current').nth(OUTPUT).innerText()).toBe('0 token');
  expect(await lines(drawer, 'next').nth(CACHE_WRITE).innerText()).toBe('4096 token');
  expect(near(await rgbOf(lines(drawer, 'current').nth(OUTPUT).locator('[data-sw-usage]')), BLUE_ON_TEXT)).toBe(true);
  expect(near(await rgbOf(lines(drawer, 'next').nth(CACHE_WRITE).locator('[data-sw-usage]')), AMBER_ON_TEXT)).toBe(true);
  await expect(drawer.locator('[data-sw-usage]')).toHaveCount(2);
});

test('a call with no recorded usage colours nothing', async ({ page }) => {
  const drawer = await usageDrawer(page, { current: { seq: 10, usage: null }, next: { kind: 'main', seq: 14, usage: null }, sourceTokens: null });
  await expect(drawer.locator('[data-sw-usage]')).toHaveCount(0);
});

test('an unconfirmed successor has no number to colour, and the slot\'s own output keeps its blue', async ({ page }) => {
  const drawer = await usageDrawer(page, { next: null, sourceTokens: 0 });
  await expect(drawer.locator('[data-sw-usage]')).toHaveCount(1);
  await expect(block(drawer, 'current').locator('[data-sw-usage]')).toHaveCount(1);
  await expect(block(drawer, 'next').locator('[data-sw-usage]')).toHaveCount(0);
});

test('an estimate alone colours nothing', async ({ page }) => {
  const drawer = await usageDrawer(page, { current: null, next: null, sourceTokens: 0 });
  await expect(drawer.locator('[data-sw-usage]')).toHaveCount(0);
});

// The theme's real tokens, light and dark, as the harness defines them: the primary text, the page, the monitor's blue and its amber.
const THEMES = {
  light: { text: [15, 17, 21], page: [255, 255, 255], blue: [65, 118, 230], amber: [245, 158, 11] },
  dark: { text: [249, 250, 251], page: [21, 21, 23], blue: [122, 170, 255], amber: [245, 158, 11] },
};
const css = rgb => `rgb(${rgb.join(', ')})`;
const luminance = rgb => rgb.map(byte => byte / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, at) => sum + v * [0.2126, 0.7152, 0.0722][at], 0);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const distance = (a, b) => Math.hypot(...a.map((v, at) => v - b[at]));

for (const [name, tokens] of Object.entries(THEMES)) {
  test(`in the ${name} theme the two numbers read on the page and still differ from the text and from each other`, async ({ page }) => {
    const drawer = await usageDrawer(page, {});
    await page.addStyleTag({ content: `:root { --dsw-alias-label-primary: ${css(tokens.text)}; --dsw-alias-state-business-primary: ${css(tokens.blue)}; --dsw-alias-state-warn-primary: ${css(tokens.amber)}; } body { background: ${css(tokens.page)}; }` });
    const blue = await rgbOf(lines(drawer, 'current').nth(OUTPUT).locator('[data-sw-usage]'));
    const amber = await rgbOf(lines(drawer, 'next').nth(CACHE_WRITE).locator('[data-sw-usage]'));
    const text = await rgbOf(lines(drawer, 'current').nth(0));
    expect(text).toEqual(tokens.text);
    for (const [label, colour] of [['blue', blue], ['amber', amber]]) {
      expect(contrast(colour, tokens.page), `${label} on the page`).toBeGreaterThanOrEqual(4.5);
      expect(distance(colour, text), `${label} from the text`).toBeGreaterThanOrEqual(100);
    }
    expect(distance(blue, amber), 'blue from amber').toBeGreaterThanOrEqual(100);
  });
}
