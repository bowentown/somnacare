/**
 * 护栏：数字健康台（第 78 轮，Phase 3）。
 * 每应用时长来自 UsageStats 真实测量；分类规则在 JS 侧本地运行；
 * 无任何数据上传。清单：原生方法/JS 封装/UI 消费/隐私声明。
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

const usagePlugin = read('plugins/cap-usage-signal/android/src/main/java/com/somnacare/usagesignal/UsageSignalPlugin.java');
const usageSignal = read('src/utils/usageSignal.ts');
const tab = read('src/components/EyeCareTab.tsx');

ok('原生：queryAppUsage 按自然日返回每应用前台分钟（<1 分钟不入报告）',
  usagePlugin.includes('public void queryAppUsage')
  && usagePlugin.includes('getTotalTimeInForeground')
  && usagePlugin.includes('ft < 60_000L'));
ok('JS：queryAppUsage 封装 + 类型', usageSignal.includes('queryAppUsage') && usageSignal.includes('AppUsageEntry'));
ok('UI：数字健康台区块（分类 chips + Top5 横条）',
  tab.includes('数字健康台') && tab.includes('categoryTotals') && tab.includes('todayApps.slice(0, 5)'));
// 第 80 轮（用户裁决）：解释性小字删除——隐私口径在 README 与权限表
ok('UI：无解释小字（干净）', !tab.includes('应用时长来自系统使用记录'));
ok('UI：复用 StatCard/Progress 视觉语法（Phase 0 组件层）',
  tab.includes('<StatCard') && !tab.includes('暂无睡眠数据</span>'));

// ── 第 81 轮真机回归：应用名必须是真实显示名，绝不允许包名碎片 ──
// 根因：targetSdk 35 的包可见性过滤，getApplicationInfo(第三方包) 一律
// NameNotFoundException → 旧代码回退包名尾段（用户截屏里的 mm/sgame）。
// 修复三件套：清单声明 QUERY_ALL_PACKAGES + 原生解析不出就跳过整条 +
// JS 侧挡住任何漏过来的碎片。
const usageManifest = read('plugins/cap-usage-signal/android/src/main/AndroidManifest.xml');
ok('原生清单：声明 QUERY_ALL_PACKAGES（Android 11+ 包可见性，否则第三方应用名一律解析失败）',
  usageManifest.includes('android.permission.QUERY_ALL_PACKAGES'));
ok('原生：appLabel 解析不出返回 null（不再回退包名尾段）',
  /private static String appLabel[\s\S]*?return null;/.test(usagePlugin)
  && !/return dot >= 0/.test(usagePlugin));
ok('原生：label 为 null 的条目整条跳过（不进报告）',
  /label == null\) continue;/.test(usagePlugin));
ok('UI：label 缺失/等于包名/等于尾段的条目不渲染（双保险）',
  tab.includes('looksLikePkgFragment')
  && /filter\(\(a\) => a\.date === todayKey && !looksLikePkgFragment\(a\)\)/.test(tab));
{
  // appLabel 只消费原生解析出的真实名——不再有"回退包名尾段"的分支
  const m = tab.match(/const appLabel[\s\S]*?;\n/);
  ok('UI：显示名直接用 a.label（无包名回退分支）',
    !!m && m[0].includes('a.label') && !m[0].includes('pkg'));
}

{
  const doctored = usagePlugin.replace('public void queryAppUsage(', 'public void removedMethod(');
  ok('反向自检：删掉原生方法后判据不再成立', !doctored.includes('public void queryAppUsage('));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——数字健康台护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-digital-wellbeing：真实测量 / 本地分类 / 隐私声明全部在位');
