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
        globalThis.signalRows = () => stores.signal('session');
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
          React.createElement(InnerCompactionView, { monitor: stores.for('session'), t })));
      `,
    },
    bundle: true, write: false,
  });
  client = outputFiles[0].text;
});

const attempt = {
  id: 6, revision: 10, epoch: 1, status: 'committed', stepN: 1, cRatio: 2,
  startedAt: 0, endedAt: 1, range: { first: 4, last: 5, count: 2 }, slots: 1,
  call: { input: '', output: 'a summary', usage: { input: 20, output: 10, cacheRead: 60, cacheWrite: 0 } },
  contextChange: { before: 1030, after: 600, delta: -430, miss: 30 },
};
const recall = {
  cuts: [],
  steps: [
    { at: 2, usage: { input: 20, output: 7, cacheRead: 570, cacheWrite: 10 }, ratio: 2, post: 6 },
    { at: 3, resident: 4 },
  ],
};
// The segment's adjusted settlement: the one seal (step 1) and the recall request at step 2 that read the original `tool/result` at seq 3 back, whose request is call 2 of the stock chart.
const cut = { segment: 1, through: 99 };
const activity = { covered: true, judged: 2, pure: 1, targets: [{ seq: 3, type: 'tool/result', at: 1, reads: [{ at: 2, seq: 10 }] }] };
const initial = {
  epoch: 2, attempts: [attempt], tailCalls: 2, recall, cut, activity,
  calls: [{ seq: 5, stock: 1000, post: false }, { seq: 10, stock: 600, post: true }, { seq: 13, stock: 620, post: false }],
};
// The adjusted cost is 100 for the summary call, 30 for the cache rebuild and 600 for the recall request net of the rebuild it already counted.
const composition = [/压缩摘要.*100.*13\.7%/, /缓存重建.*30.*4\.1%/, /召回请求净增.*600.*82\.2%/];

async function mount(page, read) {
  await page.exposeFunction('monitorCall', async (endpoint, body) => ({ ok: true, value: await read(endpoint, body) }));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: client });
}

test('the toolbar opens a frozen current settlement, and only reopening reads a new one', async ({ page }) => {
  const requests = [];
  let rows = [];
  let report = initial;
  await mount(page, (endpoint, body) => {
    if (endpoint === 'inner-monitor') return { attempts: rows, handoffs: [] };
    requests.push([endpoint, body]);
    return report;
  });
  const button = page.getByRole('button', { name: '当前分段结算', exact: true });
  const drawer = page.getByRole('complementary');
  await expect(page.getByText(zh['monitor.rows.empty'])).toBeVisible();
  expect(requests).toEqual([]);
  await button.click();
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('#2');
  await expect(drawer.getByText('截至第 3 步', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: '回本' })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByText('盈亏 −304 = 节省 426 − 成本 730', { exact: true })).toBeVisible();

  rows = [attempt];
  report = { epoch: 3, attempts: [], tailCalls: 0, calls: [] };
  await page.evaluate(() => globalThis.signalRows());
  await expect(page.getByRole('treeitem').first()).toBeVisible();
  await drawer.getByRole('tab', { name: '上下文' }).click();
  await expect(drawer.getByText('合计 730', { exact: true })).toBeVisible();
  await expect(drawer.locator('.sw-cx-comp-row')).toHaveText(composition);
  await expect(drawer.getByText('主调用 3 次')).toBeVisible();
  await drawer.getByRole('tab', { name: '回本' }).click();
  await button.click();
  await expect(drawer.getByText('截至第 3 步', { exact: true })).toBeVisible();
  expect(requests).toEqual([['inner-monitor/settlement/current', { sessionId: 'session' }]]);

  await drawer.getByRole('button', { name: zh['monitor.drawer.close'] }).click();
  await expect(drawer).toHaveCount(0);
  await button.click();
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('#3');
  await expect(drawer.getByText('本段暂无已提交的压缩')).toBeVisible();
  expect(requests).toHaveLength(2);
});

test('closing while a snapshot is loading keeps its late reply out of the next opening', async ({ page }) => {
  const first = Promise.withResolvers();
  let reads = 0;
  await mount(page, (endpoint) => {
    if (endpoint === 'inner-monitor') return { attempts: [], handoffs: [] };
    return ++reads === 1 ? first.promise : { epoch: 3, attempts: [], tailCalls: 0, calls: [] };
  });
  await page.evaluate(() => {
    const call = globalThis.monitorCall;
    globalThis.monitorCall = (endpoint, body) => {
      const reply = call(endpoint, body);
      if (endpoint !== 'inner-monitor') globalThis.firstReportReply ??= reply;
      return reply;
    };
  });
  const button = page.getByRole('button', { name: '当前分段结算', exact: true });
  const drawer = page.getByRole('complementary');
  await button.click();
  await expect.poll(() => reads).toBe(1);
  await drawer.getByRole('button', { name: zh['monitor.drawer.close'] }).click();
  await button.click();
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('#3');
  first.resolve(initial);
  await page.evaluate(async () => {
    await globalThis.firstReportReply;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('#3');
  expect(reads).toBe(2);
});

test('a committed compaction without a post measurement does not show a zero balance', async ({ page }) => {
  const pending = {
    ...attempt,
    contextChange: { before: 1030, after: null, delta: null, miss: null },
  };
  await mount(page, (endpoint) => endpoint === 'inner-monitor'
    ? { attempts: [pending], handoffs: [] }
    : { epoch: 2, attempts: [pending], tailCalls: 0, calls: [initial.calls[0]] });

  await page.getByRole('button', { name: '当前分段结算', exact: true }).click();
  const drawer = page.getByRole('complementary');
  await expect(drawer.getByText('截至第 1 步', { exact: true })).toBeVisible();
  await expect(drawer.getByText('待测量：本段还没有读数完整的压缩。')).toBeVisible();
  await expect(drawer.getByText(/^盈亏/)).toHaveCount(0);
});

test('a partially measured segment keeps the known balance and explains the missing stock chart', async ({ page }) => {
  const pending = { ...attempt, id: 14, stepN: 2, contextChange: { before: 627, after: null, delta: null, miss: null } };
  await mount(page, (endpoint) => endpoint === 'inner-monitor'
    ? { attempts: [attempt, pending], handoffs: [] }
    : { ...initial, attempts: [attempt, pending], tailCalls: 0 });

  await page.getByRole('button', { name: '当前分段结算', exact: true }).click();
  const drawer = page.getByRole('complementary');
  await expect(drawer.getByText('部分压缩待测量；合计仅纳入读数完整的压缩。')).toBeVisible();
  await expect(drawer.getByText('盈亏 −304 = 节省 426 − 成本 730', { exact: true })).toBeVisible();
  await drawer.getByRole('tab', { name: '上下文' }).click();
  await expect(drawer.getByText('此快照的调用读数不足，无法绘制输入存量图。')).toBeVisible();
  await expect(drawer.getByText('合计 730', { exact: true })).toBeVisible();
  await expect(drawer.locator('.sw-cx-comp-row')).toHaveText(composition);
});

test('a target is read once when it is chosen, at the cut the snapshot named, shown as an excerpt and expanded in place', async ({ page }) => {
  const text = 'abcdefghij'.repeat(40);
  const requests = [];
  await mount(page, (endpoint, body) => {
    if (endpoint === 'inner-monitor') return { attempts: [], handoffs: [] };
    requests.push([endpoint, body]);
    return endpoint === 'inner-monitor/settlement/target' ? { seq: body.seq, type: 'tool/result', text } : initial;
  });
  await page.getByRole('button', { name: '当前分段结算', exact: true }).click();
  const drawer = page.getByRole('complementary');
  await drawer.getByRole('tab', { name: '上下文' }).click();
  const row = drawer.getByRole('button', { name: '事件 #3 工具结果，回读 1 步' });
  await expect(row).toBeVisible();
  const targetReads = () => requests.filter(([endpoint]) => endpoint === 'inner-monitor/settlement/target');
  expect(targetReads(), 'nothing is read before a target is chosen').toEqual([]);

  await row.click();
  await expect(drawer.locator('[data-sw-recall-text="excerpt"]')).toHaveText(`${text.slice(0, 280)}…`);
  expect(targetReads()).toEqual([['inner-monitor/settlement/target', { sessionId: 'session', segment: 1, through: 99, seq: 3 }]]);

  await drawer.getByRole('button', { name: '展开全文（400 字）' }).click();
  await expect(drawer.locator('[data-sw-recall-text="whole"]')).toHaveText(text);
  await drawer.getByRole('button', { name: '收起' }).click();
  await expect(drawer.locator('[data-sw-recall-text="excerpt"]')).toBeVisible();
  expect(targetReads(), 'expanding reads nothing more').toHaveLength(1);
});

test('the before-first-seal band and legend stay muted in light and dark themes', async ({ page }) => {
  await mount(page, endpoint => (endpoint === 'inner-monitor' ? { attempts: [], handoffs: [] } : initial));
  await page.addStyleTag({ content: MONITOR_CSS });
  await page.getByRole('button', { name: '当前分段结算', exact: true }).click();
  const drawer = page.getByRole('complementary');
  await drawer.getByRole('tab', { name: '上下文' }).click();
  const bands = drawer.locator('rect.sw-rc-zero');
  const key = drawer.locator('.sw-rc-zero-key');
  await expect(bands).toHaveCount(2);

  for (const color of ['rgba(0, 0, 0, 0.04)', 'rgba(255, 255, 255, 0.06)']) {
    await page.evaluate(value => document.documentElement.style.setProperty('--dsw-alias-border-l1', value), color);
    expect(await bands.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill))).toEqual([color, color]);
    await expect(key).toHaveCSS('background-color', color);
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--dsw-alias-border-l1'));
  expect(await bands.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill))).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  await expect(key).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('a snapshot with no recall activity shows its status on the payback tab and none of the unadjusted figures, the context tab keeping its own', async ({ page }) => {
  const { activity: _activity, ...older } = initial;
  await mount(page, endpoint => (endpoint === 'inner-monitor' ? { attempts: [], handoffs: [] } : older));
  await page.getByRole('button', { name: '当前分段结算', exact: true }).click();
  const drawer = page.getByRole('complementary');
  await expect(drawer.locator('[data-sw-monitor-notice="recall-unavailable"]')).toBeVisible();
  await expect(drawer.getByText(/盈亏|节省|成本/)).toHaveCount(0);
  await drawer.getByRole('tab', { name: '上下文' }).click();
  await expect(drawer.getByText('主调用 3 次')).toBeVisible();
  await expect(drawer.getByText(/^合计/)).toHaveCount(0);
});
