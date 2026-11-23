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

async function open(page, detail) {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.exposeFunction('monitorCall', async (endpoint) => ({
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
      card({ id: '1:1:r3', warnings: [{ kind: 'old-attribution', oldLines: 19, newLines: 1, percent: 95, over: false }] }),
      card({ id: '1:1:r4', warnings: [{ kind: 'old-attribution', oldLines: 901, newLines: 99, percent: 90, over: true }] }),
    ],
  }));
  await expect(tab(drawer, zh['monitor.slotPage.summary'])).toHaveAttribute('aria-selected', 'true');
  await expect(tab(drawer, zh['monitor.slotPage.tools'])).toBeVisible();

  await tab(drawer, zh['monitor.slotPage.tools']).click();
  const cards = drawer.locator('article[data-sw-tool]');
  await expect(cards).toHaveCount(4);
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

  await expect(cards.nth(2).locator('[data-sw-warning="old-attribution"]')).toHaveText('文件读取的旧归因占比高 · 95%（旧 19 行，新 1 行）');
  await expect(cards.nth(3).locator('[data-sw-warning="old-attribution"]')).toHaveText('文件读取的旧归因占比高 · >90%（旧 901 行，新 99 行）');
  await expect(cards.nth(2).locator('[data-sw-warning="old-attribution"]')).toHaveCSS('color', WARN);

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
  const drawer = await open(page, slot({ warnings: ['old-attribution'], calls: [] }));
  await tab(drawer, zh['monitor.slotPage.tools']).click();
  await expect(drawer.locator('[data-sw-section="warnings"] [data-sw-warning="old-attribution"]')).toHaveText(zh['monitor.warning.old-attribution']);
  await expect(drawer.getByText(zh['monitor.tool.oldNote'])).toBeVisible();
  await expect(drawer.locator('article[data-sw-tool]')).toHaveCount(0);
});
