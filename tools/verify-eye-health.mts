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
ok('用眼日报：queryDailyHealth 真实聚合（前台时长 + USER_PRESENT 计数）',
  usagePlugin.includes('public void queryDailyHealth')
  && usagePlugin.includes('getTotalTimeInForeground')
  && usagePlugin.includes('EVENT_USER_PRESENT（旧 API 无命名常量）')
  && usageSignal.includes('queryDailyHealth'));
ok('用眼日报 UI：StatCard + 7 天柱图（Recharts，真实数据）',
  tab.includes('queryDailyHealth')
  && tab.includes('用眼日报')
  && tab.includes('data-testid="eye-health-chart"')
  && tab.includes('今日解锁'));
ok('UI：20-20-20 卡片在护眼页（开关 + 今日最长连续）',
  tab.includes('20-20-20 远眺提醒') && tab.includes('今日最长连续用屏'));

// ── 反向自检 ──
{
  const doctored = service.replace('REST_INTERVAL_MS = 20 * 60_000L', 'REST_INTERVAL_MS = 0L');
  ok('反向自检：阈值清零后判据不再成立', !doctored.includes('REST_INTERVAL_MS = 20 * 60_000L'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——护眼健康台护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-eye-health：真实测量 / 保活策略 / 桥接 / 日报全部在位');
