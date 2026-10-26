import { expect, test, type Page } from '@playwright/test';

/**
 * 用户旅程回归（第 55 轮）：扮演真实用户把核心路径走一遍。
 *
 * 与既有 spec 的分工：proposal.spec 锁提议引擎的闸门语义、app.spec 锁
 * 各分区主流程——本文件按"一天的真实使用顺序"串联操作，并在旅程中
 * 断言下游联动（确认→趋势→旅行能量→影子诊断；删除→能量回退；
 * 旧备份导入→日期迁移），同时收集页面异常。
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const dstr = (off: number, base = new Date()): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const mkRecord = (date: string, bedtime: string, wakeTime: string, score = 86) => ({
  id: 'r-' + date + '-' + bedtime, date, bedtime, wakeTime,
  durationMinutes: 480, deepSleepMinutes: 90, lightSleepMinutes: 300,
  remSleepMinutes: 70, awakeMinutes: 10, sleepScore: score, sleepEfficiency: 91,
  latencyMinutes: 12, wakeCount: 1,
});


/** 带逐段分期的记录：用于锁住 hypnogram 时间轴（不是百分比回退） */
const mkRecordWithStages = (date: string) => ({
  ...mkRecord(date, '23:30', '07:30', 86),
  durationMinutes: 460,
  deepSleepMinutes: 90,
  lightSleepMinutes: 310,
  remSleepMinutes: 60,
  awakeMinutes: 20,
  stages: [
    { stage: 'awake', startTime: '23:30', endTime: '23:40', durationMinutes: 10 },
    { stage: 'deep', startTime: '23:40', endTime: '01:10', durationMinutes: 90 },
    { stage: 'light', startTime: '01:10', endTime: '03:10', durationMinutes: 120 },
    { stage: 'rem', startTime: '03:10', endTime: '04:10', durationMinutes: 60 },
    { stage: 'light', startTime: '04:10', endTime: '06:30', durationMinutes: 140 },
    { stage: 'awake', startTime: '06:30', endTime: '06:40', durationMinutes: 10 },
    { stage: 'light', startTime: '06:40', endTime: '07:30', durationMinutes: 50 },
  ],
});

/** 收集页面未捕获异常与 console.error（旅程中任何一条都视为失败线索） */
const watchErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
  });
  return errors;
};

/** 测试数据已是夜归属口径 → 预写迁移标记，防止 App 加载时二次迁移 */
const NIGHT_SCHEMA = { somnacare_record_date_schema: 'night-v1' } as Record<string, string>;

const seed = async (page: Page, records: unknown[] = [], extra?: Record<string, string>) => {
  await page.addInitScript(({ recs, ex }: { recs: string; ex: Record<string, string> }) => {
    localStorage.setItem('somnacare_sleep_records', recs);
    localStorage.setItem('somnacare_onboarded_v1', '1');
    for (const [k, v] of Object.entries(ex)) localStorage.setItem(k, v);
    sessionStorage.clear();
  }, { recs: JSON.stringify(records), ex: extra ?? {} });
};

const openAt = async (page: Page, h: number, m: number): Promise<Date> => {
  const fixed = new Date();
  fixed.setHours(h, m, 0, 0);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  return fixed;
};

// 导航 = 点按 + 等吸附动画落定（SNAP_MS=300 + 余量）。轨道用指数缓出
// （前 100ms 走完 ~80%），Playwright 的两帧稳定判定会在动画尾段提前放行——
// 紧跟着的页内点击会与目标错位，落在隔壁控件上静默失效（第 82 轮 旅程19
// 两次复现的根因）。把"落定"算进导航语义，所有用例统一受益。
const navTo = async (page: Page, tab: string) => {
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: tab }).click();
  await page.waitForTimeout(380);
};

/** 安装"原生桥"mock（CustomPlatform 通道，isNativePlatform 恒 true） */
const mockNativeUsage = async (
  page: Page,
  opts: { events: number[]; usageDays: unknown[]; dailyEmpty?: boolean; windDown?: unknown },
) => {
  await page.addInitScript(({ evs, ud, empty, wd }: { evs: number[]; ud: unknown[]; empty: boolean; wd?: unknown }) => {
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, { get: (t, p) => t[p as string] ?? stub() }),
    };
    (window as any).CapacitorCustomPlatform = { name: 'android' };
    (window as any).Capacitor.Plugins.UsageSignal = {
      hasPermission: async () => ({ granted: true }),
      openPermissionSettings: async () => ({}),
      queryDailyUsage: async () => (empty ? { days: [] } : { days: ud }),
      queryScreenOnEvents: async () => ({ events: evs, observedUntil: Date.now() }),
      // 睡前一小时（第 86 轮补 mock）：默认空（不渲染卡片，既有用例不受扰），
      // 传 windDown 数据时按 nightKey 原样回放
      queryWindDownApps: async (args: any) => {
        if (!wd) return { apps: [] };
        // 按夜键匹配回放（第 88 轮核查）：夜里键取错时返回空 → 卡片不渲染
        const w = wd as any;
        if (w.nightKey && args?.nightKey !== w.nightKey) return { apps: [] };
        return { apps: w.apps, windowEnd: w.windowEnd };
      },
    };
    localStorage.setItem('somnacare_usage_days', JSON.stringify(ud));
    localStorage.setItem('somnacare_onboarded_v1', '1');
  }, { evs: opts.events, ud: opts.usageDays, empty: opts.dailyEmpty ?? false, wd: opts.windDown as any });
};

/** 合成 15 夜事件：07:05–23:40 活跃、夜里静默（就寝 23:40 / 起床 07:05） */
const synthEvents = (now: Date): number[] => {
  let s = 42;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const day0 = new Date(now);
  day0.setHours(0, 0, 0, 0);
  const day0Ms = day0.getTime();
  const events: number[] = [];
  for (let d = 15; d >= 1; d--) {
    const base = day0Ms - d * 86400000;
    for (let t = base + 7 * 3600e3 + 5 * 60e3; t < base + 23 * 3600e3 + 40 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      events.push(Math.round(t));
    }
  }
  for (let t = day0Ms + 7 * 3600e3 + 5 * 60e3; t <= now.getTime() - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
    events.push(Math.round(t));
  }
  return events.sort((a, b) => a - b);
};

// ─────────────────────────────────────────────────────────────
// 旅程 1：晨间核心流（冷启动 → 自动卡 → 确认 → 全下游联动）
// ─────────────────────────────────────────────────────────────
test('旅程1 晨间：07:50 冷启动自动出卡 → 确认 → 趋势/能量/影子全联动', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 自动卡出现且时刻按 15 分钟桶量化
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const cardText = await page.evaluate(() => document.body.innerText);
  expect(cardText).toMatch(/2[23]:[0-5]\d/);
  expect(cardText).toMatch(/0[67]:[0-2]\d/);
  expect(cardText).toMatch(/放下/);
  expect(cardText).toMatch(/拿起/);

  // 确认 → 小结 → 关闭
  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible();
  await page.getByRole('button', { name: '确定并查看详情' }).click();
  // 首条记录可能攒够旅行能量触发明信片弹窗（两阶段：拆信封 → 收进图鉴）。
  // 真实用户会先拆开再稍后再看——不处理会把后续导航全挡住
  await page.waitForTimeout(400);
  const openEnvelope = page.getByRole('button', { name: /拆开信封/ });
  if (await openEnvelope.count()) {
    await openEnvelope.click();
    const tripLater = page.getByRole('button', { name: /收进图鉴，稍后再看/ });
    await expect(tripLater).toBeVisible();
    await tripLater.click();
  }

  // 落库：date=夜归属（昨天）、来源 usage
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.recordSource === 'usage');
  expect(landed?.date).toBe(dstr(-1, fixed));
  expect(landed?.bedtime).toMatch(/^2[23]:/);

  // 趋势页：昨晚卡与历史列表都出现新记录
  await navTo(page, '趋势');
  await expect(page.getByText(/近 1 晚|近 2 晚|近 3 晚/)).toBeVisible();

  // 旅行能量：countedScores 记入该夜（night 键 = date）
  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || 'null'));
  expect(travel?.countedScores?.[dstr(-1, fixed)]).toBeGreaterThan(0);

  // 影子诊断：该夜已回填 confirmed
  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.outcome?.type).toBe('confirmed');

  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 2：已有记录 / 已处理 / 还在睡 → 都不应乱弹卡
// ─────────────────────────────────────────────────────────────
test('旅程2 晨间反向：已有记录/已忽略/凌晨还在睡 → 均不出卡', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 30, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:05'),
    mkRecord(dstr(-2, fixed), '23:30', '07:00'),
    mkRecord(dstr(-3, fixed), '00:10', '07:10'),
    mkRecord(dstr(-4, fixed), '23:00', '07:20'),
  ], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  // 昨夜的记录已存在 → gate 4 → 无卡
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('旅程3 凌晨：03:30 打开（还在睡）→ 不出卡且页面正常', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(3, 30, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:30', firstActive: '07:30', nightPickups: 0 }],
  });
  await seed(page, [mkRecord(dstr(-2, fixed), '00:20', '07:20')]);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  await expect(page.getByText('该睡了')).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 4：手动补录边界（默认昨晚 / 16h 截断 / 相同时间拦截）
// ─────────────────────────────────────────────────────────────
test('旅程4 手动补录：默认昨晚、16h 截断、相同时间被拦', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 9, 0);
  await seed(page, [mkRecord(dstr(-3, fixed), '23:40', '08:10')]);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await page.getByText('晨起手动补录').click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  // 默认日期 = 昨晚（夜归属键）
  const dateInput = page.locator('input[type="date"]');
  await expect(dateInput).toHaveValue(dstr(-1, fixed));
  // 文案随日期动态，不写死"昨晚"
  await expect(page.getByText('昨晚睡前行为习惯')).toBeVisible();

  const timeInputs = page.locator('input[type="time"]');
  // 相同时间 → 内联错误
  await timeInputs.nth(0).fill('07:30');
  await timeInputs.nth(1).fill('07:30');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('就寝与起床时间不能相同')).toBeVisible();

  // 21.5h 长窗 → 保存成功且记录自洽（分期总和 = 时长 + 清醒）
  await timeInputs.nth(0).fill('23:30');
  await timeInputs.nth(1).fill('21:00');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('补录睡眠')).toHaveCount(0);
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.date === dstr(-1, fixed) && r.recordSource === 'manual');
  expect(landed).toBeTruthy();
  expect(landed.durationMinutes).toBeLessThanOrEqual(960);
  const stageSum = (landed.stages ?? []).reduce((a: number, st: any) => a + st.durationMinutes, 0);
  expect(stageSum).toBe(landed.durationMinutes + landed.awakeMinutes);
  expect(landed.latencyEstimated).toBe(true);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 5：删除记录 → 能量回退 + 影子条目清理
// ─────────────────────────────────────────────────────────────
test('旅程5 删除：旅行能量回退 + 影子诊断条目同步清理', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 9, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:30', 92),
    mkRecord(dstr(-2, fixed), '23:30', '07:00', 85),
  ], {
    ...NIGHT_SCHEMA,
    somnacare_travel_state: JSON.stringify({ currentEnergy: 77, countedScores: { [dstr(-1, fixed)]: 92 }, unlockedCardIds: [], goldStars: {} }),
    somnacare_model_shadow: JSON.stringify({ v: 1, entries: [{ date: dstr(-1, fixed), heuristic: { bed: '23:40', wake: '07:30' }, outcome: { type: 'manual', bed: '23:40', wake: '07:30' } }], dropped: 0 }),
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '趋势');
  await page.getByRole('button', { name: /历史记录/ }).click();
  // 删除有 window.confirm：Playwright 默认 dismiss = 取消，必须显式接受
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: new RegExp(`删除 ${dstr(-1, fixed)}`) }).click();
  // confirm 走浏览器原生确认框
  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || '{}'));
  expect(travel.countedScores?.[dstr(-1, fixed)]).toBeUndefined();
  expect(travel.currentEnergy).toBeLessThan(77);
  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  expect((shadow.entries ?? []).some((e: any) => e.date === dstr(-1, fixed))).toBe(false);
  expect(errors).toEqual([]);
});

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

  // 主题四套切换（展开主题卡 → 逐个点选）
  await navTo(page, '偏好');
  await page.getByRole('button', { name: /界面主题/ }).click();
  for (const name of ['极光午夜', '深空纯黑', '琥珀暖夜', '静谧深海']) {
    const themeBtn = page.getByRole('button', { name: new RegExp(name) });
    if (await themeBtn.count()) { await themeBtn.first().click(); await page.waitForTimeout(120); }
  }

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
  // 第 88 轮修正：全应用开关均为 checkbox role（ui/Switch 是 sr-only checkbox），
  // 旧 getByRole('switch') 恒零匹配 → 整段静默跳过（F4 死代码断言）
  const eyeSwitch = page.getByRole('checkbox', { name: '开启或关闭护眼滤镜', exact: true });
  await expect(eyeSwitch).toBeVisible();
  // 点包裹 label：自动等待滑动稳定，label 原生联动 checkbox（app.spec 同法）
  await eyeSwitch.locator('xpath=ancestor::label[1]').click();
  await expect(eyeSwitch).toBeChecked();
  await page.waitForTimeout(200);

  // 闹钟：添加一次，快速再点一次（防连点只应落一条）
  // 第 88 轮修正：旧代码点完"添加"立即查 count，表单在 {isOpen &&} 里尚未
  // 展开 → count=0，防连点断言从未执行（F5）——先等保存按钮可见再断言
  await navTo(page, '偏好');
  // 闹钟区默认折叠（isOpen 门控）：先展开列表再点"添加闹钟"
  const alarmToggle = page.getByRole('button', { name: '展开闹钟列表' });
  if (await alarmToggle.count()) await alarmToggle.click();
  await page.getByRole('button', { name: /添加闹钟/ }).first().click();
  const saveAlarm = page.getByRole('button', { name: /保存并启动此闹钟|保存闹钟/ });
  await expect(saveAlarm.first()).toBeVisible({ timeout: 3000 });
  // 档案默认自带 2 条示例闹钟（周内/周末）——断言语义是"本次保存只落一条"
  const before = await page.evaluate(() => (JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}')?.alarms ?? []).length);
  await saveAlarm.first().click();
  await saveAlarm.first().click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(400);
  const alarms = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}')?.alarms ?? []);
  expect(alarms.length).toBe(before + 1);

  // 桌宠傲娇播报预览在场（第 63 轮折叠：先展开）
  await page.getByRole('button', { name: /大肥鱼桌宠/ }).click();
  await expect(page.getByText(/傲娇播报预览/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 7b：自动卡"改一下" → 手动补录预填 → 修正后落库（manual 真值）
// ─────────────────────────────────────────────────────────────
test('旅程7b 改一下：卡片预填到补录弹窗 → 修正后以 manual 落库', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  // 只放一晚历史（<3 晚 → 先验缺省，模型可能 prior-mismatch 放行启发式）
  await seed(page, [mkRecord(dstr(-3, fixed), '23:30', '07:00')], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const cardText = await page.evaluate(() => document.body.innerText);
  const shown = cardText.match(/(\d{2}:\d{2}) 放下/);
  expect(shown).toBeTruthy();

  await page.getByRole('button', { name: '改一下' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  // 预填日期 = 夜归属（昨天）；改醒来时间后保存
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(-1, fixed));
  await page.locator('input[type="time"]').nth(1).fill('08:10');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('补录睡眠')).toHaveCount(0);

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.date === dstr(-1, fixed) && r.recordSource === 'manual');
  expect(landed?.wakeTime).toBe('08:10');
  // 卡片已被处理，不再出现
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
// 旅程 10：±15 分钟微调（B）——卡上直接挪，确认后落库与影子都留痕
// ─────────────────────────────────────────────────────────────
test('旅程10 微调：卡上把起床推迟 15 分钟 → 记录与影子同步', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const wakeCell = page.getByRole('button', { name: '起床推迟15分钟' }).locator('..');
  const before = (await wakeCell.innerText()).match(/(\d{2}):(\d{2})/);
  expect(before).toBeTruthy();
  const [bh, bm] = [Number(before![1]), Number(before![2])];
  const expected = `${pad(Math.floor(((bh * 60 + bm + 15) % 1440) / 60))}:${pad((bm + 15) % 60)}`;

  await page.getByRole('button', { name: '起床推迟15分钟' }).click();
  await expect.poll(() => wakeCell.innerText()).toContain(expected);

  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  const okBtn = page.getByRole('button', { name: '确定并查看详情' });
  if (await okBtn.count()) await okBtn.click();

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = (recs as any[]).find((r) => r.recordSource === 'usage');
  expect(landed?.wakeTime).toBe(expected);

  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.adjust?.wake).toBe(15);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 11：否定标注（F）——「不是我的睡眠」不写记录，只留负样本
// ─────────────────────────────────────────────────────────────
test('旅程11 否定：点「不是我的睡眠」→ 不落库、负样本与统计可见', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 30, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await page.getByRole('button', { name: '不是我的睡眠' }).click();
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  expect((recs as any[]).length).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(dstr(-1, fixed));

  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.negative).toBe(true);

  await navTo(page, '偏好');
  await expect(page.getByText(/否定 1 晚/)).toBeVisible();
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
// 旅程 13：时段自适应（G）——早上补昨晚、午后记小睡
// ─────────────────────────────────────────────────────────────
test('旅程13 早上主按钮：09:00「补录昨晚睡眠」→ 预填昨晚与目标时刻', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, []);
  const fixed = await openAt(page, 9, 0);
  await expect(page.getByText('早安')).toBeVisible();
  await page.getByRole('button', { name: '补录昨晚睡眠' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(-1, fixed));
  await expect(page.locator('input[type="time"]').nth(0)).toHaveValue('23:30');
  await expect(page.locator('input[type="time"]').nth(1)).toHaveValue('07:30');
  expect(errors).toEqual([]);
});

test('旅程14 午后主按钮：14:00「记录一次小睡」→ 预填刚才的 40 分钟', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, []);
  const fixed = await openAt(page, 14, 0);
  await expect(page.getByText('午后小睡')).toBeVisible();
  await page.getByRole('button', { name: '记录一次小睡' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(0, fixed));
  await expect(page.locator('input[type="time"]').nth(0)).toHaveValue('13:20');
  await expect(page.locator('input[type="time"]').nth(1)).toHaveValue('14:00');
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 15：就诊摘要（I）——预览、切换具体时刻、导出
// ─────────────────────────────────────────────────────────────
test('旅程15 就诊摘要：预览可生成、可切换时刻、可下载', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 10, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:05'),
    mkRecord(dstr(-2, fixed), '23:20', '06:55'),
    mkRecord(dstr(-3, fixed), '00:10', '07:30'),
    mkRecord(dstr(-4, fixed), '23:50', '07:10'),
  ], NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  await page.getByRole('button', { name: '生成就诊摘要' }).click();
  await expect(page.getByRole('img', { name: '就诊摘要预览' })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: '包含具体时刻' }).click();
  await expect(page.getByRole('img', { name: '就诊摘要预览' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '保存 / 分享' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('clinical-summary');
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
// 旅程 17：通知确认（A）——自动档挂通知，动作回来即落库
// ─────────────────────────────────────────────────────────────
test('旅程17 通知确认：通知栏「确认记录」动作 → 无需点卡即完成记录', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await seed(page, [], {
    somnacare_user_profile: JSON.stringify({
      name: '测试', age: 30, sleepRecordMode: 'auto', chronotype: 'night',
      targetBedtime: '23:30', targetWakeTime: '07:30', targetDurationHours: 8,
      brightnessLevel: 100, warmthFilter: false, alarms: [], smartAlarmEnabled: true,
      smartWakeWindowMinutes: 20, soundDetectionSensitivity: 'medium',
    }),
  });
  await page.addInitScript(() => {
    const scheduled: any[] = [];
    let cb: ((e: any) => void) | null = null;
    (window as any).__proposalScheduled = scheduled;
    (window as any).__proposalActionReady = false;
    (window as any).__fireProposalAction = (actionId: string, date: string) => {
      cb?.({ actionId, notification: { extra: { proposalDate: date } } });
    };
    (window as any).Capacitor.Plugins.LocalNotifications = {
      checkPermissions: async () => ({ display: 'granted' }),
      requestPermissions: async () => ({ display: 'granted' }),
      registerActionTypes: async () => {},
      addListener: async (_e: string, fn: (e: any) => void) => {
        cb = fn;
        (window as any).__proposalActionReady = true;
        return { remove() {} };
      },
      createChannel: async () => {},
      schedule: async (o: any) => { scheduled.push(...o.notifications); },
      cancel: async () => {},
      getPending: async () => ({ notifications: [] }),
    };
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await page.waitForFunction(() => (window as any).__proposalActionReady === true);
  await page.waitForFunction(() => ((window as any).__proposalScheduled ?? []).length > 0);
  const scheduled = await page.evaluate(() => (window as any).__proposalScheduled);
  expect(scheduled[0]?.actionTypeId).toBe('somnacare-proposal-actions');
  expect(scheduled[0]?.extra?.proposalDate).toBe(dstr(-1, fixed));

  await page.evaluate((d) => (window as any).__fireProposalAction('confirm', d), dstr(-1, fixed));
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible({ timeout: 8000 });
  const okBtn = page.getByRole('button', { name: '确定并查看详情' });
  if (await okBtn.count()) await okBtn.click();

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = (recs as any[]).find((r) => r.recordSource === 'usage');
  expect(landed).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(dstr(-1, fixed));
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
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程20 删除撤销：5 秒内恢复记录与能量账
// ─────────────────────────────────────────────────────────────
test('旅程20 删除撤销：恢复记录 + 能量只补实际扣掉的差额', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  const date = dstr(-1, fixed);
  await seed(page, [mkRecord(date, '23:40', '07:10', 92)], {
    ...NIGHT_SCHEMA,
    somnacare_travel_state: JSON.stringify({
      currentEnergy: 50, countedScores: { [date]: 92 },
      unlockedCardIds: [], goldStars: {}, pendingArrival: null,
    }),
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  await page.getByRole('button', { name: /历史记录/ }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: new RegExp(`删除 ${date}`) }).click();

  await expect(page.getByRole('button', { name: '撤销' })).toBeVisible();
  await page.getByRole('button', { name: '撤销' }).click();

  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || '{}'));
  expect(travel.countedScores?.[date]).toBe(92);
  expect(travel.currentEnergy).toBe(50);   // 删除时被 max(0) 截断，撤销不能凭空补成 92
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  expect((recs as any[]).some((r) => r.date === date)).toBe(true);
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
        GemmaLLM: {
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
  const sw = page.getByRole('button', { name: '摇一摇广告跳过' });
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
// 旅程24 趋势图可读性：Y 轴刻度 / 分期横带 / 起卧目标窗口
// ─────────────────────────────────────────────────────────────
test('旅程24 趋势图可读性：坐标刻度、分期横带、起卧目标窗口', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:10', '07:10', 88),
    mkRecord(dstr(-2, fixed), '00:20', '08:10', 84),
    mkRecord(dstr(-3, fixed), '23:45', '07:20', 91),
    mkRecord(dstr(-4, fixed), '00:55', '08:40', 73),
    mkRecord(dstr(-5, fixed), '23:20', '07:05', 86),
    mkRecord(dstr(-6, fixed), '23:35', '07:35', 93),
    mkRecord(dstr(-7, fixed), '00:10', '07:50', 82),
  ], {
    ...NIGHT_SCHEMA,
    somnacare_user_profile: JSON.stringify({ targetBedtime: '23:30', targetWakeTime: '07:30' }),
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  // Phase 1 数据诚实重构：默认视图 = 起卧时段（真实测量），分期降为估算 tab
  const trendCard = page.getByText('趋势与结构').locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]');
  await expect(trendCard.getByText('目标 23:30–07:30')).toBeVisible();
  await expect(trendCard.getByText(/\d{2}:\d{2}→\d{2}:\d{2}/).first()).toBeVisible();

  await page.getByRole('button', { name: '得分曲线' }).click();
  const chart = page.getByTestId('score-chart');
  await expect(chart).toBeVisible();
  const axisText = await chart.locator('text').allTextContents();
  expect(axisText).toEqual(expect.arrayContaining(['100', '90', '75', '50']));
  await expect(page.getByText(/均值 \d+/)).toBeVisible();

  await page.getByRole('button', { name: '睡眠分期比例（模型估算，非测量）' }).click();
  await expect(page.getByText('近 7 晚平均')).toBeVisible();
  expect(errors).toEqual([]);
});


// ─────────────────────────────────────────────────────────────
// 旅程25 睡前一小时（第 86 轮）：链路 e2e 覆盖——此前零覆盖，mock 缺方法
// 使卡片在全部既有用例中永远不可达
// ─────────────────────────────────────────────────────────────
test('旅程25 睡前一小时：真实应用名渲染 + 总分钟合计 + 放下时刻', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 0, 0, 0);
  const events = synthEvents(fixed);
  // 昨夜 00:47 放下（fixed - 7h13m）
  const windowEnd = fixed.getTime() - (7 * 3600 + 13 * 60) * 1000;
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:47', firstActive: '07:02', nightPickups: 0 }],
    windDown: {
      nightKey: dstr(-1, fixed),   // 夜间作息昨夜键（卡片渲染即证明键取值正确）
      apps: [
        { pkg: 'com.tencent.sgame', label: '王者荣耀', minutes: 25 },
        { pkg: 'com.tencent.mm', label: '微信', minutes: 12 },
      ],
      windowEnd,
    },
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  const card = page.getByTestId('winddown-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('放下手机前的一小时')).toBeVisible();
  // 总分钟 = 25 + 12；放下时刻 = 00:47
  await expect(card.getByText('37')).toBeVisible();
  await expect(card.getByText('分钟还在亮屏')).toBeVisible();
  await expect(card.getByText('00:47 放下')).toBeVisible();
  await expect(card.getByText('王者荣耀')).toBeVisible();
  await expect(card.getByText('微信')).toBeVisible();
  // 37 分钟 < 55 → 不出现"几乎没停过"提示（不造因果断言）
  await expect(card.getByText(/几乎没停过/)).toHaveCount(0);
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
    (window as any).Capacitor.Plugins.GemmaLLM = {
      eyeCareRestGet: async () => ({ enabled: false, serviceAlive: true, maxTodayRaw: '{"maxMin":12,"date":"2026-10-26"}' }),
      eyeCareRestSet: async (args: { enabled: boolean }) => {
        restCalls.push({ enabled: args?.enabled === true });
        return { ok: true };
      },
      eyeCarePermission: async () => ({ granted: true }),
      eyeCareStatus: async () => ({ started: true, granted: true }),
      eyeCareSetEnabled: async () => ({ ok: true }),
      eyeCareOpenPermissionSettings: async () => ({}),
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
// 旅程28 服务端零记录拒绝（第 90 轮 N6）：护栏此前只做 server.ts 文本在场
// 检查——"只改路由一行"即可让零记录请求返回 200 + 完整伪造报告而护栏全绿。
// 这里真实 POST，断言 400（无 GEMINI_API_KEY 时本地规则兜底立即返回 null）。
// ─────────────────────────────────────────────────────────────
test('旅程28 服务端：零记录请求必须 400 拒绝（不伪造报告）', async ({ request }) => {
  const empty = await request.post('/api/sleep/analyze', {
    data: { recentLogs: [], userProfile: { age: 30 } },
  });
  expect(empty.status()).toBe(400);
  const body = await empty.json();
  expect(String(body.error ?? '')).toContain('尚无睡眠记录');

  // 对照：有记录时不应再走 400 分支（本地规则引擎出报告）
  const one = await request.post('/api/sleep/analyze', {
    data: {
      recentLogs: [{
        date: '2026-10-20', bedtime: '23:30', wakeTime: '07:30', durationMinutes: 480,
        deepSleepMinutes: 90, lightSleepMinutes: 300, remSleepMinutes: 90, awakeMinutes: 20,
        sleepScore: 86, sleepEfficiency: 92, latencyMinutes: 15,
      }],
      userProfile: { age: 30, targetHours: 8 },
    },
  });
  expect(one.status()).toBe(200);
  const report = await one.json();
  expect(typeof report.chronotype).toBe('string');
  expect(report.chronotype.length).toBeGreaterThan(0);
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
