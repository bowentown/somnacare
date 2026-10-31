import React from 'react';
import { SleepRecord } from '../types/sleep';
import { ThemeConfig } from '../utils/themeStyles';

/**
 * 睡眠日历（第 106 轮）：GitHub 贡献图 / cal-heatmap 的网格语法——
 * 一格一天、颜色 = 评分档（≥80 达标 / ≥60 中 / 其余弱）。
 * 最具"被验证过"的时序可视化形态，零依赖手绘 SVG
 * （cal-heatmap 为 MIT 可用，但引依赖与 bundle 护栏、简约美冲突）。
 * 颜色档复用 GOOD_NIGHT_THRESHOLD 的既有口径；无记录 = 空格，不冒充数据。
 */
export const SleepHeatmap: React.FC<{
  records: SleepRecord[];
  theme: ThemeConfig;
  accentHex: string;
  weeks?: number;
}> = ({ records, theme, accentHex, weeks = 12 }) => {
  const CELL = 11;
  const GAP = 2;
  const GUTTER = 4;
  const TOP = 12;
  const innerBg = theme?.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme?.cardInnerBorder || 'border-slate-700/80';

  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (7 - ((today.getDay() + 6) % 7)));
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - weeks * 7);

  const byDate = new Map<string, number>();
  for (const r of records) {
    if (typeof r.sleepScore === 'number') byDate.set(r.date, r.sleepScore);
  }

  const cells: React.ReactNode[] = [];
  const monthLabels: React.ReactNode[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      if (day.getTime() > today.getTime()) continue;
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const score = byDate.get(key);
      const fill = score === undefined
        ? 'rgba(255,255,255,0.05)'
        : accentHex;
      const opacity = score === undefined ? 1 : score >= 80 ? 0.95 : score >= 60 ? 0.55 : 0.28;
      const x = GUTTER + w * (CELL + GAP);
      const y = TOP + d * (CELL + GAP);
      cells.push(
        <rect key={key} x={x} y={y} width={CELL} height={CELL} rx={2.5} fill={fill} fillOpacity={opacity}>
          <title>{key}{score !== undefined ? ` · ${score} 分` : ''}</title>
        </rect>,
      );
      if (d === 0 && day.getMonth() !== lastMonth) {
        monthLabels.push(
          <text key={`m${w}`} x={x} y={8} fontSize={7} fill="rgba(148,163,184,0.75)" fontFamily="ui-monospace, monospace">{day.getMonth() + 1}月</text>,
        );
        lastMonth = day.getMonth();
      }
    }
  }

  const width = GUTTER + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);

  return (
    <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 space-y-1.5`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-slate-200">睡眠日历</span>
        <span className="text-[10px] font-mono text-slate-400">近 {weeks} 周</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="近 12 周每日睡眠评分日历">
        {monthLabels}
        {cells}
      </svg>
    </div>
  );
};

export default SleepHeatmap;
