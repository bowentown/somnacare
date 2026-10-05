import { expect, test, type Page } from '@playwright/test';

/**
 * 自动提议链路端到端（第 42 轮）：启发式的置信度门曾因线性中位数在
 * 跨午夜就寝历史上恒判低置信 → 提议永不出现，且链路失败完全静默。
 * 这里用真实浏览器锁住四件事：
 *  1. 启发式路径：跨午夜历史下出卡 → 确认 → 落库 + 影子诊断闭环（采纳）
 *  2. 忽略交互：隐去、不落库、刷新后仍隐去（handled 持久化）
 *  3. gate 4：目标夜已有夜睡记录 → 不出卡（尊重用户）
 *  4. 模型路径：mock 原生 UsageSignal → 合成 14 夜事件 → decided 提议 →
 *     引擎跑动即入影子档 → 自检面板报"跑通" → 确认采纳
 *
 * 时间确定性：所有用例用 page.clock 钉死"今天上午"——提议有 12h 新鲜度门，
 * 不钉时钟的话 CI 在夜间跑会因"距醒来 >12h"整批假失败。
 */

const pad = (n: number): string => String(n).padStart(2, '0');
/** 与 page.clock 钉死的同一天对齐的相对日期（基于真实时区的"今天"） */
const dstr = (off: number, base = new Date()): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const mkRecord = (date: string, bedtime: string, wakeTime: string) => ({
  id: 'r-' + date + '-' + bedtime, date, bedtime, wakeTime,
  durationMinutes: 480, deepSleepMinutes: 90, lightSleepMinutes: 300,
  remSleepMinutes: 70, awakeMinutes: 10, sleepScore: 86, sleepEfficiency: 91,
  latencyMinutes: 12, wakeCount: 1,
});

/** 就寝历史横跨午夜（23:4x / 00:3x 混合）——旧实现恒判低置信的用户画像 */
const midnightRecords = [
  mkRecord(dstr(-2), '23:40', '08:10'),
  mkRecord(dstr(-3), '00:30', '08:40'),
  mkRecord(dstr(-4), '00:20', '08:30'),
  mkRecord(dstr(-5), '23:50', '07:50'),
];

const seed = async (page: Page, opts: { usageDays?: unknown[]; records?: unknown[]; onboarding?: boolean }) => {
  const { usageDays = [], records = [], onboarding = true } = opts;
  await page.addInitScript(({ ud, recs, onboard }: { ud: string; recs: string; onboard: boolean }) => {
    localStorage.setItem('somnacare_usage_days', ud);
    localStorage.setItem('somnacare_sleep_records', recs);
    if (onboard) localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  }, { ud: JSON.stringify(usageDays), recs: JSON.stringify(records), onboard: onboarding });
};

/** 钉死浏览器时钟到"今天上午"并打开首页（开屏动画播完） */
const openAt = async (page: Page, h: number, m: number) => {
  const fixed = new Date();
  fixed.setHours(h, m, 0, 0);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  return fixed;
};

const readStore = (page: Page, key: string): Promise<any> =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);

test('启发式：跨午夜历史出卡 → 确认 → 落库 + 影子诊断记采纳', async ({ page }) => {
  const fixed = await openAt(page, 9, 30);   // 醒来 08:56 后 34 分钟：新鲜度门内
  const today = dstr(0, fixed);
  await seed(page, {
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:33', firstActive: '08:56', nightPickups: 1 }],
    records: midnightRecords,
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 卡片在位：放下/拿起时刻与使用信号一致
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await expect(page.getByText('00:33 放下')).toBeVisible();
  await expect(page.getByText('08:56 拿起')).toBeVisible();
  await expect(page.getByText('睡眠中亮屏 1 次')).toBeVisible();

  // 确认 → 完成小结 + 落库（date=醒来那天）+ handled 锁 + 影子诊断闭环
  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible();
  await page.getByRole('button', { name: '确定并查看详情' }).click();

  const recs = await readStore(page, 'somnacare_sleep_records');
  const landed = (recs as any[]).find((r) => r.date === today);
  expect(landed?.bedtime).toBe('00:33');
  expect(landed?.wakeTime).toBe('08:56');
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(today);

  const shadow = await readStore(page, 'somnacare_model_shadow');
  const entry = (shadow?.entries ?? []).find((e: any) => e.date === today);
  expect(entry?.heuristic?.bed).toBe('00:33');          // 引擎跑动已入档
  expect(entry?.outcome?.type).toBe('confirmed');       // 用户采纳已回填
});

test('忽略：隐去 + 不落库 + 刷新后仍隐去（handled 持久化）', async ({ page }) => {
  const fixed = await openAt(page, 9, 30);
  await seed(page, {
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:33', firstActive: '08:56', nightPickups: 0 }],
    records: midnightRecords,
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();

  await page.getByRole('button', { name: '忽略' }).click();
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  const recs = await readStore(page, 'somnacare_sleep_records');
  expect((recs as any[]).length).toBe(midnightRecords.length);   // 没有静默写库
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(dstr(0, fixed));

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);   // 刷新不复活
});

test('gate 4：目标夜已有夜睡记录 → 不出卡（尊重用户）', async ({ page }) => {
  const fixed = await openAt(page, 9, 30);
  await seed(page, {
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:33', firstActive: '08:56', nightPickups: 0 }],
    records: [...midnightRecords, mkRecord(dstr(0, fixed), '00:33', '08:56')],
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  await expect(page.getByText('今晚准备入睡')).toBeVisible();   // 页面本身健康
});

test('授权即时生效：设置返回后引擎自动重跑出卡，无需重开页面', async ({ page }) => {
  // 第 42 轮迭代发现的缺口：usageDays/模型两个 effect 均不依赖权限状态，
  // 从系统设置授权返回后引擎停在授权前的空态，直到手动切分区才恢复。
  // 本用例锁住修复：授权 → 轮询捕捉 → 引擎重跑 → 卡片出现（全程不重挂载）
  const fixed = new Date();
  fixed.setHours(9, 30, 0, 0);
  const now = fixed.getTime();
  let s = 7;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const events: number[] = [];
  const day0 = new Date(fixed);
  day0.setHours(0, 0, 0, 0);
  for (let d = 16; d >= 1; d--) {
    const base = day0.getTime() - d * 86400000;
    for (let t = base + 10 * 3600e3 + 30 * 60e3; t < base + 26 * 3600e3 + 30 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      events.push(Math.round(t));
    }
  }
  for (let t = day0.getTime() + 10 * 3600e3 + 30 * 60e3; t <= now - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
    events.push(Math.round(t));
  }
  events.sort((a, b) => a - b);

  await page.addInitScript(({ evs, ud }: { evs: number[]; ud: unknown[] }) => {
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    const granted = (): boolean => (window as any).__usageGranted === true;
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, {
        get: (t, p) => t[p as string] ?? stub(),
      }),
    };
    (window as any).Capacitor.Plugins.UsageSignal = {
      // 初始未授权；openPermissionSettings 模拟"用户在系统设置里完成授权"
      hasPermission: async () => ({ granted: granted() }),
      openPermissionSettings: async () => { (window as any).__usageGranted = true; },
      queryDailyUsage: async () => {
        if (!granted()) throw new Error('缺少使用情况访问权限');
        return { days: ud };
      },
      queryScreenOnEvents: async () => {
        if (!granted()) throw new Error('缺少使用情况访问权限');
        return { events: evs, observedUntil: Date.now() };
      },
    };
    localStorage.setItem('somnacare_onboarded_v1', '1');
  }, { evs: events, ud: [{ date: dstr(-1, fixed), lastActive: '02:30', firstActive: '10:30', nightPickups: 0 }] });

  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 授权前：无卡（查询全被拒），处于手动档默认态
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);

  // 切到自动档 → 点"开启自动记录"（跳系统设置，stub 里直接完成授权）
  await page.getByRole('button', { name: '自动', exact: true }).click();
  await page.getByRole('button', { name: /开启自动记录/ }).click();

  // 轮询（2s 间隔）捕捉到授权 → 引擎重跑 → 晚睡回退卡片出现，全程不重挂载
  await expect(page.getByText('昨晚的手机使用')).toBeVisible({ timeout: 20000 });
});

test('晚睡用户：模型先验错位拒绝 → 放行启发式回退 → 卡片出现（第 42 轮真机场景）', async ({ page }) => {
  // 真机自检实证的场景：用户作息 01:59→10:31，记录不足 3 晚 → 先验取缺省
  // 23:30/07:00 → 重定位偏差 >3h → 模型拒绝。此前组件对拒绝一律不回退
  // → 永不出卡；修复后 prior-mismatch 拒绝放行启发式，卡片必须出现
  const fixed = new Date();
  fixed.setHours(11, 30, 0, 0);   // 醒来 10:30 后 1 小时：新鲜度门内
  const now = fixed.getTime();
  let s = 7;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const events: number[] = [];
  const day0 = new Date(fixed);
  day0.setHours(0, 0, 0, 0);
  for (let d = 16; d >= 1; d--) {
    const base = day0.getTime() - d * 86400000;
    for (let t = base + 10 * 3600e3 + 30 * 60e3; t < base + 26 * 3600e3 + 30 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      events.push(Math.round(t));
    }
  }
  for (let t = day0.getTime() + 10 * 3600e3 + 30 * 60e3; t <= now - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
    events.push(Math.round(t));
  }
  events.sort((a, b) => a - b);

  await page.addInitScript(({ evs, ud }: { evs: number[]; ud: unknown[] }) => {
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, {
        get: (t, p) => t[p as string] ?? stub(),
      }),
    };
    (window as any).Capacitor.Plugins.UsageSignal = {
      hasPermission: async () => ({ granted: true }),
      openPermissionSettings: async () => ({}),
      queryDailyUsage: async () => ({ days: ud }),
      queryScreenOnEvents: async () => ({ events: evs, observedUntil: Date.now() }),
    };
    localStorage.setItem('somnacare_usage_days', JSON.stringify(ud));
    localStorage.setItem('somnacare_onboarded_v1', '1');
  }, { evs: events, ud: [{ date: dstr(-1, fixed), lastActive: '02:30', firstActive: '10:30', nightPickups: 0 }] });

  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 模型拒绝（先验错位）→ 启发式回退出卡
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const cardText = await page.evaluate(() => document.body.innerText);
  expect(cardText).toMatch(/02:[0-5]\d 放下/);
  expect(cardText).toMatch(/10:[0-5]\d 拿起/);

  // 自检面板：⑤ 应报"已放行启发式回退"，⑦ 应报能出提议（与组件一致）
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '偏好' }).click();
  await page.getByRole('button', { name: /点此自检链路/ }).click();
  const diag = await page.locator('pre').filter({ hasText: '⑦ 结论' }).innerText({ timeout: 15000 });
  expect(diag).toContain('已放行启发式回退');
  expect(diag).toContain('⑦ 结论：✓');
});

test('模型路径：mock 原生 → decided 提议 + 引擎入影子档 + 自检报"跑通" → 采纳', async ({ page }) => {
  const fixed = new Date();
  fixed.setHours(8, 30, 0, 0);
  const today = dstr(0, fixed);
  const now = fixed.getTime();

  // 合成 14 夜：07:05–23:40 每 8–18 分钟亮屏，夜里静默（就寝 23:40 / 起床 07:05）。
  // 密度对齐真实手机（低密度会让 Δ 置信门 300 拦下——原型实测过）
  let s = 42;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const events: number[] = [];
  const day0 = new Date(fixed);
  day0.setHours(0, 0, 0, 0);
  const day0Ms = day0.getTime();
  for (let d = 15; d >= 1; d--) {
    const base = day0Ms - d * 86400000;
    for (let t = base + 7 * 3600e3 + 5 * 60e3; t < base + 23 * 3600e3 + 40 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      events.push(Math.round(t));
    }
  }
  for (let t = day0Ms + 7 * 3600e3 + 5 * 60e3; t <= now - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
    events.push(Math.round(t));
  }
  events.sort((a, b) => a - b);

  await page.addInitScript(([evs, ud]) => {
    const stub = (): any => new Proxy({}, { get: () => () => Promise.resolve({}) });
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: new Proxy({} as Record<string, any>, {
        get: (t, p) => t[p as string] ?? stub(),
      }),
    };
    (window as any).Capacitor.Plugins.UsageSignal = {
      hasPermission: async () => ({ granted: true }),
      openPermissionSettings: async () => ({}),
      queryDailyUsage: async () => ({ days: ud }),
      queryScreenOnEvents: async () => ({ events: evs, observedUntil: Date.now() }),
    };
    localStorage.setItem('somnacare_usage_days', JSON.stringify(ud));
    localStorage.setItem('somnacare_onboarded_v1', '1');
  }, [events, [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }]]);

  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 模型 decided → 提议卡（时刻按 15 分钟桶量化：23:30/23:45 → 07:00/07:15）
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const cardText = await page.evaluate(() => document.body.innerText);
  expect(cardText).toMatch(/2[23]:[0-5]\d 放下/);
  expect(cardText).toMatch(/0[67]:[0-2]\d 拿起/);

  // 引擎跑动即入影子档（recordEngineRun 在提议出现时执行）
  const shadow = await readStore(page, 'somnacare_model_shadow');
  expect((shadow?.entries ?? []).some((e: any) => e.model?.bed)).toBeTruthy();

  // 自检面板：整条链路逐站报状态，模型应报"跑通"
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '偏好' }).click();
  await expect(page.getByText('自动记录 · 模型诊断')).toBeVisible();
  await page.getByRole('button', { name: /点此自检链路/ }).click();
  await expect(page.locator('pre').filter({ hasText: '⑦ 结论' })).toBeVisible({ timeout: 15000 });
  const diag = await page.locator('pre').filter({ hasText: '⑦ 结论' }).innerText();
  expect(diag).toContain('⑤ 模型：跑通');
  expect(diag).toContain('⑦ 结论：✓');

  // 回睡眠页确认采纳 → 影子档回填 confirmed
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '睡眠' }).click();
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible();

  const recs = await readStore(page, 'somnacare_sleep_records');
  const landed = (recs as any[]).find((r) => r.date === today);
  expect(landed?.bedtime).toMatch(/^2[23]:/);
  expect(landed?.recordSource).toBe('usage');
  const shadowAfter = await readStore(page, 'somnacare_model_shadow');
  const entry = (shadowAfter?.entries ?? []).find((e: any) => e.date === today);
  expect(entry?.model?.bed).toBeTruthy();
  expect(entry?.outcome?.type).toBe('confirmed');
});
