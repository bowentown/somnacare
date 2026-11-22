import { expect, test } from '@playwright/test';
import {
  dstr,
  mkRecord,
  mkRecordWithStages,
  mockNativeUsage,
  navTo,
  NIGHT_SCHEMA,
  openAt,
  seed,
  synthEvents,
  watchErrors,
} from './_journeyHelpers';

// ─────────────────────────────────────────────────────────────
// 旅程 8：开屏可跳过 + 首次引导
// ─────────────────────────────────────────────────────────────
test('旅程8 冷启动：点按跳过开屏 → 主界面可交互', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.addInitScript(() => localStorage.setItem('somnacare_onboarded_v1', '1'));
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(300);
  // 开屏在场时点按任意处 → 立即卸载（不等 1.9s）
  await page.mouse.click(200, 300);
  await page.waitForTimeout(300);
  await expect(page.getByText('早安')).toBeVisible({ timeout: 5000 });
  expect(errors).toEqual([]);
});

test('旅程9 首次使用：引导卡出现且可完成/跳过', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.addInitScript(() => {
    sessionStorage.clear();
    localStorage.removeItem('somnacare_onboarded_v1');
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText(/欢迎/).first()).toBeVisible();
  // 尝试点跳过（若有）；否则走完两步
  const skip = page.getByRole('button', { name: /跳过/ });
  if (await skip.count()) await skip.first().click();
  const next = page.getByRole('button', { name: /下一步|开始/ });
  if (await next.count()) await next.first().click();
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程18 视觉三件套：24h 表盘 / 分期时间轴 / 月相挂件直达图鉴
// ─────────────────────────────────────────────────────────────
test('旅程18 视觉：睡眠时钟 + 效率指标 + 月相挂件直达图鉴', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await seed(page, [
    mkRecordWithStages(dstr(-1, fixed)),
    mkRecord(dstr(-2, fixed), '23:20', '06:50', 82),
  ], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByRole('img', { name: /昨晚睡眠 .*评分/ })).toBeVisible();
  await expect(page.getByText('睡眠效率', { exact: true }).first()).toBeVisible();
  const pill = page.getByTestId('nav-pill');
  await expect(pill).toHaveAttribute('data-active-index', '0');

  await page.getByRole('button', { name: '打开梦境旅行图鉴' }).click();
  await expect(page.getByText('大肥鱼的漫游图鉴').first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('梦境旅行能量')).toBeVisible();
  await expect(page.getByRole('img', { name: /梦境能量/ }).first()).toBeVisible();
  // 直接打开图鉴，不再切到 AI 分区、也不经过朋友圈
  await expect(pill).toHaveAttribute('data-active-index', '0');
  await expect(page.getByRole('dialog', { name: '大肥鱼的朋友圈' })).toHaveCount(0);
  // 退出图鉴回到睡眠区（用户的初心）
  await page.getByRole('button', { name: '关闭图鉴' }).click();
  await expect(page.getByText('大肥鱼的漫游图鉴')).toHaveCount(0);
  await expect(page.getByText('早安')).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程19 晚间折叠 + 趋势图拖拽 scrub
// ─────────────────────────────────────────────────────────────
test('旅程19 晚间折叠：评分卡收为小卡 → 可展开；趋势图可拖拽', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(23, 0, 0, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:10', 88),
    mkRecord(dstr(-2, fixed), '23:10', '06:50', 80),
  ], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 晚间默认折叠；展开后回到完整卡
  await expect(page.getByRole('button', { name: '展开昨晚睡眠详情' })).toBeVisible();
  await expect(page.getByText('总睡眠时长')).toHaveCount(0);
  await page.getByRole('button', { name: '展开昨晚睡眠详情' }).click();
  await expect(page.getByText('总睡眠时长')).toBeVisible();

  await navTo(page, '趋势');
  // Phase 1：默认视图已是起卧时段，拖拽测试先切到得分曲线
  await page.getByRole('button', { name: '得分曲线' }).click();
  const chart = page.getByTestId('score-chart');
  await expect(chart).toBeVisible();
  await page.waitForTimeout(500);   // 等分区滑动落位后再取坐标
  const box = await chart.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * 0.9, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.1, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('score-detail')).toContainText(dstr(-2, fixed).slice(5));

  // 第 110 轮恶性交互回归锁：小结卡曾整卡可点 → 图表每次点按/拖拽都冒泡
  // 把上方历史记录卡展开。拖拽 scrub 后历史卡必须保持收起。
  await expect(page.getByTestId('history-list')).toHaveCount(0);

  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程26 池塘真实动画路径（第 88 轮中-5）：?pond-live 强制逐帧——
// 此前 e2e 里 webdriver 恒真走静帧 30 步，逐帧 rAF 循环从未被覆盖
// ─────────────────────────────────────────────────────────────
test('旅程26 池塘逐帧动画：pond-live 下画布持续变化', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  });
  await page.clock.install({ time: new Date(new Date().setHours(10, 0, 0, 0)) });
  await page.goto('/?pond-live=1');
  await page.waitForTimeout(2600);
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  // 逐帧路径的判定信号 = 池塘自身的帧计数在推进（第 89 轮修正：WebGL 画布
  // 无法像素差分——toDataURL 读空白、getContext('2d') 为 null；?pond-live
  // 下 bootstrap 暴露 window.__pondFrames）
  const f0 = await page.evaluate(() => (window as any).__pondFrames ?? 0);
  await page.waitForTimeout(1500);
  const f1 = await page.evaluate(() => (window as any).__pondFrames ?? 0);
  expect(f0).toBeGreaterThan(0);            // 逐帧循环已启动
  expect(f1 - f0).toBeGreaterThanOrEqual(20);   // 1.5s 内推进 ≥20 帧（30fps 路径）
  expect(errors).toEqual([]);
});

// 旅程38 分区跟手滑动（第 130 轮）：v1.40.0 的补水闸 {hydrated && ...} 把轨道
// 从首帧挂载里拿走，而手势层 effect 是 [] 依赖只跑一次——首帧 trackRef 为 null
// 早退且永不重跑，指针监听器全部落空，五分区滑动全死。本旅程是它的行为级回归锁：
// ① 纵向滚轮照常滚（方向锁定不劫持垂直手势）；② 横向拖拽 1:1 跟手（transform
// 实时位移）+ 松手吸附翻页；③ 反向拖回。起点坐标在运行时探测安全点——
// data-no-swipe 控件（滑杆/开关/图表拖拽区）本来就该绕开，这正是手势层的契约。
test('旅程38 分区跟手滑动：横向拖拽翻页，纵向滚动不劫持', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, [mkRecord(dstr(-1), '23:10', '07:10', 86)], NIGHT_SCHEMA);
  await openAt(page, 21, 0);

  const nav = page.getByRole('navigation', { name: '主标签栏' });
  const navBtn = (name: string) => nav.getByRole('button', { name });
  await expect(navBtn('睡眠')).toHaveAttribute('aria-current', 'page');

  // 在当前分区找一个"手势层会接管"的安全起点：不落在免滑控件/可点击元素上。
  // dir='left' 表示要向左翻下一页（起点需靠右侧留出拖拽行程）
  const safePoint = (dir: 'left' | 'right') => page.evaluate((d) => {
    const SKIP = 'input, textarea, select, [data-no-swipe], [data-native-hscroll], button, a, [role="button"]';
    const xs = d === 'left' ? [345, 300, 250, 200, 150] : [35, 60, 100, 150, 200];
    for (const y of [200, 300, 400, 500, 600, 700, 160, 760]) {
      for (const x of xs) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest(SKIP)) return { x, y };
      }
    }
    return null;
  }, dir);

  // ① 纵向滚轮：分区自己的滚动条照常走（方向锁定只夺横向手势）
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(200);
  const scrolled = await page.evaluate(() => document.querySelector('.swipe-pane')?.scrollTop ?? -1);
  expect(scrolled).toBeGreaterThan(10);

  // ② 横向拖拽：today → trends。先跟手（transform 实时位移），松手后吸附翻页
  const p1 = await safePoint('left');
  expect(p1).not.toBeNull();
  await page.mouse.move(p1!.x, p1!.y);
  await page.mouse.down();
  await page.mouse.move(p1!.x - 130, p1!.y, { steps: 6 });
  const tf = await page.evaluate(() => document.querySelector('.swipe-track')?.getAttribute('style') ?? '');
  expect(tf).toMatch(/translate3d\(-\d+px/);   // 跟手中：轨道已经拖出实时位移
  // 手势闸门（第 131 轮）：拖拽中 <html> 挂 gesture-live——分钟滴答/池塘/
  // 极光+氛围光全部让路；松手后复位。闸门打在 html 上，React 重渲染冲不掉
  const gate = await page.evaluate(() => {
    const cs = (sel: string, prop: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop) : 'absent';
    };
    return {
      live: document.documentElement.classList.contains('gesture-live'),
      tintHidden: cs('.ambient-tint', 'visibility'),
      auroraPaused: cs('.animate-aurora-drift', 'animation-play-state'),
    };
  });
  expect(gate.live).toBe(true);
  expect(gate.tintHidden).toBe('hidden');
  expect(gate.auroraPaused).toBe('paused');
  await page.mouse.move(p1!.x - 280, p1!.y, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => document.documentElement.classList.contains('gesture-live'))).toBe(false);
  await expect(navBtn('趋势')).toHaveAttribute('aria-current', 'page', { timeout: 5000 });
  // 趋势分区内容真挂载（懒 chunk 加载窗口给足）
  await expect(page.getByTestId('sleep-calendar')).toBeVisible({ timeout: 8000 });

  // ③ 反向拖拽：trends → today，翻页可逆
  const p2 = await safePoint('right');
  expect(p2).not.toBeNull();
  await page.mouse.move(p2!.x, p2!.y);
  await page.mouse.down();
  await page.mouse.move(p2!.x + 280, p2!.y, { steps: 12 });
  await page.mouse.up();
  await expect(navBtn('睡眠')).toHaveAttribute('aria-current', 'page', { timeout: 5000 });
  await expect(page.getByText('梦境漫游').first()).toBeVisible({ timeout: 8000 });

  expect(errors).toEqual([]);
});
