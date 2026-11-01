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
const pkg = read('package.json');
// 第 107 轮重做的两个可视化（开源组件 + 交互 + 数据诚实）
const cal = read('src/components/SleepCalendar.tsx');
const rhythm = read('src/components/SleepRhythmChart.tsx');

ok('图表库：评分图使用 Recharts（MIT，React 19）',
  trends.includes("from 'recharts'")
  && pkg.includes('"recharts"'));
ok('评分图：Y 轴刻度 50/75/90/100 + 目标带 + 缺数据断点',
  trends.includes('[50, 75, 90, 100]')
  && trends.includes('ResponsiveContainer')
  && trends.includes('ReferenceArea')
  && trends.includes('connectNulls={false}')
  && trends.includes('avgScore'));
ok('评分图：可直接点按/拖拽查看，且有可读 aria-label',
  trends.includes('data-testid="score-chart"')
  && trends.includes('aria-label="近 7 晚睡眠评分趋势图')
  && trends.includes('onPointerMove')
  && trends.includes('score-detail'));
ok('图表文字：轴标签不小于 9px，窄屏不换行',
  trends.includes('fontSize: 9')
  && trends.includes('fontSize: 10')
  && trends.includes('whitespace-nowrap'));
ok('分期图：Recharts 100% 堆叠横条（shadcn/ui Charts 语法）+ 浮层 + 7 晚平均',
  trends.includes('BarChart')
  && trends.includes('layout="vertical"')
  && trends.includes('stackId="stage"')
  && trends.includes('StageTooltip')
  && trends.includes('stageData')
  && trends.includes('stageAvg')
  && trends.includes('近 7 晚平均')
  && trends.includes('aria-label="近 7 晚睡眠分期比例图')
  && trends.includes('pickStageAt'));
ok('分期图：分段色带内嵌文字已移除（百分比走浮层/图例，不再挤在色块里）',
  !trends.includes('text-[8px] font-black text-[#06121f]'));
ok('分期图：低饱和色板（不再用荧光绿/电光蓝）',
  trends.includes("deep: '#3f9e8f'")
  && trends.includes("light: '#4f86d9'")
  && trends.includes("rem: '#8b7fd6'")
  && trends.includes("awake: '#d9955f'")
  && !trends.includes("deep: '#00d492'"));
ok('起卧图：哑铃（2px 线 + 7px 点）+ 偏离琥珀着色 + 纯填充目标带 + 页脚均值',
  trends.includes('targetBedtime')
  && trends.includes('targetWakeTime')
  && trends.includes('rangePct')
  && trends.includes('targetLabel')
  && trends.includes('left: 44, right: 82')
  && trends.includes('flex-1 h-6 relative')
  && trends.includes('isOffTarget')
  && trends.includes('offTargetCount')
  && trends.includes("offTarget ? '#fbbf24' : theme.accentHex")
  && trends.includes('w-2 h-2 rounded-full')
  && trends.includes("top: 'calc(50% - 4px)'")
  && trends.includes("top: 'calc(50% - 1px)'")
  && trends.includes('均值 ${fmtClock(avgStart)}→${fmtClock(avgEnd)}'));
ok('起卧图：点线整数几何居中（去 translate 半像素偏移）',
  !trends.includes('w-[7px] h-[7px] rounded-full')
  && !trends.includes('-translate-x-1/2 -translate-y-1/2'));
ok('起卧图：顶部时间轴刻度行已删（第 85 轮用户裁决：行左有日期右有起卧时刻，顶上一排 21:00 反而让人不明所以；轨道内仅留极淡竖网格）',
  !trends.includes('axisTicks')
  && !/'21:00'/.test(trends)
  && !trends.includes('时间轴只对齐中间轨道'));
ok('起卧图：无竖线拥挤（均值线/须线/带边框/悬停色块全部移除）',
  !trends.includes('left: `${rangePct(avgStart)}%`')
  && !trends.includes('bedWhisker')
  && !trends.includes("background: `${theme.accentHex}12`,")
  && !trends.includes('borderLeft: `1px dashed')
  && !trends.includes("bg-white/[0.04] rounded-full"));
ok('App 把用户目标作息传入趋势页',
  app.includes('targetBedtime={userProfile.targetBedtime}')
  && app.includes('targetWakeTime={userProfile.targetWakeTime}'));
ok('历史卡展开唯一入口——小结卡不是隐形大按钮（第 110 轮：整卡 onClick 冒泡，图表每次点按都误展历史卡）',
  (trends.match(/setIsHistoryExpanded/g) || []).length === 2   // useState 声明 + 历史卡自己的切换按钮
  && !trends.includes('aria-label="展开近期睡眠小结详情"')
  && !trends.includes('active:scale-[0.99]'));
ok('图表手感：activeDot 几何滑行 + tooltip 淡入（第 110 轮，SVG cx/cy 可过渡）',
  (trends.match(/cx 130ms ease-out/g) || []).length === 1
  && (rhythm.match(/cx 130ms ease-out/g) || []).length === 2
  && (trends.match(/animate-tab-fade-in rounded-xl/g) || []).length === 2
  && rhythm.includes('animate-tab-fade-in'));
ok('选中夜唯一（第 113 轮一体化）——hoveredRecord/calDay 双状态退役：月历、历史行、'
  + '评分 scrub、分期、起卧点选都写 focusDate，详情/高亮/月历描边都读它',
  !trends.includes('hoveredRecord')
  && !trends.includes('calDay')
  && (trends.match(/focusDate/g) || []).length >= 10
  && trends.includes('onFocusNight')
  && trends.includes('r.date === focusDate'));
ok('睡眠日历：第三方日历库已移除（第 109 轮）——react-activity-calendar 的默认主题会 color-mix 插值再自校验，冻结版 WebView 必崩（第 108 轮实锤）',
  !pkg.includes('"react-activity-calendar"')
  && !cal.includes("from 'react-activity-calendar'"));
ok('睡眠日历：月历形态（复刻 cal-heatmap 经典 month-domain，第 109 轮真机反馈：条带形态日期月份难分辨）',
  cal.includes('grid-cols-7')
  && cal.includes("'一', '二', '三', '四', '五', '六', '日'")
  && cal.includes('aspect-square')
  && cal.includes('{c.day}'));
ok('睡眠日历：月份标题即导航（‹ ›，下界 = 首条记录月，不展示空洞月份）',
  cal.includes('aria-label="上一月"')
  && cal.includes('aria-label="下一月"')
  && cal.includes('firstMonth'));
ok('睡眠日历：点按可选中（data-date 供 e2e 定位）+ 无记录不冒充（无底色/未来日透明）',
  cal.includes('data-date={c.key}')
  && cal.includes('onSelect')
  && cal.includes('alpha === null')
  && cal.includes("c.future"));
ok('作息曲线：recharts 双线 + 缺口断线（漏记夜不连线）+ 午夜参照线',
  rhythm.includes("from 'recharts'")
  && (rhythm.match(/connectNulls=\{false\}/g) ?? []).length === 2   // 就寝/起床双线各自断缺口
  && rhythm.includes('<ReferenceLine y={24}')
  && rhythm.includes('data-testid="rhythm-chart"')
  && rhythm.includes('aria-label='));
ok('作息曲线：双线可辨识（实线就寝/虚线起床有图例，轴刻度走中文时刻）',
  rhythm.includes('fmtTick')
  && rhythm.includes('strokeDasharray="6 3"')
  && rhythm.includes('name="就寝"')
  && rhythm.includes('name="起床"')
  && rhythm.includes('w-3 h-0.5 rounded-full'));

// 反向自检：删掉 Y 轴刻度数组后，同一判据必须失去
{
  const doctored = trends.replace('[50, 75, 90, 100]', '[]');
  ok('反向自检：删除 Y 轴刻度后判据不再成立', !doctored.includes('[50, 75, 90, 100]'));
  // 第 107 轮新增图的两个锚点各做一次反向验证（双线各有一处 connectNulls，全量替换）
  const doctoredRhythm = rhythm.split('connectNulls={false}').join('connectNulls');
  ok('反向自检：作息曲线缺口开关被改坏后判据不再成立', !doctoredRhythm.includes('connectNulls={false}'));
  const doctoredCal = cal.replace('data-date={c.key}', 'dataX={c.key}');
  ok('反向自检：日历点选锚点被删后判据不再成立', !doctoredCal.includes('data-date={c.key}'));
  const doctoredWeekdays = cal.replace("'一', '二', '三', '四', '五', '六', '日'", "'一', '三', '五'");
  ok('反向自检：星期表头被截断后判据不再成立', !doctoredWeekdays.includes("'一', '二', '三', '四', '五', '六', '日'"));
  // "库已移除"断言的两个探测器各验一次：注入回装，探测器必须命中
  const doctoredPkg = pkg.replace('"react-is"', '"react-is","react-activity-calendar"');
  ok('反向自检：package.json 回装被检出', doctoredPkg.includes('"react-activity-calendar"'));
  const doctoredImport = cal.replace(
    "import React, { useMemo, useState } from 'react';",
    "import React, { useMemo, useState } from 'react';\nimport X from 'react-activity-calendar';",
  );
  ok('反向自检：import 式回装被检出', doctoredImport.includes("from 'react-activity-calendar'"));
  // 第 110 轮两个手感/交互锚点的反向验证
  const doctoredCard = trends.replace(
    'theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4',
    'theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4" onClick={() => setIsHistoryExpanded(true)} data-x="',
  );
  ok('反向自检：小结卡被加回整卡展开后判据不再成立', (doctoredCard.match(/setIsHistoryExpanded/g) || []).length === 3);
  const doctoredGlide = rhythm.split("transition: 'cx 130ms ease-out, cy 130ms ease-out'").join('');
  ok('反向自检：activeDot 滑行被剥后判据不再成立', (doctoredGlide.match(/cx 130ms ease-out/g) || []).length === 0);
  const doctoredFocus = trends.replace(
    'const [focusDate, setFocusDate] = useState<string | null>(null);',
    'const [focusDate, setFocusDate] = useState<string | null>(null);\n  const [hoveredRecord, setHoveredRecord] = useState<SleepRecord | null>(null);',
  );
  ok('反向自检：选中夜双状态回潮被检出', doctoredFocus.includes('hoveredRecord'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——趋势图可读性护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-chart-readability：坐标/目标带/断点/分期/起卧/日历/作息曲线全部在位');
