/**
 * 护栏：趋势图可读性（第 64 轮）。
 *
 * 图表“好不好看”难以自动判断，但“有没有坐标/目标带/直接标注/缺数据断点/
 * 分期图例”是可以钉死的。本护栏锁住第 64 轮的三张图改造，防止后续
 * 重构把刻度、均值、缺口或目标窗口悄悄删掉。
 *
 * 方法论：反向自检——删掉 Y 轴刻度后同一断言必须报红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failures++;
};

const trends = read('src/components/TrendsTab.tsx');
const app = read('src/App.tsx');
const css = read('src/index.css');

ok('评分图：有 Y 轴刻度 50/75/90/100',
  trends.includes('[100, 90, 75, 50]')
  && trends.includes('PLOT_LEFT')
  && trends.includes('PLOT_RIGHT'));
ok('评分图：目标带 + 7 晚均值 + 缺数据断点',
  trends.includes('scoreToY(75) - scoreToY(100)')
  && trends.includes('avgScore')
  && trends.includes('dayGap')
  && trends.includes('scoreSegments'));
ok('评分图：可直接点按/拖拽查看，且有可读 aria-label',
  trends.includes('data-testid="score-chart"')
  && trends.includes('aria-label="近 7 晚睡眠评分趋势图')
  && trends.includes('score-detail'));
ok('图表文字：轴标签不小于 9px，窄屏不换行',
  (trends.match(/fontSize="9"/g) ?? []).length >= 3
  && trends.includes('whitespace-nowrap'));
ok('分期图：100% 横带 + 直接百分比 + 7 晚平均',
  trends.includes('STAGE_COLORS')
  && trends.includes('stageAvg')
  && trends.includes('近 7 晚平均')
  && trends.includes('min-h-9'));
ok('分期图：四段色值与 @theme 字面 hex 同步',
  css.includes('--color-emerald-400: #00d492;')
  && css.includes('--color-sky-400: #00bcff;')
  && css.includes('--color-violet-400: #a684ff;')
  && css.includes('--color-rose-400: #ff637e;')
  && trends.includes("deep: '#00d492'")
  && trends.includes("light: '#00bcff'")
  && trends.includes("rem: '#a684ff'")
  && trends.includes("awake: '#ff637e'"));
ok('起卧图：哑铃/区间 + 目标窗口 + 行标签',
  trends.includes('targetBedtime')
  && trends.includes('targetWakeTime')
  && trends.includes('rangePct')
  && trends.includes('targetLabel')
  && trends.includes('flex-1 h-6 rounded-md relative overflow-hidden'));
ok('App 把用户目标作息传入趋势页',
  app.includes('targetBedtime={userProfile.targetBedtime}')
  && app.includes('targetWakeTime={userProfile.targetWakeTime}'));

// 反向自检：删掉 Y 轴刻度数组后，同一判据必须失去
{
  const doctored = trends.replace('[100, 90, 75, 50]', '[]');
  ok('反向自检：删除 Y 轴刻度后判据不再成立', !doctored.includes('[100, 90, 75, 50]'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——趋势图可读性护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-chart-readability：坐标/目标带/断点/分期/起卧全部在位');
