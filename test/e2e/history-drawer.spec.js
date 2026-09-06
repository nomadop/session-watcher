import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proc, base, tmp;

const SNAPSHOT = {
  sections: [
    { label: 'S1',
      headline: '开场：把历史归一为物理 Turn',
      entries: [
        { u_text: '设计一个跨 session 的 turn queue',
          note: '先把历史归一为物理 Turn，再在读取阶段投影成 page' },
      ] },
    { label: 'S2',
      headline: '交接：补齐 projection 再接上 query',
      entries: [
        { u_text: '按照设计开始实现',
          note: '实现拆为 capture、projection、query 三层' },
        // note absent — this turn contributes its U row only.
        { u_text: '继续' },
      ] },
  ],
};

const LONG_SNAPSHOT = {
  sections: [
    { label: 'S1',
      headline: '开场：把历史归一为物理 Turn',
      entries: Array.from({ length: 20 }, (_, index) => ({
        u_text: `turn ${index + 1}`,
        note: `note ${index + 1}`,
      })) },
    { label: 'S2',
      headline: '交接：补齐 projection 再接上 query',
      entries: Array.from({ length: 20 }, (_, index) => ({
        u_text: `turn ${index + 21}`,
        note: index === 1 ? '实现拆为 capture、projection、query 三层' : `note ${index + 21}`,
      })) },
  ],
};

// A wayfinder far past what one divider line can show. The clip is CSS, so the whole string sits
// behind it — which is what makes an accessible-name assertion tell a hidden head from a shown one.
const LONG_HEADLINE = '把跨 session 的 turn queue 归一为物理 Turn 表，再在读取阶段投影成 page，'
  + '然后把 capture、projection、query 的边界重新画一遍，最后补上 handoff 投递记录';

// Many collapsed sections, each with a headline long enough to wrap: the list overflows while every
// section is shut, which is what makes a scroll-position assertion on the first open mean something.
const MANY_SECTIONS = {
  sections: Array.from({ length: 16 }, (_, index) => ({
    label: `S${index + 1}`,
    headline: `第 ${index + 1} 段的交接任务：${'把历史归一为物理 Turn，再在读取阶段投影成 page。'.repeat(2)}`,
    entries: [{ u_text: `turn ${index + 1}`, note: `note ${index + 1}` }],
  })),
};

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sw-e2e-drawer-'));
  // server.js reaches its entrypoint guard here and builds a real store and state file.
  // Without a HOME and SW_STATE_DIR of their own they would land in the developer's live
  // ~/.session-watcher, and the SIGTERM below would run cleanup() and unlink the state file of
  // whichever session owns that id.
  proc = spawn('node', ['server.js', '--project', 'fixtures/host/.claude/projects/C--Users-nomad-freshtrack', '--lbase', '42000', '--port', '0'],
    { env: { PATH: process.env.PATH, HOME: join(tmp, 'home'), SW_STATE_DIR: join(tmp, 'state'), SW_NO_OPEN: '1' } });
  const port = await new Promise((resolve, reject) => {
    let buf = ''; const t = setTimeout(() => reject(new Error('timeout')), 10000);
    proc.stdout.on('data', d => { buf += d; const m = buf.match(/PORT=(\d+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  base = `http://localhost:${port}`;
});
test.afterAll(() => { proc?.kill('SIGTERM'); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function setupPage(page, overrides = {}) {
  await page.route('**/api/turn/browse', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(overrides.snapshot ?? SNAPSHOT),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
}

const openDrawer = async (page) => {
  await page.click('.sw-history-trigger');
  await expect(page.locator('.sw-history-drawer.sw-history-drawer-open')).toBeVisible();
};

// Sections open collapsed, so every case that asserts on rows opens each section first.
const openSections = async (page) => {
  const dividers = page.locator('.sw-history-divider');
  await expect(dividers.first()).toBeVisible();
  for (let i = 0, n = await dividers.count(); i < n; i += 1) await dividers.nth(i).click();
  await expect(page.locator('.sw-history-section[data-expanded="false"]')).toHaveCount(0);
};

test('trigger 落在 history header 的 pager 之后，文案是 History 加段数', async ({ page }) => {
  await setupPage(page);
  const trigger = page.locator('.sw-history-actions .sw-history-anchor .sw-history-trigger');
  await expect(trigger).toBeVisible();
  // The number is there before the drawer has ever been opened. The accessible name is what pins the
  // whole of the entry's content: it holds the number after the word and admits nothing else.
  await expect(trigger.locator('.sw-history-count')).toHaveText('2');
  await expect(trigger).toHaveAccessibleName('History 2');
  await expect(page.locator('.sw-bookmark-trigger')).toHaveCount(0);
});

test('入口的段数跟着替换快照走，且不可用时没有数字', async ({ page }) => {
  let sections = SNAPSHOT.sections;
  await page.route('**/api/turn/browse', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ sections }),
  }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  const count = page.locator('.sw-history-count');
  await expect(count).toHaveText('2');
  sections = MANY_SECTIONS.sections;
  await openDrawer(page);
  await expect(page.locator('.sw-history-section')).toHaveCount(16);
  await expect(count).toHaveText('16');
  await page.keyboard.press('Escape');
  // An unavailable response retracts the number rather than reporting zero segments: a count of none
  // is a claim about the lineage, and a failed request does not make it. Asserted after the drawer's
  // own unavailable state, because an absent count also holds on a request still in flight.
  await page.unroute('**/api/turn/browse');
  await page.route('**/api/turn/browse', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await openDrawer(page);
  await expect(page.locator('.sw-history-empty')).toContainText('unavailable');
  await expect(count).toHaveCount(0);
});

test('chart 仍然挂载：pager 与 canvas 都在，抽屉没有顶掉图', async ({ page }) => {
  await setupPage(page);
  await expect(page.locator('.sw-history-canvas')).toBeVisible();
  await expect(page.locator('.sw-history-actions .pager')).toBeVisible();
});

test('每次打开只取一次快照，重开保留搜索和滚动', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/turn/browse', route => {
    calls += 1;
    const sections = LONG_SNAPSHOT.sections.map(section => ({
      ...section,
      entries: section.entries.map(entry => (entry.note.includes('三层')
        ? { ...entry, note: `${entry.note} · snapshot ${calls}` }
        : entry)),
    }));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sections }) });
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  // Waits for the mount request to land before the click, so that the counting below starts from a
  // settled state. Its subject is this test's own snapshot's section count, not a request count.
  await expect(page.locator('.sw-history-count')).toHaveText('2');
  await openDrawer(page);
  const list = page.locator('.sw-history-list');
  const search = page.locator('.sw-history-search input');
  await expect(search).toBeFocused();       // focus moves inside the modal before fetch settles
  await expect(list).toContainText('snapshot 2');
  await openSections(page);
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.waitForTimeout(1200);          // longer than one SSE-driven store update
  expect(calls).toBe(2);
  await list.evaluate(el => { el.scrollTop = 120; });
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(120);
  await page.keyboard.press('Escape');
  await openDrawer(page);
  await expect.poll(() => calls).toBe(3);
  await expect(list).toContainText('snapshot 3');
  // The expansion set is keyed by label, so a replacement snapshot reopens with the same sections
  // open and the reader's scroll position still means what it meant.
  await expect(page.locator('.sw-history-section[data-expanded="false"]')).toHaveCount(0);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(120);
  await search.fill('三层');
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0);
  await expect(page.locator('.sw-history-row')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await openDrawer(page);
  await expect.poll(() => calls).toBe(4);
  await expect(list).toContainText('snapshot 4');
  // Escape must not let Blink clear the search field: a retained filter with a blank box is a
  // filtered list with no visible cause.
  await expect(search).toHaveValue('三层');
  await expect(page.locator('.sw-history-row')).toHaveCount(2);
});

test('两个请求交叠时，晚到的失败不留下状态给下一次渲染捡走', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/turn/browse', async (route) => {
    calls += 1;
    if (calls === 1) {
      // Still in flight when the drawer opens, and it fails — the ordering that lets a failure land
      // after a success. Each completion has to write a state that agrees with itself.
      await new Promise((resolve) => { setTimeout(resolve, 2500); });
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) });
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  await openDrawer(page);
  await expect(page.locator('.sw-history-section')).toHaveCount(2);
  await expect.poll(() => calls).toBe(2);
  await page.waitForTimeout(2600);
  // A search term rebuilds the list. What it rebuilds from must still be the response the reader is
  // looking at, not the one that failed after it.
  await page.fill('.sw-history-search input', '三层');
  await expect(page.locator('.sw-history-row')).toHaveCount(2);
  await expect(page.locator('.sw-history-empty')).toHaveCount(0);
  await expect(page.locator('.sw-history-count')).toHaveText('2');
});

test('首次打开停在最老的 section：列表能滚但停在顶部', async ({ page }) => {
  await setupPage(page, { snapshot: MANY_SECTIONS });
  await openDrawer(page);
  const list = page.locator('.sw-history-list');
  await expect(page.locator('.sw-history-section')).toHaveCount(16);
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0);
  // Still at the top after the open path's own frame has run: the initial position is not the end.
  await page.waitForTimeout(300);
  expect(await list.evaluate(el => el.scrollTop)).toBe(0);
  await expect(page.locator('.sw-history-divider').first().locator('strong')).toHaveText('S1');
});

test('展开一行不重建列表，滚动位置原地不动', async ({ page }) => {
  await setupPage(page, { snapshot: LONG_SNAPSHOT });
  await openDrawer(page);
  await openSections(page);
  const list = page.locator('.sw-history-list');
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate(el => { el.scrollTop = 200; });
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(200);
  const row = page.locator('.sw-history-row[data-role="assistant"]').nth(5);
  const main = row.locator('.sw-history-main');
  // Hover first, then take the baseline. Playwright runs scrollRectIntoViewIfNeeded on the target
  // before it dispatches anything, and hover runs the identical scroll, so this is the position the
  // click actually starts from. toBeInViewport() cannot stand in for that guard: it passes on a
  // partial intersection Chrome still scrolls to correct, and that scroll would land between the
  // baseline and the click, where it reads as the accordion having moved the list.
  await main.hover();
  await expect(row).toBeInViewport();
  const before = await list.evaluate(el => el.scrollTop);
  await main.click();
  await expect(row).toHaveAttribute('data-expanded', 'true');
  expect(await list.evaluate(el => el.scrollTop)).toBe(before);
  await main.hover();
  await main.click();
  await expect(row).toHaveAttribute('data-expanded', 'false');
  expect(await list.evaluate(el => el.scrollTop)).toBe(before);
});

test('带 note 的 turn 出两行，靠 data-role 区分，且没有地址列', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  const rows = page.locator('.sw-history-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute('data-role', 'user');
  await expect(rows.nth(1)).toHaveAttribute('data-role', 'assistant');
  await expect(rows.nth(0).locator('.sw-history-role')).toHaveAttribute('role', 'img');
  await expect(rows.nth(0).locator('.sw-history-role')).toHaveAccessibleName('User');
  await expect(rows.nth(1).locator('.sw-history-role')).toHaveAccessibleName('Assistant');
  await expect(page.locator('.sw-history-address')).toHaveCount(0);
  await expect(page.locator('.sw-history-list')).not.toContainText('S1:');
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveCount(0);
});

test('divider 显 S{k} 加 headline 的单行 head，无 session id、无标题、无时间戳', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const dividers = page.locator('.sw-history-divider');
  await expect(dividers).toHaveCount(2);
  await expect(dividers.nth(0).locator('strong')).toHaveText('S1');
  await expect(dividers.nth(0).locator('.sw-history-headline-head')).toHaveText('开场：把历史归一为物理 Turn');
  await expect(dividers.nth(1).locator('strong')).toHaveText('S2');
  await expect(page.locator('.sw-history-list')).not.toContainText('sess-old');
});

test('section 默认折叠：divider 是控件，headline 块代替行显示', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const sections = page.locator('.sw-history-section');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute('data-expanded', 'false');
  await expect(sections.nth(1)).toHaveAttribute('data-expanded', 'false');
  const divider = sections.nth(0).locator('.sw-history-divider');
  await expect(divider).toHaveAttribute('role', 'button');
  await expect(divider).toHaveAttribute('tabindex', '0');
  await expect(divider).toHaveAttribute('aria-expanded', 'false');
  await expect(sections.nth(0).locator('.sw-history-headline')).toBeVisible();
  await expect(sections.nth(0).locator('.sw-history-headline'))
    .toHaveText('开场：把历史归一为物理 Turn');
  await expect(sections.nth(0).locator('.sw-history-row').first()).not.toBeVisible();
});

test('section 多开：展开一个不折叠另一个，折叠只藏行不清行内展开态', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const s1 = page.locator('.sw-history-section').nth(0);
  const s2 = page.locator('.sw-history-section').nth(1);
  await s1.locator('.sw-history-divider').click();
  await expect(s1).toHaveAttribute('data-expanded', 'true');
  await expect(s1.locator('.sw-history-divider')).toHaveAttribute('aria-expanded', 'true');
  await expect(s2).toHaveAttribute('data-expanded', 'false');
  await s2.locator('.sw-history-divider').click();
  await expect(s1).toHaveAttribute('data-expanded', 'true');
  await expect(s2).toHaveAttribute('data-expanded', 'true');
  const row = s1.locator('.sw-history-row[data-role="assistant"]').first();
  await row.locator('.sw-history-main').click();
  await expect(row).toHaveAttribute('data-expanded', 'true');
  await s1.locator('.sw-history-divider').click();
  await expect(s1).toHaveAttribute('data-expanded', 'false');
  await expect(row).not.toBeVisible();
  await expect(row).toHaveAttribute('data-expanded', 'true');
  await s1.locator('.sw-history-divider').click();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-expanded', 'true');
});

test('headline 块只在折叠态出现，单行 head 两态都在，而控件名只有 label', async ({ page }) => {
  await setupPage(page, { snapshot: { sections: [
    { label: 'S1', headline: LONG_HEADLINE,
      entries: [{ u_text: '设计一个跨 session 的 turn queue', note: '先把历史归一为物理 Turn' }] },
  ] } });
  await openDrawer(page);
  const section = page.locator('.sw-history-section');
  const divider = section.locator('.sw-history-divider');
  const head = section.locator('.sw-history-headline-head');
  const block = section.locator('.sw-history-headline');
  await expect(head).toBeVisible();
  await expect(head).toHaveText(LONG_HEADLINE);
  await expect(block).toBeVisible();
  await expect(block).toHaveText(LONG_HEADLINE);
  await divider.click();
  await expect(section).toHaveAttribute('data-expanded', 'true');
  await expect(block).not.toBeVisible();
  await expect(head).toBeVisible();
  // The block is a sibling of the control, and the head is out of the name computation, so the whole
  // wayfinder — which the CSS clip and its fade leave intact behind them — names nothing.
  await expect(divider.locator('.sw-history-headline')).toHaveCount(0);
  await expect(divider).toHaveAccessibleName('S1');
});

test('键盘 Enter 与 Space 都能开合 section', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const section = page.locator('.sw-history-section').nth(0);
  const divider = section.locator('.sw-history-divider');
  await divider.focus();
  await page.keyboard.press('Enter');
  await expect(section).toHaveAttribute('data-expanded', 'true');
  await expect(divider).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Enter');
  await expect(section).toHaveAttribute('data-expanded', 'false');
  await page.keyboard.press(' ');
  await expect(section).toHaveAttribute('data-expanded', 'true');
});

test('收起态点路牌块也展开该段，展开后块让位给行', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const section = page.locator('.sw-history-section').nth(0);
  const block = section.locator('.sw-history-headline');
  await expect(section).toHaveAttribute('data-expanded', 'false');
  await block.click();
  await expect(section).toHaveAttribute('data-expanded', 'true');
  await expect(block).not.toBeVisible();
  await expect(section.locator('.sw-history-row').first()).toBeVisible();
  await expect(section.locator('.sw-history-divider')).toHaveAttribute('aria-expanded', 'true');
});

test('搜索期间命中的 section 强制展开，清空后回到用户自己的展开集', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const sections = page.locator('.sw-history-section');
  const s1 = page.locator('.sw-history-section[aria-label="S1"]');
  const s2 = page.locator('.sw-history-section[aria-label="S2"]');
  const search = page.locator('.sw-history-search input');
  // The reader's own set: S1 opened by a click, S2 never touched.
  await s1.locator('.sw-history-divider').click();
  await expect(s1).toHaveAttribute('data-expanded', 'true');
  await expect(s2).toHaveAttribute('data-expanded', 'false');
  // '三层' is carried only by S2's note, so S2 is the one section that renders, and it renders open.
  await search.fill('三层');
  await expect(sections).toHaveCount(1);
  await expect(s2).toHaveAttribute('data-expanded', 'true');
  await expect(s2.locator('.sw-history-row').first()).toBeVisible();
  await expect(s2.locator('.sw-history-headline')).not.toBeVisible();
  await search.fill('');
  // Derived, not stored. Had the term written its matches into the expansion set, S2 would still be
  // open here; the term forced it open and left the set alone, so S1 returns to the click that
  // opened it and S2 returns to collapsed.
  await expect(sections).toHaveCount(2);
  await expect(s1).toHaveAttribute('data-expanded', 'true');
  await expect(s2).toHaveAttribute('data-expanded', 'false');
});

test('headline 为空串的 section 不出 head 也不出块，divider 仍带 label 且仍能开合', async ({ page }) => {
  await setupPage(page, { snapshot: { sections: [
    { label: 'S1', headline: '', entries: [{ u_text: '继续', note: '接着上一段做' }] },
  ] } });
  await openDrawer(page);
  const section = page.locator('.sw-history-section');
  const divider = section.locator('.sw-history-divider');
  await expect(divider).toHaveText('S1');
  await expect(section.locator('.sw-history-headline-head')).toHaveCount(0);
  await expect(section.locator('.sw-history-headline')).toHaveCount(0);
  await expect(section).toHaveAttribute('data-expanded', 'false');
  await divider.click();
  await expect(section).toHaveAttribute('data-expanded', 'true');
  await expect(section.locator('.sw-history-row').first()).toBeVisible();
});

test('note 缺失的 turn 只出 U 行，不留空的 A 格', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  await expect(page.locator('.sw-history-row[data-role="assistant"]')).toHaveCount(2);
  const rows = page.locator('.sw-history-row');
  await expect(rows.nth(4)).toHaveAttribute('data-role', 'user');
  await expect(rows.nth(4).locator('.sw-history-preview')).toHaveText('继续');
  // A preview sitting directly under a row is the control-less empty cell this replaced, so no row
  // may have one. Counting controls instead would not see the regression: the empty cell had none.
  // This assertion must stay after one that waits for content — a count of 0 also holds on a list
  // that has not rendered yet.
  await expect(page.locator('.sw-history-row > .sw-history-preview')).toHaveCount(0);
});

// The capture path cannot store an empty u_text — a turn opens only on a non-empty cleaned
// projection — so this pins the drawer's guard, not an observed row.
test('u_text 为空的 U 行退化成纯格子，而不是一个名字为空的按钮', async ({ page }) => {
  await setupPage(page, { snapshot: { sections: [
    { label: 'S1', headline: '开场', entries: [{ u_text: '', note: '有 note' }] },
  ] } });
  await openDrawer(page);
  await openSections(page);
  const rows = page.locator('.sw-history-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-role', 'user');
  await expect(rows.nth(0).locator('.sw-history-main')).toHaveCount(0);
  await expect(rows.nth(0).locator('.sw-history-preview')).toHaveText('');
  await expect(rows.nth(1).locator('.sw-history-main')).toHaveCount(1);
});

test('A 行展开显示 note 全文，展开状态互斥且跨重开保留', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  await page.locator('.sw-history-row[data-role="assistant"]').first().locator('.sw-history-main').click();
  await expect(page.locator('.sw-history-row[data-expanded="true"] .sw-history-copy')).toContainText('先把历史归一为物理 Turn');
  await page.locator('.sw-history-row[data-expanded="true"] .sw-history-detail').click();
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveAttribute('data-role', 'assistant');
  await page.locator('.sw-history-row[data-role="user"]').first().locator('.sw-history-main').click();
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveCount(1);
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveAttribute('data-role', 'user');
  await page.keyboard.press('Escape');
  await openDrawer(page);
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveCount(1);
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveAttribute('data-role', 'user');
});

test('展开区是可选中文本，不在按钮内：控件名只有预览行', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  const row = page.locator('.sw-history-row[data-role="assistant"]').first();
  const main = row.locator('.sw-history-main');
  await main.click();
  await expect(row).toHaveAttribute('data-expanded', 'true');
  // The detail is a sibling of the control, so it is not part of the control's accessible name.
  await expect(main.locator('.sw-history-detail')).toHaveCount(0);
  await expect(row.locator('.sw-history-detail')).toHaveCount(1);
  await expect(main).toHaveAccessibleName('先把历史归一为物理 Turn，再在读取阶段投影成 page');
});

test('U 行展开显示完整的 stored u_text', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  await page.locator('.sw-history-row[data-role="user"]').first().locator('.sw-history-main').click();
  const expanded = page.locator('.sw-history-row[data-expanded="true"]');
  await expect(expanded.locator('.sw-history-copy')).toHaveText('设计一个跨 session 的 turn queue');
});

test('搜索是客户端子串，只扫 u_text 与 note，并整对保留 U/A', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  await openSections(page);
  await page.locator('.sw-history-row[data-role="user"]').first().locator('.sw-history-main').click();
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveCount(1);
  await page.fill('.sw-history-search input', '三层');
  await expect(page.locator('.sw-history-row[data-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('.sw-history-row')).toHaveCount(2);
  await expect(page.locator('.sw-history-row').first().locator('.sw-history-preview'))
    .toHaveText('按照设计开始实现');
  await page.fill('.sw-history-search input', 'S2');
  await expect(page.locator('.sw-history-empty')).toBeVisible();
  // The headline is out of the corpus: a term that only its wayfinder carries reaches the empty
  // state, because a section matching on its headline alone would render holding no row.
  await page.fill('.sw-history-search input', '交接');
  await expect(page.locator('.sw-history-empty')).toBeVisible();
  await expect(page.locator('.sw-history-section')).toHaveCount(0);
  await page.fill('.sw-history-search input', 'zzz-no-match');
  await expect(page.locator('.sw-history-empty')).toBeVisible();
  // The entry's number counts what the drawer holds, so a term that renders nothing leaves it alone.
  // The trigger stays on screen behind the scrim, so both numbers are legible at once.
  await expect(page.locator('.sw-history-count')).toHaveText('2');
});

test('服务端文本按纯文本渲染，不解析为 HTML', async ({ page }) => {
  await setupPage(page, { snapshot: { sections: [
    { label: 'S1', headline: '<b>开场</b> wayfinder',
      entries: [{ u_text: '<img src=x> 设计', note: '<i>note</i>' }] },
  ] } });
  await openDrawer(page);
  await expect(page.locator('.sw-history-headline')).toContainText('<b>开场</b> wayfinder');
  await openSections(page);
  await expect(page.locator('.sw-history-preview').first()).toContainText('<img src=x> 设计');
  await expect(page.locator('.sw-history-list img')).toHaveCount(0);
  await expect(page.locator('.sw-history-list b')).toHaveCount(0);
});

test('每个成功快照都显示一条静态尾标，无编号无计数', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const horizon = page.locator('.sw-history-horizon');
  await expect(horizon).toBeVisible();
  await expect(horizon).toHaveText('Current-session turns are not included.');
  await expect(horizon).not.toHaveText(/\d/);
});

test('空快照显示空状态，不显示尾部标记以外的任何行', async ({ page }) => {
  await setupPage(page, { snapshot: { sections: [] } });
  await openDrawer(page);
  await expect(page.locator('.sw-history-empty')).toBeVisible();
  await expect(page.locator('.sw-history-row')).toHaveCount(0);
  await expect(page.locator('.sw-history-section')).toHaveCount(0);
  await expect(page.locator('.sw-history-horizon')).toBeVisible();
  // A lineage that holds nothing gets no number either: the entry's number counts segments, and the
  // empty state is what says there are none.
  await expect(page.locator('.sw-history-count')).toHaveCount(0);
});

test('非 2xx 显示不可用状态而不是空历史', async ({ page }) => {
  await page.route('**/api/turn/browse', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal' }) }));
  await page.goto(base);
  await page.waitForFunction(() => window.__SW_dashboard?.store != null);
  await openDrawer(page);
  await expect(page.locator('.sw-history-empty')).toContainText('unavailable');
});

// 一个 200 却不带 sections 数组的响应走同一个不可用态，而不是渲染成「没有存下来的 turn」。
test('200 但 body 无 sections 数组时也是不可用态，不是空历史', async ({ page }) => {
  await setupPage(page, { snapshot: {} });
  await openDrawer(page);
  await expect(page.locator('.sw-history-empty')).toContainText('unavailable');
  await expect(page.locator('.sw-history-horizon')).toHaveCount(0);
});

test('几何与 a11y：desktop 440px、窄屏满宽、打开设 .sw-wrap inert 并聚焦搜索、Escape/scrim/关闭键都能关', async ({ page }) => {
  await setupPage(page);
  await openDrawer(page);
  const box = await page.locator('.sw-history-drawer').boundingBox();
  expect(Math.round(box.width)).toBe(440);
  // base.css derives the horizon marker from the divider — the same rule-line treatment — so at the
  // desktop width the two stand the same height. Pinned here because the divider's own typography
  // has no other witness: every label assertion in this file reads the label's text, so a rule
  // dropped from the label leaves them all green while the line reflows around a fallback font. It
  // holds at the desktop width only; narrow enough and the marker's prose wraps, and that is no
  // regression.
  const dividerBox = await page.locator('.sw-history-divider').first().boundingBox();
  const horizonBox = await page.locator('.sw-history-horizon').boundingBox();
  expect(Math.round(dividerBox.height)).toBe(Math.round(horizonBox.height));
  await expect(page.locator('.sw-wrap')).toHaveAttribute('inert', '');
  await expect(page.locator('.sw-history-search input')).toBeFocused();
  await expect(page.locator('.sw-history-search input')).toHaveAccessibleName('Search history');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sw-history-drawer.sw-history-drawer-open')).toHaveCount(0);
  await expect(page.locator('.sw-wrap')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.sw-history-trigger')).toBeFocused();
  await openDrawer(page);
  await page.locator('.sw-history-scrim').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.sw-history-drawer.sw-history-drawer-open')).toHaveCount(0);
  await openDrawer(page);
  await page.locator('.sw-history-close').click();
  await expect(page.locator('.sw-history-drawer.sw-history-drawer-open')).toHaveCount(0);
  await page.setViewportSize({ width: 700, height: 900 });
  await openDrawer(page);
  const narrow = await page.locator('.sw-history-drawer').boundingBox();
  expect(Math.round(narrow.width)).toBe(700);
});
