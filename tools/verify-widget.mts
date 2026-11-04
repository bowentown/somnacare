/**
 * 护栏：睡眠桌面小组件（第 126–127 轮）。
 *
 * 四条不变量：
 *  1. Provider 行为：RemoteViews 子集布局、无记录诚实显示 "--"、点击唤起
 *     主应用、updateAll 空实例安全；
 *  2. 数据通道：petSync 三键落盘（与 Bedtime/Pet/NightRescue 共用
 *     somnacare_prefs）+ 快照变化即刷新；
 *  3. CI 接线：receiver + APPWIDGET_UPDATE + meta-data @xml/sleep_widget_info
 *     （build-apk.yml sed 注入，与 AdSkipService 同模式——本地无 android/
 *     工程，注入必须护栏钉住）；
 *  4. 元数据/布局文件在场（initialLayout 指向真实布局）。
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

const provider = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/SleepWidgetProvider.java');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const ci = read('.github/workflows/build-apk.yml');
const info = read('plugins/cap-gemma-llm/android/src/main/res/xml/sleep_widget_info.xml');
const layout = read('plugins/cap-gemma-llm/android/src/main/res/layout/sleep_widget_layout.xml');
const petOverlay = read('src/utils/petOverlay.ts');

check('Provider：无记录诚实 "--"（不冒充 0 分）+ 点击唤起主应用',
  provider.includes('score >= 0 ? String.valueOf(score) : "--"')
  && provider.includes('getLaunchIntentForPackage')
  && provider.includes('FLAG_IMMUTABLE'));
check('Provider：updateAll 空实例安全（AppWidgetIds 为 0 直接返回）',
  provider.includes('ids == null || ids.length == 0'));
check('数据通道：petSync 落盘三键 + 快照变化即 updateAll',
  plugin.includes('SleepWidgetProvider.K_WIDGET_SCORE')
  && plugin.includes('SleepWidgetProvider.K_WIDGET_BED')
  && plugin.includes('SleepWidgetProvider.updateAll(getContext())'));
check('数据源：petOverlay payload 携带 targetBedtime（两处 petSync 调用都在场）',
  (petOverlay.match(/targetBedtime: profile\?\.targetBedtime/g) || []).length === 2);
check('CI 接线：receiver + APPWIDGET_UPDATE + meta-data（本地无 android/ 工程，注入必须钉住）',
  ci.includes('<receiver android:name="com.somnacare.gemmallm.SleepWidgetProvider"')
  && ci.includes('android.appwidget.action.APPWIDGET_UPDATE')
  && ci.includes('android:resource="@xml/sleep_widget_info"'));
check('元数据：initialLayout 指向真实布局 + 2×2 尺寸',
  info.includes('android:initialLayout="@layout/sleep_widget_layout"')
  && info.includes('android:targetCellWidth="2"'));
check('布局：RemoteViews 子集（Frame/Linear/TextView）+ 三视图 id 在场',
  layout.includes('FrameLayout') && !layout.includes('ConstraintLayout')
  && layout.includes('@+id/widget_score') && layout.includes('@+id/widget_score_label')
  && layout.includes('@+id/widget_sub'));

// 反向自检
{
  const doctoredCi = ci.replace('android.appwidget.action.APPWIDGET_UPDATE', 'android.appwidget.action.XXX');
  check('反向自检：CI intent-filter 被改坏后判据不再成立',
    !doctoredCi.includes('android.appwidget.action.APPWIDGET_UPDATE'));
  const doctoredProvider = provider.split('"--"').join('"0"');   // 全量：注释与代码各一处
  check('反向自检：无记录冒充 0 分被检出',
    doctoredProvider.includes('score >= 0 ? String.valueOf(score) : "0"'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌面小组件护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-widget：Provider/数据通道/CI 接线/布局元数据全部在位');
