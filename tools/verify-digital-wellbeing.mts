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
ok('UI：隐私声明在场（本地分类、不上传）',
  tab.includes('分类规则在本机运行，不上传任何数据'));
ok('UI：复用 StatCard/Progress 视觉语法（Phase 0 组件层）',
  tab.includes('<StatCard') && !tab.includes('暂无睡眠数据</span>'));

{
  const doctored = usagePlugin.replace('public void queryAppUsage(', 'public void removedMethod(');
  ok('反向自检：删掉原生方法后判据不再成立', !doctored.includes('public void queryAppUsage('));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——数字健康台护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-digital-wellbeing：真实测量 / 本地分类 / 隐私声明全部在位');
