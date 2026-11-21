import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { zh } from '../../dsh/src/client/locales.js';

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
const initial = {
  epoch: 2, attempts: [attempt], tailCalls: 2, recall,
  calls: [{ seq: 5, stock: 1000, post: false }, { seq: 10, stock: 600, post: true }, { seq: 13, stock: 620, post: false }],
};

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
  await expect(drawer.getByText('−304 ▼', { exact: true })).toBeVisible();
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
  await expect(drawer.getByText('−304 ▼', { exact: true })).toBeVisible();
});
