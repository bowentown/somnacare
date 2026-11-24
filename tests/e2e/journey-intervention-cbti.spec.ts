import { test, expect } from '@playwright/test';
import {
  NIGHT_SCHEMA,
  dstr,
  mkRecord,
  navTo,
  openAt,
  seed,
  watchErrors,
} from './_journeyHelpers';

test('旅程42 睡前仪式 CBT-I 闭环：3 模式呼吸、仪式清单打卡与微课进度持久化', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 22, 15);
  await seed(
    page,
    [
      mkRecord(dstr(-1, fixed), '00:20', '06:30', 68),
      mkRecord(dstr(-2, fixed), '00:40', '06:40', 66),
      mkRecord(dstr(-3, fixed), '23:55', '06:35', 70),
    ],
    NIGHT_SCHEMA,
  );
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 1. 打开首页「睡前仪式」二级子页
  await page.getByRole('button', { name: /睡前仪式/ }).click();
  const region = page.getByRole('region', { name: '睡前仪式' });
  await expect(region).toBeVisible();

  // 2. 切换呼吸模式（4-7-8 → 4-4-4-4 盒式 → 4-6 慢呼）
  await region.getByRole('tab', { name: '4-4-4-4 盒式' }).click();
  await expect(region.getByText('4-4-4-4 盒式平衡呼吸')).toBeVisible();
  await region.getByRole('tab', { name: '4-6 慢呼' }).click();
  await expect(region.getByText('4-6 慢速长呼呼吸')).toBeVisible();

  // 3. 打卡今晚睡前仪式清单
  const checklistBtn = region.getByRole('button', { name: /调暗屏幕并远离强光/ });
  await checklistBtn.click();
  await expect(checklistBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(region.getByText('已完成 1/4')).toBeVisible();

  // 4. 展开 CBT-I 微课并标记已学
  await region.getByRole('button', { name: /刺激控制：15–20 分钟离床原则/ }).click();
  await region.getByRole('button', { name: '标记为已学' }).click();
  await expect(region.getByText('已学 1/6')).toBeVisible();

  // 5. 刷新页面验证微课进度与呼吸模式持久落盘，且已剔除低价值标签模块
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await page.getByRole('button', { name: /睡前仪式/ }).click();
  const regionAfterReload = page.getByRole('region', { name: '睡前仪式' });
  await expect(regionAfterReload.getByText('4-6 慢速长呼呼吸')).toBeVisible();
  await expect(regionAfterReload.getByText('已学 1/6')).toBeVisible();
  await expect(regionAfterReload.getByText('自定义睡眠日记标签')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('旅程43 极简二级子页 + 广告跳过排除名单 + 大肥鱼深夜刷屏超时提醒闭环', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const excluded = new Set<string>();
    const stimCalls: unknown[] = [];
    (window as any).__stimCalls = stimCalls;
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, { get: (t, p) => t[p as string] ?? stub() }),
    };
    (window as any).CapacitorCustomPlatform = { name: 'android' };
    (window as any).androidBridge = {};
    (window as any).Capacitor.Plugins.AdSkip = {
      adSkipStatus: async () => ({
        enabled: true,
        serviceEnabled: true,
        hits: 18,
        diag: ['12:00:01 scan tv.danmaku.bili hit=app-splash'],
        excludedPkgs: [...excluded],
      }),
      adSkipStats: async () => ({
        total: 18,
        apps: [
          { pkg: 'tv.danmaku.bili', label: '哔哩哔哩', hits: 12, excluded: excluded.has('tv.danmaku.bili') },
          { pkg: 'com.cmbchina.ccd', label: '招商银行', hits: 6, excluded: excluded.has('com.cmbchina.ccd') },
        ],
      }),
      adSkipSetPackageExcluded: async (args: { pkg: string; excluded: boolean }) => {
        if (args.excluded) excluded.add(args.pkg);
        else excluded.delete(args.pkg);
        return { ok: true, excludedPkgs: [...excluded] };
      },
      adSkipInstalledApps: async () => ({
        apps: [
          { pkg: 'com.eg.android.AlipayGphone', label: '支付宝', excluded: excluded.has('com.eg.android.AlipayGphone') },
          { pkg: 'com.cmbchina.ccd', label: '招商银行', excluded: excluded.has('com.cmbchina.ccd') },
        ],
      }),
      shizukuStatus: async () => ({ installed: false, running: false, granted: false, version: 0 }),
    };
    (window as any).Capacitor.Plugins.PetOverlay = {
      petPermission: async () => ({ granted: true, sdkInt: 35 }),
      petSetStimulusGuard: async (args: unknown) => {
        stimCalls.push(args);
        return { ok: true };
      },
      petConsumePendingTab: async () => ({ tab: null }),
    };
    localStorage.setItem('somnacare_sleep_records', '[]');
    localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2600);

  // 1. 趋势页已剔除「睡前标签关联洞察」，只保留清爽主卡与二级目录
  await navTo(page, '趋势');
  await expect(page.getByText('睡前标签关联洞察')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /历史记录/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /睡眠日历/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /手机使用对照/ })).toBeVisible();

  // 2. 偏好页主目录直接包含「摇一摇广告跳过」，进入测试双入口排除应用名单
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /摇一摇广告跳过/ }).click();
  const adRegion = page.getByRole('region', { name: '摇一摇广告跳过' });
  await expect(adRegion.getByText('排除不跳名单')).toBeVisible();

  // 入口 ①：从命中榜一键把「招商银行」停用
  const cmbRow = adRegion.locator('div').filter({ hasText: /^招商银行累计跳过 6 次/ }).first();
  await cmbRow.getByRole('button', { name: '在此应用停用' }).click();
  await expect(adRegion.getByRole('button', { name: '恢复 招商银行 的广告跳过' })).toBeVisible();

  // 入口 ②：搜索本机应用把「支付宝」加入不跳名单
  await adRegion.getByRole('button', { name: /搜索本机应用加入不跳名单/ }).click();
  await adRegion.getByLabel('搜索本机应用').fill('支付');
  await adRegion.getByRole('button', { name: '加入不跳', exact: true }).click();
  await expect(adRegion.getByText('已排除 2')).toBeVisible();

  // 3. 返回偏好 → 进入「大肥鱼桌宠」，配置深夜刷屏超时提醒为 15 分钟并切换应用勾选
  await page.getByRole('button', { name: '返回' }).click();
  await page.getByRole('button', { name: /大肥鱼桌宠/ }).click();
  const petRegion = page.getByRole('region', { name: '大肥鱼桌宠' });
  await expect(petRegion.getByText('深夜刷屏超时提醒')).toBeVisible();
  await petRegion.getByRole('button', { name: '15 分钟' }).click();
  await petRegion.getByRole('button', { name: '百度贴吧' }).click();

  const savedGuard = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('somnacare_pet_stimulus_guard') || '{}'),
  );
  expect(savedGuard.thresholdMin).toBe(15);
  expect(savedGuard.pkgs).toContain('com.baidu.tieba');
  const nativeCalls = await page.evaluate(() => (window as any).__stimCalls.length);
  expect(nativeCalls).toBeGreaterThanOrEqual(2);

  expect(errors).toEqual([]);
});
