/**
 * 护栏：放下手机前的一小时（第 82 轮，取代数字健康台）。
 *
 * 用户裁决：每应用全天时长榜与系统"屏幕使用时间"重复、"其他"分类占大头
 * 难看 → 删除；换一个系统没有、且与入睡直接相邻的视角——昨夜最后一次
 * 熄屏前 60 分钟每应用前台分钟（真实应用名，QUERY_ALL_PACKAGES 可见性）。
 *
 * 锁定清单：原生查询（夜归属与 queryDailyUsage 同口径）/ JS 封装 /
 * 首页卡片 / 数字健康台彻底移除 / 开屏涟漪与性能项一并入锁。
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

const plugin = read('plugins/cap-usage-signal/android/src/main/java/com/somnacare/usagesignal/UsageSignalPlugin.java');
const manifest = read('plugins/cap-usage-signal/android/src/main/AndroidManifest.xml');
const usageSignal = read('src/utils/usageSignal.ts');
const today = read('src/components/TodayTab.tsx');
const eye = read('src/components/EyeCareTab.tsx');

// ── 原生：queryWindDownApps ──
ok('原生：queryWindDownApps 存在且窗口钳制在 15–120 分钟',
  plugin.includes('public void queryWindDownApps')
  && plugin.includes('windowMin < 15') && plugin.includes('windowMin > 120'));
{
  // 夜归属规则与 queryDailyUsage 同步（12 点前归前一夜 + 放下窗口 18–06）：
  // 两套实现并存，规则表达式必须成对出现（各出现 ≥2 次）
  const shift = plugin.match(/hour < 12/g)?.length ?? 0;
  const shiftCal = plugin.match(/cal\.add\(Calendar\.HOUR_OF_DAY, -12\)/g)?.length ?? 0;
  const putDown = plugin.match(/hour >= 18 \|\| hour < 6/g)?.length ?? 0;
  ok('原生：夜归属/放下窗口规则与 queryDailyUsage 成对同口径（shift×2 + putDown×2）',
    shift >= 2 && shiftCal >= 2 && putDown >= 2,
    `shift=${shift} shiftCal=${shiftCal} putDown=${putDown}`);
}
ok('原生：名字解析不出跳过整条（appLabel null 复用，绝不显示包名碎片）',
  /String label = appLabel\(ctx, e\.getKey\(\)\);[\s\S]{0,120}if \(label == null\) continue;/.test(plugin));
ok('原生：窗口结束仍在前台的应用补记到放下时刻（pendingStart 收尾）',
  /for \(java\.util\.Map\.Entry<String, Long> e : pendingStart\.entrySet\(\)\)/.test(plugin));
ok('原生清单：QUERY_ALL_PACKAGES 仍在（第三方应用名可见性，mm/sgame 回归）',
  manifest.includes('android.permission.QUERY_ALL_PACKAGES'));
ok('原生：queryAppUsage（数字健康台旧通路）已移除',
  !plugin.includes('public void queryAppUsage'));

// ── JS 封装 ──
ok('JS：queryWindDownApps 封装 + 类型（label 为必填字符串）',
  usageSignal.includes('export async function queryWindDownApps')
  && usageSignal.includes('interface WindDownApp')
  && !usageSignal.includes('queryAppUsage'));

// ── 首页卡片 ──
ok('UI：首页「放下手机前的一小时」卡片（总分钟 + 应用 chips + 放下时刻）',
  today.includes('winddown-card')
  && today.includes('放下手机前的一小时')
  && today.includes('{hm} 放下')
  && today.includes('分钟还在亮屏'));
ok('UI：诚实文案只在 ≥55 分钟时出现（不制造因果断言）',
  today.includes('totalMin >= 55')
  && today.includes('放下前手机几乎没停过'));
ok('UI：无数据/无权限时卡片不渲染（apps.length > 0 门控）',
  /windDown && windDown\.apps\.length > 0/.test(today));

// ── 数字健康台彻底移除 ──
ok('移除：EyeCareTab 无每应用榜/分类规则残留',
  !eye.includes('数字健康台') && !eye.includes('CATEGORY_RULES') && !eye.includes('todayApps'));
ok('移除：护眼页保留用眼日报（今日屏幕/解锁仍在）',
  eye.includes('用眼日报') && eye.includes('queryDailyHealth'));

// ── 开屏涟漪（第 82 轮视觉）──
const css = read('src/index.css');
const splash = read('src/components/LaunchSplash.tsx');
ok('开屏：宣传语涟漪 keyframe + 组件三圈椭圆使用',
  css.includes('@keyframes splash-slogan-ripple')
  && (splash.match(/splash-slogan-ripple/g)?.length ?? 0) >= 1);
ok('开屏：大号渐变字（22px/black/bg-clip）+ 逐字浮现',
  splash.includes('text-[22px]') && splash.includes('backgroundClip')
  && splash.includes("{'懂睡眠，更懂你'.split('').map"));

// ── 性能（第 82 轮）──
const panel = read('src/components/AIAdvicePanel.tsx');
const app = read('src/App.tsx');
ok('性能：聊天跟随滚动 rAF 合帧',
  /requestAnimationFrame\(\(\) => \{[\s\S]{0,160}node\.scrollTop = node\.scrollHeight/.test(panel));
ok('性能：EyeCareTab memo + App 侧 onUpdateProfile 稳定引用',
  eye.includes('React.memo(EyeCareTabInner)') && app.includes('const handleUpdateProfile = useCallback'));

// 反向自检：改坏夜归属同步必须被抓（shift 计数跌回 1）
{
  const doctored = plugin.replace(/hour < 12/g, 'hour < 13');
  const shift = doctored.match(/hour < 12/g)?.length ?? 0;
  ok('反向自检：夜归属规则被改动 → 同步断言报红', shift < 2);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——睡前一小时/开屏涟漪/性能护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-wind-down：睡前一小时 / 数字健康台移除 / 开屏涟漪 / 性能项全部在位');
