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
// 旅程 6：旧备份导入（records-only、醒来日口径）→ 夜归属迁移
// ─────────────────────────────────────────────────────────────
test('旅程6 导入旧备份：records-only 自动迁移为夜归属', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 8, 0);
  await seed(page, []);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /数据备份/ }).click();
  // 直接调用隐藏 file input 的 setInputFiles
  const payload = JSON.stringify([
    mkRecord(dstr(-1, fixed), '00:30', '07:30', 88),
    mkRecord(dstr(-2, fixed), '23:50', '08:00', 84),
  ]);
  // 必须先挂 dialog 监听再触发文件选择：FileReader.onload 里的 confirm
  // 可能在 setInputFiles 返回前就弹出，晚注册会被 Playwright 默认驳回
  page.once('dialog', (d) => void d.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: 'old-records.json', mimeType: 'application/json', buffer: Buffer.from(payload),
  });
  await page.waitForTimeout(800);
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  // 醒来日口径 → 夜归属：00:30 凌晨觉归前一天；23:50 前夜觉也归前一天
  expect(recs.some((r: any) => r.date === dstr(-2, fixed))).toBe(true);
  expect(recs.some((r: any) => r.date === dstr(-3, fixed))).toBe(true);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 7：主题切换 / 分享卡 / 护眼 / 闹钟 / 桌宠预览
// ─────────────────────────────────────────────────────────────
test('旅程7 设置面：主题四套、分享卡生成、护眼持久、闹钟防连点、桌宠预览', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 10, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:30', 90),
    mkRecord(dstr(-2, fixed), '23:20', '07:10', 86),
    mkRecord(dstr(-3, fixed), '00:10', '07:40', 82),
  ], NIGHT_SCHEMA);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 主题四套切换（进入「界面主题」二级子页 → 逐个点选 → 返回菜单）
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /界面主题/ }).click();
  for (const name of ['极光午夜', '深空纯黑', '琥珀暖夜', '静谧深海']) {
    const themeBtn = page.getByRole('button', { name: new RegExp(name) });
    if (await themeBtn.count()) { await themeBtn.first().click(); await page.waitForTimeout(120); }
  }
  await page.getByRole('button', { name: '返回' }).click();

  // 分享卡：打开 → 生成 → 出现保存/分享按钮
  await navTo(page, '趋势');
  await page.getByRole('button', { name: '生成每周睡眠分享卡' }).click();
  await expect(page.getByRole('button', { name: /保存并分享这张卡/ })).toBeEnabled({ timeout: 20000 });
  // 关闭分享卡弹窗，否则全屏 dialog 会拦截后续导航
  await page.getByRole('button', { name: '关闭分享卡预览' }).click().catch(async () => {
    const closeBtn = page.getByRole('button', { name: /^关闭$/ }).last();
    await closeBtn.click();
  });

  // 护眼开关持久化
  await navTo(page, '护眼');
  const eyeSwitch = page.getByRole('checkbox', { name: '开启或关闭护眼滤镜', exact: true });
  await expect(eyeSwitch).toBeVisible();
  await eyeSwitch.locator('xpath=ancestor::label[1]').click();
  await expect(eyeSwitch).toBeChecked();
  await page.waitForTimeout(200);

  // 闹钟：进入「我的作息与闹钟」二级子页，添加一次并防连点
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /我的作息与闹钟/ }).click();
  const alarmToggle = page.getByRole('button', { name: '展开闹钟列表' });
  if (await alarmToggle.count()) await alarmToggle.click();
  await page.getByRole('button', { name: /添加闹钟/ }).first().click();
  const saveAlarm = page.getByRole('button', { name: /保存并启动此闹钟|保存闹钟/ });
  await expect(saveAlarm.first()).toBeVisible({ timeout: 3000 });
  const before = await page.evaluate(() => (JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}')?.alarms ?? []).length);
  await saveAlarm.first().click();
  await saveAlarm.first().click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(400);
  const alarms = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}')?.alarms ?? []);
  expect(alarms.length).toBe(before + 1);
  await page.getByRole('button', { name: '返回' }).click();

  // 桌宠：进入「大肥鱼桌宠」二级子页 → 播报预览在场
  await page.getByRole('button', { name: /大肥鱼桌宠/ }).click();
  await expect(page.getByText(/傲娇播报预览/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 12：自救助手（C）——自动档没出卡 → 一键自检并滚到面板
// ─────────────────────────────────────────────────────────────
test('旅程12 自救助手：自动档无卡 → 点检查 → 偏好页自检结论', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 30, 0, 0);
  await mockNativeUsage(page, { events: [], usageDays: [], dailyEmpty: true });
  await seed(page, [], {
    somnacare_user_profile: JSON.stringify({
      name: '测试', age: 30, sleepRecordMode: 'auto', chronotype: 'night',
      targetBedtime: '23:30', targetWakeTime: '07:30', targetDurationHours: 8,
      brightnessLevel: 100, warmthFilter: false, alarms: [], smartAlarmEnabled: true,
      smartWakeWindowMinutes: 20, soundDetectionSensitivity: 'medium',
    }),
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('自动记录没出现？')).toBeVisible();
  await page.getByRole('button', { name: '检查自动记录链路' }).click();
  await expect(page.getByText(/⓪ 监测会话/)).toBeVisible({ timeout: 8000 });
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 16：备份提醒（J）——没备份过时提示，导出后落时间戳
// ─────────────────────────────────────────────────────────────
test('旅程16 备份提醒：导出后记录时间戳并显示「今天」', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 10, 0);
  const recs = Array.from({ length: 7 }, (_, i) =>
    mkRecord(dstr(-1 - i, fixed), '23:30', '07:00'));
  await seed(page, recs, NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '偏好');
  await expect(page.getByText(/未备份/)).toBeVisible();
  await page.getByRole('button', { name: /数据备份/ }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /导出 JSON 备份/ }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('full-backup');
  expect(await page.evaluate(() => Number(localStorage.getItem('somnacare_last_backup_at')))).toBeGreaterThan(0);
  await expect(page.getByText(/今天已备份/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程21 环境光开关：默认开，偏好页可关并落库
// ─────────────────────────────────────────────────────────────
test('旅程21 环境光：开关默认开启，关闭后写入档案', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await seed(page, [], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '偏好');
  await page.getByRole('button', { name: /界面主题/ }).click();
  const sw = page.getByRole('button', { name: '环境光' });
  await expect(sw).toHaveAttribute('aria-pressed', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('somnacare_user_profile');
    return raw ? JSON.parse(raw).ambientLightEnabled : undefined;
  })).toBe(false);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程22 广告跳过：默认关闭 → 开启后调原生开关并引导无障碍授权
// ─────────────────────────────────────────────────────────────
test('旅程22 广告跳过：偏好页开关默认关闭，开启走原生 + 无障碍引导', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await page.addInitScript(() => {
    (window as any).CapacitorCustomPlatform = { name: 'android' };
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        AdSkip: {
          adSkipStatus: async () => ({ enabled: false, serviceEnabled: false, hits: 0 }),
          adSkipSetEnabled: async ({ enabled }: { enabled: boolean }) => {
            (window as any).__adSkipCalls = (window as any).__adSkipCalls || [];
            (window as any).__adSkipCalls.push({ type: 'set', enabled });
            return { enabled, serviceEnabled: false, hits: 0 };
          },
          adSkipOpenSettings: async () => {
            (window as any).__adSkipCalls = (window as any).__adSkipCalls || [];
            (window as any).__adSkipCalls.push({ type: 'open' });
          },
        },
      },
    };
    localStorage.setItem('somnacare_onboarded_v1', '1');
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '偏好');
  await page.getByRole('button', { name: /摇一摇广告跳过/ }).click();
  const sw = page.getByRole('button', { name: '摇一摇广告跳过', exact: true });
  await expect(sw).toHaveAttribute('aria-pressed', 'false');

  await sw.click();
  await expect(sw).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/不读取输入内容/)).toBeVisible();
  await expect(page.getByText(/待授权/)).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__adSkipCalls || []);
  expect(calls.some((c: any) => c.type === 'set' && c.enabled === true)).toBe(true);
  expect(calls.some((c: any) => c.type === 'open')).toBe(true);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程23 应用更新：显式点击才请求 GitHub；网页版只展示 Release，不提供安装
// ─────────────────────────────────────────────────────────────
test('旅程23 应用更新：显式检查 GitHub Release，网页版只展示不安装', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await page.addInitScript(() => {
    localStorage.setItem('somnacare_onboarded_v1', '1');
  });
  await page.route('https://api.github.com/repos/bowentown/somnacare/releases/latest', async (route) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Accept, X-GitHub-Api-Version',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: 'v9.9.9',
        published_at: '2026-10-19T00:00:00Z',
        html_url: 'https://github.com/bowentown/somnacare/releases/tag/v9.9.9',
        body: '## 更新\n- 修复了更新检查\n- **签名校验**更严格',
        assets: [{
          name: 'SomnaCare-v9.9.9.apk',
          browser_download_url: 'https://github.com/bowentown/somnacare/releases/download/v9.9.9/SomnaCare-v9.9.9.apk',
          size: 12345678,
          digest: `sha256:${'a'.repeat(64)}`,
        }],
      }),
    });
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '偏好');
  await page.getByRole('button', { name: /数据备份与诊断/ }).click();
  const heading = page.getByRole('heading', { name: '应用更新' });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();

  // 第 63 轮折叠：点卡片头即展开并检查（显式联网）
  await page.getByRole('button', { name: /应用更新/ }).click();
  await expect(page.getByText('发现新版本 v9.9.9')).toBeVisible();
  await expect(page.getByText(/11\.8 MB/)).toBeVisible();
  await expect(page.getByText(/只在打开此卡时访问 GitHub/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Release 页面/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /下载并安装/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程27 20-20-20 远眺提醒（第 90 轮 G）：此前零行为覆盖——
// 旅程7 不 mock 原生，卡片在 native=false 下根本不渲染
// ─────────────────────────────────────────────────────────────
test('旅程27 20-20-20：原生桥开关落库 + UI 跟随（行为覆盖）', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(15, 0, 0, 0);
  await page.addInitScript(() => {
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    const restCalls: Array<{ enabled: boolean }> = [];
    (window as any).__restCalls = restCalls;
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, { get: (t, p) => t[p as string] ?? stub() }),
    };
    // 平台判定必须在 window 顶层：@capacitor/core 的 createCapacitor 读的是
    // win.CapacitorCustomPlatform（Capacitor 对象的兄弟属性），嵌在 Capacitor
    // 里读不到 → isNativePlatform() 恒 false（第 90 轮 G 实测）
    (window as any).CapacitorCustomPlatform = { name: 'android' };
    (window as any).androidBridge = {};
    (window as any).Capacitor.Plugins.EyeCare = {
      eyeCareRestGet: async () => ({ enabled: false, serviceAlive: true, maxTodayRaw: '{"maxMin":12,"date":"2026-10-26"}' }),
      eyeCareRestSet: async (args: { enabled: boolean }) => {
        restCalls.push({ enabled: args?.enabled === true });
        return { ok: true };
      },
      eyeCarePermission: async () => ({ granted: true }),
      eyeCareStatus: async () => ({ started: true, granted: true }),
      eyeCareSetEnabled: async () => ({ ok: true }),
      eyeCareOpenPermissionSettings: async () => ({}),
    };
    (window as any).Capacitor.Plugins.SleepCore = {
      bedtimePermission: async () => ({ granted: true }),
      alarmRingTable: async () => ({ json: '[]' }),
    };
    (window as any).Capacitor.Plugins.UsageSignal = {
      hasPermission: async () => ({ granted: true }),
      queryDailyUsage: async () => ({ days: [] }),
      queryScreenOnEvents: async () => ({ events: [], observedUntil: Date.now() }),
      queryDailyHealth: async () => ({ days: [] }),
      queryWindDownApps: async () => ({ apps: [] }),
    };
    localStorage.setItem('somnacare_sleep_records', '[]');
    localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForTimeout(2400);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '护眼', exact: true }).click();
  await page.waitForTimeout(500);

  const restSwitch = page.getByRole('checkbox', { name: '开关 20-20-20 远眺提醒' });
  await expect(restSwitch).toBeVisible();               // 卡片在原生 mock 下渲染
  await expect(restSwitch).not.toBeChecked();
  await restSwitch.locator('xpath=ancestor::label[1]').click();
  await expect(restSwitch).toBeChecked();               // UI 跟随
  // 行为断言：原生桥真的收到 { enabled: true }（短路 setEyeRestEnabled 会红）
  const calls = await page.evaluate(() => (window as any).__restCalls as Array<{ enabled: boolean }>);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1].enabled).toBe(true);
  // 连续用屏统计在场（真实测量，非估算）
  await expect(page.getByText(/今日最长连续用屏/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程29 全量备份恢复（第 90 轮：verify-wiring 的第三条"调用点在场"断言
// 此前无任何行为覆盖）。真走文件输入 → 全量 schema2 分支 → restoreFullBackup，
// 断言恢复真的落盘（记录被替换 + 皮肤随文件恢复）。
// ─────────────────────────────────────────────────────────────
test('旅程29 全量备份恢复：schema2 导入真正落盘（行为覆盖）', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  // 不用 seed()（addInitScript 会在恢复后的 reload 上重放，把恢复结果覆盖回去）
  await page.evaluate((recs) => {
    localStorage.setItem('somnacare_sleep_records', JSON.stringify(recs));
    localStorage.setItem('somnacare_onboarded_v1', '1');
    localStorage.setItem('somnacare_record_date_schema', 'night-v1');
  }, [
    mkRecord(dstr(-1, fixed), '23:40', '07:30', 90),
    mkRecord(dstr(-2, fixed), '23:20', '07:10', 86),
    mkRecord(dstr(-3, fixed), '00:10', '07:40', 82),
  ]);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /数据备份/ }).click();

  const payload = JSON.stringify({
    app: 'somnacare', schema: 2, exportedAt: new Date().toISOString(),
    dateSchema: 'night-v1',
    records: [mkRecord(dstr(-5, fixed), '22:50', '06:50', 77)],
    profile: { name: '备份恢复者', age: 41 },
    travel: { energy: 120 },
    moments: [],
    chat: [],
    petPrefs: { skin: 'sakura', bubbleEvery: 4, enabled: true },
  });
  page.once('dialog', (d) => void d.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: 'full-backup.json', mimeType: 'application/json', buffer: Buffer.from(payload),
  });
  await page.waitForTimeout(1200);   // 恢复后 window.location.reload()

  const after = await page.evaluate(() => ({
    records: JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'),
    skin: localStorage.getItem('somnacare_pet_skin'),
    profile: JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}'),
  }));
  expect(after.records.length).toBe(1);                       // 3 条被整体替换为 1 条
  expect(after.records[0].date).toBe(dstr(-5, fixed));
  expect(after.skin).toBe('sakura');
  expect(after.profile.name).toBe('备份恢复者');
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 39：偏好二级子页栈（Phase 2B）——进入/返回、Escape 退出与桌面小组件预览
// ─────────────────────────────────────────────────────────────
test('旅程39 偏好二级子页栈：进入/返回、Escape 退出与桌面小组件实时预览', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 10, 0);
  await seed(page, [mkRecord(dstr(-1, fixed), '23:15', '07:15', 91)], NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '偏好');
  await page.getByRole('button', { name: /桌面小组件/ }).click();
  const widgetRegion = page.getByRole('region', { name: '桌面小组件' });
  await expect(widgetRegion).toBeVisible();
  await expect(widgetRegion.getByText('2×1 睡眠速览卡')).toBeVisible();
  await expect(widgetRegion.getByText('8h 0m')).toBeVisible();
  await expect(widgetRegion.getByText('最近评分')).toBeVisible();

  // 点击顶部返回键回到偏好主菜单
  await page.getByRole('button', { name: '返回' }).click();
  await expect(page.getByRole('region', { name: '桌面小组件' })).toHaveCount(0);

  // 再次进入并通过 Escape 退出子页栈
  await page.getByRole('button', { name: /外观与主题|界面主题/ }).click();
  await expect(page.getByRole('region', { name: '外观与主题' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '外观与主题' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 40：首页「睡前仪式」二级子页（Phase 2B/Phase 5 入口）
// ─────────────────────────────────────────────────────────────
test('旅程40 睡前仪式二级子页：4-7-8 呼吸练习、打开音景混音器与返回首页', async ({ page }) => {
  const errors = watchErrors(page);
  await openAt(page, 22, 15);
  await seed(page, [], NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await page.getByRole('button', { name: /睡前仪式/ }).click();
  await expect(page.getByRole('region', { name: '睡前仪式' })).toBeVisible();
  await expect(page.getByText(/4-7-8 深度助眠呼吸/)).toBeVisible();

  // 打开白噪音混音器（位于子页 z-[60] 之上），再关闭混音器应仍留在睡前仪式子页
  await page.getByRole('button', { name: '打开混音' }).click();
  await expect(page.getByRole('dialog', { name: '白噪音伴眠' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '白噪音伴眠' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '睡前仪式' })).toBeVisible();

  // 返回首页
  await page.getByRole('button', { name: '返回' }).click();
  await expect(page.getByRole('region', { name: '睡前仪式' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
