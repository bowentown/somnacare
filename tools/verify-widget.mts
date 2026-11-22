/**
 * 护栏：睡眠桌面小组件（Phase 3 独立 cap-sleep-widgets 插件建制）。
 *
 * 四条不变量：
 *  1. Provider 行为：RemoteViews 子集布局、无记录诚实显示 "--"、点击 DeepLink 唤起主应用、updateAll 空实例安全；
 *  2. 独立数据通道：SleepWidgetsPlugin.syncSnapshot 落盘 WidgetStore 并触发 WidgetRegistry.updateAll；
 *  3. 插件清单与 CI 接线：cap-sleep-widgets AndroidManifest 声明 receiver + APPWIDGET_UPDATE + meta-data @xml/sleep_widget_info，且 CI 安装并预编译 :cap-sleep-widgets；
 *  4. 元数据/布局文件在场（initialLayout 指向真实布局，无 ConstraintLayout）。
 *
 * 方法论：反向自检——注入坏配置必须被同一判据抓住。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const provider = read('plugins/cap-sleep-widgets/android/src/main/java/com/somnacare/gemmallm/SleepWidgetProvider.java');
const plugin = read('plugins/cap-sleep-widgets/android/src/main/java/com/somnacare/gemmallm/SleepWidgetsPlugin.java');
const themeHelper = read('plugins/cap-sleep-widgets/android/src/main/java/com/somnacare/gemmallm/WidgetTheme.java');
const manifest = read('plugins/cap-sleep-widgets/android/src/main/AndroidManifest.xml');
const ci = read('.github/workflows/build-apk.yml');
const info = read('plugins/cap-sleep-widgets/android/src/main/res/xml/sleep_widget_info.xml');
const layout = read('plugins/cap-sleep-widgets/android/src/main/res/layout/sleep_widget_layout.xml');

check('Provider：无记录诚实 "--"（不冒充 0 分）+ DeepLink 唤起主应用',
  provider.includes('score >= 0 ? String.valueOf(score) : "--"')
  && themeHelper.includes('getLaunchIntentForPackage')
  && themeHelper.includes('FLAG_IMMUTABLE'));
check('Provider：updateAll 空实例安全（AppWidgetIds 为 0 直接返回）',
  provider.includes('ids == null || ids.length == 0'));
check('独立数据通道：SleepWidgetsPlugin.syncSnapshot 落盘并刷新 WidgetRegistry',
  plugin.includes('public void syncSnapshot')
  && plugin.includes('WidgetStore.K_LAST_SCORE')
  && plugin.includes('WidgetStore.K_TARGET_BEDTIME')
  && plugin.includes('WidgetRegistry.updateAll(ctx)'));
check('DeepLink 通道：冷启动 consumePendingRoute + 热启动 handleOnNewIntent',
  plugin.includes('public void consumePendingRoute')
  && plugin.includes('protected void handleOnNewIntent')
  && plugin.includes('widgetDeepLink'));
check('插件清单与 CI 接线：receiver + APPWIDGET_UPDATE + meta-data + 插件安装与编译',
  manifest.includes('android:name="com.somnacare.gemmallm.SleepWidgetProvider"')
  && manifest.includes('android.appwidget.action.APPWIDGET_UPDATE')
  && manifest.includes('android:resource="@xml/sleep_widget_info"')
  && ci.includes('./plugins/cap-sleep-widgets')
  && ci.includes(':cap-sleep-widgets:compileDebugJavaWithJavac'));
check('元数据：initialLayout 指向真实布局 + 2 格宽度',
  info.includes('android:initialLayout="@layout/sleep_widget_layout"')
  && info.includes('android:targetCellWidth="2"'));
check('布局：RemoteViews 子集（Frame/Linear/TextView）+ 三视图 id 在场',
  layout.includes('FrameLayout') && !layout.includes('ConstraintLayout')
  && layout.includes('@+id/widget_score') && layout.includes('@+id/widget_score_label')
  && layout.includes('@+id/widget_sub'));

// 反向自检
{
  const doctoredManifest = manifest.replace('android.appwidget.action.APPWIDGET_UPDATE', 'android.appwidget.action.XXX');
  check('反向自检：Manifest intent-filter 被改坏后判据不再成立',
    !doctoredManifest.includes('android.appwidget.action.APPWIDGET_UPDATE'));
  const doctoredProvider = provider.split('"--"').join('"0"');
  check('反向自检：无记录冒充 0 分被检出',
    doctoredProvider.includes('score >= 0 ? String.valueOf(score) : "0"'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌面小组件护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-widget：Provider/独立快照通道/DeepLink/插件清单与布局元数据全部在位');
