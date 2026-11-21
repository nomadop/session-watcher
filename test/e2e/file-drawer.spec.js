import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proc, base, tmp;

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';
const C = '/repo/lib/c.js';
const pathRow = (path, over = {}) => ({
  path, tokens: 20000, lastTurn: 3, lastCallSeq: 4, totalSpent: 25000, churn: 1.25, efficiency: 80, readCount: 2, editCount: 0,
  touchSeqs: [1, 2], pureRereads: 0, defaultSelected: true, defaultDiscardReason: null, userOverride: null, ...over,
});
// Two files in one directory and one in another, so the panel folds `src` into a directory row and leaves `lib/c.js` a file row of its own.
// A skill and a bash residual stand beside them: the rows that are no file.
const BUCKETS = {
  dead: 40000,
  skills: [{ name: 'tdd', tokens: 3000, lastTurn: 2, lastCallSeq: 3, userOverride: null }],
  residual: { bash: [{ name: 'npm test', detail: '', tokens: 1200, count: 2, lastTurn: 3, lastCallSeq: 4, touchSeqs: [3] }], mcp: [], agent: [], tool: [] },
  paths: [pathRow(A), pathRow(B, { tokens: 15000 }), pathRow(C, { tokens: 9000 })],
  totalB: 44000, totalL: 90000, bDefault: 44000, totalResidualRaw: 6000, totalResidual: 6000, currentTurnSeq: 5, segment: 0,
};

const lines = (...numbers) => numbers.map(number => ({ number, text: `line ${number} of the file` }));
const HELD = { path: A, total: 9, runs: [{ offset: 2, lines: lines(2, 3) }, { offset: 6, lines: lines(6) }] };

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sw-e2e-file-drawer-'));
  // A HOME and SW_STATE_DIR of its own keep the server's store and state file out of the developer's live ~/.session-watcher.
  proc = spawn('node', ['server.js', '--project', 'fixtures/host/.claude/projects/C--Users-nomad-freshtrack', '--lbase', '42000', '--port', '0'],
    { env: { PATH: process.env.PATH, HOME: join(tmp, 'home'), SW_STATE_DIR: join(tmp, 'state'), SW_NO_OPEN: '1' } });
  const port = await new Promise((resolve, reject) => {
    let buf = ''; const t = setTimeout(() => reject(new Error('timeout')), 10000);
    proc.stdout.on('data', d => { buf += d; const m = buf.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  base = `http://localhost:${port}`;
});
test.afterAll(() => { proc?.kill('SIGTERM'); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const reply = (status, body) => route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// `answer(path)` is the status and body of the file endpoint for a path, and `posts` collects each request it receives.
async function setupPage(page, { answer = () => [200, HELD] } = {}) {
  const posts = [];
  await page.route('**/api/buckets', reply(200, BUCKETS));
  await page.route('**/api/bucket/file', async (route) => {
    const request = route.request();
    posts.push({ method: request.method(), type: request.headers()['content-type'], body: request.postDataJSON() });
    const [status, body] = await answer(request.postDataJSON().path);
    await reply(status, body)(route);
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  await dirRow(page).locator('.bucket-name').click();
  await expect(rowOf(page, A)).toBeVisible();
  return posts;
}

const dirRow = page => page.locator('.bucket-row.is-dir').first();
const rowOf = (page, path) => page.locator(`.bucket-row[data-id="file:${path}"]`);
const drawer = page => page.locator('.sw-filedrawer');
const openDrawer = page => page.locator('.sw-filedrawer.sw-drawer-open');

async function openFile(page, path = A) {
  await rowOf(page, path).locator('.bucket-name').click();
  await expect(openDrawer(page)).toBeVisible();
}

test('点文件行的名字打开抽屉：POST 路径、标题是路径、头里写持有行数，行是持有的行加间隔行', async ({ page }) => {
  const posts = await setupPage(page);
  await openFile(page);
  expect(posts).toEqual([{ method: 'POST', type: 'application/json', body: { path: A } }]);
  await expect(drawer(page).locator('.sw-drawer-title')).toHaveText(A);
  await expect(drawer(page)).toHaveAccessibleName(A);
  await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('Holds 3 of 9 lines');
  const scroll = drawer(page).locator('.sw-fl-scroll');
  await expect(scroll).toHaveAttribute('data-wrap', 'on');
  await expect(scroll.locator('.sw-fl-sep')).toHaveText(['⋯ Lines 1 not loaded', '⋯ Lines 4–5 not loaded', '⋯ Lines 7–9 not loaded']);
  await expect(scroll.locator('.sw-fl-n')).toHaveText(['2', '3', '6']);
  await expect(scroll.locator('.sw-fl-t')).toHaveText(['line 2 of the file', 'line 3 of the file', 'line 6 of the file']);
  await expect(drawer(page).locator('.sw-filedrawer-foot')).toHaveText('Line text is read from the disk now, so it can differ from what the session saw.');
});

test('复选框、目录行不打开抽屉：复选框只切换勾选，目录行只折叠', async ({ page }) => {
  await setupPage(page);
  const row = rowOf(page, A);
  const before = await row.getAttribute('aria-checked');
  await row.locator('.bucket-cb').click();
  await expect(row).not.toHaveAttribute('aria-checked', before);
  await expect(openDrawer(page)).toHaveCount(0);
  await dirRow(page).locator('.bucket-name').click();
  await expect(rowOf(page, A)).toBeHidden();
  await expect(openDrawer(page)).toHaveCount(0);
});

test('键盘：Enter 在文件行打开抽屉，Space 仍然切换勾选且不打开；目录行的 Enter 仍切换勾选', async ({ page }) => {
  await setupPage(page);
  const row = rowOf(page, A);
  const checked = await row.getAttribute('aria-checked');
  await row.focus();
  await page.keyboard.press('Space');
  await expect(row).not.toHaveAttribute('aria-checked', checked);
  await expect(openDrawer(page)).toHaveCount(0);
  // A toggle redraws the tree, which drops the focus the key press had on the row.
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(openDrawer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(openDrawer(page)).toHaveCount(0);

  const dir = dirRow(page);
  const dirChecked = await dir.getAttribute('aria-checked');
  await dir.focus();
  await page.keyboard.press('Enter');
  await expect(dir).not.toHaveAttribute('aria-checked', dirChecked);
  await expect(openDrawer(page)).toHaveCount(0);
});

test('文件行是可点的样子，抽屉是模态：打开时 .sw-wrap inert、焦点进抽屉，Escape、scrim、关闭钮都能关，关闭后焦点回到那一行', async ({ page }) => {
  await setupPage(page);
  await expect(rowOf(page, C)).toHaveCSS('cursor', 'pointer');
  for (const close of [
    () => page.keyboard.press('Escape'),
    () => page.locator('.sw-drawer-scrim.sw-drawer-scrim-visible').click({ position: { x: 5, y: 5 } }),
    () => drawer(page).locator('.sw-drawer-close').click(),
  ]) {
    await openFile(page, C);
    await expect(page.locator('.sw-wrap')).toHaveAttribute('inert', '');
    await expect(page.locator('.sw-drawer-scrim.sw-drawer-scrim-visible')).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer(page).locator('.sw-drawer-close')).toBeFocused();
    await close();
    await expect(openDrawer(page)).toHaveCount(0);
    await expect(page.locator('.sw-wrap')).not.toHaveAttribute('inert', '');
    await expect(rowOf(page, C)).toBeFocused();
  }
});

// What a poll does to the panel: the same snapshot handed to the store again redraws the whole tree.
const redraw = page => page.evaluate(() => {
  const { store } = window.__SW_dashboard;
  const { status, history, capabilities, bucketData } = store.getSnapshot();
  store.update(status, history, capabilities, bucketData);
});

test('抽屉开着时面板重画了树：关闭后焦点回到重画出来的那一行，不是已脱离页面的旧元素', async ({ page }) => {
  await setupPage(page);
  await openFile(page, C);
  await redraw(page);
  await page.keyboard.press('Escape');
  await expect(rowOf(page, C)).toBeFocused();
});

test('主题切换会重挂载面板：旧抽屉连同 scrim 被拆掉，页面只剩一个，且不再 inert', async ({ page }) => {
  await setupPage(page);
  await openFile(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('sw-theme-change')));
  await expect(page.locator('.sw-filedrawer')).toHaveCount(1);
  await expect(page.locator('.sw-filedrawer.sw-drawer-open')).toHaveCount(0);
  await expect(page.locator('.sw-wrap')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.sw-drawer-scrim')).toHaveCount(2);
});

test('没有持有行、读不了、不再持有、请求失败各有一句提示，没有行和头里的行数', async ({ page }) => {
  const answers = {
    [A]: [200, { path: A, total: 9, runs: [] }],
    [B]: [200, { path: B, reason: 'too-large' }],
    [C]: [200, { path: C, total: 2, runs: [{ offset: 1, lines: lines(1, 2) }] }],
  };
  await setupPage(page, { answer: path => answers[path] });
  // The drawer last showed lines, so what a notice leaves of them is told from what it never had.
  await openFile(page, C);
  await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('Holds 2 of 2 lines');
  await page.keyboard.press('Escape');
  answers[C] = [404, { error: 'not_held', message: 'The path is not held in the current context.' }];
  const cases = [
    [A, 'No lines of this file are held in the current context.'],
    [C, 'This path is no longer held in the current context.'],
  ];
  for (const [path, text] of cases) {
    await openFile(page, path);
    await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText(text);
    await expect(drawer(page).locator('.sw-fl-row')).toHaveCount(0);
    await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('');
    await page.keyboard.press('Escape');
    await expect(openDrawer(page)).toHaveCount(0);
  }
  await openFile(page, B);
  await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText('Unreadable: Too large');
  await page.keyboard.press('Escape');

  // A 404 is the host's `not_held` only by what its body says: the DSH tab answers an endpoint it lacks with a 404 too.
  const unavailable = 'This file is unavailable right now. Close and reopen the drawer to retry.';
  answers[A] = [500, { error: 'x' }];
  await openFile(page, A);
  await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText(unavailable);
  await page.keyboard.press('Escape');
  answers[A] = [404, { error: 'unknown_endpoint', message: 'unknown endpoint bucket/file' }];
  await openFile(page, A);
  await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText(unavailable);
});

test('只有文件行打开抽屉：系统提示、skill、残余、others 行点击或 Enter 都不打开，也没有文件行的样子', async ({ page }) => {
  await setupPage(page);
  await page.locator('.section-label[data-section="output"]').click();
  for (const id of ['system:prompt', 'skill:tdd', 'bash:npm test', 'others']) {
    const row = page.locator(`.bucket-row[data-id="${id}"]`);
    await expect(row, id).toBeVisible();
    await expect(row, id).not.toHaveClass(/is-file/);
    await expect(row, id).toHaveCSS('cursor', 'default');
    await row.locator('.bucket-name').click();
    await expect(openDrawer(page), id).toHaveCount(0);
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(openDrawer(page), id).toHaveCount(0);
  }
});

test('Escape 只属于打开着的抽屉：都关着时不被拦，开着的被拦并关掉，抽屉连同监听被拆掉后也不再拦', async ({ page }) => {
  await setupPage(page);
  const escapePrevented = () => page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await escapePrevented()).toBe(false);
  await openFile(page);
  expect(await escapePrevented()).toBe(true);
  await expect(openDrawer(page)).toHaveCount(0);
  expect(await escapePrevented()).toBe(false);

  await openFile(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('sw-theme-change')));
  await expect(openDrawer(page)).toHaveCount(0);
  expect(await escapePrevented()).toBe(false);
});

test('重开别的文件时上一个文件的行不留在新标题下：先是 Loading…，没有行，头里的行数清空，答案到了才换成新的行', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await setupPage(page, {
    answer: async (path) => {
      if (path !== B) return [200, HELD];
      await gate;
      return [200, { path: B, total: 1, runs: [{ offset: 1, lines: [{ number: 1, text: 'only b' }] }] }];
    },
  });
  await openFile(page, A);
  await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('Holds 3 of 9 lines');
  await page.keyboard.press('Escape');
  await openFile(page, B);
  await expect(drawer(page).locator('.sw-drawer-title')).toHaveText(B);
  await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText('Loading…');
  await expect(drawer(page).locator('.sw-fl-row')).toHaveCount(0);
  await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('');
  release();
  await expect(drawer(page).locator('.sw-fl-t')).toHaveText(['only b']);
});

test('换行开关只在抽屉里：默认开，关掉后行不折、可横向滚；重开同一文件是新的快照', async ({ page }) => {
  let held = HELD;
  await setupPage(page, { answer: () => [200, held] });
  await openFile(page);
  const toggle = drawer(page).locator('.sw-filedrawer-wrap');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const scroll = drawer(page).locator('.sw-fl-scroll');
  await expect(scroll.locator('.sw-fl-t').first()).toHaveCSS('white-space', 'pre-wrap');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(scroll).toHaveAttribute('data-wrap', 'off');
  await expect(scroll.locator('.sw-fl-t').first()).toHaveCSS('white-space', 'pre');
  await page.keyboard.press('Escape');

  const many = { path: A, total: 80, runs: [{ offset: 1, lines: lines(...Array.from({ length: 80 }, (_, at) => at + 1)) }] };
  held = many;
  await openFile(page);
  const body = drawer(page).locator('.sw-drawer-body');
  await expect(drawer(page).locator('.sw-fl-row')).toHaveCount(80);
  await body.evaluate((el) => { el.scrollTop = 200; });
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(200);
  await toggle.click();
  await expect(scroll).toHaveAttribute('data-wrap', 'on');
  expect(await body.evaluate(el => el.scrollTop)).toBe(200);
  await page.keyboard.press('Escape');

  held = { path: A, total: 3, runs: [{ offset: 1, lines: lines(1, 2, 3) }] };
  await openFile(page);
  await expect(drawer(page).locator('.sw-filedrawer-held')).toHaveText('Holds 3 of 3 lines');
  await expect(drawer(page).locator('.sw-fl-row')).toHaveCount(3);
});

test('晚到的旧答案不覆盖新打开的文件', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await setupPage(page, {
    answer: async (path) => {
      if (path === A) await gate;
      return [200, path === A ? HELD : { path: B, total: 1, runs: [{ offset: 1, lines: [{ number: 1, text: 'only b' }] }] }];
    },
  });
  await rowOf(page, A).locator('.bucket-name').click();
  await expect(drawer(page).locator('.sw-filedrawer-notice')).toHaveText('Loading…');
  await page.keyboard.press('Escape');
  await openFile(page, B);
  await expect(drawer(page).locator('.sw-fl-t')).toHaveText(['only b']);
  release();
  await page.waitForTimeout(200);
  await expect(drawer(page).locator('.sw-drawer-title')).toHaveText(B);
  await expect(drawer(page).locator('.sw-fl-t')).toHaveText(['only b']);
});

test('几何：桌面端抽屉靠右、比 History 宽；窄屏满宽；长行在关掉换行后横向滚动而不撑宽抽屉', async ({ page }) => {
  const long = 'x'.repeat(400);
  await setupPage(page, { answer: () => [200, { path: A, total: 2, runs: [{ offset: 1, lines: [{ number: 1, text: long }, { number: 2, text: 'short' }] }] }] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFile(page);
  // The drawer slides in, so its right edge reaches the viewport's once the transition has run.
  await expect.poll(async () => { const box = await drawer(page).boundingBox(); return Math.round(box.x + box.width); }).toBe(1280);
  const wide = await drawer(page).boundingBox();
  expect(wide.width).toBeGreaterThan(440);
  await drawer(page).locator('.sw-filedrawer-wrap').click();
  const scroll = drawer(page).locator('.sw-fl-scroll');
  expect(await scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect((await drawer(page).boundingBox()).width).toBe(wide.width);
  // The dashboard's own panels do not lay out at this width, so the drawer is narrowed while it is open.
  await page.setViewportSize({ width: 400, height: 800 });
  await expect.poll(async () => (await drawer(page).boundingBox()).width).toBe(400);
});
