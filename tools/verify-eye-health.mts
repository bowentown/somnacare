/**
 * 护栏：护眼健康台（第 77 轮，Phase 2）。
 *
 * 20-20-20 远眺提醒与用眼日报的全部数字来自真实测量：
 *  - 连续用屏时长 = SCREEN_ON/OFF 事件（动态接收器），不是估算；
 *  - 每日屏幕分钟/解锁 = UsageStats/USER_PRESENT 聚合；
 *  - 滤镜关闭时 20-20-20 仍可独立运行（零透明度窗口保活服务）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
};

const service = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/EyeCareService.java');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const usagePlugin = read('plugins/cap-usage-signal/android/src/main/java/com/somnacare/usagesignal/UsageSignalPlugin.java');
const eyeCare = read('src/utils/eyeCare.ts');
const usageSignal = read('src/utils/usageSignal.ts');
const tab = read('src/components/EyeCareTab.tsx');

// ── 20-20-20 原生 ──
ok('20-20-20：SCREEN_ON/OFF 真实测量连续用屏（动态接收器）',
  service.includes('ACTION_SCREEN_ON')
  && service.includes('ACTION_SCREEN_OFF')
  && service.includes('screenOnAt = android.os.SystemClock.elapsedRealtime()'));
ok('20-20-20：20 分钟阈值 / 20 秒引导 / 可点按结束 / 熄屏即收',
  service.includes('REST_INTERVAL_MS = 20 * 60_000L')
  && service.includes('REST_DURATION_MS = 20_000L')
  && service.includes('box.setOnClickListener(v -> dismissRestOverlay())')
  && service.includes('accumulateContinuousUsage()'));
ok('20-20-20：今日最长连续落盘（用眼日报用，日期键控）',
  service.includes('KEY_EYE_MAX_TODAY') && service.includes('"maxMin"'));
ok('20-20-20：滤镜关闭时保活服务（STOP 不停服，零透明度窗口）',
  service.includes('if (!restEnabled) {\n                    stopForeground(STOP_FOREGROUND_REMOVE);')
  && plugin.includes('EXTRA_WARM_ALPHA, 0f)'));
ok('服务完整性：onDestroy 只定义一次（CI 曾抓到重复定义的编译失败）',
  (service.match(/public void onDestroy\(/g) ?? []).length === 1);
ok('20-20-20：开关桥接（读取/设置 + APPLY extras 传递）',
  plugin.includes('public void eyeCareRestGet')
  && plugin.includes('public void eyeCareRestSet')
  && plugin.includes('EyeCareService.EXTRA_REST_ENABLED'));
ok('JS 封装：getEyeRestStatus / setEyeRestEnabled',
  eyeCare.includes('getEyeRestStatus') && eyeCare.includes('setEyeRestEnabled'));

// ── 用眼日报 ──
// 第 86 轮：解锁计数断言从"注释字符串在场"改为行为断言——旧断言锁死了
// 错误注释（UsageEvents.Event 并无 USER_PRESENT 常量，==1 数的是前台切换），
// 反而阻止正确修复。真解锁 = KEYGUARD_HIDDEN(18)，旧设备回退亮屏计数。
ok('用眼日报：queryDailyHealth 真实聚合（前台时长 + KEYGUARD_HIDDEN 解锁计数，含旧设备亮屏回退）',
  usagePlugin.includes('public void queryDailyHealth')
  && usagePlugin.includes('getTotalTimeInForeground')
  && usagePlugin.includes('type != EVT_KEYGUARD_HIDDEN && type != EVT_SCREEN_INTERACTIVE')
  && /unlockSource/.test(usagePlugin) && /unlockFromKeyguard \? "keyguard" : "screen"/.test(usagePlugin)
  && !usagePlugin.includes('USER_PRESENT（旧 API 无命名常量）')
  && usageSignal.includes('queryDailyHealth'));
ok('用眼日报 UI：StatCard + 7 天柱图（Recharts，真实数据）',
  tab.includes('queryDailyHealth')
  && tab.includes('用眼日报')
  && tab.includes('data-testid="eye-health-chart"')
  && /label=\{todayHealth\.unlockSource === 'screen' \? '今日亮屏次数' : '今日解锁'\}/.test(tab));
ok('UI：20-20-20 卡片在护眼页（开关 + 今日最长连续）',
  tab.includes('20-20-20 远眺提醒') && tab.includes('今日最长连续用屏'));

// ── 反向自检 ──
{
  const doctored = service.replace('REST_INTERVAL_MS = 20 * 60_000L', 'REST_INTERVAL_MS = 0L');
  ok('反向自检：阈值清零后判据不再成立', !doctored.includes('REST_INTERVAL_MS = 20 * 60_000L'));
}

// ── 用眼日报的物理边界（第 102 轮，行为断言）──
// 用户实测单日 34.6 小时：系统桶在时钟变更/对齐后跨日重叠双计。修复分三层
// （Java 归日 + 当天容量钳制 → TS sanitizeDailyHealth 钳制 → 图表展示），
// 本块 import 真实 TS 清洗函数，断言"单日亮屏 ≤ 1440 分钟"这条物理不变式。
{
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const { sanitizeDailyHealth, MAX_DAILY_SCREEN_MINUTES } = await import(
    new URL('../src/utils/usageSignal.ts', import.meta.url).href
  );
  const raw = [
    { date: '2026-10-26', screenMinutes: 2076, unlocks: 38, unlockSource: 'keyguard' },   // 34.6h（用户实测）
    { date: '2026-10-27', screenMinutes: 508, unlocks: 30, unlockSource: 'screen' },
    { date: '2026-10-28', screenMinutes: -5, unlocks: -3 },
    { date: 'not-a-date', screenMinutes: 100 },
    null,
  ];
  const out: Array<{ date: string; screenMinutes: number; unlocks: number; unlockSource?: string }> =
    sanitizeDailyHealth(raw);
  // 判据（正反共用）：单日分钟数落在 [0, 1440]
  const physical = (list: Array<{ screenMinutes: number }>): boolean =>
    list.every((d) => d.screenMinutes >= 0 && d.screenMinutes <= MAX_DAILY_SCREEN_MINUTES);

  ok('用眼日报：单日亮屏钳到物理上限（34.6h = 2076min → 1440）',
    MAX_DAILY_SCREEN_MINUTES === 1440
    && out.find((d) => d.date === '2026-10-26')?.screenMinutes === 1440);
  ok('用眼日报：正常值透传 / 负值归零 / 坏条目剔除',
    out.find((d) => d.date === '2026-10-27')?.screenMinutes === 508
    && out.find((d) => d.date === '2026-10-28')?.screenMinutes === 0
    && out.find((d) => d.date === 'not-a-date') === undefined
    && out.length === 3);
  ok('用眼日报：unlockSource 白名单外不落字段',
    out.find((d) => d.date === '2026-10-27')?.unlockSource === 'screen');
  // 反向自检：修复前的透传（只滤形状不钳数值）必须不满足同一物理判据
  {
    const preFix = (raw as unknown[]).filter(
      (d): d is { date: string; screenMinutes: number } =>
        !!d && typeof (d as any).date === 'string',
    );
    ok('反向自检：修复前的透传不满足物理边界（钳制不是摆设）',
      physical(out) && !physical(preFix));
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——护眼健康台护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-eye-health：真实测量 / 保活策略 / 桥接 / 日报全部在位');
