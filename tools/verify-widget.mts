/**
 * 护栏：桌面小组件矩阵（Phase 4 完整 4 款小组件 + 独立 WidgetSnapshot 总线 + DeepLink）。
 *
 * 五条不变量：
 *  1. 4 款 Provider 行为齐备：SleepWidgetProvider(2×1)、BedtimeQuickWidgetProvider(2×2)、
 *     WeekRhythmWidgetProvider(4×2)、PetEnergyWidgetProvider(2×2) 均含空实例安全返回；
 *     无记录诚实显示 "--"（不冒充 0 分），SRI 样本不足诚实显示 "SRI --"；
 *  2. RemoteViews 安全子集：全部 4 份布局 XML 严禁 ConstraintLayout / oklch；
 *  3. 独立快照通道：SleepWidgetsPlugin.syncSnapshot 落盘 WidgetStore 并通过 WidgetRegistry.updateAll
 *     一次刷新 4 款组件；前端 App.tsx 挂载防抖同步总线 syncWidgetsDebounced；
 *  4. DeepLink 与护眼就地切换：冷启动 consumePendingRoute + 热启动 handleOnNewIntent +
 *     睡前小组件直接发显式广播 com.somnacare.ACTION_TOGGLE_EYECARE（不打开 App）；
 *  5. 插件清单与 CI 接线：4 个 AppWidget receiver + WidgetRefreshReceiver + 对应 xml 元数据，
 *     CI 安装并预编译 :cap-sleep-widgets。
 *
 * 方法论：反向自检——注入坏配置必须被同一判据抓住。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const base = 'plugins/cap-sleep-widgets/android/src/main';
const scoreProvider = read(`${base}/java/com/somnacare/gemmallm/SleepWidgetProvider.java`);
const bedtimeProvider = read(`${base}/java/com/somnacare/gemmallm/BedtimeQuickWidgetProvider.java`);
const rhythmProvider = read(`${base}/java/com/somnacare/gemmallm/WeekRhythmWidgetProvider.java`);
const petProvider = read(`${base}/java/com/somnacare/gemmallm/PetEnergyWidgetProvider.java`);
const plugin = read(`${base}/java/com/somnacare/gemmallm/SleepWidgetsPlugin.java`);
const registry = read(`${base}/java/com/somnacare/gemmallm/WidgetRegistry.java`);
const themeHelper = read(`${base}/java/com/somnacare/gemmallm/WidgetTheme.java`);
const manifest = read(`${base}/AndroidManifest.xml`);
const ci = read('.github/workflows/build-apk.yml');
const appTsx = read('src/app/App.tsx');
const snapshotTs = read('src/features/widgets/widgetSnapshot.ts');
const syncTs = read('src/features/widgets/syncWidgets.ts');

const widgets = [
  {
    name: 'SleepWidgetProvider',
    provider: scoreProvider,
    info: read(`${base}/res/xml/sleep_widget_info.xml`),
    layout: read(`${base}/res/layout/sleep_widget_layout.xml`),
    layoutRef: '@layout/sleep_widget_layout',
    infoRef: '@xml/sleep_widget_info',
  },
  {
    name: 'BedtimeQuickWidgetProvider',
    provider: bedtimeProvider,
    info: read(`${base}/res/xml/widget_bedtime_quick_info.xml`),
    layout: read(`${base}/res/layout/widget_bedtime_quick.xml`),
    layoutRef: '@layout/widget_bedtime_quick',
    infoRef: '@xml/widget_bedtime_quick_info',
  },
  {
    name: 'WeekRhythmWidgetProvider',
    provider: rhythmProvider,
    info: read(`${base}/res/xml/widget_week_rhythm_info.xml`),
    layout: read(`${base}/res/layout/widget_week_rhythm.xml`),
    layoutRef: '@layout/widget_week_rhythm',
    infoRef: '@xml/widget_week_rhythm_info',
  },
  {
    name: 'PetEnergyWidgetProvider',
    provider: petProvider,
    info: read(`${base}/res/xml/widget_pet_energy_info.xml`),
    layout: read(`${base}/res/layout/widget_pet_energy.xml`),
    layoutRef: '@layout/widget_pet_energy',
    infoRef: '@xml/widget_pet_energy_info',
  },
];

check('Provider：无记录诚实 "--"（不冒充 0 分）+ SRI 样本不足诚实 "SRI --"',
  scoreProvider.includes('score >= 0 ? String.valueOf(score) : "--"')
  && rhythmProvider.includes('sri >= 0 ? ("SRI " + sri) : "SRI --"'));

check('4 款 Provider 均含空实例安全返回 + 注册进 WidgetRegistry + Manifest 声明',
  widgets.every((w) =>
    w.provider.includes('ids == null || ids.length == 0')
    && registry.includes(`${w.name}.updateAll(context)`)
    && manifest.includes(`android:name="com.somnacare.gemmallm.${w.name}"`)
    && manifest.includes(`android:resource="${w.infoRef}"`)
    && w.info.includes(`android:initialLayout="${w.layoutRef}"`)));

check('全部 4 份布局 XML 遵守 RemoteViews 安全子集（无 ConstraintLayout / 无 oklch）',
  widgets.every((w) =>
    w.layout.includes('FrameLayout')
    && !w.layout.includes('ConstraintLayout')
    && !w.layout.includes('oklch')));

const requiredDrawables = [
  'widget_bg_midnight', 'widget_bg_pure_dark', 'widget_bg_warm_amber', 'widget_bg_serene_blue',
  'widget_surface_midnight', 'widget_surface_pure_dark', 'widget_surface_warm_amber', 'widget_surface_serene_blue',
  'widget_accent_midnight', 'widget_accent_pure_dark', 'widget_accent_warm_amber', 'widget_accent_serene_blue',
  'widget_dot_green', 'widget_dot_yellow', 'widget_dot_red', 'widget_dot_none',
];
const missingDrawables = requiredDrawables.filter((name) => {
  const p = join(ROOT, `${base}/res/drawable/${name}.xml`);
  if (!existsSync(p)) return true;
  const xml = readFileSync(p, 'utf-8');
  return !xml.includes('<shape') || !xml.includes('<corners');
});
check('4 款小组件全部改用圆角 <shape> drawable（setBackgroundResource，零直角 setBackgroundColor）',
  missingDrawables.length === 0
  && widgets.every((w) =>
    w.provider.includes('setBackgroundResource')
    && !w.provider.includes('setBackgroundColor')
    && w.layout.includes('@drawable/widget_bg_midnight')),
  missingDrawables.length > 0 ? `缺失/缺圆角：${missingDrawables.join(', ')}` : '');

check('DeepLink 与护眼就地切换：冷/热启动消费 + 睡前小组件显式广播护眼',
  themeHelper.includes('getLaunchIntentForPackage')
  && themeHelper.includes('FLAG_IMMUTABLE')
  && themeHelper.includes('com.somnacare.ACTION_TOGGLE_EYECARE')
  && bedtimeProvider.includes('sleep/start')
  && bedtimeProvider.includes('intervention/wind-down')
  && bedtimeProvider.includes('toggleEyeCareBroadcast')
  && rhythmProvider.includes('"trends"')
  && petProvider.includes('"pet/codex"')
  && plugin.includes('public void consumePendingRoute')
  && plugin.includes('protected void handleOnNewIntent')
  && plugin.includes('public void requestPinWidget'));

check('独立数据总线：前端 WidgetSnapshot → syncWidgetsDebounced → SleepWidgetsPlugin.syncSnapshot',
  snapshotTs.includes('export function buildWidgetSnapshot')
  && syncTs.includes("nativePlugin('SleepWidgets')")
  && appTsx.includes('syncWidgetsDebounced(records, userProfile)')
  && plugin.includes('public void syncSnapshot')
  && plugin.includes('WidgetRegistry.updateAll(ctx)'));

check('CI 接线：安装并预编译 :cap-sleep-widgets + WidgetRefreshReceiver 在场',
  manifest.includes('com.somnacare.gemmallm.WidgetRefreshReceiver')
  && manifest.includes('com.somnacare.ACTION_WIDGET_REFRESH')
  && ci.includes('./plugins/cap-sleep-widgets')
  && ci.includes(':cap-sleep-widgets:compileDebugJavaWithJavac'));

// 反向自检
{
  const doctoredManifest = manifest.replace('android.appwidget.action.APPWIDGET_UPDATE', 'android.appwidget.action.XXX');
  check('反向自检：Manifest intent-filter 被改坏后判据不再成立',
    (doctoredManifest.match(/android\.appwidget\.action\.APPWIDGET_UPDATE/g)?.length ?? 0) < 4);
  const doctoredProvider = scoreProvider.split('"--"').join('"0"');
  check('反向自检：无记录冒充 0 分被检出',
    doctoredProvider.includes('score >= 0 ? String.valueOf(score) : "0"'));
  const squareProvider = scoreProvider.replace('setBackgroundResource', 'setBackgroundColor');
  check('反向自检：回退直角 setBackgroundColor 被检出',
    squareProvider !== scoreProvider && squareProvider.includes('setBackgroundColor'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌面小组件护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-widget：4 款小组件 / RemoteViews 安全布局 / 独立快照总线 / DeepLink 全部在位');
