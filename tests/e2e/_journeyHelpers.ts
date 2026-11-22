import { expect, test, type Page } from '@playwright/test';

/**
 * 用户旅程回归（第 55 轮）：扮演真实用户把核心路径走一遍。
 *
 * 与既有 spec 的分工：proposal.spec 锁提议引擎的闸门语义、app.spec 锁
 * 各分区主流程——本文件按"一天的真实使用顺序"串联操作，并在旅程中
 * 断言下游联动（确认→趋势→旅行能量→影子诊断；删除→能量回退；
 * 旧备份导入→日期迁移），同时收集页面异常。
 */

export const pad = (n: number): string => String(n).padStart(2, '0');
export const dstr = (off: number, base = new Date()): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const mkRecord = (date: string, bedtime: string, wakeTime: string, score = 86) => ({
  id: 'r-' + date + '-' + bedtime, date, bedtime, wakeTime,
  durationMinutes: 480, deepSleepMinutes: 90, lightSleepMinutes: 300,
  remSleepMinutes: 70, awakeMinutes: 10, sleepScore: score, sleepEfficiency: 91,
  latencyMinutes: 12, wakeCount: 1,
});


/** 带逐段分期的记录：用于锁住 hypnogram 时间轴（不是百分比回退） */
export const mkRecordWithStages = (date: string) => ({
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
export const watchErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
  });
  return errors;
};

/** 测试数据已是夜归属口径 → 预写迁移标记，防止 App 加载时二次迁移 */
export const NIGHT_SCHEMA = { somnacare_record_date_schema: 'night-v1' } as Record<string, string>;

export const seed = async (page: Page, records: unknown[] = [], extra?: Record<string, string>) => {
  await page.addInitScript(({ recs, ex }: { recs: string; ex: Record<string, string> }) => {
    localStorage.setItem('somnacare_sleep_records', recs);
    localStorage.setItem('somnacare_onboarded_v1', '1');
    for (const [k, v] of Object.entries(ex)) localStorage.setItem(k, v);
    sessionStorage.clear();
  }, { recs: JSON.stringify(records), ex: extra ?? {} });
};

export const openAt = async (page: Page, h: number, m: number): Promise<Date> => {
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
export const navTo = async (page: Page, tab: string) => {
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: tab }).click();
  await page.waitForTimeout(380);
};

/** 安装"原生桥"mock（CustomPlatform 通道，isNativePlatform 恒 true） */
export const mockNativeUsage = async (
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
export const synthEvents = (now: Date): number[] => {
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
